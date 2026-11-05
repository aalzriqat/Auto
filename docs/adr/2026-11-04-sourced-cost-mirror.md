# Keep the SOURCED purchase-price mirror transactional (SCRUM-907)

Invariant: after a successful cost write to a SOURCED vehicle, `purchasePrice === sourceCost`.
`sourceCost` is the supplier entitlement, never owned inventory (ACC-1).

## Enumeration before implementation

Scope: tracked TypeScript/TSX in `convex/`, `components/`, `app/`, `lib/` at
the branch base, excluding tests and generated code. Enumerated both field names
with `git grep`, inspected each production hit and followed the write payloads.
Declarations, validators and cost-visibility classifiers are not money readers.

| Readers / writers | Effect of a stale SOURCED purchasePrice |
| --- | --- |
| `vehicles.create`, `createSourced`, both `importBulk` insert branches, `vehicleEdits.resolve` CREATE | Writers already mirror sourceCost. |
| `vehicles.update`, `vehicleEdits.requestUpdate` / `resolve` UPDATE | Defective writer paths; normalize before existing locks and persist the effective audit payload. |
| `vehicles.correctAcquisitionCost`; `saleCompletion` trade-in attach; `saleCancellation` trade-in restore | purchasePrice writers restricted to owned stock; SOURCED refused. |
| `adminData` generic patch | Ownership/cost fields locked; cannot bypass the vehicle workflow. |
| `VehicleCostBar`, `ReviewVehicleCard`, `VehiclePicker`, `Step1QuoteSetup`, `VehicleDetailsDialog` | Displayed recorded cost can be stale; the cost bar derives no profit or sale amount. |
| Vehicles page | Missing-cost indicator uses sourceCost for SOURCED; unaffected by stale purchasePrice. |
| `VehicleDialog`, `ApprovalOwnershipChooser`, `VehicleImportDialog`, `vehicleSheet`, `vehicle.schema`; lib `ownershipGaps`, `importSupplierMapping` | Form/import values and completeness hints; the old edit form resubmitted the hidden stale mirror. Export prefers sourceCost for SOURCED (purchasePrice is a fallback for missing sourceCost). |
| `VehicleHistoryDialog` | Audit display must include the mirrored field actually written. |
| `saleCompletion`, `sales`, `applications`, `dealOverview`, `vehicleOwnership`, `vehicleCost`, `vehicleCostBasis` | Money: SOURCED entitlement from sourceCost or frozen sale/application basis; purchasePrice applies to STOCK/trade-ins. |
| `supplierConcession`, `sourcingPayables`, sourcing page | Money: concession basis / payable derived from sourceCost or frozen entitlement. |
| `reports`, reports page | Money totals use sourceCost for SOURCED; exported purchasePrice column can display stale cost. |
| `dashboard`, vehicles aggregate reads | Money: sourced margin uses sourceCost / canonical cost helper; inventory aggregates exclude SOURCED. |
| `sourcedAgentImpact` | Money diagnostic: mismatch produces SOURCED_COST_CONFLICT and withholds correction eligibility. Never automatically rewrite sold history. |
| `accountingMigration`, `accountingCutover`, `accounting/openingAllocations`, `openingVehicleBasis`, posting rules / workflow hooks | Money: owned inventory/opening/trade-in paths; SOURCED excluded or refused; agent journals use canonical sourceCost / frozen economics. |
| `supplierPaymentAmounts`, `vehicleSourceShape`, `vehicleSupplierIdentity`, validations, schema, saleRowProjection / vehicleCostVisibility | Validation, typing or redaction; no independent money calculation. |

## Decision

Use native `db.patch` to write the source and mirror in one transaction. Refuse
contradictory submitted costs. A purchasePrice-only edit must echo the stored
price, and that echo is omitted from the write. A different price requires an
explicit, consistent supplier-cost change. The direct and approval doors share a pure patch
normalizer. The form submits only sourceCost for SOURCED edits; its hidden
purchasePrice is the old mirror. Keep concession, opening-basis and posted-acquisition checks in their
existing order. Ownership flips remain behind the existing pilot containment.
An approval request with no submitted change still refuses as before; a derived
mirror alone must not create a pending request. Conflicting input is validated
before filtering, and the derived field joins only a nonempty request payload.

