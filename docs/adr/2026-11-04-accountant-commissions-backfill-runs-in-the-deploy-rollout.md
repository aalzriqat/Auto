# ACCOUNTANT commission visibility and the deploy backfill boundary

Date: 2026-11-04

Status: implemented under SCRUM-908 c24538 with the task's exact cost-price targeting. Already-cost-repaired roles remain excluded.

## Requirement

The default ACCOUNTANT receives `view:commissions`. SCRUM-908's management net profit requires commission visibility because it subtracts commissions. SENIOR_ACCOUNTANT already has this permission. The grant does not add `manage:commissions`.

Invariant: grant the default template the visibility the owner approved, while preserving explicit owner restrictions and custom roles in existing organizations.

## Decision for new organizations

Add the permission to `DEFAULT_ROLE_TEMPLATES`. `organizations.create` seeds these templates. Existing organizations keep their stored role permissions until an authorized migration or owner action changes them.

`roles.create` and `roles.update` accept commission visibility with accounting and disbursement permissions. `assertRoleMayBeStored` enforces sale-completion plus cost visibility, not a prohibition on commission viewing. The commission section in `RolePermissionsEditor` uses `VIEW_COMMISSIONS` as its base read permission. The inspected permission registry, shared role-save assertion, public role writers, Data Browser role writers and permission-matrix scanner contain no ACCOUNTANT-specific commission refusal to relax. Commission management and payroll self-beneficiary guards retain their existing conditions.

## Migration design conflict

The requested backfill must reuse the targeting of `backfillAccountantCostPriceAccess` from SCRUM-886 and SCRUM-896, without selecting a renamed, custom or owner-restricted role. That function requires all of:

- The role is live.
- Its name normalizes to ACCOUNTANT.
- `completesSalesWithoutCostAccess(role.permissions)` is true.

The last predicate requires sale-completion authority and **missing** `view:cost_price`. Once the existing cost-price rollout repairs a role, that predicate becomes false. Literal reuse cannot repair already-cost-repaired accountants. Running commissions before cost would cover only legacy accountants still missing cost, and running it after cost would miss those too.

Removing the missing-cost condition changes the migration's authority. An owner may legally save an ACCOUNTANT that has cost and sale-completion access but lacks commission access. `roles.create` may also create such a custom role. The `roles` schema stores no default-template provenance, customization marker or migration history. Permission-array equality cannot distinguish an untouched default from an owner who intentionally saved that array. `_creationTime` does not record later owner restrictions.

| Candidate | Result |
| --- | --- |
| Reuse the exact predicate before the cost-price phase | Selected because the task explicitly requires the same predicates and prohibits a looser one. Already-cost-repaired ACCOUNTANT roles remain unchanged. |
| Match ACCOUNTANT plus sale completion regardless of cost | Rejected under the current task. Selects valid owner-restricted and recreated custom roles. |
| Require commission visibility in future role saves | Changes owner authority and does not establish historical provenance. Requires a separate ruling. |
| Use an explicitly authorized existing-role cohort or a provenance design | Follow-up option for already-cost-repaired roles. Requires a separate scope decision. |

`backfillAccountantCommissionsAccess` reuses the exact three predicates above and `patchRoleIfNeeded`. It runs before the cost-price phase. Valid custom or recreated roles have cost access when they hold a completing permission, because current role writers enforce that condition. A renamed role does not match. An owner-restricted role without completion authority does not match either. A later owner restriction of commission visibility leaves cost access in place, so the next rollout does not undo it.

As in the existing cost-price backfill, a pre-rule custom role named ACCOUNTANT with the same invalid missing-cost state is indistinguishable from a legacy default and may match. This change does not broaden that existing cohort. The advisory design review confirmed these limits; it was not a formal seat. The broader objective of granting every historically seeded ACCOUNTANT remains unproven and is not claimed here.

## Rollout contract

The bounded `internalMutation` in `migrateRoles.ts` reads one roles page per call, with the cost-price backfill's `numItems`, optional nullable cursor, page clamp of 1 to 500 with default 100, and `{ updatedCount, updates, isDone, continueCursor }` result. It patches only the missing permission. Failures throw so the page rolls back atomically. Committed pages can be retried idempotently, passing `continueCursor` until `isDone`.

`runAccountantCommissionsPhase` keeps the phase body, including its logging, in tested `scripts/releaseGuard.ts`. The `.mjs` script calls it with the shared CLI runner, logger and deadline after supplier identity repair and before cost-price repair. The shared cursor walker and page parser retain the 10,000-page cap, malformed-evidence refusal, stalled-cursor refusal and counts-only public logs. `updates`, which contains role and organization identifiers, is never copied into output. The page parser was renamed to describe its shared contract; its validation is unchanged.

The mutation has no caller-supplied organization or document id. Its global scan patches only the role document read from that page. Tenant tests preserve the distinct organizations and permission arrays of both matched roles and leave the foreign custom role unchanged. This operation does not spend, post, reverse or recalculate financial history. No new spending or reversal path is introduced.

Five predicted failures are tested: cost repair running first; broadening the eligibility predicate; writing a renamed or deleted row; adding the grant twice on replay or failing to bound pages; and leaking private update strings or accepting a page after the deadline.

## Evidence and limits

Failing-first at base `644d785d78361c351b6fb9f1166da18bdfd3527d`: `convex/utils/permissions.test.ts` failed 1 of 9 tests because ACCOUNTANT lacked `view:commissions`. `convex/accountantCommissionsAccess.scrum908.test.ts` failed 1 of 2 tests for the same missing grant in the role actually seeded through `organizations.create`. The role-create and role-update control accepted the proposed permission combination before the template changed.

After correcting a test fixture's missing required email, removing only the new template grant produced 2 failures and 10 passes across the two new or changed test files. Restoring it made the checks pass. The setup error was not counted as permission evidence.

