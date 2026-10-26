#!/usr/bin/env node
// devbrief collector: gathers the health of every project into one JSON snapshot.
// No dependencies. Needs git; uses the GitHub CLI (gh) when it is installed.
//
//   node collect.mjs              collect, save a snapshot, print JSON
//   node collect.mjs --init       write a starter config from discovered repos
//   node collect.mjs --no-fetch   skip `git fetch` (faster, offline)
//   node collect.mjs --project x  collect one project only
//   node collect.mjs --no-save    print without saving a snapshot
//   node collect.mjs --remote     GitHub only, no local clones (for cloud jobs)

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);

export const DEFAULT_STATUS_DOCS = [
  'LAUNCH-STATUS.md', 'docs/LAUNCH-STATUS.md',
  'STATUS.md', 'docs/STATUS.md',
  'NEXT.md', 'docs/NEXT.md',
  'TODO.md', 'docs/TODO.md',
  'FIX-LIST.md', 'docs/FIX-LIST.md',
  'ROADMAP.md', 'docs/ROADMAP.md',
];

export const DEFAULT_CONFIG = {
  roots: ['~'],
  projects: [],
  exclude: [],
  statusDocs: DEFAULT_STATUS_DOCS,
  maxStatusDocs: 2,
  staleDays: 14,
  fetch: true,
};

const NEXT_HEADING = /\b(next|todo|to[- ]do|left|remaining|pending|blocked|blockers?|open|backlog|up next|in progress|in flight|right now)\b/i;

export function expandHome(p) {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\')
    ? path.join(os.homedir(), p.slice(1))
    : p;
}

// "~/x" keeps a config portable between machines with different home folders.
export function homeRelative(p) {
  const rel = path.relative(os.homedir(), p);
  const outside = rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  return rel && !outside ? `~/${rel.split(path.sep).join('/')}` : p;
}

// PowerShell's Out-File and old Notepad save UTF-8 with a BOM, which breaks
// JSON.parse and the first markdown heading.
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Node resolves symlinks for the main module, so compare real paths: the
// skill is usually run through the link install.mjs makes.
export function isMain(metaUrl) {
  if (!process.argv[1]) return false;
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl)); } catch { return false; }
}

export function dataDir() {
  return expandHome(process.env.DEVBRIEF_HOME || '~/.devbrief');
}

function readJson(file) {
  try { return JSON.parse(stripBom(fs.readFileSync(file, 'utf8'))); } catch { return null; }
}

// A missing config means "discover everything"; a broken one is an error,
// never a silent fallback to scanning the whole home folder.
export function loadConfig(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return { config: { ...DEFAULT_CONFIG }, found: false }; }
  let user;
  try { user = JSON.parse(stripBom(text)); } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}). Fix it, or delete it to start over.`);
  }
  return { config: { ...DEFAULT_CONFIG, ...user }, found: true };
}

export function localDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function sh(cmd, args, cwd, timeout = 20000) {
  try {
    const { stdout } = await run(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, out: stdout.trim() };
  } catch (e) {
    const msg = String(e.stderr || e.message || 'failed').trim().split(/\r?\n/)[0];
    return { ok: false, error: e.killed ? `timed out after ${timeout / 1000}s` : msg };
  }
}

// ---------- discovery ----------

export function detectIntegrations(dir) {
  const found = {};
  const vercel = readJson(path.join(dir, '.vercel', 'project.json'));
  if (vercel?.projectId) {
    found.vercel = { projectId: vercel.projectId, teamId: vercel.orgId };
    if (vercel.projectName) found.vercel.projectName = vercel.projectName;
  }
  try {
    const ref = fs.readFileSync(path.join(dir, 'supabase', '.temp', 'project-ref'), 'utf8').trim();
    if (ref) found.supabase = { projectRef: ref };
  } catch { /* not linked */ }
  return found;
}

// On macOS, merely looking inside these makes the OS ask for folder access.
const HOME_SKIP = {
  darwin: ['Desktop', 'Documents', 'Downloads', 'Library', 'Movies', 'Music', 'Pictures', 'Public'],
};

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

export function discoverProjects(config) {
  const byPath = new Map();
  for (const p of config.projects || []) {
    const full = path.resolve(expandHome(p.path));
    byPath.set(full, { name: path.basename(full), ...p, path: full });
  }
  for (const root of config.roots || []) {
    const rootDir = path.resolve(expandHome(root));
    const skip = rootDir === path.resolve(os.homedir()) ? HOME_SKIP[process.platform] || [] : [];
    let entries;
    try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.') || skip.includes(e.name)) continue;
      const full = path.resolve(rootDir, e.name);
      if (!e.isDirectory() && !(e.isSymbolicLink() && isDir(full))) continue;
      if (byPath.has(full) || !fs.existsSync(path.join(full, '.git'))) continue;
      byPath.set(full, { name: e.name, path: full });
    }
  }
  const exclude = new Set(config.exclude || []);
  return [...byPath.values()]
    .filter((p) => !p.ignore && !exclude.has(p.name))
    .map((p) => ({ ...detectIntegrations(p.path), ...p }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ---------- status docs ----------

function cleanItem(line) {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/^\[ \]\s*/, '')
    .replace(/\*\*|__|`/g, '')
    .trim();
}

