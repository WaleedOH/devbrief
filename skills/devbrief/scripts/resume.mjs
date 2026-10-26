#!/usr/bin/env node
// devbrief resume: "where was I?" across machines. Each machine publishes a
// small summary of its work in progress (branch, last commit, how much is
// uncommitted or unpushed, a few file names, never file contents) to a private
// GitHub repo you name, and any other machine can read it back.
//
//   node resume.mjs publish               save this machine's state
//   node resume.mjs publish --if-changed  skip when nothing changed (for hooks)
//   node resume.mjs publish --min-minutes 15   skip if published less than 15 min ago
//   node resume.mjs show                  the other machines' state, and what to do first
//   node resume.mjs show --json           the same as JSON
//   node resume.mjs ... --quiet           hooks: print only problems and hints
//   node resume.mjs ... --config f        same as DEVBRIEF_CONFIG=f

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, discoverProjects, expandHome, dataDir, isMain, daysBetween } from './collect.mjs';
import { run } from './deliver.mjs';

const MAX_RECENT = 5;
const ACTIVE_DAYS = 7;

export const SETUP_HELP = [
  'Resume needs a private GitHub repo to keep each machine\'s state in. Create one once:',
  '  gh repo create you/devbrief-state --private',
  'then add it to your devbrief config:',
  '  "resume": { "repo": "you/devbrief-state" }',
];

// ---------- this machine ----------

export function hostName(config = {}) {
  return String(config.resume?.host || os.hostname() || 'unknown');
}

export function hostFile(host) {
  const safe = host.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '') || 'unknown';
  return `hosts/${safe}.json`;
}

// `git status --porcelain -z`: "XY path\0", and renames add "\0old path".
export function parseStatus(out) {
  const entries = [];
  const parts = (out || '').split('\0').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    entries.push({ code, file: parts[i].slice(3) });
    if (/[RC]/.test(code)) i++;
  }
  return entries;
}

export function parseShortstat(out) {
  const n = (re) => Number((out || '').match(re)?.[1] || 0);
  return { files: n(/(\d+) files? changed/), insertions: n(/(\d+) insertions?/), deletions: n(/(\d+) deletions?/) };
}

export function diffSummary({ files, insertions, deletions }, untracked) {
  const parts = [];
  if (files) parts.push(`+${insertions} -${deletions} in ${files} file(s)`);
  if (untracked) parts.push(`${untracked} untracked`);
  return parts.join(', ');
}

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// Files being worked on, newest first; when fewer than five are open,
// the rest come from the latest commits. Names only.
async function recentFiles(dir, changed, g) {
  const open = changed.map((file) => ({ file, at: mtime(path.join(dir, file)) }))
    .sort((a, b) => b.at - a.at).map((x) => x.file);
  const out = [...new Set(open)].slice(0, MAX_RECENT);
  if (out.length < MAX_RECENT) {
    const log = await g('log', '-n', '20', '--name-only', '--format=');
    for (const f of log.ok ? log.out.split('\n').map((l) => l.trim()).filter(Boolean) : []) {
      if (out.length >= MAX_RECENT) break;
      if (!out.includes(f)) out.push(f);
    }
  }
  return out;
}

