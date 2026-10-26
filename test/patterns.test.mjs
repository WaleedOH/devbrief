import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPatterns } from '../skills/devbrief/scripts/lib/patterns.mjs';

const flag = (code, severity = 'low', message = code) => ({ code, severity, message });
const failing = (workflowName) => ({ ci: { conclusion: 'failure', workflowName } });

const snapshot = {
  date: '2026-03-04',
  projects: [
    { name: 'shop-api', flags: [flag('ci-failing', 'high'), flag('no-status-doc')], github: failing('test'),
      advisors: [{ name: 'function_search_path_mutable', level: 'WARN', title: 'Function search path mutable' }, { name: 'function_search_path_mutable', level: 'WARN' }],
      outdated: { lodash: { current: '4.17.20', latest: '4.17.21' } } },
    { name: 'landing', flags: [flag('ci-failing', 'high'), flag('no-status-doc')], github: failing('test'),
      outdated: [{ name: 'lodash', current: '4.17.19', latest: '4.17.21' }, { name: 'vite', current: '5.0.0', latest: '5.4.2' }] },
    { name: 'recipes-app', flags: [flag('ci-failing', 'high'), flag('uncommitted', 'medium', '30 uncommitted file(s)')], github: failing('lint') },
    { name: 'pixel-quest', flags: [flag('uncommitted', 'low', '2 uncommitted file(s)')] },
  ],
};

test('findPatterns groups problems shared by two or more projects', () => {
  const patterns = findPatterns(snapshot, { advisors: { 'recipes-app': [{ name: 'function_search_path_mutable', level: 'ERROR' }] } });
  assert.deepEqual(patterns.map((p) => [p.key, p.projects]), [
    ['advisor:function_search_path_mutable', ['recipes-app', 'shop-api']],
    ['ci:test', ['landing', 'shop-api']],
    ['dependency:lodash', ['landing', 'shop-api']],
    ['flag:no-status-doc', ['landing', 'shop-api']],
    ['flag:uncommitted', ['pixel-quest', 'recipes-app']],
  ]);
  const byKey = Object.fromEntries(patterns.map((p) => [p.key, p]));
  assert.equal(byKey['advisor:function_search_path_mutable'].level, 'ERROR', 'the worst level wins');
  assert.match(byKey['advisor:function_search_path_mutable'].summary, /Function search path mutable/);
  assert.equal(byKey['flag:uncommitted'].severity, 'medium');
  assert.equal(byKey['ci:test'].summary, 'CI workflow "test" is failing in landing, shop-api');
  assert.match(byKey['dependency:lodash'].summary, /latest 4\.17\.21/);
  assert.equal(byKey['dependency:vite'], undefined, 'one project is not a pattern');
  assert.equal(byKey['flag:ci-failing'], undefined, 'CI is grouped by workflow, not by the flag');
});

test('findPatterns handles an empty or sparse snapshot', () => {
  assert.deepEqual(findPatterns({}), []);
  assert.deepEqual(findPatterns({ projects: [{ name: 'a' }, { name: 'b', flags: [] }] }), []);
});

test('patterns are sorted by how many projects they hit', () => {
  const many = { projects: ['a', 'b', 'c'].map((name) => ({ name, flags: [flag('stale')] }))
    .concat([{ name: 'd', advisors: [{ name: 'x' }] }, { name: 'e', advisors: [{ name: 'x' }] }]) };
  const patterns = findPatterns(many);
  assert.deepEqual(patterns.map((p) => p.key), ['flag:stale', 'advisor:x']);
  assert.match(patterns[0].summary, /"stale" in 3 projects \(a, b, c\)/);
});

test('CLI: patterns.mjs reads the snapshot and brief extras, and --key filters', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrief-patterns-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, 'snapshots'));
  fs.mkdirSync(path.join(home, 'brief-extras'));
  fs.writeFileSync(path.join(home, 'snapshots', '2026-03-04.json'), JSON.stringify(snapshot));
  fs.writeFileSync(path.join(home, 'brief-extras', '2026-03-04.json'),
    JSON.stringify({ projects: { landing: { advisors: [{ name: 'function_search_path_mutable', level: 'WARN' }] } } }));
  const script = fileURLToPath(new URL('../skills/devbrief/scripts/patterns.mjs', import.meta.url));
  const run = (args) => new Promise((resolve) => execFile(process.execPath, [script, ...args], { env: { ...process.env, DEVBRIEF_HOME: home } },
    (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));
  const r = await run(['--date', '2026-03-04', '--key', 'advisor:function_search_path_mutable']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).patterns[0].projects, ['landing', 'shop-api']);
  const missing = await run(['--date', '2026-01-01']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /No snapshot for 2026-01-01/);
});
