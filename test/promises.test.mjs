import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeItem, dayDiff, itemAges, closedSince, staleDocs, annotateSnapshot,
} from '../skills/devbrief/scripts/lib/promises.mjs';

// One snapshot: projects maps a name to its open items (strings, or
// { text, section }) in a STATUS.md, or to null for "no status doc".
function snap(date, projects, extra = {}) {
  return {
    date,
    ...extra,
    projects: Object.entries(projects).map(([name, items]) => ({
      name,
      git: {},
      statusDocs: items === null ? [] : [{
        file: 'STATUS.md',
        updated: date,
        title: name,
        items: items.map((i) => (typeof i === 'string' ? { text: i, section: 'Next' } : i)),
      }],
    })),
  };
}

test('normalizeItem ignores case, markdown, links and punctuation', () => {
  assert.equal(normalizeItem('**Add login** (see [#12](https://example.com/12)).'), 'add login see 12');
  assert.equal(normalizeItem('  add   LOGIN, see 12 '), 'add login see 12');
  assert.equal(normalizeItem('`npm run build` → fix'), 'npm run build fix');
  assert.equal(normalizeItem('Café menü'), 'café menü');
  assert.equal(normalizeItem(''), '');
});

test('dayDiff counts calendar days and accepts ISO timestamps', () => {
  assert.equal(dayDiff('2026-10-20', '2026-10-26'), 6);
  assert.equal(dayDiff('2026-03-28', '2026-03-30'), 2);
  assert.equal(dayDiff('2026-10-01', '2026-10-09T23:59:00+02:00'), 8);
  assert.equal(dayDiff('2026-10-26', '2026-10-20'), -6);
});

test('itemAges dates an item from the start of its current run', () => {
  const history = [
    snap('2026-10-18', { 'shop-api': ['Add login'] }),
    snap('2026-10-19', { 'shop-api': ['Fix cart'] }),
    snap('2026-10-20', { 'shop-api': ['Add login', 'Fix cart'] }),
    snap('2026-10-23', { 'shop-api': ['**Add login**', 'Fix cart.', 'Write docs'] }),
    snap('2026-10-26', { 'shop-api': ['add login', 'fix cart', 'Write docs', 'Ship it'] }),
  ];
  const ages = itemAges(history, { today: '2026-10-26' });
  assert.deepEqual(ages['shop-api'], [
    { text: 'add login', file: 'STATUS.md', section: 'Next', firstSeen: '2026-10-20', daysOpen: 6 },
    { text: 'fix cart', file: 'STATUS.md', section: 'Next', firstSeen: '2026-10-19', daysOpen: 7 },
    { text: 'Write docs', file: 'STATUS.md', section: 'Next', firstSeen: '2026-10-23', daysOpen: 3 },
    { text: 'Ship it', file: 'STATUS.md', section: 'Next', firstSeen: '2026-10-26', daysOpen: 0 },
  ]);
});

test('itemAges skips days the project or its doc was missing instead of resetting', () => {
  const history = [
    snap('2026-10-10', { landing: ['Pick a font'] }),
    snap('2026-10-12', { 'shop-api': ['Add login'] }),
    snap('2026-10-14', { landing: null }),
    snap('2026-10-16', { landing: ['Pick a font'] }),
  ];
  assert.deepEqual(itemAges(history, { today: '2026-10-17' }).landing, [
    { text: 'Pick a font', file: 'STATUS.md', section: 'Next', firstSeen: '2026-10-10', daysOpen: 7 },
  ]);
});

test('itemAges matches items across status docs and defaults today to the newest snapshot', () => {
  const two = (date, a, b) => ({
    date,
    projects: [{ name: 'pixel-quest', statusDocs: [
      { file: 'NEXT.md', updated: date, items: a.map((text) => ({ text })) },
      { file: 'docs/TODO.md', updated: date, items: b.map((text) => ({ text })) },
    ] }],
  });
  const ages = itemAges([
    two('2026-10-01', ['Boss fight'], []),
    two('2026-10-05', [], ['Boss fight!', 'Sound pass']),
  ]);
  assert.deepEqual(ages['pixel-quest'], [
    { text: 'Boss fight!', file: 'docs/TODO.md', firstSeen: '2026-10-01', daysOpen: 4 },
    { text: 'Sound pass', file: 'docs/TODO.md', firstSeen: '2026-10-05', daysOpen: 0 },
  ]);
});

