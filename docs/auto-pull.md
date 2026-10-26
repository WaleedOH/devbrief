# Auto-pull on session start

If you work on more than one machine, it is easy to start a session on a repo
that is a few commits behind. devbrief can fix that for you: a Claude Code
`SessionStart` hook runs `skills/devbrief/scripts/pull.mjs`, which fetches every
project in your devbrief config and fast-forwards the ones that are safely behind.

## What it does

For each configured project (the same list `collect.mjs` uses):

1. Skip it if the current branch has no upstream.
2. `git fetch`.
3. If it is not behind, do nothing.
4. If it has local commits too (diverged), do not pull. Say so.
5. If it has uncommitted changes to tracked files, do not pull. Say so.
6. Otherwise fast-forward to the upstream (`git merge --ff-only @{upstream}`,
   which is what `git pull --ff-only` does after its fetch, without a second
   trip to the network).

Up to four repos run at once, and the whole run stops after 20 seconds, so a
slow or offline network never holds up your session. Repos that were not done
in time are listed as skipped. Git is never allowed to prompt for a password.

The script always exits 0, so it can never block a session.

## Safety rules

- Fast-forward only. It never merges, rebases, stashes or resets.
- It never touches a repo with uncommitted changes to tracked files.
- It never touches a repo with local commits that are not on the upstream.
- With `--dry-run` it fetches (which only updates `origin/*` refs) but leaves
  every branch and file alone.

## Output

The hook's output is added to Claude's context, so it is kept tiny: one line
per repo that was pulled or needs you, and nothing when everything is current.

```
devbrief: pulled shop-api (+3)
devbrief: landing is behind (+2) but has uncommitted changes, not pulled
devbrief: recipes-app has diverged (1 local, 4 on origin), not pulled
devbrief: could not fetch pixel-quest
devbrief: ran out of time, skipped old-prototype
```

## Running it by hand

```
node skills/devbrief/scripts/pull.mjs              # fetch and fast-forward
node skills/devbrief/scripts/pull.mjs --dry-run    # say what would be pulled
node skills/devbrief/scripts/pull.mjs --project x  # one project only
node skills/devbrief/scripts/pull.mjs --quiet      # silent when nothing changed
node skills/devbrief/scripts/pull.mjs --timeout 10 # time cap in seconds (default 20)
node skills/devbrief/scripts/pull.mjs --config f   # same as DEVBRIEF_CONFIG=f
```

## Install and remove

```
node install.mjs --with-hook     # normal install, plus the hook
node install.mjs --remove-hook   # take the hook out (nothing else)
```

Both edit `~/.claude/settings.json` (or the file in `CLAUDE_SETTINGS_FILE`).
They keep every other setting as it is, save the old file as
`settings.json.devbrief.bak` before writing, and are safe to run twice: there is
only ever one devbrief hook. If the settings file is not valid JSON, they stop
and tell you instead of overwriting it.

Restart Claude Code (or open `/hooks`) after installing so it picks the hook up.

## What it adds to settings.json

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "\"/usr/local/bin/node\" \"/home/you/devbrief/skills/devbrief/scripts/pull.mjs\" --quiet",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

The two paths are the absolute path of the `node` that ran the installer and of
`pull.mjs` in your clone. Both are double-quoted so folders with spaces work.
On Windows the backslashes become forward slashes, for example
`"C:/Program Files/nodejs/node.exe"`, which both Windows and Git Bash accept.

`startup|resume` means it runs when you start or resume a session, not after
`/clear` or compaction. Any existing `SessionStart` hooks stay in place next to it.

If you move the repo or switch Node installs, run `node install.mjs --with-hook`
again to update the paths.

Claude Code runs hook commands through `sh` (Git Bash on Windows). On a Windows
machine without Git Bash it falls back to PowerShell, where this command line
does not work; install Git for Windows, or edit the hook to start with `& `.

Schema checked against https://code.claude.com/docs/en/hooks (October 2026).
