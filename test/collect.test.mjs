import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractNextSteps, parseGithubRemote, computeFlags, diffSnapshots,
  discoverProjects, latestSnapshotBefore, readStatusDocs,
} from '../skills/devbrief/scripts/collect.mjs';

test('extractNextSteps keeps open items under "next" headings and skips done ones', () => {
  const md = [
    '# Launch status',
    '## Done',
    '- Set up the project',
    '## Left to do',
    '1. ~~Write the README.~~ Done.',
    '2. **Add login** (email only).',
    '   - nested detail is ignored',
    '3. [x] Already finished',
    '4. Write the pricing page.',
    '## Notes',
    '- not a task',
    '- [ ] Unchecked box anywhere counts',
  ].join('\n');
  const { title, items } = extractNextSteps(md);
  assert.equal(title, 'Launch status');
  assert.deepEqual(items.map((i) => i.text), [
    'Add login (email only).',
    'Write the pricing page.',
    'Unchecked box anywhere counts',
  ]);
  assert.equal(items[0].section, 'Left to do');
  assert.equal(items[2].section, undefined);
});

test('extractNextSteps reads table rows and skips done rows', () => {
  const md = [
    '# Fix list',
    '## A. In flight right now',
    '| # | Step | Status |',
    '|---|---|---|',
    '| A1 | Fix the slow first page load | running |',
    '| A2 | Add dark mode | done |',
    '## B. Later ideas',
    '| B1 | Not in a next section | open |',
  ].join('\n');
  assert.deepEqual(extractNextSteps(md).items.map((i) => i.text), ['Fix the slow first page load']);
});

test('extractNextSteps caps the number of items', () => {
  const md = '## Next\n' + Array.from({ length: 20 }, (_, i) => `- task ${i}`).join('\n');
  assert.equal(extractNextSteps(md, { maxItems: 5 }).items.length, 5);
});

test('parseGithubRemote handles https and ssh', () => {
  assert.equal(parseGithubRemote('https://github.com/a/b.git'), 'a/b');
  assert.equal(parseGithubRemote('git@github.com:a/b-c.git'), 'a/b-c');
  assert.equal(parseGithubRemote('https://gitlab.com/a/b.git'), null);
  assert.equal(parseGithubRemote(null), null);
});

test('computeFlags ranks broken things above housekeeping', () => {
  const flags = computeFlags({
    git: { branch: 'main', remote: 'x', behind: 2, ahead: 0, uncommitted: 3, lastCommit: { daysAgo: 30 } },
    github: { ci: { conclusion: 'failure', workflowName: 'test' }, openPRs: [{ isDraft: true }] },
    statusDocs: [{}],
  });
  const codes = Object.fromEntries(flags.map((f) => [f.code, f.severity]));
  assert.deepEqual(codes, { 'ci-failing': 'high', behind: 'medium', uncommitted: 'low', stale: 'low' });
});

test('computeFlags notices missing remote and status doc', () => {
  const codes = computeFlags({ git: { branch: 'main', remote: null }, statusDocs: [] }).map((f) => f.code);
  assert.deepEqual(codes, ['no-remote', 'no-status-doc']);
});

test('computeFlags treats commits on no remote as a backup risk', () => {
  const noRemote = computeFlags({ git: { branch: 'main', remote: null, localOnly: 17 }, statusDocs: [{}] });
  assert.equal(noRemote.find((f) => f.code === 'local-only').severity, 'high');
  const newBranch = computeFlags({ git: { branch: 'feat', remote: 'x', upstream: null, localOnly: 2, ahead: 2 }, statusDocs: [{}] });
  assert.deepEqual(newBranch.map((f) => [f.code, f.severity]), [['local-only', 'medium']]);
});

test('diffSnapshots reports new and resolved flags', () => {
  const prev = { date: '2026-10-25', projects: [
    { name: 'a', flags: [{ code: 'behind' }] },
    { name: 'gone', flags: [] },
  ] };
  const curr = { projects: [
    { name: 'a', flags: [{ code: 'ci-failing' }] },
    { name: 'b', flags: [] },
  ] };
  assert.deepEqual(diffSnapshots(prev, curr), { since: '2026-10-25', changes: [
    { project: 'a', added: ['ci-failing'], resolved: ['behind'] },
    { project: 'b', change: 'new project' },
    { project: 'gone', change: 'no longer tracked' },
  ] });
  assert.equal(diffSnapshots(null, curr), null);
});

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devbrief-'));
}

test('discoverProjects finds git repos, applies excludes and detects Vercel', () => {
  const root = tempDir();
  for (const n of ['one', 'two', 'skip']) fs.mkdirSync(path.join(root, n, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'not-a-repo'));
  fs.mkdirSync(path.join(root, 'one', '.vercel'));
  fs.writeFileSync(path.join(root, 'one', '.vercel', 'project.json'), '{"projectId":"prj_1","orgId":"team_1"}');
  const found = discoverProjects({
    roots: [root],
    exclude: ['skip'],
    projects: [{ path: path.join(root, 'two'), name: 'Two', notes: 'hello' }],
  });
  assert.deepEqual(found.map((p) => p.name), ['one', 'Two']);
  assert.deepEqual(found[0].vercel, { projectId: 'prj_1', teamId: 'team_1' });
  assert.equal(found[1].notes, 'hello');
});

test('readStatusDocs stops at the max and records the file', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'STATUS.md'), '# S\n## Next\n- a');
  fs.writeFileSync(path.join(dir, 'docs', 'NEXT.md'), '# N\n## Next\n- b');
  const docs = readStatusDocs(dir, ['STATUS.md', 'missing.md', 'docs/NEXT.md'], 1);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].file, 'STATUS.md');
  assert.equal(docs[0].items[0].text, 'a');
});

test('latestSnapshotBefore picks the newest earlier day', () => {
  const dir = tempDir();
  for (const d of ['2026-10-20', '2026-10-24', '2026-10-26']) {
    fs.writeFileSync(path.join(dir, `${d}.json`), JSON.stringify({ date: d }));
  }
  assert.equal(latestSnapshotBefore(dir, '2026-10-26').date, '2026-10-24');
  assert.equal(latestSnapshotBefore(dir, '2026-10-01'), null);
  assert.equal(latestSnapshotBefore(path.join(dir, 'nope'), '2026-10-26'), null);
});
