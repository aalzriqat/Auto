# TASK-DEAL-04: Cockpit lacks recordLegalInvoice / classifyDealAccounting / reconcileDealFee bindings

## Severity: High
## Status: CLOSED

## Problem Statement
Three crucial backend mutations required to finalize and close a financed deal's accounting:
1. `recordLegalInvoice`: records the official tax/legal invoice number, date, amount, and recipient.
2. `reconcileDealFee`: marks closing and template handover fees reconciled against invoices/receipts with actual amounts and references.
3. `classifyDealAccounting`: marks deal accounting complete (sale recognized, COGS matched).
None of these had UI bindings or dialogs in `components/applications/cockpit/`. As a result, the Unified Deal cockpit could not complete a deal end to end.

## Invariants Protected
- `[ACC-3]`: All sales, COGS, and fee recognition transactions must be traceable to official source documents.
- `[ACC-5]`: Period reconciliation and closing checklists must enforce explicit authorization and documented accounting classification.

## Failing-First Test
- `components/applications/cockpit/DealCockpitClosingBindings.test.tsx`:
  - Assert 1: `renders Record Legal Invoice trigger and binds recordLegalInvoice mutation`
  - Assert 2: `renders Reconcile Fee button on handover fee line and binds reconcileDealFee`
  - Assert 3: `renders Classify Deal Accounting button and binds classifyDealAccounting`
  - First run (before wiring): FAILED on missing UI controls and missing mutation bindings.

## Implementation Details
1. Created `components/applications/cockpit/RecordLegalInvoiceDialog.tsx`:
   - Modal form for entering legal invoice number, amount, date, and recipient (Customer / Finance Company / Other).
   - Validates required inputs and converts major units to minor currency units using scale.
2. Created `components/applications/cockpit/ClassifyDealAccountingDialog.tsx`:
   - Modal form for entering classification sign-off notes and confirming accounting completion.
3. Updated `components/applications/cockpit/HandoverCostsPanel.tsx`:
   - Added `onReconcile?: (feeId: string, actualAmountMinor: number, receiptReference: string) => Promise<void>` to props.
   - Added `ReconcileForm` stateful component and `CheckCheck` action trigger buttons on both template and additional fee items.
4. Updated `components/applications/cockpit/DealCockpit.tsx`:
   - Added `useMutation(api.financeDealCosts.recordLegalInvoice)`.
   - Added `useMutation(api.financeDealCosts.reconcileDealFee)`.
   - Added `useMutation(api.financeDealCosts.classifyDealAccounting)`.
   - Wired `onReconcile` into `handoverCosts` config.
   - Wired `closingChecklist` prop into `DealCockpitView` with legal invoice and accounting classification facts and action triggers.
   - Mounted `RecordLegalInvoiceDialog` and `ClassifyDealAccountingDialog` within `DealCockpit`.
   - Added Deal Closing Checklist card to `DealCockpitView` under `data-testid="deal-closing-checklist"`.
5. Updated `lib/i18n/domains/sales.ts`:
   - Added English and Arabic translations for legal invoice recording, fee reconciliation, and accounting classification.

## Verification Evidence
- Vitest run: `pnpm vitest run components/applications/cockpit/DealCockpitClosingBindings.test.tsx`
  - Result: 3 passed (100%)
- Cockpit test suite: `pnpm vitest run components/applications/cockpit/`
  - Result: 18 passed, 1 skipped (395 passed tests)
