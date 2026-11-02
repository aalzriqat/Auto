# The ACCOUNTANT cost-price backfill runs in the Deploy production rollout

Status: accepted. ADR required by SCRUM-760 c24361. Implements SCRUM-896.

## Context

PR #746 (SCRUM-886) makes every SOURCED sale completion door require `view:cost_price`, and adds that permission to the default
ACCOUNTANT template. A template change reaches an organization only when its roles are seeded, once, at creation
(`convex/organizations.ts`). An organization seeded before the change keeps a stored ACCOUNTANT role without the permission.
After #746 is deployed, that accountant is refused at `sales.create`, `sales.completeDraft`, `sales.completeFromQuote` and
`applications.finalizeDeal` for any SOURCED car, and is refused at `vehicles.correctAcquisitionCost`, until the stored role is
repaired.

The repair already exists: `migrateRoles:backfillAccountantCostPriceAccess` (internal, paginated 1 to 500 roles per call,
idempotent, adds only `view:cost_price`). Nothing calls it. The owner decision on when it runs was left open (c24365).

## Decision

Owner ruling SCRUM-886 c24372, 2026-11-02: "بعد النشر تلقائياً". In English: after the deploy, automatically.

The backfill runs inside the Deploy production rollout step (`scripts/rolloutRelease.mjs`), page by page through the operator
key until the backend reports `isDone`. It is phase 2e: after the supplier identity repair (2d) and before the Social Inbox
verification (3), under the same single deadline (`rolloutStartedAt` plus `ROLLOUT_TIMEOUT_MINUTES`) as every other phase. The
page cursor is held by the script and passed back as `continueCursor`. Pages are 100 roles; the script stops after 10,000
pages, which bounds one deployment at 1,000,000 role rows. Those constants, the function name, the `numItems` argument and the
public summary text live in `runAccountantCostPricePhase` in `scripts/releaseGuard.ts`, where tests execute them; the script
keeps only the phase skeleton (log, one call, publish the summary). The helper receives the script's own `fail` and calls it
on a refusal, because the script cannot be executed under coverage, so the phase body, refusal branch included, must live in
tested code.

Why the rollout step, and not another path:

| Option | Why not |
| --- | --- |
| A by-hand `npx convex run` | The owner declined it. It also depends on someone remembering, and the refusal it prevents starts at the deploy. |
| A cron | It would write tenant roles on a schedule nobody approved, and keep running after the work is done. |
| A migration on read (patch the role when it is loaded) | A read path would write permissions, hidden from the deploy record, and an org with no traffic is never repaired. |
| The rollout step | It already owns the operator key, the shared deadline, the page-by-page pattern, the public-log rules and the resumable re-run. Its result is visible on the deploy run. |

The phase must not run on the empty-deployment path. That path exits before phase 2, because a deployment with no
organizations has nothing to roll out. A wiring test pins the order: identity check, refusal, supplier VAT migration, empty
deployment branch, bank rebuild, supplier registry, supplier identity, this phase, then verification.

### Predicate narrowed to sale-completing ACCOUNTANT roles (Seat 1 R1-F1, Seat 2 R3-F1, ccd2f7647)

Invariant: once an organization owner has saved or created a role, its permissions change only through an owner action or a
one-time repair the owner approved, never through a recurring system job.

The first version of this decision granted `view:cost_price` to every non-deleted role named ACCOUNTANT. That was safe as a
one-time by-hand run and unsafe as a per-deploy job. Seat 1's chain: deploy N repairs the legacy ACCOUNTANT; the owner then saves
the role without `view:cost_price` and without `create:sales` and `confirm:finance_disbursement` (Rule 3 accepts that, since no
completing permission remains); deploy N+1 patches it back, silently, with a counts-only public summary. Seat 2 reproduced the
same defect through the name: a custom role named ACCOUNTANT (the default renamed and a new one created, a custom role renamed to
ACCOUNTANT, or the default deleted and the name recreated) was granted `view:cost_price`. With `manage:finance` that opens the
GL-posting `vehicles.correctAcquisitionCost` door and the correction context query, and `view:cost_price` alone opens the cost
read in `vehicles.get`.

Decision (Option A, adopted by the coordinator): the mutation repairs a role only when its normalized name is ACCOUNTANT, it is
not deleted, it holds a sale-completing permission (`SALE_COMPLETING_PERMISSIONS`: `create:sales`,
`confirm:finance_disbursement`) and it lacks `view:cost_price`. The mutation calls `completesSalesWithoutCostAccess`, the
function Rule 3 uses to refuse a role save, so the repaired set is exactly the set Rule 3 calls invalid and the completion doors
refuse. A role the owner deliberately left without both a completing permission and cost access is valid, and is not touched, so
running on every deploy is safe by construction. The legacy default template holds `confirm:finance_disbursement`, so it is
still repaired. Owner rulings c24372 (after the deploy, automatically) and c24358 are unchanged. The rollout script, its phase
order and the permission list are not edited.

Alternatives not taken: tracking "repaired once" per organization needs a new table or a role field and a schema change for a
fact the permissions already show; matching on a role id list taken at the first deploy needs state outside the deployment;
dropping the automatic run contradicts c24372.

Disclosed limit: the name cannot tell a custom role from the legacy default when both hold a completing permission without
`view:cost_price`. Only a role stored before round 13 can be in that state, because `roles.create` and `roles.update` refuse it.

### What is not changed

