// The MCP server, end to end over stdio the way a client runs it, plus its
// pure helpers. A temp DEVBRIEF_HOME keeps the real ~/.devbrief out of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  handleMessage, capText, negotiateVersion, summarizeSnapshot, readBrief, latestSnapshot,
  TOOL_NAMES, LEGACY_VERSIONS, MODERN_VERSIONS,
} from '../skills/devbrief/mcp/server.mjs';

const serverPath = fileURLToPath(new URL('../skills/devbrief/mcp/server.mjs', import.meta.url));
const reviewPath = fileURLToPath(new URL('../skills/devbrief/scripts/review.mjs', import.meta.url));

const SNAPSHOT = {
  version: 1,
  date: '2026-03-14',
  generatedAt: '2026-03-14T08:00:00.000Z',
  configFile: null,
  projects: [
    {
      name: 'shop-api',
      git: { branch: 'main', behind: 2 },
      statusDocs: [{ file: 'STATUS.md', items: [{ text: 'Add Apple Pay to checkout' }, { text: 'Write the refund flow' }] }],
      flags: [
        { severity: 'high', code: 'ci-failing', message: 'CI "test" is failing on main' },
        { severity: 'medium', code: 'behind', message: '2 commit(s) behind origin, pull before working' },
      ],
    },
    { name: 'old-prototype', notes: 'paused', statusDocs: [], flags: [{ severity: 'low', code: 'stale', message: 'no commits for 90 days' }] },
  ],
  changes: { since: '2026-03-13', changes: [{ project: 'shop-api', added: ['ci-failing'], resolved: [] }] },
};

function tmpHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrief-mcp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'snapshots'));
  fs.mkdirSync(path.join(dir, 'briefs'));
  fs.writeFileSync(path.join(dir, 'snapshots', '2026-03-13.json'), JSON.stringify({ ...SNAPSHOT, date: '2026-03-13', projects: [] }));
  fs.writeFileSync(path.join(dir, 'snapshots', '2026-03-14.json'), JSON.stringify(SNAPSHOT));
  fs.writeFileSync(path.join(dir, 'briefs', '2026-03-13.md'), '# devbrief · 2026-03-13\n');
  fs.writeFileSync(path.join(dir, 'briefs', '2026-03-14.md'), '﻿# devbrief · 2026-03-14\n\n## Do first\n');
  return dir;
}

// A tiny client: writes raw lines, and collects every stdout line as JSON so a
// stray non-JSON write fails the test.
function startServer(t, env) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  t.after(() => child.kill());
  const raw = [];
  const waiters = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      raw.push(line);
      const msg = JSON.parse(line);
      for (const w of waiters.splice(0)) if (!w(msg)) waiters.push(w);
    }
  });
  const next = (match) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no reply from the server')), 30000);
    waiters.push((msg) => (match(msg) ? (clearTimeout(timer), resolve(msg), true) : false));
  });
  const write = (line) => child.stdin.write(line + '\n');
  const request = (id, method, params) => {
    write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params && { params }) }));
    return next((m) => m.id === id);
  };
  return { child, raw, write, next, request };
}

const text = (reply) => reply.result.content[0].text;

test('initialize, tools/list and devbrief_latest over stdio', async (t) => {
  const home = tmpHome(t);
  const s = startServer(t, { DEVBRIEF_HOME: home, DEVBRIEF_CONFIG: path.join(home, 'config.json') });

  const init = await s.request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  assert.equal(init.jsonrpc, '2.0');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(init.result.serverInfo.name, 'devbrief');
  s.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

  const pong = await s.request(2, 'ping');
  assert.equal(pong.result.resultType, 'complete');

  const list = await s.request(3, 'tools/list');
  assert.deepEqual(list.result.tools.map((x) => x.name), TOOL_NAMES);
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.run, undefined);
  }

  const latest = await s.request(4, 'tools/call', { name: 'devbrief_latest', arguments: {} });
  assert.equal(latest.result.isError, false);
  const summary = JSON.parse(text(latest));
  assert.equal(summary.date, '2026-03-14');
  assert.deepEqual(summary.projects[0], {
    name: 'shop-api',
    severity: { high: 1, medium: 1, low: 0 },
    nextStep: { text: 'Add Apple Pay to checkout', file: 'STATUS.md' },
    flags: ['high ci-failing: CI "test" is failing on main', 'medium behind: 2 commit(s) behind origin, pull before working'],
  });
  assert.equal(summary.projects[1].notes, 'paused');

  const project = await s.request(5, 'tools/call', { name: 'devbrief_project', arguments: { name: 'shop-api' } });
  assert.equal(JSON.parse(text(project)).project.git.behind, 2);

  const brief = await s.request(6, 'tools/call', { name: 'devbrief_brief', arguments: {} });
  assert.match(text(brief), /^# devbrief · 2026-03-14/);

  // Every byte on stdout was a JSON-RPC message (the parser above would have thrown otherwise).
  assert.equal(s.raw.length, 6);
  for (const line of s.raw) assert.equal(JSON.parse(line).jsonrpc, '2.0');
});

test('errors: unknown method, unknown tool, malformed JSON, bad request', async (t) => {
  const home = tmpHome(t);
  const s = startServer(t, { DEVBRIEF_HOME: home });

  const unknown = await s.request('a', 'resources/list');
  assert.equal(unknown.error.code, -32601);

  const tool = await s.request('b', 'tools/call', { name: 'devbrief_delete_everything' });
  assert.equal(tool.error.code, -32602);
  assert.match(tool.error.message, /Unknown tool/);

  s.write('{"jsonrpc": "2.0", "id": 7, "method": ');
  const parse = await s.next((m) => m.error?.code === -32700);
  assert.equal(parse.id, null);

  s.write(JSON.stringify({ jsonrpc: '1.0', id: 'c', method: 'ping' }));
  const invalid = await s.next((m) => m.id === 'c');
  assert.equal(invalid.error.code, -32600);

  // The server is still alive and answering after all that.
  const pong = await s.request('d', 'ping');
  assert.ok(pong.result);
});