// One project's work in progress. No fetch: this must be fast enough for a
// hook, so ahead/behind are as of the last fetch.
export async function projectState(p, exec = run) {
  const g = (...args) => exec('git', args, { cwd: p.path, timeout: 15000 });
  const branch = await g('rev-parse', '--abbrev-ref', 'HEAD');
  if (!branch.ok) return { name: p.name, error: branch.error };
  const state = { name: p.name, branch: branch.out.trim() };

  const head = await g('rev-parse', '--short', 'HEAD');
  if (head.ok) state.head = head.out.trim();
  const last = await g('log', '-1', '--format=%cI%x00%s');
  if (last.ok && last.out) {
    const [date, subject] = last.out.trim().split('\0');
    state.lastCommit = { subject, date };
  }

  const status = await g('status', '--porcelain', '-z');
  const entries = status.ok ? parseStatus(status.out) : [];
  const untracked = entries.filter((e) => e.code === '??').length;
  state.uncommitted = entries.length;
  const stat = parseShortstat((await g('diff', '--shortstat', 'HEAD')).out);
  state.diffstat = diffSummary(stat, untracked);

  const localOnly = await g('rev-list', '--count', 'HEAD', '--not', '--remotes');
  if (localOnly.ok) state.localOnly = Number(localOnly.out.trim()) || 0;
  const counts = await g('rev-list', '--left-right', '--count', '@{upstream}...HEAD');
  if (counts.ok) {
    const [behind, ahead] = counts.out.trim().split(/\s+/).map(Number);
    Object.assign(state, { ahead, behind });
  }
  state.recentFiles = await recentFiles(p.path, entries.filter((e) => e.code !== '??').map((e) => e.file), g);
  return state;
}

export async function machineState(projects, { host, exec = run, now = new Date() } = {}) {
  const states = [];
  for (const p of projects) states.push(await projectState(p, exec));
  return { version: 1, host, updatedAt: now.toISOString(), projects: states };
}

// ---------- the state repo (through gh, no clone) ----------

const parse = (r) => { try { return JSON.parse(r.out); } catch { return null; } };
const notFound = (r) => /\b404\b|not found/i.test(r.error || '');

export function validRepo(repo) {
  return typeof repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(repo);
}

async function gh(exec, args, input) {
  const r = await exec('gh', args, { input, timeout: 20000 });
  if (r.missing) throw new Error('Resume needs the GitHub CLI (gh). Install it and run `gh auth login`.');
  return r;
}

// Refuses public repos: the state names your projects, branches and files.
export async function checkRepo(repo, exec = run) {
  const r = await gh(exec, ['api', `repos/${repo}`]);
  if (!r.ok) {
    if (notFound(r)) return `Could not find ${repo}. Create it with: gh repo create ${repo} --private`;
    return `Could not read ${repo}: ${r.error}`;
  }
  const info = parse(r);
  if (!info) return `Could not read ${repo}: unexpected reply from gh`;
  if (info.private !== true) return `${repo} is public. Resume only writes to a private repo; make it private (gh repo edit ${repo} --visibility private --accept-visibility-change-consequences) or name another one.`;
  return null;
}

export async function readFile(repo, file, exec = run) {
  const r = await gh(exec, ['api', `repos/${repo}/contents/${file}`]);
  if (!r.ok) return notFound(r) ? { missing: true } : { error: r.error };
  const body = parse(r);
  if (body?.encoding !== 'base64') return { error: 'unexpected reply from gh' };
  try {
    return { sha: body.sha, data: JSON.parse(Buffer.from(body.content, 'base64').toString('utf8')) };
  } catch {
    return { sha: body.sha, error: `${file} is not valid JSON` };
  }
}

// PUT needs the current sha to update a file. If another run got there first
// (409, or 422 "sha does not match") read the new sha and try once more.
export async function writeFile(repo, file, data, message, exec = run) {
  const content = Buffer.from(JSON.stringify(data, null, 2) + '\n').toString('base64');
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await readFile(repo, file, exec);
    if (current.error && !current.sha) return { ok: false, error: current.error };
    const body = { message, content, ...(current.sha && { sha: current.sha }) };
    const r = await gh(exec, ['api', '--method', 'PUT', `repos/${repo}/contents/${file}`, '--input', '-'], JSON.stringify(body));
    if (r.ok) return { ok: true, created: !current.sha };
    if (!/\b(409|422)\b|does not match|conflict/i.test(r.error || '')) return { ok: false, error: r.error };
  }
  return { ok: false, error: 'the file kept changing while saving; try again' };
}

