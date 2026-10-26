import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planTasks, parseOutdated, gatherExtras, readRepoInfo, isOptedIn, formatPlan, slugify, removeWorktree,
  readLog, appendLog, summarizeLog, lastNightSummary, formatSummary,
} from '../skills/devbrief/scripts/nightshift.mjs';

const script = fileURLToPath(new URL('../skills/devbrief/scripts/nightshift.mjs', import.meta.url));
const DATE = '2026-03-04';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrief-night-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function project(name, over = {}) {
  return {
    name,
    path: `/fake/${name}`,
    git: { branch: 'main', github: `example/${name}`, ahead: 0, behind: 0, localOnly: 0, uncommitted: 0, ...over.git },
    github: { openPRs: [], ci: null, ...over.github },
    statusDocs: over.statusDocs || [],
    flags: [],
    ...(over.notes && { notes: over.notes }),
    ...(over.advisors && { advisors: over.advisors }),
  };
}

const failingCi = { github: { ci: { conclusion: 'failure', workflowName: 'test', url: 'https://example.invalid/run/1' } } };
const autoDoc = (text) => ({ statusDocs: [{ file: 'docs/NEXT.md', items: [{ text, section: 'Next' }] }] });
const nodeRepo = { testScript: 'node --test', packageManager: 'npm', hasPackageJson: true };

test('only opted-in projects get tasks', () => {
  const snapshot = { date: DATE, projects: [project('shop-api', failingCi), project('landing', failingCi), project('recipes-app', failingCi)] };
  const config = { projects: [{ name: 'shop-api', path: '~/shop-api', nightShift: true }, { name: 'recipes-app', path: '~/r', nightShift: false }], nightShift: { projects: ['landing', 'recipes-app'] } };
  assert.equal(isOptedIn(snapshot.projects[2], config), false, 'an explicit false on the project wins');
  const plan = planTasks(snapshot, config, { date: DATE });
  assert.deepEqual(plan.tasks.map((t) => t.project).sort(), ['landing', 'shop-api']);
  assert.equal(planTasks(snapshot, {}, { date: DATE }).tasks.length, 0, 'nothing without opt-in');
});

test('a task has the documented shape and a dated night shift branch', () => {
  const snapshot = { date: DATE, projects: [project('shop-api', failingCi)] };
  const config = { nightShift: { projects: ['shop-api'] } };
  const [task] = planTasks(snapshot, config, { repoInfo: { 'shop-api': nodeRepo } }).tasks;
  assert.deepEqual(task, {
    id: 'shop-api-ci-fix', project: 'shop-api', kind: 'ci-failing', title: 'Fix failing CI "test"', risk: 'medium',
    why: 'The last "test" run on main failed (https://example.invalid/run/1).',
    branch: `devbrief/nightshift/${DATE}-shop-api-ci-fix`, base: 'main', checks: ['npm test'], ciUrl: 'https://example.invalid/run/1',
  });
});

test('work in progress, paused projects and repos without GitHub are left alone', () => {
  const projects = [
    project('dirty', { ...failingCi, git: { uncommitted: 2 } }),
    project('local', { ...failingCi, git: { localOnly: 1 } }),
    project('unpushed', { ...failingCi, git: { ahead: 3 } }),
    project('old-prototype', { ...failingCi, notes: 'Paused until spring' }),
    project('archive', { ...failingCi, notes: 'archived' }),
    project('offline', { ...failingCi, git: { github: null } }),
    project('feature', { ...failingCi, git: { branch: 'add-cart' } }),
  ];
  const config = { nightShift: { projects: projects.map((p) => p.name) } };
  const plan = planTasks({ date: DATE, projects }, config, { repoInfo: { feature: { defaultBranch: 'main' } } });
  assert.deepEqual(plan.tasks, []);
  const why = Object.fromEntries(plan.skipped.map((s) => [s.project, s.reason]));
  assert.match(why.dirty, /2 uncommitted/);
  assert.match(why.local, /only on this machine/);
  assert.match(why.unpushed, /3 unpushed/);
  assert.match(why['old-prototype'], /Paused/);
  assert.match(why.archive, /archived/);
  assert.match(why.offline, /no GitHub remote/);
  assert.match(why.feature, /not on main.*work in progress/);
});

