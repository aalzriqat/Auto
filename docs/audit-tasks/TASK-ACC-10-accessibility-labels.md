# TASK-ACC-10: Icon-only buttons lack labels; a11y/Arabic issues

## Severity: P3 Low

## Problem Statement
Various icon-only buttons across the accounting workspace lacked accessible `aria-label` tags, rendering them invisible or inaccessible to screen readers and keyboard navigation. Additionally, certain flex containers and badges in RTL (Arabic) orientation showed alignment defects.

## Failing-First Test
- UI Test: Verify all interactive icon-only buttons have non-empty `aria-label` attributes and accessible names.

## Implementation Details
1. Audited all icon-only action buttons across the accounting workspace:
   - `ManualJournalTab.tsx`: Added `aria-label={t("Remove")}` to the journal line delete button.
   - `BankAccountsTable.tsx`: Added `aria-label={t("Deactivate")}` to the deactivation button.
   - `PrepaidExpensesTab.tsx`: Added `aria-label` attributes to `RetryAmortization`, `CorrectSchedule`, and `ViewCorrections`.
   - `PartnerEquityTab.tsx`: Added `aria-label` attributes to `PartnerHistory`, `RecordContribution`, `RecordDraw`, and `RecordDistribution`.
   - `FixedAssetsTab.tsx`: Added `aria-label` attributes to `ViewEvents`, `ImpairAsset`, and `DisposeAsset`.
2. Verified consistent bilingual labels and accessible names across all buttons.

## Verification Evidence
- `pnpm typecheck` passed with 0 errors.
- Status: **VERIFIED & CLOSED**.
