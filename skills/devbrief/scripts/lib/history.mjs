// Reads saved snapshots back so other commands can look at trends over time.
// No dependencies; shared by review and anything else that needs history.

import fs from 'node:fs';
import path from 'node:path';
import { stripBom, localDate } from '../collect.mjs';

const SNAPSHOT_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

const dayOf = (d) => (d instanceof Date ? localDate(d) : d);

// Snapshots in `snapDir` dated from `since` to `until` (both inclusive,
// "YYYY-MM-DD" or Date), oldest first. Only files named like a date count, so
// the remote/ subfolder, briefs and stray files are skipped, and a file that
// cannot be read or parsed is left out instead of failing the whole read.
export function loadSnapshots(snapDir, { since, until } = {}) {
  const from = dayOf(since);
  const to = dayOf(until);
  let names;
  try { names = fs.readdirSync(snapDir); } catch { return []; }
  const out = [];
  for (const name of names.sort()) {
    const date = name.match(SNAPSHOT_FILE)?.[1];
    if (!date || (from && date < from) || (to && date > to)) continue;
    let snap;
    try { snap = JSON.parse(stripBom(fs.readFileSync(path.join(snapDir, name), 'utf8'))); } catch { continue; }
    if (!snap || typeof snap !== 'object' || !Array.isArray(snap.projects)) continue;
    out.push({ ...snap, date: snap.date || date });
  }
  return out;
}

// The open status-doc items of one project in one snapshot, or null when the
// snapshot did not read its docs (for example git failed that day).
export function openItemsOf(project) {
  if (!project || !Array.isArray(project.statusDocs)) return null;
  return project.statusDocs.flatMap((d) => (d.items || []).map((i) => i.text).filter(Boolean));
}

// Per project, how many status-doc items were open on each snapshot date:
// { "shop-api": [{ date, open }, ...] }. Fewer open items over time means the
// project is getting closer to launch.
export function openItemCounts(snapshots) {
  const series = {};
  for (const snap of snapshots) {
    for (const p of snap.projects || []) {
      const items = openItemsOf(p);
      if (!p?.name || !items) continue;
      (series[p.name] ||= []).push({ date: snap.date, open: items.length });
    }
  }
  return series;
}

// Walks one project's item lists in date order and returns what was closed
// (gone by the end) and added (not there at the start) along the way. An item
// added and closed inside the window shows up in both.
export function itemChanges(lists) {
  const known = lists.filter(Boolean);
  if (known.length < 2) return { closed: [], added: [] };
  const start = new Set(known[0]);
  const end = new Set(known[known.length - 1]);
  const closed = new Set();
  const added = new Set();
  for (let i = 1; i < known.length; i++) {
    const before = new Set(known[i - 1]);
    const after = new Set(known[i]);
    for (const t of before) if (!after.has(t) && !end.has(t)) closed.add(t);
    for (const t of after) if (!before.has(t) && !start.has(t)) added.add(t);
  }
  return { closed: [...closed], added: [...added] };
}
