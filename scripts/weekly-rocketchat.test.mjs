import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { PassThrough } from 'node:stream';

import {
  buildMessages,
  classifyChangedPaths,
  diffWeekly,
  parseWeekly,
} from './weekly-rocketchat-lib.mjs';
import { collectChanges, main, postWebhook, readState, runGit, sendMessages, writeStateAtomic } from './weekly-rocketchat.mjs';

const execFileAsync = promisify(execFile);
const git = (cwd, ...args) => execFileAsync('git', args, { cwd });
const weeklyDoc = (issue, title, summary = '简介') => `# 【${issue}】日期\n\n## 1.${title}\n\n${summary}\n\nhttps://example.com/${title}\n`;

const makeWeekly = (entries) => ({
  issue: '119',
  title: '【119】2026年9月6日-2026年9月12日',
  sourcePath: 'docs/119.md',
  entries,
});

test('parseWeekly handles CRLF and extracts the last URL', () => {
  const doc = '# 【119】2026年9月6日-2026年9月12日\r\n\r\n## 1.Tool A\r\n\r\n第一段简介。\r\n\r\nhttps://example.com/old\r\nhttps://example.com/a\r\n';
  assert.deepEqual(parseWeekly(doc, 'docs/119.md'), {
    issue: '119',
    title: '【119】2026年9月6日-2026年9月12日',
    sourcePath: 'docs/119.md',
    entries: [{
      key: '1.Tool A',
      title: '1.Tool A',
      summary: '第一段简介。',
      url: 'https://example.com/a',
      body: '第一段简介。\n\nhttps://example.com/old\nhttps://example.com/a',
    }],
  });
});

test('parseWeekly rejects missing headings without leaking document content', () => {
  assert.throws(
    () => parseWeekly('SECRET-CONTENT', 'docs/119.md'),
    (error) => error.message.includes('docs/119.md') && !error.message.includes('SECRET-CONTENT'),
  );
});

test('parseWeekly rejects blank H1 and H2 headings', () => {
  assert.throws(() => parseWeekly('#   \n## Tool\nBody\nhttps://example.com', 'docs/119.md'), /title/);
  assert.throws(() => parseWeekly('# Issue\n##   \n## Tool\nBody\nhttps://example.com', 'docs/119.md'), /entry/);
});

test('classifyChangedPaths ignores README and non-numbered docs', () => {
  assert.deepEqual(classifyChangedPaths('M\tREADME.md\nA\tdocs/119.md\nM\tdocs/about.md\n'), [
    { status: 'A', path: 'docs/119.md', oldPath: null },
  ]);
});

test('classifyChangedPaths understands renames and deletions', () => {
  assert.deepEqual(classifyChangedPaths('R100\tdocs/118.md\tdocs/119.md\nR100\tdocs/116.md\tdocs/archive.md\nR100\tdocs/archive.md\tdocs/120.md\nD\tdocs/117.md\n'), [
    { status: 'D', path: 'docs/118.md', oldPath: null },
    { status: 'A', path: 'docs/119.md', oldPath: null },
    { status: 'D', path: 'docs/116.md', oldPath: null },
    { status: 'A', path: 'docs/120.md', oldPath: null },
    { status: 'D', path: 'docs/117.md', oldPath: null },
  ]);
});

test('diffWeekly reports changed, removed, and added entries', () => {
  const oldWeekly = makeWeekly([
    { key: '1.Tool A', title: '1.Tool A', summary: '旧', url: 'https://a', body: '旧' },
    { key: '2.Tool B', title: '2.Tool B', summary: '删除', url: 'https://b', body: '删除' },
  ]);
  const newWeekly = makeWeekly([
    { key: '1.Tool A', title: '1.Tool A', summary: '新', url: 'https://a', body: '新' },
    { key: '3.Tool C', title: '3.Tool C', summary: '新增', url: 'https://c', body: '新增' },
  ]);
  assert.deepEqual(diffWeekly(oldWeekly, newWeekly).map(({ kind, title }) => ({ kind, title })), [
    { kind: 'changed', title: '1.Tool A' },
    { kind: 'removed', title: '2.Tool B' },
    { kind: 'added', title: '3.Tool C' },
  ]);
});