function isDone(line) {
  const body = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '');
  return /^\[[xX]\]/.test(body) || /^~~/.test(body) || /^(done|✅)\b/i.test(body);
}

// A table row becomes an item: its first cell with real words (skipping ids
// like "A1"), unless any cell says the row is done.
function tableItem(line) {
  if (/^\s*\|?\s*:?-{3,}/.test(line)) return null;
  const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
  if (cells.some((c) => /^(done|✅|~~)/i.test(c))) return null;
  const text = cells.find((c) => c.split(/\s+/).length >= 3);
  return text ? text.replace(/\*\*|__|`/g, '') : null;
}

// Pulls the "what's next" part out of a status doc: open items under headings
// like "Next", "Left to do" or "Blocked", plus any unchecked "- [ ]" anywhere.
export function extractNextSteps(markdown, { maxItems = 8 } = {}) {
  const lines = stripBom(markdown).replace(/\r\n/g, '\n').split('\n');
  const title = (lines.find((l) => /^#\s/.test(l)) || '').replace(/^#\s+/, '').trim() || null;
  const items = [];
  const seen = new Set();
  const add = (text, section) => {
    if (!text || seen.has(text) || items.length >= maxItems) return;
    seen.add(text);
    items.push(section ? { text, section } : { text });
  };

  let section = null;
  let inNext = false;
  let nextLevel = 0;
  let tableHeader = false;
  for (const line of lines) {
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      if (inNext && level <= nextLevel) inNext = false;
      if (!inNext && NEXT_HEADING.test(h[2]) && level > 1) {
        inNext = true;
        nextLevel = level;
        section = h[2].trim();
      }
      tableHeader = true;
      continue;
    }
    const isTopItem = /^(?:[-*+]|\d+[.)])\s+/.test(line);
    const isRow = /^\s*\|/.test(line);
    if (!isRow) tableHeader = true;
    if (/^\s*[-*+]\s+\[ \]\s+/.test(line)) add(cleanItem(line), inNext ? section : null);
    else if (inNext && isTopItem && !isDone(line)) add(cleanItem(line), section);
    else if (inNext && isRow) {
      if (tableHeader) { tableHeader = false; continue; }
      add(tableItem(line), section);
    }
  }
  return { title, items };
}

// Matches status doc names ignoring case (Linux would miss "Status.md") and
// returns the real spelling, or null.
function findFile(dir, rel, listings) {
  const parts = rel.split(/[\\/]/);
  const name = parts.pop().toLowerCase();
  const sub = parts.join('/');
  if (!listings.has(sub)) {
    try { listings.set(sub, fs.readdirSync(path.join(dir, sub))); } catch { listings.set(sub, []); }
  }
  const real = listings.get(sub).find((n) => n.toLowerCase() === name);
  return real ? (sub ? `${sub}/${real}` : real) : null;
}

export function readStatusDocs(dir, docs, max) {
  const out = [];
  const listings = new Map();
  const seen = new Set();
  for (const wanted of docs) {
    if (out.length >= max) break;
    const rel = findFile(dir, wanted, listings);
    if (!rel || seen.has(rel.toLowerCase())) continue;
    seen.add(rel.toLowerCase());
    const file = path.join(dir, rel);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const mtime = fs.statSync(file).mtime;
    out.push({ file: rel, updated: localDate(mtime), ...extractNextSteps(text) });
  }
  return out;
}

// ---------- git ----------

export function parseGithubRemote(url) {
  const m = (url || '').match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function daysBetween(a, b) {
  return Math.floor((b.getTime() - a.getTime()) / 86400000);
}

async function collectGit(dir, { fetch, now }) {
  const g = (...args) => sh('git', args, dir);
  const git = {};
  const branch = await g('rev-parse', '--abbrev-ref', 'HEAD');
  if (!branch.ok) return { error: branch.error };
  git.branch = branch.out;

  const remote = await g('remote', 'get-url', 'origin');
  git.remote = remote.ok ? remote.out : null;
  git.github = parseGithubRemote(git.remote);

  if (fetch && git.remote) {
    const f = await sh('git', ['fetch', '--quiet', 'origin'], dir, 30000);
    if (!f.ok) git.fetchError = f.error;
  }

  const counts = await g('rev-list', '--left-right', '--count', '@{upstream}...HEAD');
  if (counts.ok) {
    const [behind, ahead] = counts.out.split(/\s+/).map(Number);
    Object.assign(git, { behind, ahead });
  } else {
    git.upstream = null;
  }

  // Commits on no remote branch at all: lost if this machine dies.
  const localOnly = await g('rev-list', '--count', 'HEAD', '--not', '--remotes');
  if (localOnly.ok) git.localOnly = Number(localOnly.out);

  const status = await g('status', '--porcelain');
  git.uncommitted = status.ok && status.out ? status.out.split('\n').length : 0;

  const last = await g('log', '-1', '--format=%cI%x00%s');
  if (last.ok && last.out) {
    const [date, subject] = last.out.split('\0');
    git.lastCommit = { date, subject, daysAgo: daysBetween(new Date(date), now) };
  }
  return git;
}

// ---------- GitHub ----------

async function collectGithub(repo, branch, exec = sh) {
  const gh = (...args) => exec('gh', [...args, '-R', repo]);
  const [prs, issues, runs] = await Promise.all([
    gh('pr', 'list', '--state', 'open', '--limit', '20', '--json', 'number,title,isDraft,updatedAt'),
    gh('issue', 'list', '--state', 'open', '--limit', '20', '--json', 'number,title,updatedAt'),
    gh('run', 'list', '--branch', branch, '--limit', '1', '--json', 'workflowName,status,conclusion,createdAt,url'),
  ]);
  const parse = (r) => (r.ok ? JSON.parse(r.out || '[]') : null);
  const out = {};
  const errors = [prs, issues, runs].filter((r) => !r.ok).map((r) => r.error);
  if (errors.length) out.errors = [...new Set(errors)];
  const p = parse(prs);
  if (p) out.openPRs = p;
  const i = parse(issues);
  if (i) out.openIssues = { count: i.length, latest: i.slice(0, 5) };
  const r = parse(runs);
  if (r) out.ci = r[0] || null;
  return out;
}

// ---------- signals ----------

// Plain facts the brief can rank. Severity: high = broken or blocking,
// medium = needs action soon, low = worth knowing.
export function computeFlags(p, { staleDays = 14 } = {}) {
  const flags = [];
  const flag = (severity, code, message) => flags.push({ severity, code, message });
  const { git = {}, github } = p;

  const remote = p.source === 'remote';
  if (git.error) {
    if (remote) flag('high', 'repo-error', `could not read the repo from GitHub: ${git.error}`);
    else flag('high', 'git-error', `git failed: ${git.error}`);
  }
  if (github?.ci?.conclusion === 'failure') flag('high', 'ci-failing', `CI "${github.ci.workflowName}" is failing on ${git.branch}`);
  if (git.behind > 0) flag('medium', 'behind', `${git.behind} commit(s) behind origin, pull before working`);
  if (git.localOnly > 0) {
    const where = git.remote ? 'on no remote' : 'and the repo has no remote';
    flag(git.remote ? 'medium' : 'high', 'local-only', `${git.localOnly} commit(s) exist only on this machine (${where})`);
  } else if (git.ahead > 0) {
    flag('medium', 'unpushed', `${git.ahead} unpushed commit(s)`);
  }
  if (git.uncommitted > 0) flag(git.uncommitted > 20 ? 'medium' : 'low', 'uncommitted', `${git.uncommitted} uncommitted file(s)`);
  if (git.fetchError) flag('low', 'fetch-failed', `could not fetch: ${git.fetchError}`);
  if (remote) { /* no clone, so there is no upstream or remote to check */ }
  else if (git.branch && !git.remote) flag('low', 'no-remote', 'no remote, so nothing is backed up');
  else if (git.branch && git.upstream === null && !git.localOnly) flag('low', 'no-upstream', `branch ${git.branch} has no upstream`);
  if (git.lastCommit?.daysAgo > staleDays) flag('low', 'stale', `no commits for ${git.lastCommit.daysAgo} days`);
  const readyPRs = (github?.openPRs || []).filter((pr) => !pr.isDraft);
  if (readyPRs.length) flag('medium', 'open-prs', `${readyPRs.length} open PR(s) waiting`);
  if (!p.statusDocs?.length) flag('low', 'no-status-doc', 'no status doc, so the next step is unknown');
  return flags;
}

export function diffSnapshots(prev, curr) {
  if (!prev) return null;
  const before = new Map(prev.projects.map((p) => [p.name, new Set((p.flags || []).map((f) => f.code))]));
  const changes = [];
  for (const p of curr.projects) {
    const old = before.get(p.name);
    if (!old) { changes.push({ project: p.name, change: 'new project' }); continue; }
    const now = new Set(p.flags.map((f) => f.code));
    const added = [...now].filter((c) => !old.has(c));
    const resolved = [...old].filter((c) => !now.has(c));
    if (added.length || resolved.length) changes.push({ project: p.name, added, resolved });
  }
  for (const name of before.keys()) {
    if (!curr.projects.some((p) => p.name === name)) changes.push({ project: name, change: 'no longer tracked' });
  }
  return { since: prev.date, changes };
}

// With a mode, only snapshots of that mode count, so a remote run is never
// diffed against a local one (they see different flags). No mode means local.
export function latestSnapshotBefore(dir, date, mode) {
  let files;
  try { files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)); } catch { return null; }
  for (const f of files.filter((f) => f.slice(0, 10) < date).sort().reverse()) {
    const snap = readJson(path.join(dir, f));
    if (!mode || (snap?.mode || 'local') === mode) return snap;
  }
  return null;
}

// ---------- remote mode (GitHub only, no local clones) ----------

// Every command below goes through `exec(cmd, args, cwd)`, which returns
// { ok, out } or { ok: false, error } like sh(), so tests can stub gh.

function parseJson(r) {
  if (!r.ok) return null;
  try { return JSON.parse(r.out || 'null'); } catch { return null; }
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

// Which repos to collect: every repo of each `remote.owners` entry, plus any
// configured project's `github` field, plus the GitHub remote of local clones
// that happen to be on this machine. Configured details (name, notes, status
// docs, Vercel, Supabase) win, and `exclude`/`ignore` match the repo name too.
export async function remoteTargets(config, exec = sh) {
  const remote = config.remote || {};
  const exclude = new Set(config.exclude || []);
  const ignored = new Set((config.projects || []).filter((p) => p.ignore).map((p) => p.name || path.basename(p.path || '')));
  const configured = discoverProjects(config);
  const byName = new Map(configured.map((p) => [p.name.toLowerCase(), p]));
  const targets = new Map();
  const errors = [];
  const skip = (name) => exclude.has(name) || ignored.has(name);
  const add = (repo, extra, base) => {
    const key = repo.toLowerCase();
    const name = repo.split('/')[1];
    if (targets.has(key)) { Object.assign(targets.get(key), extra); return; }
    if (skip(name)) return;
    const { path: _path, ...details } = base || byName.get(name.toLowerCase()) || {};
    targets.set(key, { name, ...details, ...extra, repo });
  };

  for (const p of configured) {
    let repo = p.github || null;
    if (!repo && p.path && fs.existsSync(path.join(p.path, '.git'))) {
      const r = await exec('git', ['remote', 'get-url', 'origin'], p.path);
      repo = r.ok ? parseGithubRemote(r.out) : null;
    }
    if (repo) add(repo, {}, p);
  }

  for (const owner of remote.owners || []) {
    const r = await exec('gh', ['repo', 'list', owner, '--limit', '100', '--json', 'name,nameWithOwner,isArchived,isFork,pushedAt,defaultBranchRef']);
    const repos = parseJson(r);
    if (!Array.isArray(repos)) { errors.push(`could not list repos for ${owner}: ${r.error || 'unexpected reply from gh'}`); continue; }
    for (const x of repos) {
      if (x.isArchived || (x.isFork && !remote.includeForks)) continue;
      const branch = x.defaultBranchRef?.name;
      add(x.nameWithOwner, { ...(branch && { defaultBranch: branch }), ...(x.pushedAt && { pushedAt: x.pushedAt }) });
    }
  }
  const list = [...targets.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { targets: list, errors };
}

// Lists each needed directory once (root, then e.g. docs/ only if the root
// has it), then fetches just the status docs that exist, in configured order.
export async function fetchRemoteStatusDocs(repo, ref, docs, max, exec = sh) {
  const q = `?ref=${encodeURIComponent(ref)}`;
  const api = (p) => exec('gh', ['api', `repos/${repo}/contents${p ? `/${encodePath(p)}` : ''}${q}`]);
  const listings = new Map();
  const errors = [];
  const list = (dir) => {
    if (!listings.has(dir)) {
      listings.set(dir, api(dir).then((r) => {
        const entries = parseJson(r);
        if (!Array.isArray(entries)) {
          if (!dir) errors.push(`could not list files: ${r.error || 'unexpected reply'}`);
          return new Map();
        }
        return new Map(entries.map((e) => [e.name, e.type]));
      }));
    }
    return listings.get(dir);
  };
  const exists = async (rel) => {
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      const entries = await list(parts.slice(0, i).join('/'));
      if (entries.get(parts[i]) !== (i === parts.length - 1 ? 'file' : 'dir')) return false;
    }
    return true;
  };

  const found = [];
  for (const rel of docs) {
    if (found.length >= max) break;
    if (await exists(rel)) found.push(rel);
  }
  const out = await Promise.all(found.map(async (rel) => {
    const [file, history] = await Promise.all([
      api(rel),
      exec('gh', ['api', `repos/${repo}/commits?sha=${encodeURIComponent(ref)}&path=${encodeURIComponent(rel)}&per_page=1`]),
    ]);
    const body = parseJson(file);
    if (body?.encoding !== 'base64') { errors.push(`could not read ${rel}: ${file.error || 'file too large or unexpected reply'}`); return null; }
    const date = parseJson(history)?.[0]?.commit?.committer?.date;
    const text = Buffer.from(body.content, 'base64').toString('utf8');
    return { file: rel, ...(date && { updated: localDate(new Date(date)) }), ...extractNextSteps(text) };
  }));
  return { docs: out.filter(Boolean), errors };
}

async function collectRemoteGit(t, now, exec) {
  const git = { remote: `https://github.com/${t.repo}`, github: t.repo };
  let branch = t.defaultBranch;
  if (!branch) {
    const r = await exec('gh', ['api', `repos/${t.repo}`]);
    branch = parseJson(r)?.default_branch;
    if (!branch) return { ...git, error: r.error || 'no default branch' };
  }
  git.branch = branch;
  const r = await exec('gh', ['api', `repos/${t.repo}/commits?sha=${encodeURIComponent(branch)}&per_page=1`]);
  const c = parseJson(r)?.[0]?.commit;
  if (c) {
    const date = c.committer?.date || c.author?.date;
    git.lastCommit = { date, subject: (c.message || '').split('\n')[0], daysAgo: daysBetween(new Date(date), now) };
  } else if (/empty/i.test(r.error || '')) {
    git.empty = true;
  } else {
    git.error = `could not read the last commit: ${r.error || 'unexpected reply'}`;
  }
  return git;
}

export async function collectRemoteProject(t, config, { exec = sh, now = new Date() } = {}) {
  const result = { name: t.name, repo: t.repo, source: 'remote' };
  if (t.notes) result.notes = t.notes;
  if (t.vercel) result.vercel = t.vercel;
  if (t.supabase) result.supabase = t.supabase;
  result.git = await collectRemoteGit(t, now, exec);
  if (result.git.branch && !result.git.empty) {
    const [github, docs] = await Promise.all([
      collectGithub(t.repo, result.git.branch, exec),
      fetchRemoteStatusDocs(t.repo, result.git.branch, t.statusDocs || config.statusDocs, config.maxStatusDocs, exec),
    ]);
    result.github = github;
    result.statusDocs = docs.docs;
    if (docs.errors.length) result.statusDocErrors = docs.errors;
  } else {
    result.statusDocs = [];
  }
  result.flags = computeFlags(result, config);
  return result;
}

// Collects every remote target. The snapshot shape matches local mode, minus
// the fields that need a clone (uncommitted, ahead/behind, localOnly, path).
export async function collectRemote(config, { exec, now = new Date(), project = null } = {}) {
  const remote = config.remote || {};
  const timeout = (remote.timeoutSeconds || 20) * 1000;
  const timed = exec || ((cmd, args, cwd) => sh(cmd, args, cwd, timeout));
  let { targets, errors } = await remoteTargets(config, timed);
  if (project) targets = targets.filter((t) => t.name === project);
  const projects = await pool(targets, remote.concurrency || 4, async (t) => {
    try { return await collectRemoteProject(t, config, { exec: timed, now }); } catch (e) {
      const failed = { name: t.name, repo: t.repo, source: 'remote', git: { error: e.message }, statusDocs: [] };
      return { ...failed, flags: computeFlags(failed, config) };
    }
  });
  return { projects, errors };
}

// ---------- main ----------

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function collectProject(p, config, hasGh, now) {
  const result = { name: p.name, path: p.path };
  if (p.notes) result.notes = p.notes;
  if (p.vercel) result.vercel = p.vercel;
  if (p.supabase) result.supabase = p.supabase;
  result.git = await collectGit(p.path, { fetch: config.fetch, now });
  if (hasGh && result.git.github) result.github = await collectGithub(result.git.github, result.git.branch);
  result.statusDocs = readStatusDocs(p.path, p.statusDocs || config.statusDocs, config.maxStatusDocs);
  result.flags = computeFlags(result, config);
  return result;
}

function parseArgs(argv) {
  const args = { fetch: true, save: true, init: false, remote: false, project: null, config: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-fetch') args.fetch = false;
    else if (a === '--no-save') args.save = false;
    else if (a === '--init') args.init = true;
    else if (a === '--remote') args.remote = true;
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 11).join('\n'));
    return;
  }
  const home = dataDir();
  const configFile = expandHome(args.config || process.env.DEVBRIEF_CONFIG || path.join(home, 'config.json'));
  const { config, found } = loadConfig(configFile);

  if (args.init) {
    if (found) { console.error(`Config already exists: ${configFile}`); process.exit(1); }
    const projects = discoverProjects(config).map(({ name, path: p, vercel, supabase }) => ({
      name, path: homeRelative(p), ...(vercel && { vercel }), ...(supabase && { supabase }),
    }));
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ roots: [], projects, exclude: [] }, null, 2) + '\n');
    console.log(`Wrote ${configFile} with ${projects.length} project(s). Edit it to rename, exclude or add projects.`);
    return;
  }

  if (args.remote) return mainRemote(args, config, configFile, found, home);
  if (!args.fetch) config.fetch = false;
  const now = new Date();
  let projects = discoverProjects(config);
  if (args.project) projects = projects.filter((p) => p.name === args.project);
  if (!projects.length) {
    console.error(args.project ? `No project named "${args.project}".` : 'No projects found. Run with --init or add projects to the config.');
    process.exit(1);
  }

  const hasGh = (await sh('gh', ['auth', 'status'])).ok;
  const date = localDate(now);
  const snapshot = {
    version: 1,
    date,
    generatedAt: now.toISOString(),
    host: os.hostname(),
    configFile: found ? configFile : null,
    github: hasGh ? 'gh' : 'unavailable (install and log in to gh for PRs, issues and CI)',
    projects: await pool(projects, 4, (p) => collectProject(p, config, hasGh, now)),
  };
  saveAndPrint(snapshot, home, args);
}