test('a task with an open night shift PR from an earlier night is skipped', () => {
  const projects = [project('shop-api', failingCi), project('landing', { github: { ...failingCi.github, openPRs: [{ number: 4, headRefName: 'devbrief/nightshift/2026-03-01-landing-ci-fix' }] } })];
  const config = { nightShift: { projects: ['shop-api', 'landing'] } };
  const plan = planTasks({ date: DATE, projects }, config, { openBranches: { 'shop-api': ['devbrief/nightshift/2026-03-02-shop-api-ci-fix'] } });
  assert.deepEqual(plan.tasks, []);
  assert.equal(plan.skipped.filter((s) => /already open/.test(s.reason)).length, 2);
  // A different task in the same project is not blocked.
  const other = planTasks({ date: DATE, projects: [project('shop-api', autoDoc('Fix the typo in the README [auto]'))] }, config,
    { openBranches: { 'shop-api': ['devbrief/nightshift/2026-03-02-shop-api-ci-fix'] } });
  assert.equal(other.tasks.length, 1);
});

test('tasks are sorted by value over risk and capped at max', () => {
  const projects = [
    project('landing', autoDoc('Add alt text to the hero image (nightshift)')),
    project('pixel-quest', autoDoc('Fix the typo in the README [auto]')),
    project('recipes-app'),
    project('shop-api', failingCi),
  ];
  const config = { nightShift: { projects: projects.map((p) => p.name), max: 2 } };
  const repoInfo = { 'recipes-app': { ...nodeRepo, outdated: { tiny: { current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' } } } };
  const all = planTasks({ date: DATE, projects }, config, { repoInfo, max: 10 });
  assert.deepEqual(all.tasks.map((t) => `${t.project}:${t.kind}:${t.risk}`), [
    'pixel-quest:doc-auto:low',
    'shop-api:ci-failing:medium',
    'landing:doc-auto:medium',
    'recipes-app:deps-patch:low',
  ]);
  const capped = planTasks({ date: DATE, projects }, config, { repoInfo });
  assert.equal(capped.tasks.length, 2, 'config max applies');
  assert.equal(capped.skipped.filter((s) => /over the limit of 2/.test(s.reason)).length, 2);
  assert.equal(planTasks({ date: DATE, projects }, config, { repoInfo, max: 1 }).tasks.length, 1, 'extras max wins');
});

test('doc-auto strips the tag and refuses items that touch secrets, migrations or deploys', () => {
  const projects = [project('landing', {
    statusDocs: [{ file: 'NEXT.md', items: [
      { text: '[auto] Rename the footer links' },
      { text: 'Rotate the API keys [auto]' },
      { text: 'Add a migration for orders (nightshift)' },
      { text: 'Write the pricing page' },
    ] }],
  })];
  const plan = planTasks({ date: DATE, projects }, { nightShift: { projects: ['landing'] } });
  assert.deepEqual(plan.tasks.map((t) => [t.title, t.risk]), [['Rename the footer links', 'low']]);
  assert.equal(plan.tasks[0].branch, `devbrief/nightshift/${DATE}-landing-rename-the-footer-links`);
  assert.equal(plan.skipped.length, 2);
  assert.ok(plan.skipped.every((s) => /never changes/.test(s.reason)));
});

test('advisor cleanups need a known lint and a migrations folder', () => {
  const advisors = [{ name: 'function_search_path_mutable', level: 'WARN' }, { name: 'function_search_path_mutable', level: 'WARN' }, { name: 'rls_disabled_in_public', level: 'ERROR' }];
  const projects = [project('shop-api', { advisors }), project('recipes-app')];
  const config = { nightShift: { projects: ['shop-api', 'recipes-app'] } };
  const plan = planTasks({ date: DATE, projects }, config, {
    repoInfo: { 'shop-api': { hasMigrations: true }, 'recipes-app': { hasMigrations: false } },
    advisors: { 'recipes-app': [{ name: 'unindexed_foreign_keys', level: 'INFO' }] },
  });
  assert.deepEqual(plan.tasks.map((t) => [t.project, t.kind, t.advisor]), [['shop-api', 'advisor-cleanup', 'function_search_path_mutable']]);
  assert.match(plan.tasks[0].why, /2 time\(s\).*does not apply it/);
  assert.match(plan.skipped.find((s) => s.project === 'recipes-app').reason, /no supabase\/migrations/);
});

test('parseOutdated keeps patch and minor updates and drops majors, 0.x minors and odd versions', () => {
  const json = {
    express: { current: '4.18.2', wanted: '4.18.2', latest: '5.0.1' },
    lodash: { current: '4.17.20', wanted: '4.17.21', latest: '4.17.21' },
    vite: { current: '5.1.0', wanted: '5.1.0', latest: '5.4.2' },
    zod: { current: '0.3.1', wanted: '0.3.4', latest: '0.4.0' },
    tiny: { current: '0.0.1', wanted: '0.0.1', latest: '0.0.2' },
    missing: { wanted: '1.0.0', latest: '1.0.0' },
    beta: { current: '1.0.0', wanted: '1.0.0', latest: '1.1.0-rc.1' },
    linked: { current: 'linked', wanted: 'linked', latest: '2.0.0' },
    workspace: [{ current: '2.0.0', wanted: '2.0.3', latest: '2.0.3', dependent: 'a' }],
  };
  assert.deepEqual(parseOutdated(json), [
    { name: 'lodash', from: '4.17.20', to: '4.17.21', bump: 'patch' },
    { name: 'vite', from: '5.1.0', to: '5.4.2', bump: 'minor' },
    { name: 'workspace', from: '2.0.0', to: '2.0.3', bump: 'patch' },
    { name: 'zod', from: '0.3.1', to: '0.3.4', bump: 'patch' },
  ]);
  assert.deepEqual(parseOutdated(null), []);
});

test('deps-patch needs a test script to verify the update', () => {
  const projects = [project('recipes-app'), project('landing')];
  const outdated = { lodash: { current: '4.17.20', wanted: '4.17.21', latest: '4.17.21' } };
  const plan = planTasks({ date: DATE, projects }, { nightShift: { projects: ['recipes-app', 'landing'] } }, {
    repoInfo: { 'recipes-app': { ...nodeRepo, outdated }, landing: { hasPackageJson: true, packageManager: 'npm', outdated } },
  });
  assert.deepEqual(plan.tasks.map((t) => t.project), ['recipes-app']);
  assert.deepEqual(plan.tasks[0].checks, ['npm ci', 'npm test']);
  assert.deepEqual(plan.tasks[0].packages, [{ name: 'lodash', from: '4.17.20', to: '4.17.21', bump: 'patch' }]);
  assert.match(plan.skipped.find((s) => s.project === 'landing').reason, /no test script/);
});

test('gatherExtras reads the repo and parses stubbed npm and gh output', async (t) => {
  const dir = tmp(t);
  const repo = path.join(dir, 'recipes-app');
  fs.mkdirSync(path.join(repo, 'supabase', 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(repo, 'package-lock.json'), '{}');
  const calls = [];
  const exec = async (cmd, args, cwd) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'git') return { ok: true, out: 'origin/trunk' };
    // npm outdated exits 1 when something is outdated; stdout still has the JSON.
    if (cmd === 'npm') return { ok: false, error: 'exit 1', out: JSON.stringify({ lodash: { current: '4.17.20', wanted: '4.17.21', latest: '4.17.21' } }) };
    if (cmd === 'gh') return { ok: true, out: JSON.stringify([{ headRefName: 'devbrief/nightshift/2026-03-01-recipes-app-deps' }, { headRefName: 'feature-x' }]) };
    throw new Error(`unexpected ${cmd}`);
  };
  const p = { ...project('recipes-app'), path: repo };
  const skipMe = project('landing');
  const config = { nightShift: { projects: ['recipes-app'] } };
  const extras = await gatherExtras([p, skipMe], config, { exec });
  assert.deepEqual(Object.keys(extras.repoInfo), ['recipes-app'], 'projects that did not opt in are never touched');
  const info = extras.repoInfo['recipes-app'];
  assert.equal(info.defaultBranch, 'trunk');
  assert.equal(info.testScript, 'node --test');
  assert.equal(info.hasMigrations, true);
  assert.deepEqual(extras.openBranches['recipes-app'], ['devbrief/nightshift/2026-03-01-recipes-app-deps']);
  assert.ok(calls.includes('npm outdated --json'));

  const plan = planTasks({ date: DATE, projects: [p] }, config, extras);
  assert.deepEqual(plan.tasks, [], 'the deps PR from an earlier night is still open');

  calls.length = 0;
  await gatherExtras([p], config, { exec, offline: true });
  assert.deepEqual(calls, ['git symbolic-ref --short refs/remotes/origin/HEAD'], 'offline never runs npm or gh');
});

test('readRepoInfo ignores the npm placeholder test and notes other package managers', (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'package.json'), '﻿' + JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
  fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
  assert.deepEqual(readRepoInfo(dir), { packageManager: 'pnpm', hasPackageJson: true, hasMigrations: false });
});

test('log round-trip: append, read, summarize, and the morning line', (t) => {
  const dir = tmp(t);
  assert.deepEqual(readLog(dir, DATE), { date: DATE, entries: [] });
  appendLog(dir, DATE, { project: 'shop-api', title: 'Fix failing CI "test"', branch: 'devbrief/nightshift/x', result: 'opened', pr: 'https://example.invalid/pr/7' });
  appendLog(dir, DATE, { project: 'landing', title: 'Rename links', result: 'failed', reason: 'tests failed after the change' });
  appendLog(dir, DATE, { project: 'pixel-quest', result: 'skipped', reason: 'out of time' });
  assert.throws(() => appendLog(dir, DATE, { project: 'x', result: 'merged' }), /result/);
  assert.throws(() => appendLog(dir, DATE, { project: 'x', result: 'opened' }), /pr/);
  assert.throws(() => appendLog(dir, DATE, { project: 'x', result: 'failed' }), /reason/);
  assert.throws(() => appendLog(dir, '../evil', { project: 'x', result: 'skipped', reason: 'r' }), /not a date/);

  const log = readLog(dir, DATE);
  assert.equal(log.entries.length, 3);
  assert.ok(log.entries.every((e) => !Number.isNaN(Date.parse(e.at))));
  const summary = summarizeLog(log);
  assert.deepEqual(summary.opened, [{ project: 'shop-api', title: 'Fix failing CI "test"', branch: 'devbrief/nightshift/x', pr: 'https://example.invalid/pr/7' }]);
  assert.deepEqual(summary.failed, [{ project: 'landing', title: 'Rename links', reason: 'tests failed after the change' }]);
  assert.equal(formatSummary(summary), 'Night shift: 1 draft PR ready for review, 1 task stopped without a PR');
  assert.equal(formatSummary(null), null);

  // A run that started before midnight is found the next morning.
  assert.deepEqual(lastNightSummary(dir, '2026-03-05'), summary);
  assert.equal(lastNightSummary(dir, '2026-03-07'), null);
});

test('removeWorktree deletes only night shift worktrees and prunes git', async (t) => {
  const home = tmp(t);
  const repo = path.join(home, 'shop-api');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, encoding: 'utf8' });
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  const wt = path.join(home, 'nightshift', 'worktrees', 'shop-api-deps');
  git('worktree', 'add', '-q', '--detach', wt, 'HEAD');
  fs.mkdirSync(path.join(wt, 'node_modules'));
  fs.writeFileSync(path.join(wt, 'node_modules', 'x.js'), '');

  await assert.rejects(removeWorktree(home, repo, repo), /Refusing/);
  await assert.rejects(removeWorktree(home, repo, path.join(home, 'nightshift', 'worktrees')), /Refusing/);
  await assert.rejects(removeWorktree(home, repo, path.join(home, 'nightshift', 'worktrees', '..', '..', 'shop-api')), /Refusing/);
  assert.ok(fs.existsSync(path.join(repo, 'a.txt')), 'the real repo is untouched');

  assert.match(await removeWorktree(home, repo, wt), /Removed/);
  assert.equal(fs.existsSync(wt), false);
  assert.doesNotMatch(git('worktree', 'list'), /shop-api-deps/);
  assert.equal(git('branch', '--list').trim(), '* main', 'no branch was created or left behind');
});

