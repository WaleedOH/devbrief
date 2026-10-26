#!/usr/bin/env node
// devbrief review: what happened across every project over the last few days.
// Commits, active days and lines changed come from git; items closed and the
// open-item trend come from saved snapshots; stars and releases from gh.
//
//   node review.mjs               last 7 days, short summary
//   node review.mjs --json        the same as JSON (for /devbrief review)
//   node review.mjs --days 14     a longer window
//   node review.mjs --to 2026-10-25   end the window on another day
//   node review.mjs --project x   one project only
//   node review.mjs --no-github   skip the gh calls
//   node review.mjs --config f    same as DEVBRIEF_CONFIG=f

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadConfig, discoverProjects, expandHome, dataDir, localDate, isMain,
  parseGithubRemote, readStatusDocs,
} from './collect.mjs';
import { loadSnapshots, openItemsOf, itemChanges } from './lib/history.mjs';

const CONCURRENCY = 4;
// How far before the window to look for the snapshot that gives the start count.
const BASELINE_DAYS = 30;

function sh(cmd, args, cwd, timeout = 20000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, out: stdout.trim() });
      const msg = String(stderr || err.message || 'failed').trim().split(/\r?\n/)[0];
      resolve({ ok: false, error: err.killed ? `timed out after ${timeout / 1000}s` : msg });
    });
  });
}

