# Changelog

All notable changes to devbrief are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://github.com/WaleedOH/devbrief/releases/tag/v0.1.0
