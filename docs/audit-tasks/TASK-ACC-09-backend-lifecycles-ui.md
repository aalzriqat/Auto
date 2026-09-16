# TASK-ACC-09: Backend-only lifecycles with no UI (reopen, failed-outbox retry, unmatch)

## Severity: P2 Low

## Problem Statement
Several critical lifecycle mutations exist in the backend engine but have no interface exposure:
1. `api.accountingPeriods.reopen`: Reopening closed periods when authorized by `MANAGE_FINANCE`.
2. `api.accountingOutbox.retryFailed` & `redrive`: Retrying failed outbox posting attempts.
3. `api.bankReconciliation.unmatch`: Unmatching incorrectly matched statement lines.
Because no screen exposed these, recoverable operational exceptions were dead ends for users.

## Failing-First Test
- UI Test: Verify that buttons/actions for Reopen Period, Retry Failed Outbox, and Unmatch are rendered and invoke the respective mutations.

## Implementation Details
1. `AccountingPeriodsTable.tsx` & `AccountingSetupTab.tsx`:
   - Added `ReopenPeriod` action button on CLOSED periods (gated by `canLockPeriod` / `PERMISSIONS.REOPEN_PERIODS`).
   - Prompts for required reopen reason using `EnterReopenReason` translation.
   - Invokes `api.accountingPeriods.reopen` with `{ orgId, periodId, reason }` and provides toast notification on success.
2. `PendingAccountingEventsTable.tsx` & `AccountingSetupTab.tsx`:
   - Added Actions column to `PendingAccountingEventsTable`.
   - Renders `RetryEvent` button with spinner for events with status `FAILED` or `attempts > 0`.
   - Prompts confirmation with `ConfirmRetryOutbox` before invoking `api.accountingOutbox.retryFailed`.
3. `ReconciliationPanel.tsx`:
   - Added view toggle (`UnmatchedLines` vs `MatchedLines`).
   - For `MatchedLines`: queries `api.bankReconciliation.listStatementLines` with `status: "MATCHED"`.
   - Renders `Unmatch` button for each matched line, prompting `ConfirmUnmatch` and invoking `api.bankReconciliation.unmatch`.
4. `lib/i18n/domains/common.ts`:
   - Added bilingual translation keys for all reopen, retry, and unmatch flows.

## Verification Evidence
- Ran `pnpm vitest run convex/bankReconciliation.test.ts` (11/11 tests pass).
- Ran `pnpm vitest run convex/accountingOutboxAtomicity.test.ts` (17/17 tests pass, including retryFailed).
- Ran `pnpm typecheck` (clean frontend compile).
- Ran `pnpm typecheck:convex` (clean backend compile).
- Status: **VERIFIED & CLOSED**.
