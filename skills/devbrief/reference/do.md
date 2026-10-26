# /devbrief do <n>

Do item `n` from today's "Do first" list. The user is asking you to act, so
act, but within the rules below. Run commands from this skill's base directory.

## 1. Find the item

1. Read `~/.devbrief/briefs/<date>.md` (or under `$DEVBRIEF_HOME`), where
   `<date>` is today in local time (YYYY-MM-DD).
2. If it is missing, make today's brief first (the normal `/devbrief` flow),
   show it, then carry on.
3. Take item `n` under `## Do first`. If there is no item `n`, list the items
   that exist and stop.
4. Restate it in one line before doing anything:
   `Doing 2: pull shop-api (3 commits behind).`

If the brief is older than a few hours, or the item looks done already, re-run
`node scripts/collect.mjs --project <name>` and check the fact behind it still
holds. If it no longer holds, say so and stop.

## 2. Do it, safely

Work in the project's own folder (`path` in the snapshot). Before changing
anything, run `git status` and `git branch --show-current`.

Go ahead without asking:
- read-only checks: `git status`, `git log`, `gh pr view`, `gh run view
  --log-failed`, reading files and logs;
- pull or fast-forward (`git pull --ff-only`) when the tree is clean;
- pushing a branch that is not the default branch;
- running the repo's tests, linter or build.

Ask first, and wait for an explicit yes:
- pushing to the default branch (`main`, `master`, or whatever
  `git symbolic-ref refs/remotes/origin/HEAD` names);
- deleting a branch, local or remote;
- anything with `--force`, `-f`, `reset --hard`, `clean -fd` or a rebase of
  pushed commits;
- database writes of any kind: migrations, SQL that changes data or schema,
  Supabase MCP calls that write;
- deploys, promotions or rollbacks (Vercel or anything else);
- anything that reads, prints, edits or rotates secrets: `.env*` files, API
  keys, tokens, Vercel or Supabase environment variables.

When you ask, say exactly what you will run and what it changes:
`This pushes 2 commits to main on shop-api. Go ahead?`

Code changes go on a new branch, `devbrief/do-<slug>` (slug: lowercase words
from the item joined with `-`, at most 40 characters), made from an up-to-date
default branch, unless the user says to use another branch. If the working
tree has uncommitted changes that are not yours, do not stash, reset or commit
them: say so and ask how to proceed.

Keep the change to what the item says. If the item turns out bigger than one
sitting (more than a few files, or a design decision), stop, describe what you
found, and suggest the first concrete step.

## 3. Verify and report

1. Run the checks that prove it worked: the repo's tests for a code change,
   `git status` and `git log -1` for a pull or push, `gh run list --branch
   <branch> --limit 1` after a CI fix is pushed.
2. Re-run `node scripts/collect.mjs --project <name> --no-save` and confirm the
   flag behind the item is gone (or say why it is still there).
3. Report in a few lines: what changed (branch, commits, files), how it was
   verified, and what is left for the user (for example "open a PR from
   `devbrief/do-fix-login-test`, or say the word and I will").

Never claim a check passed that you did not run. If something failed, say
what failed and leave things as they are; do not undo the user's work.
