import { KEYCAPS, withHeaderCard } from './format.mjs';

const WEEKLY_PATH = /^docs\/(\d+)\.md$/;
const URL_PATTERN = /https?:\/\/[^\s<>()]+/g;

const normalizeText = (value) => value.replace(/\r\n?/g, '\n').trim();
const normalizeTitle = (value) => value.replace(/\s+/g, ' ').trim();

export function parseWeekly(markdown, sourcePath) {
  const pathMatch = WEEKLY_PATH.exec(sourcePath);
  if (!pathMatch) throw new Error(`Invalid weekly path: ${sourcePath}`);

  const normalized = normalizeText(markdown);
  if (/^#[ \t]*$/m.test(normalized)) throw new Error(`Missing weekly title in ${sourcePath}`);
  if (/^##[ \t]*$/m.test(normalized)) throw new Error(`Invalid weekly entry in ${sourcePath}`);
  const headingMatch = normalized.match(/^#[ \t]+([^\r\n]+)$/m);
  if (!headingMatch) throw new Error(`Missing weekly title in ${sourcePath}`);

  const sections = [...normalized.matchAll(/^##[ \t]+([^\r\n]+)$/gm)];
  if (sections.length === 0) throw new Error(`Missing weekly entries in ${sourcePath}`);

  const entries = sections.map((match, index) => {
    const title = normalizeTitle(match[1]);
    const start = match.index + match[0].length;
    const end = sections[index + 1]?.index ?? normalized.length;
    const body = normalized.slice(start, end).trim();
    if (!title || !body) throw new Error(`Invalid weekly entry in ${sourcePath}`);

    const paragraphs = body.split(/\n\s*\n/).map(normalizeTitle).filter(Boolean);
    const summary = paragraphs.find((paragraph) => !/^https?:\/\//.test(paragraph)) ?? '';
    const urls = [...body.matchAll(URL_PATTERN)].map((urlMatch) => urlMatch[0].replace(/[，。；、]+$/, ''));

    return {
      key: title,
      title,
      summary,
      url: urls.at(-1) ?? '',
      body,
    };
  });

  const weekly = {
    issue: pathMatch[1],
    title: normalizeTitle(headingMatch[1]),
    sourcePath,
    entries,
  };
  Object.defineProperty(weekly, 'markdown', { value: normalized, enumerable: false });
  return weekly;
}

export function classifyChangedPaths(nameStatusText) {
  const result = [];
  for (const line of normalizeText(nameStatusText).split('\n')) {
    if (!line) continue;
    const [rawStatus, firstPath, secondPath] = line.split('\t');
    const status = rawStatus[0];
    if (status === 'R' || status === 'C') {
      if (WEEKLY_PATH.test(firstPath ?? '')) result.push({ status: 'D', path: firstPath, oldPath: null });
      if (WEEKLY_PATH.test(secondPath ?? '')) result.push({ status: 'A', path: secondPath, oldPath: null });
    } else if (WEEKLY_PATH.test(firstPath ?? '')) {
      result.push({ status, path: firstPath, oldPath: null });
    }
  }
  return result;
}

export function diffWeekly(oldWeekly, newWeekly) {
  const oldByKey = new Map((oldWeekly?.entries ?? []).map((entry) => [entry.key, entry]));
  const newByKey = new Map((newWeekly?.entries ?? []).map((entry) => [entry.key, entry]));
  const context = newWeekly ?? oldWeekly;
  const changes = [];

  for (const entry of oldWeekly?.entries ?? []) {
    const replacement = newByKey.get(entry.key);
    if (!replacement) {
      changes.push(toChange('removed', entry, context));
    } else if (normalizeText(entry.body) !== normalizeText(replacement.body)) {
      changes.push(toChange('changed', replacement, context));
    }
  }
  for (const entry of newWeekly?.entries ?? []) {
    if (!oldByKey.has(entry.key)) changes.push(toChange('added', entry, context));
  }
  return changes.sort((a, b) => changeRank(a.kind) - changeRank(b.kind));
}

function changeRank(kind) {
  return { changed: 0, removed: 1, added: 2 }[kind] ?? 3;
}

function toChange(kind, entry, weekly) {
  return {
    kind,
    issue: weekly.issue,
    issueTitle: weekly.title,
    sourcePath: weekly.sourcePath,
    title: entry.title,
    summary: entry.summary,
    url: entry.url,
    document: weekly.markdown,
  };
}

export function buildMessages(changes, { commit, repositoryUrl, maxLength = 6000 }) {
  if (changes.length === 0) return [];
  if (!commit || !repositoryUrl) throw new Error('commit and repositoryUrl are required');

  if (changes.some((change) => change.document)) {
    return buildDocumentMessages(changes, commit, repositoryUrl);
  }

  const shortCommit = commit.slice(0, 7);
  const blocks = attachSourceUrls(changes, repositoryUrl).map(formatChange);
  let partCount = 1;
  let parts = packBlocks(blocks, maxLength, partCount, shortCommit);
  while (parts.length !== partCount) {
    partCount = parts.length;
    parts = packBlocks(blocks, maxLength, partCount, shortCommit);
  }

  return parts.map((part, index) => {
    const prefix = `【每周科技补全 · 增量更新】${index + 1}/${parts.length} · ${shortCommit}`;
    return `${prefix}\n\n${part.join('\n\n')}`;
  });
}

const WEEKLY_COLOR = '#8250df';

function shortLinkName(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const parts = pathname.split('/').filter(Boolean);
    if (hostname === 'github.com' && parts.length >= 2) return parts[1];
    return hostname.replace(/^www\./, '') + (parts.length ? `/${parts.at(-1)}` : '');
  } catch {
    return url;
  }
}

// 周刊正文一句一行：通常句间空一行、段间空两行（没有空两行时按空一行分段）。
// 普通段落合并成一段话；含链接的段落（通常是末尾的「名称 + 链接」列表）改成可点击链接，
// 若只有一个链接且与卡片标题链接相同则省略。
export function formatEntryBody(entry) {
  const separator = /\n[ \t]*\n[ \t]*\n/.test(entry.body) ? /\n[ \t]*\n[ \t]*\n\s*/ : /\n[ \t]*\n\s*/;
  const isUrl = (line) => /^https?:\/\/\S+$/.test(line);
  const paragraphs = entry.body.split(separator).map((paragraph) => {
    const lines = paragraph.split('\n').map((line) => line.trim()).filter(Boolean);
    if (!lines.some(isUrl)) {
      return lines.reduce((joined, line) => (!joined ? line : /[　-〿＀-￯]$/.test(joined) ? joined + line : `${joined} ${line}`), '');
    }
    // 链接段：一行名称后跟一个或多个链接。名称后只有一个链接时直接做成 [名称](链接)，
    // 多个链接时写成「名称：[仓库名](链接)…」。
    const groups = [];
    for (const line of lines) {
      if (!isUrl(line)) groups.push({ label: line, urls: [] });
      else if (groups.length === 0) groups.push({ label: '', urls: [line] });
      else groups.at(-1).urls.push(line);
    }
    const prose = groups.filter((group) => group.urls.length === 0).map((group) => group.label);
    const linked = groups.filter((group) => group.urls.length > 0);
    if (prose.length === 0 && linked.length === 1 && linked[0].urls.length === 1 && linked[0].urls[0] === entry.url) return '';
    const rendered = linked.map((group) => (group.urls.length === 1 && group.label
      ? `🔗 [${group.label}](${group.urls[0]})`
      : `🔗 ${group.label ? `${group.label}：` : ''}${group.urls.map((url) => `[${shortLinkName(url)}](${url})`).join('　')}`));
    return [...prose, ...rendered].join('\n');
  }).filter(Boolean);
  return paragraphs.join('\n\n');
}

// 每期一条消息：头部是期号与日期范围，每个项目一张卡片（标题链到项目地址，正文完整保留）。
function buildDocumentMessages(changes, commit, repositoryUrl) {
  const documents = new Map();
  const deletions = [];
  for (const change of changes) {
    if (change.document && !documents.has(change.sourcePath)) {
      documents.set(change.sourcePath, change);
    } else if (change.kind === 'deleted-issue') {
      deletions.push(change);
    }
  }

  const messages = [];
  for (const change of documents.values()) {
    const isNew = changes.some((item) => item.sourcePath === change.sourcePath && item.kind === 'new-issue');
    const weekly = parseWeekly(change.document, change.sourcePath);
    const range = weekly.title.replace(/^【\d+】\s*/, '');
    const sourceUrl = `${repositoryUrl}/blob/main/${change.sourcePath}`;
    messages.push(withHeaderCard({
      title: `📚 玄离周刊 · 第 ${weekly.issue} 期 · ${isNew ? '新一期' : '内容更新'}`,
      description: `${range} · ${weekly.entries.length} 个项目 · [GitHub 原文](${sourceUrl})`,
      color: WEEKLY_COLOR,
    }, weekly.entries.map((entry, index) => ({
      color: WEEKLY_COLOR,
      title: `${KEYCAPS[index] ?? `${index + 1}.`} ${entry.title.replace(/^\d+\s*[.、．]\s*/, '')}`,
      ...(entry.url ? { title_link: entry.url } : {}),
      text: formatEntryBody(entry),
    }))));
  }
  if (deletions.length > 0) {
    messages.push(withHeaderCard(
      { title: '📚 玄离周刊 · 期数删除', description: `上游提交 ${commit.slice(0, 7)} 删除了以下期数`, color: '#9aa0a6' },
      deletions.map((change) => ({ color: '#9aa0a6', text: `第 ${change.issue} 期 · ${change.title}` })),
    ));
  }
  return messages;
}

function packBlocks(blocks, maxLength, assumedParts, shortCommit) {
  const prefixBudget = `【每周科技补全 · 增量更新】${assumedParts}/${assumedParts} · ${shortCommit}\n\n`.length;
  const budget = maxLength - prefixBudget;
  if (budget < 80) throw new Error('maxLength is too small');
  const parts = [];
  let current = [];
  let currentLength = 0;

  for (const original of blocks) {
    const block = shortenBlock(original, budget);
    const separator = current.length === 0 ? 0 : 2;
    if (current.length > 0 && currentLength + separator + block.length > budget) {
      parts.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(block);
    currentLength += (current.length === 1 ? 0 : 2) + block.length;
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function shortenBlock(block, budget) {
  if (block.length <= budget) return block;
  const lines = block.split('\n');
  const urls = lines.filter((line) => line.startsWith('http'));
  const fixed = `${lines[0]}\n（简介过长，已省略）${urls.length ? `\n${urls.join('\n')}` : ''}`;
  if (fixed.length > budget) throw new Error('A weekly entry cannot fit within maxLength');
  return fixed;
}

function formatChange(change) {
  const label = {
    'new-issue': '新一期',
    added: '内容新增',
    changed: '内容更新',
    removed: '内容删除',
    'deleted-issue': '期数删除',
  }[change.kind] ?? '内容更新';
  const lines = [`【${label}】第 ${change.issue} 期 · ${change.title}`];
  if (change.summary && change.kind !== 'removed' && change.kind !== 'deleted-issue') lines.push(change.summary);
  if (change.url) lines.push(change.url);
  if (change.sourceUrl) lines.push(change.sourceUrl);
  return lines.join('\n');
}

export function attachSourceUrls(changes, repositoryUrl) {
  return changes.map((change) => ({
    ...change,
    sourceUrl: `${repositoryUrl}/blob/main/${change.sourcePath}`,
  }));
}
