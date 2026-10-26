#!/usr/bin/env node
// devbrief night shift planner: picks a few small, safe tasks for opted-in
// projects. It only reads; it never changes a repo, branch or file outside
// the night shift log. Claude does the work (see reference/nightshift.md).
//
//   node nightshift.mjs plan               list tonight's tasks
//   node nightshift.mjs plan --max 3       at most this many tasks (default 3)
//   node nightshift.mjs plan --json        print the plan as JSON
//   node nightshift.mjs plan --offline     skip npm and gh (no network)
//   node nightshift.mjs log --add <json>   record a task's result (--date d)
//   node nightshift.mjs log --read [date]  print a night's log (default today)
//   node nightshift.mjs log --summary      last night's results for the brief
//   node nightshift.mjs cleanup --repo r --worktree w   remove a night shift worktree

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, expandHome, dataDir, localDate, isMain, stripBom } from './collect.mjs';
import { readLog, appendLog, summarizeLog, lastNightSummary, formatSummary } from './lib/nightlog.mjs';

export { readLog, appendLog, summarizeLog, lastNightSummary, formatSummary };

export const BRANCH_PREFIX = 'devbrief/nightshift/';
const KIND_VALUE = { 'ci-failing': 3, 'doc-auto': 2, 'deps-patch': 1, 'advisor-cleanup': 1 };
const RISK_RANK = { low: 0, medium: 1, high: 2 };
const PAUSED = /\b(paused|archived|on hold|superseded)\b/i;
const AUTO_TAG = /\[auto\]|\(nightshift\)/i;

// Status-doc items that mention these need a human, whatever their tag says.
const OFF_LIMITS = /\b(migrations?|database|schema|deploy\w*|secrets?|\.env|env vars?|credentials?|api keys?|passwords?|infra\w*|terraform|billing|payments?|dns)\b/i;
const LOW_RISK_WORDS = /\b(typo|readme|docs?|comment|spelling|wording|copy|lint|format\w*|rename|test(?:s)?)\b/i;

// Advisor lints a night shift may fix with one new migration file that is
// never applied. Anything else (RLS, auth settings) is left for the user.
export const ADVISOR_CLEANUPS = {
  function_search_path_mutable: 'Pin search_path on functions the Supabase advisor flagged',
  unindexed_foreign_keys: 'Add indexes for foreign keys the Supabase advisor flagged',
};

export function slugify(text, max = 40) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'task';
}

// ---------- dependency updates ----------

function parseVersion(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? m.slice(1).map(Number) : null;
}

// Semver says 0.x minors (and 0.0.x patches) can break, so they count as majors.
function compatKey([major, minor, patch]) {
  if (major > 0) return `${major}`;
  return minor > 0 ? `0.${minor}` : `0.0.${patch}`;
}

