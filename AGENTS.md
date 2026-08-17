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
  commit_sha  the exact full 40-character SHA — must be main's current tip
  confirm     DEPLOY TO PRODUCTION
```

Then someone other than you approves the `production` environment, and only at
that moment does the run gain access to a Convex credential.

**There is no rollback mode.** Any older commit predates this verification
tooling, so a "rollback" would deploy and then verify nothing while reporting
success. To undo something, merge a revert and deploy that through this same
path with the full checks. Versioned rollback compatibility is separate work.

### What it actually guarantees

The verification job holds **no** production secret. It refuses an abbreviated
SHA, a commit that is not contained in `main`, anything that is not `main`'s
current tip, a wrong confirmation phrase, and dispatch from a branch. It also
requires **CI to be green at that exact commit** — ancestry proves a commit was
merged, not that the merge was healthy — reading both the check-runs API and the
commit-status API, because a check present in one is invisible to the other.

Known-red checks are declared in `.github/release-waivers.json` with an issue and
an expiry. They are reported as **WAIVED**, never as passing, and an expired
waiver fails the release rather than quietly becoming a lower standard.

That job runs `main`'s copy of its own logic rather than the candidate commit's,
so a commit cannot ship its own approval.

The deploy job then checks out the exact SHA, asserts `HEAD` matches, re-derives
`main`'s tip from the API **immediately before deploying** (approval is
asynchronous — a run can wait hours), refuses any credential that does not
address the expected deployment, installs from the frozen lockfile, and invokes
the Convex CLI out of that commit's own `node_modules`.

**Both credentials must name one exact deployment.** "Is it a production key" is
not the question: a valid production key for the *wrong* project deploys,
verifies and reports success there exactly as confidently. `CONVEX_PROD_DEPLOYMENT`
names the target, both keys must address it, and they must agree with each other
— otherwise the run would deploy to one deployment and verify another. After
deploying, the backend states its own identity (`CONVEX_CLOUD_URL`) over the same
connection the verification uses, so the check is an observation rather than a
log line.

It then starts the Social Inbox conversation backfills and refuses to finish
until every organization is provably reading the materialised path.

Backfills run in the same job on purpose. Between the code landing and the
backfills completing, database I/O goes **up**: the conversation trigger adds a
read and a write per inbound webhook while every inbox is still served by the
legacy full scan. Splitting the two across manually resumed sessions leaves
production in that state for the length of the gap.

### ⚠️ Everything this prints is public

This repository is public, so its Actions logs, job summaries and artifacts are
public too. Organizations therefore appear as stable opaque hashes, never by
name or document id, and backend error text never leaves the Convex logs — the
stored `failureMessage` is raw error output. Resolve a hash on the authenticated
`/admin` materialisation screen, which exists for exactly that question.

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
laptop still reaches production and none of the above applies to it.

The environment's required reviewer is the binding control — not the ref check,
not the input validation. Those are guards on an operator's mistakes.

### Required configuration (not in this repository)

The workflow is inert, and misleadingly so, until all of this exists:

| What | Where | Detail |
| --- | --- | --- |
| `production` environment | Settings → Environments | **Required reviewer**; self-review prevented; **admin bypass disabled**; **deployment branches restricted to `main`** |
| `CONVEX_PROD_DEPLOYMENT` | that environment's **variables** | The exact production deployment name, e.g. `kindly-hound-172`. Not a secret — it is an identifier, and naming it is the point |
| `CONVEX_PROD_DEPLOY_KEY` | that environment's secrets | Scoped to that deployment, permission `deployment:deploy` **only** |
| `CONVEX_PROD_OPERATOR_KEY` | that environment's secrets | `deployment:functions:runInternalMutations` + `runInternalQueries` **only** |

⚠️ **The names are deliberately not `CONVEX_DEPLOY_KEY`.** A repository-level
secret of that name exists and `playwright.yml` consumes it. Repository secrets
are visible to every job, so reusing the name would mean this workflow silently
falling back to it whenever the environment secret is missing — and a preview key
makes `convex deploy` build a **preview** deployment, which the verifier would
then verify, reporting "Production rollout verified" while production went
untouched. Distinct names make a missing secret resolve to empty and fail closed.

⚠️ **Verify the operator key's scope when you mint it.** That
`runInternalMutations`/`runInternalQueries`-only granularity is what makes the
verification step structurally unable to deploy. Convex enforces it server-side,
so nothing in this repository can confirm the dashboard offers exactly that
scope. If it cannot be minted that narrowly, say so — the property does not hold
and the claim has to be corrected rather than assumed.

Once a real run has succeeded, revoke the workstation production deploy key,
remove production deploy credentials from local env files, and use a
dev-deployment-scoped key for ordinary local work.

### When it fails

A failed rollout is reported as **deployed but incomplete**, never as a failed
deploy — those want different responses, and the workflow summary says which one
happened along with every outstanding organization. Re-running is safe: the
backfills skip organizations already proven complete, so a second run resumes
rather than restarting.
