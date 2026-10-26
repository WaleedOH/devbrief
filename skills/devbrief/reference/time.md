# /devbrief with a time budget

The user gives a time budget, for example `/devbrief 40m`, `/devbrief 2h` or
`/devbrief 1h30`. Answer the question "what is the best use of this time?"

## 1. Read the budget

Turn it into minutes: `40m` = 40, `2h` = 120, `1h30` = 90, `1.5h` = 90. If it
cannot be read, ask once instead of guessing.

## 2. Collect

Run the normal collection and checks (steps 1 and 2 of the brief). Use the
same ranking rules as the brief to list candidate actions: flags, failing CI,
security problems, open PRs and each project's status-doc items. Respect
`notes`: paused projects give no candidates.

## 3. Size each action

Estimate each action from cues in the facts and in the item's own wording:

| Size | Time | Typical cues |
|---|---|---|
| S | up to 15 min | pull, push, commit what is there, merge a green PR, a settings toggle, revoke a grant, rename, typo, copy or config change |
| M | up to 45 min | fix failing CI, review a PR, fix a bug with a clear cause, write a test, small UI tweak, update a dependency |
| L | over 45 min | new feature or page, "add", "build", "redesign", migration, anything vague or with several steps |

Count S as 15, M as 45 and L as 90 minutes when adding up. If an L item can be
split into a first step that fits (for example "sketch the schema" for "add
search"), offer that step as an M, worded as such. Never invent tasks beyond
that.

## 4. Pick the set

Go down the ranked list, highest value first, and take each action that still
fits in what is left of the budget. Keep about 10% of the budget free for
context switching when the set spans more than one project. Prefer finishing
one project's items over touching many.

```
# devbrief · <date> · <budget>

## In <budget>
1. **<project>: <action>** (S, ~15 min). <why, one line>
2. ...
Total: ~<n> min of <budget>.

## Doesn't fit today
- <project>: <action> (L, ~90 min+)
```

Always include the "Doesn't fit today" line, even if it is just "nothing
important left out". Say once, briefly, that the sizes are rough estimates
from the wording, not measured.
