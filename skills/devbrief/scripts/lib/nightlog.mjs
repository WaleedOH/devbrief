// Night shift log: one JSON file per night at <dir>/<date>.json saying what
// was attempted, what happened, and why anything stopped. Only node built-ins
// here, so collect.mjs can import it without a cycle.

import fs from 'node:fs';
import path from 'node:path';

export const RESULTS = ['opened', 'failed', 'skipped', 'stopped'];

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function logFile(dir, date) {
  if (!DATE.test(date || '')) throw new Error(`"${date}" is not a date like 2026-01-31.`);
  return path.join(dir, `${date}.json`);
}

// A missing log is an empty night, not an error.
export function readLog(dir, date) {
  let text;
  try { text = fs.readFileSync(logFile(dir, date), 'utf8'); } catch { return { date, entries: [] }; }
  const log = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  return { date, entries: Array.isArray(log.entries) ? log.entries : [] };
}

export function validateEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'the entry must be a JSON object';
  if (typeof entry.project !== 'string' || !entry.project) return 'the entry needs a "project"';
  if (!RESULTS.includes(entry.result)) return `"result" must be one of ${RESULTS.join(', ')}`;
  if (entry.result === 'opened' && !entry.pr) return 'an "opened" entry needs the "pr" URL';
  if (entry.result !== 'opened' && !entry.reason) return `a "${entry.result}" entry needs a "reason"`;
  return null;
}

export function appendLog(dir, date, entry, now = new Date()) {
  const problem = validateEntry(entry);
  if (problem) throw new Error(`Not logged: ${problem}.`);
  const log = readLog(dir, date);
  log.entries.push({ at: now.toISOString(), ...entry });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(logFile(dir, date), JSON.stringify(log, null, 2) + '\n');
  return log;
}

// The shape the morning brief reads: drafts to review and tasks that stopped.
export function summarizeLog(log) {
  const pick = (r, keys) => r.entries.filter((e) => keys.includes(e.result));
  const brief = (e) => ({ project: e.project, ...(e.title && { title: e.title }), ...(e.branch && { branch: e.branch }) });
  return {
    date: log.date,
    opened: pick(log, ['opened']).map((e) => ({ ...brief(e), pr: e.pr })),
    failed: pick(log, ['failed', 'stopped']).map((e) => ({ ...brief(e), reason: e.reason })),
    skipped: pick(log, ['skipped']).map((e) => ({ ...brief(e), reason: e.reason })),
  };
}

// A night shift that starts before midnight logs under yesterday's date, so
// the morning looks at today's log first, then yesterday's.
export function lastNightSummary(dir, today) {
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() - 1);
  const pad = (n) => String(n).padStart(2, '0');
  const yesterday = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  for (const date of [today, yesterday]) {
    const log = readLog(dir, date);
    if (log.entries.length) return summarizeLog(log);
  }
  return null;
}

export function formatSummary(summary) {
  if (!summary) return null;
  const n = summary.opened.length;
  const stopped = summary.failed.length;
  const parts = [];
  if (n) parts.push(`${n} draft PR${n === 1 ? '' : 's'} ready for review`);
  if (stopped) parts.push(`${stopped} task${stopped === 1 ? '' : 's'} stopped without a PR`);
  if (!parts.length) parts.push('nothing to do');
  return `Night shift: ${parts.join(', ')}`;
}
