import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordStart, checkStop, pruneSessions, optedOut } from '../skills/devbrief/scripts/session.mjs';

const sessionScript = fileURLToPath(new URL('../skills/devbrief/scripts/session.mjs', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
}

function commit(dir, file, text = `${Date.now()} ${Math.random()}\n`) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', `edit ${file}`);
}

// A repo named shop-api with one commit and a STATUS.md, plus a devbrief home.
function setup({ statusDoc = 'STATUS.md' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrief-session-'));
  const repo = path.join(root, 'shop-api');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  commit(repo, 'app.js', 'one\n');
  if (statusDoc) commit(repo, statusDoc, '# shop-api\n\n## Next\n- [ ] Add login\n');
  const home = path.join(root, '.devbrief');
  return { root, repo, home };
}

const input = (repo, extra = {}) => ({ session_id: 'abc123', cwd: repo, hook_event_name: 'SessionStart', source: 'startup', ...extra });
const stopInput = (extra = {}) => ({ session_id: 'abc123', hook_event_name: 'Stop', stop_hook_active: false, ...extra });

test('start records the repo and HEAD, and does nothing outside a repo', () => {
  const s = setup();
  const sub = path.join(s.repo, 'src');
  fs.mkdirSync(sub);
  const rec = recordStart(input(sub), { home: s.home });
  assert.equal(fs.realpathSync.native(rec.repoRoot).toLowerCase(), fs.realpathSync.native(s.repo).toLowerCase());
  assert.equal(rec.head, git(s.repo, 'rev-parse', 'HEAD'));
  assert.ok(fs.existsSync(path.join(s.home, 'sessions', 'abc123.json')));

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrief-norepo-'));
  assert.equal(recordStart(input(outside, { session_id: 'xyz' }), { home: s.home }), null);
  assert.equal(fs.existsSync(path.join(s.home, 'sessions', 'xyz.json')), false);
});

test('resume keeps the first record so earlier commits still count', () => {
  const s = setup();
  const first = recordStart(input(s.repo), { home: s.home });
  commit(s.repo, 'app.js');
  const again = recordStart(input(s.repo, { source: 'resume' }), { home: s.home });
  assert.equal(again.head, first.head);
});

test('stop nudges once when commits skipped the status doc', () => {
  const s = setup();
  recordStart(input(s.repo), { home: s.home });
  assert.equal(checkStop(stopInput(), { home: s.home }), null, 'no commits yet');
  commit(s.repo, 'app.js');
  commit(s.repo, 'cart.js');
  const reason = checkStop(stopInput(), { home: s.home });
  assert.equal(reason, "devbrief: you made 2 commits this session but STATUS.md wasn't updated. Run /devbrief wrap (or say skip).");
  assert.equal(checkStop(stopInput(), { home: s.home }), null, 'only once per session');
});

test('stop stays quiet when the status doc was committed or is being edited', () => {
  const s = setup({ statusDoc: 'docs/NEXT.md' });
  recordStart(input(s.repo), { home: s.home });
  commit(s.repo, 'app.js');
  fs.appendFileSync(path.join(s.repo, 'docs', 'NEXT.md'), '- [ ] Add search\n');
  assert.equal(checkStop(stopInput(), { home: s.home }), null);
  git(s.repo, 'checkout', '--', 'docs/NEXT.md');
  commit(s.repo, 'docs/NEXT.md', '# shop-api\n\n## Next\n- [ ] Add search\n');
  assert.equal(checkStop(stopInput(), { home: s.home }), null);
});

test('stop offers to start STATUS.md when the repo has none', () => {
  const s = setup({ statusDoc: null });
  recordStart(input(s.repo), { home: s.home });
  commit(s.repo, 'app.js');
  assert.match(checkStop(stopInput(), { home: s.home }), /made 1 commit this session and this repo has no status doc yet\. Run \/devbrief wrap to start STATUS\.md/);
});

test('stop respects stop_hook_active, background work, and opt-outs', () => {
  const s = setup();
  recordStart(input(s.repo), { home: s.home });
  commit(s.repo, 'app.js');
  assert.equal(checkStop(stopInput({ stop_hook_active: true }), { home: s.home }), null);
  assert.equal(checkStop(stopInput({ background_tasks: [{ id: 't1', type: 'shell' }] }), { home: s.home }), null);
  assert.equal(checkStop(stopInput(), { home: s.home, config: { wrap: { nudge: false } } }), null);
  const paused = { projects: [{ name: 'shop-api', path: s.repo, notes: 'paused until spring' }] };
  assert.equal(checkStop(stopInput(), { home: s.home, config: paused }), null);
  const off = { projects: [{ name: 'shop-api', path: s.repo, wrap: { nudge: false } }] };
  assert.equal(checkStop(stopInput(), { home: s.home, config: off }), null);
  // None of those counted as the one nudge.
  assert.match(checkStop(stopInput(), { home: s.home }), /1 commit this session/);
});

test('optedOut reads config and project notes', () => {
  assert.equal(optedOut({}, null), null);
  assert.equal(optedOut({}, { notes: 'main project, ship by Friday' }), null);
  assert.match(optedOut({}, { notes: 'Superseded by recipes-app' }), /notes/);
  assert.match(optedOut({ wrap: { nudge: false } }, null), /config/);
});

test('a per-project statusDocs list decides which files count', () => {
  const s = setup({ statusDoc: 'PLAN.md' });
  recordStart(input(s.repo), { home: s.home });
  commit(s.repo, 'PLAN.md', '# plan\n');
  const config = { projects: [{ name: 'shop-api', path: s.repo, statusDocs: ['PLAN.md'] }] };
  assert.equal(checkStop(stopInput(), { home: s.home, config }), null);
});

test('prune drops session files older than 14 days', () => {
  const s = setup();
  const dir = path.join(s.home, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const old = path.join(dir, 'old.json');
  const fresh = path.join(dir, 'fresh.json');
  fs.writeFileSync(old, '{}');
  fs.writeFileSync(fresh, '{}');
  const past = new Date(Date.now() - 20 * 86400000);
  fs.utimesSync(old, past, past);
  assert.equal(pruneSessions(s.home), 1);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(fresh), true);
});

function hook(mode, payload, env) {
  return spawnSync(process.execPath, [sessionScript, mode], { input: payload, env, encoding: 'utf8' });
}

test('the CLI prints the Stop block JSON once, and is silent and exit 0 otherwise', () => {
  const s = setup();
  const env = { ...process.env, DEVBRIEF_HOME: s.home, DEVBRIEF_CONFIG: path.join(s.root, 'none.json') };
  const start = hook('start', JSON.stringify(input(s.repo)), env);
  assert.equal(start.status, 0);
  assert.equal(start.stdout, '');
  commit(s.repo, 'app.js');

  const first = hook('stop', JSON.stringify(stopInput({ cwd: s.repo })), env);
  assert.equal(first.status, 0);
  const out = JSON.parse(first.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /^devbrief: you made 1 commit this session but STATUS\.md wasn't updated/);
  assert.equal(hook('stop', JSON.stringify(stopInput()), env).stdout, '');

  for (const [mode, payload] of [['stop', 'not json'], ['start', ''], ['nope', '{}'], ['stop', '{"session_id":"unknown"}']]) {
    const r = hook(mode, payload, env);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});

test('a broken config never fails the Stop hook', () => {
  const s = setup();
  const config = path.join(s.root, 'config.json');
  fs.writeFileSync(config, '{ broken');
  const env = { ...process.env, DEVBRIEF_HOME: s.home, DEVBRIEF_CONFIG: config };
  hook('start', JSON.stringify(input(s.repo)), env);
  commit(s.repo, 'app.js');
  const r = hook('stop', JSON.stringify(stopInput()), env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
