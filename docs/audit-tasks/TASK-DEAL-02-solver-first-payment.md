# TASK-DEAL-02: Solver defaults first payment to 0 and persists it

## Severity: High

## Problem Statement
When calculating loan options in the financing solver, if no customer first payment was supplied, the solver defaulted the value to `0` and persisted `0` into durable state rather than leaving it unset/undefined. This fabricated financial data and obscured whether the customer had agreed to zero down payment or had not yet specified one.

## Failing-First Test
- Test file: `convex/financingEconomics.test.ts` (test `dd44eda7e`)
- Verifies that when customer first payment is not provided, it remains `undefined` and is not coerced to `0`.

## Implementation Details
1. In `convex/utils/financingEconomics.ts` and `convex/financingEconomics.ts`:
   - Keep `customerFirstPaymentMinor` as `undefined` when absent.
   - Guard against `0` coercion.

## Verification Evidence
- Ran `pnpm vitest run convex/financingEconomics.test.ts`:
  - 170/170 passed across all financing solver and economics tests.
  - Duration: 3.69s.
  - Exit code: 0.
- Status: **VERIFIED & CLOSED**.
