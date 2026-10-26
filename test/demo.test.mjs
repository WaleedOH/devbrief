// The demo ships hand-written sample output. These tests keep it honest: the
// files exist, they only talk about the fictional projects, and the brief
// follows the template in SKILL.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'devbrief');
const demoDir = path.join(skillDir, 'demo');
const FILES = ['brief.md', 'review.md', 'nightshift.md', 'post.md'];
const FICTIONAL = new Set(['shop-api', 'landing', 'pixel-quest', 'recipes-app', 'old-prototype', 'dotfiles']);

const read = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const section = (text, heading) => {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) return null;
  const rest = text.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return end < 0 ? rest : rest.slice(0, end);
};

// Every place the demo names a project, in any of the four formats.
function projectNames(text) {
  const names = [];
  const add = (re) => { for (const m of text.matchAll(re)) names.push(m[1]); };
  add(/^\d+\. \*\*([\w.-]+):/gm);                               // Do first: 1. **shop-api: ...
  add(/^- [🔴🟡🟢] \*\*([\w.-]+)\*\*/gmu);                        // Projects: - 🔴 **landing**
  add(/^- \*\*(?:FINISH|PUSH|PAUSE|KILL) ([\w.-]+)\*\*/gm);      // review verdicts
  add(/^\| ([\w.-]+) \| \d/gm);                                  // launch distance rows
  add(/^- ([a-z][\w.-]*): /gm);                                  // - recipes-app: ... (not "- New:")
  add(/^#{2,3} ([\w.-]+): /gm);                                  // ### shop-api: draft PR opened
  add(/^\d+\. \*\*([\w.-]+)\*\* \(/gm);                          // 1. **shop-api** (doc-auto, ...
  const used = text.match(/^Projects used: ([^.,]+)/m);           // post: Projects used: a and b
  if (used) names.push(...used[1].split(/,| and /).map((s) => s.trim()).filter(Boolean));
  return names;
}

test('demo files exist and the demo reference points at each of them', () => {
  const ref = read(path.join(skillDir, 'reference', 'demo.md'));
  for (const f of FILES) {
    assert.ok(fs.existsSync(path.join(demoDir, f)), `demo/${f} exists`);
    assert.ok(ref.includes(`demo/${f}`), `reference/demo.md mentions demo/${f}`);
  }
  assert.match(ref, /--init/);
  assert.match(ref, /github\.com\/WaleedOH\/devbrief/);
});

test('demo files only name the fictional projects', () => {
  for (const f of FILES) {
    const text = read(path.join(demoDir, f));
    const names = projectNames(text);
    assert.ok(names.length > 0, `${f} names at least one project`);
    for (const name of names) assert.ok(FICTIONAL.has(name), `${f}: "${name}" is not a fictional demo project`);

    for (const m of text.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+)/g)) {
      const [, owner, repo] = m;
      const ok = (owner === 'your-github-user' && FICTIONAL.has(repo)) || (owner === 'WaleedOH' && repo === 'devbrief');
      assert.ok(ok, `${f}: unexpected GitHub link ${m[0]}`);
    }
    assert.doesNotMatch(text, /[A-Za-z]:\\|\/Users\/|\/home\/|~\//, `${f} has no local paths`);
    assert.doesNotMatch(text, /[\w.+-]+@[\w-]+\.[\w.]+/, `${f} has no email addresses`);
  }
});

test('demo brief follows the brief template', () => {
  const brief = read(path.join(demoDir, 'brief.md'));
  const lines = brief.split('\n');
  assert.match(lines[0], /^# devbrief · \d{4}-\d{2}-\d{2}$/);
  assert.match(lines[1], /^Night shift: 2 draft PRs ready for review/);

  const doFirst = section(brief, 'Do first');
  assert.ok(doFirst, 'has a Do first section');
  const items = doFirst.split('\n').filter((l) => /^\d+\. /.test(l));
  assert.ok(items.length >= 1 && items.length <= 3, `Do first has 1 to 3 items, got ${items.length}`);
  items.forEach((l, i) => assert.match(l, new RegExp(`^${i + 1}\\. \\*\\*[\\w.-]+: .+\\.\\*\\* \\S`), `item ${i + 1} is "**project: action.** why"`));
  assert.match(items[0], /no remote|only on this laptop/, 'local-only work comes first');

  const projects = section(brief, 'Projects');
  assert.ok(projects, 'has a Projects section');
  const marks = [...projects.matchAll(/^- ([🔴🟡🟢])/gmu)].map((m) => m[1]);
  assert.ok(marks.length >= 3, 'one line per project');
  const rank = { '🔴': 0, '🟡': 1, '🟢': 2 };
  assert.deepEqual(marks, [...marks].sort((a, b) => rank[a] - rank[b]), 'red, then yellow, then green');
  assert.match(projects, /Quiet: /);
  assert.match(brief, /\(next for 6 days\)/);
  assert.ok(section(brief, 'Since last brief'), 'has a Since last brief section');
});

test('demo X thread posts fit in 280 characters', () => {
  const post = read(path.join(demoDir, 'post.md'));
  const posts = [...post.matchAll(/```\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  assert.ok(posts.length >= 3 && posts.length <= 6, '3 to 6 posts');
  for (const p of posts) assert.ok([...p].length <= 280, `post is ${[...p].length} characters`);
  assert.match(posts.at(-1), /Made with devbrief: https:\/\/github\.com\/WaleedOH\/devbrief/);
});
