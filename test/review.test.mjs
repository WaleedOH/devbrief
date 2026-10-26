import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildReview, reviewWindow, parseGitLog, githubImpact, itemSummary, formatReview,
} from '../skills/devbrief/scripts/review.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repoRoot, 'skills', 'devbrief', 'scripts', 'review.mjs');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrief-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Dates without an offset are local time, so the day a commit lands on is the
// same in every time zone the tests run in.
function makeRepo(dir, commits, nextDoc) {
  const git = (args, date) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd: dir, stdio: 'pipe',
    env: { ...process.env, ...(date && { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }) },
  });
  fs.mkdirSync(dir, { recursive: true });
  git(['-c', 'init.defaultBranch=main', 'init', '--quiet']);
  commits.forEach(([date, subject, lines = 1], i) => {
    fs.writeFileSync(path.join(dir, `file${i}.txt`), 'x\n'.repeat(lines));
    git(['add', '.']);
    git(['commit', '--quiet', '-m', subject, `--date=${date}`], date);
  });
  if (nextDoc) fs.writeFileSync(path.join(dir, 'NEXT.md'), nextDoc);
  return git;
}

const ok = (v) => ({ ok: true, out: JSON.stringify(v) });

function realGit(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, windowsHide: true }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, error: String(stderr || err.message).split('\n')[0] } : { ok: true, out: stdout.trim() });
    });
  });
}

// git runs for real; gh answers from `routes` (first key found in the command
// line wins), and every gh call is recorded.
function execWith(routes) {
  const calls = [];
  const exec = async (cmd, args, cwd) => {
    if (cmd !== 'gh') return realGit(cmd, args, cwd);
    const line = args.join(' ');
    calls.push(line);
    const key = Object.keys(routes).find((k) => line.includes(k));
    return key ? routes[key] : { ok: false, error: 'HTTP 404: Not Found' };
  };
  return { exec, calls };
}

const snapshot = (date, projects) => ({ version: 1, date, projects });
const withItems = (name, ...texts) => ({ name, statusDocs: [{ file: 'NEXT.md', items: texts.map((text) => ({ text })) }] });

function writeSnapshots(home, snaps, sub = 'snapshots') {
  const dir = path.join(home, sub);
  fs.mkdirSync(dir, { recursive: true });
  for (const s of snaps) fs.writeFileSync(path.join(dir, `${s.date}.json`), JSON.stringify(s));
}

test('reviewWindow counts back from the end day, both ends included', () => {
  assert.deepEqual(reviewWindow(7, '2026-10-26'), { from: '2026-10-20', to: '2026-10-26' });
  assert.deepEqual(reviewWindow(1, '2026-10-26'), { from: '2026-10-26', to: '2026-10-26' });
  assert.deepEqual(reviewWindow(7, '2026-03-03'), { from: '2026-02-25', to: '2026-03-03' });
});