Repair only live SOURCED mismatches with a valid positive supplier cost, in one
bounded cursor page per internal mutation. Skip and count sold vehicles,
acquisition/landed-cost exposure, opening-basis locks and held concessions.
Unexpected failures escape after server logging so the page rolls back; a caught
write failure must never commit a partial page (CVX-1). Re-running starts safely
from null because repaired rows no longer match. No journal, payable or frozen
sale snapshot is changed. The rollout uses the existing shared cursor walker,
deadline and operator runner, before inbox verification. Locked and invalid-cost
rows are counted anomalies and need a reviewed correction. Read errors and
uncompleted pages refuse the final rollout verdict after inbox verification.

Official guidance checked 2026-11-04:
- https://docs.convex.dev/database/writing-data (atomic mutations and patch)
- https://docs.convex.dev/database/pagination (native cursor continuation)
- https://docs.convex.dev/functions/error-handling/ (application vs developer errors)

## Closure / limits

Authorization and tenancy stay at existing public boundaries. The internal
repair accepts no org/document id and exposes counts plus cursor only. No new
spending or reversal event exists: cancellation/reversal/reset semantics stay
with their existing owners. Retry is idempotent. Historical sold/locked rows are
reported rather than silently changing recorded financial facts.

Five predicted failures to test: approval bypasses the mirror; a purchasePrice-only
edit breaks it; normalization bypasses a posted/concession lock; repair touches
STOCK/deleted/locked history; rollout accepts malformed/late/incomplete evidence.
Serial convex-test evidence does not certify platform limits, OCC, browser UI,
CI, production rows or release readiness. Independent seats belong to the coordinator.

## Implementation evidence

- `db5489a96` committed the public-mutation regression before the fix. Its red
  run expected purchasePrice 9,900 and received 10,250 with sourceCost 9,900.
  The same test passed after the fix.
- `e4fd26f03` contains the implementation. Main's test/documentation change
  `f119b20e5` merged cleanly in `8ee127e64`.
- The post-merge cost-disclosure control exposed an unchanged-cost echo creating
  a pending request solely from the derived mirror. It failed at `8ee127e64`.
  The correction preserves that existing refusal and has its own money record
  and SCRUM-486 row. No refusal assertion was removed.
- Jira comment SCRUM-907 c24498 now records that the owner corrected the affected
  production row directly. The repair remains bounded and idempotent and is
  expected to update zero rows on that population. This session did not access
  production or independently verify that report.

The following named-file runs passed after the no-change correction. Every
Vitest invocation used one worker, without changing timeouts or thresholds.

```powershell
# 372 tests, 9 files
pnpm vitest run convex/sourcedCostMirror.scrum907.test.ts convex/vehicleCostDisclosureWrites.scrum886.test.ts convex/vehicleCostFieldVisibility.scrum886.test.ts convex/aggregateWiring.test.ts scripts/sourcedCostMirrorRollout.test.ts scripts/accountantCostPriceRollout.test.ts scripts/tenantWriteGuard.test.ts scripts/regression/scenarioRecord.test.ts components/vehicles/VehicleDialog.buyout.test.tsx --maxWorkers=1
# 205 tests, 5 files
pnpm vitest run convex/vehicles.test.ts convex/vehicleEdits.test.ts convex/supplierConcession.scrum766c.test.ts convex/scrum486Certification.test.ts convex/applicationsIndexReads.test.ts --maxWorkers=1
```

Both `pnpm typecheck:convex` and `pnpm typecheck` passed again after the final
request correction. `pnpm vitest run scripts/regression/scenarioRecord.test.ts
--maxWorkers=1` passed all 62 checks after the eighth record was added.
The Convex config includes convex and test-utils, excluding `_generated` as
root files (imported generated types still resolve). The root config excludes
convex, test-utils, apps, packages and dealer-worker as root files. Its include
patterns/checkJs setting do not check `.mjs` implementation bodies.

