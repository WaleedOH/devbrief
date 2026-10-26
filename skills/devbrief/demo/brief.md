# devbrief · 2026-10-26
Night shift: 2 draft PRs ready for review, 1 task stopped without a PR
- shop-api: Add request IDs to error logs (https://github.com/your-github-user/shop-api/pull/41)
- recipes-app: Update 3 dependencies to their latest patch versions (https://github.com/your-github-user/recipes-app/pull/18)
- landing: stopped, tests failed after the change (2 of 48 in form.test.js)

## Do first
1. **pixel-quest: Push your work (4 commits).** They exist only on this laptop, on no remote branch. If the laptop dies, they are gone.
2. **landing: Fix the failing CI on main.** "test" has failed since `Add signup form validation` on Saturday. The night shift tried a fix and stopped because 2 tests still failed.
3. **shop-api: Add rate limits to /checkout.** Top item under "Next" in docs/STATUS.md, on your most active project this week.

## Projects
- 🔴 **pixel-quest**: 4 commits on no remote → push them, then "Add the level select screen" (docs/NEXT.md).
- 🔴 **landing**: CI "test" failing on main → fix the signup form tests in form.test.js, then "Add the pricing section" (TODO.md).
- 🟡 **recipes-app**: status doc may be out of date (9 days behind the commits) → run `/devbrief wrap` there. Draft PR #18 from the night shift is waiting.
- 🟢 **shop-api**: draft PR #41 from the night shift is waiting; next is "Add rate limits to /checkout" (next for 6 days).
- 🟢 Quiet: old-prototype (superseded by shop-api), dotfiles.

## Since last brief
- New: landing ci-failing, pixel-quest local-only.
- Resolved: shop-api behind, recipes-app unpushed.
