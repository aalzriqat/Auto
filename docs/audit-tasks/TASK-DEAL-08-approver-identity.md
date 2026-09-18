# TASK-DEAL-08: Approver identity and dual-actor separation

## Severity: Medium
## Status: CLOSED

## Problem Statement
Separation of duties requires that the salesperson who builds and quotes a deal cannot be the same person who approves the dealer purchase amount or updates status (`approveDealerPurchaseAmount` and `updateStatus` refuse the application's own salesperson).
Previously, dual-identity setup in Playwright had skipped permanently because `test.skip()` had evaluated against local session files rather than discovery-level environment credentials.

## Invariants Protected
- `[TEN-2]`: Role boundaries and dual-actor duties enforcement: salesperson cannot approve their own deals.
- `[ACC-3]`: Segregation of duties prevents self-approval of financial liabilities and contributions.

## Implementation Details
1. `playwright/tests/financed-deal-economics.spec.ts` relies on two distinct identities:
   - Salesperson identity: creates vehicle, customer, finance application, and records quotation.
   - Approver / Manager identity (`E2E_APPROVER_USER` / `E2E_APPROVER_PASSWORD`): reviews application, approves credit decision, and records approved purchase amount.
2. Verified discovery-level evaluation of environment variables in Playwright so CI runners with provisioned approvers execute the dual-identity suite reliably.

## Verification Evidence
- Vitest unit test coverage: `convex/applications.test.ts` ("rejects missing applications, invalid transitions, self-approval, and missing approval quote").
- `components/applications/cockpit/DealCockpitSupplierAuthority.test.tsx` ("a salesperson on their own deal cannot approve").
