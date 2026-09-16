# TASK-ACC-01: Manual journal UI omits accountingDate

## Severity: P0 Critical

## Problem Statement
The manual-journal form (`components/accounting/ManualJournalTab.tsx`) had no date field, so journals posted at approval time (`Date.now()`) instead of the accounting date the user intended. This led to entries being posted into the wrong accounting period and distorting financial reports.

## Failing-First Test
- Test file: `convex/manualJournalAccountingDate.test.ts`
- Verifies that `accountingDate` is accepted by the mutation and stored on both `journalEntries` and `journalLines`, and that omitting it or supplying an invalid date fails closed.

## Implementation Details
1. Added `accountingDate` to `manualJournal.schema.ts` with validation (format YYYY-MM-DD, UTC conversion).
2. Added date input field in `ManualJournalTab.tsx` with default to current date.
3. Passed `accountingDate` in payload to `api.financialAudit.createManualJournalDraft` and related endpoints.

## Verification Evidence
- Ran `pnpm vitest run convex/manualJournalAccountingDate.test.ts`:
  - 16/16 passed across all date parsing and posting cases.
  - Duration: 2.07s.
  - Exit code: 0.
- Status: **VERIFIED & CLOSED**.
