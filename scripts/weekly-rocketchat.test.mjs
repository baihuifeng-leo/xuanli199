import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildMessages,
  classifyChangedPaths,
  diffWeekly,
  parseWeekly,
} from './weekly-rocketchat-lib.mjs';

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

test('classifyChangedPaths ignores README and non-numbered docs', () => {
  assert.deepEqual(classifyChangedPaths('M\tREADME.md\nA\tdocs/119.md\nM\tdocs/about.md\n'), [
    { status: 'A', path: 'docs/119.md', oldPath: null },
  ]);
});

test('classifyChangedPaths understands renames and deletions', () => {
  assert.deepEqual(classifyChangedPaths('R100\tdocs/118.md\tdocs/119.md\nD\tdocs/117.md\n'), [
    { status: 'R', path: 'docs/119.md', oldPath: 'docs/118.md' },
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
