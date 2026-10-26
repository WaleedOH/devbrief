import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  remoteTargets, fetchRemoteStatusDocs, collectRemote, computeFlags, latestSnapshotBefore,
} from '../skills/devbrief/scripts/collect.mjs';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const ok = (v) => ({ ok: true, out: JSON.stringify(v) });

// A fake runner: the first route whose key is contained in "cmd args..." wins.
// Every call is recorded so tests can check what was (not) fetched.
function fakeExec(routes) {
  const calls = [];
  const exec = async (cmd, args) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    const key = Object.keys(routes).find((k) => line.includes(k));
    if (!key) return { ok: false, error: `HTTP 404: Not Found (${line})` };
    const r = routes[key];
    return typeof r === 'function' ? r(line) : r;
  };
  return { exec, calls };
}

const base = { roots: [], projects: [], exclude: [], statusDocs: ['LAUNCH-STATUS.md', 'docs/LAUNCH-STATUS.md', 'NEXT.md', 'docs/NEXT.md'], maxStatusDocs: 2, staleDays: 14 };

test('remoteTargets lists owner repos, skips archived, forks and excludes, and dedupes', async () => {
  const { exec } = fakeExec({
    'repo list me': ok([
      { name: 'app', nameWithOwner: 'me/app', isArchived: false, isFork: false, defaultBranchRef: { name: 'main' }, pushedAt: '2026-10-25T00:00:00Z' },
      { name: 'old', nameWithOwner: 'me/old', isArchived: true, isFork: false },
      { name: 'forked', nameWithOwner: 'me/forked', isArchived: false, isFork: true },
      { name: 'dotfiles', nameWithOwner: 'me/dotfiles', isArchived: false, isFork: false },
      { name: 'Game', nameWithOwner: 'me/Game', isArchived: false, isFork: false, defaultBranchRef: { name: 'dev' } },
    ]),
  });
  const config = {
    ...base,
    exclude: ['dotfiles'],
    remote: { owners: ['me'] },
    projects: [
      { name: 'My App', path: '/nowhere/app', github: 'me/app', notes: 'launch first' },
      { name: 'game', path: '/nowhere/game', statusDocs: ['docs/NEXT.md'] },
      { name: 'friend', path: '/nowhere/friend', github: 'them/friend' },
    ],
  };
  const { targets, errors } = await remoteTargets(config, exec);
  assert.deepEqual(errors, []);
  assert.deepEqual(targets.map((t) => t.repo), ['them/friend', 'me/Game', 'me/app']);
  const app = targets.find((t) => t.repo === 'me/app');
  assert.equal(app.name, 'My App');
  assert.equal(app.notes, 'launch first');
  assert.equal(app.defaultBranch, 'main');
  assert.equal(app.path, undefined);
  const game = targets.find((t) => t.repo === 'me/Game');
  assert.deepEqual(game.statusDocs, ['docs/NEXT.md'], 'configured project matched by repo name');

  const withForks = await remoteTargets({ ...config, remote: { owners: ['me'], includeForks: true } }, exec);
  assert.ok(withForks.targets.some((t) => t.repo === 'me/forked'));
});

test('remoteTargets reports an owner it cannot list without failing', async () => {
  const { exec } = fakeExec({});
  const { targets, errors } = await remoteTargets({ ...base, remote: { owners: ['ghost'] } }, exec);
  assert.deepEqual(targets, []);
  assert.match(errors[0], /could not list repos for ghost/);
});

test('fetchRemoteStatusDocs lists directories once and fetches only docs that exist', async () => {
  const { exec, calls } = fakeExec({
    'contents/docs/NEXT.md?ref=main': ok({ encoding: 'base64', content: b64('# Next\n## Next\n- [ ] ship it\n') }),
    'contents/docs?ref=main': ok([{ name: 'NEXT.md', type: 'file' }, { name: 'LAUNCH-STATUS.md', type: 'dir' }]),
    'contents/NEXT.md?ref=main': ok({ encoding: 'base64', content: b64('# Root\n## Up next\n1. write docs\n') }),
    'contents?ref=main': ok([{ name: 'NEXT.md', type: 'file' }, { name: 'docs', type: 'dir' }, { name: 'README.md', type: 'file' }]),
    'path=NEXT.md': ok([{ commit: { committer: { date: '2026-10-20T10:00:00Z' } } }]),
  });
  const { docs, errors } = await fetchRemoteStatusDocs('me/app', 'main', base.statusDocs, 5, exec);
  assert.deepEqual(errors, []);
  assert.deepEqual(docs.map((d) => d.file), ['NEXT.md', 'docs/NEXT.md']);
  assert.equal(docs[0].title, 'Root');
  assert.equal(docs[0].items[0].text, 'write docs');
  assert.equal(docs[0].updated, '2026-10-20');
  assert.equal(docs[1].items[0].text, 'ship it');
  assert.equal(docs[1].updated, undefined);
  const listings = calls.filter((c) => /contents(\/docs)?\?ref=/.test(c));
  assert.equal(listings.length, 2, 'root and docs/ are each listed once');
  assert.ok(!calls.some((c) => c.includes('LAUNCH-STATUS.md')), 'missing docs are never fetched');
});

