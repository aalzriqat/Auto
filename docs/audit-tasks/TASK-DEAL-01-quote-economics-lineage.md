# TASK-DEAL-01: createFromQuote drops quote economics (target / first payment)

## Severity: Critical

## Problem Statement
When converting an accepted quotation to a finance application (`convex/applications.ts:createFromQuote`), the agreed target selling amount and customer first payment were dropped. Downstream calculations (LTV, loan amounts, dealer net proceeds) operated on unanchored values.

Furthermore, Sonnet's code review on PR #317 identified a blocking medium finding:
Five refusal paths in `repairQuoteEconomicsLineage` (`convex/applications.ts`) had zero line coverage:
1. Non-in-flight application status refusal.
2. Existing quotation/approval/disbursement/finalization evidence refusal.
3. Requested currency differing from organization denomination refusal.
4. Existing application currency differing from requested currency refusal.
5. Company-backed application missing its frozen company rule snapshot refusal.

## Failing-First Test
- Test file: `convex/applications.test.ts` (lines 890–975)
- Added parameterized tests covering all 5 fail-closed guards:
  - `refuses repair when application status is terminal (not in-flight)`
  - `refuses repair when downstream milestone evidence (submitted quotation) exists`
  - `refuses repair when downstream milestone evidence (approved purchase) exists`
  - `refuses repair when requested currency does not match organization currency`
  - `refuses repair when application already denominated in a different currency`
  - `refuses repair when company-backed application is missing its frozen rule snapshot`
- Assert that each guard throws the specific `ConvexError` and proves no application field changed (`expect(snapshotAfter).toEqual(snapshotBefore)`).

## Implementation Details
1. `createFromQuote`: Snapshots `targetSellingAmountMinor`, `customerFirstPaymentMinor`, `targetNetProceedsMinor`, and estimated closing expenses directly from the accepted quote into `financeApplications`.
2. `repairQuoteEconomicsLineage`: Provides audited, dry-run-capable repair for historical records without mutating closed/milestone deals.

## Verification Evidence
- Ran `pnpm vitest run convex/applications.test.ts`:
  - 38/38 passed (including all 6 repair and fail-closed tests).
  - Exit code: 0.
- Status: **VERIFIED & CLOSED**.
