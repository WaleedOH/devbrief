#!/usr/bin/env node
// devbrief MCP server: lets any MCP client (Claude Code, Claude Desktop, other
// agents) read devbrief snapshots and briefs. No dependencies, stdio only.
// Every tool is read-only: it never saves a snapshot, a brief or a config.
//
//   node server.mjs     speak MCP (newline-delimited JSON-RPC 2.0) on stdin/stdout
//
// It is dual-era: it answers the legacy `initialize` handshake (2025-11-25 and
// earlier) and the stateless per-request `_meta` style (2026-07-28 and later).
// stdout carries protocol messages only; anything else goes to stderr.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dataDir, isMain, latestSnapshotBefore, stripBom } from '../scripts/collect.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptsDir = path.join(here, '..', 'scripts');

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MAX_TEXT = 100 * 1024;
const CHILD_TIMEOUT = 120000;

const META = 'io.modelcontextprotocol/';
const ERR = {
  parse: -32700, invalidRequest: -32600, methodNotFound: -32601,
  invalidParams: -32602, internal: -32603, unsupportedVersion: -32022,
};

function serverVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(here, '..', '..', '..', 'package.json'), 'utf8')).version; } catch { return 'unknown'; }
}

export const SERVER_INFO = { name: 'devbrief', version: serverVersion() };

const INSTRUCTIONS = 'Read-only access to devbrief, a morning brief across all of the user\'s software projects. '
  + 'Start with devbrief_latest for a summary, then devbrief_project for one project in depth. '
  + 'devbrief_collect gathers fresh data and can take a minute.';

// If the client asks for a version we know, use it; otherwise offer our latest.
export function negotiateVersion(requested) {
  return LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSIONS[0];
}

