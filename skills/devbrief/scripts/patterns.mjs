#!/usr/bin/env node
// devbrief patterns: problems shared by two or more projects, for
// /devbrief fix-everywhere. Reads only.
//
//   node patterns.mjs            patterns in today's snapshot, as JSON
//   node patterns.mjs --date d   another day's snapshot
//   node patterns.mjs --key k    one pattern only

import fs from 'node:fs';
import path from 'node:path';
import { dataDir, localDate, isMain, stripBom } from './collect.mjs';
import { readBriefExtras } from './nightshift.mjs';
import { findPatterns } from './lib/patterns.mjs';

function main() {
  const argv = process.argv.slice(2);
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  const date = opt('--date') || localDate();
  const home = dataDir();
  let snapshot;
  try { snapshot = JSON.parse(stripBom(fs.readFileSync(path.join(home, 'snapshots', `${date}.json`), 'utf8'))); } catch {
    throw new Error(`No snapshot for ${date}. Run node scripts/collect.mjs first.`);
  }
  let patterns = findPatterns(snapshot, { advisors: readBriefExtras(home, date) });
  const key = opt('--key');
  if (key) {
    patterns = patterns.filter((p) => p.key === key);
    if (!patterns.length) throw new Error(`No pattern "${key}" in the ${date} snapshot.`);
  }
  return JSON.stringify({ date, patterns }, null, 2);
}

if (isMain(import.meta.url)) {
  try { console.log(main()); } catch (e) { console.error(e.message); process.exit(1); }
}