test('itemAges handles empty input and projects with no doc', () => {
  assert.deepEqual(itemAges([]), {});
  assert.deepEqual(itemAges(undefined), {});
  assert.deepEqual(itemAges([snap('2026-10-01', { 'old-prototype': null })]), {});
  assert.deepEqual(itemAges([snap('2026-10-01', { recipes: [] })]), { recipes: [] });
});

test('closedSince lists items that dropped off within the window', () => {
  const history = [
    snap('2026-10-01', { 'shop-api': ['Old thing'] }),
    snap('2026-10-20', { 'shop-api': ['Add login', 'Fix cart'], landing: ['Pick a font'] }),
    snap('2026-10-23', { 'shop-api': ['Add login', 'Fix cart', 'Hotfix'], landing: ['Pick a font'] }),
    snap('2026-10-26', { 'shop-api': ['Add login.'], landing: null }),
  ];
  assert.deepEqual(closedSince(history, 7), {
    'shop-api': [
      { text: 'Fix cart', file: 'STATUS.md', firstSeen: '2026-10-20', lastSeen: '2026-10-23' },
      { text: 'Hotfix', file: 'STATUS.md', firstSeen: '2026-10-23', lastSeen: '2026-10-23' },
    ],
  });
  // A wider window reaches the old item too; a project whose doc vanished is skipped.
  assert.equal(closedSince(history, 30)['shop-api'].length, 3);
  assert.equal(closedSince(history, 30).landing, undefined);
  assert.deepEqual(closedSince([]), {});
});

test('staleDocs flags docs that fell more than N days behind the commits', () => {
  const project = (name, updated, commit) => ({
    name,
    git: commit ? { lastCommit: { date: commit, subject: 'x', daysAgo: 0 } } : {},
    statusDocs: updated ? [{ file: 'STATUS.md', updated, items: [] }, { file: 'docs/NEXT.md', updated: '2026-09-01', items: [] }] : [],
  });
  const snapshot = {
    date: '2026-10-26',
    projects: [
      project('shop-api', '2026-10-10', '2026-10-25T18:00:00+02:00'),
      project('landing', '2026-10-20', '2026-10-25T09:00:00Z'),
      project('pixel-quest', '2026-10-18', '2026-10-25T09:00:00Z'),
      project('recipes-app', null, '2026-10-25T09:00:00Z'),
      project('old-prototype', '2026-01-01', null),
      { name: 'remote-one', git: { lastCommit: { date: '2026-10-25T00:00:00Z' } }, statusDocs: [{ file: 'STATUS.md', items: [] }] },
    ],
  };
  assert.deepEqual(staleDocs(snapshot), [
    { name: 'shop-api', file: 'STATUS.md', updated: '2026-10-10', lastCommit: '2026-10-25', daysBehind: 15 },
  ]);
  assert.deepEqual(staleDocs(snapshot, { days: 5 }).map((s) => s.name), ['shop-api', 'pixel-quest']);
  assert.deepEqual(staleDocs({}), []);
});

test('annotateSnapshot adds promises, staleDoc and a stale-doc flag', () => {
  const history = [
    snap('2026-10-18', { 'shop-api': ['Add login', 'Fix cart'] }),
    snap('2026-10-20', { 'shop-api': ['Add login', 'Fix cart'] }, { mode: 'remote' }),
    snap('2026-10-26', { 'shop-api': ['Never saved'] }),
  ];
  const today = snap('2026-10-26', { 'shop-api': ['Add login', 'Fix cart', 'New today'], landing: ['Pick a font'] });
  today.projects[0].flags = [{ severity: 'medium', code: 'behind', message: '1 behind' }];
  today.projects[0].statusDocs[0].updated = '2026-10-01';
  today.projects[0].git = { lastCommit: { date: '2026-10-25T10:00:00Z' } };

  annotateSnapshot(today, history);
  const [shop, landing] = today.projects;
  assert.deepEqual(shop.promises.map((p) => [p.text, p.daysOpen]), [['Add login', 8], ['Fix cart', 8]]);
  assert.deepEqual(shop.staleDoc, { file: 'STATUS.md', updated: '2026-10-01', daysBehind: 24 });
  assert.deepEqual(shop.flags.map((f) => f.code), ['behind', 'stale-doc']);
  assert.equal(landing.promises, undefined, 'items seen only today are not promises yet');
  assert.equal(landing.staleDoc, undefined);
});
