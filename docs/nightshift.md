# Night shift

The night shift turns the brief into work. While you are away, Claude picks a
few small, safe tasks from projects you opted in, does each one in a separate
git worktree, runs the tests, and leaves every result as a **draft** pull
request. In the morning the brief starts with:

```
Night shift: 2 draft PRs ready for review, 1 task stopped without a PR
```

Nothing is ever merged, deployed or pushed to your default branch. If a task
cannot be verified, there is no PR, just a line in the log saying why.

## What it will do

Only these kinds of task, only in projects that opted in:

| Kind | When | Risk |
| - | - | - |
| `ci-failing` | the latest CI run on the default branch failed | medium |
| `doc-auto` | a status-doc item you tagged `[auto]` or `(nightshift)` | low or medium |
| `deps-patch` | `npm outdated` shows patch or minor updates (npm repos with a lockfile and a test script) | low |
| `advisor-cleanup` | a Supabase advisor reported `function_search_path_mutable` or `unindexed_foreign_keys` and the repo has `supabase/migrations/` | low |

Tasks are sorted by value over risk and capped at 3 a night (60 minutes at
most). Each one gets its own branch, `devbrief/nightshift/<date>-<slug>`, made
from the default branch in a fresh worktree. A task is skipped while a night
shift PR for the same task is still open.

## What it will not do

- Merge, approve, or mark a draft ready for review.
- Push to the default branch, force-push, or delete a branch.
- Touch your working copy: it skips any project with uncommitted changes,
  unpushed commits or commits that exist only on your machine, and works in a
  separate worktree for the rest.
- Touch secrets or `.env` files, existing migrations, infrastructure or deploy
  config, or write to a database. An `advisor-cleanup` PR adds one new
  migration file and says plainly that it was not applied.
- Work on projects whose `notes` say paused or archived.
- Tag items that mention migrations, databases, deploys, secrets, keys,
  billing or DNS: those are skipped even if you tag them.
- Make a major version bump, or update dependencies in a repo without tests.

## Opting in

Nothing is opted in by default. In `~/.devbrief/config.json`, either mark
projects:

```json
{
  "projects": [
    { "name": "shop-api", "path": "~/code/shop-api", "nightShift": true },
    { "name": "landing", "path": "~/code/landing", "nightShift": true }
  ]
}
```

or list them in one place, with optional limits:

```json
{
  "nightShift": { "projects": ["shop-api", "landing"], "max": 3, "maxMinutes": 60 }
}
```

`"nightShift": false` on a project always wins.

To hand the night shift a specific chore, tag it in the project's status doc,
in a "Next" section or as a checkbox:

```markdown
## Next
- [ ] Fix the typo in the pricing page footer [auto]
- [ ] Add alt text to the gallery images (nightshift)
```

## See the plan first

The planner only reads, so it is safe to run any time:

```
node skills/devbrief/scripts/nightshift.mjs plan             # readable list
node skills/devbrief/scripts/nightshift.mjs plan --json      # what Claude reads
node skills/devbrief/scripts/nightshift.mjs plan --offline   # skip npm and gh
node skills/devbrief/scripts/nightshift.mjs plan --max 1
```

It prints tonight's tasks and, for every opted-in project it left alone, the
reason. Run `/devbrief nightshift` in a normal session once and watch it work
before you schedule it.

## Scheduling

### On your machine (recommended)

The night shift needs your local clones, so a scheduled `claude -p` run on
your own computer is the simplest setup. It runs headless, so nobody can answer
a permission prompt: start it in `dontAsk` mode with an explicit allowlist, so
anything not on the list is denied instead of waiting. Do not use `--bare`: it
skips skills, so `/devbrief` would not load.

Save this as `~/.devbrief/nightshift.sh` (macOS, Linux) and make it
executable:

```sh
#!/bin/sh
# Run from the folder that holds your projects, so the repos and
# ~/.devbrief are inside Claude's working directory.
cd "$HOME" || exit 1
mkdir -p "$HOME/.devbrief/nightshift"
exec claude -p "/devbrief nightshift" \
  --permission-mode dontAsk \
  --permission-prompts none \
  --max-turns 200 \
  --max-budget-usd 5 \
  --allowedTools "Read,Edit,Write,Glob,Grep,Bash(node *),Bash(git *),Bash(gh pr list *),Bash(gh pr create *),Bash(gh run view *),Bash(npm ci *),Bash(npm install *),Bash(npm test *)" \
  --disallowedTools "Bash(gh pr merge *),Bash(gh pr ready *),Bash(gh pr review *),Bash(git * --force*),Bash(git * -f *),Bash(git * push * main),Bash(git * push *:main),Bash(git * push * master),Bash(git * push *:master),Bash(git * reset --hard*),Bash(git * stash*)" \
  > "$HOME/.devbrief/nightshift/last-run.txt" 2>&1
```

