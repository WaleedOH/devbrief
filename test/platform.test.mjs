// Cross-platform edge cases: BOMs, file name case, symlinks, broken configs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  extractNextSteps, loadConfig, readStatusDocs, discoverProjects, homeRelative,
} from '../skills/devbrief/scripts/collect.mjs';

const collector = fileURLToPath(new URL('../skills/devbrief/scripts/collect.mjs', import.meta.url));
const BOM = '﻿';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'devbrief-platform-'));
}

test('a config saved with a BOM still loads', () => {
  const file = path.join(tempDir(), 'config.json');
  fs.writeFileSync(file, BOM + '{"exclude":["x"]}');
  const { config, found } = loadConfig(file);
  assert.equal(found, true);
  assert.deepEqual(config.exclude, ['x']);
});

test('a broken config is an error, not a silent fallback', () => {
  const file = path.join(tempDir(), 'config.json');
  fs.writeFileSync(file, '{ nope');
  assert.throws(() => loadConfig(file), /not valid JSON/);
  assert.equal(loadConfig(path.join(tempDir(), 'missing.json')).found, false);
});

test('a status doc with a BOM keeps its title', () => {
  assert.equal(extractNextSteps(BOM + '# Status\n## Next\n- a').title, 'Status');
});

test('status docs match names ignoring case and report the real name once', () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'Status.md'), '# S\n## Next\n- a');
  fs.writeFileSync(path.join(dir, 'docs', 'next.md'), '# N\n## Next\n- b');
  const docs = readStatusDocs(dir, ['STATUS.md', 'status.md', 'docs/NEXT.md'], 5);
  assert.deepEqual(docs.map((d) => d.file), ['Status.md', 'docs/next.md']);
});

test('discovery follows symlinked repos under a root', (t) => {
  const root = tempDir();
  const elsewhere = tempDir();
  fs.mkdirSync(path.join(elsewhere, 'linked', '.git'), { recursive: true });
  try {
    fs.symlinkSync(path.join(elsewhere, 'linked'), path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('cannot create symlinks here');
    return;
  }
  assert.deepEqual(discoverProjects({ roots: [root] }).map((p) => p.name), ['linked']);
});

test('homeRelative only shortens paths inside the home folder', () => {
  const home = os.homedir();
  assert.equal(homeRelative(path.join(home, 'code', 'app')), '~/code/app');
  assert.equal(homeRelative(path.join(home, '..foo')), '~/..foo');
  const outside = path.resolve(home, '..', 'someone-else');
  assert.equal(homeRelative(outside), outside);
});

test('the collector runs when started through a link to the skill', (t) => {
  const dir = tempDir();
  const link = path.join(dir, 'skill');
  try {
    fs.symlinkSync(path.dirname(path.dirname(collector)), link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('cannot create symlinks here');
    return;
  }
  const out = execFileSync(process.execPath, [path.join(link, 'scripts', 'collect.mjs'), '--help'], { encoding: 'utf8' });
  assert.match(out, /devbrief collector/);
});

test('the collector reports a broken config and exits 1', () => {
  const home = tempDir();
  fs.writeFileSync(path.join(home, 'config.json'), '{ nope');
  const r = spawnSync(process.execPath, [collector, '--no-fetch', '--no-save'], {
    encoding: 'utf8', env: { ...process.env, DEVBRIEF_HOME: home, DEVBRIEF_CONFIG: '' },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not valid JSON/);
});
