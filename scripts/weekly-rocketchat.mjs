#!/usr/bin/env node
import { spawn as nodeSpawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildMessages,
  classifyChangedPaths,
  diffWeekly,
  parseWeekly,
} from './weekly-rocketchat-lib.mjs';

const REPOSITORY_URL = 'https://github.com/xuanli199/weekly';

export async function runGit(args, { cwd, spawn = nodeSpawn, allowFailure = false } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0 || allowFailure) resolvePromise({ code, stdout, stderr });
      else reject(new Error(`git ${args[0]} failed (${code}): ${stderr.trim().slice(0, 300)}`));
    });
  });
}

export async function readState(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const state = JSON.parse(raw);
    if (state.schemaVersion !== 1 || !/^[0-9a-f]{40}$/i.test(state.lastSuccessfulCommit)) throw new Error('shape');
    return state;
  } catch {
    throw new Error(`Invalid state file: ${path}`);
  }
}

export async function writeStateAtomic(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function collectChanges({ repo, fromCommit, toCommit = 'upstream/main', git = runGit }) {
  const ancestry = await git(['merge-base', '--is-ancestor', fromCommit, toCommit], { cwd: repo, allowFailure: true });
  if (ancestry.code !== 0) throw new Error(`${fromCommit.slice(0, 7)} is not an ancestor of ${toCommit}`);
  const diff = await git(['diff', '--name-status', '-M', fromCommit, toCommit], { cwd: repo });
  const paths = classifyChangedPaths(diff.stdout);
  const changes = [];

  for (const changed of paths) {
    if (changed.status === 'D') {
      const oldDoc = parseWeekly((await git(['show', `${fromCommit}:${changed.path}`], { cwd: repo })).stdout, changed.path);
      changes.push({ kind: 'deleted-issue', issue: oldDoc.issue, issueTitle: oldDoc.title, sourcePath: changed.path, title: oldDoc.title, summary: '', url: '' });
      continue;
    }
    const newDoc = parseWeekly((await git(['show', `${toCommit}:${changed.path}`], { cwd: repo })).stdout, changed.path);
    if (changed.status === 'A') {
      changes.push(...newDoc.entries.map((entry, index) => ({
        kind: index === 0 ? 'new-issue' : 'added',
        issue: newDoc.issue,
        issueTitle: newDoc.title,
        sourcePath: newDoc.sourcePath,
        title: entry.title,
        summary: entry.summary,
        url: entry.url,
      })));
      continue;
    }
    const oldPath = changed.oldPath ?? changed.path;
    const oldDoc = parseWeekly((await git(['show', `${fromCommit}:${oldPath}`], { cwd: repo })).stdout, oldPath);
    changes.push(...diffWeekly(oldDoc, newDoc));
  }
  return changes;
}

function parseArgs(argv) {
  const options = { dryRun: false, initBaseline: false, testWebhook: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--repo' || value === '--state-file') {
      const next = argv[++index];
      if (!next) throw new Error(`Missing value for ${value}`);
      options[value === '--repo' ? 'repo' : 'stateFile'] = resolve(next);
    } else if (value === '--dry-run') options.dryRun = true;
    else if (value === '--init-baseline') options.initBaseline = true;
    else if (value === '--test-webhook') options.testWebhook = true;
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!options.repo && !options.testWebhook) throw new Error('Missing --repo');
  if (!options.stateFile && !options.testWebhook) throw new Error('Missing --state-file');
  return options;
}

const productionDeps = {
  fetchUpstream: async (repo) => { await runGit(['fetch', '--quiet', 'upstream', 'main'], { cwd: repo }); },
  resolveHead: async (repo) => (await runGit(['rev-parse', 'upstream/main'], { cwd: repo })).stdout.trim(),
  collectChanges,
  sendMessages: async () => { throw new Error('Webhook delivery is not implemented'); },
  log: console.log,
};

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const deps = { ...productionDeps, ...dependencies };
  const options = parseArgs(argv);
  if (options.testWebhook) throw new Error('Webhook delivery is not implemented');
  await deps.fetchUpstream(options.repo);
  const head = await deps.resolveHead(options.repo);
  const state = await readState(options.stateFile);
  const nextState = { schemaVersion: 1, lastSuccessfulCommit: head, updatedAt: new Date().toISOString() };

  if (options.initBaseline || state === null) {
    await writeStateAtomic(options.stateFile, nextState);
    deps.log(`Baseline set to ${head.slice(0, 7)}`);
    return { mode: 'baseline-created', commit: head };
  }

  const changes = await deps.collectChanges({ repo: options.repo, fromCommit: state.lastSuccessfulCommit, toCommit: 'upstream/main' });
  const messages = buildMessages(changes, { commit: head, repositoryUrl: REPOSITORY_URL });
  if (options.dryRun) {
    messages.forEach((message) => deps.log(message));
    return { mode: 'dry-run', commit: head, changes: changes.length, messages: messages.length };
  }
  if (messages.length > 0) await deps.sendMessages(messages);
  await writeStateAtomic(options.stateFile, nextState);
  deps.log(`Processed ${head.slice(0, 7)}: ${changes.length} changes, ${messages.length} messages`);
  return { mode: 'processed', commit: head, changes: changes.length, messages: messages.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
