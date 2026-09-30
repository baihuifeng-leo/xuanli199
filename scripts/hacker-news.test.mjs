import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatCount, formatDayLabel } from './format.mjs';
import {
  addDescriptions,
  buildHackerNewsMessage,
  extractDescription,
  runHackerNewsFallback,
  selectFreshStories,
  toStory,
  translateStories,
} from './hacker-news.mjs';
import { main, writeStateAtomic } from './weekly-rocketchat.mjs';

const items = [
  { id: 1, type: 'story', title: 'Vermont replacing power plants with home batteries', url: 'https://www.example.com/vermont', score: 81, descendants: 40 },
  { id: 2, type: 'story', title: 'GPT 6.1 Sol &amp; friends', url: 'https://openai.example/sol', score: 783, descendants: 512 },
  { id: 3, type: 'story', title: 'Ask HN: What are you working on?', score: 120, descendants: 300 },
  { id: 4, type: 'job', title: 'Hiring', url: 'https://jobs.example' },
  { id: 5, type: 'story', title: 'Dead story', url: 'https://x.example', dead: true },
];
const stories = items.map(toStory).filter(Boolean);
const now = new Date('2026-09-30T00:00:00Z'); // 北京时间 08:00

test('toStory keeps live stories, decodes titles and links Ask HN to the discussion', () => {
  assert.equal(stories.length, 3);
  assert.deepEqual(stories[1], {
    id: 2,
    title: 'GPT 6.1 Sol & friends',
    url: 'https://openai.example/sol',
    domain: 'openai.example',
    discussion: 'https://news.ycombinator.com/item?id=2',
    score: 783,
    comments: 512,
    description: '',
  });
  assert.equal(stories[0].domain, 'example.com');
  assert.equal(stories[2].url, 'https://news.ycombinator.com/item?id=3');
  assert.equal(stories[2].domain, '');
});

test('selectFreshStories skips recent pushes and sorts by score', () => {
  assert.deepEqual(selectFreshStories(stories, [], { now }).map((story) => story.id), [2, 3, 1]);
  assert.deepEqual(selectFreshStories(stories, [{ id: 2, date: '2026-09-29' }], { now }).map((story) => story.id), [3, 1]);
  assert.deepEqual(selectFreshStories(stories, [{ id: 2, date: '2026-09-20' }], { now, limit: 1 }).map((story) => story.id), [1]);
});

test('extractDescription prefers og:description and decodes entities', () => {
  assert.equal(extractDescription('<meta property="og:description" content="Batteries &amp; grids">'), 'Batteries & grids');
  assert.equal(extractDescription('<meta content="Reverse order" name="description">'), 'Reverse order');
  assert.equal(extractDescription('<html><head></head></html>'), '');
});

test('addDescriptions fetches article pages but skips HN-internal posts and failures', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    if (url.includes('vermont')) return new Response('<meta property="og:description" content="Home batteries replace peakers.">', { headers: { 'content-type': 'text/html' } });
    throw new Error('timeout');
  };
  const result = await addDescriptions(stories, { fetchImpl });
  assert.deepEqual(requested.sort(), ['https://openai.example/sol', 'https://www.example.com/vermont']);
  assert.equal(result[0].description, 'Home batteries replace peakers.');
  assert.equal(result[1].description, '');
});

test('translateStories translates titles and drops intros that have no source description', async () => {
  const env = { AI_API_BASE: 'https://relay.example/v1', AI_API_KEY: 'k', AI_MODEL: 'm' };
  const input = [{ ...stories[0], description: 'Home batteries replace peakers.' }, stories[1]];
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: '[{"t":"佛蒙特用家用电池替代电厂","d":"家用电池取代调峰电厂。"},{"t":"GPT 6.1 Sol 发布","d":"模型编造的导读"}]' } }] }));
  const result = await translateStories(input, { env, fetchImpl });
  assert.equal(result[0].titleZh, '佛蒙特用家用电池替代电厂');
  assert.equal(result[0].descriptionZh, '家用电池取代调峰电厂。');
  assert.equal(result[1].descriptionZh, '');
  await assert.rejects(() => translateStories(stories, { env, fetchImpl }), /unexpected shape/);
  assert.equal(await translateStories(stories, { env: {} }), stories);
});

