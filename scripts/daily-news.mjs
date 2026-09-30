import { readFile } from 'node:fs/promises';

import { beijingDate, formatDayLabel, withHeaderCard } from './format.mjs';
import { askLlm, llmConfigured } from './llm.mjs';

// vikiboss/60s 的静态数据仓库：每天一份「每天 60 秒读懂世界」JSON，通常北京时间 05:30 更新，偶尔晚于 08:00。
const NEWS_SOURCE_BASE = 'https://raw.githubusercontent.com/vikiboss/60s-static-host/main/static/60s';

export function parseDailyNews(raw, expectedDate) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (data?.date !== expectedDate) throw new Error(`News date mismatch: expected ${expectedDate}, got ${data?.date}`);
  const news = (Array.isArray(data.news) ? data.news : []).map((item) => String(item).trim()).filter(Boolean);
  if (news.length === 0) throw new Error('News list is empty');
  return { date: data.date, news, tip: String(data.tip ?? '').trim(), link: /^https:\/\//.test(data.link ?? '') ? data.link : '' };
}

// 分类卡片的顺序、标题与色条颜色。
export const NEWS_CATEGORIES = [
  { key: 'politics', title: '🏛️ 时政要闻', color: '#c62828' },
  { key: 'economy', title: '💰 财经动态', color: '#e0a800' },
  { key: 'tech', title: '🔬 科技前沿', color: '#1565c0' },
  { key: 'world', title: '🌍 国际视野', color: '#2e7d32' },
  { key: 'society', title: '🏙️ 社会民生', color: '#6a1b9a' },
  { key: 'culture', title: '🎭 文体娱乐', color: '#ef6c00' },
];
const FALLBACK_CATEGORY = { key: 'all', title: '📋 今日要闻', color: '#d93025' };

// 用大模型给每条新闻打分类并拟一个短标题；未配置时返回 null，失败时抛错（调用方退回冒号拆分排版）。
export async function classifyNews(news, { env = process.env, fetchImpl = fetch } = {}) {
  if (!llmConfigured(env)) return null;
  const keys = NEWS_CATEGORIES.map((category) => category.key);
  const prompt = `为下面每条中文新闻：1) 归入一个分类 c：politics=国内时政与政策，economy=财经、产业与市场，tech=科技与科学，world=国际新闻，society=社会民生，culture=体育、文化与娱乐；2) 拟一个不超过 14 个汉字的新闻小标题 t，概括事件本身，不要用「报告显示」「某某表示」这类信源开头，不加标点结尾。只输出 JSON 数组，元素形如 {"c":"economy","t":"房贷贴息新政落地"}，顺序与输入一致，不要任何其他文字。\n${JSON.stringify(news)}`;
  const text = await askLlm(prompt, { env, fetchImpl });
  let parsed = null;
  try { parsed = JSON.parse(/\[[\s\S]*\]/.exec(text)?.[0] ?? 'null'); } catch { /* handled below */ }
  if (!Array.isArray(parsed) || parsed.length !== news.length || !parsed.every((item) => typeof item?.t === 'string' && item.t.trim())) {
    throw new Error('LLM response has an unexpected shape');
  }
  return parsed.map((item) => ({
    category: keys.includes(item.c) ? item.c : 'society',
    headline: item.t.trim().slice(0, 20),
  }));
}

// 有大模型标题时：加粗小标题 + 原文；否则按第一个冒号拆成加粗标题 + 细节，没有冒号就整条加粗。
export function formatNewsItem(item, headline = '') {
  if (headline) return `▸ **${headline}**\n${item}`;
  const match = /^(.{2,40}?)[：:]\s*(.+)$/.exec(item);
  return match ? `▸ **${match[1].trim()}**\n${match[2].trim()}` : `▸ **${item}**`;
}

export function buildNewsMessage({ date, news, tip, link }, labels = null) {
  const items = news.map((text, index) => ({ text, ...(labels?.[index] ?? {}) }));
  const groups = labels
    ? NEWS_CATEGORIES.map((category) => ({ ...category, items: items.filter((item) => item.category === category.key) }))
      .filter((group) => group.items.length > 0)
    : [{ ...FALLBACK_CATEGORY, items }];
  const attachments = groups.map((group) => ({
    color: group.color,
    title: `${group.title}（${group.items.length}）`,
    text: group.items.map((item) => formatNewsItem(item.text, item.headline)).join('\n\n'),
  }));
  if (tip) attachments.push({ color: '#9aa0a6', text: `💬 **今日微语**\n${tip}` });
  const source = link ? ` · [阅读原文](${link})` : '';
  return withHeaderCard({ title: `📰 今日热点新闻 · ${formatDayLabel(date)}`, description: `${news.length} 条要闻，60 秒读懂世界${source}`, color: '#d93025' }, attachments);
}

export async function readNewsState(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, lastPushedDate: '' };
    throw error;
  }
  const state = JSON.parse(raw);
  if (state.schemaVersion !== 1 || typeof state.lastPushedDate !== 'string') throw new Error(`Invalid news state file: ${path}`);
  return state;
}

// 返回 null 表示当天数据尚未发布。
async function fetchNewsJson(date, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const response = await fetchImpl(`${NEWS_SOURCE_BASE}/${date}.json`, { signal: AbortSignal.timeout(timeoutMs) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`News source request failed: HTTP ${response.status}`);
  return response.text();
}

// 每天推一次；数据未发布时静默，等 10:00 的补推。
export async function runDailyNews({
  stateFile,
  send,
  writeState,
  dryRun = false,
  now = new Date(),
  fetchNews = fetchNewsJson,
  classify = classifyNews,
  log = console.log,
}) {
  const state = await readNewsState(stateFile);
  const date = beijingDate(now);
  if (state.lastPushedDate === date) {
    log('News: already pushed today');
    return { messages: 0 };
  }
  const raw = await fetchNews(date);
  if (raw === null) {
    log(`News: ${date} not published yet`);
    return { messages: 0 };
  }
  const parsed = parseDailyNews(raw, date);
  let labels = null;
  try {
    labels = await classify(parsed.news);
  } catch (error) {
    log(`News: classification skipped (${String(error.message).slice(0, 120)})`);
  }
  const message = buildNewsMessage(parsed, labels);
  if (dryRun) {
    log(JSON.stringify(message, null, 2));
    return { messages: 1 };
  }
  await send([message]);
  await writeState(stateFile, { schemaVersion: 1, lastPushedDate: date, updatedAt: now.toISOString() });
  log(`News: pushed ${date}`);
  return { messages: 1 };
}
