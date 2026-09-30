import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildBbcMessage, parseBbcFeed, runBbcNews, selectFreshArticles, translateArticles } from './bbc-news.mjs';
import { main, writeStateAtomic } from './weekly-rocketchat.mjs';

const item = (id, title, summary, pubDate, thumb = true) => `
        <item>
            <title><![CDATA[${title}]]></title>
            <description><![CDATA[${summary}]]></description>
            <link>https://www.bbc.co.uk/news/articles/${id}?at_medium=RSS&amp;at_campaign=rss</link>
            <guid isPermaLink="false">https://www.bbc.co.uk/news/articles/${id}#0</guid>
            <pubDate>${pubDate}</pubDate>
            ${thumb ? `<media:thumbnail width="240" height="135" url="https://ichef.bbci.co.uk/${id}.jpg"/>` : ''}
        </item>`;

const feed = `<?xml version="1.0"?><rss><channel><title><![CDATA[BBC News]]></title>${[
  item('a1', 'Spain bans evictions', 'The ban must be approved in parliament.', 'Tue, 29 Sep 2026 16:23:58 GMT'),
  item('b2', 'Rebels advance in Ethiopia', 'Fears of a return to civil war.', 'Tue, 29 Sep 2026 12:00:00 GMT', false),
  item('c3', 'Old story', 'Published days ago.', 'Fri, 25 Sep 2026 10:00:00 GMT'),
].join('')}</channel></rss>`;

const now = new Date('2026-09-30T00:00:00Z'); // 北京时间 08:00

test('parseBbcFeed reads CDATA, strips tracking params and keeps thumbnails', () => {
  const items = parseBbcFeed(feed);
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Spain bans evictions');
  assert.equal(items[0].summary, 'The ban must be approved in parliament.');
  assert.equal(items[0].url, 'https://www.bbc.co.uk/news/articles/a1');
  assert.equal(items[0].thumbnail, 'https://ichef.bbci.co.uk/a1.jpg');
  assert.equal(items[1].thumbnail, '');
  assert.throws(() => parseBbcFeed('<rss></rss>'), /no items/);
});

test('selectFreshArticles drops stale and recently pushed articles', () => {
  const items = parseBbcFeed(feed);
  assert.deepEqual(selectFreshArticles(items, [], { now }).map((entry) => entry.title), ['Spain bans evictions', 'Rebels advance in Ethiopia']);
  const pushed = [{ url: 'https://www.bbc.co.uk/news/articles/a1', date: '2026-09-29' }];
  assert.deepEqual(selectFreshArticles(items, pushed, { now }).map((entry) => entry.title), ['Rebels advance in Ethiopia']);
});

test('translateArticles maps titles and summaries in order', async () => {
  const env = { AI_API_BASE: 'https://relay.example/v1', AI_API_KEY: 'k', AI_MODEL: 'm' };
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: '[{"t":"西班牙禁止驱逐","d":"禁令须经议会批准。"},{"t":"埃塞俄比亚叛军推进","d":"外界担忧重回内战。"}]' } }] }));
  const result = await translateArticles(parseBbcFeed(feed).slice(0, 2), { env, fetchImpl });
  assert.equal(result[0].titleZh, '西班牙禁止驱逐');
  assert.equal(result[1].summaryZh, '外界担忧重回内战。');
  await assert.rejects(() => translateArticles(parseBbcFeed(feed), { env, fetchImpl }), /unexpected shape/);
  const untouched = parseBbcFeed(feed);
  assert.equal(await translateArticles(untouched, { env: {} }), untouched);
});

test('buildBbcMessage renders linked cards with thumbnails', () => {
  const items = parseBbcFeed(feed).slice(0, 2);
  items[0].titleZh = '西班牙禁止驱逐';
  items[0].summaryZh = '禁令须经议会批准。';
  const message = buildBbcMessage(items, { date: '2026-09-30' });
  assert.equal(message.text, '');
  assert.deepEqual(message.attachments[0], { color: '#bb1919', title: '🌐 BBC 国际新闻 · 9月30日 周三', text: '2 条 BBC World 要闻（AI 翻译），点击标题看原文' });
  assert.deepEqual(message.attachments[1], {
    color: '#bb1919',
    title: '1️⃣ 西班牙禁止驱逐',
    title_link: 'https://www.bbc.co.uk/news/articles/a1',
    text: '禁令须经议会批准。',
    thumb_url: 'https://ichef.bbci.co.uk/a1.jpg',
  });
  assert.equal(message.attachments[2].title, '2️⃣ Rebels advance in Ethiopia');
  assert.equal('thumb_url' in message.attachments[2], false);
});

test('runBbcNews pushes once a day, falls back to English and records articles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bbc-'));
  try {
    const stateFile = join(directory, 'bbc-state.json');
    const sent = [];
    const options = {
      stateFile,
      send: async (messages) => sent.push(...messages),
      writeState: writeStateAtomic,
      now,
      fetchFeed: async () => feed,
      translate: async () => { throw new Error('relay down'); },
      log: () => {},
    };
    assert.deepEqual(await runBbcNews(options), { messages: 1 });
    assert.equal(sent[0].attachments[1].title, '1️⃣ Spain bans evictions');
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.lastPushedDate, '2026-09-30');
    assert.equal(state.pushed.length, 2);
    assert.deepEqual(await runBbcNews(options), { messages: 0 });
    assert.deepEqual(await runBbcNews({ ...options, now: new Date('2026-10-01T00:00:00Z') }), { messages: 0 });
    assert.equal(sent.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('main pushes news, then BBC, then the weekly flow; a BBC failure does not block the rest', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bbc-main-'));
  try {
    const stateFile = join(directory, 'state.json');
    await writeStateAtomic(stateFile, { schemaVersion: 1, lastSuccessfulCommit: 'a'.repeat(40), updatedAt: 'x' });
    const order = [];
    await assert.rejects(() => main([
      '--repo', directory, '--state-file', stateFile,
      '--news-state-file', join(directory, 'n.json'), '--bbc-state-file', join(directory, 'b.json'),
      '--hn-state-file', join(directory, 'h.json'),
    ], {
      runDailyNews: async () => { order.push('news'); return { messages: 1 }; },
      runBbcNews: async () => { order.push('bbc'); throw new Error('bbc down'); },
      fetchUpstream: async () => { order.push('weekly'); },
      resolveHead: async () => 'b'.repeat(40),
      collectChanges: async () => [],
      sendMessages: async () => {},
      runHackerNewsFallback: async () => { order.push('hn'); return { messages: 1, stories: 1 }; },
      log: () => {},
    }), /bbc down/);
    assert.deepEqual(order, ['news', 'bbc', 'weekly', 'hn']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
