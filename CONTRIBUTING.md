# Contributing

Thanks for helping. Bug reports, status-doc formats that devbrief misreads,
and small focused pull requests are all welcome.

## Setup

```bash
git clone https://github.com/WaleedOH/devbrief.git
cd devbrief
npm test
```

`npm test` runs Node's built-in test runner. It must pass on Linux, macOS and
Windows (CI checks all three).

## Rules

- **No dependencies.** The collector uses only Node built-ins plus `git` and
  `gh` on the command line. Please don't add npm packages, including dev
  dependencies.
- **Keep the snapshot shape stable.** The skill and other people's scripts
  read the collector's JSON. Adding a field is fine. Renaming or removing one,
  or changing a flag `code`, is a breaking change and needs a good reason and a
  changelog entry.
- **Never guess.** If a source can't be checked, report it as unavailable
  instead of making up a state.
- Add a test for every change in behavior, and a line under "Unreleased" in
  `CHANGELOG.md`.

## Adding a status-doc pattern

Status docs are parsed by `extractNextSteps()` in
`skills/devbrief/scripts/collect.mjs`.

- A new file name: add it to `DEFAULT_STATUS_DOCS`.
- A new heading word (like "Up next"): add it to the `NEXT_HEADING` regex.
- A new list or table format: extend `extractNextSteps()`.

Add a test in `test/collect.test.mjs` with a short markdown sample, ideally
copied (and anonymized) from a real doc that was misread.

## Adding a new source

1. Collect it in its own function, like `collectGit()` or `collectGithub()`,
   and store the result under a new key on the project.
2. If the source needs a CLI, check it is available first and skip it cleanly
   when it isn't.
3. Turn real problems into flags in `computeFlags()` with a severity
   (`high`, `medium`, `low`), a short stable `code` and a plain message.
4. If the source needs an MCP connector instead (like Vercel and Supabase),
   describe the calls in `skills/devbrief/SKILL.md` rather than the collector.
5. Add the source to the "What it checks" table in the README.
