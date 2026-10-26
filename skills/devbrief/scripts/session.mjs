#!/usr/bin/env node
// devbrief session tracking, run from Claude Code hooks. Reads the hook's JSON
// on stdin, never prints anything unless it nudges, and always exits 0.
//
//   node session.mjs start   SessionStart: remember where HEAD was
//   node session.mjs stop    Stop: if the session made commits but the status
//                            doc was not touched, ask once for /devbrief wrap
//
// Hook input and output: https://code.claude.com/docs/en/hooks

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_STATUS_DOCS, dataDir, expandHome, isMain, loadConfig, stripBom } from './collect.mjs';

const KEEP_DAYS = 14;
const QUIET_NOTES = /\b(paused|archived|superseded|abandoned|on hold|frozen|dead)\b/i;

function gitRaw(cwd, ...args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

const git = (cwd, ...args) => gitRaw(cwd, ...args)?.trim() ?? null;

function sessionsDir(home = dataDir()) {
  return path.join(home, 'sessions');
}

// Session ids come from Claude Code, but they still end up in a file name.
function sessionFile(id, home) {
  return path.join(sessionsDir(home), `${String(id).replace(/[^\w-]/g, '_')}.json`);
}

function readSession(id, home) {
  try { return JSON.parse(fs.readFileSync(sessionFile(id, home), 'utf8')); } catch { return null; }
}

function writeSession(record, home) {
  fs.mkdirSync(sessionsDir(home), { recursive: true });
  fs.writeFileSync(sessionFile(record.session_id, home), JSON.stringify(record, null, 2) + '\n');
}

export function pruneSessions(home = dataDir(), now = Date.now(), keepDays = KEEP_DAYS) {
  const dir = sessionsDir(home);
  let names;
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let removed = 0;
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > keepDays * 86400000) { fs.unlinkSync(file); removed++; }
    } catch { /* gone already */ }
  }
  return removed;
}

// Resume and compaction fire SessionStart again with the same id. Keeping the
// first record means commits from earlier in the session still count.
export function recordStart(input, { home = dataDir(), now = new Date() } = {}) {
  pruneSessions(home, now.getTime());
  if (!input?.session_id || !input.cwd) return null;
  const existing = readSession(input.session_id, home);
  if (existing) return existing;
  const repoRoot = git(input.cwd, 'rev-parse', '--show-toplevel');
  if (!repoRoot) return null;
  const record = {
    session_id: input.session_id,
    cwd: input.cwd,
    repoRoot: path.resolve(repoRoot),
    head: git(repoRoot, 'rev-parse', '--verify', '--quiet', 'HEAD') || null,
    startedAt: now.toISOString(),
  };
  writeSession(record, home);
  return record;
}

const samePath = (a, b) => (process.platform === 'win32' || process.platform === 'darwin'
  ? a.toLowerCase() === b.toLowerCase()
  : a === b);

// Real paths on both sides: git reports /private/var on macOS for /var, and
// a configured path may go through a symlink.
function realPath(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

export function projectFor(repoRoot, config) {
  const root = realPath(repoRoot);
  return (config.projects || []).find((p) => p.path && samePath(realPath(expandHome(p.path)), root)) || null;
}

// Why not to nudge for this repo, or null to go ahead.
export function optedOut(config, project) {
  if (config.wrap?.nudge === false) return 'off in config';
  if (project?.wrap?.nudge === false) return 'off for this project';
  if (project?.ignore) return 'project ignored';
  if (project?.notes && QUIET_NOTES.test(project.notes)) return 'project notes say it is not active';
  return null;
}

const norm = (f) => f.replace(/\\/g, '/').toLowerCase();

// `status --porcelain -z` entries are "XY path"; a rename or copy is followed
// by one more entry holding the old name, which also counts as touched.
function porcelainFiles(out) {
  const entries = (out || '').split('\0');
  const files = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.length < 4) continue;
    files.push(e.slice(3));
    if (/[RC]/.test(e.slice(0, 2))) files.push(entries[++i]);
  }
  return files;
}

// The nudge text, or null when there is nothing to say.
export function checkStop(input, { home = dataDir(), config = {} } = {}) {
  if (!input || input.stop_hook_active) return null;
  // Claude is only pausing for background work; it will stop again later.
  if (input.background_tasks?.length) return null;
  const record = input.session_id && readSession(input.session_id, home);
  if (!record || record.nudged) return null;

  const project = projectFor(record.repoRoot, config);
  if (optedOut(config, project)) return null;

  const range = record.head ? [`${record.head}..HEAD`] : ['HEAD'];
  const count = Number(git(record.repoRoot, 'rev-list', '--count', ...range));
  if (!(count > 0)) return null;

  const docs = (project?.statusDocs || config.statusDocs || DEFAULT_STATUS_DOCS).map(norm);
  const committed = (git(record.repoRoot, '-c', 'core.quotePath=false', 'log', '--format=', '--name-only', ...range) || '').split('\n');
  const working = porcelainFiles(gitRaw(record.repoRoot, 'status', '--porcelain', '-z', '--untracked-files=all'));
  const touched = [...committed, ...working].filter(Boolean).map(norm);
  if (touched.some((f) => docs.includes(f))) return null;

  const existing = (project?.statusDocs || config.statusDocs || DEFAULT_STATUS_DOCS)
    .find((d) => fs.existsSync(path.join(record.repoRoot, d)));
  const commits = `${count} commit${count === 1 ? '' : 's'}`;
  const reason = existing
    ? `devbrief: you made ${commits} this session but ${existing} wasn't updated. Run /devbrief wrap (or say skip).`
    : `devbrief: you made ${commits} this session and this repo has no status doc yet. Run /devbrief wrap to start STATUS.md (or say skip).`;

  writeSession({ ...record, nudged: new Date().toISOString() }, home);
  return reason;
}

function readStdin() {
  try { return JSON.parse(stripBom(fs.readFileSync(0, 'utf8'))); } catch { return null; }
}

function main() {
  const mode = process.argv[2];
  const input = readStdin();
  if (mode === 'start') {
    recordStart(input);
    return '';
  }
  if (mode === 'stop') {
    if (!input || input.stop_hook_active) return '';
    const configFile = expandHome(process.env.DEVBRIEF_CONFIG || path.join(dataDir(), 'config.json'));
    const { config } = loadConfig(configFile);
    const reason = checkStop(input, { config });
    return reason ? JSON.stringify({ decision: 'block', reason }) + '\n' : '';
  }
  return '';
}

if (isMain(import.meta.url)) {
  // A hook must never break the session, so every failure is silent.
  let out = '';
  try { out = main(); } catch { out = ''; }
  process.stdout.write(out, () => process.exit(0));
}
