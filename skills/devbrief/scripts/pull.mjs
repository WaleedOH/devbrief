#!/usr/bin/env node
// devbrief auto-pull: fast-forwards every configured repo that is safely behind.
// Built to run from a Claude Code SessionStart hook, so it is quiet, time-capped
// and always exits 0. It never touches a repo with uncommitted changes or local
// commits, and it only ever fast-forwards.
//
//   node pull.mjs                 fetch and fast-forward every project
//   node pull.mjs --dry-run       say what would be pulled, change no branch or file
//   node pull.mjs --project x     one project only
//   node pull.mjs --quiet         print nothing when nothing changed
//   node pull.mjs --timeout 20    give up on unfinished repos after this many seconds

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, discoverProjects, expandHome, dataDir, isMain } from './collect.mjs';

const CONCURRENCY = 4;

function git(args, cwd, { signal, timeout = 15000 } = {}) {
  return new Promise((resolve) => {
    // GIT_TERMINAL_PROMPT=0: a hook has no terminal, so a password prompt would just hang.
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    execFile('git', args, { cwd, signal, timeout, env, windowsHide: true }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, out: stdout.trim() });
      const msg = String(stderr || err.message || 'failed').trim().split('\n')[0];
      resolve({ ok: false, error: err.killed ? 'timed out' : msg });
    });
  });
}

// One repo, start to finish. Returns { name, action, ... } where action is one of:
// pulled, would-pull, up-to-date, no-upstream, dirty, diverged, fetch-failed, failed.
export async function pullProject(p, { dryRun = false, signal, isLate = () => false } = {}) {
  const at = { name: p.name };
  const g = (...args) => git(args, p.path);

  const upstream = await g('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}');
  if (!upstream.ok) return { ...at, action: 'no-upstream' };

  const fetched = await git(['fetch', '--quiet'], p.path, { signal, timeout: 30000 });
  if (!fetched.ok) return { ...at, action: signal?.aborted ? 'timeout' : 'fetch-failed', error: fetched.error };

  const counts = await g('rev-list', '--left-right', '--count', '@{upstream}...HEAD');
  if (!counts.ok) return { ...at, action: 'failed', error: counts.error };
  const [behind, ahead] = counts.out.split(/\s+/).map(Number);
  if (!behind) return { ...at, action: 'up-to-date', ahead };
  if (ahead > 0) return { ...at, action: 'diverged', behind, ahead };

  const status = await g('status', '--porcelain', '--untracked-files=no');
  if (!status.ok) return { ...at, action: 'failed', error: status.error };
  if (status.out) return { ...at, action: 'dirty', behind };

  if (dryRun) return { ...at, action: 'would-pull', behind };
  if (isLate()) return { ...at, action: 'timeout' };
  // Same as `git pull --ff-only` minus a second network trip: the fetch above
  // already brought the commits in, so this step is local and quick.
  const merged = await g('merge', '--ff-only', '--quiet', '@{upstream}');
  if (!merged.ok) return { ...at, action: 'failed', behind, error: merged.error };
  return { ...at, action: 'pulled', behind };
}

// Runs every repo with a concurrency limit and a hard deadline. Repos still
// waiting on the network at the deadline are cut off and reported as timeouts.
export async function pullAll(projects, { dryRun = false, timeoutMs = 20000, concurrency = CONCURRENCY } = {}) {
  const controller = new AbortController();
  const results = new Array(projects.length);
  let late = false;
  let next = 0;
  const worker = async () => {
    while (next < projects.length && !late) {
      const i = next++;
      results[i] = await pullProject(projects[i], { dryRun, signal: controller.signal, isLate: () => late });
    }
  };
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  const work = Promise.all(Array.from({ length: Math.min(concurrency, projects.length) }, worker));
  await Promise.race([work, deadline]);
  clearTimeout(timer);
  late = true;
  controller.abort();
  return projects.map((p, i) => results[i] || { name: p.name, action: 'timeout' });
}

// One short line per repo that changed or needs a human. Everything else is
// left out, because a hook's output lands in Claude's context.
export function formatResults(results, { dryRun = false, quiet = false } = {}) {
  const lines = [];
  const names = (action) => results.filter((r) => r.action === action).map((r) => r.name);
  for (const r of results) {
    if (r.action === 'pulled') lines.push(`devbrief: pulled ${r.name} (+${r.behind})`);
    else if (r.action === 'would-pull') lines.push(`devbrief: would pull ${r.name} (+${r.behind})`);
    else if (r.action === 'dirty') lines.push(`devbrief: ${r.name} is behind (+${r.behind}) but has uncommitted changes, not pulled`);
    else if (r.action === 'diverged') lines.push(`devbrief: ${r.name} has diverged (${r.ahead} local, ${r.behind} on origin), not pulled`);
    else if (r.action === 'failed') lines.push(`devbrief: could not pull ${r.name}: ${r.error}`);
  }
  // Offline or slow networks hit every repo at once, so these share one line.
  const noFetch = names('fetch-failed');
  if (noFetch.length) lines.push(`devbrief: could not fetch ${noFetch.join(', ')}`);
  const late = names('timeout');
  if (late.length) lines.push(`devbrief: ran out of time, skipped ${late.join(', ')}`);
  if (!lines.length && !quiet) {
    lines.push(`devbrief: ${results.length} repo(s) checked, nothing to pull`);
  }
  return lines;
}

function parseArgs(argv) {
  const args = { dryRun: false, quiet: false, project: null, config: null, timeout: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--project') args.project = argv[++i];
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--timeout') args.timeout = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
  }
  if (!(args.timeout > 0)) args.timeout = 20;
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    return [fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).join('\n')];
  }
  const configFile = expandHome(args.config || process.env.DEVBRIEF_CONFIG || path.join(dataDir(), 'config.json'));
  const { config } = loadConfig(configFile);
  let projects = discoverProjects(config);
  if (args.project) projects = projects.filter((p) => p.name === args.project);
  if (!projects.length) {
    return args.quiet ? [] : [args.project ? `devbrief: no project named "${args.project}"` : 'devbrief: no projects configured'];
  }
  const results = await pullAll(projects, { dryRun: args.dryRun, timeoutMs: args.timeout * 1000 });
  return formatResults(results, args);
}

// Exit explicitly: a git process cut off at the deadline may still hold a pipe
// open. Wait for stdout to drain first, since pipes are async on Windows.
function finish(lines) {
  const text = lines.length ? lines.join('\n') + '\n' : '';
  process.stdout.write(text, () => process.exit(0));
}

if (isMain(import.meta.url)) {
  // A SessionStart hook must never block or fail the session, so even a crash exits 0.
  main().then(finish, (e) => finish([`devbrief: auto-pull failed: ${e.message}`]));
}
