# TASK-DEAL-06: Employee custody accounting & ledger integration

## Severity: Critical
## Status: CLOSED

## Problem Statement
Deal-level employee cash custody records (`financeDealCustody` and `custodyMovements`) previously tracked custody balances in an off-ledger fashion without canonical GL posting:
- Moving funds to employees for vehicle handover, detailing, transport, or customs clearance was not posting through double-entry accounting (`DEAL_CUSTODY_CLEARING`).
- Reversals, fee allocations (`setFeeCustody`), and write-offs (`reconcileDealCustody`) were not reconciled against the outbox posting pipeline.
- Stranded cash risks existed if applications were cancelled while custody records remained open.

## Invariants Protected
- `[ACC-1]`: Double-entry equality across every custody cash issuance, expense reimbursement, return, and write-off.
- `[ACC-3]`: All deal-borne expenditures must post to immutable ledger journals with auditable lineage to the specific vehicle, deal, and custodian.
- `[ACC-5]`: Period reconciliation rules prevent moving money into closed periods.
- `[TEN-1]`: Multi-tenant boundary verified across every custody mutation and query.

## Failing-First Test
- `convex/dealCustodyAccounting.test.ts`:
  - 131 comprehensive tests asserting GL posting, outbox draining, idempotency fingerprints, period validations, write-offs, and multi-currency handling for employee custody.
- `components/applications/cockpit/DealCockpitCustodyIdentity.test.tsx`:
  - UI command identity tests asserting retained idempotency keys across retries, dialog lifecycles, and network blips.

## Implementation Details
1. Merged PR #316 (`origin/agent/deal-custody-accounting`):
   - Created `convex/utils/custodySourceLedger.ts` providing canonical ledger integration for deal custody.
   - Integrated `DEAL_CUSTODY_CLEARING` system account into `defaultChart.ts` and `chartOfAccounts.ts`.
   - Wired custody posting events into `accounting/postingRules.ts`, `accounting/workflowHooks.ts`, and `accountingOutbox.ts`.
   - Added `planCustodyHandler`, `openDealCustody`, `recordCustodyMovement`, `setFeeCustody`, `reconcileDealCustody`, and `reopenDealCustody` mutations to `convex/financeDealCosts.ts`.
   - Built UI dialogs (`DealCustodyDialogs.tsx`) and enhanced `DealCustodyPanel.tsx` with full accounting controls.
2. Invariant Reconciliation:
   - Preserved `closingChecklist` and `deal-closing-checklist` UI from TASK-DEAL-04.
   - Reconciled economic command classification ratchet in `scripts/economicCommandCensus.test.ts` (120 commands).
   - Re-measured tenant write coverage in `scripts/tenantWriteGuard.test.ts` (495 totalMutations, 323 analysed).
   - Re-measured protected source pins for `convex/applications.ts` in `scripts/protectedSourcePins.test.ts` (232839 bytes).

## Verification Evidence
- `convex/dealCustodyAccounting.test.ts`: 131 passed (100%).
- `components/applications/cockpit/DealCockpitCustodyIdentity.test.tsx`: 10 passed (100%).
- `components/applications/cockpit/DealCockpitClosingBindings.test.tsx`: 3 passed (100%).
- `scripts/economicCommandCensus.test.ts`: 10 passed (100%).
- `scripts/tenantWriteGuard.test.ts`: 8 passed (100%).
- `scripts/protectedSourcePins.test.ts`: 3 passed (100%).
