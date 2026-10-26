# Changelog

All notable changes to devbrief are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-10-26

devbrief now acts on the brief, keeps your status docs current, reviews your
week, and goes where you are.

### Added
- **Doing, not just reporting:** `/devbrief do <n>` carries out a Do-first
  item with safe defaults. `/devbrief nightshift` plans safe tasks in opted-in
  projects (`nightShift`), fixes them in isolated worktrees and opens draft
  PRs; the morning brief opens with the results. `/devbrief fix-everywhere`
  fixes a problem shared by several projects once. New scripts:
  `nightshift.mjs` (planner and log), `patterns.mjs`.
- **Living status docs:** `/devbrief wrap` updates the status doc at the end of
  a session. `--with-hook` now also installs session hooks that nudge once
  when a session committed without updating the doc (`"wrap": { "nudge":
  false }` turns it off). Briefs show how long each next step has waited and
  flag status docs that lag the commits.
- **Portfolio review:** `/devbrief review` and `review.mjs`: commits, active
  days, lines changed, items closed and added, launch distance, GitHub stars
  and releases, opt-in Vercel page views and Supabase sign-up counts, and a
  push / pause / kill / finish verdict per project. Time budgets
  (`/devbrief 40m`).
- **Delivery:** `/devbrief send` to ntfy, Discord or a desktop notification,
  `/devbrief speak` with the OS's built-in voice (`deliver.mjs`), and
  `"deliver": { "afterBrief": true }` to send every brief.
- **Resume across machines:** `/devbrief resume` and `resume.mjs` through a
  private GitHub repo you own (refuses public repos, never stores contents).
- **Build in public:** `/devbrief post` drafts an X/Bluesky thread, LinkedIn
  post or devlog from the week's work. Private by default, never posts.
- **MCP server:** five read-only tools for any MCP client, registered by the
  plugin (`skills/devbrief/mcp/server.mjs`).

### Changed
- Errors print one line; set `DEVBRIEF_DEBUG=1` for the stack.

## [0.1.0] - 2026-10-26

First public release.

### Added
- Remote mode (`--remote`): collect from GitHub only, with no local clones,
  for scheduled cloud runs. Configured with `remote.owners`. See
  `docs/remote-mode.md`.
- Auto-pull hook: `node install.mjs --with-hook` adds a Claude Code
  SessionStart hook that fast-forwards clean repos; `--remove-hook` takes it
  out. See `docs/auto-pull.md`.
- Install through the Claude Code plugin marketplace.
- CI on Linux, macOS and Windows.
- Handles configs and docs saved with a UTF-8 BOM, status doc names in any
  case, symlinked repos, and running through the installed skill link. Skips
  macOS privacy-protected folders when scanning the home folder.
- `/devbrief` skill: a ranked brief with "Do first" (at most 3), one line per
  project and "Since last brief". Arguments: `quick`, `offline`, `<project>`.
- Dependency-free collector (`skills/devbrief/scripts/collect.mjs`) that
  prints a JSON snapshot and saves it to `~/.devbrief/snapshots/`.
- git checks: branch, ahead/behind origin, uncommitted files, last commit,
  stale repos, missing remote or upstream.
- `local-only` flag for commits that exist on no remote branch.
- GitHub checks through `gh`: open PRs, open issues, latest CI run.
- Status-doc reader: open items under headings like *Next*, *Left to do* or
  *Blocked*, unchecked `- [ ]` items, and table rows that are not done.
- Vercel deploy and runtime-error checks, and Supabase advisors sorted into
  real problems and expected noise, through MCP connectors.
- Auto-detection of Vercel and Supabase links from `.vercel/project.json` and
  `supabase/.temp/project-ref`.
- Config at `~/.devbrief/config.json` with `roots`, `projects`, `exclude`,
  `notes`, `statusDocs`, `staleDays`, `fetch` and `maxStatusDocs`.
- `install.mjs`: links the skill into `~/.claude/skills` and writes a starter
  config.

[0.2.0]: https://github.com/WaleedOH/devbrief/releases/tag/v0.2.0
[0.1.0]: https://github.com/WaleedOH/devbrief/releases/tag/v0.1.0
