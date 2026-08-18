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

⚠️ **That job does NOT protect you from the commit it is judging, and an earlier
version of this file claimed it did.** It checks out `github.ref` — `main` — and
the workflow only ever deploys `main`'s tip, so main's copy of the verification
logic *is* the candidate's copy. There is no separation between them to rely on.
Dispatching from a branch is refused by that same logic, which the branch could
have edited. Every check in this repository is a guard on an operator's
mistakes; **the boundary is the environment approval**, and nothing here.

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

The deploy job then checks out the exact SHA, asserts `HEAD` matches, and
installs from the frozen lockfile. **After approval** it re-derives `main`'s tip,
then the CI verdict, then refuses any credential that does not address the
expected deployment, then invokes the Convex CLI out of that commit's own
`node_modules` — in that order, which is load-bearing and pinned by a test.
Approval is asynchronous: a run can wait hours, and in that window a check can be
re-run red or a waiver can expire without `main` moving at all.

The tip is checked once more **inside the deploy step, on the line before the
CLI call**. ⚠️ Read that guarantee precisely: it is *main's tip as observed
immediately before the deploy*, not *main's tip at the instant of deploy*. A
merge landing in the moment between the check and the call is undetectable, by
this or any other arrangement. What the second check buys is shrinking that gap
from several steps — CI re-verification and credential assertion both sit in it —
down to a single command.

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
until every organization reports every platform `completed` at the current
generation, resolves to the materialised reader, and — where a platform claims
it materialised rows — actually has one. That last check is **per platform**,
because an org-wide probe lets Facebook's rows answer for Instagram's missing
ones, and a confidently empty Instagram inbox is the original incident surviving
the guard written for it.

⚠️ **A platform that materialised *nothing* is reported, not refused**, so
"every organization is verified" does not mean "every organization has
conversations". `syncThreadsInBackfillPage` legitimately skips events with no
`customerId`, so an org whose events are all unlinked completes having
materialised zero — indistinguishable, with the counts available today, from the
2026-08-07 failure. Refusing it would also be unrecoverable, because the fan-out
skips orgs already `completed`. SCRUM-126 adds the materializable-event count
that would make this enforceable; until then it is an anomaly in the summary and
a human decides.

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

#### ⚠️ There is no second person, and by design there will not be one

**`prevent_self_review` is `false`, permanently and deliberately.** `aalzriqat`
is the repository's only collaborator and the owner does not intend to add
another, so the sole possible reviewer is the same person who dispatches the run.
With self-review prevented, nobody could ever approve and the workflow would be
permanently unrunnable. Owner decision, 2026-08-18.

Do not treat this as a gap awaiting closure, and do not "fix" it by enabling the
setting — that turns the deploy path off. It is a standing constraint of a
single-maintainer repository.

So do not read the approval gate as independent review. What it actually
provides:

- production credentials are unreachable until an explicit, separately recorded
  approval action — a run cannot deploy by simply starting;
- deployments are refused from any ref other than `main`;
- administrators cannot bypass it;
- there is an audit trail naming who approved which run against which commit.

What it does **not** provide is a second pair of eyes. Getting that would require
adding a second collaborator and then setting `prevent_self_review: true`; there
is no configuration of a single-maintainer repository that produces it, and that
is an accepted trade rather than an outstanding task.

Verify the current state with the query rather than from memory — including
after any change to collaborators:

```bash
gh api repos/aalzriqat/Auto/environments/Production \
  --jq '{rules: [.protection_rules[].type],
         reviewers: [.protection_rules[] | select(.type=="required_reviewers") | .reviewers[].reviewer.login],
         self_review_prevented: [.protection_rules[] | select(.type=="required_reviewers") | .prevent_self_review][0],
         admins_bypass: .can_admins_bypass}'
gh api repos/aalzriqat/Auto/environments/Production/deployment-branch-policies --jq '.branch_policies[].name'
```

The environment approval is the binding control — not the ref check, not the
input validation, not the verification job. Those are guards on an operator's
mistakes.

⚠️ The workflow names the environment in lower case (`environment: production`)
while GitHub stores it as `Production`. That resolves to the same environment —
verified by `gh api repos/aalzriqat/Auto/environments/production`, which returns
the configured `Production` and creates nothing new — so the rules above do
apply. Had it not resolved, the job would have silently created a rule-less
environment and gated on nothing.

It is also only a boundary once the production credential exists **nowhere
else** — see the workstation key above.

**Commit statuses cannot be identified by producer.** The statuses API carries no
app slug, so nothing status-sourced is required; statuses are read only so that a
required check which moves surfaces is still seen. A live illustration of why the
identity matters: CodeRabbit posts `state=success` with the description *"Review
skipped: manual review required for this OSS repository"*.

### Configuration — complete as of 2026-08-18