test('buildMessages splits only between entries and marks every part with the commit', () => {
  const changes = Array.from({ length: 7 }, (_, index) => ({
    kind: index === 0 ? 'new-issue' : 'added',
    issue: '119',
    issueTitle: '【119】2026年9月6日-2026年9月12日',
    sourcePath: 'docs/119.md',
    title: `${index + 1}.Tool ${index + 1}`,
    summary: `第 ${index + 1} 个项目的简介，包含足够多的文字用于测试安全分片。`,
    url: `https://example.com/${index + 1}`,
  }));
  const messages = buildMessages(changes, {
    commit: '1234567890abcdef',
    repositoryUrl: 'https://github.com/xuanli199/weekly',
    maxLength: 420,
  });
  assert.ok(messages.length > 1);
  assert.ok(messages.every((message, index) => message.includes(`${index + 1}/${messages.length}`)));
  assert.ok(messages.every((message) => message.includes('1234567')));
  assert.ok(messages.every((message) => message.length <= 420));
  assert.ok(messages.every((message) => !message.endsWith('https://')));
  assert.deepEqual(messages.flatMap((message) => [...message.matchAll(/https:\/\/example\.com\/(\d+)/g)].map((match) => match[1])).sort(), ['1', '2', '3', '4', '5', '6', '7']);
});

test('buildMessages preserves project and source URLs when shortening an oversized entry', () => {
  const [message] = buildMessages([{
    kind: 'added', issue: '119', issueTitle: '【119】日期', sourcePath: 'docs/119.md',
    title: '1.Tool', summary: '很长'.repeat(300), url: 'https://project.example/tool',
  }], { commit: '1234567890abcdef', repositoryUrl: 'https://github.com/xuanli199/weekly', maxLength: 300 });
  assert.match(message, /https:\/\/project\.example\/tool/);
  assert.match(message, /https:\/\/github\.com\/xuanli199\/weekly\/blob\/main\/docs\/119\.md/);
  assert.ok(message.length <= 300);
});

test('buildMessages sends a complete weekly document as one message', async () => {
  const markdown = await readFile(new URL('../docs/118.md', import.meta.url), 'utf8');
  const weekly = parseWeekly(markdown, 'docs/118.md');
  const changes = weekly.entries.map((entry, index) => ({
    kind: index === 0 ? 'new-issue' : 'added', issue: weekly.issue, issueTitle: weekly.title,
    sourcePath: weekly.sourcePath, title: entry.title, summary: entry.summary, url: entry.url,
    document: weekly.markdown,
  }));
  const messages = buildMessages(changes, {
    commit: '4ddd5ac7a55e8584f810fb8382416e6ea4380c9c',
    repositoryUrl: 'https://github.com/xuanli199/weekly',
  });
  assert.equal(messages.length, 1);
  const [message] = messages;
  assert.equal(message.text, '');
  const [header, ...cards] = message.attachments;
  assert.deepEqual(header, { color: '#8250df', title: '📚 玄离周刊 · 第 118 期 · 新一期', text: '2026年8月29日-2026年9月5日 · 4 个项目 · [GitHub 原文](https://github.com/xuanli199/weekly/blob/main/docs/118.md)' });
  assert.equal(cards.length, 4);
  assert.equal(cards[0].title, '1️⃣ convenient_window_free');
  assert.equal(cards[0].title_link, 'https://github.com/ximizhou/convenient_window_free');
  // 段内合并成一段话，完整保留正文；末尾「项目名（说明）+ 链接」段省略
  assert.match(cards[0].text, /^在 Mac 上有一个叫触发角的功能，只要把鼠标移动到屏幕的角落里，就能触发各种功能。\n\n/);
  assert.match(cards[0].text, /就能在任意位置调整它们。$/);
  assert.equal(cards[3].title, '4️⃣ AI-Cubby');
  assert.equal(cards[3].title_link, 'https://github.com/miragecoa/AI-Cubby');
  const original = weekly.entries.map((entry) => entry.body.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, '')).join('');
  const rendered = cards.map((card) => card.text.replace(/\s+/g, '')).join('');
  for (const sentence of ['DLSS5', '窗口增强中的贴边隐藏']) assert.ok(rendered.includes(sentence) && original.includes(sentence));
});

