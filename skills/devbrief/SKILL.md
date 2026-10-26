---
name: devbrief
description: Morning brief across all of the user's software projects. Collects git, GitHub (PRs, issues, CI), deploy and database health plus each repo's own status docs, then says what to do first. Also acts on the brief (do an item, night shift PRs), keeps status docs current (wrap), reviews the week, writes build-in-public posts, and delivers the brief by phone or voice. Use when the user runs /devbrief, asks for their dev brief or project status across repos, asks "what should I work on", "where are all my projects at", for a weekly review, or to wrap up a session. Not for calendar or email briefs.
---

# devbrief

Turn a snapshot of every project into a short brief that says what to do first.
The collector gathers facts; your job is to rank them and name the next action.

Arguments (all optional):
- a project name: brief that one project in depth
- `quick`: skip the Vercel and Supabase checks (step 2)
- `offline`: pass `--no-fetch` to the collector
- a time budget such as `40m` or `2h`, or a command from the table below

## Commands

The default (no command) is the brief described in steps 1 to 3. For any of
these, read the reference file from this skill's base directory and follow it
instead:

| Command | What it does | Read |
|---|---|---|
| `do <n>` | carry out item n of today's "Do first" | `reference/do.md` |
| `nightshift` | pick safe tasks and open draft PRs for them | `reference/nightshift.md` |
| `fix-everywhere` | one fix for a problem several projects share | `reference/patterns.md` |
| `wrap` | update the project's status doc at the end of a session | `reference/wrap.md` |
| `review` | weekly portfolio review: where time went, push/pause/kill | `reference/review.md` |
| `40m`, `2h`, … | today's brief, filtered to what fits the time | `reference/time.md` |
| `send`, `speak` | deliver the brief to the phone, Discord, or out loud | `reference/deliver.md` |
| `resume` | what you were doing on your other machine | `reference/resume.md` |
| `post` | turn the week's work into a build-in-public post | `reference/post.md` |

## 1. Collect

Run the collector from this skill's base directory:

```
node scripts/collect.mjs
```

Add `--project <name>` for one project, `--no-fetch` for offline. It prints a
JSON snapshot and saves it to `~/.devbrief/snapshots/<date>.json` (or under
`$DEVBRIEF_HOME`). The snapshot holds, per project: `git` (branch,
ahead/behind, uncommitted files, last commit), `github` (open PRs, issues,
latest CI run), `statusDocs` (open items pulled from files like
`LAUNCH-STATUS.md`, `docs/NEXT.md`), `flags` (pre-ranked problems), and at the
top level `changes` since the previous snapshot.

With `--remote` the collector reads GitHub only, with no local clones (for
cloud jobs; see docs/remote-mode.md). It covers the repos of each
`remote.owners` entry in the config plus any project with a `github` field.
Those snapshots have `mode: "remote"`, and each project has `source: "remote"`
and `repo` but no `path`, `uncommitted` or ahead/behind. So never say a remote
project is clean, pushed or in sync locally; say "local state not checked" if
it matters. A `repo-error` flag means GitHub could not be read for that repo.

If `configFile` is null, no config exists and projects were auto-discovered
from the home folder. Mention once at the end that `node scripts/collect.mjs
--init` writes `~/.devbrief/config.json` for excluding, renaming or adding
projects, and linking Vercel and Supabase.

## 2. Check deploys and databases

Skip this step for `quick`. For each project that has `vercel` or `supabase`
in the snapshot, use the matching MCP tools if they are available in this
session:

- Vercel (`projectId`, `teamId`): latest production deployment state, and
  runtime errors from the last 24 hours.
- Supabase (`projectRef`): security advisors. Several Supabase connectors may
  be installed; use the one that can see that project ref.

