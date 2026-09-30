import { readFile } from 'node:fs/promises';

import { RANK_MARKS, beijingDate, decodeEntities, formatCount, formatDayLabel, withHeaderCard } from './format.mjs';
import { askLlm, llmConfigured } from './llm.mjs';

// Hacker News 官方 API（https://github.com/HackerNews/API），无需密钥。
const HN_API = 'https://hacker-news.firebaseio.com/v0';
const CANDIDATES = 30;
const DEDUP_WINDOW_DAYS = 7;
const HISTORY_DAYS = 30;

const discussionUrl = (id) => `https://news.ycombinator.com/item?id=${id}`;

export function toStory(item) {
  if (!item || item.type !== 'story' || item.dead || item.deleted || !item.title) return null;
  const url = /^https?:\/\//.test(item.url ?? '') ? item.url : discussionUrl(item.id);
  let domain = '';
  try { domain = item.url ? new URL(item.url).hostname.replace(/^www\./, '') : ''; } catch { /* 无效链接按站内帖子处理 */ }
  return {
    id: item.id,
    title: decodeEntities(item.title),
    url,
    domain,
    discussion: discussionUrl(item.id),
    score: item.score ?? 0,
    comments: item.descendants ?? 0,
    description: '',
  };
}

// 保持 HN 首页排序，跳过 7 天内推过的，取前 limit 条，再按分数排序（奖牌与数字一致）。
export function selectFreshStories(stories, pushed, { now = new Date(), limit = 10 } = {}) {
  const since = beijingDate(new Date(now.getTime() - DEDUP_WINDOW_DAYS * 86_400_000));
  const recent = new Set(pushed.filter((item) => item.date > since).map((item) => item.id));
  return stories
    .filter((story) => !recent.has(story.id))
    .slice(0, limit)
    .sort((a, b) => b.score - a.score);
}

// 从文章页的 og:description / description 取一句原文简介；取不到就留空，不让模型编造。
export function extractDescription(html) {
  const head = String(html).slice(0, 200_000);
  for (const pattern of [
    /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:description["']/i,
    /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']description["']/i,
  ]) {
    const match = pattern.exec(head)?.[1];
    if (match) return decodeEntities(match).replace(/\s+/g, ' ').trim().slice(0, 400);
  }
  return '';
}

export async function addDescriptions(stories, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const results = await Promise.allSettled(stories.map(async (story) => {
    if (!story.domain) return '';
    const response = await fetchImpl(story.url, {
      headers: { 'user-agent': 'Mozilla/5.0 (weekly-rocketchat)', accept: 'text/html' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok || !/html/i.test(response.headers.get('content-type') ?? '')) return '';
    return extractDescription(await response.text());
  }));
  return stories.map((story, index) => ({ ...story, description: results[index].status === 'fulfilled' ? results[index].value : '' }));
}

export async function translateStories(stories, { env = process.env, fetchImpl = fetch } = {}) {
  if (!llmConfigured(env)) return stories;
  const prompt = `下面是 Hacker News 今日热门帖子。对每条：t 把 title 翻译成简洁自然的简体中文标题（不超过 30 字，保留产品名、公司名等专有名词）；d 根据 description 写一句中文导读（不超过 70 字）。description 为空时 d 必须是空字符串，不要根据标题编造内容。只输出 JSON 数组，元素形如 {"t":"……","d":"……"}，顺序与输入一致，不要任何其他文字。\n${JSON.stringify(stories.map((story) => ({ title: story.title, description: story.description })))}`;
  const text = await askLlm(prompt, { env, fetchImpl, maxTokens: 3000 });
  let parsed = null;
  try { parsed = JSON.parse(/\[[\s\S]*\]/.exec(text)?.[0] ?? 'null'); } catch { /* handled below */ }
  if (!Array.isArray(parsed) || parsed.length !== stories.length || !parsed.every((item) => typeof item?.t === 'string' && item.t.trim())) {
    throw new Error('LLM response has an unexpected shape');
  }
  return stories.map((story, index) => ({
    ...story,
    titleZh: parsed[index].t.trim(),
    // 没有原文简介时丢弃模型给的导读，防止编造。
    descriptionZh: story.description && typeof parsed[index].d === 'string' ? parsed[index].d.trim() : '',
  }));
}

export function buildHackerNewsMessage(stories, { date }) {
  const translated = stories.some((story) => story.titleZh);
  return withHeaderCard({
    title: `🔥 Hacker News 今日热点 · ${formatDayLabel(date)}`,
    description: `玄离周刊今日无更新，精选 ${stories.length} 条 Hacker News 最热科技讨论${translated ? '（AI 翻译）' : ''}`,
    color: '#ff6600',
  }, stories.map((story, index) => {
      const meta = [`▲ ${formatCount(story.score)} 分`, `💬 ${formatCount(story.comments)} 评论`, story.domain ? `🌐 ${story.domain}` : '📝 HN 站内帖'].join('　');
      const description = story.descriptionZh || (translated ? '' : story.description);
      return {
        color: index < 3 ? '#ff6600' : '#f5a26b',
        title: `${RANK_MARKS[index] ?? `${index + 1}.`} ${story.titleZh || story.title}`,
        title_link: story.url,
        text: [meta, description, `[查看 HN 讨论 ›](${story.discussion})`].filter(Boolean).join('\n'),
      };
  }));
}

export async function readHackerNewsState(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, pushed: [], lastPushedDate: '' };
    throw error;
  }
  const state = JSON.parse(raw);
  if (state.schemaVersion !== 1 || !Array.isArray(state.pushed)) throw new Error(`Invalid Hacker News state file: ${path}`);
  return state;
}

