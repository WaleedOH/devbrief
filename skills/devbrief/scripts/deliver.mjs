#!/usr/bin/env node
// devbrief delivery: sends a saved brief to your phone, Discord or desktop, or
// reads it out loud. No dependencies. Secrets (ntfy topic, webhook URL) come
// from environment variables named in the config, never from the config itself.
//
//   node deliver.mjs                      send today's brief to the default channels
//   node deliver.mjs --to ntfy,discord    pick channels: ntfy, discord, desktop
//   node deliver.mjs --speak              read the brief out loud
//   node deliver.mjs --file brief.md      a brief other than today's
//   node deliver.mjs --dry-run            show what would be sent, send nothing
//   node deliver.mjs --config f           same as DEVBRIEF_CONFIG=f

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, expandHome, dataDir, localDate, isMain, stripBom } from './collect.mjs';

export const DEFAULT_DELIVER = {
  ntfy: { topicEnv: 'DEVBRIEF_NTFY_TOPIC', server: 'https://ntfy.sh' },
  discord: { webhookEnv: 'DEVBRIEF_DISCORD_WEBHOOK' },
  desktop: true,
  default: ['ntfy'],
};

export const CHANNELS = ['ntfy', 'discord', 'desktop'];
const NTFY_MAX = 1200;
const DISCORD_MAX = 2000;
const DISCORD_MAX_MESSAGES = 4;

export function deliverConfig(config = {}) {
  const user = config.deliver || {};
  return {
    ...DEFAULT_DELIVER,
    ...user,
    ntfy: { ...DEFAULT_DELIVER.ntfy, ...(user.ntfy || {}) },
    discord: { ...DEFAULT_DELIVER.discord, ...(user.discord || {}) },
  };
}

// ---------- reading the brief ----------

const LEVELS = [['red', '🔴'], ['yellow', '🟡'], ['green', '🟢']];

