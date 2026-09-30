import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildNewsMessage, classifyNews, formatNewsItem, parseDailyNews, runDailyNews } from './daily-news.mjs';
import { main, writeStateAtomic } from './weekly-rocketchat.mjs';

const now = new Date('2026-09-29T01:00:00Z');
const sample = JSON.stringify({
  date: '2026-09-29',
  news: ['上海出台楼市新政：全面加强商品住房预售管理', '  “星舰” 第 14 次试飞首次成功进入地球轨道  ', ''],
  tip: '行动是打破迷茫最好的武器',
  link: 'https://mp.weixin.qq.com/s?x=1',
});

test('parseDailyNews validates the date and trims items', () => {
  assert.deepEqual(parseDailyNews(sample, '2026-09-29'), {
    date: '2026-09-29',
    news: ['上海出台楼市新政：全面加强商品住房预售管理', '“星舰” 第 14 次试飞首次成功进入地球轨道'],
    tip: '行动是打破迷茫最好的武器',
    link: 'https://mp.weixin.qq.com/s?x=1',
  });
  assert.throws(() => parseDailyNews(sample, '2026-09-30'), /date mismatch/);
  assert.throws(() => parseDailyNews({ date: '2026-09-29', news: [] }, '2026-09-29'), /empty/);
});

test('formatNewsItem bolds the headline before the first colon', () => {
  assert.equal(formatNewsItem('上海出台楼市新政：全面加强商品住房预售管理'), '▸ **上海出台楼市新政**\n全面加强商品住房预售管理');
  assert.equal(formatNewsItem('没有冒号的一整条新闻'), '▸ **没有冒号的一整条新闻**');
  const long = `${'很'.repeat(45)}：细节`;
  assert.equal(formatNewsItem(long), `▸ **${long}**`);
});

test('buildNewsMessage groups items into colored category cards', () => {
  const message = buildNewsMessage(parseDailyNews(sample, '2026-09-29'), [{ category: 'economy', headline: '上海楼市新政出台' }, { category: 'tech' }]);
  assert.equal(message.text, '');
  assert.deepEqual(message.attachments[0], { color: '#d93025', title: '📰 今日热点新闻 · 9月29日 周二', text: '2 条要闻，60 秒读懂世界 · [阅读原文](https://mp.weixin.qq.com/s?x=1)' });
  assert.deepEqual(message.attachments.slice(1).map((card) => card.title), ['💰 财经动态（1）', '🔬 科技前沿（1）', undefined]);
  assert.equal(message.attachments[1].text, '▸ **上海楼市新政出台**\n上海出台楼市新政：全面加强商品住房预售管理');
  assert.equal(message.attachments[2].text, '▸ **“星舰” 第 14 次试飞首次成功进入地球轨道**');
  assert.equal(message.attachments[3].text, '💬 **今日微语**\n行动是打破迷茫最好的武器');
});

test('buildNewsMessage falls back to one card without categories', () => {
  const message = buildNewsMessage(parseDailyNews(sample, '2026-09-29'));
  assert.equal(message.attachments[1].title, '📋 今日要闻（2）');
  assert.match(message.attachments[1].text, /\n\n▸ \*\*“星舰”/);
});

test('classifyNews returns categories and headlines, mapping unknown labels to society', async () => {
  const env = { AI_API_BASE: 'https://relay.example/v1', AI_API_KEY: 'k', AI_MODEL: 'm' };
  const reply = (content) => async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  assert.deepEqual(await classifyNews(['a', 'b'], { env, fetchImpl: reply('```json\n[{"c":"economy","t":"标题一"},{"c":"weird","t":" 标题二 "}]\n```') }), [
    { category: 'economy', headline: '标题一' },
    { category: 'society', headline: '标题二' },
  ]);
  await assert.rejects(() => classifyNews(['a', 'b'], { env, fetchImpl: reply('[{"c":"economy","t":"只有一条"}]') }), /unexpected shape/);
  assert.equal(await classifyNews(['a'], { env: {} }), null);
});

test('runDailyNews pushes once per day and waits when data is not published', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'news-'));
  try {
    const stateFile = join(directory, 'news-state.json');
    const sent = [];
    const options = { stateFile, send: async (messages) => sent.push(...messages), writeState: writeStateAtomic, now, classify: async () => null, log: () => {} };
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
