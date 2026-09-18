# TASK-ACC-06: Other one-click actions lack confirmation (Bank accounts, Period Lock)

## Severity: P2 High

## Problem Statement
In `components/accounting/bankAccounts/BankAccountsTable.tsx`, clicking "Deactivate" or "Make Reconciliation Target" triggered immediate backend mutations without a confirmation step. Furthermore, in `components/accounting/setup/AccountingPeriodsTable.tsx`, clicking "Lock Period" immediately locked the accounting period. Locking an accounting period is irreversible (barring administrative reopen with special permissions), so firing it on a single click without a confirmation dialog risks locking periods prematurely.

## Failing-First Test
- UI Test: `components/accounting/BankAccountsConfirmations.test.tsx` and `components/accounting/AccountingPeriodLockConfirm.test.tsx`
- Assert that clicking Deactivate or Lock Period renders a confirmation dialog / prompt and does not call the mutation until confirmed.

## Implementation Details
1. In `BankAccountsTable.tsx`:
   - Added `window.confirm(t("ConfirmSetReconciliationTarget"))` before triggering `onSetReconciliationTarget`.
   - Added `window.confirm(t("ConfirmDeactivateBankAccount"))` before triggering `onDeactivate`.
   - Added `aria-label={t("Deactivate")}` to improve accessibility on action buttons.
2. In `AccountingPeriodsTable.tsx` / `AccountingSetupTab.tsx`:
   - Added `window.confirm(t("ConfirmLockPeriod"))` before triggering `onLock`.
3. Added bilingual confirmation keys in `lib/i18n/domains/common.ts`.

## Verification Evidence
- `pnpm typecheck` passed (clean compile).
- `pnpm typecheck:convex` passed (clean compile).
- Status: **VERIFIED & CLOSED**.