Targeted ESLint on the changed implementation/test files exited 0 with no errors
and 85 warnings in the existing large files. A final `pnpm exec eslint
convex/vehicleEdits.ts` rerun exited 0 with two warnings on unchanged `any` casts.
No SonarCloud run was available on
this unpushed branch; no new nested ternary or NOSONAR was added. The new repair
and rollout functions were checked for cognitive complexity below 15; this is
author inspection, not a Sonar verdict. No browser hunters, real-backend rehearsal,
production rollout or independent review seats ran in this implementation lane.


## Review remediation at ca621c5c (2026-11-04)

Invariant: a real supplier-cost change on a live unlocked SOURCED vehicle mirrors
purchasePrice atomically. An unchanged echo never repairs history. Sold, opening
and posted-cost history remain for the bounded repair to classify and skip.

The three doors are vehicles.update, vehicleEdits.requestUpdate and
vehicleEdits.resolve. The shared normalizer distinguishes a real cost change or
ownership flip from an echo. The approval doors discard unchanged cost and
ownership keys before their existing locks; an echo-only approval records its
resolution but does not patch the vehicle. New mobile edits omit purchasePrice
for SOURCED cars; older builds are supported by the server's unchanged-echo rule.
Role policy, tenancy, posting locks and financial activation switches are unchanged.

The rollout reports locked and invalid row counts as anomalies. Malformed pages,
read failures, stuck cursors and deadlines still refuse the final deploy verdict.
The phase returns a discriminated result, allowing phase 3 to execute before the
script applies a SOURCED-repair refusal. No backend data enters the public error.

Class map and impact boundary:

| Area | Remediation evidence or boundary |
| --- | --- |
| Writers | Direct update and both approval doors call the shared rules; repair remains unchanged. |
| Readers | Existing ADR reader map remains the scope. Stale historical cost and sourcedAgentImpact conflict evidence stay intact. |
| History and transitions | SOLD, pending opening basis, posted acquisition, and old pending requests are exercised. Ownership flips still derive the mirror. |
| Reversal and ledger | No new spending or posting path; existing lock tests remain enabled. |
| Idempotency | Direct echo is a no-op; repair rerun and bounded cursor controls remain. |
| Authorization and tenancy | Existing permission and tenant-write suites run; field-presence cost access still precedes comparisons. |
| Audit | Direct echo omits cost; approval still overwrites its UPDATE payload, LOW L2 left unchanged. |
| UI | Mobile payload is verified in the real module's Jest harness. No visual layout changes. |
| Release | Counts-only anomalies; actionable refusal is deferred until after inbox verification. No deployment executed. |
| Runtime | convex-test evidence only; no platform, production or concurrency certification. |

Five predicted failures checked: older clients echo a stale price; a source-cost
or ownership echo reaches a lock; a sold echo silently repairs history; an old
pending request rewrites vehicle timestamps; permanently skipped rows prevent
all future inbox verification. The focused tests exercise these cases. The
existing real-cost-change, conflict, posted-lock and repair controls remain.

Red evidence:

- 609e8cb161a2238e9fdf19c82d27be57cb3e739e contains the first review regressions.
  Against ca621c5c production code: backend 4 failed / 17 passed; rollout 5 failed /
  15 passed; mobile 1 failed / 14 passed; scenario provenance 5 failed / 62 passed.
- 3d6bc3f88 adds individually registered history checks and the timestamp assertion.
  At that exact commit, rerunning the backend, rollout and scenario-record files
  gives 14 failed / 94 passed: M1/M2 four failures, rollout five and provenance
  five. During the partial fix the expanded history cases also failed 3 / 21. The original
  rollout ordering test selected the empty-deployment exit; this commit corrects
  its selector to the final exit. That selector failure was a test defect, not an
  additional product finding.