// Splits the brief SKILL.md writes into its parts. Anything it does not
// recognise is ignored, so a hand-edited brief still delivers.
export function parseBrief(markdown) {
  const lines = stripBom(markdown).replace(/\r\n/g, '\n').split('\n');
  const title = (lines.find((l) => /^#\s/.test(l)) || '').replace(/^#\s+/, '').trim() || null;
  const date = (title || '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || null;
  const brief = { title, date, doFirst: [], projects: [] };
  let section = '';
  for (const line of lines) {
    const h = line.match(/^##\s+(.*)$/);
    if (h) { section = h[1].toLowerCase(); continue; }
    if (/do first/.test(section)) {
      const m = line.match(/^\s*\d+[.)]\s+(.*\S)/);
      if (m) brief.doFirst.push(m[1]);
    } else if (/projects/.test(section)) {
      const m = line.match(/^\s*[-*+]\s+(.*\S)/);
      if (!m) continue;
      const level = LEVELS.find(([, emoji]) => m[1].includes(emoji))?.[0] || null;
      const name = m[1].match(/\*\*([^*]+)\*\*/)?.[1] || null;
      brief.projects.push({ level, name, line: m[1] });
    }
  }
  return brief;
}

export function stripMarkdown(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/^\s*(?:#+|>)\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Lines are dropped whole, never cut mid-word, and the reader is told how
// many were left out.
function fitLines(lines, max) {
  const out = [];
  let size = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].length > max ? `${lines[i].slice(0, max - 1)}…` : lines[i];
    const room = i < lines.length - 1 ? 16 : 0; // for "…and N more"
    if (out.length && size + line.length + 1 + room > max) {
      out.push(`…and ${lines.slice(i).filter((l) => l.trim()).length} more`);
      break;
    }
    out.push(line);
    size += line.length + 1;
  }
  return out;
}

// ---------- messages ----------

// Phones cut long notifications short, so ntfy gets only what needs you:
// the Do first list and the red and yellow projects.
export function ntfyMessage(markdown, max = NTFY_MAX) {
  const b = parseBrief(markdown);
  const lines = [];
  if (b.doFirst.length) {
    lines.push('**Do first**');
    b.doFirst.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  }
  const hot = b.projects.filter((p) => p.level === 'red' || p.level === 'yellow');
  if (hot.length) {
    if (lines.length) lines.push('');
    for (const p of hot) lines.push(p.line);
  }
  const green = b.projects.filter((p) => p.level === 'green').length;
  if (green) lines.push(`🟢 ${green} project(s) healthy`);
  if (!lines.length) {
    lines.push(...stripBom(markdown).split(/\r?\n/).filter((l) => l.trim() && !/^#\s/.test(l)).slice(0, 12));
  }
  const title = b.date ? `devbrief ${b.date}` : 'devbrief';
  const worst = LEVELS.find(([level]) => b.projects.some((p) => p.level === level))?.[0];
  const tags = worst ? `${worst}_circle` : 'memo';
  return { title, tags, body: fitLines(lines, max).join('\n') || 'Your brief is empty.' };
}

// Discord caps a message at 2000 characters. Split on line breaks, and stop
// after a few messages so a huge brief cannot spam the channel.
export function discordChunks(markdown, max = DISCORD_MAX, maxMessages = DISCORD_MAX_MESSAGES) {
  const lines = stripBom(markdown).replace(/\r\n/g, '\n').trim().split('\n')
    .flatMap((l) => (l.length > max ? l.match(new RegExp(`.{1,${max}}`, 'gs')) : [l]));
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= max) { current = next; continue; }
    chunks.push(current);
    current = line;
  }
  if (current) chunks.push(current);
  if (chunks.length <= maxMessages) return chunks;
  const kept = chunks.slice(0, maxMessages);
  const note = '\n…(brief cut short, see the full file)';
  const last = kept[maxMessages - 1];
  kept[maxMessages - 1] = (last.length + note.length > max ? last.slice(0, max - note.length) : last) + note;
  return kept;
}

export function desktopText(markdown) {
  const b = parseBrief(markdown);
  // A toast has room for the action, not the reason behind it.
  if (b.doFirst.length) return stripMarkdown(b.doFirst[0].match(/^\*\*(.+?)\*\*/)?.[1] || b.doFirst[0]).slice(0, 200);
  if (b.projects.length && b.projects.every((p) => p.level === 'green')) return 'All projects healthy.';
  return 'Your brief is ready.';
}

// ---------- speech ----------

const NUMBERS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const ORDINALS = ['First', 'Second', 'Third', 'Fourth', 'Fifth'];
const spokenCount = (n) => NUMBERS[n] || String(n);
const cap = (s) => s[0].toUpperCase() + s.slice(1);

function spokenDate(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// Paths read out letter by letter are noise: keep the last part, so
// "~/code/shop-api" says "shop-api" and "docs/NEXT.md" says "NEXT".
function speakPath(token) {
  if (/^\d+\/\d+$/.test(token)) return token;
  const last = token.split(/[\\/]/).filter(Boolean).pop() || '';
  return last.replace(/\.[a-z0-9]{1,5}$/i, '');
}

export function speakable(text) {
  return stripMarkdown(text)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
    .replace(/(?:[A-Za-z]:)?[\w.~-]*[\\/][\w.~\\/-]*[\w-]/g, speakPath)
    .replace(/\b([\w-]+)\.(md|mjs|js|ts|tsx|json|ya?ml|txt)\b/g, '$1')
    .replace(/\bPRs\b/g, 'pull requests')
    .replace(/\bPR\b/g, 'pull request')
    .replace(/\s*(?:→|->)\s*/g, ', then ')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\(\+(\d+)\)/g, '(plus $1)')
    .replace(/\s*[()]\s*/g, ', ')
    .replace(/\s*;\s*/g, ', ')
    .replace(/\s+/g, ' ')
    .replace(/(?:\s*,)+\s*([.!?:])/g, '$1')
    .replace(/,(\s*,)+/g, ',')
    .replace(/^[\s,.:]+|[\s,:]+$/g, '')
    .trim();
}

const sentence = (s) => (s && !/[.!?]$/.test(s) ? `${s}.` : s);
const wordCount = (parts) => parts.join(' ').split(/\s+/).filter(Boolean).length;

function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// About 60 seconds of speech is roughly 150 words. Detail goes first when the
// script runs long: the "why" lines, then the project names.
export function toSpeech(markdown, { maxWords = 160 } = {}) {
  const b = parseBrief(markdown);
  const items = b.doFirst.map((raw) => {
    const bold = raw.match(/^\*\*(.+?)\*\*\s*(.*)$/);
    return { action: sentence(speakable(bold ? bold[1] : raw)), why: bold ? sentence(speakable(bold[2])) : '' };
  });
  const groups = [
    ['red', 'needs you now', 'need you now'],
    ['yellow', 'needs action soon', 'need action soon'],
  ].map(([level, one, many]) => {
    const names = b.projects.filter((p) => p.level === level).map((p) => speakable(p.name || p.line));
    return { level, names, one, many };
  });
  const green = b.projects.filter((p) => p.level === 'green').length;

  const build = ({ whys, names }) => {
    const parts = [b.date ? `Here is your dev brief for ${spokenDate(b.date)}.` : 'Here is your dev brief.'];
    if (items.length) {
      parts.push(items.length === 1 ? 'One thing to do first.' : `${cap(spokenCount(items.length))} things to do first.`);
      items.forEach((it, i) => parts.push(`${ORDINALS[i] || 'Next'}: ${it.action}`, ...(whys > i && it.why ? [it.why] : [])));
    } else {
      parts.push('Nothing urgent today.');
    }
    for (const g of groups) {
      if (!g.names.length) continue;
      const verb = g.names.length === 1 ? g.one : g.many;
      const count = g.names.length === 1 ? 'One project' : `${spokenCount(g.names.length)} projects`;
      parts.push(names ? `${cap(count)} ${verb}, marked ${g.level}: ${joinNames(g.names)}.` : `${cap(count)} ${verb}.`);
    }
    if (green) parts.push(green === 1 ? 'One project is healthy.' : `${cap(spokenCount(green))} projects are healthy.`);
    return parts.filter(Boolean);
  };

  for (let whys = items.length; whys >= 0; whys--) {
    const parts = build({ whys, names: true });
    if (wordCount(parts) <= maxWords) return parts.join(' ');
  }
  return build({ whys: 0, names: false }).join(' ');
}

// ---------- running programs ----------

// PowerShell on stderr wraps progress and errors in CLIXML; keep the readable bits.
function firstError(stderr) {
  return String(stderr || '').split(/\r?\n/).map((l) => l.replace(/<[^>]+>/g, '').trim())
    .find((l) => l && !/^#< CLIXML/.test(l) && !/Preparing modules/.test(l)) || '';
}

// Text always goes in on stdin, never into the command line, so quotes and
// $(...) in a brief can never become code. Resolves { ok, out } or
// { ok: false, error, missing } (missing: the program is not installed).
export function run(cmd, args, { input = '', timeout = 30000, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { cwd, timeout, windowsHide: true }); } catch (e) {
      return resolve({ ok: false, missing: e.code === 'ENOENT', error: e.message });
    }
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ ok: false, missing: e.code === 'ENOENT', error: e.code === 'ENOENT' ? `${cmd} is not installed` : e.message }));
    child.on('close', (code, signal) => resolve(code === 0
      ? { ok: true, out: out.replace(/\s+$/, '') } // keep leading spaces: `git status` needs them
      : { ok: false, error: firstError(err) || (signal ? 'timed out' : `${cmd} exited with code ${code}`) }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

// -EncodedCommand sidesteps Windows command-line quoting entirely; the
// scripts themselves are fixed and read their text from stdin.
function powershell(script) {
  const full = `$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; ${script}`;
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(full, 'utf16le').toString('base64')];
}

const READ_STDIN = '$text = (New-Object IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)).ReadToEnd();';

const WINDOWS_TOAST = `${READ_STDIN}
$parts = $text -split [char]10, 2
$n = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$nodes = $xml.GetElementsByTagName('text')
[void]$nodes.Item(0).AppendChild($xml.CreateTextNode($parts[0]))
[void]$nodes.Item(1).AppendChild($xml.CreateTextNode($parts[1]))
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($xml))`;

const WINDOWS_SPEECH = `${READ_STDIN}
Add-Type -AssemblyName System.Speech
$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice.Speak($text)`;

// Each entry: [command, args, stdin]. Tried in order; a missing program
// moves on to the next one.
export function desktopCommands(title, text, platform = process.platform) {
  if (platform === 'win32') return [['powershell', powershell(WINDOWS_TOAST), `${title}\n${text}`]];
  if (platform === 'darwin') {
    // osascript gets the text as script arguments (argv), not inside the script.
    return [['osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, text], '']];
  }
  return [['notify-send', ['--', title, text], '']];
}

export function speechCommands(script, platform = process.platform) {
  if (platform === 'win32') return [['powershell', powershell(WINDOWS_SPEECH), script]];
  if (platform === 'darwin') return [['say', ['-f', '-'], script]];
  return [['spd-say', ['-w', '-e'], script], ['espeak-ng', ['--stdin'], script], ['espeak', ['--stdin'], script]];
}

async function firstWorking(commands, exec, timeout) {
  const missing = [];
  for (const [cmd, args, input] of commands) {
    const r = await exec(cmd, args, { input, timeout });
    if (r.ok) return { ok: true, cmd };
    if (!r.missing) return { ok: false, cmd, error: r.error };
    missing.push(cmd);
  }
  return { ok: false, missing: true, error: `none of ${missing.join(', ')} is installed` };
}

// ---------- channels ----------

const envHelp = {
  ntfy: (name) => `set ${name} to your ntfy topic (use a long random name: anyone who knows a topic can read it)`,
  discord: (name) => `set ${name} to your Discord webhook URL (Server settings > Integrations > Webhooks)`,
};

async function sendNtfy(markdown, cfg, { env, fetch, dryRun }) {
  const name = cfg.ntfy.topicEnv;
  const topic = (env[name] || '').trim();
  if (!topic) return { ok: false, message: envHelp.ntfy(name) };
  if (!/^[\w-]{1,64}$/.test(topic)) return { ok: false, message: `${name} must be letters, digits, - or _ (64 at most)` };
  const msg = ntfyMessage(markdown);
  if (dryRun) return { ok: true, message: `would send ${msg.body.length} characters titled "${msg.title}"`, preview: msg.body };
  const server = String(cfg.ntfy.server || DEFAULT_DELIVER.ntfy.server).replace(/\/+$/, '');
  try {
    const res = await fetch(`${server}/${topic}`, {
      method: 'POST',
      headers: { Title: msg.title, Markdown: 'yes', Tags: msg.tags, 'Content-Type': 'text/plain; charset=utf-8' },
      body: msg.body,
    });
    if (!res.ok) return { ok: false, message: `ntfy answered ${res.status} ${res.statusText || ''}`.trim() };
    return { ok: true, message: `sent ${msg.body.length} characters` };
  } catch (e) {
    return { ok: false, message: `could not reach ntfy: ${e.message}` };
  }
}

async function sendDiscord(markdown, cfg, { env, fetch, dryRun }) {
  const name = cfg.discord.webhookEnv;
  const url = (env[name] || '').trim();
  if (!url) return { ok: false, message: envHelp.discord(name) };
  if (!/^https:\/\/(?:[\w-]+\.)?(?:discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)) {
    return { ok: false, message: `${name} does not look like a Discord webhook URL` };
  }
  const chunks = discordChunks(markdown);
  if (dryRun) return { ok: true, message: `would send ${chunks.length} message(s)`, preview: chunks.join('\n---\n') };
  for (let i = 0; i < chunks.length; i++) {
    try {
      // allowed_mentions off: a brief that quotes "@everyone" must not ping anyone.
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: chunks[i], username: 'devbrief', allowed_mentions: { parse: [] } }),
      });
      if (!res.ok) return { ok: false, message: `Discord answered ${res.status} on message ${i + 1} of ${chunks.length}` };
    } catch (e) {
      // Never echo the URL: it is the secret.
      return { ok: false, message: `could not reach Discord: ${e.message.replace(url, '<webhook>')}` };
    }
  }
  return { ok: true, message: `sent ${chunks.length} message(s)` };
}