test('first normal run creates a baseline without messages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weekly-state-'));
  const stateFile = join(directory, 'state.json');
  const sent = [];
  try {
    const result = await main(['--repo', directory, '--state-file', stateFile], {
      fetchUpstream: async () => {},
      resolveHead: async () => 'a'.repeat(40),
      collectChanges: async () => { throw new Error('must not collect on baseline'); },
      sendMessages: async (messages) => sent.push(...messages),
      log: () => {},
    });
    assert.equal(result.mode, 'baseline-created');
    assert.deepEqual(sent, []);
    assert.equal((await readState(stateFile)).lastSuccessfulCommit, 'a'.repeat(40));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a non-ancestor cursor fails without replacing state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weekly-state-'));
  const stateFile = join(directory, 'state.json');
  const orphan = 'b'.repeat(40);
  try {
    await writeStateAtomic(stateFile, { schemaVersion: 1, lastSuccessfulCommit: orphan, updatedAt: '2026-09-22T00:00:00.000Z' });
    await assert.rejects(() => main(['--repo', directory, '--state-file', stateFile], {
      fetchUpstream: async () => {},
      resolveHead: async () => 'c'.repeat(40),
      collectChanges: async () => { throw new Error('lastSuccessfulCommit is not an ancestor of upstream/main'); },
      sendMessages: async () => {},
      log: () => {},
    }), /not an ancestor/);
    assert.equal((await readState(stateFile)).lastSuccessfulCommit, orphan);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('dry-run and README-only changes do not advance state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weekly-state-'));
  const stateFile = join(directory, 'state.json');
  const oldHead = 'd'.repeat(40);
  await writeFile(stateFile, JSON.stringify({ schemaVersion: 1, lastSuccessfulCommit: oldHead, updatedAt: '2026-09-22T00:00:00.000Z' }));
  try {
    const result = await main(['--repo', directory, '--state-file', stateFile, '--dry-run'], {
      fetchUpstream: async () => {},
      resolveHead: async () => 'e'.repeat(40),
      collectChanges: async () => [],
      sendMessages: async () => { throw new Error('dry-run must not send'); },
      log: () => {},
    });
    assert.equal(result.mode, 'dry-run');
    assert.equal((await readState(stateFile)).lastSuccessfulCommit, oldHead);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('dry-run with missing state neither creates state nor initializes a baseline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weekly-state-'));
  const stateFile = join(directory, 'state.json');
  try {
    const result = await main(['--repo', directory, '--state-file', stateFile, '--dry-run'], {
      fetchUpstream: async () => {}, resolveHead: async () => 'f'.repeat(40), collectChanges: async () => [],
      sendMessages: async () => {}, log: () => {},
    });
    assert.equal(result.mode, 'dry-run');
    await assert.rejects(() => access(stateFile), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('conflicting dry-run and init-baseline modes are rejected', async () => {
  await assert.rejects(() => main(['--repo', '.', '--state-file', '/tmp/no-write', '--dry-run', '--init-baseline']), /cannot be combined/);
});

test('main pins collection to the resolved upstream SHA', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weekly-state-'));
  const stateFile = join(directory, 'state.json');
  const oldHead = '1'.repeat(40);
  const newHead = '2'.repeat(40);
  await writeStateAtomic(stateFile, { schemaVersion: 1, lastSuccessfulCommit: oldHead, updatedAt: new Date().toISOString() });
  let receivedToCommit;
  try {
    await main(['--repo', directory, '--state-file', stateFile], {
      fetchUpstream: async () => {}, resolveHead: async () => newHead,
      collectChanges: async ({ toCommit }) => { receivedToCommit = toCommit; return []; },
      sendMessages: async () => {}, log: () => {},
    });
    assert.equal(receivedToCommit, newHead);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('collectChanges reads real Git additions, modifications, deletions, and rename boundaries', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'weekly-git-'));
  try {
    await git(repo, 'init', '-q');
    await git(repo, 'config', 'user.email', 'test@example.com');
    await git(repo, 'config', 'user.name', 'Test');
    await mkdir(join(repo, 'docs'));
    await writeFile(join(repo, 'docs/116.md'), weeklyDoc('116', 'Old'));
    await writeFile(join(repo, 'docs/117.md'), weeklyDoc('117', 'Delete'));
    await writeFile(join(repo, 'docs/118.md'), weeklyDoc('118', 'Modify', '旧简介'));
    await git(repo, 'add', '.'); await git(repo, 'commit', '-qm', 'old');
    const { stdout: oldOut } = await git(repo, 'rev-parse', 'HEAD');
    await git(repo, 'mv', 'docs/116.md', 'docs/archive.md');
    await rm(join(repo, 'docs/117.md'));
    await writeFile(join(repo, 'docs/118.md'), weeklyDoc('118', 'Modify', '新简介'));
    await writeFile(join(repo, 'docs/119.md'), weeklyDoc('119', 'New'));
    await git(repo, 'add', '-A'); await git(repo, 'commit', '-qm', 'new');
    const { stdout: newOut } = await git(repo, 'rev-parse', 'HEAD');
    const changes = await collectChanges({ repo, fromCommit: oldOut.trim(), toCommit: newOut.trim() });
    assert.deepEqual(changes.map(({ kind, issue }) => `${kind}:${issue}`).sort(), [
      'changed:118', 'deleted-issue:116', 'deleted-issue:117', 'new-issue:119',
    ].sort());
    await assert.rejects(() => collectChanges({ repo, fromCommit: 'f'.repeat(40), toCommit: newOut.trim() }), /not an ancestor/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('runGit terminates a command that exceeds its timeout', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killed = false;
  child.kill = () => { killed = true; child.emit('close', null, 'SIGTERM'); };
  await assert.rejects(() => runGit(['fetch'], { spawn: () => child, timeoutMs: 5 }), /timed out/);
  assert.equal(killed, true);
});

test('readState rejects malformed state', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weekly-state-'));
  const stateFile = join(directory, 'state.json');
  try {
    await writeFile(stateFile, '{bad json');
    await assert.rejects(() => readState(stateFile), /Invalid state file/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('HTTP 200 with success false is rejected without exposing URL', async () => {
  const secretUrl = 'https://chat.invalid/hooks/integration/SECRET';
  await assert.rejects(
    () => postWebhook(secretUrl, 'test', {
      fetchImpl: async () => new Response(JSON.stringify({ success: false, error: 'rejected' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    }),
    (error) => error.message.includes('rejected') && !error.message.includes('SECRET'),
  );
});

test('network and reflected server errors redact webhook credentials', async () => {
  const secretUrl = 'https://chat.invalid/hooks/integration/SECRET_TOKEN';
  await assert.rejects(() => postWebhook(secretUrl, 'test', {
    fetchImpl: async () => { throw new Error(`connect ${secretUrl}`); },
  }), (error) => !error.message.includes('SECRET_TOKEN') && !error.message.includes('/hooks/'));
  await assert.rejects(() => postWebhook(secretUrl, 'test', {
    fetchImpl: async () => new Response(JSON.stringify({ success: false, error: `bad ${secretUrl}` }), { status: 200 }),
  }), (error) => !error.message.includes('SECRET_TOKEN') && !error.message.includes('/hooks/'));
});

test('main preserves state when message delivery fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'weekly-state-'));
  const stateFile = join(directory, 'state.json');
  const oldHead = '3'.repeat(40);
  await writeStateAtomic(stateFile, { schemaVersion: 1, lastSuccessfulCommit: oldHead, updatedAt: new Date().toISOString() });
  try {
    await assert.rejects(() => main(['--repo', directory, '--state-file', stateFile], {
      fetchUpstream: async () => {}, resolveHead: async () => '4'.repeat(40),
      collectChanges: async () => [{ kind: 'added', issue: '119', issueTitle: 'Issue', sourcePath: 'docs/119.md', title: 'Tool', summary: 'Summary', url: 'https://example.com' }],
      sendMessages: async () => { throw new Error('delivery failed'); }, log: () => {},
    }), /delivery failed/);
    assert.equal((await readState(stateFile)).lastSuccessfulCommit, oldHead);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('real HTTP second-message failure preserves state', async () => {
  let calls = 0;
  const server = createServer((request, response) => {
    request.resume(); calls += 1;
    response.writeHead(calls === 1 ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify(calls === 1 ? { success: true } : { success: false, error: 'retry' }));
  });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  const url = `http://127.0.0.1:${server.address().port}/hooks/test/token`;
  const directory = await mkdtemp(join(tmpdir(), 'weekly-state-'));
  const stateFile = join(directory, 'state.json');
  const oldHead = '5'.repeat(40);
  await writeStateAtomic(stateFile, { schemaVersion: 1, lastSuccessfulCommit: oldHead, updatedAt: new Date().toISOString() });
  const changes = Array.from({ length: 90 }, (_, index) => ({
    kind: 'added', issue: '119', issueTitle: 'Issue', sourcePath: 'docs/119.md',
    title: `Tool ${index}`, summary: '摘要'.repeat(80), url: `https://example.com/${index}`,
  }));
  try {
    await assert.rejects(() => main(['--repo', directory, '--state-file', stateFile], {
      fetchUpstream: async () => {}, resolveHead: async () => '6'.repeat(40), collectChanges: async () => changes,
      sendMessages: (messages) => sendMessages(messages, { url }), log: () => {},
    }), /retry/);
    assert.equal(calls, 2);
    assert.equal((await readState(stateFile)).lastSuccessfulCommit, oldHead);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    await rm(directory, { recursive: true, force: true });
  }
});

test('sendMessages stops after a failure', async () => {
  let calls = 0;
  await assert.rejects(() => sendMessages(['one', 'two', 'three'], {
    url: 'https://chat.invalid/hooks/id/token',
    post: async () => {
      calls += 1;
      if (calls === 2) throw new Error('503');
    },
  }), /503/);
  assert.equal(calls, 2);
});

test('test-webhook sends fixed text without reading state', async () => {
  const sent = [];
  const result = await main(['--test-webhook'], {
    sendMessages: async (messages) => sent.push(...messages),
    log: () => {},
  });
  assert.equal(result.mode, 'test-webhook');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /自动推送链路测试/);
});

test('systemd units enforce schedule, paths, and hardening', async () => {
  const service = await readFile(new URL('../deploy/weekly-rocketchat.service', import.meta.url), 'utf8');
  const timer = await readFile(new URL('../deploy/weekly-rocketchat.timer', import.meta.url), 'utf8');
  assert.match(service, /Type=oneshot/);
  assert.match(service, /EnvironmentFile=\/etc\/weekly-rocketchat\.env/);
  assert.match(service, /--repo \/var\/lib\/weekly-rocketchat\/repo/);
  assert.match(service, /--state-file \/var\/lib\/weekly-rocketchat\/state\.json/);
  assert.match(service, /--hn-state-file \/var\/lib\/weekly-rocketchat\/hn-state\.json/);
  assert.match(service, /NoNewPrivileges=true/);
  assert.doesNotMatch(service, /ReadWritePaths=.*xuanli199-weekly\/\.git/);
  assert.match(timer, /OnCalendar=\*-\*-\* 08:00:00 Asia\/Shanghai/);
  assert.match(timer, /OnCalendar=\*-\*-\* 10:00:00 Asia\/Shanghai/);
  assert.match(service, /--news-state-file \/var\/lib\/weekly-rocketchat\/news-state\.json/);
  assert.match(service, /--bbc-state-file \/var\/lib\/weekly-rocketchat\/bbc-state\.json/);
  assert.match(timer, /Persistent=true/);
  assert.doesNotMatch(timer, /RandomizedDelaySec/);
});
