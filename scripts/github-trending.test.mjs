import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildTrendingMessage,
  parseTrending,
  runTrendingFallback,
  selectFresh,
  translateDescriptions,
} from './github-trending.mjs';
import { main, writeStateAtomic } from './weekly-rocketchat.mjs';

const readme = [
  '# GitHub Trending',
  '',
  '## All language',
  '',
  '* 【2026-09-29】[cs341-illinois / coursebook](https://github.com/cs341-illinois/coursebook) - Open Source Systems Programming Textbook',
  '* 【2026-09-28】[vercel-labs / scriptc](https://github.com/vercel-labs/scriptc) - TypeScript-to-Native Compiler',
  '* 【2026-09-28】[someone / nodesc](https://github.com/someone/nodesc)',
  '* 【2026-09-20】[cloudflare / quiche](https://github.com/cloudflare/quiche) - QUIC',
  '',
  '## Java',
  '',
  '* 【2026-09-29】[java / only](https://github.com/java/only) - Java section item',
].join('\n');

const now = new Date('2026-09-29T01:00:00Z');

test('parseTrending reads only the All language section', () => {
  const entries = parseTrending(readme);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[0], {
    date: '2026-09-29',
    name: 'cs341-illinois/coursebook',
    url: 'https://github.com/cs341-illinois/coursebook',
    description: 'Open Source Systems Programming Textbook',
  });
  assert.equal(entries[2].description, '');
  assert.ok(!entries.some((entry) => entry.name === 'java/only'));
});

test('parseTrending rejects a README without the expected section', () => {
  assert.throws(() => parseTrending('# nothing'), /All language/);
});

test('selectFresh skips pushed and stale projects, newest first', () => {
  const fresh = selectFresh(parseTrending(readme), ['https://github.com/vercel-labs/scriptc'], { now });
  assert.deepEqual(fresh.map((entry) => entry.name), ['cs341-illinois/coursebook', 'someone/nodesc']);
});

test('translateDescriptions uses the OpenAI-compatible endpoint and keeps order', async () => {
  const entries = parseTrending(readme).slice(0, 3);
  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n["开源系统编程教材","vercel-labs/scriptc：TypeScript 原生编译器"]\n```' } }] }));
  };
  const env = { AI_API_BASE: 'https://relay.example/v1/', AI_API_KEY: 'k', AI_MODEL: 'm' };
  const result = await translateDescriptions(entries, { env, fetchImpl });
  assert.equal(request.url, 'https://relay.example/v1/chat/completions');
  assert.equal(request.init.headers.authorization, 'Bearer k');
  assert.equal(result[0].descriptionZh, '开源系统编程教材');
  assert.equal(result[1].descriptionZh, 'TypeScript 原生编译器');
  assert.equal(result[2].descriptionZh, undefined);
});

test('translateDescriptions is a no-op without configuration', async () => {
  const entries = parseTrending(readme);
  const result = await translateDescriptions(entries, { env: {}, fetchImpl: async () => assert.fail('should not call') });
  assert.equal(result, entries);
});

test('translateDescriptions rejects a mismatched response', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: '["只有一条"]' } }] }));
  const env = { AI_API_BASE: 'https://relay.example/v1', AI_API_KEY: 'k', AI_MODEL: 'm' };
  await assert.rejects(() => translateDescriptions(parseTrending(readme).slice(0, 2), { env, fetchImpl }), /unexpected shape/);
});

test('buildTrendingMessage prefers Chinese descriptions', () => {
  const message = buildTrendingMessage([
    { name: 'a/b', url: 'https://github.com/a/b', description: 'English', descriptionZh: '中文' },
    { name: 'c/d', url: 'https://github.com/c/d', description: 'Only English' },
  ], { date: '2026-09-29' });
  assert.match(message, /^【GitHub 今日热点】2026-09-29/);
  assert.match(message, /1\. \*\*a\/b\*\*\n中文\nhttps:\/\/github\.com\/a\/b/);
  assert.match(message, /Only English/);
  assert.doesNotMatch(message, /English\nhttps:\/\/github\.com\/a\/b/);
});

test('runTrendingFallback pushes once, records URLs, then stays silent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trending-'));
  try {
    const stateFile = join(directory, 'trending-state.json');
    const sent = [];
    const options = {
      stateFile,
      send: async (messages) => sent.push(...messages),
      writeState: writeStateAtomic,
      now,
      fetchMarkdown: async () => readme,
      translate: async (entries) => entries,
      log: () => {},
    };
    assert.deepEqual(await runTrendingFallback(options), { messages: 1, projects: 3 });
    assert.equal(sent.length, 1);
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.equal(state.pushedUrls.length, 3);
    assert.deepEqual(await runTrendingFallback(options), { messages: 0, projects: 0 });
    assert.equal(sent.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runTrendingFallback falls back to English when translation fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trending-'));
  try {
    const sent = [];
    await runTrendingFallback({
      stateFile: join(directory, 'state.json'),
      send: async (messages) => sent.push(...messages),
      writeState: writeStateAtomic,
      now,
      fetchMarkdown: async () => readme,
      translate: async () => { throw new Error('boom'); },
      log: () => {},
    });
    assert.match(sent[0], /TypeScript-to-Native Compiler/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runTrendingFallback does not send or record state on delivery failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'trending-'));
  try {
    const stateFile = join(directory, 'state.json');
    await assert.rejects(() => runTrendingFallback({
      stateFile,
      send: async () => { throw new Error('down'); },
      writeState: writeStateAtomic,
      now,
      fetchMarkdown: async () => readme,
      translate: async (entries) => entries,
      log: () => {},
    }), /down/);
    await assert.rejects(() => readFile(stateFile), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function runMain(weeklyMessages) {
  const directory = await mkdtemp(join(tmpdir(), 'trending-main-'));
  const stateFile = join(directory, 'state.json');
  await writeStateAtomic(stateFile, { schemaVersion: 1, lastSuccessfulCommit: 'a'.repeat(40), updatedAt: 'x' });
  const calls = [];
  try {
    await main(['--repo', directory, '--state-file', stateFile, '--trending-state-file', join(directory, 't.json')], {
      fetchUpstream: async () => {},
      resolveHead: async () => 'b'.repeat(40),
      collectChanges: async () => weeklyMessages,
      sendMessages: async () => {},
      runTrendingFallback: async (options) => { calls.push(options); return { messages: 1, projects: 1 }; },
      log: () => {},
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  return calls;
}

test('main runs the trending fallback only when the weekly has no update', async () => {
  assert.equal((await runMain([])).length, 1);
  const change = { kind: 'new-issue', issue: '119', issueTitle: '【119】', sourcePath: 'docs/119.md', title: '1.A', summary: 's', url: 'https://example.com', document: '# 【119】\n\n## 1.A\n\ns\n\nhttps://example.com\n' };
  assert.equal((await runMain([change])).length, 0);
});
