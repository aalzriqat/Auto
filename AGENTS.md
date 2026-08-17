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

Production is deployed by running the **Deploy production** workflow from the
Actions tab, on `main`.

```
Actions → Deploy production → Run workflow (from: main)
  commit_sha  the exact full 40-character SHA — must be main's current tip
  confirm     DEPLOY TO PRODUCTION
```

**This is intended to be the only way, and it is not yet the only way.** A
production deploy key still exists on a developer workstation, where
`npx convex deploy` reaches production directly and none of what follows applies
to it. That is tracked as the local-credential cleanup below, and until it is
done this workflow is *a* path rather than *the* path.

**There is no rollback mode.** Any older commit predates this verification
tooling, so a "rollback" would deploy and then verify nothing while reporting
success. To undo something, merge a revert and deploy that through this same
path with the full checks. Versioned rollback compatibility is separate work.

### What it actually guarantees

The verification job holds **no secret from the `production` environment** — it
declares no `environment:`, so those secrets do not exist in it. (Repository-level
secrets are visible to every job regardless, which is exactly why SCRUM-125
matters.) It refuses an abbreviated SHA, a commit that is not contained in
`main`, anything that is not `main`'s current tip, a wrong confirmation phrase,
and dispatch from a branch.

That job runs `main`'s copy of its own logic rather than the candidate commit's,
so **the commit being deployed cannot ship its own approval**. Dispatching from
a branch is refused by that same logic — which the branch could have edited, so
treat it as a guard on mistakes, not as the boundary.

**CI must be green at that exact commit.** Ancestry proves a commit was merged,
not that the merge was healthy. Both the check-runs API and the commit-status API
are read, because a check present in one is invisible to the other.

⚠️ **A check is identified by its producer *and* its name, never by name alone.**
This repository has two check-runs called `osv-scanner`: one is Advanced
Security's real result, the other a `security.yml` job that reports success
whatever it finds. Requiring "osv-scanner" gated on whichever arrived second. So
`.github/release-waivers.json` names `{producer, name}` pairs, **zero matches is
a refusal and more than one is a refusal**, and only checks that genuinely fail
when their protected condition fails are listed. Report-only jobs are recorded
there as informational, with the reason, so they are not re-added by someone who
sees a green tick with a scanner's name on it.

Known-red checks are waived in that same file with an issue and an expiry. They
are reported as **WAIVED**, never as passing; an expired waiver fails the
release; and a waiver excuses a **result**, never the absence of one — a renamed
or deleted check still refuses.

The deploy job then checks out the exact SHA, asserts `HEAD` matches, and —
**after approval, immediately before deploying** — re-derives both `main`'s tip
*and* the CI verdict. Approval is asynchronous: a run can wait hours, and in that
window a check can be re-run red or a waiver can expire without `main` moving at
all. It then refuses any credential that does not address the expected
deployment, installs from the frozen lockfile, and invokes the Convex CLI out of
that commit's own `node_modules`.

**Both credentials must name one exact deployment.** "Is it a production key" is
not the question: a valid production key for the *wrong* project deploys,
verifies and reports success there exactly as confidently. `CONVEX_PROD_DEPLOYMENT`
names the target and each key is required to address it. (The two are also
compared with each other, but that comparison is unreachable as written — both
are checked against the same expected name, so two keys that each pass are
already equal. It is an invariant against a future edit, not what protects
today.) After deploying, the backend states its own identity
(`CONVEX_CLOUD_URL`) over the same connection the verification uses, so the check
is an observation rather than a log line.

It then starts the Social Inbox conversation backfills and refuses to finish
until every organization is provably reading the materialised path — checked
**per platform**, because an org-wide probe lets Facebook's rows answer for
Instagram's missing ones, and a confidently empty Instagram inbox is the original
incident surviving the guard written for it.

Backfills run in the same job on purpose. Between the code landing and the
backfills completing, database I/O goes **up**: the conversation trigger adds a
read and a write per inbound webhook while every inbox is still served by the
legacy full scan. Splitting the two across manually resumed sessions leaves
production in that state for the length of the gap.

### ⚠️ Everything this prints is public

This repository is public, so its Actions logs and job summaries are public too —
including anything `convex deploy` itself prints.

Organizations appear as stable opaque hashes, never by name or document id. The
org **name** is not merely unprinted, it is stripped in Convex: the release query
returns an explicit allowlist of fields, so `orgName` never leaves the backend
and a field added to the shared report later cannot join the payload by default.
The org id does come out, because a stable hash needs a stable input, and
`opaqueOrgRef` is the only path from it to output.

