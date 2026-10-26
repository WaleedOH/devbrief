# Weekly review and time budgets

The daily brief answers "what now?". The weekly review answers "where did my
week go, and what deserves next week?".

## Weekly review

```
/devbrief review        the last 7 days
/devbrief review 14     the last 14 days
```

Claude runs `skills/devbrief/scripts/review.mjs`, which gathers for each
project:

- **Commits**: subjects and dates from every local branch (merges left out),
  the number of days you committed, and lines added and removed.
- **Items closed and added**: from your status docs, by comparing the
  snapshots each brief saves. The more often you run the brief, the more
  accurate this gets.
- **Launch distance**: open status-doc items at the start and end of the
  week. Going down means the project is getting closer to done.
- **GitHub**: stars, forks, open issues and the latest release, when `gh` is
  logged in.

Then it writes the review: how spread out your attention was, a verdict per
project (**PUSH**, **PAUSE**, **KILL** or **FINISH**) with the numbers behind
it, and one project to focus on next week. Your `notes` in the config always
win, so a paused project stays paused. The review is saved to
`~/.devbrief/reviews/<date>.md`.

You can also run the script yourself:

```
node skills/devbrief/scripts/review.mjs              # short summary
node skills/devbrief/scripts/review.mjs --json       # full JSON
node skills/devbrief/scripts/review.mjs --days 14    # longer window
node skills/devbrief/scripts/review.mjs --to 2026-10-25  # end on another day
node skills/devbrief/scripts/review.mjs --project shop-api
node skills/devbrief/scripts/review.mjs --no-github  # skip gh
```

```
devbrief review · 2026-10-20 to 2026-10-26 (7 days)
19 commits in 2 of 4 projects, 5 items closed

landing        no commits; 4 open
old-prototype  no commits
pixel-quest    5 commits on 2 days, +310 -42; 1 closed, 2 added; open 7 -> 8
shop-api       14 commits on 5 days, +820 -140; 4 closed, 0 added; open 7 -> 3; 14 stars, v0.3.0
```

Item tracking is approximate: a reworded item counts as one closed and one
added, and only the first 8 open items of each doc are tracked.

## Impact (opt-in)

Commits show effort; impact shows whether anyone cares. Turn it on per
project in `~/.devbrief/config.json`:

```json
{
  "name": "shop-api",
  "path": "~/code/shop-api",
  "vercel": { "projectId": "prj_xxx", "teamId": "team_xxx" },
  "supabase": { "projectRef": "abcdefghijklmnop" },
  "impact": { "pageviews": true, "signups": true }
}
```

- `pageviews`: the week's page views from Vercel Web Analytics, through the
  Vercel MCP connector.
- `signups`: the number of new accounts that week, through the Supabase MCP
  connector. Claude runs one read-only `count(*)` on `auth.users` for the
  window. It never reads emails or any other personal data, only the count.

Both are off unless you turn them on, and are skipped ("not checked") when
the connector is not available.

## Time budgets

```
/devbrief 40m
/devbrief 2h
/devbrief 1h30
```

Instead of a full brief, you get the best set of actions that fits the time:
each sized S (up to 15 min), M (up to 45 min) or L (over 45 min) from its
wording, highest value first, plus a "doesn't fit today" line for the
important things left out. The sizes are rough guesses from the wording, not
measurements.
