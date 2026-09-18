# TASK-ACC-03: Claims tab is a dead UI (retired writers)

## Severity: P1 High

## Problem Statement
The Claims tab (`components/accounting/ClaimsTab.tsx`) continued to render action buttons for Add, Settle, and Reject backed by mutations that had been retired from the backend engine. Clicking those buttons resulted in errors or dead clicks, presenting misleading actions to accounting personnel.

## Failing-First Test
- Test file: `convex/claimsRetirement.test.ts`
- Verifies that legacy claims writers are retired and that finance company receivables are authoritative and paginated through `api.claims.paginateFinanceCompanyReceivables`.

## Implementation Details
1. Replaced legacy mutations with read-only paginated table backed by `api.claims.paginateFinanceCompanyReceivables`.
2. Removed all dead/retired writer buttons (add, settle, reject).
3. Provided verified deal links and settlement counterparty details for each receivable line.

## Verification Evidence
- Ran `pnpm vitest run convex/claimsRetirement.test.ts`:
  - 23/23 passed across all retired writer refusals and receivable pagination.
  - Duration: 14.01s.
  - Exit code: 0.
- Status: **VERIFIED & CLOSED**.