test('fetchRemoteStatusDocs honors maxStatusDocs and skips docs/ when the root has none', async () => {
  const { exec, calls } = fakeExec({
    'contents/LAUNCH-STATUS.md': ok({ encoding: 'base64', content: b64('## Next\n- a\n') }),
    'contents?ref=dev': ok([{ name: 'LAUNCH-STATUS.md', type: 'file' }, { name: 'NEXT.md', type: 'file' }]),
  });
  const { docs } = await fetchRemoteStatusDocs('me/app', 'dev', base.statusDocs, 1, exec);
  assert.deepEqual(docs.map((d) => d.file), ['LAUNCH-STATUS.md']);
  assert.ok(!calls.some((c) => c.includes('contents/docs')));
  assert.ok(!calls.some((c) => c.includes('contents/NEXT.md')));
});

function repoRoutes(lastCommitDate) {
  return {
    'repo list me': ok([{ name: 'app', nameWithOwner: 'me/app', isArchived: false, isFork: false, defaultBranchRef: { name: 'main' } }]),
    'commits?sha=main&per_page=1': ok([{ commit: { committer: { date: lastCommitDate }, message: 'Fix login\n\nlong body' } }]),
    'pr list': ok([{ number: 3, title: 'Feature', isDraft: false, updatedAt: '2026-10-25T00:00:00Z' }]),
    'issue list': ok([{ number: 9, title: 'Bug', updatedAt: '2026-10-24T00:00:00Z' }]),
    'run list': ok([{ workflowName: 'test', status: 'completed', conclusion: 'failure', createdAt: '2026-10-25T00:00:00Z', url: 'u' }]),
    'contents?ref=main': ok([{ name: 'README.md', type: 'file' }]),
  };
}

test('collectRemote builds the local snapshot shape without local-only fields', async () => {
  const { exec } = fakeExec(repoRoutes('2026-10-01T12:00:00Z'));
  const config = { ...base, remote: { owners: ['me'] } };
  const { projects, errors } = await collectRemote(config, { exec, now: new Date('2026-10-26T12:00:00Z') });
  assert.deepEqual(errors, []);
  assert.equal(projects.length, 1);
  const [p] = projects;
  assert.equal(p.source, 'remote');
  assert.equal(p.path, undefined);
  assert.deepEqual(p.git, {
    remote: 'https://github.com/me/app',
    github: 'me/app',
    branch: 'main',
    lastCommit: { date: '2026-10-01T12:00:00Z', subject: 'Fix login', daysAgo: 25 },
  });
  assert.equal(p.github.openPRs.length, 1);
  assert.equal(p.github.openIssues.count, 1);
  assert.equal(p.github.ci.conclusion, 'failure');
  assert.deepEqual(p.statusDocs, []);
  assert.deepEqual(p.flags.map((f) => f.code).sort(), ['ci-failing', 'no-status-doc', 'open-prs', 'stale']);
});

test('a failing repo is reported per project and does not stop the run', async () => {
  const routes = repoRoutes('2026-10-25T12:00:00Z');
  routes['repo list me'] = ok([
    { name: 'app', nameWithOwner: 'me/app', isArchived: false, isFork: false, defaultBranchRef: { name: 'main' } },
    { name: 'broken', nameWithOwner: 'me/broken', isArchived: false, isFork: false },
  ]);
  routes['api repos/me/broken'] = { ok: false, error: 'timed out after 20s' };
  const { exec } = fakeExec(routes);
  const { projects } = await collectRemote({ ...base, remote: { owners: ['me'] } }, { exec, now: new Date('2026-10-26T12:00:00Z') });
  const broken = projects.find((p) => p.name === 'broken');
  assert.equal(broken.git.error, 'timed out after 20s');
  assert.equal(broken.flags[0].code, 'repo-error');
  assert.match(broken.flags[0].message, /could not read the repo from GitHub/);
  assert.ok(projects.find((p) => p.name === 'app').git.lastCommit);
});

test('remote projects never get flags that only make sense for a clone', () => {
  const flags = computeFlags({
    source: 'remote',
    git: { branch: 'main', remote: 'https://github.com/me/app', github: 'me/app', lastCommit: { daysAgo: 1 } },
    statusDocs: [{}],
  });
  assert.deepEqual(flags, []);
  const missingRemote = computeFlags({ source: 'remote', git: { branch: 'main' }, statusDocs: [{}] });
  assert.deepEqual(missingRemote, []);
});

test('latestSnapshotBefore with a mode skips snapshots of the other mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrief-'));
  fs.writeFileSync(path.join(dir, '2026-10-23.json'), JSON.stringify({ date: '2026-10-23', mode: 'remote' }));
  fs.writeFileSync(path.join(dir, '2026-10-24.json'), JSON.stringify({ date: '2026-10-24' }));
  fs.writeFileSync(path.join(dir, '2026-10-25.json'), JSON.stringify({ date: '2026-10-25', mode: 'remote' }));
  assert.equal(latestSnapshotBefore(dir, '2026-10-26', 'remote').date, '2026-10-25');
  assert.equal(latestSnapshotBefore(dir, '2026-10-26', 'local').date, '2026-10-24');
  assert.equal(latestSnapshotBefore(dir, '2026-10-26').date, '2026-10-25');
  assert.equal(latestSnapshotBefore(dir, '2026-10-24', 'local'), null);
});