- Seven original records cited db5489a96. Only the direct regression exists and
  fails there. Five preventive/repair controls now have no bugRef. The approval
  bug cites e827df86f on local branch codex/scrum907-approval-red-evidence, a
  test-only child of db5489a96. At that exact evidence commit, direct and approval
  mirror tests fail and the posted-cost lock control passes (2 red, 1 green).
  The coordinator must preserve/publish that evidence branch with the PR. The
  eighth original record already cites the genuine unchanged-request regression
  at 8ee127e64 and retains it.

Design sources checked before implementation: Convex's mutation documentation
(https://docs.convex.dev/functions/mutation-functions), native shallow patch
semantics including undefined deleting fields
(https://docs.convex.dev/database/writing-data), and Convex's maintained migration
component's bounded, resumable and idempotent batch behavior
(https://github.com/get-convex/migrations). The existing repair stays in place;
this change fixes its outcome handling without adding migration infrastructure.


Verification of the remediation source:

- Both root and Convex typechecks exit 0. Root excludes convex, test-utils, apps,
  packages and dealer-worker as root files; Convex includes convex and test-utils,
  excluding generated roots. Imported types still resolve. Neither is an Expo
  typecheck; pnpm mobile:typecheck also exits 0. The root check does not check
  .mjs implementation bodies.
- Mobile Jest: 15 passed, one worker, watch disabled, testTimeout 20000. The new
  payload test was red before the client change (1 failed / 15).
- Release suites: 215 passed across releaseGuard, sourced mirror, accountant,
  supplier identity, supplier registry and VAT hold rollout tests. V8 coverage of
  releaseGuard is 99.31% lines and 97.63% branches. All 23 executable PR-added
  lines are covered, including both executable lines changed in this remediation.
- Source helper coverage: 102 passed in the sourced mirror, vehicle ownership
  intake/remediation, approval guards and cost-disclosure suites. Native V8
  coverage of vehicleSourceShape is 98.30% lines and 95.72% branches. All ten
  executable remediation-added lines are covered. Existing coverage thresholds
  remain unchanged.
- Targeted ESLint exits 0. Convex vehicleEdits retains two existing any warnings;
  mobile, explicitly linted with --no-ignore, retains its existing any and
  Image alt-text warnings. No NOSONAR, waiver or coverage exclusion was added.
- Self-review applied clean-code-guard and test-guard. New helper complexity is
  inspected below 15; this is not a SonarCloud analysis. A cloud verdict and
  independent seats remain pending because the branch is intentionally unpushed.

LOW items left: L2 UPDATE audit payload overwrite, L3 coordinator baseline note,
L5 per-deploy full scan, and mobile projected-margin wording. M2 also closes L1
and L4. No baseline renewal, merge, push, deployment or production read/write was
performed by this remediation session.


Final broad run: 881 tests passed in 21 files; one additional suite,
scripts/regression/refreshRulings.test.ts, failed before test registration.
Vite/Rolldown prepends CommonJS builtin interop before the shebang in the imported
refreshRulings.mjs, then reports Invalid Character !. The identical named-file
run fails at the original ca621c5c checkout too. Both files are unchanged. This
is failed sibling-suite verification, not a green scenario gate. The separate
scenarioRecord + implFixture + refreshRulings run has 68 passing tests in the
first two files and the same failed third suite. localExecution.test.ts passes
in the broad run. No skip or toolchain workaround was added.

```powershell
# 881 passed, 21 files; refreshRulings is the failed 22nd suite.
pnpm exec vitest run convex/sourcedCostMirror.scrum907.test.ts convex/vehicleCostDisclosureWrites.scrum886.test.ts convex/vehicleCostFieldVisibility.scrum886.test.ts convex/aggregateWiring.test.ts scripts/sourcedCostMirrorRollout.test.ts scripts/accountantCostPriceRollout.test.ts scripts/tenantWriteGuard.test.ts scripts/regression/scenarioRecord.test.ts components/vehicles/VehicleDialog.buyout.test.tsx convex/vehicles.ownershipRemediation.test.ts convex/vehicles.test.ts convex/vehiclesSelector.test.ts convex/vehicleSupplierFirstLink.scrum868.test.ts convex/vehicleSupplierIdentity.test.ts convex/vehicleEdits.approvalGuards.test.ts convex/vehicleEdits.test.ts convex/supplierConcession.scrum766c.test.ts convex/scrum486Certification.test.ts convex/applicationsIndexReads.test.ts scripts/regression/implFixture.test.ts scripts/regression/localExecution.test.ts scripts/regression/refreshRulings.test.ts --maxWorkers=1 --testTimeout=20000
# 215 passed, native coverage thresholds unchanged.
pnpm exec vitest run scripts/releaseGuard.test.ts scripts/sourcedCostMirrorRollout.test.ts scripts/accountantCostPriceRollout.test.ts scripts/supplierIdentityRollout.test.ts scripts/supplierRegistryRollout.test.ts scripts/supplierVatHoldRollout.test.ts --maxWorkers=1 --testTimeout=20000 --coverage --coverage.include=scripts/releaseGuard.ts --coverage.reportsDirectory=E:/tmp/scrum907-release-coverage
# 102 passed, native coverage thresholds unchanged.
pnpm exec vitest run convex/vehicleOwnershipIntake.test.ts convex/vehicles.ownershipRemediation.test.ts convex/vehicleEdits.approvalGuards.test.ts convex/vehicleCostDisclosureWrites.scrum886.test.ts convex/sourcedCostMirror.scrum907.test.ts --maxWorkers=1 --testTimeout=20000 --coverage --coverage.include=convex/utils/vehicleSourceShape.ts --coverage.reportsDirectory=E:/tmp/scrum907-source-coverage
pnpm --filter @autoflow/mobile exec jest src/features/workspace/modules/vehicles.ownership.test.tsx --runInBand --watch=false --testTimeout=20000
pnpm typecheck
pnpm typecheck:convex
pnpm mobile:typecheck
pnpm exec eslint convex/utils/vehicleSourceShape.ts convex/vehicleEdits.ts convex/sourcedCostMirror.scrum907.test.ts scripts/releaseGuard.ts scripts/rolloutRelease.mjs scripts/sourcedCostMirrorRollout.test.ts scripts/regression/scenarioRecord.test.ts
pnpm exec eslint --no-ignore apps/mobile/src/features/workspace/modules/vehicles.tsx apps/mobile/src/features/workspace/modules/vehicles.ownership.test.tsx
node --check scripts/rolloutRelease.mjs
```

Local raw logs are E:/tmp/scrum907-{medium-red,mobile-red,provenance-red,
exact-red,historical-red,full-green,release-coverage,source-coverage,
scenarios-green,baseline-refresh,root-typecheck,convex-typecheck,
mobile-typecheck,lint,mobile-lint,mobile-green}.log. The full-green filename
names the intended run, not its verdict; its sibling parse failure is recorded
above. No rendered browser, bug hunters, real-backend rehearsal, concurrency,
production or final-head SonarCloud result is claimed.

After the final scenario metadata edit, scenarioRecord.test.ts passes 67/67
with --maxWorkers=1 --testTimeout=20000 (E:/tmp/scrum907-final-scenario.log).

## Precision refusal regression at d33662da

Decision (a): preserve `SUPPLIER_AMOUNT_PRECISION` before
`VEHICLE_SOURCED_COST_CONFLICT` for an invalid submitted purchase amount.
The existing SCRUM-880 legacy-cost test failed at requestUpdate, not at the
preceding direct update. Direct update and UPDATE approval already validate
precision before applying the SOURCED mirror rule. Only requestUpdate needed
its existing precision assertion moved before `normalizeSourcedCostUpdate`.
It checks `submittedPayload`, retaining the existing unchanged-legacy exemption.
The permission check still precedes amount comparisons. No source helper,
accounting write, ownership gate or lifecycle operation changes.

The choice follows Google's semantic API compatibility guidance
(https://google.aip.dev/180), OWASP's boundary validation guidance
(https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html),
and Convex's documented client-visible application error payloads
(https://docs.convex.dev/functions/error-handling/application-errors).
These sources support preserving the established specific refusal; they do not
prescribe this application's exact precedence. The SCRUM-880 contract and the
owner's instruction determine that order.

Failing-first commit `83c5ff28a05cc3c919ac2d2eebddfba8d557a0b0` adds one
parameterized public-seam control for direct update, requestUpdate and resolve.
Each submits an excess-precision purchasePrice that also conflicts with the
SOURCED cost, requires the exact precision code, and compares every main-schema
table before and after refusal. Approval uses an older pending payload and must
leave it pending. With d33662da production code: requestUpdate fails with the
conflict code, direct and resolve pass. After the reorder, all three pass.
The original legacy-cost test is unchanged and passes too.

Five predicted regressions and their controls: precision masked by conflict
(new three-door control); legacy precision echoes refused (original SCRUM-880
test); SOLD/opening/posted echoes rewrite history (M1/M2 controls); a real live
cost change fails to mirror (existing mirror controls); a valid-precision
conflict becomes accepted (existing direct/request/approval conflict controls).
Both complete focused files pass, 44 tests. No new spending or reversal path
exists, and no historical repair behavior changes.

Verification commands for this follow-up, all run from E:/tmp/auto-907:

```powershell
# Red: 1 failed / 2 passed, request returns the wrong code.
pnpm exec vitest run convex/sourcingPayables.test.ts --maxWorkers=1 --testTimeout=30000 -t "SCRUM-907:.*refuses excess purchase precision"
# Green: 44 passed, including the whole sourcingPayables file and M1/M2.
pnpm exec vitest run convex/sourcingPayables.test.ts convex/sourcedCostMirror.scrum907.test.ts --maxWorkers=1 --testTimeout=30000
# Broad rerun of every previously named non-coverage Vitest file, plus sourcingPayables.
pnpm exec vitest run convex/sourcedCostMirror.scrum907.test.ts convex/vehicleCostDisclosureWrites.scrum886.test.ts convex/vehicleCostFieldVisibility.scrum886.test.ts convex/aggregateWiring.test.ts scripts/sourcedCostMirrorRollout.test.ts scripts/accountantCostPriceRollout.test.ts scripts/tenantWriteGuard.test.ts scripts/regression/scenarioRecord.test.ts components/vehicles/VehicleDialog.buyout.test.tsx convex/vehicles.ownershipRemediation.test.ts convex/vehicles.test.ts convex/vehiclesSelector.test.ts convex/vehicleSupplierFirstLink.scrum868.test.ts convex/vehicleSupplierIdentity.test.ts convex/vehicleEdits.approvalGuards.test.ts convex/vehicleEdits.test.ts convex/supplierConcession.scrum766c.test.ts convex/scrum486Certification.test.ts convex/applicationsIndexReads.test.ts scripts/regression/implFixture.test.ts scripts/regression/localExecution.test.ts scripts/regression/refreshRulings.test.ts convex/sourcingPayables.test.ts --maxWorkers=1 --testTimeout=30000
# 215 passed; releaseGuard 99.31% lines, 97.63% branches. Native thresholds pass.
pnpm exec vitest run scripts/releaseGuard.test.ts scripts/sourcedCostMirrorRollout.test.ts scripts/accountantCostPriceRollout.test.ts scripts/supplierIdentityRollout.test.ts scripts/supplierRegistryRollout.test.ts scripts/supplierVatHoldRollout.test.ts --maxWorkers=1 --testTimeout=30000 --coverage --coverage.include=scripts/releaseGuard.ts --coverage.reportsDirectory=E:/tmp/scrum907-precedence-release-coverage
# 517 passed; both measured files pass unchanged native thresholds.
pnpm exec vitest run convex/vehicleOwnershipIntake.test.ts convex/vehicles.ownershipRemediation.test.ts convex/vehicleEdits.approvalGuards.test.ts convex/vehicleCostDisclosureWrites.scrum886.test.ts convex/sourcedCostMirror.scrum907.test.ts convex/vehicleEdits.test.ts convex/sourcingPayables.test.ts convex/vehicleSupplierFirstLink.scrum868.test.ts convex/vehicleSupplierIdentity.test.ts convex/vehicleCostFieldVisibility.scrum886.test.ts convex/vehicles.test.ts convex/vehiclesSelector.test.ts convex/supplierConcession.scrum766c.test.ts --maxWorkers=1 --testTimeout=30000 --coverage --coverage.include=convex/utils/vehicleSourceShape.ts --coverage.include=convex/vehicleEdits.ts --coverage.reportsDirectory=E:/tmp/scrum907-precedence-writer-coverage
# 15 passed. Jest uses its single-worker mode and never watches.
pnpm --filter @autoflow/mobile exec jest src/features/workspace/modules/vehicles.ownership.test.tsx --runInBand --watch=false --testTimeout=30000
pnpm typecheck
pnpm typecheck:convex
pnpm mobile:typecheck
pnpm exec eslint convex/vehicleEdits.ts convex/sourcingPayables.test.ts
node --check scripts/rolloutRelease.mjs
```

An initial coverage run used the first seven files of the writer command and
the same two coverage includes/options. All 142 tests passed, but it failed
the unchanged 90% statement threshold at 88.17%. Expanding to the remaining
already-named writer suites above passes with 91.75% statements, 94.11% lines,
85.95% branches and 100% functions. vehicleEdits alone has 90% statements and
92.85% lines; vehicleSourceShape retains 98.30% lines and 95.72% branches.
LCOV reports `DA:297,46` for the sole changed executable production line:
1/1 changed lines covered, 100%. Neither thresholds nor coverage exclusions
were changed.

All three typechecks exit 0. Root excludes convex, test-utils, apps, packages
and dealer-worker as roots; Convex includes convex and test-utils, excluding
generated roots; mobile checks the Expo project. Targeted lint exits 0 with
two existing any warnings in vehicleEdits and no test warnings. The rollout
syntax check exits 0. Clean-code-guard and test-guard self-review found no new
smell. No NOSONAR or new production function/control-flow branch was added;
the reorder adds zero cognitive complexity. This is author inspection, not a
final-head SonarCloud verdict.

No client file was edited or had its lines shifted. The coordinator's contract
skew baseline and every protected path named in the task remain untouched.
Only the test, vehicleEdits and this ADR belong to this follow-up. The existing
.gitignore and .ignore changes remain unmodified and unstaged. No push, merge,
backend call, deployment, browser hunter, real-backend rehearsal or independent
seat was run. Convex-test results do not certify the platform or concurrency.

The 23-file broad command exited 1: 903 tests passed, one test failed in
localExecution.test.ts, and refreshRulings.test.ts failed before registering
tests. The latter is the same Vite/Rolldown shebang-transform failure recorded
in round 4. Both refreshRulings files are unchanged from ca621c5c through
d33662da and this follow-up. The localExecution failure was its beforeEach
hook exceeding the unchanged 10-second hook timeout, at line 739, while
preparing the harness checkout for the skip-worktree reporter case. The same
case passes when retried alone. Runner/reporter source and tests are unchanged
from d33662da. No timeout, test, threshold or gate was relaxed.

```powershell
# Targeted retry: 1 passed, 192 unselected.
pnpm exec vitest run scripts/regression/localExecution.test.ts --maxWorkers=1 --testTimeout=30000 -t "a reporter edit that is skip-worktree never runs"
# Complete runner retry: 193 passed, unchanged timeout settings.
pnpm exec vitest run scripts/regression/localExecution.test.ts --maxWorkers=1 --testTimeout=30000
```

Raw logs for this follow-up are E:/tmp/scrum907-precedence-{red,green,broad,
source-coverage,writer-coverage,release-coverage,mobile,root-typecheck,
convex-typecheck,mobile-typecheck,lint,localExecution-rerun,
localExecution-whole}.log. The initial narrow coverage failure and the broad
failures remain in that evidence; neither is reported as a passing run.
The standalone complete localExecution retry exits 0 with 193/193 passed in
460.51 seconds. The refreshRulings parse failure remains unresolved.
