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
    return [buildDocumentMessage(changes, commit, repositoryUrl)];
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

function buildDocumentMessage(changes, commit, repositoryUrl) {
  const documents = new Map();
  const deletions = [];
  for (const change of changes) {
    if (change.document && !documents.has(change.sourcePath)) {
      documents.set(change.sourcePath, change);
    } else if (change.kind === 'deleted-issue') {
      deletions.push(change);
    }
  }

  const sections = [];
  for (const change of documents.values()) {
    const label = changes.some((item) => item.sourcePath === change.sourcePath && item.kind === 'new-issue')
      ? '新一期'
      : '内容更新';
    sections.push(`【${label}】\n${change.document}\n\n来源：${repositoryUrl}/blob/main/${change.sourcePath}`);
  }
  for (const change of deletions) {
    sections.push(`【期数删除】第 ${change.issue} 期 · ${change.title}`);
  }
  return `【每周科技补全 · 增量更新】${commit.slice(0, 7)}\n\n${sections.join('\n\n---\n\n')}`;
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
