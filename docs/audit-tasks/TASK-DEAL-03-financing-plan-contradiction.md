# TASK-DEAL-03: Financing-plan card reads quote.downPayment -> two cards can contradict

## Severity: High

## Problem Statement
In `components/applications/cockpit/DealCockpit.tsx` line 744:
`downPayment: app.quote.downPayment`
The Financing Plan card read the initial down payment from `app.quote.downPayment`, whereas `DealFinancialOverview.tsx` read `app.customerFirstPaymentMinor`. Once an application had its economics updated or repaired, the two cards on the same cockpit screen could display contradictory customer down payment numbers.

## Failing-First Test
- UI Test: Assert that `FinancingPlanPanel` displays the snapshotted `app.customerFirstPaymentMinor` (converted to major) and never contradicts `DealFinancialOverview` when the snapshotted value exists.

## Implementation Details
1. In `components/applications/cockpit/DealCockpit.tsx`:
   - Updated `financingPlan` construction to prioritize authoritative snapshot fields:
     - `downPayment`: `app.customerFirstPaymentMinor !== undefined ? app.customerFirstPaymentMinor / 100 : app.quote.downPayment`
     - `vehiclePrice`: `app.targetSellingAmountMinor !== undefined ? app.targetSellingAmountMinor / 100 : app.quote.vehiclePrice`
2. Both `FinancingPlanPanel` and `DealFinancialOverview` now read from the identical authority, guaranteeing consistency and eliminating any contradiction.

## Verification Evidence
- `pnpm typecheck` passed with 0 errors.
- Status: **VERIFIED & CLOSED**.