function newer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// Turns `npm outdated --json` into the patch/minor updates worth making.
// Majors, prereleases, git or linked deps and missing installs are left out.
export function parseOutdated(json) {
  const out = [];
  for (const [name, raw] of Object.entries(json || {})) {
    const info = Array.isArray(raw) ? raw.find((x) => x?.current) : raw;
    const current = parseVersion(info?.current);
    if (!current) continue;
    const target = [info.latest, info.wanted].map(parseVersion)
      .find((v) => v && newer(v, current) && compatKey(v) === compatKey(current));
    if (!target) continue;
    const bump = target[0] !== current[0] || target[1] !== current[1] ? 'minor' : 'patch';
    out.push({ name, from: info.current, to: target.join('.'), bump });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- planning ----------

export function nightShiftSettings(config) {
  const top = config.nightShift && typeof config.nightShift === 'object' ? config.nightShift : {};
  return {
    projects: Array.isArray(top.projects) ? top.projects : [],
    max: Number(top.max) > 0 ? Number(top.max) : 3,
    maxMinutes: Number(top.maxMinutes) > 0 ? Number(top.maxMinutes) : 60,
  };
}

// Opt-in only: `"nightShift": true` on the project, or its name in the
// top-level `nightShift.projects`. An explicit false on the project wins.
export function isOptedIn(project, config) {
  const entry = (config.projects || []).find((p) => (p.name || path.basename(p.path || '')) === project.name);
  const own = entry?.nightShift ?? project.nightShift;
  if (own === false) return false;
  return own === true || nightShiftSettings(config).projects.includes(project.name);
}

// Why the night shift must leave a project alone, or null when it may work on it.
export function exclusionReason(p) {
  const git = p.git || {};
  if (p.notes && PAUSED.test(p.notes)) return `notes say "${p.notes}"`;
  if (git.error) return `git could not be read (${git.error})`;
  if (git.uncommitted > 0) return `${git.uncommitted} uncommitted file(s), so someone is mid-work`;
  if (git.localOnly > 0) return `${git.localOnly} commit(s) exist only on this machine`;
  if (git.ahead > 0) return `${git.ahead} unpushed commit(s)`;
  if (!git.github && !p.repo) return 'no GitHub remote, so there is nowhere to open a PR';
  return null;
}

function defaultBranchOf(p, info) {
  if (info.defaultBranch) return info.defaultBranch;
  if (p.source === 'remote') return p.git?.branch || null;
  return ['main', 'master'].includes(p.git?.branch) ? p.git.branch : null;
}

function testCommand(info) {
  return info.testScript ? `${info.packageManager || 'npm'} test` : null;
}

function candidateTasks(p, info, ctx) {
  const tasks = [];
  const skipped = [];
  const base = defaultBranchOf(p, info);
  const test = testCommand(info);
  const add = (kind, slugText, title, risk, why, checks, extra = {}) => {
    const slug = slugify(`${p.name}-${slugText}`);
    tasks.push({
      id: slug, project: p.name, kind, title, risk, why,
      branch: `${BRANCH_PREFIX}${ctx.date}-${slug}`, base, checks, ...extra,
    });
  };
  const skip = (kind, reason) => skipped.push({ project: p.name, kind, reason });

  const ci = p.github?.ci;
  if (ci?.conclusion === 'failure') {
    if (!base) skip('ci-failing', `could not tell whether ${p.git?.branch} is the default branch, so CI was left alone`);
    else if (p.git?.branch !== base) skip('ci-failing', `CI fails on ${p.git?.branch}, not on ${base}, so it is someone's work in progress`);
    else add('ci-failing', 'ci-fix', `Fix failing CI "${ci.workflowName}"`, 'medium',
      `The last "${ci.workflowName}" run on ${base} failed${ci.url ? ` (${ci.url})` : ''}.`,
      test ? [test] : [], ci.url ? { ciUrl: ci.url } : {});
  }

  if (info.outdated) {
    const updates = parseOutdated(info.outdated);
    if (updates.length && !test) skip('deps-patch', 'no test script, so dependency updates cannot be verified');
    else if (updates.length) {
      const names = updates.slice(0, 3).map((u) => `${u.name} ${u.from} → ${u.to}`).join(', ');
      add('deps-patch', 'deps', `Update ${updates.length} dependenc${updates.length === 1 ? 'y' : 'ies'} (patch and minor only)`, 'low',
        `${names}${updates.length > 3 ? ', ...' : ''}. No major versions.`,
        ['npm ci', test], { packages: updates });
    }
  } else if (info.depsSkipped) {
    skip('deps-patch', info.depsSkipped);
  }

  for (const doc of p.statusDocs || []) {
    for (const item of doc.items || []) {
      if (!AUTO_TAG.test(item.text)) continue;
      const text = item.text.replace(new RegExp(AUTO_TAG.source, 'gi'), ' ').replace(/\s+/g, ' ').trim();
      if (OFF_LIMITS.test(text)) { skip('doc-auto', `"${text}" touches something the night shift never changes (${text.match(OFF_LIMITS)[0]})`); continue; }
      add('doc-auto', text, text, LOW_RISK_WORDS.test(text) ? 'low' : 'medium',
        `Tagged for the night shift in ${doc.file}${item.section ? ` under "${item.section}"` : ''}.`,
        test ? [test] : [], { source: doc.file });
    }
  }

  const advisors = p.advisors || ctx.advisors[p.name] || [];
  const lints = [...new Set(advisors.map((a) => a.name).filter((n) => ADVISOR_CLEANUPS[n]))];
  for (const name of lints) {
    if (!info.hasMigrations) { skip('advisor-cleanup', `advisor "${name}" needs a migration, but there is no supabase/migrations folder`); continue; }
    const count = advisors.filter((a) => a.name === name).length;
    add('advisor-cleanup', name.replace(/_/g, '-'), ADVISOR_CLEANUPS[name], 'low',
      `The Supabase advisor reported "${name}" ${count} time(s). The PR adds one new migration file and does not apply it.`,
      test ? [test] : [], { advisor: name });
  }
  return { tasks, skipped };
}

// Same task, any night: the branch name minus its date.
function sameTask(branch, slug) {
  const rest = branch.startsWith(BRANCH_PREFIX) ? branch.slice(BRANCH_PREFIX.length) : null;
  return rest !== null && rest.replace(/^\d{4}-\d{2}-\d{2}-/, '') === slug;
}

function score(t) {
  return KIND_VALUE[t.kind] / (1 + RISK_RANK[t.risk]);
}

// Pure: snapshot + config + extras in, plan out. Extras, all optional:
//   date, max, repoInfo: { [project]: { testScript, packageManager,
//   defaultBranch, hasMigrations, outdated, depsSkipped } },
//   openBranches: { [project]: ["devbrief/nightshift/..."] },
//   advisors: { [project]: [{ name, level }] }
export function planTasks(snapshot, config, extras = {}) {
  const settings = nightShiftSettings(config);
  const date = extras.date || snapshot.date;
  const max = Number(extras.max) > 0 ? Number(extras.max) : settings.max;
  const ctx = { date, advisors: extras.advisors || {} };
  const all = [];
  const skipped = [];
  for (const p of snapshot.projects || []) {
    if (!isOptedIn(p, config)) continue;
    const reason = exclusionReason(p);
    if (reason) { skipped.push({ project: p.name, reason }); continue; }
    const found = candidateTasks(p, extras.repoInfo?.[p.name] || {}, ctx);
    skipped.push(...found.skipped);
    const open = [...(extras.openBranches?.[p.name] || []), ...(p.github?.openPRs || []).map((pr) => pr.headRefName).filter(Boolean)];
    for (const t of found.tasks) {
      const dup = open.find((b) => sameTask(b, t.id));
      if (dup) skipped.push({ project: p.name, kind: t.kind, reason: `a night shift PR is already open (${dup})` });
      else all.push(t);
    }
  }
  all.sort((a, b) => score(b) - score(a) || a.project.localeCompare(b.project) || a.id.localeCompare(b.id));
  for (const t of all.slice(max)) skipped.push({ project: t.project, kind: t.kind, reason: `over the limit of ${max} task(s) a night` });
  return { date, max, maxMinutes: settings.maxMinutes, tasks: all.slice(0, max), skipped };
}

// ---------- gathering facts for the plan (reads only) ----------

function sh(cmd, args, cwd, timeout = 60000) {
  // npm is npm.cmd on Windows, which only runs through a shell. The args here
  // are fixed strings from this file, never repo content.
  const win = process.platform === 'win32' && cmd === 'npm';
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    execFile(win ? 'npm.cmd' : cmd, args, { cwd, timeout, env, windowsHide: true, shell: win, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, out: stdout.trim() });
        const msg = String(stderr || err.message || 'failed').trim().split(/\r?\n/)[0];
        resolve({ ok: false, out: String(stdout || '').trim(), error: err.killed ? 'timed out' : msg });
      });
  });
}