async function sendDesktop(markdown, cfg, { exec, platform, dryRun }) {
  if (cfg.desktop === false) return { ok: false, message: 'turned off in the config ("deliver": { "desktop": false })' };
  const text = desktopText(markdown);
  if (dryRun) return { ok: true, message: `would show "devbrief: ${text}"` };
  const r = await firstWorking(desktopCommands('devbrief', text, platform), exec, 15000);
  if (r.ok) return { ok: true, message: 'shown' };
  if (r.missing) return { ok: false, message: platform === 'linux' ? 'notify-send is not installed (try the libnotify-bin package)' : r.error };
  return { ok: false, message: `${r.cmd} failed: ${r.error}` };
}

async function speak(markdown, { exec, platform, dryRun, log }) {
  const script = toSpeech(markdown);
  if (dryRun) return { ok: true, message: `would say ${wordCount([script])} words`, preview: script };
  const r = await firstWorking(speechCommands(script, platform), exec, 180000);
  if (r.ok) return { ok: true, message: `spoke ${wordCount([script])} words` };
  log(script);
  const why = r.missing && platform === 'linux'
    ? 'no speech program found (install speech-dispatcher or espeak-ng); the script is printed above'
    : `${r.error}; the script is printed above`;
  return { ok: false, message: why };
}

