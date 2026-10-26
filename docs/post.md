# Build in public

`/devbrief post` turns what you shipped into drafts you can share: an X or
Bluesky thread, a LinkedIn post, or a devlog in markdown. It writes drafts
only. **Nothing is ever posted for you**; you copy the text where you want it.

```
/devbrief post               all three formats, last 7 days
/devbrief post x             X / Bluesky thread
/devbrief post linkedin 14   LinkedIn post, last 14 days
/devbrief post devlog        markdown devlog
```

## Privacy

Your projects are treated as private until you say otherwise. The first time,
Claude asks which projects you are happy to talk about and saves the answer in
`~/.devbrief/config.json`:

```json
{ "post": { "public": ["shop-api", "pixel-quest"] } }
```

Projects not in that list are never named, hinted at or counted. Inside public
projects, drafts still leave out customer names, revenue numbers, private repo
names, internal URLs, file paths and anything that looks like a secret, unless
you say a detail is fine. Edit the list any time, or ask Claude to change it.

## What goes in

The drafts come from your commits and the status-doc items you closed in that
time (via `scripts/review.mjs`, or plain `git log` if that is missing). Commit
subjects are rewritten as outcomes: "feat: add applepay" becomes "visitors can
now pay with Apple Pay". Numbers only appear when they come from your data,
and a quiet week gets an honest short post, not filler.

## Formats

- **x**: a thread of 3 to 6 posts, each under 280 characters, hook first.
- **linkedin**: short paragraphs and one takeaway.
- **devlog**: a section per project with what shipped, what's next (from your
  status docs) and one "what I learned" line.

## Where drafts go

`~/.devbrief/posts/<date>-<format>.md`, for example
`~/.devbrief/posts/2026-03-14-x.md`. Running it again the same day replaces
that day's draft.

## The footer

Each draft ends with `Made with devbrief: https://github.com/WaleedOH/devbrief`.
It helps other people find the tool, but it is yours to remove:

```json
{ "post": { "public": ["shop-api"], "footer": false } }
```
