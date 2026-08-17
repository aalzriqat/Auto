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
pnpm deploy:prod                       # guarded production deploy
pnpm deploy:prod --rollback-to <sha>   # deliberate rollback to an older merged commit
pnpm dev:push                          # one-shot push to the dev deployment
```

Use `pnpm deploy:prod`, not `npx convex deploy`.

**What it deploys is not your working directory.** The wrapper resolves one
exact commit — `origin/main`'s tip, or the commit you name for a rollback —
exports it into a brand-new temporary directory, installs that commit's own
locked dependencies there, and runs the Convex CLI from inside it. Your worktree
is never read as a bundle input, so an untracked file, a `.gitignore`d one, or a
file you create mid-deploy cannot become part of what ships.

⚠️ **It is not a sandbox, and the earlier version of this paragraph overstated
it.** It said "nothing on your disk can reach production", and a reviewer
falsified that in one pass: Node honours `NODE_OPTIONS=--require`, so an
inherited environment could preload code into the CLI that writes into the
checkout after every check had passed. The wrapper now builds a minimal child
environment, but the honest boundary is narrower than the original sentence —
this reduces what reaches production to the approved commit plus whatever your
own account can do to a directory it owns. A subverted `git`, `pnpm` or `node`
is out of scope.

That matters more than it sounds. Convex bundles from disk and follows relative
imports **out** of `convex/` — real modules do this today — and esbuild resolves
`.tsx` before `.ts`, so an untracked `lib/helper.tsx` would silently replace a
reviewed `lib/helper.ts`. Checking git status cannot see either problem. Not
reading the directory at all can.

Before anything is prepared it refuses a dirty tree, a commit that is not
contained in `origin/main`, and any deployable file under `convex/` that git
does not track. That last check now means the opposite of what it used to: an
uncommitted file there will **not** ship, and shipping less than you are looking
at is its own kind of surprise.

Then it shows you both the deployment name and the commit SHA, read out of the
CLI's own announcement, and makes you type the deployment name before pushing.
If the dry run announces no deployment, or more than one, it refuses rather than
guessing which is real.

For a rollback, `--rollback-to <sha>` deploys an older commit that is still
contained in `origin/main`. It goes back to something that was reviewed, never
sideways to something that was not.

**Why any of this exists.** On 2026-08-07 `npx convex deploy -y` put unmerged
code and an untracked scratch module on production, and the Social Inbox
reported zero conversations for an org holding over a thousand live events.
`-y` — undocumented in `--help` — suppresses the confirmation that names the
production deployment.

⚠️ **The wrapper is advisory, not binding.** The raw CLI still works and the
production credential is on developer machines, so this depends on reaching for
the right command. Making production unreachable from a workstation means a
CI-mediated deploy against a protected environment, which is a separate change
this does not attempt.