function parseJson(r) {
  if (!r.ok) return null;
  try { return JSON.parse(r.out || 'null'); } catch { return null; }
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function parseDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function addDays(day, n) {
  const d = parseDay(day);
  d.setDate(d.getDate() + n);
  return localDate(d);
}

// `days` calendar days ending on `to`, both ends included.
export function reviewWindow(days, to) {
  return { from: addDays(to, -(days - 1)), to };
}

// ---------- git ----------

// One record per commit: "\x1e<date>\0<subject>", then git's shortstat line
// (" 2 files changed, 10 insertions(+), 3 deletions(-)") when files changed.
export function parseGitLog(out) {
  const commits = [];
  let added = 0;
  let removed = 0;
  for (const record of out.split('\x1e')) {
    if (!record.trim()) continue;
    const [head, ...rest] = record.split('\n');
    const [iso, subject = ''] = head.split('\0');
    const date = new Date(iso.trim());
    if (Number.isNaN(date.getTime())) continue;
    commits.push({ date: localDate(date), subject: subject.trim() });
    const stat = rest.join(' ');
    added += Number(stat.match(/(\d+) insertions?\(\+\)/)?.[1] || 0);
    removed += Number(stat.match(/(\d+) deletions?\(-\)/)?.[1] || 0);
  }
  return { commits, linesAdded: added, linesRemoved: removed };
}

// Every local branch counts, so work on a feature branch shows up too.
// Merges are left out because they repeat work already counted.
async function gitActivity(dir, { from, to }, exec) {
  const r = await exec('git', [
    'log', '--branches', '--no-merges',
    `--since=${from} 00:00:00`, `--until=${to} 23:59:59`,
    '--format=%x1e%cI%x00%s', '--shortstat',
  ], dir);
  if (!r.ok) return { error: r.error, commits: [], linesAdded: 0, linesRemoved: 0 };
  return parseGitLog(r.out);
}

// ---------- GitHub ----------

// open_issues_count from GitHub includes open pull requests.
export async function githubImpact(repo, exec) {
  const [info, release] = await Promise.all([
    exec('gh', ['api', `repos/${repo}`]),
    exec('gh', ['api', `repos/${repo}/releases/latest`]),
  ]);
  const r = parseJson(info);
  if (!r || typeof r !== 'object') return null;
  const out = { stars: r.stargazers_count ?? 0, forks: r.forks_count ?? 0, openIssues: r.open_issues_count ?? 0 };
  const rel = parseJson(release);
  if (rel?.tag_name) out.latestRelease = { tag: rel.tag_name, date: localDate(new Date(rel.published_at || rel.created_at)) };
  return out;
}

// ---------- status-doc history ----------

function findProject(snap, name) {
  return (snap.projects || []).find((p) => p.name === name);
}

// The open-item lists to compare, oldest first: the last snapshot before the
// window (the start), every snapshot inside it, and today's docs read live.
function itemLists(name, history, live) {
  const before = history.before.map((s) => openItemsOf(findProject(s, name))).filter(Boolean);
  // Today's docs read live replace today's snapshot: same day, one reading.
  const inside = history.inside
    .filter((s) => !live || s.date !== history.to)
    .map((s) => openItemsOf(findProject(s, name))).filter(Boolean);
  const lists = [...before.slice(-1), ...inside];
  if (live) lists.push(live);
  return lists;
}

export function itemSummary(lists) {
  // No readings, or never any items (no status doc): launch distance is unknown, not zero.
  if (!lists.length || lists.every((l) => !l.length)) return { itemsClosed: [], itemsAdded: [], openItems: { start: null, end: null } };
  const { closed, added } = itemChanges(lists);
  // A single reading has no earlier point to compare with, so the start is unknown.
  return {
    itemsClosed: closed,
    itemsAdded: added,
    openItems: { start: lists.length > 1 ? lists[0].length : null, end: lists[lists.length - 1].length },
  };
}

// ---------- one project ----------

export async function reviewProject(p, ctx) {
  const { window, history, config, exec, hasGh, readLive } = ctx;
  const result = { name: p.name };
  if (p.notes) result.notes = p.notes;
  // Passed through so the review step knows where to look for impact numbers.
  for (const key of ['impact', 'vercel', 'supabase']) if (p[key]) result[key] = p[key];

  const git = await gitActivity(p.path, window, exec);
  if (git.error) result.error = git.error;
  result.commits = git.commits;
  result.activeDays = new Set(git.commits.map((c) => c.date)).size;
  result.linesAdded = git.linesAdded;
  result.linesRemoved = git.linesRemoved;

  let live = null;
  if (readLive) {
    try { live = openItemsOf({ statusDocs: readStatusDocs(p.path, p.statusDocs || config.statusDocs, config.maxStatusDocs) }); } catch { live = null; }
  }
  Object.assign(result, itemSummary(itemLists(p.name, history, live)));

  if (hasGh) {
    let repo = p.github || null;
    if (!repo && !git.error) {
      const r = await exec('git', ['remote', 'get-url', 'origin'], p.path);
      repo = r.ok ? parseGithubRemote(r.out) : null;
    }
    if (repo) {
      const gh = await githubImpact(repo, exec);
      if (gh) result.github = gh;
    }
  }
  return result;
}

function emptyResult(p, error) {
  return {
    name: p.name, ...(p.notes && { notes: p.notes }), error,
    commits: [], activeDays: 0, linesAdded: 0, linesRemoved: 0,
    itemsClosed: [], itemsAdded: [], openItems: { start: null, end: null },
  };
}

// Local snapshots first; a machine that only runs remote mode has its
// history in snapshots/remote instead.
function loadHistory(home, window) {
  const range = { since: addDays(window.from, -BASELINE_DAYS), until: window.to };
  let snaps = loadSnapshots(path.join(home, 'snapshots'), range);
  if (!snaps.length) snaps = loadSnapshots(path.join(home, 'snapshots', 'remote'), range);
  return {
    before: snaps.filter((s) => s.date < window.from),
    inside: snaps.filter((s) => s.date >= window.from),
    to: window.to,
  };
}

export async function buildReview(config, {
  days = 7, to, now = new Date(), project = null, home = dataDir(), exec = sh, hasGh = false,
} = {}) {
  const today = localDate(now);
  const window = reviewWindow(days, to || today);
  let projects = discoverProjects(config);
  if (project) projects = projects.filter((p) => p.name === project);
  const history = loadHistory(home, window);
  // Live docs only describe today, so they only count when the window ends today.
  const ctx = { window, history, config, exec, hasGh, readLive: window.to === today };
  const results = await pool(projects, CONCURRENCY, async (p) => {
    try { return await reviewProject(p, ctx); } catch (e) { return emptyResult(p, e.message); }
  });
  return {
    version: 1,
    from: window.from,
    to: window.to,
    days,
    projects: results,
    totals: {
      commits: results.reduce((n, p) => n + p.commits.length, 0),
      activeProjects: results.filter((p) => p.commits.length > 0).length,
      itemsClosed: results.reduce((n, p) => n + p.itemsClosed.length, 0),
    },
  };
}

// ---------- output ----------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function formatReview(review) {
  const { totals } = review;
  const lines = [
    `devbrief review · ${review.from} to ${review.to} (${plural(review.days, 'day')})`,
    `${plural(totals.commits, 'commit')} in ${totals.activeProjects} of ${plural(review.projects.length, 'project')}, ${plural(totals.itemsClosed, 'item')} closed`,
    '',
  ];
  const width = Math.max(...review.projects.map((p) => p.name.length), 4);
  for (const p of review.projects) {
    const parts = [];
    if (p.commits.length) {
      parts.push(`${plural(p.commits.length, 'commit')} on ${plural(p.activeDays, 'day')}, +${p.linesAdded} -${p.linesRemoved}`);
    } else {
      parts.push('no commits');
    }
    if (p.itemsClosed.length || p.itemsAdded.length) parts.push(`${p.itemsClosed.length} closed, ${p.itemsAdded.length} added`);
    if (p.openItems.start !== null) parts.push(`open ${p.openItems.start} -> ${p.openItems.end}`);
    else if (p.openItems.end !== null) parts.push(`${p.openItems.end} open`);
    if (p.github) parts.push(`${plural(p.github.stars, 'star')}${p.github.latestRelease ? `, ${p.github.latestRelease.tag}` : ''}`);
    if (p.error) parts.push(`git failed: ${p.error}`);
    lines.push(`${p.name.padEnd(width)}  ${parts.join('; ')}`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { days: 7, json: false, github: true, project: null, config: null, to: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--days') args.days = Number(argv[++i]);
    else if (a === '--to') args.to = argv[++i];
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--no-github') args.github = false;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 13).join('\n'));
    return;
  }
  if (!Number.isInteger(args.days) || args.days < 1 || args.days > 366) {
    console.error('--days needs a whole number of days from 1 to 366, for example --days 7.');
    process.exit(1);
  }
  if (args.to && !/^\d{4}-\d{2}-\d{2}$/.test(args.to)) {
    console.error('--to needs a date like 2026-10-25.');
    process.exit(1);
  }
  const home = dataDir();
  const configFile = expandHome(args.config || process.env.DEVBRIEF_CONFIG || path.join(home, 'config.json'));
  const { config } = loadConfig(configFile);
  const hasGh = args.github && (await sh('gh', ['auth', 'status'])).ok;
  const review = await buildReview(config, { days: args.days, to: args.to, project: args.project, home, hasGh });
  if (!review.projects.length) {
    console.error(args.project ? `No project named "${args.project}".` : 'No projects found. Run collect.mjs --init or add projects to the config.');
    process.exit(1);
  }
  console.log(args.json ? JSON.stringify(review, null, 2) : formatReview(review));
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