Advisors are noisy, so sort them before ranking:
- Real problems: any ERROR level; RLS disabled on a public table; a
  `SECURITY DEFINER` function callable by `anon` (not signed in). Exception:
  trigger functions (names like `handle_new_user` or `*_trigger`, or helpers
  like `rls_auto_enable`) cannot run through the API, so they are a 🟡
  one-line cleanup ("revoke execute from anon"), not 🔴. If unsure, say so.
- Expected in apps that call database functions directly: "signed-in users
  can execute SECURITY DEFINER function" and "RLS enabled, no policy" (tables
  only reached through functions). Report these as a count only, never as 🔴.
- Settings toggles such as leaked password protection: one 🟡 line.

Keep it to these calls. If a tool is missing or a call fails, write "not
checked" for that project. Never guess a deploy or database state.

After the Supabase checks, save what the advisors returned to
`~/.devbrief/brief-extras/<date>.json` (same base directory as snapshots), as
`{"date":"<date>","projects":{"<project>":{"advisors":[{"name":"<lint name>","level":"ERROR|WARN|INFO","title":"<title>","count":<n>}]}}}`.
Merge with the file if it exists. Lint names and levels only: no keys, URLs,
SQL or row data. The night shift and `fix-everywhere` read this file.

## 3. Write the brief

```
# devbrief · <date>
<night shift line, if any>

## Do first
1. **<project>: <concrete action>.** <one line on why: the fact behind it>
(at most 3 items)

## Projects
- 🔴 **<project>**: <the problem, then the next step>
- 🟡 **<project>**: ...
- 🟢 **<project>**: <next step from its status doc>

## Since last brief
<new and resolved problems from `changes`; omit the section if `changes` is null or empty>
```

How to rank and write:
- If the snapshot has `nightshift` with any `opened` or `failed` entries, the
  first line (above "Do first") is the headline from `node
  scripts/nightshift.mjs log --summary` (its `line` field), for example "Night
  shift: 3 draft PRs ready for review", then one line per PR (`- <project>:
  <title> (<pr url>)`) and one per stopped task with its reason. These are
  drafts for the user to review; never call them merged or done.
- 🔴 = any high flag, a failed production deploy, runtime errors or a real
  security problem (see step 2). 🟡 = a medium flag or a settings toggle.
  🟢 = healthy.
- A `local-only` flag means work that would be lost with this machine; it
  outranks everything except broken production.
- Each project may have `promises`: open status-doc items with `daysOpen`.
  When you quote a next step open 5 or more days, add its age: "Add login"
  (next for 6 days). An item open 14+ days on an active project earns a line
  in Do first only if nothing more urgent exists. If `staleDoc` is set, the
  doc lags the commits by `daysBehind` days: say "status doc may be out of
  date" and suggest `/devbrief wrap` in that repo. Never put `stale-doc` alone
  in Do first.
- "Do first" order: broken production, then failing CI or security, then
  being behind or unpushed on a project worked on in the last week, then the
  top status-doc item of the most active project. Housekeeping (stale, no
  status doc, a few uncommitted files) never goes in "Do first" unless there is
  risk of losing work, such as many uncommitted files on a repo with no remote.
- Each action is something the user can start right away: "Pull shop-api
  (3 commits behind)", not "check shop-api".
- The next step comes from the project's own status doc. Quote its wording,
  shortened, and do not invent tasks. With no doc, say so and use the last
  commit subject as context.
- Group quiet projects (🟢 with no status doc and no recent commits) into one
  line at the end of Projects.
- A project's `notes` field in the config is the user's own context (for
  example "superseded by v2" or "paused"). Respect it: a paused project gets
  one short line and never goes in "Do first".

Save the brief to `~/.devbrief/briefs/<date>.md` (same base directory as the
snapshots), then show it in the chat. If the config has
`"deliver": { "afterBrief": true }`, run `node scripts/deliver.mjs` after
saving and add its result lines to the reply.

For a single-project brief, skip the template and give: health, all open
status-doc items, open PRs and issues, and the recommended next step.
