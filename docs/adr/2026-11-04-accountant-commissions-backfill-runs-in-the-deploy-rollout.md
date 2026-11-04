# ACCOUNTANT commission visibility and one-shot rollout provenance

Date: 2026-11-04

Status: round 2 implementation of SCRUM-908 c24538 and the coordinator-selected exact-template cohort. Local validation is recorded below; deployment and independent seats remain pending.

## Requirement and production observation

The default ACCOUNTANT receives `view:commissions` without `manage:commissions`. Management net profit requires commission visibility because it subtracts commissions. SENIOR_ACCOUNTANT already has this permission.

The coordinator's read-only production observation on 2026-11-04 found exactly **one** ACCOUNTANT role. Its 19 permissions equal the pre-change default at `644d785d78361c351b6fb9f1166da18bdfd3527d`: it holds `view:cost_price`, payroll access, supplier settlement and finance disbursement, and lacks `view:commissions`. No document id, organization name or production amount is recorded here. This lane did not independently access production.

At starting SHA `e6762aca1c744ca1fabb2d000376d90f34dddc9b`, the backfill required missing cost access. It therefore could not reach that role. The former same-cost-predicate decision is superseded by the explicitly selected cohort below.

Invariant: grant the authorized exact-template ACCOUNTANT cohort once, record provenance atomically with the grant, and preserve later owner restrictions on marked roles.

## Decision

`ACCOUNTANT_TEMPLATE_BEFORE_COMMISSIONS` is an `Object.freeze` constant containing the 19 literal permissions from the pre-change default. The template test asserts exact set equality with the current ACCOUNTANT default minus `view:commissions`, including count and uniqueness. The migration never derives its target from a future mutable template.

A role qualifies only when it is live, its name normalizes to ACCOUNTANT, it is not a system-owner role, it lacks this migration marker, and its permissions contain exactly that frozen set. Order is irrelevant; duplicates, any additional permission, any missing permission, renamed roles and other names do not qualify. A same-length substituted permission is also refused. Historical intent is not inferred: an unmarked role with the identical name and set is the coordinator-authorized target, regardless of how it was originally created.

The optional older no-cost template is not accepted by this commission phase. The existing cost phase can make such a row match the supported set for a subsequent rollout. The phase does not promise that a row remains excluded after another authorized migration changes its permissions.

The `roles` schema adds `appliedRoleMigrations: v.optional(v.array(v.string()))`. Existing documents remain valid without it. One patch appends both `view:commissions` and `accountant-commissions-2026-11-04`, preserving other migration markers. Replays skip marked rows even if an owner has removed commission visibility and restored the old permission set. An uncaught mutation failure rolls back the page; there is no catch that could commit a partial repair.

New organizations stamp the marker in the same ACCOUNTANT insert that seeds the new default grant. This closes new organization → owner restriction → rollout regrant. It records known provenance and does not infer historical intent. The raw admin editor accepts unchanged marker round trips and ordinary permission edits, but refuses marker removal or forgery.

Alternatives rejected: a sale-completing capability match would admit custom roles, while the original missing-cost match misses the observed role. A new requirement that every role save include commission visibility would remove owner authority. A separate migration component adds infrastructure without improving this existing bounded operator rollout.

## Writers, readers and impact boundary

Inspected production role-write paths: `roles.create/update/remove`, `memberships.syncRolePermissionsToTemplate`, `migrateRoles.fixExistingRoles`, its shared `patchRoleIfNeeded` and backfills, `migrations.backfillPermissions`, organization creation, the two permission patches in `e2eBootstrap`, and the generic admin editor. Inserts create new documents; existing role saves, template sync, legacy backfills, soft deletes and restores use partial patches that omit migration history. The raw admin patch is protected explicitly. Hard deletion destroys the role itself; a subsequently created role has a new identity and no inherited history.

Role readers in `roles.list/get`, `adminUsers.listRolesForOrg` and the raw admin browser return documents without restrictive role return validators. Membership and bootstrap return validators describe explicit permission/name projections rather than raw documents. No such validator rejects the added field. Public `roles.list/get` are executed with marked documents in the regression tests. No reader API or generated module is added, so `convex/_generated/api.d.ts` needs no regeneration.

The backfill has no caller-supplied organization or document id. It patches the role it read from its single global page. Tenant controls preserve ownership across two organizations; public commission access tests preserve foreign-organization refusal. This grants read visibility only. It creates no spend, posting, ledger calculation, monetary snapshot or reversal obligation. Reports and UI continue to consume stored role permissions through the existing gates. No UI is edited.

## Rollout

Keep supplier repair → commissions → cost-price → remaining verification. Commissions stays first to minimize rollout wiring changes. The supported cohort already has cost access, so cost-first also leaves it eligible; a backend control calls cost repair before and after commission repair. Correctness for this cohort no longer depends on phase order.

Keep one `paginate` call per mutation, default page size 100 and clamp 1–500, optional nullable cursor, and `{ updatedCount, updates, isDone, continueCursor }`. The existing `releaseGuard.ts` helper retains the 10,000-page cap, shared deadline, malformed-result and stalled-cursor refusal. Public output contains counts only. Private `updates` strings are never logged or copied into the release summary. Helper wording now names the exact unmarked template cohort.