On Windows, save the same command as `%USERPROFILE%\.devbrief\nightshift.cmd`
(`cd /d %USERPROFILE%`, one line, `^` for line breaks).

The deny rules are a backstop, not the safety guarantee: Claude Code
evaluates deny rules before allow rules, but a Bash rule only matches the
command as written. The real guarantees are the night shift's own rules, the
draft-only PRs, and **branch protection on your default branch** (require a
pull request before merging). Turn that on in each opted-in repo.

`--permission-prompts` needs Claude Code v2.1.259 or later; on older versions
leave it out (a `-p` run with no one to ask denies prompts anyway). Check your
version with `claude --version`.

Then schedule it nightly:

- **macOS / Linux, cron** (`crontab -e`; cron has a short `PATH`, so use the
  full path to `claude`, from `which claude`, inside the script):
  ```
  0 2 * * * "$HOME/.devbrief/nightshift.sh"
  ```
- **macOS, launchd** (runs a missed job when the Mac wakes): save as
  `~/Library/LaunchAgents/dev.devbrief.nightshift.plist`, then
  `launchctl load ~/Library/LaunchAgents/dev.devbrief.nightshift.plist`.
  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
  <plist version="1.0"><dict>
    <key>Label</key><string>dev.devbrief.nightshift</string>
    <key>ProgramArguments</key><array>
      <string>/bin/sh</string><string>-c</string><string>"$HOME/.devbrief/nightshift.sh"</string>
    </array>
    <key>StartCalendarInterval</key><dict>
      <key>Hour</key><integer>2</integer><key>Minute</key><integer>0</integer>
    </dict>
  </dict></plist>
  ```
- **Windows, Task Scheduler** (in a terminal):
  ```
  schtasks /Create /SC DAILY /ST 02:00 /TN "devbrief night shift" /TR "%USERPROFILE%\.devbrief\nightshift.cmd"
  ```
  In Task Scheduler, open the task's Settings and tick "Run task as soon as
  possible after a scheduled start is missed" if the laptop sleeps at night.

The run needs your machine on, `git` and `gh` logged in, and Claude Code
logged in (the same login you use interactively).

### In the cloud

A Claude Code cloud routine (`/schedule` in a session, then a nightly routine
whose prompt is `/devbrief nightshift`) runs without your machine. It has no
local clones, so it plans from GitHub with remote mode (see
[remote-mode.md](remote-mode.md)) and clones each task's repo before working on
it. Dependency checks need a clone, so `deps-patch` is not planned there. The
routine needs devbrief installed and your config available to it (for
example in the private repo the routine runs in), and GitHub access to the
opted-in repos. This path is newer and less tested than the local one.

Docs used for the flags above:
[headless mode](https://code.claude.com/docs/en/headless),
[CLI reference](https://code.claude.com/docs/en/cli-reference),
[permissions](https://code.claude.com/docs/en/permissions),
[scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks).

## In the morning

Run `/devbrief` as usual. The brief opens with the night shift headline and
the PR links. To see everything, including why tasks stopped:

```
node skills/devbrief/scripts/nightshift.mjs log --summary   # last night, short
node skills/devbrief/scripts/nightshift.mjs log --read      # today's full log
node skills/devbrief/scripts/nightshift.mjs log --read 2026-03-04
```

Logs live in `~/.devbrief/nightshift/<date>.json` (a run that starts before
midnight logs under that evening's date), and the last run's output is in
`~/.devbrief/nightshift/last-run.txt`. Review each draft PR like a
colleague's: read the diff, check the "How it was verified" section, then mark
it ready and merge it yourself, or close it.

## Advisor results (brief-extras)

Supabase advisors come from MCP tools, which the collector cannot call. After
its database checks, the brief saves what it found to
`~/.devbrief/brief-extras/<date>.json`, which the night shift and
`/devbrief fix-everywhere` read:

```json
{
  "date": "2026-03-04",
  "projects": {
    "shop-api": {
      "advisors": [
        { "name": "function_search_path_mutable", "level": "WARN", "title": "Function Search Path Mutable", "count": 3 }
      ]
    }
  }
}
```

`name` is the advisor's lint name and `level` is `ERROR`, `WARN` or `INFO`.
Nothing secret goes in this file: no keys, URLs with tokens, or row data.
