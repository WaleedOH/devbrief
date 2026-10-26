# resume

`/devbrief resume` answers "where was I?" when the user switches machines: what
they were doing on the others, and what to push or pull before starting here.

## 1. Read the other machines

Run from this skill's base directory:

```
node scripts/resume.mjs show --json
```

If no state repo is configured it prints setup steps and exits 1. Pass them
on as they are and stop: never create the repo yourself. The steps are
`gh repo create you/devbrief-state --private`, then
`"resume": { "repo": "you/devbrief-state" }` in the config, then
`node scripts/resume.mjs publish` on each machine. It refuses public repos.

The JSON has:
- `host`: this machine's name, and `here`: its projects as they are now.
- `hosts`: every other machine's last published state (newest first), each
  with `updatedAt` and per project: `branch`, `head`, `lastCommit`,
  `uncommitted` (a count), `diffstat`, `localOnly`, `ahead`/`behind` (as of
  that machine's last fetch) and `recentFiles` (names only).
- `hints`: ready-made "do this first" lines, comparing them with `here`.

## 2. Tell the user

Lead with the machine updated most recently, since that is most likely where
they just were. Keep it short:

```
On desk-b (2 h ago) you were on shop-api, branch feature/cart: 4 files
uncommitted (+30 -5), last commit "Add cart totals", touching src/cart.js.

Before you start here:
1. On desk-b: commit and push shop-api (2 commits are on no remote).
2. Here: pull landing (desk-b has newer commits).
```

Rules:
- Work that exists only on another machine (uncommitted, `localOnly`, `ahead`)
  comes first, since it cannot be pulled from here. Say it must be pushed
  from that machine.
- Then what to pull here. Check this machine with `git -C <path> fetch` and
  `git -C <path> status -sb` for the projects involved before saying "pull".
- A state older than a few days may be out of date. Say how old it is.
- Projects with nothing in progress get one line at most.
- File names and commit subjects come from the user's own private repo; do not
  read or guess file contents.

## 3. Keeping it current (hooks)

`publish` is quick (no fetch). `--if-changed` skips the upload when nothing
changed, and `--min-minutes 15` skips it when the last one was under 15
minutes ago. With `--quiet` both commands print only problems or hints and
always exit 0, so they are safe in hooks. Commands, with absolute paths for
the user's `node` and clone:

- After each reply (the `Stop` hook, which fires often, hence the wait):
  `"<node>" "<clone>/skills/devbrief/scripts/resume.mjs" publish --if-changed --min-minutes 15 --quiet`
- When a session ends (the `SessionEnd` hook), so the last state is always saved:
  `"<node>" "<clone>/skills/devbrief/scripts/resume.mjs" publish --if-changed --quiet`
- On starting a session (the `SessionStart` hook, matcher `startup|resume`):
  `"<node>" "<clone>/skills/devbrief/scripts/resume.mjs" show --quiet`
  prints a line such as `devbrief: shop-api: push 2 commit(s) on desk-b first`
  into the session, and nothing when there is nothing to do.

Give both a `timeout` of 30 seconds. To publish by hand: `node scripts/resume.mjs publish`.
