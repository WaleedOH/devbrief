import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pullScript = fileURLToPath(new URL('../skills/devbrief/scripts/pull.mjs', import.meta.url));

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
}

function commit(dir, file, text) {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', `edit ${file}`);
}

// A bare origin, a "laptop" clone that pushes, and one clone per scenario.
function setup(names) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrief-pull-'));
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const laptop = path.join(root, 'laptop');
  git(root, 'clone', '-q', origin, laptop);
  git(laptop, 'checkout', '-q', '-b', 'main');
  commit(laptop, 'a.txt', 'one\n');
  git(laptop, 'push', '-q', '-u', 'origin', 'main');
  const clones = {};
  for (const name of names) {
    clones[name] = path.join(root, name);
    git(root, 'clone', '-q', origin, clones[name]);
  }
  const config = path.join(root, 'config.json');
  const projects = names.map((name) => ({ name, path: clones[name] }));
  fs.writeFileSync(config, JSON.stringify({ roots: [], projects }));
  const pushFromLaptop = (n = 1) => {
    for (let i = 0; i < n; i++) commit(laptop, 'a.txt', `change ${Date.now()} ${i}\n`);
    git(laptop, 'push', '-q');
  };
  return { root, origin, laptop, clones, config, pushFromLaptop };
}

function runPull(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [pullScript, ...args], { encoding: 'utf8', env: { ...process.env, ...env } },
      (err, stdout) => resolve({ code: err ? err.code : 0, lines: stdout.split('\n').filter(Boolean) }));
  });
}

const head = (dir) => git(dir, 'rev-parse', 'HEAD');

test('fast-forwards a clean clone that is behind', async () => {
  const s = setup(['work']);
  s.pushFromLaptop(3);
  const { code, lines } = await runPull(['--config', s.config]);
  assert.equal(code, 0);
  assert.deepEqual(lines, ['devbrief: pulled work (+3)']);
  assert.equal(head(s.clones.work), head(s.laptop));
});

test('leaves dirty and diverged clones alone and says why', async () => {
  const s = setup(['dirty', 'diverged', 'clean']);
  fs.writeFileSync(path.join(s.clones.dirty, 'a.txt'), 'local edit\n');
  commit(s.clones.diverged, 'b.txt', 'local commit\n');
  const before = { dirty: head(s.clones.dirty), diverged: head(s.clones.diverged) };
  s.pushFromLaptop(2);

  const { code, lines } = await runPull(['--config', s.config]);
  assert.equal(code, 0);
  assert.deepEqual(lines.sort(), [
    'devbrief: diverged has diverged (1 local, 2 on origin), not pulled',
    'devbrief: dirty is behind (+2) but has uncommitted changes, not pulled',
    'devbrief: pulled clean (+2)',
  ].sort());
  assert.equal(head(s.clones.dirty), before.dirty);
  assert.equal(head(s.clones.diverged), before.diverged);
  assert.equal(fs.readFileSync(path.join(s.clones.dirty, 'a.txt'), 'utf8'), 'local edit\n');
});

test('--dry-run reports but changes nothing', async () => {
  const s = setup(['work']);
  const before = head(s.clones.work);
  s.pushFromLaptop(1);
  const { lines } = await runPull(['--config', s.config, '--dry-run']);
  assert.deepEqual(lines, ['devbrief: would pull work (+1)']);
  assert.equal(head(s.clones.work), before);
});

test('--quiet prints nothing when there is nothing to pull; otherwise one summary line', async () => {
  const s = setup(['work', 'other']);
  assert.deepEqual((await runPull(['--config', s.config, '--quiet'])).lines, []);
  assert.deepEqual((await runPull(['--config', s.config])).lines, ['devbrief: 2 repo(s) checked, nothing to pull']);
});

test('--project limits the run and DEVBRIEF_CONFIG is honored', async () => {
  const s = setup(['one', 'two']);
  s.pushFromLaptop(1);
  const { lines } = await runPull(['--project', 'two'], { DEVBRIEF_CONFIG: s.config });
  assert.deepEqual(lines, ['devbrief: pulled two (+1)']);
  assert.notEqual(head(s.clones.one), head(s.laptop));
});

test('repos without an upstream are skipped silently', async () => {
  const s = setup(['work']);
  git(s.clones.work, 'checkout', '-q', '-b', 'local-only');
  assert.deepEqual((await runPull(['--config', s.config, '--quiet'])).lines, []);
});

test('a hanging fetch is cut off at the time cap and reported as skipped', async () => {
  const s = setup(['slow', 'fast']);
  // Local-path remotes run upload-pack through the shell, so this stalls the fetch.
  git(s.clones.slow, 'config', 'remote.origin.uploadpack', 'sleep 30; git-upload-pack');
  s.pushFromLaptop(1);
  const started = Date.now();
  const { code, lines } = await runPull(['--config', s.config, '--timeout', '3']);
  const took = Date.now() - started;
  assert.equal(code, 0);
  assert.ok(took < 15000, `took ${took}ms`);
  assert.deepEqual(lines.sort(), ['devbrief: pulled fast (+1)', 'devbrief: ran out of time, skipped slow']);
});

test('no projects is not an error', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrief-home-'));
  const env = { HOME: home, USERPROFILE: home };
  const missing = path.join(home, 'none.json');
  assert.deepEqual(await runPull(['--config', missing, '--quiet'], env), { code: 0, lines: [] });
  assert.deepEqual(await runPull(['--config', missing], env), { code: 0, lines: ['devbrief: no projects configured'] });
});