const SENDERS = { ntfy: sendNtfy, discord: sendDiscord, desktop: sendDesktop };

// --to wins, then the config's default list. --speak on its own means "just speak".
export function pickChannels({ to = null, speak: wantSpeech = false }, cfg) {
  if (to) return [...new Set(to.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (wantSpeech) return [];
  return Array.isArray(cfg.default) ? cfg.default : [];
}

export async function deliver(markdown, {
  channels, speak: wantSpeech = false, dryRun = false, config = {}, env = process.env,
  fetch = globalThis.fetch, exec = run, platform = process.platform, log = console.log,
} = {}) {
  const cfg = deliverConfig(config);
  const ctx = { env, fetch, exec, platform, dryRun, log };
  const results = [];
  for (const channel of channels) {
    const send = SENDERS[channel];
    if (!send) { results.push({ channel, ok: false, message: `unknown channel (use ${CHANNELS.join(', ')})` }); continue; }
    results.push({ channel, ...(await send(markdown, cfg, ctx)) });
  }
  if (wantSpeech) results.push({ channel: 'speech', ...(await speak(markdown, ctx)) });
  return results;
}

export function formatResults(results, { dryRun = false } = {}) {
  const lines = [];
  for (const r of results) {
    lines.push(r.ok ? `devbrief: ${r.channel}: ${r.message}` : `devbrief: ${r.channel} failed: ${r.message}`);
    if (dryRun && r.preview) lines.push(...r.preview.split('\n').map((l) => `  | ${l}`));
  }
  return lines;
}

// ---------- main ----------

function parseArgs(argv) {
  const args = { file: null, to: null, speak: false, dryRun: false, config: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--to') args.to = argv[++i] || '';
    else if (a === '--speak') args.speak = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

export function todaysBrief(home = dataDir(), now = new Date()) {
  return path.join(home, 'briefs', `${localDate(now)}.md`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).join('\n'));
    return 0;
  }
  const configFile = expandHome(args.config || process.env.DEVBRIEF_CONFIG || path.join(dataDir(), 'config.json'));
  const { config } = loadConfig(configFile);
  const file = args.file ? path.resolve(expandHome(args.file)) : todaysBrief();
  let markdown;
  try { markdown = fs.readFileSync(file, 'utf8'); } catch {
    console.error(args.file ? `No brief at ${file}.` : `No brief for today yet (${file}). Run /devbrief first, or pass --file.`);
    return 1;
  }
  const channels = pickChannels(args, deliverConfig(config));
  if (!channels.length && !args.speak) {
    console.error('No channels to send to. Pass --to ntfy,discord,desktop or set "deliver": { "default": [...] } in the config.');
    return 1;
  }
  const results = await deliver(markdown, { channels, speak: args.speak, dryRun: args.dryRun, config });
  for (const line of formatResults(results, args)) console.log(line);
  return results.some((r) => r.ok) ? 0 : 1;
}

if (isMain(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 1; });
}
