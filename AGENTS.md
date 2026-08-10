<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## Deploying to production

```bash
pnpm deploy:prod      # guarded production deploy
pnpm dev:push         # one-shot push to the dev deployment
```

Use `pnpm deploy:prod`, not `npx convex deploy`. The wrapper refuses a dirty
tree, a commit that is not contained in `origin/main`, and any deployable file
under `convex/` that git does not track — that directory is bundled from disk,
so an untracked or `.gitignore`d module there ships exactly like committed code
while appearing in no diff, review or CI check. It also resolves the target with
a dry run and makes you type the deployment's name before pushing.

To deploy a commit that is merged but behind the tip — a deliberate rollback —
run `pnpm deploy:prod --allow-behind`. That flag excuses only the tip check. A
dirty tree, an untracked module under `convex/`, and unmerged code are still
refused, and a branch that has diverged from `origin/main` is not "behind" and
is not covered by it.

That last part is not redundant with Convex's own prompt. Convex asks only when
`CONVEX_DEPLOYMENT` names a *different* deployment than the target; it stays
silent when the variable already names production, and when `CONVEX_DEPLOY_KEY`
is set.

On 2026-08-07 `npx convex deploy -y` put unmerged code and an untracked scratch
module on production, and the Social Inbox reported zero conversations for an
org holding over a thousand live events. `-y` — undocumented in `--help` —
suppresses the confirmation that names the production deployment.

The wrapper is advisory. The raw CLI still works, so this depends on reaching
for the right command.
