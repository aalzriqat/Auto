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
contradictory submitted costs, including purchasePrice-only edits that disagree
with the stored supplier cost. The direct and approval doors share a pure patch
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
deadline and operator runner, before inbox verification. Locked/unreadable rows
make rollout incomplete, with counts only; they need a reviewed correction.

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
