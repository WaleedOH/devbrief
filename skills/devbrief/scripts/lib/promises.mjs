// Promise tracking: how long each status-doc item has been open, which items
// were finished, and which status docs fell behind the commits. Pure functions
// over snapshot objects (oldest first), so they never touch the disk.

const DAY = 86400000;

// "**Add login** (see #12)." and "add login (see 12)" are the same promise.
export function normalizeItem(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Whole days between two YYYY-MM-DD dates (or ISO timestamps, by their date
// part), counted in UTC so a daylight-saving change never shifts the result.
export function dayDiff(from, to) {
  const utc = (d) => Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`);
  return Math.round((utc(to) - utc(from)) / DAY);
}

function todayString(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// The open items of one project in one snapshot, keyed by normalized text.
// Returns null when the project is missing or has no readable status doc:
// that day says nothing about the items, so it must not end a streak.
function openItems(snapshot, name) {
  const p = (snapshot?.projects || []).find((x) => x.name === name);
  if (!p?.statusDocs?.length) return null;
  const items = new Map();
  for (const doc of p.statusDocs) {
    for (const item of doc.items || []) {
      const key = normalizeItem(item.text);
      if (key && !items.has(key)) items.set(key, { ...item, file: doc.file });
    }
  }
  return items;
}

// Per project, every item open in the newest snapshot, with the date it was
// first seen in its current unbroken run and how many days that is.
export function itemAges(snapshots, { today } = {}) {
  const list = (snapshots || []).filter(Boolean);
  const newest = list[list.length - 1];
  if (!newest) return {};
  const asOf = today || newest.date || todayString();
  const out = {};
  for (const p of newest.projects || []) {
    const current = openItems(newest, p.name);
    if (!current) continue;
    out[p.name] = [...current].map(([key, item]) => {
      let firstSeen = newest.date;
      for (let i = list.length - 2; i >= 0; i--) {
        const items = openItems(list[i], p.name);
        if (!items) continue;
        if (!items.has(key)) break;
        firstSeen = list[i].date;
      }
      const age = { text: item.text, file: item.file };
      if (item.section) age.section = item.section;
      return { ...age, firstSeen, daysOpen: Math.max(0, dayDiff(firstSeen, asOf)) };
    });
  }
  return out;
}

// Per project, items seen in the last `days` days that are gone from the
// newest snapshot: moved to Done, struck through, or deleted.
export function closedSince(snapshots, days = 7) {
  const list = (snapshots || []).filter(Boolean);
  const newest = list[list.length - 1];
  if (!newest) return {};
  const out = {};
  for (const p of newest.projects || []) {
    const current = openItems(newest, p.name);
    if (!current) continue;
    const gone = new Map();
    for (const snap of list.slice(0, -1)) {
      if (dayDiff(snap.date, newest.date) > days) continue;
      for (const [key, item] of openItems(snap, p.name) || []) {
        if (current.has(key)) continue;
        const seen = gone.get(key);
        gone.set(key, { text: item.text, file: item.file, firstSeen: seen?.firstSeen || snap.date, lastSeen: snap.date });
      }
    }
    if (gone.size) out[p.name] = [...gone.values()];
  }
  return out;
}

// Projects whose newest status doc is more than `days` older than their last
// commit: work went on, the doc did not.
export function staleDocs(snapshot, { days = 7 } = {}) {
  const out = [];
  for (const p of snapshot?.projects || []) {
    const commit = p.git?.lastCommit?.date;
    const docs = (p.statusDocs || []).filter((d) => d.updated);
    if (!commit || !docs.length) continue;
    const doc = docs.reduce((a, b) => (b.updated > a.updated ? b : a));
    const behind = dayDiff(doc.updated, commit);
    if (behind > days) out.push({ name: p.name, file: doc.file, updated: doc.updated, lastCommit: commit.slice(0, 10), daysBehind: behind });
  }
  return out;
}

// Adds `promises` (the first `top` open items in doc order, with their age,
// leaving out ones newer than `minDays`) and `staleDoc` to
// each project of `snapshot`, plus a low "stale-doc" flag. `history` is the
// saved snapshots before this one, oldest first.
export function annotateSnapshot(snapshot, history = [], { top = 3, staleDays = 7, minDays = 1 } = {}) {
  const sameMode = (s) => (s?.mode || 'local') === (snapshot.mode || 'local') && s.date < snapshot.date;
  const ages = itemAges([...history.filter(sameMode), snapshot], { today: snapshot.date });
  const stale = new Map(staleDocs(snapshot, { days: staleDays }).map((s) => [s.name, s]));
  for (const p of snapshot.projects || []) {
    const open = (ages[p.name] || []).filter((i) => i.daysOpen >= minDays);
    if (open.length) p.promises = open.slice(0, top);
    const s = stale.get(p.name);
    if (s) {
      p.staleDoc = { file: s.file, updated: s.updated, daysBehind: s.daysBehind };
      p.flags = [...(p.flags || []), { severity: 'low', code: 'stale-doc', message: `${s.file} is ${s.daysBehind} days older than the last commit` }];
    }
  }
  return snapshot;
}