const LOCKFILES = [
  ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'],
];
const NPM_PLACEHOLDER_TEST = /no test specified/;

export function readRepoInfo(dir) {
  const info = {};
  let pkg = null;
  try { pkg = JSON.parse(stripBom(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))); } catch { /* not a node project */ }
  if (pkg) {
    const test = pkg.scripts?.test;
    if (test && !NPM_PLACEHOLDER_TEST.test(test)) info.testScript = test;
    const lock = LOCKFILES.find(([f]) => fs.existsSync(path.join(dir, f)));
    if (lock) info.packageManager = lock[1];
    info.hasPackageJson = true;
  }
  info.hasMigrations = fs.existsSync(path.join(dir, 'supabase', 'migrations'));
  return info;
}

// Everything planTasks needs that is not in the snapshot. `exec` is injectable
// so tests never call npm, gh or the network.
export async function gatherExtras(projects, config, { exec = sh, offline = false } = {}) {
  const repoInfo = {};
  const openBranches = {};
  for (const p of projects) {
    if (!isOptedIn(p, config) || exclusionReason(p)) continue;
    const info = p.path ? readRepoInfo(p.path) : {};
    if (p.path) {
      const head = await exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], p.path);
      if (head.ok && head.out) info.defaultBranch = head.out.replace(/^origin\//, '');
    }
    if (info.hasPackageJson && info.packageManager === 'npm' && !offline) {
      // npm outdated exits 1 when anything is outdated, so read stdout either way.
      const r = await exec('npm', ['outdated', '--json'], p.path);
      try { info.outdated = JSON.parse(r.out || '{}'); } catch { info.depsSkipped = `npm outdated failed: ${r.error || 'unexpected output'}`; }
    } else if (info.hasPackageJson && info.packageManager && info.packageManager !== 'npm') {
      info.depsSkipped = `uses ${info.packageManager}; dependency updates only support npm for now`;
    } else if (info.hasPackageJson && !info.packageManager) {
      info.depsSkipped = 'no lockfile, so updates would not be reproducible';
    }
    const repo = p.repo || p.git?.github;
    if (repo && !offline) {
      const r = await exec('gh', ['pr', 'list', '-R', repo, '--state', 'open', '--limit', '100', '--json', 'headRefName']);
      try { openBranches[p.name] = JSON.parse(r.out || '[]').map((x) => x.headRefName).filter((b) => b.startsWith(BRANCH_PREFIX)); } catch { /* gh missing: the run re-checks before pushing */ }
    }
    repoInfo[p.name] = info;
  }
  return { repoInfo, openBranches };
}

