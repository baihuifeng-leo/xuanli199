import { readFile } from 'node:fs/promises';

export const TRENDING_SOURCE_URL = 'https://raw.githubusercontent.com/aneasystone/github-trending/master/README.md';
const TRENDING_REPOSITORY_URL = 'https://github.com/aneasystone/github-trending';
const PUSHED_HISTORY_LIMIT = 1000;

// aneasystone/github-trending 在 "## All language" 下按首次上榜日期记录项目：
// * 【2026-09-29】[owner / repo](https://github.com/owner/repo) - description
export function parseTrending(markdown) {
  const lines = String(markdown).split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '## All language');
  if (start === -1) throw new Error('Trending README has no "All language" section');
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('## ')) break;
    const match = /^\* 【(\d{4}-\d{2}-\d{2})】\[([^\]]+)\]\((https:\/\/github\.com\/[^)\s]+)\)(?: - (.*))?$/.exec(line.trim());
    if (!match) continue;
    entries.push({
      date: match[1],
      name: match[2].replace(/\s*\/\s*/, '/').trim(),
      url: match[3],
      description: (match[4] ?? '').trim(),
    });
  }
  return entries;
}

export function selectFresh(entries, pushedUrls, { now = new Date(), maxAgeDays = 3, limit = 10 } = {}) {
  const pushed = new Set(pushedUrls);
  const oldest = new Date(now.getTime() - maxAgeDays * 86_400_000).toISOString().slice(0, 10);
  return entries
    .filter((entry) => entry.date >= oldest && !pushed.has(entry.url))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
}

export async function translateDescriptions(entries, {
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 60_000,
} = {}) {
  const base = String(env.AI_API_BASE ?? '').replace(/\/$/, '');
  const apiKey = env.AI_API_KEY ?? '';
  const model = env.AI_MODEL ?? '';
  const protocol = env.AI_API_PROTOCOL || 'openai';
  const pending = entries.filter((entry) => entry.description);
  if (!base || !apiKey || !model || pending.length === 0) return entries;

  const prompt = `把下面每个 GitHub 项目的英文简介（description 字段）翻译成简洁自然的简体中文（每条不超过 60 字，保留专有名词，不要重复项目名）。只输出 JSON 字符串数组，顺序与输入一致，不要任何其他文字。\n${JSON.stringify(pending.map((entry) => ({ name: entry.name, description: entry.description })))}`;
  const isAnthropic = protocol === 'anthropic';
  const response = await fetchImpl(isAnthropic ? `${base}/messages` : `${base}/chat/completions`, {
    method: 'POST',
    headers: isAnthropic
      ? { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`Translation request failed: HTTP ${response.status}`);
  const payload = await response.json();
  const text = isAnthropic
    ? (payload?.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('')
    : payload?.choices?.[0]?.message?.content ?? '';
  const json = /\[[\s\S]*\]/.exec(text)?.[0];
  const translated = json ? JSON.parse(json) : null;
  if (!Array.isArray(translated) || translated.length !== pending.length || !translated.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error('Translation response has an unexpected shape');
  }
  // 模型偶尔仍会在译文前加 "owner/repo：" 前缀，统一去掉。
  const stripName = (name, text) => (text.startsWith(name) ? text.slice(name.length).replace(/^\s*[:：-]\s*/, '') : text);
  const byUrl = new Map(pending.map((entry, index) => [entry.url, stripName(entry.name, translated[index].trim()) || translated[index].trim()]));
  return entries.map((entry) => (byUrl.has(entry.url) ? { ...entry, descriptionZh: byUrl.get(entry.url) } : entry));
}

export function buildTrendingMessage(entries, { date }) {
  const lines = [`【GitHub 今日热点】${date}`, '玄离周刊今日无更新，以下是 GitHub Trending 新上榜项目：', ''];
  entries.forEach((entry, index) => {
    lines.push(`${index + 1}. **${entry.name}**`);
    const description = entry.descriptionZh || entry.description;
    if (description) lines.push(description);
    lines.push(entry.url, '');
  });
  lines.push(`来源：GitHub Trending（${TRENDING_REPOSITORY_URL}）`);
  return lines.join('\n');
}

export async function readTrendingState(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, pushedUrls: [] };
    throw error;
  }
  const state = JSON.parse(raw);
  if (state.schemaVersion !== 1 || !Array.isArray(state.pushedUrls)) throw new Error(`Invalid trending state file: ${path}`);
  return state;
}

async function fetchTrendingMarkdown({ fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  const response = await fetchImpl(TRENDING_SOURCE_URL, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Trending source request failed: HTTP ${response.status}`);
  return response.text();
}

// 玄离无更新时的补位推送：只推没推过的新上榜项目，全部推过则静默。
// 翻译失败不影响推送，退回英文原文。
export async function runTrendingFallback({
  stateFile,
  send,
  writeState,
  dryRun = false,
  now = new Date(),
  fetchMarkdown = fetchTrendingMarkdown,
  translate = translateDescriptions,
  log = console.log,
}) {
  const state = await readTrendingState(stateFile);
  const fresh = selectFresh(parseTrending(await fetchMarkdown()), state.pushedUrls, { now });
  if (fresh.length === 0) {
    log('Trending: no new projects');
    return { messages: 0, projects: 0 };
  }
  let entries = fresh;
  try {
    entries = await translate(fresh);
  } catch (error) {
    log(`Trending: translation skipped (${String(error.message).slice(0, 120)})`);
  }
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);
  const message = buildTrendingMessage(entries, { date });
  if (dryRun) {
    log(message);
    return { messages: 1, projects: entries.length };
  }
  await send([message]);
  const pushedUrls = [...state.pushedUrls, ...fresh.map((entry) => entry.url)].slice(-PUSHED_HISTORY_LIMIT);
  await writeState(stateFile, { schemaVersion: 1, pushedUrls, updatedAt: now.toISOString() });
  log(`Trending: pushed ${entries.length} projects`);
  return { messages: 1, projects: entries.length };
}
