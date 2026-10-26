# /devbrief demo

Show what devbrief does, using sample output for a made-up developer with five
projects. This works on a fresh install with no config, no git repos, no `gh`
and no MCP connectors.

Do not run the collector, git, `gh`, any script or any MCP tool. The only tool
calls allowed are reading files in this skill's `demo/` folder. Do not read the
user's config, snapshots or repos, and do not save anything.

## 1. Show the brief

Read `demo/brief.md` from this skill's base directory and show it verbatim:
the whole file, unchanged, as markdown (not in a code block). Put one short
line above it: "This is sample output for a made-up developer, not your
projects."

## 2. Offer the rest

Then one line:

"Also in the demo: the weekly review, what the night shift did overnight, and
a build-in-public post. Say `review`, `nightshift` or `post` to see one."

If the user picks one, read `demo/review.md`, `demo/nightshift.md` or
`demo/post.md` and show it verbatim the same way, then repeat the offer for
the ones not yet shown. Never run the real command for these: in the demo,
`review`, `nightshift` and `post` mean the sample files.

## 3. Make it yours

End the first demo reply with this section, as markdown (not in a code
block), worded as below:

**Make it yours**
- Run `/devbrief` for your real brief. It finds the git repos in your home folder on its own.
- Run `node scripts/collect.mjs --init` (from the skill folder) to exclude, rename or add projects.
- Everything else: https://github.com/WaleedOH/devbrief#readme