- A custom role and a renamed ACCOUNTANT role are untouched. The mutation matches the normalized role name `ACCOUNTANT`.
- An ACCOUNTANT role that holds no sale-completing permission is untouched, whatever else it holds.
- A deleted role row is never written.
- No other permission is granted, and nothing is revoked.
- The rollout script and its wiring are not edited. The mutation's predicate is the only backend change in this round.
- `convex/utils/customerCreditPayoutContainment.ts` and its compile-time switches are not touched.

### Public logs

This repository is public, so the job log and the job summary are public. The mutation's `updates` array carries one line per
patched role, with the role name and organization id. The script must not print it and must not write it to the job summary.
The helper checks that `updates` is an array whose length equals `updatedCount` and never copies an element. No refusal reason copies backend output,
and a failed call uses the shared helper that is never given the CLI's output. The summary gets counts only: how many roles
were granted the permission and in how many page calls.

### Failure semantics

A failed call, a malformed page, a cursor that does not advance, the page cap and the shared deadline each end the run
through `fail()` with a message that starts "Production is DEPLOYED, but". The run is reported as deployed but incomplete, as
for the other phases. A re-run resumes safely: a role that already holds the grant is not written, so the second pass patches
nothing it already patched. Because the phase runs before the Social Inbox verification, a refusal here stops the run
before that verification does.

A page can be short or empty before `isDone` is true (Convex pagination makes no promise about page size). The helper
therefore treats only `isDone` as the end, and refuses only a cursor that comes back unchanged.

The phase runs on the shared cursor walker (`walkCursorPages` in `scripts/releaseGuard.ts`), the loop the supplier registry
phases already use. The walker checks the shared deadline before and after every page call, so a page whose call returns past
the deadline is refused instead of accepted as complete. The phase supplies only its refusal label and its page parser. The
other hand-written loops (the bank balance rebuild, the supplier VAT hold recovery and the supplier identity phases) do not use
the walker yet; moving them onto it is follow-up work.

## Class table: every door through which `view:cost_price` reaches a stored role

| Door | Who authorizes it | Affects |
| --- | --- | --- |
| Template seeding at organization creation (`organizations.ts`, from `DEFAULT_ROLE_TEMPLATES`) | The product, through code review of the template | New organizations only: OWNER, MANAGER, ACCOUNTANT, SENIOR_ACCOUNTANT |
| `roles.create` and `roles.update` | The organization's OWNER (both call `requireOwner`). Saving a completing permission without `view:cost_price` is refused (c24358). | One role at a time, any name |
| This backfill, in the deploy rollout | The owner, c24372 | Every stored, non-deleted role named ACCOUNTANT that holds a sale-completing permission without `view:cost_price`; idempotent, and an owner's later restriction is left alone |
| `migrateRoles:backfillSeniorAccountantRole` insert (copies the SENIOR_ACCOUNTANT template) | Run by hand with owner approval, as before. Not part of this change. | Inserts a missing SENIOR_ACCOUNTANT role |
| `e2eBootstrap` role patches | Test environments only | Not a production door |
| The older `migrateRoles.ts` backfills (view:users, finance application, marketplace, expense, valuation, payroll) | Run by hand with owner approval, as before | None of them grants `view:cost_price` |

## Consequences

An organization seeded before #746 gets its ACCOUNTANT role repaired by the first Deploy production that contains this
change, in the same run that deploys the backend. The permission change reaches production roles without a person running
anything, so the evidence is the deploy run: the summary section states how many roles were granted and in how many calls.

Ordering for the release train: this change must merge before the next Deploy production that contains #746. Otherwise that
deploy ships the refusal and the repair separately, and an affected accountant is refused at every SOURCED completion door
until the next deploy. Train position: after #746, before #740.

A legacy ACCOUNTANT role that is repaired also passes the `vehicles.correctAcquisitionCost` gate (`manage:finance` plus
`view:cost_price`). The owner allowed that for the default ACCOUNTANT (c24368, option A). The backfill extends it to the
stored roles named ACCOUNTANT that hold a sale-completing permission, which is the legacy default role.

## Evidence

Failing-first tests in `scripts/accountantCostPriceRollout.test.ts` cover paging and cursor order, idempotent re-run,
malformed pages, failed calls, the no-leak rule for `updates`, the page cap, the shared deadline and the wiring order.
Backend behavior of the mutation (idempotency, bounded pages, name matching) is covered by the existing permission scenario
`accountant-backfill-adds-view-cost-price-idempotently-and-in-bounded-pages`. The predicate narrowing (R1-F1, R3-F1) is covered
by the describe "SCRUM-896 R1-F1 / R3-F1" in `convex/consignedSaleCostAccessRule.scrum886.test.ts` (red at a79d324b3, 6 of 47
failed; two mutants killed 6 and 9) and by the scenario records `accountant-backfill-leaves-an-owner-restricted-accountant-alone`
and `accountant-backfill-does-not-grant-a-renamed-or-recreated-custom-accountant`. Nothing in this change was run against a
deployment. The first real run is the production deploy, so the first run is where the real page sequence is observed.

Sources checked: the Convex pagination documentation (`continueCursor` and `isDone` semantics, pages not guaranteed to match
`numItems`; the repository copy is `convex/_generated/ai/guidelines.md`), GitHub's secure-use guidance on secrets in logs
(redaction is not guaranteed, so the script never prints backend text), and this repository's `AGENTS.md` rollout rules (the
repository is public, so the logs are public).