Before the new migration and phase exports existed, `convex/accountantCommissionsBackfill.scrum908.test.ts` and `scripts/accountantCommissionsRollout.test.ts` failed all 23 registered cases because the exports and wiring were absent. The added mutation then made the tenant guard fail at 569 total mutations and 171 without orgId, versus 568 and 170. The pinned census was updated to those measured values; the 383 analyzed mutations and 15 without an args block are unchanged.

Commands and results on this local branch:

```text
pnpm exec vitest run convex/utils/permissions.test.ts convex/accountantCommissionsAccess.scrum908.test.ts convex/accountantCommissionsBackfill.scrum908.test.ts convex/roles.test.ts convex/migrateRoles.test.ts convex/consignedSaleCostAccessRule.scrum886.test.ts scripts/accountantCostPriceRollout.test.ts scripts/accountantCommissionsRollout.test.ts scripts/tenantWriteGuard.test.ts scripts/intelligence/permissionMatrix.test.ts scripts/regression/scenarioRecord.test.ts --maxWorkers=1 --testTimeout=20000
Final run: 230 passed in 11 files, no skips, exit 0. The three suites affected by moving phase logging into the TypeScript helper also passed 112/112.

pnpm typecheck
passed; root Next.js config excludes convex/, test-utils/, apps/, packages/ and dealer-worker/ as entry sets

pnpm typecheck:convex
passed; includes convex/ and test-utils/, excludes _generated/ as an entry set and does not cover the frontend entry set

pnpm exec eslint convex/utils/permissions.ts convex/utils/permissions.test.ts convex/accountantCommissionsAccess.scrum908.test.ts convex/accountantCommissionsBackfill.scrum908.test.ts convex/migrateRoles.ts scripts/releaseGuard.ts scripts/accountantCommissionsRollout.test.ts scripts/tenantWriteGuard.test.ts scripts/rolloutRelease.mjs
passed, zero warnings

node scripts/contractSkew/renewBaselineReviewed.mjs --check-evidence --reviewed HEAD --pr-base 644d785d78361c351b6fb9f1166da18bdfd3527d
945 checked, 0 stale, 0 unrenewed, 0 malformed, 0 missing

node scripts/contractSkew/checkBaselineIdentity.mjs
945 call identities matched; backend finding identity not checked by this command
```

API declaration regeneration is unnecessary: `api.d.ts` already imports `utils/permissions` and `migrateRoles`, so the added function is inferred through the existing module declaration. Baseline checks are re-run against the committed head before handoff.

Source mutation controls, each restored from the original bytes before the next run:

| Function | Mutation | Result |
| --- | --- | --- |
| `backfillAccountantCommissionsAccess` handler | Replace the commission grant with an empty set | 5 failed, 2 passed |
| Same handler | Remove the missing-cost/completion predicate | 2 failed, 5 passed |
| Same handler | Remove normalized-name predicate | 2 failed, 5 passed |
| Same handler | Remove deleted-row predicate | 1 failed, 6 passed |
| `runAccountantCommissionsPhase` | Call the cost-price function instead | 1 failed, 15 passed |

Each control ran `pnpm exec vitest run <the corresponding new test file> --maxWorkers=1 --testTimeout=20000` and exited 1. These controls cover both new function bodies and each eligibility conjunct.

Coverage command: the same named-file invocation with only the two new backend suites, `convex/utils/permissions.test.ts` and the two accountant rollout suites, plus `--coverage --coverage.include=convex/migrateRoles.ts --coverage.include=scripts/releaseGuard.ts --coverage.include=convex/utils/permissions.ts --coverage.reporter=lcov --coverage.reporter=json-summary`. Its 69 tests passed, but the command exited 1 because that focused sample covers only 21.4% of the three large legacy files against the unchanged global 90% line threshold. No threshold was lowered. The earlier 230-test coverage sample likewise passed its tests but failed whole-file coverage at 31.95% lines.

Nonempty LCOV intersected with `git diff --unified=0` measured 26 added executable line points, all covered: 11 in `migrateRoles.ts`, 15 in `releaseGuard.ts`. The template array element has no separate LCOV point and is asserted directly by the template and organization-seeding tests. The `.mjs` adapter adds three unexecuted code lines plus an import specifier. Counting all four as uncovered line points gives a conservative local 26/30, or 86.7%, for that measured set. This is local evidence rather than a SonarCloud verdict; SonarCloud's actual new-code denominator remains unverified. The file-wide threshold failures are not reported as passing coverage gates.

Two initial scenario records used an overlong input token and a token containing spaces. The library guard refused both. Their tokens and fingerprints were corrected, retaining the guard and the scenarios; the library suite then passed 62/62. Eight new permission records cite c24538 and carry no `bugRef`.

These are serial `convex-test`, pure-template and rollout-helper checks. They do not prove platform concurrency, the SCRUM-908 management-net readers on unmerged PR #772, authenticated browser behavior, broader existing-role migration coverage or production state. Formal seats, CI, SonarCloud, a build and release verification remain pending. No live backend, production credential or deployment was accessed.

## Sources checked

- [Convex internal functions](https://docs.convex.dev/functions/internal-functions): use an internal mutation for operator-only migration logic rather than exposing a client endpoint.
- [Convex pagination](https://docs.convex.dev/database/pagination): pass cursor continuations and use `isDone`, including after short or empty pages.
- [Convex online migrations](https://stack.convex.dev/migrating-data-with-mutations): process bounded batches and make retries safe. The existing native cursor rollout is sufficient here; a new migration component would not resolve the missing authorization provenance.

The official sources were checked on 2026-11-04. They support the proposed mechanics, not the business decision about which historical roles may receive a grant.
