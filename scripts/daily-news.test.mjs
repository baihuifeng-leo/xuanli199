import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildNewsMessage, parseDailyNews, runDailyNews } from './daily-news.mjs';
import { main, writeStateAtomic } from './weekly-rocketchat.mjs';

const now = new Date('2026-09-29T01:00:00Z');
const sample = JSON.stringify({
  date: '2026-09-29',
  news: ['第一条新闻', '  第二条新闻  ', ''],
  tip: '行动是打破迷茫最好的武器',
  link: 'https://mp.weixin.qq.com/s?x=1',
});

test('parseDailyNews validates the date and trims items', () => {
  assert.deepEqual(parseDailyNews(sample, '2026-09-29'), {
    date: '2026-09-29',
    news: ['第一条新闻', '第二条新闻'],
    tip: '行动是打破迷茫最好的武器',
    link: 'https://mp.weixin.qq.com/s?x=1',
  });
  assert.throws(() => parseDailyNews(sample, '2026-09-30'), /date mismatch/);
  assert.throws(() => parseDailyNews({ date: '2026-09-29', news: [] }, '2026-09-29'), /empty/);
});

test('buildNewsMessage renders a numbered card and a tip card', () => {
  const message = buildNewsMessage(parseDailyNews(sample, '2026-09-29'));
  assert.equal(message.text, '**📰 今日热点新闻** · 9月29日 周二');
  assert.equal(message.attachments[0].title_link, 'https://mp.weixin.qq.com/s?x=1');
  assert.equal(message.attachments[0].text, '1. 第一条新闻\n2. 第二条新闻');
  assert.equal(message.attachments[1].text, '💡 行动是打破迷茫最好的武器');
});

test('runDailyNews pushes once per day and waits when data is not published', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'news-'));
  try {
    const stateFile = join(directory, 'news-state.json');
    const sent = [];
    const options = { stateFile, send: async (messages) => sent.push(...messages), writeState: writeStateAtomic, now, log: () => {} };
    assert.deepEqual(await runDailyNews({ ...options, fetchNews: async () => null }), { messages: 0 });
    await assert.rejects(() => readFile(stateFile), { code: 'ENOENT' });
    assert.deepEqual(await runDailyNews({ ...options, fetchNews: async () => sample }), { messages: 1 });
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).lastPushedDate, '2026-09-29');
    assert.deepEqual(await runDailyNews({ ...options, fetchNews: async () => assert.fail('should not fetch') }), { messages: 0 });
    assert.equal(sent.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a news failure does not block the weekly run but fails the process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'news-main-'));
  try {
    const stateFile = join(directory, 'state.json');
    await writeStateAtomic(stateFile, { schemaVersion: 1, lastSuccessfulCommit: 'a'.repeat(40), updatedAt: 'x' });
    const order = [];
    await assert.rejects(() => main(['--repo', directory, '--state-file', stateFile, '--news-state-file', join(directory, 'n.json')], {
      runDailyNews: async () => { order.push('news'); throw new Error('news down'); },
      fetchUpstream: async () => { order.push('weekly'); },
      resolveHead: async () => 'b'.repeat(40),
      collectChanges: async () => [],
      sendMessages: async () => {},
      log: () => {},
    }), /news down/);
    assert.deepEqual(order, ['news', 'weekly']);
    assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).lastSuccessfulCommit, 'b'.repeat(40));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('postWebhook sends object messages as the raw payload', async () => {
  const { postWebhook } = await import('./weekly-rocketchat.mjs');
  let body;
  await postWebhook('https://chat.example/hooks/x/y', { text: 't', attachments: [{ title: 'a' }] }, {
    fetchImpl: async (url, init) => { body = JSON.parse(init.body); return new Response('{"success":true}'); },
  });
  assert.deepEqual(body, { text: 't', attachments: [{ title: 'a' }] });
});