function saveAndPrint(snapshot, home, args) {
  // Remote snapshots get their own folder so a cloud run never overwrites the
  // day's local snapshot when both share a DEVBRIEF_HOME.
  const snapDir = snapshot.mode === 'remote' ? path.join(home, 'snapshots', 'remote') : path.join(home, 'snapshots');
  const { date } = snapshot;
  if (!args.project) snapshot.changes = diffSnapshots(latestSnapshotBefore(snapDir, date, snapshot.mode || 'local'), snapshot);
  if (args.save && !args.project) {
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, `${date}.json`), JSON.stringify(snapshot, null, 2) + '\n');
  }
  console.log(JSON.stringify(snapshot, null, 2));
}

async function mainRemote(args, config, configFile, found, home) {
  if (!(await sh('gh', ['auth', 'status'])).ok) {
    console.error('Remote mode needs the GitHub CLI (gh) logged in. Run `gh auth login`, or set GH_TOKEN in a CI job.');
    process.exit(1);
  }
  const now = new Date();
  const { projects, errors } = await collectRemote(config, { now, project: args.project });
  if (!projects.length) {
    console.error(args.project ? `No remote project named "${args.project}".`
      : 'No remote projects found. Add "remote": { "owners": ["your-github-name"] } or "github": "owner/repo" entries to the config.');
    for (const e of errors) console.error(e);
    process.exit(1);
  }
  const snapshot = {
    version: 1,
    mode: 'remote',
    date: localDate(now),
    generatedAt: now.toISOString(),
    host: os.hostname(),
    configFile: found ? configFile : null,
    github: 'gh',
    ...(errors.length && { errors }),
    projects,
  };
  saveAndPrint(snapshot, home, args);
}

if (isMain(import.meta.url)) {
  main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
