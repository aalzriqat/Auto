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
| `VehicleCostBar`, `ReviewVehicleCard`, `VehiclePicker`, `Step1QuoteSetup`, `VehicleDetailsDialog`, vehicles page | Displayed cost / suggested pricing basis can be stale; server money decisions remain authoritative. |
| `VehicleDialog`, `ApprovalOwnershipChooser`, `VehicleImportDialog`, `vehicleSheet`, `vehicle.schema`; lib `ownershipGaps`, `importSupplierMapping` | Form/export/import values and completeness hints; submitted costs can become writes. |
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
normalizer. Keep concession, opening-basis and posted-acquisition checks in their
existing order. Ownership flips remain behind the existing pilot containment.

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
