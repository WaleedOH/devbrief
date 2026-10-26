// Resume reads real git from throwaway repos, but gh is fully faked: an
// in-memory "state repo" that checks shas the way the GitHub contents API does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  projectState, parseStatus, parseShortstat, diffSummary, hostFile, hintsFor, formatShow,
  runResume, writeFile, readHosts, stateHash, SETUP_HELP,
} from '../skills/devbrief/scripts/resume.mjs';
import { run } from '../skills/devbrief/scripts/deliver.mjs';

const REPO = 'you/devbrief-state';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrief-resume-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  const identity = ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false'];
  return execFileSync('git', [...identity, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function commit(dir, file, text, message = `edit ${file}`) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', message);
}

// origin + a clone with one pushed commit, one local-only commit, an edited
// tracked file and an untracked file.
function workRepo(root, name = 'shop-api') {
  const origin = path.join(root, `${name}.git`);
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const dir = path.join(root, name);
  git(root, 'clone', '-q', origin, dir);
  git(dir, 'checkout', '-q', '-b', 'main');
  commit(dir, 'src/cart.js', 'one\ntwo\n', 'Start the cart');
  git(dir, 'push', '-q', '-u', 'origin', 'main');
  commit(dir, 'src/totals.js', 'total\n', 'Add cart totals');
  fs.writeFileSync(path.join(dir, 'src/cart.js'), 'one\nTWO\nthree\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'scratch\n');
  return dir;
}

function fakeGh({ isPrivate = true } = {}) {
  const files = new Map();
  const calls = [];
  let n = 0;
  const state = { files, calls, conflictOnce: false };
  const repoPath = (url) => url.replace(/^repos\/[^/]+\/[^/]+\/contents\/?/, '');
  state.seed = (file, data) => files.set(file, { sha: `seed${++n}`, content: Buffer.from(JSON.stringify(data)).toString('base64') });
  state.read = (file) => JSON.parse(Buffer.from(files.get(file).content, 'base64').toString('utf8'));
  state.exec = async (cmd, args, opts = {}) => {
    if (cmd !== 'gh') return run(cmd, args, opts);
    calls.push({ args, input: opts.input });
    if (args[1] === '--method') {
      assert.deepEqual(args.slice(0, 3), ['api', '--method', 'PUT']);
      assert.deepEqual(args.slice(4), ['--input', '-']);
      const file = repoPath(args[3]);
      const body = JSON.parse(opts.input);
      const current = files.get(file);
      if (state.conflictOnce) { state.conflictOnce = false; files.set(file, { ...current, sha: `moved${++n}` }); return { ok: false, error: 'gh: is at moved but expected sha (HTTP 409)' }; }
      if (current && body.sha !== current.sha) return { ok: false, error: 'gh: sha does not match (HTTP 409)' };
      if (!current && body.sha) return { ok: false, error: 'gh: sha wasn\'t supplied (HTTP 422)' };
      files.set(file, { sha: `sha${++n}`, content: body.content, message: body.message });
      return { ok: true, out: '{}' };
    }
    const url = args[1];
    if (/^repos\/[^/]+\/[^/]+$/.test(url)) return url === `repos/${REPO}` ? { ok: true, out: JSON.stringify({ private: isPrivate }) } : { ok: false, error: 'gh: Not Found (HTTP 404)' };
    const p = repoPath(url);
    if (files.has(p)) return { ok: true, out: JSON.stringify({ sha: files.get(p).sha, encoding: 'base64', content: files.get(p).content }) };
    const children = [...files.keys()].filter((k) => k.startsWith(`${p}/`));
    if (children.length) return { ok: true, out: JSON.stringify(children.map((k) => ({ name: k.slice(p.length + 1), type: 'file' }))) };
    return { ok: false, error: 'gh: Not Found (HTTP 404)' };
  };
  return state;
}

function setup(t, resume = { repo: REPO, host: 'laptop-a' }, projects = []) {
  const home = tmp(t);
  const config = path.join(home, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ roots: [], projects, ...(resume && { resume }) }));
  return { home, env: { DEVBRIEF_CONFIG: config } };
}