test('parseGitLog sums shortstat lines and skips junk', () => {
  const out = [
    '\x1e2026-10-21T10:00:00+02:00\0add search',
    '',
    ' 2 files changed, 10 insertions(+), 3 deletions(-)',
    '\x1e2026-10-22T09:00:00+02:00\0fix typo',
    '',
    ' 1 file changed, 1 insertion(+)',
    '\x1e2026-10-22T11:00:00+02:00\0empty commit',
    '\x1enot a date\0broken',
  ].join('\n');
  const r = parseGitLog(out);
  assert.equal(r.commits.length, 3);
  assert.deepEqual(r.commits.map((c) => c.subject), ['add search', 'fix typo', 'empty commit']);
  assert.match(r.commits[0].date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(r.linesAdded, 11);
  assert.equal(r.linesRemoved, 3);
  assert.deepEqual(parseGitLog(''), { commits: [], linesAdded: 0, linesRemoved: 0 });
});

test('itemSummary leaves the start unknown with a single reading', () => {
  assert.deepEqual(itemSummary([]).openItems, { start: null, end: null });
  assert.deepEqual(itemSummary([['a', 'b']]).openItems, { start: null, end: 2 });
  const s = itemSummary([['a', 'b'], ['b', 'c'], ['c']]);
  assert.deepEqual(s.openItems, { start: 2, end: 1 });
  assert.deepEqual(s.itemsClosed.sort(), ['a', 'b']);
  assert.deepEqual(s.itemsAdded, ['c']);
});

test('githubImpact reads stars, forks, issues and the latest release', async () => {
  const { exec } = execWith({
    'repos/me/shop-api/releases/latest': ok({ tag_name: 'v1.2.0', published_at: '2026-10-21T12:00:00Z' }),
    'repos/me/shop-api': ok({ stargazers_count: 14, forks_count: 2, open_issues_count: 5 }),
  });
  const gh = await githubImpact('me/shop-api', exec);
  assert.equal(gh.stars, 14);
  assert.equal(gh.forks, 2);
  assert.equal(gh.openIssues, 5);
  assert.equal(gh.latestRelease.tag, 'v1.2.0');
  assert.match(gh.latestRelease.date, /^2026-10-2[12]$/);

  const noRelease = execWith({ 'repos/me/landing': ok({ stargazers_count: 0, forks_count: 0, open_issues_count: 0 }) });
  assert.equal((await githubImpact('me/landing', noRelease.exec)).latestRelease, undefined);
  assert.equal(await githubImpact('me/ghost', execWith({}).exec), null);
});

test('buildReview reports commits, items and launch distance per project', async (t) => {
  const base = tmp(t);
  const home = path.join(base, 'devbrief-home');
  const shop = path.join(base, 'shop-api');
  const git = makeRepo(shop, [
    ['2026-10-15T10:00:00', 'old work, before the window', 50],
    ['2026-10-20T09:00:00', 'add cart', 5],
    ['2026-10-20T18:00:00', 'fix cart total', 2],
    ['2026-10-22T12:00:00', 'add checkout', 3],
  ], '# Shop\n## Next\n- fix login\n- add search\n');
  // A feature branch merged back: its commit counts once, the merge not at all.
  git(['checkout', '--quiet', '-b', 'feature']);
  fs.writeFileSync(path.join(shop, 'feature.txt'), 'x\n');
  git(['add', 'feature.txt']);
  git(['commit', '--quiet', '-m', 'add coupons', '--date=2026-10-24T10:00:00'], '2026-10-24T10:00:00');
  git(['checkout', '--quiet', 'main']);
  git(['merge', '--quiet', '--no-ff', '-m', 'merge feature', 'feature'], '2026-10-24T11:00:00');

  const landing = path.join(base, 'landing');
  makeRepo(landing, [['2026-10-01T10:00:00', 'first']]);

  writeSnapshots(home, [
    snapshot('2026-09-01', [withItems('shop-api', 'too old to be the baseline')]),
    snapshot('2026-10-18', [withItems('shop-api', 'write tests', 'fix login', 'add cart'), withItems('landing', 'hero copy')]),
    snapshot('2026-10-23', [withItems('shop-api', 'fix login', 'add cart', 'add search'), withItems('landing', 'hero copy')]),
    snapshot('2026-10-27', [withItems('shop-api', 'after the window')]),
  ]);

  const config = {
    roots: [], exclude: [], statusDocs: ['NEXT.md'], maxStatusDocs: 2,
    projects: [
      { name: 'shop-api', path: shop, github: 'me/shop-api', impact: { signups: true } },
      { name: 'landing', path: landing, notes: 'paused until the launch is done' },
      { name: 'old-prototype', path: path.join(base, 'missing') },
    ],
  };
  const { exec, calls } = execWith({
    'repos/me/shop-api/releases/latest': ok({ tag_name: 'v0.3.0', published_at: '2026-10-22T12:00:00Z' }),
    'repos/me/shop-api': ok({ stargazers_count: 9, forks_count: 1, open_issues_count: 2 }),
  });
  const review = await buildReview(config, {
    days: 7, to: '2026-10-26', now: new Date(2026, 9, 26, 12), home, exec, hasGh: true,
  });

  assert.equal(review.version, 1);
  assert.equal(review.from, '2026-10-20');
  assert.equal(review.to, '2026-10-26');
  assert.equal(review.days, 7);
  assert.deepEqual(review.projects.map((p) => p.name), ['landing', 'old-prototype', 'shop-api']);

  const s = review.projects.find((p) => p.name === 'shop-api');
  assert.deepEqual(s.commits.map((c) => c.subject).sort(), ['add cart', 'add checkout', 'add coupons', 'fix cart total']);
  assert.ok(s.commits.every((c) => /^2026-10-2\d$/.test(c.date)));
  assert.equal(s.activeDays, 3);
  assert.equal(s.linesAdded, 11);
  assert.equal(s.linesRemoved, 0);
  // Baseline 10-18, then 10-23, then the live NEXT.md.
  assert.deepEqual(s.itemsClosed.sort(), ['add cart', 'write tests']);
  assert.deepEqual(s.itemsAdded, ['add search']);
  assert.deepEqual(s.openItems, { start: 3, end: 2 });
  assert.deepEqual(s.github, { stars: 9, forks: 1, openIssues: 2, latestRelease: { tag: 'v0.3.0', date: s.github.latestRelease.date } });
  assert.deepEqual(s.impact, { signups: true });

  const l = review.projects.find((p) => p.name === 'landing');
  assert.equal(l.notes, 'paused until the launch is done');
  assert.deepEqual(l.commits, []);
  assert.equal(l.activeDays, 0);
  // Live read finds no NEXT.md, so the item counts as closed today.
  assert.deepEqual(l.openItems, { start: 1, end: 0 });
  assert.equal(l.github, undefined, 'no GitHub remote, no gh calls');

  const o = review.projects.find((p) => p.name === 'old-prototype');
  assert.ok(o.error, 'a missing repo is reported, not fatal');
  assert.deepEqual(o.commits, []);

  assert.deepEqual(review.totals, { commits: 4, activeProjects: 1, itemsClosed: 3 });
  assert.ok(calls.every((c) => c.includes('me/shop-api')));

  const text = formatReview(review);
  assert.match(text, /4 commits in 1 of 3 projects, 3 items closed/);
  assert.match(text, /shop-api\s+4 commits on 3 days, \+11 -0; 2 closed, 1 added; open 3 -> 2; 9 stars, v0\.3\.0/);
});

test('buildReview ignores live docs for a past window and falls back to remote snapshots', async (t) => {
  const base = tmp(t);
  const home = path.join(base, 'devbrief-home');
  const repo = path.join(base, 'recipes-app');
  makeRepo(repo, [['2026-10-10T10:00:00', 'first']], '# Recipes\n## Next\n- live item\n');
  writeSnapshots(home, [
    snapshot('2026-10-05', [withItems('recipes-app', 'a', 'b')]),
    snapshot('2026-10-11', [withItems('recipes-app', 'b')]),
  ], path.join('snapshots', 'remote'));

  const config = { roots: [], exclude: [], statusDocs: ['NEXT.md'], maxStatusDocs: 2, projects: [{ name: 'recipes-app', path: repo }] };
  const review = await buildReview(config, { days: 7, to: '2026-10-12', now: new Date(2026, 9, 26), home, exec: execWith({}).exec });
  const p = review.projects[0];
  assert.deepEqual(p.commits.map((c) => c.subject), ['first']);
  assert.deepEqual(p.itemsClosed, ['a']);
  assert.deepEqual(p.openItems, { start: 2, end: 1 });
});

test('review.mjs prints JSON and a summary without touching gh', (t) => {
  const base = tmp(t);
  const home = path.join(base, 'devbrief-home');
  const repo = path.join(base, 'pixel-quest');
  makeRepo(repo, [['2026-10-25T10:00:00', 'add level two', 4]]);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ roots: [], projects: [{ name: 'pixel-quest', path: repo }] }));
  const env = { ...process.env, HOME: base, USERPROFILE: base, DEVBRIEF_HOME: home, DEVBRIEF_CONFIG: '' };
  const run = (args) => execFileSync(process.execPath, [script, ...args], { cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });

  const review = JSON.parse(run(['--json', '--no-github', '--to', '2026-10-26']));
  assert.equal(review.projects[0].commits[0].subject, 'add level two');
  assert.equal(review.totals.commits, 1);
  assert.match(run(['--no-github', '--to', '2026-10-26', '--days', '3']), /2026-10-24 to 2026-10-26 \(3 days\)/);
  assert.throws(() => run(['--days', 'zero']), /--days needs a whole number/);
  assert.throws(() => run(['--project', 'nope', '--no-github']), /No project named "nope"/);
});