// ---------- cleanup ----------

// Removes a worktree the night shift made, build output and all, then lets
// git forget it. Refuses any folder outside <home>/nightshift/worktrees, so a
// wrong path can never delete real work.
export async function removeWorktree(home, repo, worktree, exec = sh) {
  const root = path.resolve(home, 'nightshift', 'worktrees');
  const target = path.resolve(worktree);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to remove ${target}: night shift worktrees live under ${root}.`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  const r = await exec('git', ['worktree', 'prune'], repo);
  return r.ok ? `Removed ${target}` : `Removed ${target}, but git worktree prune failed: ${r.error}`;
}

// ---------- CLI ----------

function readJsonFile(file) {
  try { return JSON.parse(stripBom(fs.readFileSync(file, 'utf8'))); } catch { return null; }
}

// Advisor results the skill saved after its MCP checks (see docs/nightshift.md).
export function readBriefExtras(home, date) {
  const extras = readJsonFile(path.join(home, 'brief-extras', `${date}.json`));
  const advisors = {};
  for (const [name, p] of Object.entries(extras?.projects || {})) if (Array.isArray(p.advisors)) advisors[name] = p.advisors;
  return advisors;
}

function runCollector(configFile, remote) {
  const collector = fileURLToPath(new URL('./collect.mjs', import.meta.url));
  const args = [collector, remote ? '--remote' : '--no-fetch', '--config', configFile];
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`The collector failed: ${String(stderr || err.message).trim().split('\n')[0]}`));
      resolve(JSON.parse(stdout));
    });
  });
}

function parseArgs(argv) {
  const args = { cmd: argv[0], max: null, json: false, offline: false, remote: false, config: null, add: null, read: null, summary: false, date: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--max') args.max = Number(argv[++i]);
    else if (a === '--json') args.json = true;
    else if (a === '--offline') args.offline = true;
    else if (a === '--remote') args.remote = true;
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--add') args.add = argv[++i];
    else if (a === '--date') args.date = argv[++i];
    else if (a === '--summary') args.summary = true;
    else if (a === '--repo') args.repo = argv[++i];
    else if (a === '--worktree') args.worktree = argv[++i];
    else if (a === '--read') args.read = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '';
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

export function formatPlan(plan) {
  const lines = [`devbrief night shift plan for ${plan.date}: ${plan.tasks.length} task(s), at most ${plan.max}, stop after ${plan.maxMinutes} minutes`];
  plan.tasks.forEach((t, i) => {
    lines.push(`${i + 1}. [${t.risk}] ${t.project}: ${t.title}`);
    lines.push(`   why: ${t.why}`);
    lines.push(`   branch: ${t.branch} (from ${t.base || 'the default branch'})`);
    lines.push(`   checks: ${t.checks.length ? t.checks.join(', ') : 'none found, work out how the repo tests itself'}`);
  });
  if (!plan.tasks.length) lines.push('Nothing to do tonight.');
  if (plan.skipped.length) {
    lines.push('Left alone:');
    for (const s of plan.skipped) lines.push(`- ${s.project}${s.kind ? ` (${s.kind})` : ''}: ${s.reason}`);
  }
  return lines.join('\n');
}

async function plan(args, home, configFile) {
  const { config, found } = loadConfig(configFile);
  const date = localDate();
  const snapDir = args.remote ? path.join(home, 'snapshots', 'remote') : path.join(home, 'snapshots');
  const snapshot = readJsonFile(path.join(snapDir, `${date}.json`)) || await runCollector(configFile, args.remote);
  const optedIn = (snapshot.projects || []).filter((p) => isOptedIn(p, config));
  if (!optedIn.length) {
    const hint = found ? configFile : `${configFile} (it does not exist yet)`;
    return `No project has opted in to the night shift. Add "nightShift": true to a project in ${hint}.`;
  }
  const gathered = await gatherExtras(snapshot.projects, config, { offline: args.offline });
  const result = planTasks(snapshot, config, {
    ...gathered, date, advisors: readBriefExtras(home, date), ...(args.max > 0 && { max: args.max }),
  });
  const now = new Date();
  result.startedAt = now.toISOString();
  result.stopBy = new Date(now.getTime() + result.maxMinutes * 60000).toISOString();
  return args.json ? JSON.stringify(result, null, 2) : formatPlan(result);
}

function log(args, home) {
  const dir = path.join(home, 'nightshift');
  const date = args.date || localDate();
  if (args.add !== null) {
    let entry;
    try { entry = JSON.parse(args.add); } catch (e) { throw new Error(`--add needs a JSON object (${e.message}).`); }
    appendLog(dir, date, entry);
    return `Logged ${entry.result} for ${entry.project} in ${path.join(dir, `${date}.json`)}`;
  }
  if (args.summary) {
    const summary = lastNightSummary(dir, date);
    return JSON.stringify({ line: formatSummary(summary), ...summary }, null, 2);
  }
  if (args.read !== null) return JSON.stringify(readLog(dir, args.read || date), null, 2);
  throw new Error('Use log --add <json>, log --read [date] or log --summary.');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !['plan', 'log', 'cleanup'].includes(args.cmd)) {
    return fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).join('\n');
  }
  const home = dataDir();
  if (args.cmd === 'cleanup') {
    if (!args.repo || !args.worktree) throw new Error('Use cleanup --repo <project folder> --worktree <worktree folder>.');
    return removeWorktree(home, args.repo, args.worktree);
  }
  const configFile = expandHome(args.config || process.env.DEVBRIEF_CONFIG || path.join(home, 'config.json'));
  return args.cmd === 'plan' ? plan(args, home, configFile) : log(args, home);
}

if (isMain(import.meta.url)) {
  main().then((out) => console.log(out), (e) => { console.error(e.message); process.exit(1); });
}
