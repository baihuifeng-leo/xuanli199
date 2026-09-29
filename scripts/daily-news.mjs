import { readFile } from 'node:fs/promises';

import { beijingDate, formatDayLabel } from './github-trending.mjs';

// vikiboss/60s 的静态数据仓库：每天一份「每天 60 秒读懂世界」JSON，通常北京时间 05:30 更新，偶尔晚于 09:00。
const NEWS_SOURCE_BASE = 'https://raw.githubusercontent.com/vikiboss/60s-static-host/main/static/60s';

export function parseDailyNews(raw, expectedDate) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (data?.date !== expectedDate) throw new Error(`News date mismatch: expected ${expectedDate}, got ${data?.date}`);
  const news = (Array.isArray(data.news) ? data.news : []).map((item) => String(item).trim()).filter(Boolean);
  if (news.length === 0) throw new Error('News list is empty');
  return { date: data.date, news, tip: String(data.tip ?? '').trim(), link: /^https:\/\//.test(data.link ?? '') ? data.link : '' };
}

export function buildNewsMessage({ date, news, tip, link }) {
  const attachments = [{
    color: '#d93025',
    title: '每天 60 秒读懂世界',
    ...(link ? { title_link: link } : {}),
    text: news.map((item, index) => `${index + 1}. ${item}`).join('\n'),
  }];
  if (tip) attachments.push({ color: '#9aa0a6', text: `💡 ${tip}` });
  return { text: `**📰 今日热点新闻** · ${formatDayLabel(date)}`, attachments };
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

// 每天推一次；数据未发布时静默，等 11:00 的补推。
export async function runDailyNews({
  stateFile,
  send,
  writeState,
  dryRun = false,
  now = new Date(),
  fetchNews = fetchNewsJson,
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
  const message = buildNewsMessage(parseDailyNews(raw, date));
  if (dryRun) {
    log(JSON.stringify(message, null, 2));
    return { messages: 1 };
  }
  await send([message]);
  await writeState(stateFile, { schemaVersion: 1, lastPushedDate: date, updatedAt: now.toISOString() });
  log(`News: pushed ${date}`);
  return { messages: 1 };
}
