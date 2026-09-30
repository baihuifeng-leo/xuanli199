import { readFile } from 'node:fs/promises';

import { KEYCAPS, beijingDate, formatDayLabel, withHeaderCard } from './format.mjs';
import { askLlm, llmConfigured } from './llm.mjs';

// BBC News 官方 RSS（World 频道）：按编辑排序，每条有一句摘要和缩略图。
export const BBC_FEED_URL = 'https://feeds.bbci.co.uk/news/world/rss.xml';
const MAX_AGE_HOURS = 36;
const DEDUP_WINDOW_DAYS = 7;
const HISTORY_DAYS = 30;

function textOf(block, tag) {
  const raw = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block)?.[1] ?? '';
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  const text = cdata ? cdata[1] : raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

export function parseBbcFeed(xml) {
  const items = String(xml).split('<item>').slice(1).map((block) => {
    const link = textOf(block, 'link');
    return {
      title: textOf(block, 'title'),
      summary: textOf(block, 'description'),
      // 去掉 ?at_medium=RSS 等追踪参数，也作为去重键。
      url: link.split('?')[0],
      publishedAt: new Date(textOf(block, 'pubDate')),
      thumbnail: /<media:thumbnail[^>]*url="([^"]+)"/.exec(block)?.[1] ?? '',
    };
  }).filter((item) => item.title && /^https:\/\//.test(item.url));
  if (items.length === 0) throw new Error('BBC feed has no items');
  return items;
}

// 保持 BBC 的编辑排序；只要 36 小时内发布、7 天内没推过的，最多 limit 条。
export function selectFreshArticles(items, pushed, { now = new Date(), limit = 10 } = {}) {
  const since = beijingDate(new Date(now.getTime() - DEDUP_WINDOW_DAYS * 86_400_000));
  const recent = new Set(pushed.filter((item) => item.date > since).map((item) => item.url));
  const oldest = now.getTime() - MAX_AGE_HOURS * 3_600_000;
  return items
    .filter((item) => !(item.publishedAt.getTime() < oldest) && !recent.has(item.url))
    .slice(0, limit);
}

export async function translateArticles(items, { env = process.env, fetchImpl = fetch } = {}) {
  if (!llmConfigured(env)) return items;
  const prompt = `把下面每条 BBC 英文新闻翻译成简体中文：t 是新闻标题（简洁有力，不超过 30 字），d 是摘要（通顺自然，不超过 80 字）。人名、地名用中文媒体通行译名。只输出 JSON 数组，元素形如 {"t":"……","d":"……"}，顺序与输入一致，不要任何其他文字。\n${JSON.stringify(items.map((item) => ({ title: item.title, summary: item.summary })))}`;
  const text = await askLlm(prompt, { env, fetchImpl, maxTokens: 3000 });
  let parsed = null;
  try { parsed = JSON.parse(/\[[\s\S]*\]/.exec(text)?.[0] ?? 'null'); } catch { /* handled below */ }
  if (!Array.isArray(parsed) || parsed.length !== items.length || !parsed.every((item) => typeof item?.t === 'string' && item.t.trim())) {
    throw new Error('LLM response has an unexpected shape');
  }
  return items.map((item, index) => ({
    ...item,
    titleZh: parsed[index].t.trim(),
    summaryZh: typeof parsed[index].d === 'string' ? parsed[index].d.trim() : '',
  }));
}

export function buildBbcMessage(items, { date }) {
  const translated = items.some((item) => item.titleZh);
  return withHeaderCard({
    title: `🌐 BBC 国际新闻 · ${formatDayLabel(date)}`,
    description: `${items.length} 条 BBC World 要闻${translated ? '（AI 翻译）' : ''}，点击标题看原文`,
    color: '#bb1919',
  }, items.map((item, index) => ({
    color: '#bb1919',
    title: `${KEYCAPS[index] ?? `${index + 1}.`} ${item.titleZh || item.title}`,
    title_link: item.url,
    text: item.summaryZh || item.summary,
    ...(item.thumbnail ? { thumb_url: item.thumbnail } : {}),
  })));
}

export async function readBbcState(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, pushed: [], lastPushedDate: '' };
    throw error;
  }
  const state = JSON.parse(raw);
  if (state.schemaVersion !== 1 || !Array.isArray(state.pushed)) throw new Error(`Invalid BBC state file: ${path}`);
  return state;
}

async function fetchBbcFeed({ fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const response = await fetchImpl(BBC_FEED_URL, {
    headers: { 'user-agent': 'Mozilla/5.0 (weekly-rocketchat)' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`BBC feed request failed: HTTP ${response.status}`);
  return response.text();
}

// 每天推一次；翻译失败时推英文原文，不漏推。
export async function runBbcNews({
  stateFile,
  send,
  writeState,
  dryRun = false,
  now = new Date(),
  fetchFeed = fetchBbcFeed,
  translate = translateArticles,
  log = console.log,
}) {
  const state = await readBbcState(stateFile);
  const date = beijingDate(now);
  if (state.lastPushedDate === date) {
    log('BBC: already pushed today');
    return { messages: 0 };
  }
  const fresh = selectFreshArticles(parseBbcFeed(await fetchFeed()), state.pushed, { now });
  if (fresh.length === 0) {
    log('BBC: no new articles');
    return { messages: 0 };
  }
  let items = fresh;
  try {
    items = await translate(fresh);
  } catch (error) {
    log(`BBC: translation skipped (${String(error.message).slice(0, 120)})`);
  }
  const message = buildBbcMessage(items, { date });
  if (dryRun) {
    log(JSON.stringify(message, null, 2));
    return { messages: 1 };
  }
  await send([message]);
  const cutoff = beijingDate(new Date(now.getTime() - HISTORY_DAYS * 86_400_000));
  const pushed = [...state.pushed.filter((item) => item.date > cutoff), ...fresh.map((item) => ({ url: item.url, date }))];
  await writeState(stateFile, { schemaVersion: 1, pushed, lastPushedDate: date, updatedAt: now.toISOString() });
  log(`BBC: pushed ${items.length} articles`);
  return { messages: 1 };
}