const other = (host, projects, updatedAt = '2026-10-26T08:00:00.000Z') => ({ version: 1, host, updatedAt, projects });

test('projectState reports work in progress from a real repo, names only', async (t) => {
  const dir = workRepo(tmp(t));
  const s = await projectState({ name: 'shop-api', path: dir });
  assert.equal(s.branch, 'main');
  assert.equal(s.lastCommit.subject, 'Add cart totals');
  assert.match(s.lastCommit.date, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(s.uncommitted, 2);
  assert.equal(s.diffstat, '+2 -1 in 1 file(s), 1 untracked');
  assert.equal(s.localOnly, 1);
  assert.equal(s.ahead, 1);
  assert.equal(s.behind, 0);
  assert.match(s.head, /^[0-9a-f]{7,}$/);
  assert.deepEqual(s.recentFiles, ['src/cart.js', 'src/totals.js']);
  assert.ok(!JSON.stringify(s).includes(dir), 'no local paths in the state');
  assert.ok(!JSON.stringify(s).includes('TWO'), 'no file contents in the state');
});

test('projectState on a broken path is an error entry, not a crash', async (t) => {
  const s = await projectState({ name: 'old-prototype', path: path.join(tmp(t), 'gone') });
  assert.equal(s.name, 'old-prototype');
  assert.ok(s.error);
});

test('status, shortstat and host file parsing', () => {
  assert.deepEqual(parseStatus(' M a.js\0R  new.js\0old.js\0?? b.txt\0'), [
    { code: ' M', file: 'a.js' }, { code: 'R ', file: 'new.js' }, { code: '??', file: 'b.txt' },
  ]);
  assert.deepEqual(parseShortstat(' 3 files changed, 12 insertions(+), 1 deletion(-)'), { files: 3, insertions: 12, deletions: 1 });
  assert.deepEqual(parseShortstat(' 1 file changed, 2 deletions(-)'), { files: 1, insertions: 0, deletions: 2 });
  assert.equal(diffSummary({ files: 0, insertions: 0, deletions: 0 }, 0), '');
  assert.equal(hostFile('Laptop A.local'), 'hosts/laptop-a.local.json');
  assert.equal(hostFile('../../etc'), 'hosts/etc.json');
});

test('no repo configured: explain how to make one, call nothing', async (t) => {
  const { home, env } = setup(t, null);
  const gh = fakeGh();
  const r = await runResume(['publish'], { exec: gh.exec, env, home });
  assert.equal(r.code, 1);
  assert.deepEqual(r.lines, SETUP_HELP);
  assert.match(r.lines.join('\n'), /gh repo create you\/devbrief-state --private/);
  assert.equal(gh.calls.length, 0);
  const quiet = await runResume(['show', '--quiet'], { exec: gh.exec, env, home });
  assert.deepEqual(quiet, { code: 0, lines: [] });
});

test('a public or missing state repo is refused and never written', async (t) => {
  const { home, env } = setup(t);
  const pub = fakeGh({ isPrivate: false });
  const r = await runResume(['publish'], { exec: pub.exec, env, home });
  assert.equal(r.code, 1);
  assert.match(r.lines[0], /is public/);
  assert.equal(pub.files.size, 0);

  const { home: h2, env: e2 } = setup(t, { repo: 'you/missing-state' });
  const missing = await runResume(['publish'], { exec: fakeGh().exec, env: e2, home: h2 });
  assert.match(missing.lines[0], /Could not find you\/missing-state\. Create it with: gh repo create you\/missing-state --private/);
});

test('publish creates the host file, then updates it with its sha', async (t) => {
  const dir = workRepo(tmp(t));
  const { home, env } = setup(t, { repo: REPO, host: 'laptop-a' }, [{ name: 'shop-api', path: dir }]);
  const gh = fakeGh();
  const first = await runResume(['publish'], { exec: gh.exec, env, home, now: new Date('2026-10-26T09:00:00Z') });
  assert.equal(first.code, 0, first.lines.join('\n'));
  assert.match(first.lines[0], /Published 1 project\(s\) for laptop-a to you\/devbrief-state\/hosts\/laptop-a\.json/);
  const saved = gh.read('hosts/laptop-a.json');
  assert.equal(saved.host, 'laptop-a');
  assert.equal(saved.projects[0].localOnly, 1);
  const firstPut = JSON.parse(gh.calls.find((c) => c.args[1] === '--method').input);
  assert.equal(firstPut.sha, undefined);

  const sha = gh.files.get('hosts/laptop-a.json').sha;
  const second = await runResume(['publish'], { exec: gh.exec, env, home, now: new Date('2026-10-26T10:00:00Z') });
  assert.equal(second.code, 0);
  const puts = gh.calls.filter((c) => c.args[1] === '--method');
  assert.equal(JSON.parse(puts[1].input).sha, sha);
  assert.equal(gh.read('hosts/laptop-a.json').updatedAt, '2026-10-26T10:00:00.000Z');
});

test('publish --if-changed skips when only the time would change', async (t) => {
  const { home, env } = setup(t);
  const gh = fakeGh();
  await runResume(['publish', '--if-changed'], { exec: gh.exec, env, home, now: new Date('2026-10-26T09:00:00Z') });
  const skipped = await runResume(['publish', '--if-changed'], { exec: gh.exec, env, home, now: new Date('2026-10-26T09:30:00Z') });
  assert.match(skipped.lines[0], /Nothing changed/);
  assert.equal(gh.calls.filter((c) => c.args[1] === '--method').length, 1);
  assert.equal(stateHash(other('a', [], 'x')), stateHash(other('a', [], 'y')));
});

test('publish --min-minutes waits between uploads even when something changed', async (t) => {
  const dir = workRepo(tmp(t));
  const { home, env } = setup(t, { repo: REPO, host: 'laptop-a' }, [{ name: 'shop-api', path: dir }]);
  const gh = fakeGh();
  const at = (time) => ({ exec: gh.exec, env, home, now: new Date(`2026-10-26T${time}:00Z`) });
  await runResume(['publish', '--min-minutes', '15'], at('09:00'));
  fs.writeFileSync(path.join(dir, 'src/totals.js'), 'changed\n');
  const early = await runResume(['publish', '--if-changed', '--min-minutes', '15'], at('09:10'));
  assert.match(early.lines[0], /Published 10 min ago, so skipped/);
  const later = await runResume(['publish', '--if-changed', '--min-minutes', '15', '--quiet'], at('09:20'));
  assert.deepEqual(later, { code: 0, lines: [] });
  assert.equal(gh.calls.filter((c) => c.args[1] === '--method').length, 2);
});

test('writeFile retries once when another machine moved the sha', async () => {
  const gh = fakeGh();
  gh.seed('hosts/laptop-a.json', other('laptop-a', []));
  gh.conflictOnce = true;
  const r = await writeFile(REPO, 'hosts/laptop-a.json', other('laptop-a', [{ name: 'landing' }]), 'update', gh.exec);
  assert.deepEqual(r, { ok: true, created: false });
  assert.equal(gh.read('hosts/laptop-a.json').projects[0].name, 'landing');
});

test('show lists the other machines and what to do first, skipping this one', async (t) => {
  const { home, env } = setup(t, { repo: REPO, host: 'laptop-a' });
  const gh = fakeGh();
  gh.seed('hosts/laptop-a.json', other('laptop-a', [{ name: 'mine', branch: 'main' }]));
  gh.seed('hosts/desk-b.json', other('desk-b', [
    { name: 'shop-api', branch: 'feature/cart', head: 'abc1234', lastCommit: { subject: 'Add cart totals', date: '2026-10-26T07:00:00Z' }, uncommitted: 4, diffstat: '+30 -5 in 3 file(s), 1 untracked', localOnly: 2, ahead: 0, recentFiles: ['src/cart.js'] },
    { name: 'old-prototype', branch: 'main', lastCommit: { subject: 'old', date: '2025-01-01T00:00:00Z' }, uncommitted: 0, localOnly: 0 },
  ], '2026-10-26T07:30:00.000Z'));
  gh.seed('hosts/travel-c.json', other('travel-c', [
    { name: 'landing', branch: 'main', lastCommit: { subject: 'Hero copy', date: '2026-10-25T07:00:00Z' }, uncommitted: 0, localOnly: 0, ahead: 1 },
  ], '2026-10-25T08:00:00.000Z'));

  const r = await runResume(['show'], { exec: gh.exec, env, home, now: new Date('2026-10-26T09:30:00Z') });
  assert.equal(r.code, 0);
  const text = r.lines.join('\n');
  assert.ok(!text.includes('laptop-a'), 'this machine is not shown');
  assert.ok(text.indexOf('desk-b (updated 2 h ago)') < text.indexOf('travel-c (updated 26 h ago)'), text);
  assert.match(text, /shop-api on feature\/cart · "Add cart totals" \(2026-10-26\)/);
  assert.match(text, /4 uncommitted: \+30 -5 in 3 file\(s\), 1 untracked · 2 commit\(s\) on no remote/);
  assert.match(text, /recent: src\/cart\.js/);
  assert.match(text, /1 other project\(s\) quiet/);
  assert.match(text, /→ shop-api: push 2 commit\(s\) on desk-b first, they are on no remote/);
  assert.match(text, /→ landing: push 1 unpushed commit\(s\) on travel-c first/);

  const quiet = await runResume(['show', '--quiet'], { exec: gh.exec, env, home });
  assert.ok(quiet.lines.every((l) => l.startsWith('devbrief: ')));
  assert.equal(quiet.lines.length, 3);

  const json = JSON.parse((await runResume(['show', '--json'], { exec: gh.exec, env, home })).lines[0]);
  assert.deepEqual(json.hosts.map((h) => h.host), ['desk-b', 'travel-c']);
  assert.equal(json.hints.length, 3);
});

test('show with nobody published yet', async (t) => {
  const { home, env } = setup(t);
  const r = await runResume(['show'], { exec: fakeGh().exec, env, home });
  assert.match(r.lines[0], /No other machine has published yet/);
  assert.deepEqual(await readHosts(REPO, fakeGh().exec), { hosts: [], errors: [] });
});

test('hints compare branches and commits with this machine', () => {
  const here = { host: 'laptop-a', projects: [
    { name: 'shop-api', branch: 'main', head: 'aaa1111', lastCommit: { date: '2026-10-24T00:00:00Z' } },
    { name: 'landing', branch: 'main', head: 'bbb2222', lastCommit: { date: '2026-10-24T00:00:00Z' } },
  ] };
  const there = other('desk-b', [
    { name: 'shop-api', branch: 'main', head: 'ccc3333', lastCommit: { date: '2026-10-25T00:00:00Z' }, uncommitted: 0, localOnly: 0 },
    { name: 'landing', branch: 'redesign', head: 'ddd4444', uncommitted: 0, localOnly: 0 },
    { name: 'recipes-app', branch: 'main', uncommitted: 0, localOnly: 0 },
  ]);
  assert.deepEqual(hintsFor(there, here), [
    'shop-api: desk-b has newer commits (ccc3333); pull here (this machine is at aaa1111)',
    'landing: desk-b was on redesign, this machine is on main',
  ]);
  assert.deepEqual(formatShow({ hosts: [there], here, quiet: true }), [
    'devbrief: shop-api: desk-b has newer commits (ccc3333); pull here (this machine is at aaa1111)',
    'devbrief: landing: desk-b was on redesign, this machine is on main',
  ]);
});

test('missing gh is a clear error', async (t) => {
  const { home, env } = setup(t);
  const exec = async () => ({ ok: false, missing: true, error: 'gh is not installed' });
  await assert.rejects(runResume(['show'], { exec, env, home }), /needs the GitHub CLI/);
});