export async function readHosts(repo, exec = run) {
  const r = await gh(exec, ['api', `repos/${repo}/contents/hosts`]);
  if (!r.ok) return notFound(r) ? { hosts: [], errors: [] } : { hosts: [], errors: [`could not list machines: ${r.error}`] };
  const entries = parse(r);
  if (!Array.isArray(entries)) return { hosts: [], errors: ['could not list machines: unexpected reply from gh'] };
  const hosts = [];
  const errors = [];
  for (const e of entries.filter((x) => x.type === 'file' && x.name.endsWith('.json'))) {
    const f = await readFile(repo, `hosts/${e.name}`, exec);
    if (f.data) hosts.push({ file: `hosts/${e.name}`, ...f.data });
    else errors.push(`could not read ${e.name}: ${f.error || 'missing'}`);
  }
  hosts.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return { hosts, errors };
}

// ---------- comparing ----------

function ago(iso, now) {
  const mins = Math.round((now - new Date(iso)) / 60000);
  if (!(mins >= 0)) return 'at an unknown time';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h ago`;
  return `${Math.round(mins / 1440)} days ago`;
}

const isActive = (p, now) => p.uncommitted > 0 || p.localOnly > 0 || p.ahead > 0
  || (p.lastCommit?.date && daysBetween(new Date(p.lastCommit.date), now) <= ACTIVE_DAYS);

// What to do before working here, from one other machine's state and this one's.
export function hintsFor(other, here) {
  const hints = [];
  const where = other.host;
  for (const p of other.projects || []) {
    if (p.error) continue;
    const local = here?.projects?.find((x) => x.name === p.name);
    if (p.localOnly > 0) hints.push(`${p.name}: push ${p.localOnly} commit(s) on ${where} first, they are on no remote`);
    else if (p.ahead > 0) hints.push(`${p.name}: push ${p.ahead} unpushed commit(s) on ${where} first`);
    if (p.uncommitted > 0) hints.push(`${p.name}: ${where} has ${p.uncommitted} uncommitted file(s)${p.diffstat ? ` (${p.diffstat})` : ''}; commit and push there to carry them over`);
    if (!local || local.error) continue;
    if (local.branch !== p.branch) {
      hints.push(`${p.name}: ${where} was on ${p.branch}, this machine is on ${local.branch}`);
    } else if (p.head && local.head && p.head !== local.head && p.lastCommit?.date > (local.lastCommit?.date || '')) {
      hints.push(`${p.name}: ${where} has newer commits (${p.head}); pull here (this machine is at ${local.head})`);
    }
  }
  return hints;
}

export function formatShow({ hosts, here, now = new Date(), quiet = false }) {
  const others = hosts.filter((h) => h.host !== here?.host);
  const lines = [];
  if (!quiet && !others.length) lines.push('No other machine has published yet. Run `resume.mjs publish` there first.');
  for (const h of others) {
    const hints = hintsFor(h, here);
    if (quiet) { lines.push(...hints.map((t) => `devbrief: ${t}`)); continue; }
    lines.push(`${h.host} (updated ${ago(h.updatedAt, now)})`);
    const active = (h.projects || []).filter((p) => !p.error && isActive(p, now));
    for (const p of active) {
      const commit = p.lastCommit ? ` · "${p.lastCommit.subject}" (${p.lastCommit.date.slice(0, 10)})` : '';
      lines.push(`  ${p.name} on ${p.branch}${commit}`);
      const wip = [];
      if (p.uncommitted) wip.push(`${p.uncommitted} uncommitted${p.diffstat ? `: ${p.diffstat}` : ''}`);
      if (p.localOnly) wip.push(`${p.localOnly} commit(s) on no remote`);
      else if (p.ahead) wip.push(`${p.ahead} unpushed`);
      if (wip.length) lines.push(`    ${wip.join(' · ')}`);
      if (p.recentFiles?.length) lines.push(`    recent: ${p.recentFiles.join(', ')}`);
    }
    const quietCount = (h.projects || []).length - active.length;
    if (quietCount > 0) lines.push(`  ${quietCount} other project(s) quiet`);
    for (const t of hints) lines.push(`  → ${t}`);
  }
  return lines;
}

// ---------- main ----------

const LAST_FILE = 'resume-last.json';

// Hash of everything but the timestamp, so --if-changed can skip a publish
// that would only bump the time.
export function stateHash(state) {
  const { updatedAt: _t, ...rest } = state;
  return crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

function parseArgs(argv) {
  const args = { command: null, json: false, quiet: false, ifChanged: false, minMinutes: 0, config: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--if-changed') args.ifChanged = true;
    else if (a === '--min-minutes') args.minMinutes = Number(argv[++i]) || 0;
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else if (!a.startsWith('-') && !args.command) args.command = a;
  }
  return args;
}

// Returns { code, lines } so tests can drive it with a stubbed exec.
export async function runResume(argv, { exec = run, env = process.env, now = new Date(), home = dataDir() } = {}) {
  const args = parseArgs(argv);
  if (args.help || !['publish', 'show'].includes(args.command)) {
    const usage = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14);
    return { code: args.help ? 0 : 1, lines: usage };
  }
  const configFile = expandHome(args.config || env.DEVBRIEF_CONFIG || path.join(home, 'config.json'));
  const { config } = loadConfig(configFile);
  const repo = config.resume?.repo;
  if (!repo) return { code: args.quiet ? 0 : 1, lines: args.quiet ? [] : SETUP_HELP };
  if (!validRepo(repo)) return { code: 1, lines: [`"resume.repo" should look like "you/devbrief-state", not "${repo}".`] };

  const host = hostName(config);
  const here = await machineState(discoverProjects(config), { host, exec, now });
  const problem = await checkRepo(repo, exec);
  if (problem) return { code: args.quiet ? 0 : 1, lines: [args.quiet ? `devbrief: resume: ${problem}` : problem] };

  if (args.command === 'publish') return publish(repo, here, args, home, exec);

  const { hosts, errors } = await readHosts(repo, exec);
  if (args.json) {
    const others = hosts.filter((h) => h.host !== host);
    const hints = others.flatMap((h) => hintsFor(h, here));
    return { code: 0, lines: [JSON.stringify({ host, here, hosts: others, hints, errors }, null, 2)] };
  }
  return { code: 0, lines: [...formatShow({ hosts, here, now, quiet: args.quiet }), ...errors.map((e) => `devbrief: ${e}`)] };
}

async function publish(repo, state, args, home, exec) {
  const hash = stateHash(state);
  const lastFile = path.join(home, LAST_FILE);
  let last = null;
  try { last = JSON.parse(fs.readFileSync(lastFile, 'utf8')); } catch { /* first publish here */ }
  const same = last?.repo === repo;
  if (args.ifChanged && same && last.hash === hash) {
    return { code: 0, lines: args.quiet ? [] : ['Nothing changed since the last publish, so nothing was sent.'] };
  }
  // The Stop hook fires after every reply; this keeps it from committing each time.
  const minutes = (new Date(state.updatedAt) - new Date(last?.at)) / 60000;
  if (args.minMinutes && same && minutes >= 0 && minutes < args.minMinutes) {
    return { code: 0, lines: args.quiet ? [] : [`Published ${Math.floor(minutes)} min ago, so skipped (--min-minutes ${args.minMinutes}).`] };
  }
  const file = hostFile(state.host);
  const r = await writeFile(repo, file, state, `devbrief: update ${state.host}`, exec);
  if (!r.ok) return { code: args.quiet ? 0 : 1, lines: [`devbrief: could not publish to ${repo}: ${r.error}`] };
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(lastFile, JSON.stringify({ repo, hash, at: state.updatedAt }) + '\n');
  return { code: 0, lines: args.quiet ? [] : [`Published ${state.projects.length} project(s) for ${state.host} to ${repo}/${file}.`] };
}

if (isMain(import.meta.url)) {
  runResume(process.argv.slice(2)).then(
    ({ code, lines }) => { if (lines.length) console.log(lines.join('\n')); process.exitCode = code; },
    (e) => { console.error(e.message); process.exitCode = process.argv.includes('--quiet') ? 0 : 1; },
  );
}