test('slugify makes branch-safe names', () => {
  assert.equal(slugify('Fix: the "README" typo!'), 'fix-the-readme-typo');
  assert.equal(slugify('!!!'), 'task');
  assert.ok(slugify('x'.repeat(100)).length <= 40);
});

test('formatPlan lists tasks and what was left alone', () => {
  const projects = [project('shop-api', failingCi), project('landing', { git: { uncommitted: 1 } })];
  const text = formatPlan(planTasks({ date: DATE, projects }, { nightShift: { projects: ['shop-api', 'landing'] } }));
  assert.match(text, /1\. \[medium\] shop-api: Fix failing CI "test"/);
  assert.match(text, /checks: none found/);
  assert.match(text, /- landing: 1 uncommitted file/);
});

function cli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

test('CLI: plan reads today\'s snapshot, and log --add / --read / --summary work', async (t) => {
  const home = tmp(t);
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  fs.mkdirSync(path.join(home, 'snapshots'));
  fs.writeFileSync(path.join(home, 'snapshots', `${date}.json`), JSON.stringify({ date, projects: [{ ...project('shop-api', failingCi), path: home }] }));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ roots: [], nightShift: { projects: ['shop-api'] } }));
  const env = { DEVBRIEF_HOME: home, DEVBRIEF_CONFIG: '', HOME: home, USERPROFILE: home };

  const plan = await cli(['plan', '--json', '--offline', '--max', '2'], env);
  assert.equal(plan.code, 0, plan.stderr);
  const parsed = JSON.parse(plan.stdout);
  assert.equal(parsed.max, 2);
  assert.deepEqual(parsed.tasks.map((t) => t.id), ['shop-api-ci-fix']);
  assert.ok(Date.parse(parsed.stopBy) - Date.parse(parsed.startedAt) === 60 * 60000);

  const add = await cli(['log', '--add', JSON.stringify({ project: 'shop-api', result: 'opened', pr: 'https://example.invalid/pr/1' })], env);
  assert.equal(add.code, 0, add.stderr);
  const read = JSON.parse((await cli(['log', '--read'], env)).stdout);
  assert.equal(read.entries[0].project, 'shop-api');
  const summary = JSON.parse((await cli(['log', '--summary'], env)).stdout);
  assert.equal(summary.line, 'Night shift: 1 draft PR ready for review');

  const bad = await cli(['log', '--add', '{"project":"x"}'], env);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Not logged/);

  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ roots: [] }));
  const none = await cli(['plan', '--offline'], env);
  assert.match(none.stdout, /No project has opted in/);
});

test('CLI: with no snapshot today, plan runs the collector offline first', async (t) => {
  const home = tmp(t);
  const repo = path.join(home, 'landing');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'pipe' });
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  fs.writeFileSync(path.join(repo, 'README.md'), 'hi\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ roots: [], projects: [{ name: 'landing', path: repo, nightShift: true }] }));
  // An empty gh config keeps gh logged out, so nothing reaches GitHub.
  const env = { DEVBRIEF_HOME: home, DEVBRIEF_CONFIG: '', HOME: home, USERPROFILE: home, GH_CONFIG_DIR: path.join(home, 'gh'), GH_TOKEN: '', GITHUB_TOKEN: '' };
  const r = await cli(['plan', '--json', '--offline'], env);
  assert.equal(r.code, 0, r.stderr);
  const plan = JSON.parse(r.stdout);
  assert.deepEqual(plan.tasks, []);
  // A repo with no remote has commits on this machine only, which comes first.
  assert.deepEqual(plan.skipped, [{ project: 'landing', reason: '1 commit(s) exist only on this machine' }]);
  assert.equal(fs.readdirSync(path.join(home, 'snapshots')).filter((f) => f.endsWith('.json')).length, 1, 'the collector saved a snapshot');
});
