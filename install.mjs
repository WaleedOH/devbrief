#!/usr/bin/env node
// Links the devbrief skill into ~/.claude/skills so Claude Code finds it,
// then writes a starter config if there is none. Run again to repair the link.
//
//   node install.mjs                link the skill and write a starter config
//   node install.mjs --with-hook    also pull your repos when a session starts
//   node install.mjs --remove-hook  take that hook out again (nothing else)
//
// CLAUDE_SKILLS_DIR and CLAUDE_SETTINGS_FILE point it somewhere else (tests use this).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dataDir, expandHome } from './skills/devbrief/scripts/collect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, 'skills', 'devbrief');
const pullScript = path.join(source, 'scripts', 'pull.mjs');

// Pulls on a fresh start and on resume; /clear and compaction are mid-session.
export const HOOK_MATCHER = 'startup|resume';
export const HOOK_TIMEOUT = 30;

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function settingsFile() {
  return process.env.CLAUDE_SETTINGS_FILE || path.join(claudeDir(), 'settings.json');
}

// Hooks run through sh, or Git Bash on Windows. Forward slashes work for both
// Windows and Git Bash, and double quotes keep spaces in paths together.
export function shellQuote(p, platform = process.platform) {
  const s = platform === 'win32' ? p.replace(/\\/g, '/') : p;
  return `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

export function hookCommand(node = process.execPath, script = pullScript, platform = process.platform) {
  return `${shellQuote(node, platform)} ${shellQuote(script, platform)} --quiet`;
}

export function isOurHook(h) {
  const cmd = String(h?.command || '');
  return cmd.includes('devbrief') && cmd.includes('pull.mjs');
}

// Returns settings with every devbrief hook gone, dropping groups and events
// that end up empty so the file looks as it did before we touched it.
export function withoutHook(settings) {
  const out = { ...settings };
  const groups = out.hooks?.SessionStart;
  if (!Array.isArray(groups)) return out;
  const kept = groups
    .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurHook(h)) } : g))
    .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length);
  out.hooks = { ...out.hooks, SessionStart: kept };
  if (!kept.length) delete out.hooks.SessionStart;
  if (!Object.keys(out.hooks).length) delete out.hooks;
  return out;
}

export function withHook(settings, command = hookCommand()) {
  const out = withoutHook(settings);
  const group = { matcher: HOOK_MATCHER, hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT }] };
  out.hooks = { ...out.hooks, SessionStart: [...(out.hooks?.SessionStart || []), group] };
  return out;
}

function readSettings(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  if (!text.trim()) return {};
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    throw new Error(`${file} is not valid JSON (${e.message}). Fix it by hand and run again; nothing was changed.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} does not hold a JSON object. Fix it by hand and run again; nothing was changed.`);
  }
  return parsed;
}

// Rewrites settings only when something changes, after saving a backup.
// Returns the backup path, null when there was no file to back up, or false
// when nothing needed changing.
export function updateSettings(file, change) {
  const before = readSettings(file);
  const after = change(before);
  if (JSON.stringify(after) === JSON.stringify(before)) return false;
  let backup = null;
  if (fs.existsSync(file)) fs.copyFileSync(file, backup = `${file}.devbrief.bak`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(after, null, 2) + '\n');
  return backup;
}

function linkSkill() {
  const skillsDir = process.env.CLAUDE_SKILLS_DIR || path.join(claudeDir(), 'skills');
  const target = path.join(skillsDir, 'devbrief');
  fs.mkdirSync(skillsDir, { recursive: true });

  let existing = null;
  try { existing = fs.lstatSync(target); } catch { /* nothing there */ }
  if (existing && !existing.isSymbolicLink()) {
    console.error(`${target} already exists and is not a link. Move it away and run again.`);
    process.exit(1);
  }
  if (existing) fs.unlinkSync(target);

  // A junction needs no admin rights on Windows; elsewhere a normal symlink.
  fs.symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
  console.log(`Linked ${target} -> ${source}`);

  const config = expandHome(process.env.DEVBRIEF_CONFIG || path.join(dataDir(), 'config.json'));
  if (fs.existsSync(config)) {
    console.log(`Keeping your config at ${config}`);
    return;
  }
  // Any failure here is real (the config check above covers "already exists").
  execFileSync(process.execPath, [path.join(source, 'scripts', 'collect.mjs'), '--init'], { stdio: 'inherit' });
}

function changeHook(add) {
  const file = settingsFile();
  try {
    const result = updateSettings(file, add ? (s) => withHook(s) : withoutHook);
    const changed = result !== false;
    if (add) console.log(changed ? `Added the auto-pull hook to ${file}` : `The auto-pull hook is already in ${file}`);
    else console.log(changed ? `Removed the auto-pull hook from ${file}` : `No auto-pull hook found in ${file}`);
    if (result) console.log(`Backup of the old file: ${result}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--remove-hook')) {
    changeHook(false);
    return;
  }
  linkSkill();
  if (args.includes('--with-hook')) changeHook(true);
  console.log('\nDone. In Claude Code, run /devbrief.');
}

// Compare real paths: Node resolves symlinks for the main module.
const realArgv = (() => { try { return fs.realpathSync(process.argv[1]); } catch { return null; } })();
if (realArgv && realArgv === fs.realpathSync(fileURLToPath(import.meta.url))) main();
