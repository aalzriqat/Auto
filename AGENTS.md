<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->

## Deploying the Convex backend to production

**There is no local command for this, and that is the point.** Production is
deployed by running the **Deploy production** workflow from the Actions tab, on
`main`, and it needs a second person to approve it.

```
Actions → Deploy production → Run workflow (from: main)
  commit_sha  the exact full 40-character SHA (abbreviations are refused)
  confirm     DEPLOY TO PRODUCTION
  mode        deploy   — main's current tip
              rollback — an older commit already merged into main
```

Then someone other than you approves the `production` environment, and only at
that moment does the run gain access to a Convex credential.

### What it actually guarantees

The verification job holds **no** production secret. It refuses an abbreviated
SHA, a commit that is not contained in `main`, a `deploy` that is not `main`'s
tip, and a `rollback` whose target *is* the tip — all before any credential
exists in the run. It also runs `main`'s copy of that logic rather than the
candidate commit's, so a commit cannot ship its own approval.

The deploy job checks out the exact SHA, **independently re-derives** from the
GitHub API that the commit is contained in `main` (and, for a normal deploy,
that `main` has not moved while the run sat waiting for approval), refuses any
credential not provably scoped to a production deployment, installs from the
frozen lockfile, and invokes the Convex CLI out of that commit's own
`node_modules`.

For a normal deploy it then, in the same job, starts the Social Inbox
conversation backfills and refuses to finish until every organization is
provably reading the materialised path.

Backfills run in the same job on purpose. Between the code landing and the
backfills completing, database I/O goes **up**: the conversation trigger adds a
read and a write per inbound webhook while every inbox is still served by the
legacy full scan. Splitting the two across manually resumed sessions leaves
production in that state for the length of the gap.

**A rollback does not run that step, and does not verify anything.** A rollback
target predates this tooling — today every rollback target does — so both the
script and the Convex function it calls are absent from the tree and from the
backend it just deployed. Running the current backfill against rolled-back code
would also be the forward-only-fence hazard recorded in SCRUM-110. The run
summary says so explicitly rather than letting a green run read as a verified
one; check the Social Inbox by hand afterwards.

### What it does not guarantee

**It is not a boundary until the environment is configured, and it is not
configured yet.** A GitHub environment with no protection rules gates nothing —
`environment: production` on a rule-less environment is a no-op and the job
starts immediately, like any other. This repository's `Production` environment
currently has `protection_rules: []` and no deployment-branch policy. Verify
before trusting it, with the query rather than from memory:

```bash
gh api repos/aalzriqat/Auto/environments/Production \
  --jq '{rules: [.protection_rules[].type], branches: .deployment_branch_policy}'
```

It is also only a boundary once the production credential exists **nowhere
else**. Until the workstation deploy key is revoked, `npx convex deploy` from a
laptop still reaches production and none of the above applies to it. The
workflow is the safe route; removing the unsafe one is a separate, deliberate
act.

The environment's required reviewer is the binding control — not the ref check,
not the input validation. Those are guards on an operator's mistakes. A person
approving a specific run against a specific commit is what makes the credential
unreachable to anything they did not agree to.

### Required configuration (not in this repository)

The workflow is inert, and misleadingly so, until all of this exists:

| What | Where | Detail |
| --- | --- | --- |
| `production` environment | Settings → Environments | **Required reviewer**; prevent self-review where available; **deployment branches restricted to `main`** |
| `CONVEX_PROD_DEPLOY_KEY` | that environment's secrets | Scoped to the production deployment, permission `deployment:deploy` **only** |
| `CONVEX_PROD_OPERATOR_KEY` | that environment's secrets | `deployment:functions:runInternalMutations` + `runInternalQueries` **only** |

⚠️ **The names are deliberately not `CONVEX_DEPLOY_KEY`.** A repository-level
secret of that name already exists and `playwright.yml` consumes it on every
pull request using Convex's preview-deploy flags. Repository secrets are visible
to every job, so reusing the name would mean this workflow silently falling back
to that key whenever the environment secret is missing — and a preview key makes
`convex deploy` build a **preview** deployment, which the verifier would then
verify, reporting "Production rollout verified" while production went untouched.
Distinct names make a missing secret resolve to empty and fail closed. The
workflow also refuses any key whose shape is not `prod:<deployment>|…`.

⚠️ **Verify the operator key's scope when you mint it.** That
`runInternalMutations`/`runInternalQueries`-only granularity is what makes the
verification step structurally unable to deploy. Convex enforces it server-side,
so nothing in this repository can confirm the dashboard offers exactly that
scope. If it cannot be minted that narrowly, say so — the "a verifier that can
mutate is a verifier that can make itself pass" property does not hold, and the
claim above has to be corrected rather than assumed.

⚠️ The deployment-scoped key is what selects the target — there is no
environment variable that could point it elsewhere. That is deliberate: on
2026-08-07 `CONVEX_DEPLOYMENT=dev:vibrant-cat-418 npx convex deploy` reached
**production**, because `convex deploy` ignores that variable, and it carried
unmerged code plus an untracked scratch module with it. The Social Inbox then
reported zero conversations for an org holding 347 Instagram and 689 Facebook
events — no throw, no log.

Once a real run has succeeded, revoke the workstation production deploy key,
remove production deploy credentials from local env files, and use a
dev-deployment-scoped key for ordinary local work.

### When it fails

A failed rollout is reported as **deployed but incomplete**, never as a failed
deploy — those want different responses, and the workflow summary says which
one happened along with every organization still outstanding. Re-running is
safe: the backfills skip organizations already proven complete, so a second run
resumes rather than restarting.
