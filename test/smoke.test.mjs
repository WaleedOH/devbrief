// End to end: runs the real collector as a child process against a throwaway
// repo, the way Claude runs it. Needs git, but not gh or a network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const collector = path.join(repoRoot, 'skills', 'devbrief', 'scripts', 'collect.mjs');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrief-smoke-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// CI machines have no git identity, so every commit brings its own.
function makeRepo(dir) {
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  fs.mkdirSync(dir, { recursive: true });
  git('-c', 'init.defaultBranch=main', 'init', '--quiet');
  // CRLF on purpose: that is how a Windows checkout can hand the doc over.
  fs.writeFileSync(path.join(dir, 'STATUS.md'), [
    '# Smoke status', '', '## Done', '- Set up the repo', '',
    '## Next', '- Write the landing page', '- Ship the first release', '',
  ].join('\r\n'));
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'first');
}

// A fake home keeps "~" and the default ~/.devbrief away from the real ones.
function runCollector(args, env) {
  return execFileSync(process.execPath, [collector, ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
  });
}

function fakeHomeEnv(home, devbriefHome) {
  return { HOME: home, USERPROFILE: home, DEVBRIEF_HOME: devbriefHome, DEVBRIEF_CONFIG: '' };
}

test('collector prints a snapshot with next steps and saves it', (t) => {
  const base = tmp(t);
  const repo = path.join(base, 'smoke-app');
  const devbriefHome = path.join(base, 'devbrief-home');
  makeRepo(repo);
  fs.mkdirSync(devbriefHome);
  fs.writeFileSync(path.join(devbriefHome, 'config.json'), JSON.stringify({
    roots: [], projects: [{ name: 'smoke-app', path: repo }],
  }));

  const out = runCollector(['--no-fetch'], fakeHomeEnv(base, devbriefHome));
  const snapshot = JSON.parse(out);

  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.projects.length, 1);
  const p = snapshot.projects[0];
  assert.equal(p.name, 'smoke-app');
  assert.equal(p.git.branch, 'main');
  assert.equal(p.git.lastCommit.subject, 'first');
  assert.equal(p.statusDocs[0].file, 'STATUS.md');
  assert.deepEqual(p.statusDocs[0].items.map((i) => i.text), ['Write the landing page', 'Ship the first release']);
  assert.ok(p.flags.some((f) => f.code === 'no-remote'));

  const snaps = fs.readdirSync(path.join(devbriefHome, 'snapshots'));
  assert.deepEqual(snaps, [`${snapshot.date}.json`]);
  const saved = JSON.parse(fs.readFileSync(path.join(devbriefHome, 'snapshots', snaps[0]), 'utf8'));
  assert.equal(saved.generatedAt, snapshot.generatedAt);
});

test('--init writes a config from the repos under the home folder', (t) => {
  const home = tmp(t);
  const devbriefHome = path.join(home, '.devbrief');
  makeRepo(path.join(home, 'smoke-app'));
  fs.mkdirSync(path.join(home, 'not-a-repo'));

  runCollector(['--init'], fakeHomeEnv(home, devbriefHome));

  const config = JSON.parse(fs.readFileSync(path.join(devbriefHome, 'config.json'), 'utf8'));
  assert.deepEqual(config.projects, [{ name: 'smoke-app', path: '~/smoke-app' }]);

  // A second --init must refuse rather than overwrite the user's edits.
  assert.throws(() => runCollector(['--init'], fakeHomeEnv(home, devbriefHome)), /already exists/);
});
