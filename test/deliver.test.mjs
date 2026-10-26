// Delivery never touches the network or a real speaker here: fetch and exec
// are stubbed, and a global fetch that throws catches anything that slips by.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseBrief, toSpeech, speakable, ntfyMessage, discordChunks, desktopText, pickChannels,
  deliver, deliverConfig, formatResults, desktopCommands, speechCommands, todaysBrief,
} from '../skills/devbrief/scripts/deliver.mjs';
import { localDate } from '../skills/devbrief/scripts/collect.mjs';

globalThis.fetch = () => { throw new Error('a test tried to use the real network'); };

const script = fileURLToPath(new URL('../skills/devbrief/scripts/deliver.mjs', import.meta.url));
const BRIEF = fs.readFileSync(fileURLToPath(new URL('./fixtures/brief.md', import.meta.url)), 'utf8');
const ENV = { DEVBRIEF_NTFY_TOPIC: 'devbrief-made-up-topic-0000', DEVBRIEF_DISCORD_WEBHOOK: 'https://discord.com/api/webhooks/000/made-up' };

function fakeFetch(status = 200) {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, ...init }); return { ok: status < 300, status, statusText: status < 300 ? 'OK' : 'Bad' }; };
  return { fetch, calls };
}

function fakeExec(reply = () => ({ ok: true, out: '' })) {
  const calls = [];
  const exec = async (cmd, args, opts = {}) => { calls.push({ cmd, args, input: opts.input }); return reply(cmd); };
  return { exec, calls };
}

const noNetwork = () => { throw new Error('network used'); };
const noExec = () => { throw new Error('program run'); };

test('parseBrief reads Do first and the colored project lines', () => {
  const b = parseBrief(BRIEF);
  assert.equal(b.date, '2026-10-26');
  assert.equal(b.doFirst.length, 3);
  assert.match(b.doFirst[0], /^\*\*shop-api: Fix the failing CI/);
  assert.deepEqual(b.projects.map((p) => [p.level, p.name]), [
    ['red', 'shop-api'], ['yellow', 'landing'], ['yellow', 'recipes-app'], ['green', 'pixel-quest'], ['green', null],
  ]);
});

