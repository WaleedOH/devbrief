# Remote mode

`--remote` builds the snapshot from GitHub alone, with no local clones. Use it
where your laptops and repos are not around: a scheduled cloud job (GitHub
Actions, a cron box), or as the base for a hosted brief.

```
node skills/devbrief/scripts/collect.mjs --remote
```

`--project <name>`, `--no-save` and `--config <file>` work as in local mode.
It needs the GitHub CLI (`gh`) logged in (`gh auth login`, or `GH_TOKEN` in CI)
and exits with a clear message if it is not.

## Which repos

Remote mode reads the same config file. It collects:

- every repo of each `remote.owners` entry (up to 100 each), skipping archived
  repos and forks (set `includeForks: true` to keep forks);
- every configured project with a `github: "owner/repo"` field;
- the GitHub remote of any local clone that happens to be on the machine.

Repos are deduped. `exclude` and `ignore: true` match the repo name, and a
configured project whose `name` matches a repo name lends it its `notes`,
`statusDocs`, `vercel` and `supabase` settings.

```json
{
  "remote": {
    "owners": ["your-github-name", "your-org"],
    "includeForks": false,
    "concurrency": 4,
    "timeoutSeconds": 20
  },
  "projects": [
    { "name": "my-app", "github": "your-github-name/my-app", "notes": "launch first" }
  ],
  "exclude": ["dotfiles"]
}
```

## What is checked

Per repo, on its default branch: the last commit (date, subject, days ago),
open PRs, open issues, the latest CI run, and the status docs (`LAUNCH-STATUS.md`,
`docs/NEXT.md` and the rest of `statusDocs`, in order, up to `maxStatusDocs`).
Status docs cost two directory listings (root and `docs/`) plus one fetch per
doc found, and each doc's `updated` date is its last commit.

Not checked, because they need a clone: uncommitted files, ahead/behind,
commits that exist only on one machine, and branches other than the default.
So remote snapshots never carry `uncommitted`, `behind`, `local-only`,
`no-remote` or `no-upstream` flags. A repo that cannot be read gets a
`repo-error` flag and the run carries on; an owner that cannot be listed goes
into the snapshot's top-level `errors`.

Snapshots have `mode: "remote"` and each project has `source: "remote"` and
`repo`, but no `path`. `changes` only compares against the previous remote
snapshot. Remote snapshots are saved in their own folder,
`snapshots/remote/<date>.json`, so they never overwrite a local one.

A run is about 6 GitHub calls per repo; 12 repos took about 5 seconds.

## On a schedule in GitHub Actions

Put this in a private repo that holds your config (for example
`devbrief/config.json`). The default `GITHUB_TOKEN` only sees the repo the
workflow runs in, so make a fine-grained personal access token with read-only
access to Contents, Issues, Pull requests, Actions and Metadata on the repos
you want, and save it as the secret `DEVBRIEF_GH_TOKEN`.

```yaml
name: devbrief
on:
  schedule:
    - cron: '0 6 * * 1-5'   # 06:00 UTC on weekdays
  workflow_dispatch:
jobs:
  brief:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4
        with:
          repository: WaleedOH/devbrief
          path: devbrief-tool
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Collect
        env:
          GH_TOKEN: ${{ secrets.DEVBRIEF_GH_TOKEN }}
          DEVBRIEF_HOME: ${{ github.workspace }}/devbrief
        run: node devbrief-tool/skills/devbrief/scripts/collect.mjs --remote > snapshot.json
      - uses: actions/upload-artifact@v4
        with:
          name: devbrief-snapshot
          path: devbrief/snapshots/remote/
```

`gh` is already installed on GitHub-hosted runners. To keep a history (so
`changes` works between runs), commit `devbrief/snapshots/` back to the repo
in a final step instead of only uploading it (that step needs
`permissions: contents: write` on the job).
