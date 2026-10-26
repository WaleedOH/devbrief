// Problems shared by two or more projects, so they can be fixed once and the
// same change applied everywhere (/devbrief fix-everywhere).
// Pure: no file or network access, so collect.mjs or a brief can import it.

// ci-failing is grouped by workflow name instead: two repos failing different
// workflows are not the same problem.
const SKIP_FLAGS = new Set(['ci-failing']);
const KIND_ORDER = ['advisor', 'ci', 'dependency', 'flag'];
const LEVEL_RANK = { ERROR: 3, WARN: 2, INFO: 1 };
const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };

// `outdated` may be npm's own object ({ name: { current, latest } }) or a list.
function outdatedList(p) {
  const o = p.outdated;
  if (Array.isArray(o)) return o.filter((d) => d?.name);
  if (o && typeof o === 'object') return Object.entries(o).map(([name, d]) => ({ name, ...(Array.isArray(d) ? d[0] : d) }));
  return [];
}

function worst(values, rank) {
  return values.reduce((best, v) => ((rank[v] || 0) > (rank[best] || 0) ? v : best), values[0]);
}

const list = (names) => (names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', '));

// Pure. `advisors` per project may come from the snapshot or be merged in by
// the caller from brief-extras: [{ name, level, title? }].
export function findPatterns(snapshot, { advisors = {} } = {}) {
  const groups = new Map();
  const add = (key, kind, project, info) => {
    if (!groups.has(key)) groups.set(key, { key, kind, members: new Map() });
    const g = groups.get(key);
    if (!g.members.has(project)) g.members.set(project, info);
  };

  for (const p of snapshot.projects || []) {
    for (const f of p.flags || []) {
      if (!SKIP_FLAGS.has(f.code)) add(`flag:${f.code}`, 'flag', p.name, { severity: f.severity, message: f.message });
    }
    for (const a of p.advisors || advisors[p.name] || []) {
      if (a?.name) add(`advisor:${a.name}`, 'advisor', p.name, { level: a.level, title: a.title });
    }
    const ci = p.github?.ci;
    if (ci?.conclusion === 'failure' && ci.workflowName) add(`ci:${ci.workflowName}`, 'ci', p.name, { url: ci.url });
    for (const d of outdatedList(p)) add(`dependency:${d.name}`, 'dependency', p.name, { current: d.current, latest: d.latest });
  }

  const patterns = [];
  for (const g of groups.values()) {
    if (g.members.size < 2) continue;
    const projects = [...g.members.keys()].sort();
    const infos = [...g.members.values()];
    const name = g.key.slice(g.key.indexOf(':') + 1);
    const pattern = { key: g.key, kind: g.kind, projects };
    if (g.kind === 'flag') {
      pattern.severity = worst(infos.map((i) => i.severity), SEVERITY_RANK);
      pattern.summary = `"${name}" in ${projects.length} projects (${list(projects)}): ${infos[0].message}`;
    } else if (g.kind === 'advisor') {
      pattern.level = worst(infos.map((i) => i.level), LEVEL_RANK);
      const title = infos.find((i) => i.title)?.title;
      pattern.summary = `Supabase advisor "${name}"${title ? ` (${title})` : ''} in ${list(projects)}`;
    } else if (g.kind === 'ci') {
      pattern.summary = `CI workflow "${name}" is failing in ${list(projects)}`;
    } else {
      const latest = infos.find((i) => i.latest)?.latest;
      pattern.summary = `${name} is out of date in ${list(projects)}${latest ? ` (latest ${latest})` : ''}`;
    }
    patterns.push(pattern);
  }
  return patterns.sort((a, b) => b.projects.length - a.projects.length
    || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.key.localeCompare(b.key));
}