test('stateless requests: server/discover and version checks in _meta', async (t) => {
  const home = tmpHome(t);
  const s = startServer(t, { DEVBRIEF_HOME: home });
  const meta = (v) => ({ _meta: { 'io.modelcontextprotocol/protocolVersion': v, 'io.modelcontextprotocol/clientCapabilities': {} } });

  const discover = await s.request(1, 'server/discover', meta('2026-07-28'));
  assert.ok(discover.result.supportedVersions.includes('2026-07-28'));
  assert.equal(discover.result._meta['io.modelcontextprotocol/serverInfo'].name, 'devbrief');

  const call = await s.request(2, 'tools/call', { name: 'devbrief_latest', arguments: {}, ...meta('2026-07-28') });
  assert.equal(call.result.resultType, 'complete');
  assert.equal(JSON.parse(text(call)).date, '2026-03-14');

  const old = await s.request(3, 'tools/list', meta('1900-01-01'));
  assert.equal(old.error.code, -32022);
  assert.equal(old.error.data.requested, '1900-01-01');

  const noCaps = await s.request(4, 'tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } });
  assert.equal(noCaps.error.code, -32602);
});

test('devbrief_collect runs the collector without saving a snapshot', async (t) => {
  const home = tmpHome(t);
  const repo = path.join(home, 'landing');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'pipe' });
  git('-c', 'init.defaultBranch=main', 'init', '--quiet');
  fs.writeFileSync(path.join(repo, 'README.md'), '# landing\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'first');
  const config = path.join(home, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ roots: [], projects: [{ name: 'landing', path: repo }] }));
  const s = startServer(t, { DEVBRIEF_HOME: home, DEVBRIEF_CONFIG: config, HOME: home, USERPROFILE: home });

  const reply = await s.request(1, 'tools/call', { name: 'devbrief_collect', arguments: { offline: true } });
  assert.equal(reply.result.isError, false, text(reply));
  const snap = JSON.parse(text(reply));
  assert.deepEqual(snap.projects.map((p) => p.name), ['landing']);
  assert.deepEqual(fs.readdirSync(path.join(home, 'snapshots')).sort(), ['2026-03-13.json', '2026-03-14.json']);

  const bad = await s.request(2, 'tools/call', { name: 'devbrief_collect', arguments: { offline: 'yes' } });
  assert.equal(bad.result.isError, true);
});

test('devbrief_review says clearly when review.mjs is missing', { skip: fs.existsSync(reviewPath) && 'review.mjs is installed' }, async (t) => {
  const reply = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'devbrief_review', arguments: { days: 7 } } }, { home: tmpHome(t) });
  assert.equal(reply.result.isError, true);
  assert.match(reply.result.content[0].text, /not available/);
});

test('handleMessage: notifications and replies get no answer', async () => {
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.equal(await handleMessage({ jsonrpc: '2.0', id: 9, result: {} }), null);
  assert.equal((await handleMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).error.code, -32600);
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: null, method: 'ping' })).error.code, -32600);
  // A prototype key is not a method.
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 1, method: 'toString' })).error.code, -32601);
});

test('handleMessage: tool argument problems are tool errors the model can fix', async (t) => {
  const home = tmpHome(t);
  const call = (name, args) => handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, { home });
  const missing = await call('devbrief_project', { name: 'recipes-app' });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /Known: shop-api, old-prototype/);
  assert.equal((await call('devbrief_brief', { date: '../../secrets' })).result.isError, true);
  assert.equal((await call('devbrief_brief', { date: '2026-01-01' })).result.isError, true);
  assert.equal((await call('devbrief_review', { days: 0 })).result.isError, true);
  assert.equal((await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'devbrief_latest', arguments: [] } })).error.code, -32602);
});

test('negotiateVersion echoes a known version and offers the latest otherwise', () => {
  assert.equal(negotiateVersion('2024-11-05'), '2024-11-05');
  assert.equal(negotiateVersion('2099-01-01'), LEGACY_VERSIONS[0]);
  assert.equal(negotiateVersion(undefined), LEGACY_VERSIONS[0]);
  assert.ok(!LEGACY_VERSIONS.includes(MODERN_VERSIONS[0]));
});

test('capText leaves short text alone and marks a cut', () => {
  assert.equal(capText('abc', 10), 'abc');
  const cut = capText('x'.repeat(30), 10);
  assert.ok(cut.startsWith('x'.repeat(10) + '\n[truncated: 20 more characters'));
});

test('summarizeSnapshot, latestSnapshot and readBrief', (t) => {
  const home = tmpHome(t);
  assert.equal(latestSnapshot(home).date, '2026-03-14');
  const s = summarizeSnapshot({ date: '2026-03-14', projects: [{ name: 'pixel-quest' }] });
  assert.deepEqual(s.projects[0], { name: 'pixel-quest', severity: { high: 0, medium: 0, low: 0 }, nextStep: null, flags: [] });
  assert.equal(s.mode, 'local');
  assert.equal(s.changes, null);
  assert.equal(readBrief(undefined, home).date, '2026-03-14');
  assert.equal(readBrief('2026-03-13', home).markdown, '# devbrief · 2026-03-13\n');
  assert.equal(readBrief(undefined, path.join(home, 'nope')), null);
});
