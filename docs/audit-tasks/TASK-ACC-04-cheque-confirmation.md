# TASK-ACC-04: Cheque Deposit/Clear mutate without confirmation

## Severity: P1 High

## Problem Statement
In `components/accounting/CollectionsTab.tsx`, a single accidental click on "Deposit" or "Clear" for a post-dated cheque immediately advanced the cheque's lifecycle and posted a financial entry to the general ledger, with no confirmation prompt. Accidental clicks created permanent, audit-logged ledger entries that required complex accounting reversals.

## Failing-First Test
- UI Test: Verify that clicking "Deposit" or "Clear" triggers an explicit confirmation dialogue / prompt before the mutation can be dispatched, and that cancelling leaves state untouched.

## Implementation Details
1. Wrapped Cheque Deposit and Cheque Clear handlers in `CollectionsTab.tsx` with explicit confirmation checks.
2. Gated the actions behind `canManage` permissions.

## Verification Evidence
- Verified in `components/accounting/CollectionsTab.tsx` (lines 171-197):
  - `runChequeAction` prompts with `ConfirmChequeDeposit` and `ConfirmChequeClear`.
  - Cheque action buttons are gated by `{canManage && ...}`.
  - Idempotency key `clear-cheque:${cheque._id}` used for clearing.
- Status: **VERIFIED & CLOSED**.
