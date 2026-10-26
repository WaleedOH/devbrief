# /devbrief wrap

End of a work session: bring this repo's status doc up to date so tomorrow's
brief (and the next person) knows where things stand. Run it in the repo the
session worked on. `wrap <project>` runs it for a configured project instead.

The doc is the user's, not yours. Your edits should read as if they wrote
them: same wording style, same structure, as short as before.

## 1. Find the status doc

Look in the repo root for the first of these that exists, ignoring case. This
is the same list and order the collector uses, so the brief will read the
file you edit:

```
LAUNCH-STATUS.md  docs/LAUNCH-STATUS.md
STATUS.md         docs/STATUS.md
NEXT.md           docs/NEXT.md
TODO.md           docs/TODO.md
FIX-LIST.md       docs/FIX-LIST.md
ROADMAP.md        docs/ROADMAP.md
```

If the project has its own `statusDocs` list in the devbrief config
(`~/.devbrief/config.json`), use that list instead.

If none exists, create `STATUS.md` in the repo root from this template, and
fill it from step 2:

```markdown
# <project> status

## Next
- [ ] <the most important next step>

## Blocked
- <waiting on someone or something, or leave the section empty>

## Done recently
- <what this session finished>
```

## 2. Find out what the session did

```
git log -1 --format=%H -- <doc>        # last commit that changed the doc
git log --oneline <that>..HEAD         # commits since then (all commits if none)
git status --short                     # work not committed yet
git diff --stat                        # how big it is
```

Read the commit subjects, and the diffs of any you cannot place from the
subject. Add what you know from this conversation: what the user asked for,
what was tried, what broke, what was left half done. Uncommitted work counts
as in progress, not done.

## 3. Edit the doc

- **Finished items:** match the doc's own convention. If it has a "Done"
  section, move the item there (newest first). If it ticks boxes, change
  `- [ ]` to `- [x]`. If it strikes text, use `~~…~~`. If it uses a table
  with a status column, set that cell to `Done` or `✅`, whichever the table
  already uses. With no convention yet, move it under `## Done recently`.
- **New next steps** the session revealed (a bug found, a follow-up the user
  mentioned, a TODO left in code): add them as `- [ ]` items under the
  existing "Next" section, in order of importance. Do not invent work.
- **Blockers:** waiting on a review, a key, a person, a decision. Put them
  under "Blocked" with what would unblock them.
- **Keep the user's words.** Edit an item's text only when it is now wrong.
  Never reorder sections, rewrite the intro or change the heading style.
- **Never delete user content wholesale.** Remove a line only when it is a
  duplicate of one you just moved. When "Done recently" grows past about 10
  items, ask before trimming the oldest.
- **Keep it short.** One line per item, no session diary. A dated line like
  `Last wrap: 2026-10-26` under the title is fine if the doc already has one.

The collector reads open items under headings that contain words like
"Next", "Left to do", "Remaining", "Todo", "Blocked" or "In progress", plus
any unchecked `- [ ]` line anywhere, plus table rows under those headings
(rows with a `Done`, `✅` or `~~` cell are skipped). Done items are skipped
when they are `- [x]`, start with `~~`, or start with "Done" or ✅. So keep
open items under such a heading, and make finished ones look finished, or
the brief will keep reporting them as open.

## 4. Show it and commit

Show the user the diff (`git diff -- <doc>`) and a one-line summary such as
"Moved 2 items to Done, added 1 next step."

Then commit only the doc, and only if it fits how this repo works:
- Commit when the user asked you to, or the repo's own instructions
  (CLAUDE.md, CONTRIBUTING) say status updates get committed, or recent
  history shows doc-only commits like "Update STATUS.md".
- Otherwise ask: "Commit this as 'Update STATUS.md'?"
- Never commit other files with it, never push without being asked, and never
  commit on a protected or shared branch the user does not commit to.

If the user says "skip" (for example after the Stop nudge), do nothing and
do not bring it up again this session.