test('toSpeech reads Do first, then counts, with no markdown, emoji or paths', () => {
  const s = toSpeech(BRIEF);
  assert.match(s, /^Here is your dev brief for Monday, October 26\. Three things to do first\. First: shop-api: Fix the failing CI on main\./);
  assert.match(s, /One project needs you now, marked red: shop-api\./);
  assert.match(s, /Two projects need action soon, marked yellow: landing and recipes-app\./);
  assert.match(s, /Two projects are healthy\.$/);
  assert.doesNotMatch(s, /[*`#]|🔴|🟡|🟢|src\/|docs\/|\.md\b|\.js\b/);
  assert.ok(s.split(/\s+/).length <= 160);
});

test('toSpeech drops the detail first when the brief is long', () => {
  const long = BRIEF.replace(/\*\* (.*)$/gm, (_, why) => `** ${why} ${'More detail that goes on and on. '.repeat(10)}`);
  const s = toSpeech(long, { maxWords: 90 });
  assert.ok(s.split(/\s+/).length <= 90, s);
  assert.match(s, /First: shop-api: Fix the failing CI on main\. Second:/);
  assert.match(s, /marked red: shop-api/);
});

test('toSpeech says when nothing is urgent', () => {
  const s = toSpeech('# devbrief · 2026-10-27\n\n## Projects\n- 🟢 **landing**: next is the pricing page\n');
  assert.equal(s, 'Here is your dev brief for Tuesday, October 27. Nothing urgent today. One project is healthy.');
});

test('speakable keeps the useful part of paths and drops links and emoji', () => {
  assert.equal(speakable('Edit `~/code/shop-api/src/cart.js` now 🔥'), 'Edit cart now');
  assert.equal(speakable('See [the PR](https://example.com/pr/1) for 3/5 PRs'), 'See the pull request for 3/5 pull requests');
  assert.equal(speakable('Pull (+3) → test'), 'Pull, plus 3, then test');
});

test('ntfyMessage keeps Do first and red and yellow lines only', () => {
  const m = ntfyMessage(BRIEF);
  assert.equal(m.title, 'devbrief 2026-10-26');
  assert.equal(m.tags, 'red_circle');
  assert.match(m.body, /^\*\*Do first\*\*\n1\. \*\*shop-api/);
  assert.match(m.body, /🔴 \*\*shop-api\*\*/);
  assert.match(m.body, /🟡 \*\*recipes-app\*\*/);
  assert.match(m.body, /🟢 2 project\(s\) healthy$/);
  assert.doesNotMatch(m.body, /pixel-quest|Since last brief/);
});

test('ntfyMessage cuts whole lines and says how many were left out', () => {
  const many = '# devbrief · 2026-10-26\n## Projects\n' + Array.from({ length: 60 }, (_, i) => `- 🟡 **shop-api-${i}**: one thing to fix soon`).join('\n');
  const m = ntfyMessage(many, 300);
  assert.ok(m.body.length <= 300, m.body.length);
  assert.match(m.body, /…and \d+ more$/);
  assert.equal(m.tags, 'yellow_circle');
});

test('discordChunks splits on lines under 2000 characters and caps the count', () => {
  assert.deepEqual(discordChunks(BRIEF), [BRIEF.trim()]);
  const long = Array.from({ length: 400 }, (_, i) => `- line ${i} ${'x'.repeat(40)}`).join('\n');
  const chunks = discordChunks(long);
  assert.equal(chunks.length, 4);
  assert.ok(chunks.every((c) => c.length <= 2000));
  assert.match(chunks[3], /brief cut short/);
  assert.ok(chunks[0].endsWith(`${'x'.repeat(40)}`));
  const oneHugeLine = discordChunks('y'.repeat(4500));
  assert.deepEqual(oneHugeLine.map((c) => c.length), [2000, 2000, 500]);
});

test('desktopText is the top Do first action', () => {
  assert.equal(desktopText(BRIEF), 'shop-api: Fix the failing CI on main.');
  assert.equal(desktopText('## Projects\n- 🟢 **landing**: fine'), 'All projects healthy.');
});

test('pickChannels: --to wins, then the config default; --speak alone sends nothing', () => {
  const cfg = deliverConfig({ deliver: { default: ['ntfy', 'desktop'] } });
  assert.deepEqual(pickChannels({ to: 'Discord, ntfy,discord' }, cfg), ['discord', 'ntfy']);
  assert.deepEqual(pickChannels({}, cfg), ['ntfy', 'desktop']);
  assert.deepEqual(pickChannels({ speak: true }, cfg), []);
  assert.deepEqual(pickChannels({}, deliverConfig({})), ['ntfy']);
  assert.equal(deliverConfig({ deliver: { ntfy: { server: 'https://ntfy.example.com' } } }).ntfy.topicEnv, 'DEVBRIEF_NTFY_TOPIC');
});

test('a missing env var is a clear failure and nothing is sent', async () => {
  const results = await deliver(BRIEF, { channels: ['ntfy', 'discord'], env: {}, fetch: noNetwork, exec: noExec });
  assert.deepEqual(results.map((r) => r.ok), [false, false]);
  assert.match(results[0].message, /set DEVBRIEF_NTFY_TOPIC .*long random name/);
  assert.match(results[1].message, /set DEVBRIEF_DISCORD_WEBHOOK /);
  const custom = await deliver(BRIEF, { channels: ['ntfy'], env: {}, fetch: noNetwork, config: { deliver: { ntfy: { topicEnv: 'MY_TOPIC' } } } });
  assert.match(custom[0].message, /set MY_TOPIC/);
});

test('ntfy posts the short version as plain text with a title', async () => {
  const { fetch, calls } = fakeFetch();
  const config = { deliver: { ntfy: { server: 'https://ntfy.example.com/' } } };
  const [r] = await deliver(BRIEF, { channels: ['ntfy'], env: ENV, fetch, config });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://ntfy.example.com/devbrief-made-up-topic-0000');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.Title, 'devbrief 2026-10-26');
  assert.equal(calls[0].headers.Markdown, 'yes');
  assert.equal(calls[0].body, ntfyMessage(BRIEF).body);
});

test('ntfy rejects a topic that would change the URL', async () => {
  const [r] = await deliver(BRIEF, { channels: ['ntfy'], env: { DEVBRIEF_NTFY_TOPIC: '../admin?x=1' }, fetch: noNetwork });
  assert.equal(r.ok, false);
  assert.match(r.message, /letters, digits/);
});

test('Discord gets JSON chunks with mentions turned off, and errors hide the URL', async () => {
  const { fetch, calls } = fakeFetch();
  const [r] = await deliver(BRIEF, { channels: ['discord'], env: ENV, fetch });
  assert.equal(r.ok, true);
  const body = JSON.parse(calls[0].body);
  assert.equal(body.content, BRIEF.trim());
  assert.deepEqual(body.allowed_mentions, { parse: [] });

  const failing = async (url) => { throw new Error(`connect failed for ${url}`); };
  const [bad] = await deliver(BRIEF, { channels: ['discord'], env: ENV, fetch: failing });
  assert.equal(bad.ok, false);
  assert.ok(!bad.message.includes(ENV.DEVBRIEF_DISCORD_WEBHOOK), bad.message);

  const [notHook] = await deliver(BRIEF, { channels: ['discord'], env: { DEVBRIEF_DISCORD_WEBHOOK: 'https://example.com/x' }, fetch: noNetwork });
  assert.match(notHook.message, /does not look like a Discord webhook/);

  const { fetch: f500 } = fakeFetch(500);
  const [err] = await deliver(BRIEF, { channels: ['discord'], env: ENV, fetch: f500 });
  assert.match(err.message, /Discord answered 500/);
});

test('dry run builds every message but sends and runs nothing', async () => {
  const results = await deliver(BRIEF, { channels: ['ntfy', 'discord', 'desktop'], speak: true, dryRun: true, env: ENV, fetch: noNetwork, exec: noExec });
  assert.deepEqual(results.map((r) => [r.channel, r.ok]), [['ntfy', true], ['discord', true], ['desktop', true], ['speech', true]]);
  assert.match(results[0].message, /^would send/);
  assert.equal(results[3].preview, toSpeech(BRIEF));
  const lines = formatResults(results, { dryRun: true });
  assert.ok(lines.includes('devbrief: ntfy: ' + results[0].message));
  assert.ok(lines.some((l) => l.startsWith('  | Here is your dev brief')));
});

test('desktop and speech pass the text on stdin or as plain arguments, never inside a script', async () => {
  const hostile = '# devbrief · 2026-10-26\n## Do first\n1. **shop-api: run "$(rm -rf ~)" `whoami` \'; exit\'.** why\n';
  for (const platform of ['win32', 'darwin', 'linux']) {
    const { exec, calls } = fakeExec();
    const results = await deliver(hostile, { channels: ['desktop'], speak: true, platform, exec, fetch: noNetwork });
    assert.ok(results.every((r) => r.ok), platform);
    const [toast, voice] = calls;
    if (platform === 'win32') {
      assert.equal(toast.cmd, 'powershell');
      assert.ok(toast.args.includes('-EncodedCommand'));
      assert.ok(!toast.args.join(' ').includes('rm -rf'));
      assert.match(toast.input, /^devbrief\nshop-api: run "\$\(rm -rf ~\)"/);
      assert.ok(!voice.args.join(' ').includes('rm -rf'));
      assert.match(voice.input, /rm -rf/);
    } else if (platform === 'darwin') {
      assert.equal(toast.cmd, 'osascript');
      assert.ok(toast.args.slice(0, 6).every((a) => !a.includes('rm -rf')));
      assert.match(toast.args[7], /rm -rf/);
      assert.deepEqual([voice.cmd, voice.args], ['say', ['-f', '-']]);
    } else {
      assert.deepEqual(toast.args.slice(0, 2), ['--', 'devbrief']);
      assert.equal(voice.cmd, 'spd-say');
    }
  }
});

test('speech falls back through Linux engines, then prints the script', async () => {
  const { exec, calls } = fakeExec((cmd) => (cmd === 'espeak-ng' ? { ok: true } : { ok: false, missing: true }));
  const [r] = await deliver(BRIEF, { channels: [], speak: true, platform: 'linux', exec });
  assert.equal(r.ok, true);
  assert.deepEqual(calls.map((c) => c.cmd), ['spd-say', 'espeak-ng']);

  const printed = [];
  const none = fakeExec(() => ({ ok: false, missing: true }));
  const [miss] = await deliver(BRIEF, { channels: [], speak: true, platform: 'linux', exec: none.exec, log: (t) => printed.push(t) });
  assert.equal(miss.ok, false);
  assert.match(miss.message, /no speech program found .*printed above/);
  assert.deepEqual(printed, [toSpeech(BRIEF)]);

  const broken = fakeExec(() => ({ ok: false, error: 'audio device busy' }));
  const [fail] = await deliver(BRIEF, { channels: ['desktop'], platform: 'darwin', exec: broken.exec });
  assert.match(fail.message, /osascript failed: audio device busy/);
});

test('desktop can be turned off in the config', async () => {
  const [r] = await deliver(BRIEF, { channels: ['desktop'], config: { deliver: { desktop: false } }, exec: noExec });
  assert.equal(r.ok, false);
  assert.match(r.message, /turned off/);
});

test('command builders cover every platform', () => {
  assert.equal(desktopCommands('devbrief', 'x', 'linux')[0][0], 'notify-send');
  assert.deepEqual(speechCommands('x', 'linux').map((c) => c[0]), ['spd-say', 'espeak-ng', 'espeak']);
  const decoded = Buffer.from(speechCommands('x', 'win32')[0][1].at(-1), 'base64').toString('utf16le');
  assert.match(decoded, /System\.Speech/);
  assert.match(decoded, /OpenStandardInput/);
});

// ---------- the CLI, end to end (dry run or failing, so still offline) ----------

function runCli(args, env) {
  return new Promise((resolve) => {
    const clean = { ...process.env, DEVBRIEF_NTFY_TOPIC: '', DEVBRIEF_DISCORD_WEBHOOK: '', ...env };
    execFile(process.execPath, [script, ...args], { env: clean, encoding: 'utf8', timeout: 30000 },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout, err: stderr }));
  });
}

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrief-deliver-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('CLI: dry run of today\'s brief', async (t) => {
  const home = tempHome(t);
  fs.mkdirSync(path.join(home, 'briefs'));
  fs.writeFileSync(todaysBrief(home), BRIEF);
  assert.equal(path.basename(todaysBrief(home)), `${localDate()}.md`);
  const r = await runCli(['--dry-run', '--to', 'ntfy,desktop'], { DEVBRIEF_HOME: home, DEVBRIEF_CONFIG: '', ...ENV });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^devbrief: ntfy: would send \d+ characters/m);
  assert.match(r.out, /^devbrief: desktop: would show/m);
});

test('CLI: no brief today, and every channel failing, both exit 1', async (t) => {
  const home = tempHome(t);
  const none = await runCli([], { DEVBRIEF_HOME: home, DEVBRIEF_CONFIG: '' });
  assert.equal(none.code, 1);
  assert.match(none.err, /No brief for today yet .*Run \/devbrief first/);

  const file = path.join(home, 'b.md');
  fs.writeFileSync(file, BRIEF);
  const failed = await runCli(['--file', file, '--to', 'ntfy,discord'], { DEVBRIEF_HOME: home, DEVBRIEF_CONFIG: '' });
  assert.equal(failed.code, 1);
  assert.deepEqual(failed.out.trim().split('\n').map((l) => l.split(':')[1].trim()), ['ntfy failed', 'discord failed']);
});
