# Resume across machines

Switch from a desktop to a laptop and devbrief tells you where you left off:
which branch, what was uncommitted, what is still unpushed over there, and
what to pull here. In Claude Code: `/devbrief resume`.

Each machine publishes a small JSON summary to a **private** GitHub repo you
own; any machine reads the others back. It goes through the GitHub CLI
(`gh api`), so nothing is cloned.

## Setup (once)

```
gh repo create you/devbrief-state --private
```

Add it to `~/.devbrief/config.json`:

```json
"resume": { "repo": "you/devbrief-state" }
```

devbrief never creates the repo for you, and it refuses to write to a public
one. Optional: `"host": "desk"` to use a name other than the machine's.

## Use

```
node skills/devbrief/scripts/resume.mjs publish   # save this machine's state
node skills/devbrief/scripts/resume.mjs show      # read the other machines
node skills/devbrief/scripts/resume.mjs show --json
```

```
desk-b (updated 2 h ago)
  shop-api on feature/cart · "Add cart totals" (2026-10-26)
    4 uncommitted: +30 -5 in 3 file(s), 1 untracked · 2 commit(s) on no remote
    recent: src/cart.js, src/totals.js
  6 other project(s) quiet
  → shop-api: push 2 commit(s) on desk-b first, they are on no remote
```

## What is stored

Per project: name, branch, short commit id, last commit subject and date,
the number of uncommitted files, a diffstat line (`+30 -5 in 3 file(s)`),
local-only, ahead and behind counts, and up to five recently changed file
names. Never file contents, and never local folder paths. One file per machine,
`hosts/<machine>.json`, updated in place.

## Hooks

With `--quiet` both commands print only problems or hints and always exit 0.

| Hook | Command |
|---|---|
| `Stop` | `resume.mjs publish --if-changed --min-minutes 15 --quiet` |
| `SessionEnd` | `resume.mjs publish --if-changed --quiet` |
| `SessionStart` (`startup\|resume`) | `resume.mjs show --quiet` |

`--if-changed` skips the upload when nothing changed since this machine last
published; `--min-minutes` keeps the `Stop` hook (which runs after every
reply) from uploading more than once every 15 minutes.
