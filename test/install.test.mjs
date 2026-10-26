import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote, hookCommand, sessionCommand, withHook, withoutHook, isOurHook } from '../install.mjs';

const installScript = fileURLToPath(new URL('../install.mjs', import.meta.url));

// Every path the installer could touch points into a fresh temp folder, so the
// real ~/.claude and ~/.devbrief are never read or written.
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrief-install-'));
  const env = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    DEVBRIEF_HOME: path.join(root, '.devbrief'),
    DEVBRIEF_CONFIG: '',
    CLAUDE_SKILLS_DIR: path.join(root, 'skills'),
    CLAUDE_SETTINGS_FILE: path.join(root, 'settings.json'),
  };
  const settings = env.CLAUDE_SETTINGS_FILE;
  const install = (...args) => spawnSync(process.execPath, [installScript, ...args], { env, encoding: 'utf8' });
  const read = () => JSON.parse(fs.readFileSync(settings, 'utf8'));
  return { root, env, settings, install, read };
}

const ourHooks = (s) => Object.values(s.hooks || {}).flat().flatMap((g) => g.hooks).filter(isOurHook);

test('--with-hook links the skill and adds the pull, session start and stop hooks, keeping other settings', () => {
  const s = sandbox();
  const original = {
    model: 'opus',
    permissions: { allow: ['Bash(git status)'] },
    hooks: {
      SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }],
    },
  };
  fs.writeFileSync(s.settings, JSON.stringify(original, null, 2));

  const r = s.install('--with-hook');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.lstatSync(path.join(s.root, 'skills', 'devbrief')).isSymbolicLink());

  const after = s.read();
  assert.equal(after.model, 'opus');
  assert.deepEqual(after.permissions, original.permissions);
  assert.deepEqual(after.hooks.SessionStart[0], original.hooks.SessionStart[0]);
  assert.deepEqual(after.hooks.SessionStart[1], {
    matcher: 'startup|resume',
    hooks: [{ type: 'command', command: hookCommand(), timeout: 30 }],
  });
  assert.deepEqual(after.hooks.SessionStart[2], {
    matcher: 'startup|resume|clear',
    hooks: [{ type: 'command', command: sessionCommand('start'), timeout: 10 }],
  });
  assert.deepEqual(after.hooks.Stop, [
    original.hooks.Stop[0],
    { hooks: [{ type: 'command', command: sessionCommand('stop'), timeout: 10 }] },
  ]);
  assert.match(sessionCommand('stop'), /session\.mjs" stop$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${s.settings}.devbrief.bak`, 'utf8')), original);
});

test('running --with-hook twice leaves exactly one of each hook', () => {
  const s = sandbox();
  assert.equal(s.install('--with-hook').status, 0);
  const once = fs.readFileSync(s.settings, 'utf8');
  const r = s.install('--with-hook');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /already/);
  assert.equal(fs.readFileSync(s.settings, 'utf8'), once);
  assert.equal(ourHooks(s.read()).length, 3);
});

test('--with-hook upgrades a 0.1 install that only had the pull hook', () => {
  const s = sandbox();
  const old = { hooks: { SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: hookCommand(), timeout: 30 }] }] } };
  fs.writeFileSync(s.settings, JSON.stringify(old));
  assert.equal(s.install('--with-hook').status, 0);
  const after = s.read();
  assert.equal(ourHooks(after).length, 3);
  assert.equal(after.hooks.SessionStart.length, 2);
  assert.equal(after.hooks.Stop.length, 1);
});

test('--remove-hook takes out only our hook and backs up first', () => {
  const s = sandbox();
  fs.writeFileSync(s.settings, JSON.stringify({ theme: 'dark' }));
  s.install('--with-hook');
  const withIt = fs.readFileSync(s.settings, 'utf8');
  const r = s.install('--remove-hook');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(s.read(), { theme: 'dark' });
  assert.equal(fs.readFileSync(`${s.settings}.devbrief.bak`, 'utf8'), withIt);
  assert.match(s.install('--remove-hook').stdout, /No devbrief hooks/);
});

test('--remove-hook keeps other Stop hooks', () => {
  const s = sandbox();
  const theirs = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo bye' }] }] } };
  fs.writeFileSync(s.settings, JSON.stringify(theirs));
  s.install('--with-hook');
  assert.equal(s.install('--remove-hook').status, 0);
  assert.deepEqual(s.read(), theirs);
});

test('invalid JSON is refused and left untouched', () => {
  const s = sandbox();
  const broken = '{ "model": "opus", }';
  fs.writeFileSync(s.settings, broken);
  for (const flag of ['--with-hook', '--remove-hook']) {
    const r = s.install(flag);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not valid JSON/);
    assert.equal(fs.readFileSync(s.settings, 'utf8'), broken);
  }
  assert.equal(fs.existsSync(`${s.settings}.devbrief.bak`), false);
});

test('a plain install does not touch settings', () => {
  const s = sandbox();
  const r = s.install();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(s.settings), false);
  assert.ok(fs.existsSync(path.join(s.root, '.devbrief', 'config.json')));
});

test('withoutHook drops only devbrief entries and empty groups', () => {
  const mine = { type: 'command', command: '"/n/node" "/x/devbrief/scripts/pull.mjs" --quiet' };
  const other = { type: 'command', command: 'echo hi' };
  const settings = { hooks: { SessionStart: [{ hooks: [mine, other] }, { matcher: 'resume', hooks: [mine] }] } };
  assert.deepEqual(withoutHook(settings), { hooks: { SessionStart: [{ hooks: [other] }] } });
  assert.deepEqual(withoutHook(withHook({})), {});
  const stop = { type: 'command', command: '"/n/node" "/x/devbrief/scripts/session.mjs" stop' };
  assert.deepEqual(withoutHook({ hooks: { Stop: [{ hooks: [stop, other] }] } }), { hooks: { Stop: [{ hooks: [other] }] } });
  assert.equal(isOurHook({ command: 'node /x/devbrief/notes.mjs' }), false);
});

test('shellQuote keeps paths with spaces in one argument', () => {
  assert.equal(shellQuote('C:\\Program Files\\nodejs\\node.exe', 'win32'), '"C:/Program Files/nodejs/node.exe"');
  assert.equal(shellQuote('/home/a b/$x`y"z', 'linux'), '"/home/a b/\\$x\\`y\\"z"');
});

test('the hook command runs under sh even with spaces in the path', { skip: !hasSh() }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrief space '));
  const script = path.join(dir, 'echo args.mjs');
  fs.writeFileSync(script, 'console.log(JSON.stringify(process.argv.slice(2)));');
  const out = execFileSync('sh', ['-c', hookCommand(process.execPath, script)], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out), ['--quiet']);
});

function hasSh() {
  return spawnSync('sh', ['-c', 'exit 0']).status === 0;
}