test('buildHackerNewsMessage renders ranked cards with points, comments, domain and discussion link', () => {
  const ranked = selectFreshStories(stories, [], { now });
  ranked[0] = { ...ranked[0], titleZh: 'GPT 6.1 Sol 发布', descriptionZh: '更便宜的新模型。' };
  const message = buildHackerNewsMessage(ranked, { date: '2026-09-30' });
  assert.equal(message.text, '');
  assert.deepEqual(message.attachments[0], { color: '#ff6600', title: '🔥 Hacker News 今日热点 · 9月30日 周三', text: '玄离周刊今日无更新，精选 3 条 Hacker News 最热科技讨论（AI 翻译）' });
  assert.deepEqual(message.attachments[1], {
    color: '#ff6600',
    title: '🥇 GPT 6.1 Sol 发布',
    title_link: 'https://openai.example/sol',
    text: '▲ 783 分　💬 512 评论　🌐 openai.example\n更便宜的新模型。\n[查看 HN 讨论 ›](https://news.ycombinator.com/item?id=2)',
  });
  assert.equal(message.attachments[2].title, '🥈 Ask HN: What are you working on?');
  assert.match(message.attachments[2].text, /📝 HN 站内帖/);
});

test('formatCount and formatDayLabel', () => {
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1234), '1.2k');
  assert.equal(formatCount(56789), '57k');
  assert.equal(formatCount(undefined), '');
  assert.equal(formatDayLabel('2026-10-04'), '10月4日 周日');
});

test('runHackerNewsFallback pushes once a day, falls back to English and does not repeat stories', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hn-'));
  try {
    const stateFile = join(directory, 'hn-state.json');
    const sent = [];
    const options = {
      stateFile,
      send: async (messages) => sent.push(...messages),
      writeState: writeStateAtomic,
      now,
      fetchStories: async () => stories,
      describe: async (list) => list,
      translate: async () => { throw new Error('relay down'); },
      log: () => {},
    };
    assert.deepEqual(await runHackerNewsFallback(options), { messages: 1, stories: 3 });
    assert.equal(sent[0].attachments[1].title, '🥇 GPT 6.1 Sol & friends');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.lastPushedDate, '2026-09-30');
    assert.deepEqual(state.pushed.map((item) => item.id).sort(), [1, 2, 3]);
    assert.deepEqual(await runHackerNewsFallback(options), { messages: 0, stories: 0 });
    assert.deepEqual(await runHackerNewsFallback({ ...options, now: new Date('2026-10-01T00:00:00Z') }), { messages: 0, stories: 0 });
    assert.equal(sent.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runHackerNewsFallback does not record state on delivery failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hn-'));
  try {
    const stateFile = join(directory, 'state.json');
    await assert.rejects(() => runHackerNewsFallback({
      stateFile,
      send: async () => { throw new Error('down'); },
      writeState: writeStateAtomic,
      now,
      fetchStories: async () => stories,
      describe: async (list) => list,
      translate: async (list) => list,
      log: () => {},
    }), /down/);
    await assert.rejects(() => readFile(stateFile), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function runMain(weeklyChanges) {
  const directory = await mkdtemp(join(tmpdir(), 'hn-main-'));
  const stateFile = join(directory, 'state.json');
  await writeStateAtomic(stateFile, { schemaVersion: 1, lastSuccessfulCommit: 'a'.repeat(40), updatedAt: 'x' });
  const calls = [];
  const sent = [];
  try {
    await main(['--repo', directory, '--state-file', stateFile, '--hn-state-file', join(directory, 'h.json')], {
      fetchUpstream: async () => {},
      resolveHead: async () => 'b'.repeat(40),
      collectChanges: async () => weeklyChanges,
      sendMessages: async (messages) => sent.push(...messages),
      runHackerNewsFallback: async (options) => { calls.push(options); return { messages: 1, stories: 1 }; },
      log: () => {},
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return { calls, sent };
}

test('main pushes Hacker News only when the weekly has no update, and the weekly as cards otherwise', async () => {
  assert.equal((await runMain([])).calls.length, 1);
  const document = '# 【119】2026年9月6日-2026年9月12日\n\n## 1.Tool A\n\n第一句，\n\n第二句。\n\n\nTool A（说明）\nhttps://github.com/a/tool-a\n';
  const change = { kind: 'new-issue', issue: '119', issueTitle: '【119】', sourcePath: 'docs/119.md', title: '1.Tool A', summary: 's', url: 'https://github.com/a/tool-a', document };
  const { calls, sent } = await runMain([change]);
  assert.equal(calls.length, 0);
  assert.deepEqual(sent, [{
    text: '',
    attachments: [
      { color: '#8250df', title: '📚 玄离周刊 · 第 119 期 · 新一期', text: '2026年9月6日-2026年9月12日 · 1 个项目 · [GitHub 原文](https://github.com/xuanli199/weekly/blob/main/docs/119.md)' },
      { color: '#8250df', title: '1️⃣ Tool A', title_link: 'https://github.com/a/tool-a', text: '第一句，第二句。' },
    ],
  }]);
});
