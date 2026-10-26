// The plugin packaging a marketplace install relies on: the manifest agrees
// with the marketplace entry and package.json, every ${CLAUDE_PLUGIN_ROOT}
// path exists, the icon meets the directory's rules, and the MCP server
// starts from the manifest's own command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
const manifest = readJson('.claude-plugin/plugin.json');
const marketplace = readJson('.claude-plugin/marketplace.json');
const pkg = readJson('package.json');

// What Claude Code does on install: ${CLAUDE_PLUGIN_ROOT} becomes the install path.
const resolveRoot = (s) => s.replaceAll('${CLAUDE_PLUGIN_ROOT}', root.replace(/\\/g, '/').replace(/\/$/, ''));

test('manifest, marketplace entry and package.json agree', () => {
  const entry = marketplace.plugins.find((p) => p.name === manifest.name);
  assert.ok(entry, `marketplace lists ${manifest.name}`);
  assert.equal(entry.source, './');
  assert.equal(manifest.version, pkg.version);
  assert.ok(manifest.author?.name);
});

test('every MCP server path under ${CLAUDE_PLUGIN_ROOT} exists', () => {
  const servers = Object.entries(manifest.mcpServers || {});
  assert.ok(servers.length);
  for (const [name, srv] of servers) {
    for (const arg of srv.args || []) {
      if (!arg.includes('${CLAUDE_PLUGIN_ROOT}')) continue;
      assert.ok(fs.existsSync(resolveRoot(arg)), `${name}: ${arg} exists`);
    }
  }
});

// The directory wants a square PNG or JPEG, 512 to 2048 px a side, under 2 MB.
test('icon is a square PNG of 512-2048 px under 2 MB inside the plugin', () => {
  assert.match(manifest.icon, /^\.\/[^.]/, 'icon is a ./ path with no ..');
  const file = path.resolve(root, manifest.icon);
  assert.ok(!path.relative(root, file).startsWith('..'), 'icon stays inside the plugin');
  const buf = fs.readFileSync(file);
  assert.ok(buf.length < 2 * 1024 * 1024, 'under 2 MB');
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  assert.equal(buf.toString('ascii', 12, 16), 'IHDR');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  assert.equal(width, height, 'square');
  assert.ok(width >= 512 && width <= 2048, `512-2048 px (got ${width})`);
});

test('the MCP server starts from the manifest command line and lists its tools', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrief-plugin-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const srv = manifest.mcpServers.devbrief;
  const command = srv.command === 'node' ? process.execPath : srv.command;
  const child = spawn(command, srv.args.map(resolveRoot), {
    env: { ...process.env, DEVBRIEF_HOME: home, CLAUDE_PLUGIN_ROOT: root },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => child.kill());
  const replies = new Map();
  let buffer = '';
  let wake = () => {};
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line.trim()) { const msg = JSON.parse(line); replies.set(msg.id, msg); }
    }
    wake();
  });
  const request = async (id, method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const deadline = Date.now() + 15000;
    while (!replies.has(id)) {
      assert.ok(Date.now() < deadline, `no reply to ${method}`);
      await new Promise((r) => { wake = r; setTimeout(r, 200); });
    }
    return replies.get(id);
  };
  const init = await request(1, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'plugin-test', version: '0' },
  });
  assert.equal(init.result.serverInfo.name, 'devbrief');
  assert.equal(init.result.serverInfo.version, manifest.version);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await request(2, 'tools/list', {});
  assert.ok(list.result.tools.some((tool) => tool.name === 'devbrief_latest'));
});
