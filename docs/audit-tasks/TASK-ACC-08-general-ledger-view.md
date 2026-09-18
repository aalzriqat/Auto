# TASK-ACC-08: "Transaction Register" is not the GL

## Severity: P2 Low

## Problem Statement
`components/accounting/GeneralLedgerTab.tsx` was presented under the tab "Transaction Register" / "General Ledger", but it only displayed entries from the simple `transactions` cash register table (with columns Date, Type IN/OUT, Category, Description, Amount). This is not a true general ledger view (chart of accounts, debits, credits, journal entry reference, running balance) and is misleading to accounting professionals.

## Failing-First Test
- UI Test: Assert that the accounting workspace provides a true General Ledger view querying `api.accountingLedger.listJournalEntries` and `api.accountingLedger.getAccountActivity` with debit/credit columns, account codes, and journal links, while keeping the transaction register distinctly labeled.

## Implementation Details
1. In `components/accounting/GeneralLedgerTab.tsx`:
   - Added top view switcher between `GeneralLedger` (Journal Entries) and `TransactionRegister` (Cash register transactions).
   - In General Ledger view: queries `api.accountingLedger.listJournalEntries` and displays accounting dates, journal entry number (`journalNumber`), memo, source (`sourceType: sourceId`), and status.
   - Added "View Lines" action dialog querying `api.accountingLedger.getJournalEntry` displaying individual debit and credit lines, descriptions, and net amounts.
   - Preserved cash transaction register view with full date filtering and IN/OUT categorization.
2. In `lib/i18n/domains/common.ts`:
   - Added bilingual strings for `GeneralLedger`, `JournalEntries`, `EntryNumber`, `Debit`, `Credit`, `Memo`, `NoJournalEntriesFound`, `ViewLines`, and `JournalLines`.

## Verification Evidence
- `pnpm typecheck` passed with 0 errors.
- `pnpm typecheck:convex` passed with 0 errors.
- Status: **VERIFIED & CLOSED**.
