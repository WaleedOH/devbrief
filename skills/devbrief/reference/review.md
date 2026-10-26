# /devbrief review

A weekly review, written like a portfolio manager would: where the week's
attention went, which projects moved closer to launch, and the one project to
focus on next week.

Arguments (all optional): a number of days (`review 14`, default 7), or a
project name for a single-project review.

## 1. Collect the week

Run from this skill's base directory:

```
node scripts/review.mjs --json
```

Add `--days <n>` for another window and `--project <name>` for one project.
It prints JSON:

```
{ version: 1, from, to, days,
  projects: [{ name, notes?, commits: [{date, subject}], activeDays,
               linesAdded, linesRemoved, itemsClosed: [text], itemsAdded: [text],
               openItems: { start, end }, github?: { stars, forks, openIssues,
               latestRelease?: { tag, date } }, impact?, vercel?, supabase?, error? }],
  totals: { commits, activeProjects, itemsClosed } }
```

What the fields mean:
- `commits` are from every local branch, merges left out, dated by commit day.
- `itemsClosed` / `itemsAdded` compare the status-doc items in the saved
  snapshots (the last one before the window, every one inside it, and today's
  docs read live). A reworded item shows up as one closed and one added, and
  only the first 8 items of each doc are tracked, so treat these as close, not
  exact. Never claim an item was finished if the commits say nothing about it;
  say "dropped from the doc" when in doubt.
- `openItems` is the launch distance: open items at the start and end of the
  window. `start: null` means there was no earlier snapshot, so there is no
  trend yet; say "no history yet", not "no progress".
- `github.openIssues` counts open pull requests too.
- `error` means git could not read that repo. Report it in one line; the
  other numbers for that project are zeros, not facts.

## 2. Impact (optional)

Only for projects that have both the integration and an `impact` entry in the
config. Use the MCP tools if they are available in this session; if a tool is
missing or a call fails, write "not checked" for that number. Never estimate.

- Page views, when `"impact": { "pageviews": true }` and the project has
  `vercel` (`projectId`, `teamId`): call Vercel `count_pageviews` (or
  `aggregate_pageviews`) for `from` to `to`. Report one total, and the change
  from the week before if you can get it with one more call.
- Sign-ups, only when the user turned on `"impact": { "signups": true }` and
  the project has `supabase` (`projectRef`): run one read-only count with
  `execute_sql` on the connector that can see that ref:

  ```sql
  select count(*) as signups
  from auth.users
  where created_at >= '<from>'::date
    and created_at < '<to>'::date + 1;
  ```

  Counts only. Never select emails, names, ids or any other column from
  `auth.users`, never run anything that writes, and never put user data in
  the review.

## 3. Write the review

```
# devbrief review · <from> to <to>

**Attention:** <spread in one line, e.g. "you touched 5 projects and moved 1 closer to launch">

## Verdicts
- **FINISH shop-api**: open items 9 -> 3, 14 commits on 5 days. Three items left; close them out.
- **PUSH landing**: ...
- **PAUSE pixel-quest**: ...
- **KILL old-prototype**: ...

## Launch distance
| Project | Open items (start -> end) | Closed | Added |
|---|---|---|---|

## Impact
<stars, forks, releases this week, page views, sign-ups; omit the section if there is nothing>

## Focus next week
**<one project>**: <why, in one or two lines, and its first open item>
```

How to judge:
- "Moved closer to launch" means `openItems.end < openItems.start`. Count
  those for the attention line, alongside the number of projects with commits.
  Spread across many projects with few closer to launch is worth saying
  plainly.
- One verdict per project with activity, open items or a note. Group the rest
  into one line ("quiet: recipes-app, ...").
  - **FINISH**: few open items left (about 5 or fewer) and recent progress.
    The fastest way to a launch.
  - **PUSH**: active and the open-item count is going down, or new impact
    (stars, a release, sign-ups) says people want it.
  - **PAUSE**: little or no activity, or items being added faster than
    closed with no impact. Not dead, just not now.
  - **KILL**: no commits for the whole window and the last few weeks, no
    impact, and the notes or status doc give no reason to keep it. Only
    suggest it; the user decides.
- Each verdict's reason quotes the numbers it rests on. Never invent progress
  or impact.
- `notes` win: a project noted as paused or superseded gets PAUSE (or KILL
  only if the note says it is replaced) and never becomes the focus.
- The focus is one project, never two. Prefer a FINISH, then the PUSH with the
  best impact. Name its first open item as the first step.

Save the review to `~/.devbrief/reviews/<to>.md` (under `$DEVBRIEF_HOME` if
set, next to the briefs), then show it in the chat.

For a single-project review, skip the template: the week's commits grouped by
theme, items closed and added, launch distance, impact, and a verdict.
