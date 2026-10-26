# /devbrief fix-everywhere [<key>]

Some problems show up in several projects at once: the same Supabase advisor
lint, the same CI workflow failing, the same outdated dependency, the same
flag. Fix it once, then apply the same change to the others.

Run commands from this skill's base directory. The rules for what may run
without asking, branches and verification are the ones in `reference/do.md`;
read it first if you have not this session.

## 1. Find the pattern

```
node scripts/patterns.mjs            # every shared problem in today's snapshot
node scripts/patterns.mjs --key <k>  # one of them
```

If there is no snapshot today, run `node scripts/collect.mjs` first. Supabase
advisor patterns only appear when today's brief saved its advisor results to
`brief-extras/<date>.json` (see `docs/nightshift.md`).

Each pattern is `{ key, kind, projects, summary }`, plus `level` (advisors) or
`severity` (flags). Kinds: `advisor`, `ci`, `dependency`, `flag`.

- With no `<key>`: list the patterns as numbered lines (`summary` only), most
  widespread first, and ask which to fix. Stop there.
- With a `<key>` (or a number from that list): show the pattern and the plan
  in a few lines, then go on.

Some patterns are not one change: `behind` means "pull each", `stale` or
`no-status-doc` may be fine as they are. Say so instead of inventing a fix.
Skip projects whose `notes` say paused or archived, and say which.

## 2. Fix it once

Pick the first project in `projects` that is active and has a clean working
tree. In it, on a new branch `devbrief/do-<slug>` (slug from the key, for
example `devbrief/do-function-search-path-mutable`):

1. Make the smallest change that fixes the problem.
2. Verify: the repo's tests, plus the check that proves this pattern is gone
   (`npm outdated <name>`, the workflow's failing step run locally, a
   re-read of the advisor after the user applies the migration).
3. Show the user the diff and the result before touching any other project.
   Database migrations are written, never applied, unless the user says yes.

## 3. Apply it to the others

For each remaining project, one at a time:

1. Check it still has the problem (the snapshot may be hours old).
2. Make the same change, adapted only where the code differs (file names,
   function names). If it needs more than small adaptation, stop for that
   project and say why.
3. Run its tests on its own `devbrief/do-<slug>` branch.
4. Push the branch and open a PR, or leave a commit, following the `do.md`
   rules (pushing a non-default branch is fine; the default branch needs a
   yes).

A failure in one project never blocks the rest: note it and move on.

## 4. Report per project

```
fix-everywhere · advisor:function_search_path_mutable
- shop-api: fixed on devbrief/do-function-search-path-mutable, tests pass, PR #12
- landing: fixed, tests pass, PR #31
- recipes-app: not changed, tests were already failing before the change
```

Then say what the user still has to do (for example apply the migrations, or
merge the PRs).