Backend error text stays in the Convex logs. That means the stored
`failureMessage` (raw error output — SCRUM-119), *and* the Convex CLI's own
stderr, *and* anything that arrives on stdout when a response fails to parse:
each of those was or could have been a way for tenant data to reach a public log,
so none of them is reproduced. Failures give an exit code and a pointer to the
dashboard. Resolve a hash on the authenticated `/admin` materialisation screen.

### What it does not guarantee

**It is not a boundary until the environment is configured, and it is not
configured yet.** A GitHub environment with no protection rules gates nothing —
`environment: production` on a rule-less environment is a no-op and the job
starts immediately, like any other. This repository's `Production` environment
currently has `protection_rules: []`, no deployment-branch policy, and no
variables or secrets. Until that changes, **nothing above requires a second
person**, and the workflow refuses at the credential gate rather than deploying.
Verify with the query rather than from memory:

```bash
gh api repos/aalzriqat/Auto/environments/Production \
  --jq '{rules: [.protection_rules[].type], branches: .deployment_branch_policy}'
```

It is also only a boundary once the production credential exists **nowhere
else** — see the workstation key above.

The environment's required reviewer is the binding control — not the ref check,
not the input validation. Those are guards on an operator's mistakes.

**Commit statuses cannot be identified by producer.** The statuses API carries no
app slug, so nothing status-sourced is required; statuses are read only so that a
required check which moves surfaces is still seen. A live illustration of why the
identity matters: CodeRabbit posts `state=success` with the description *"Review
skipped: manual review required for this OSS repository"*.

### Required configuration (not in this repository)

The workflow is inert, and misleadingly so, until all of this exists:

| What | Where | Detail |
| --- | --- | --- |
| `production` environment | Settings → Environments | **Required reviewer**; self-review prevented; **admin bypass disabled**; **deployment branches restricted to `main`** |
| `CONVEX_PROD_DEPLOYMENT` | that environment's **variables** | The exact production deployment name, e.g. `kindly-hound-172`. Not a secret — it is an identifier, and naming it is the point |
| `CONVEX_PROD_DEPLOY_KEY` | that environment's secrets | Scoped to that deployment, permission `deployment:deploy` **only** |
| `CONVEX_PROD_OPERATOR_KEY` | that environment's secrets | `deployment:functions:runInternalMutations` + `runInternalQueries` **only** |

⚠️ **The names are deliberately not `CONVEX_DEPLOY_KEY`.** A repository-level
secret of that name still exists (SCRUM-125 removes it; `playwright.yml` now uses
`CONVEX_PREVIEW_DEPLOY_KEY` instead). Repository secrets are visible to every job,
so reusing the name would mean this workflow silently falling back to it whenever
the environment secret is missing — and a preview key makes `convex deploy` build
a **preview** deployment, which the verifier would then verify, reporting
"Production rollout verified" while production went untouched. Distinct names make
a missing secret resolve to empty and fail closed.

⚠️ **Verify the operator key's scope when you mint it.** That
`runInternalMutations`/`runInternalQueries`-only granularity is what makes the
verification step structurally unable to deploy. Convex enforces it server-side,
so nothing in this repository can confirm the dashboard offers exactly that
scope. If it cannot be minted that narrowly, say so — the property does not hold
and the claim has to be corrected rather than assumed.

Once a real run has succeeded, revoke the workstation production deploy key,
remove production deploy credentials from local env files, and use a
dev-deployment-scoped key for ordinary local work.

### The one thing only the first real run can settle

`assertDeploymentIdentity` requires the backend to report `CONVEX_CLOUD_URL`.
That variable is a Convex system variable available in the function runtime, and
its sibling `CONVEX_SITE_URL` is read by production code today — but
`convex-test` does not set either, so **no test in this repository proves the
real runtime provides it**. It is a first-release runtime gate, not something the
suite has closed.

The behaviour if it is absent is the safe one and is tested: the verifier refuses
rather than certifying a deployment that will not say which one it is. So the
first protected run either verifies the identity or fails closed — it cannot
quietly pass. Expect that outcome and read the refusal, rather than assuming a
green run proved the variable exists.

### When it fails

A failed rollout is reported as **deployed but incomplete**, never as a failed
deploy — those want different responses, and the workflow summary says which one
happened along with every outstanding organization. Re-running is safe: the
backfills skip organizations already proven complete, so a second run resumes
rather than restarting.