## Verification

Risk: HIGH, because an automatic rollout grants authority and adds persisted provenance.

Red evidence is committed at `a59e3afdf198c00c67aa1450a84cb37552bc65d0`, on top of the requested starting SHA, before production edits. The updated backend file first produced 6 failures and 1 pass: the exact 19-permission target returned `updatedCount: 0`, custom roles were incorrectly granted, and the bounded-page target produced zero repairs. Adding provenance controls produced 11 failures and 15 passes across the backfill and admin files. The latter also includes expected schema failures for the not-yet-declared field; those are not counted as independent proof of the admin guard.

After implementation, four source mutation controls independently exited 1 with assertion failures: removing the marker replay guard, removing exact membership checking, removing admin metadata protection with the optional schema present, and removing the new-organization marker stamp. Each original file was restored byte-for-byte before the next control.

Green validation:

```text
pnpm exec vitest run convex/accountantCommissionsAccess.scrum908.test.ts convex/accountantCommissionsBackfill.scrum908.test.ts convex/utils/permissions.test.ts convex/roles.test.ts convex/migrateRoles.test.ts convex/adminData.test.ts convex/consignedSaleCostAccessRule.scrum886.test.ts scripts/accountantCostPriceRollout.test.ts scripts/accountantCommissionsRollout.test.ts scripts/tenantWriteGuard.test.ts scripts/intelligence/permissionMatrix.test.ts scripts/regression/scenarioRecord.test.ts --maxWorkers=1 --testTimeout=20000
250 passed in 12 files, no skips, exit 0.

pnpm typecheck
exit 0. Root config excludes convex/, test-utils/, apps/, packages/ and dealer-worker/ as entry sets.

pnpm typecheck:convex
exit 0. Includes convex/ and test-utils/; excludes _generated/ as an entry set. Does not cover the frontend entry set.

pnpm exec eslint convex/adminData.ts convex/adminData.test.ts convex/migrateRoles.ts convex/organizations.ts convex/schema.ts convex/utils/permissions.ts convex/utils/permissions.test.ts convex/accountantCommissionsBackfill.scrum908.test.ts scripts/releaseGuard.ts scripts/accountantCommissionsRollout.test.ts
exit 0; zero errors and 13 warnings on unchanged admin source/test lines.
```

Five predicted failure classes are exercised: wrong cohort or owner identity; duplicate grant or lost marker after owner removal; a role save/backfill/admin patch stripping provenance; failure to advance/bound pages across tenants; and leaking private results or accepting malformed/late rollout evidence. Scenario records and matrix row `SCRUM908-accountant-commission-visibility` bind the controls to c24538. Defect records name the committed red revision containing their actual tests.

These are serial `convex-test`, template and rollout-helper checks. They do not establish Convex platform concurrency, a real deployed schema push, production data mutation, PR #772 management-net reader integration, authenticated browser hunters, CI, SonarCloud or release readiness. No production access, push or deployment was performed. Formal Opus/Codex review seats remain with the coordinator. Advisory design review identified the seed and raw-admin provenance gaps, now covered by tests; it is not a formal seat.

Implementation source commit: `1920aed8021c641a06e10fc395f82e8d39ebc318`. Advisory standards review found no introduced violation. Advisory spec review found one stale matrix sentence about bugRef; it was corrected. Neither review is a formal seat.

The first committed-head evidence check found five stale entries, all in the admin data browser shard after adding metadata protection. The five renewals were reviewed against the unchanged client and changed defining backend module, then appended with current git-blob evidence using the repository shard writer. Entry identity, classification, rationale, fingerprint, multiplicity and expiry are unchanged. This is source-evidence freshness, not live-backend or independent-review evidence.

```text
node scripts/contractSkew/renewBaselineReviewed.mjs --check-evidence --reviewed HEAD --pr-base 644d785d78361c351b6fb9f1166da18bdfd3527d
945 checked, 0 unrenewed, 0 stale, 0 malformed, 0 missing; exit 0 after renewal.

node scripts/contractSkew/checkBaselineIdentity.mjs
945 call identities matched; exit 0. This command does not check backend finding identity.
```

Both commands are repeated at the final committed head before handoff. The only remaining worktree changes are the pre-existing ignore files, which were never staged.

## Official sources checked

- [Convex schemas and optional fields](https://docs.convex.dev/database/schemas): optional fields admit old documents while schema validation stays enabled.
- [Convex online migrations](https://stack.convex.dev/migrating-data-with-mutations): evolve schema compatibly and migrate live data in bounded transactions.
- [Convex pagination](https://docs.convex.dev/database/pagination): continue with returned cursors until `isDone`.
- [Convex writing data](https://docs.convex.dev/database/writing-data): patch shallow-merges fields, explicit undefined removes fields, and mutations are transactions.

Checked on 2026-11-04. These sources support the schema, patch and pagination mechanics. They do not prove rollout execution or authorize the business cohort; c24538 and the coordinator's round-2 selection supply that scope. No required official documentation source was unavailable.