async function fetchJson(url, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Hacker News request failed: HTTP ${response.status}`);
  return response.json();
}

export async function fetchTopStories({ fetchImpl = fetch } = {}) {
  const ids = await fetchJson(`${HN_API}/topstories.json`, { fetchImpl });
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('Hacker News returned no top stories');
  const items = await Promise.allSettled(ids.slice(0, CANDIDATES).map((id) => fetchJson(`${HN_API}/item/${id}.json`, { fetchImpl })));
  const stories = items.map((result) => (result.status === 'fulfilled' ? toStory(result.value) : null)).filter(Boolean);
  if (stories.length === 0) throw new Error('Hacker News items could not be loaded');
  return stories;
}

// 玄离无更新时的补位推送：每天一次，取 HN 首页 7 天内没推过的前 10 条。
// 简介抓取或翻译失败都不影响推送，退回英文原文。
export async function runHackerNewsFallback({
  stateFile,
  send,
  writeState,
  dryRun = false,
  now = new Date(),
  fetchStories = fetchTopStories,
  describe = addDescriptions,
  translate = translateStories,
  log = console.log,
}) {
  const state = await readHackerNewsState(stateFile);
  const date = beijingDate(now);
  // 定时器一天会跑两次（08:00 与补推的 10:00），每天只推一次。
  if (state.lastPushedDate === date) {
    log('Hacker News: already pushed today');
    return { messages: 0, stories: 0 };
  }
  const fresh = selectFreshStories(await fetchStories(), state.pushed, { now });
  if (fresh.length === 0) {
    log('Hacker News: no new stories');
    return { messages: 0, stories: 0 };
  }
  let stories = await describe(fresh);
  try {
    stories = await translate(stories);
  } catch (error) {
    log(`Hacker News: translation skipped (${String(error.message).slice(0, 120)})`);
  }
  const message = buildHackerNewsMessage(stories, { date });
  if (dryRun) {
    log(JSON.stringify(message, null, 2));
    return { messages: 1, stories: stories.length };
  }
  await send([message]);
  const cutoff = beijingDate(new Date(now.getTime() - HISTORY_DAYS * 86_400_000));
  const pushed = [...state.pushed.filter((item) => item.date > cutoff), ...fresh.map((story) => ({ id: story.id, date }))];
  await writeState(stateFile, { schemaVersion: 1, pushed, lastPushedDate: date, updatedAt: now.toISOString() });
  log(`Hacker News: pushed ${stories.length} stories`);
  return { messages: 1, stories: stories.length };
}
