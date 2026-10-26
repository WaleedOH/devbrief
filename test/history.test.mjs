import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadSnapshots, openItemCounts, openItemsOf, itemChanges } from '../skills/devbrief/scripts/lib/history.mjs';

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devbrief-history-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const project = (name, ...texts) => ({ name, statusDocs: [{ file: 'NEXT.md', items: texts.map((text) => ({ text })) }] });
const snap = (date, projects) => ({ version: 1, date, projects });

function writeSnap(dir, file, body) {
  fs.writeFileSync(path.join(dir, file), typeof body === 'string' ? body : JSON.stringify(body));
}

test('loadSnapshots reads dated files oldest first and skips everything else', (t) => {
  const dir = tmp(t);
  writeSnap(dir, '2026-10-22.json', snap('2026-10-22', [project('shop-api', 'a')]));
  writeSnap(dir, '2026-10-20.json', snap('2026-10-20', [project('shop-api', 'a', 'b')]));
  // BOM, as PowerShell writes it.
  writeSnap(dir, '2026-10-21.json', '﻿' + JSON.stringify(snap('2026-10-21', [])));
  writeSnap(dir, '2026-10-23.json', '{ not json');
  writeSnap(dir, '2026-10-24.json', 'null');
  writeSnap(dir, 'notes.json', snap('2026-10-25', []));
  writeSnap(dir, '2026-10-25.json.bak', snap('2026-10-25', []));
  fs.mkdirSync(path.join(dir, 'remote'));
  writeSnap(path.join(dir, 'remote'), '2026-10-22.json', snap('2026-10-22', [project('landing')]));

  const all = loadSnapshots(dir);
  assert.deepEqual(all.map((s) => s.date), ['2026-10-20', '2026-10-21', '2026-10-22']);
  assert.equal(all[0].projects[0].name, 'shop-api');
});

test('loadSnapshots filters by an inclusive date range and fills a missing date', (t) => {
  const dir = tmp(t);
  for (const d of ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21']) writeSnap(dir, `${d}.json`, { projects: [] });
  assert.deepEqual(loadSnapshots(dir, { since: '2026-10-19', until: '2026-10-20' }).map((s) => s.date), ['2026-10-19', '2026-10-20']);
  assert.deepEqual(loadSnapshots(dir, { since: new Date(2026, 9, 21) }).map((s) => s.date), ['2026-10-21']);
  assert.deepEqual(loadSnapshots(path.join(dir, 'missing')), []);
});

test('openItemCounts builds a per-project series and skips days without docs', () => {
  const series = openItemCounts([
    snap('2026-10-20', [project('shop-api', 'a', 'b', 'c'), project('landing', 'x')]),
    snap('2026-10-21', [project('shop-api', 'a', 'b'), { name: 'landing', git: { error: 'boom' } }]),
    snap('2026-10-22', [project('shop-api', 'a'), project('landing')]),
  ]);
  assert.deepEqual(series, {
    'shop-api': [{ date: '2026-10-20', open: 3 }, { date: '2026-10-21', open: 2 }, { date: '2026-10-22', open: 1 }],
    landing: [{ date: '2026-10-20', open: 1 }, { date: '2026-10-22', open: 0 }],
  });
});

test('openItemsOf joins every doc of a project', () => {
  const p = { statusDocs: [{ items: [{ text: 'a' }] }, { items: [{ text: 'b' }, { text: '' }] }] };
  assert.deepEqual(openItemsOf(p), ['a', 'b']);
  assert.equal(openItemsOf({ name: 'x' }), null);
});

test('itemChanges counts items that came and went inside the window', () => {
  const { closed, added } = itemChanges([
    ['write tests', 'fix login'],
    ['write tests', 'fix login', 'add search'],
    ['fix login', 'add search', 'try dark mode'],
    ['fix login', 'add search'],
  ]);
  assert.deepEqual(closed.sort(), ['try dark mode', 'write tests']);
  assert.deepEqual(added.sort(), ['add search', 'try dark mode']);
  assert.deepEqual(itemChanges([['a']]), { closed: [], added: [] });
});
