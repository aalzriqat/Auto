# TASK-ACC-02: Missing required system account not repairable in-product

## Severity: P0 Critical

## Problem Statement
If an organization's chart of accounts lacked a system account (such as clearing accounts, customer receivables, inventory, or cash drawer accounts), every subsequent accounting posting requiring that key would fail closed. Previously, there was no in-product mechanism to detect or repair these missing accounts without direct database intervention or custom script execution.

## Failing-First Test
- Test file: `convex/freshChartUnappliedReceipts.test.ts`
- Verifies that `repairMissingSystemAccounts` identifies missing keys, provisions them with the correct normal balance, currency, and system key, and is idempotent (does not duplicate existing keys).

## Implementation Details
1. `convex/chartOfAccounts.ts:repairMissingSystemAccounts`:
   - Checks existing active accounts for the organization.
   - Determines missing required system keys from the canonical chart specification.
   - Creates the missing accounts with proper system keys and logs the repair in the audit trail.
2. `components/accounting/setup/SetupStatusCards.tsx`:
   - Displays a repair trigger card when system accounts are incomplete.
   - Invokes `repairMissingSystemAccounts` with operator feedback.

## Verification Evidence
- Ran `pnpm vitest run convex/freshChartUnappliedReceipts.test.ts`:
  - 16/16 passed across all unapplied receipts, missing 2110 fail-closed, and repair cases.
  - Duration: 2.32s.
  - Exit code: 0.
- Status: **VERIFIED & CLOSED**.
