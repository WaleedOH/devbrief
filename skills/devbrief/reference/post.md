# /devbrief post

Write build-in-public drafts from what actually shipped. You write drafts only:
**never post, schedule or send anything.** The user copies the text themselves.

Arguments (all optional, any order):
- format: `x` (also fits Bluesky), `linkedin`, `devlog`, or `all` (default)
- days: a number, how far back to look (default 7)

So `/devbrief post`, `/devbrief post x`, `/devbrief post devlog 14`.

## 1. Privacy first

The user's projects are private by default. Before anything else, read the
`post` section of the devbrief config (`~/.devbrief/config.json`, or the file
in `DEVBRIEF_CONFIG`):

```json
{ "post": { "public": ["shop-api", "pixel-quest"], "footer": true } }
```

- If `post.public` is missing, list the project names and ask which ones the
  user is happy to talk about in public. Save the answer as `post.public` in
  the config, keeping every other key exactly as it was. Ask again only if
  the user asks to change it, or a new active project shows up that is not in
  the list (then ask about that one project only).
- An empty list means nothing is public: say so and stop.
- Only projects in `post.public` exist for this command. Never name, hint at
  or count the others ("and 3 secret projects" is a leak too).

Inside a public project, still leave out unless the user explicitly says it is
fine: customer or user names, company names, revenue and money numbers,
private repo names, internal URLs, hostnames, local file paths, keys, tokens,
emails, and anything a commit or status doc marks as private, internal or
security-related (a security fix becomes "fixed a bug", with no detail on how
to exploit it). If you are unsure about a detail, leave it out and mention it
in one line after the drafts so the user can add it back.

## 2. Gather what shipped

From this skill's base directory:

```
node scripts/review.mjs --json --days <days>
```

It prints `{ from, to, days, projects: [...], totals }`. Per project you get
`commits` (`date`, `subject`), `activeDays`, `linesAdded`, `linesRemoved`,
`itemsClosed` and `itemsAdded` (status-doc items), `openItems` (`start`,
`end`), `notes`, and sometimes `github` (`stars`, `forks`, `openIssues`,
`latestRelease`). Drop every project not in `post.public`, then every project
with no commits and no closed items.

If `scripts/review.mjs` is missing or fails, fall back to git for each public
project (paths come from the latest snapshot in `~/.devbrief/snapshots/`):

```
git -C <path> log --since="<days> days ago" --no-merges --date=short --format=%ad%x09%s
```

and read its status doc for what is next. Say in one line that the fallback
was used, since closed items and line counts are then missing.

Nothing shipped in public projects? Say so plainly and write nothing. Do not
pad a quiet week.

## 3. Turn commits into outcomes

People care what changed for them, not what the diff was.

- "feat: add applepay" becomes "visitors can now pay with Apple Pay".
- "fix: cart total rounding" becomes "cart totals no longer drift by a cent".
- Group many small commits into one outcome. Skip chores, merges, typo fixes,
  dependency bumps and refactors unless they are the story ("cut the build
  from 4 minutes to 40 seconds" is a story).
- Closed status-doc items (`itemsClosed`) are often the best outcomes: they
  are already written by the user in plain words.
- What's next comes from open status-doc items. Quote them, shortened. Never
  invent plans.

Tone: honest, specific, first person, plain words. No hype ("game-changer",
"revolutionary", "excited to announce", "huge", rocket emoji). Only numbers
that come from the data (commits, days, closed items, stars, a release tag).
Never invent metrics, users or results. Small weeks are fine: "Slow week: one
fix to checkout" is a good post.

## 4. Write the drafts

**x** (X or Bluesky thread): 3 to 6 posts, each at most 280 characters
counting the footer and any numbering like `1/4`. The first post is the hook:
the most interesting concrete outcome, not "Weekly update!". One idea per
post. End with what's next. Count characters; if a post is over, cut words.

**linkedin**: 4 to 8 short paragraphs of one to three sentences, no walls of
text, at most 3 hashtags at the very end (or none). Open with the outcome,
explain briefly how or why, and close with one takeaway the reader can use.

**devlog** (markdown for a blog, README or changelog):

```
# Devlog: <from> to <to>

## <project>
What shipped:
- <outcome>
What's next:
- <open status-doc item>

**What I learned:** <one honest line, from the work itself>
```

One `##` section per public project that shipped something, most active first.

## 5. Footer, save, show

Unless `post.footer` is `false`, end each draft with the footer, on its own
line: `Made with devbrief: https://github.com/WaleedOH/devbrief`. In the x
format it goes in the last post and counts toward its 280 characters.

Save each draft to `~/.devbrief/posts/<date>-<format>.md` (under
`$DEVBRIEF_HOME` if set; `<date>` is today, local time). If that file exists,
overwrite it: it is a draft. Then show the drafts in the chat, each in its own
code block so it is easy to copy, followed by:

- the projects used and the date range,
- anything you left out for privacy that the user might want back,
- a reminder that nothing was posted, and that `"post": { "footer": false }`
  in the config turns the footer off.