⚠️ **This workflow is now ARMED.** Every credential it needs exists. A
`workflow_dispatch` that passes the checks and receives approval will deploy the
Convex backend to production and then mutate production data via the backfills.
Until 2026-08-18 it refused at the credential gate no matter what; that is no
longer true, and reviews of it should be read with that in mind.

| What | Where | State | Detail |
| --- | --- | --- | --- |
| `Production` environment | Settings → Environments | ✅ | Required reviewer `aalzriqat`; branches restricted to `main`; admin bypass disabled. **Self-review NOT prevented** — see above |
| `CONVEX_PROD_DEPLOYMENT` | that environment's **variables** | ✅ | `kindly-hound-172`. Not a secret — it is an identifier, and naming it is the point |
| `CONVEX_PROD_DEPLOY_KEY` | that environment's secrets | ✅ | Intended scope: that deployment, permission `deployment:deploy` **only** |
| `CONVEX_PROD_OPERATOR_KEY` | that environment's secrets | ✅ | Intended scope: `deployment:functions:runInternalMutations` + `runInternalQueries` **only** |
| `CONVEX_PREVIEW_DEPLOY_KEY` | **repository** secrets | ✅ | Not used by this workflow; `playwright.yml` reads it |

Verify presence — never values — with:

```bash
gh api repos/aalzriqat/Auto/environments/Production/secrets --jq '.secrets[].name'
gh api repos/aalzriqat/Auto/environments/Production/variables --jq '.variables[] | "\(.name) = \(.value)"'
```

⚠️ These keys are minted in the Convex dashboard. The CLI has no command that
creates one (checked: no `key`, `token` or `auth` subcommand), so provisioning
and rotation are manual by necessity, not by choice.

⚠️ **The operator key's SCOPE is unverified and unverifiable from here.** The
table says *intended* scope for a reason: Convex enforces key permissions
server-side, nothing in this repository can read a secret's scope, and the first
protected run is the first moment anything could demonstrate it. If that key was
minted broader than `runInternalMutations`/`runInternalQueries`, then the
separation between the deploy step and the rollout step is organisational rather
than structural — the rollout step would be *able* to deploy, it simply does not.
Treat the structural claim as unproven until a real run establishes it.

### Still outstanding

`CONVEX_DEPLOY_KEY` remains a **repository-level** secret. This branch repointed
`playwright.yml` at `CONVEX_PREVIEW_DEPLOY_KEY`, but `main`'s copy still reads the
old name, so it cannot be removed until this PR merges. Order: merge → delete the
repository secret → revoke the underlying Convex credential (SCRUM-125). Deleting
it first breaks E2E on `main` and destroys a credential that cannot be recreated
from a shell.

The workstation production deploy key also still exists — see the top of this
section. Until it is revoked, `npx convex deploy` from a laptop reaches
production and none of this applies to it.

⚠️ **The names are deliberately not `CONVEX_DEPLOY_KEY`.** A repository-level
secret of that name still exists (SCRUM-125 removes it; `playwright.yml` now uses
`CONVEX_PREVIEW_DEPLOY_KEY` instead). Repository secrets are visible to every job,
so reusing the name would mean this workflow silently falling back to it whenever
the environment secret is missing — and a preview key makes `convex deploy` build
a **preview** deployment, which the verifier would then verify, reporting
"Production rollout verified" while production went untouched. Distinct names make
a missing secret resolve to empty and fail closed.

Once a real run has succeeded, revoke the workstation production deploy key,
remove production deploy credentials from local env files, and use a
dev-deployment-scoped key for ordinary local work.

### The two things only the first real run can settle

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

The second is the **operator key's scope**, for the same reason from the other
direction. "This step holds only the operator key, so it structurally cannot
deploy" is a claim about how that key was minted, enforced by Convex's servers
and invisible to everything here. Nothing in the suite tests it and nothing can.
If the dashboard could not mint it as narrowly as the table above intends, the
separation is organisational rather than structural and that sentence has to be
corrected — not assumed because the run went green.

### ⚠️ A green CI is not guaranteed to stay green

`unit-and-integration` intermittently fails with **zero failing tests** — a vitest
worker-teardown race (`Closing rpc while "onUserConsoleLog" was pending`) that
names a different Convex suite each time and passes on re-run. `sonarcloud` runs
the same vitest invocation for coverage, so one race can take out two required
checks at once. See **SCRUM-140**.

The gate is evaluated twice — in `authorize`, and again after approval — so a
flake in either window refuses the release. That is fail-closed and correct. It
does mean a release can need a CI re-run for reasons that have nothing to do with
the release, and the right response is to re-run the job and read the result, not
to loosen the required list.

### When it fails

A failed rollout is reported as **deployed but incomplete**, never as a failed
deploy — those want different responses, and the workflow summary says which one
happened along with every outstanding organization. Re-running is safe: the
backfills skip organizations already proven complete, so a second run resumes
rather than restarting.
