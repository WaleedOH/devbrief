# Living status docs

devbrief reads each repo's status doc (`STATUS.md`, `docs/NEXT.md` and so
on) to say what to do next. That only works while the doc is current. Three
things keep it that way.

## /devbrief wrap

At the end of a session, run `/devbrief wrap` in the repo. Claude reads the
commits since the doc last changed and the work not committed yet, then:

- marks finished items done, the way your doc already does it (a Done
  section, `- [x]`, or `~~strikethrough~~`),
- adds next steps the session turned up, and blockers,
- keeps your wording and layout, and never deletes your content wholesale,
- shows you the diff, and commits only the doc, and only if your repo does
  that or you say so.

A repo with no status doc gets a short `STATUS.md` with `## Next`,
`## Blocked` and `## Done recently`.

## The Stop nudge

With the hooks installed (`node install.mjs --with-hook`), devbrief notes
where `HEAD` was when a session starts. When Claude finishes a reply, it
checks the repo again. If the session made commits and neither those commits
nor your uncommitted changes touched the status doc, Claude is asked once:

```
devbrief: you made 3 commits this session but STATUS.md wasn't updated.
Run /devbrief wrap (or say skip).
```

It asks at most once per session, never while Claude is already continuing
because of a Stop hook, and never while background tasks are still running.
It stays quiet for projects whose `notes` in the config say "paused",
"archived", "superseded" or "on hold". Session records live in
`~/.devbrief/sessions/` and are deleted after 14 days. If anything goes
wrong, the hook says nothing and lets Claude stop.

Turn it off everywhere in `~/.devbrief/config.json`:

```json
{ "wrap": { "nudge": false } }
```

or for one project:

```json
{ "projects": [{ "name": "landing", "path": "~/landing", "wrap": { "nudge": false } }] }
```

`node install.mjs --remove-hook` removes all devbrief hooks (auto-pull,
session tracking and the nudge).

## Promise tracking

Every brief saves a snapshot, so devbrief can tell how long an item has sat
in your "Next" list. Items are matched by their text, ignoring case,
punctuation and markdown, so small edits keep their age. When an item has
been open for a while, the brief says so:

> **shop-api:** "Add login" has been next for 6 days.

It also notices when commits keep landing but the status doc has not changed
in over a week, and which items dropped off the list recently, so the weekly
review can say what got finished.