export function capText(text, max = MAX_TEXT) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: ${text.length - max} more characters. Ask for one project to see the rest.]`;
}

// ---------- reading devbrief's saved files ----------

// '9999-12-31' sorts after every real date, so this finds the newest snapshot.
export function latestSnapshot(home = dataDir()) {
  return latestSnapshotBefore(path.join(home, 'snapshots'), '9999-12-31', 'local')
    || latestSnapshotBefore(path.join(home, 'snapshots', 'remote'), '9999-12-31', 'remote');
}

function topNextStep(p) {
  for (const doc of p.statusDocs || []) {
    if (doc.items?.length) return { text: doc.items[0].text, file: doc.file };
  }
  return null;
}

export function summarizeSnapshot(snap) {
  return {
    date: snap.date,
    generatedAt: snap.generatedAt,
    mode: snap.mode || 'local',
    projects: (snap.projects || []).map((p) => {
      const counts = { high: 0, medium: 0, low: 0 };
      for (const f of p.flags || []) if (f.severity in counts) counts[f.severity]++;
      return {
        name: p.name,
        ...(p.notes && { notes: p.notes }),
        severity: counts,
        nextStep: topNextStep(p),
        flags: (p.flags || []).map((f) => `${f.severity} ${f.code}: ${f.message}`),
      };
    }),
    changes: snap.changes ?? null,
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function readBrief(date, home = dataDir()) {
  const dir = path.join(home, 'briefs');
  if (!date) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => DATE.test(f.slice(0, -3)) && f.endsWith('.md')).sort(); } catch { /* no briefs yet */ }
    if (!files.length) return null;
    date = files.at(-1).slice(0, -3);
  }
  try { return { date, markdown: stripBom(fs.readFileSync(path.join(dir, `${date}.md`), 'utf8')) }; } catch { return null; }
}

function runNode(script, args, signal) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], {
      timeout: CHILD_TIMEOUT, signal, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, out: stdout });
      const reason = err.killed ? `timed out after ${CHILD_TIMEOUT / 1000}s`
        : String(stderr || err.message || 'failed').trim().split(/\r?\n/)[0];
      resolve({ ok: false, error: reason });
    });
  });
}

// ---------- tools ----------

const ok = (value) => ({ content: [{ type: 'text', text: capText(JSON.stringify(value)) }], isError: false });
const fail = (message) => ({ content: [{ type: 'text', text: message }], isError: true });
const NO_SNAPSHOT = 'No devbrief snapshot saved yet. Run /devbrief (or call devbrief_collect) first.';

function schema(properties = {}, required = []) {
  return { type: 'object', properties, ...(required.length && { required }), additionalProperties: false };
}

const TOOLS = [
  {
    name: 'devbrief_latest',
    title: 'Latest devbrief summary',
    description: 'Summary of the latest saved devbrief snapshot: per project, problem counts by severity, the top next step from its status doc, and its flags. Fast, reads a saved file.',
    inputSchema: schema(),
    run: async (_args, ctx) => {
      const snap = latestSnapshot(ctx.home);
      return snap ? ok(summarizeSnapshot(snap)) : fail(NO_SNAPSHOT);
    },
  },
  {
    name: 'devbrief_project',
    title: 'One project from the latest snapshot',
    description: 'Everything the latest saved snapshot has on one project: git, GitHub PRs, issues and CI, status-doc items and flags.',
    inputSchema: schema({ name: { type: 'string', description: 'Project name, as devbrief_latest lists it' } }, ['name']),
    run: async ({ name }, ctx) => {
      if (typeof name !== 'string' || !name) return fail('Give a project name, for example {"name": "shop-api"}.');
      const snap = latestSnapshot(ctx.home);
      if (!snap) return fail(NO_SNAPSHOT);
      const p = (snap.projects || []).find((x) => x.name === name);
      if (!p) return fail(`No project named "${name}" in the ${snap.date} snapshot. Known: ${(snap.projects || []).map((x) => x.name).join(', ') || 'none'}.`);
      return ok({ date: snap.date, project: p });
    },
  },
  {
    name: 'devbrief_collect',
    title: 'Collect fresh devbrief data',
    description: 'Runs the devbrief collector now and returns a fresh snapshot without saving it. Can take up to two minutes; use offline to skip git fetch.',
    inputSchema: schema({
      project: { type: 'string', description: 'Collect one project only' },
      offline: { type: 'boolean', description: 'Skip git fetch (faster, no network)' },
    }),
    run: async ({ project, offline }, ctx) => {
      if (project !== undefined && typeof project !== 'string') return fail('project must be a string.');
      if (offline !== undefined && typeof offline !== 'boolean') return fail('offline must be true or false.');
      const args = ['--no-save', ...(offline ? ['--no-fetch'] : []), ...(project ? ['--project', project] : [])];
      const r = await runNode(path.join(scriptsDir, 'collect.mjs'), args, ctx.signal);
      if (!r.ok) return fail(`The collector failed: ${r.error}`);
      try { return ok(JSON.parse(r.out)); } catch { return fail('The collector did not print valid JSON.'); }
    },
  },
  {
    name: 'devbrief_brief',
    title: 'A saved devbrief',
    description: 'The saved brief markdown for a date (YYYY-MM-DD), or the latest brief when no date is given.',
    inputSchema: schema({ date: { type: 'string', description: 'Date as YYYY-MM-DD', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } }),
    run: async ({ date }, ctx) => {
      if (date !== undefined && (typeof date !== 'string' || !DATE.test(date))) return fail('date must look like 2026-03-14.');
      const b = readBrief(date, ctx.home);
      if (!b) return fail(date ? `No brief saved for ${date}.` : 'No brief saved yet. Run /devbrief first.');
      return { content: [{ type: 'text', text: capText(b.markdown) }], isError: false };
    },
  },
  {
    name: 'devbrief_review',
    title: 'Review of recent work',
    description: 'What shipped across projects in the last N days (commits, closed status-doc items, totals), as JSON.',
    inputSchema: schema({ days: { type: 'integer', minimum: 1, maximum: 365, description: 'How many days back (default 7)' } }),
    run: async ({ days = 7 }, ctx) => {
      if (!Number.isInteger(days) || days < 1 || days > 365) return fail('days must be a whole number from 1 to 365.');
      const script = path.join(scriptsDir, 'review.mjs');
      if (!fs.existsSync(script)) return fail('Review is not available in this devbrief version (scripts/review.mjs is missing). Update devbrief.');
      const r = await runNode(script, ['--json', '--days', String(days)], ctx.signal);
      if (!r.ok) return fail(`The review failed: ${r.error}`);
      try { return ok(JSON.parse(r.out)); } catch { return fail('The review did not print valid JSON.'); }
    },
  },
];

export const TOOL_NAMES = TOOLS.map((t) => t.name);
const toolList = () => TOOLS.map(({ run, ...t }) => ({ ...t, annotations: { readOnlyHint: true, openWorldHint: false } }));

// ---------- JSON-RPC ----------

const errorReply = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data && { data }) } });
const result = (id, value) => ({
  jsonrpc: '2.0', id,
  result: { resultType: 'complete', ...value, _meta: { [`${META}serverInfo`]: SERVER_INFO } },
});

// Legacy clients send no per-request _meta, so it is only checked when present.
function checkMeta(params) {
  const meta = params?._meta;
  const version = meta?.[`${META}protocolVersion`];
  if (version === undefined) return null;
  const supported = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
  if (!supported.includes(version)) return [ERR.unsupportedVersion, 'Unsupported protocol version', { supported, requested: version }];
  if (MODERN_VERSIONS.includes(version) && typeof meta[`${META}clientCapabilities`] !== 'object') {
    return [ERR.invalidParams, `Missing _meta "${META}clientCapabilities"`];
  }
  return null;
}

const METHODS = {
  initialize: async (params) => ({
    protocolVersion: negotiateVersion(params?.protocolVersion),
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions: INSTRUCTIONS,
  }),
  'server/discover': async () => ({
    supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
    capabilities: { tools: {} },
    instructions: INSTRUCTIONS,
  }),
  ping: async () => ({}),
  'tools/list': async () => ({ tools: toolList() }),
  'tools/call': async (params, ctx) => {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) throw Object.assign(new Error(`Unknown tool: ${params?.name}`), { code: ERR.invalidParams });
    const args = params.arguments ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) throw Object.assign(new Error('arguments must be an object'), { code: ERR.invalidParams });
    return tool.run(args, ctx);
  },
};

// One parsed message in, one reply (or null for notifications) out.
export async function handleMessage(msg, ctx = {}) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return errorReply(null, ERR.invalidRequest, 'Expected one JSON-RPC message object (batches are not supported)');
  if (msg.method === undefined && ('result' in msg || 'error' in msg)) return null; // a reply to us; we send no requests
  const isNotification = !('id' in msg);
  if (isNotification) return null; // initialized, cancelled and the rest need no reply
  const id = msg.id;
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || !(typeof id === 'string' || typeof id === 'number')) {
    return errorReply(typeof id === 'string' || typeof id === 'number' ? id : null, ERR.invalidRequest, 'Invalid request');
  }
  const handler = Object.hasOwn(METHODS, msg.method) ? METHODS[msg.method] : null;
  if (!handler) return errorReply(id, ERR.methodNotFound, `Method not found: ${msg.method}`);
  if (msg.method !== 'initialize') {
    const bad = checkMeta(msg.params);
    if (bad) return errorReply(id, ...bad);
  }
  try {
    return result(id, await handler(msg.params, ctx));
  } catch (e) {
    if (e.code === ERR.invalidParams) return errorReply(id, e.code, e.message);
    console.error(`devbrief mcp: ${msg.method} failed: ${e.stack || e.message}`);
    return errorReply(id, ERR.internal, 'Internal error');
  }
}

export function serve({ input = process.stdin, output = process.stdout, home } = {}) {
  const inFlight = new Map();
  const send = (reply) => { if (reply) output.write(JSON.stringify(reply) + '\n'); };
  output.on?.('error', () => process.exit(0)); // the client went away
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send(errorReply(null, ERR.parse, 'Parse error: each line must be one JSON message')); }
    if (msg?.method === 'notifications/cancelled') {
      const key = JSON.stringify(msg.params?.requestId);
      inFlight.get(key)?.abort();
      inFlight.delete(key);
      return;
    }
    const key = JSON.stringify(msg?.id);
    const controller = new AbortController();
    if (msg?.id !== undefined) inFlight.set(key, controller);
    handleMessage(msg, { home, signal: controller.signal }).then((reply) => {
      // A cancelled request gets no reply at all.
      if (controller.signal.aborted) return;
      inFlight.delete(key);
      send(reply);
    });
  });
  return rl;
}

if (isMain(import.meta.url)) {
  serve();
  console.error(`devbrief MCP server ${SERVER_INFO.version} ready on stdio`);
}
