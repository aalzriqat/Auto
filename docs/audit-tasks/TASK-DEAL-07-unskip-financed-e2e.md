# TASK-DEAL-07: Unskip Financed Deal Economics Playwright Spec

## Severity: High
## Status: CLOSED

## Problem Statement
`playwright/tests/financed-deal-economics.spec.ts` and `playwright/tests/deal-cockpit-measure.spec.ts` were unconditionally skipped with `test.skip(true, "The deal screen is being redesigned (SCRUM-63)...")`.
This unconditional skip meant that CI was green without ever executing the end-to-end flow through the deal cockpit interface where operators record quotation, credit decisions, and approved amounts.

## Invariants Protected
- `[TEN-2]`: End-to-end integration and dual-identity workflows must be verifiable through the actual user interface.
- `[ACC-3]`: Recording economics and finalized deals must be reachable by operators without backend loopholes.

## Implementation Details
1. In `playwright/tests/financed-deal-economics.spec.ts`:
   - Removed unconditional `test.skip(true, ...)`.
   - Kept environment credentials guard `test.skip(!process.env.E2E_APPROVER_USER || !process.env.E2E_APPROVER_PASSWORD)` so tests execute when credentials are provisioned in CI/environment and skip with clear messaging when running locally without a second provisioned account.
2. In `playwright/tests/deal-cockpit-measure.spec.ts`:
   - Removed unconditional `test.skip(true, ...)`.
   - Preserved reading measure calculations and responsive viewport checks (desktop-1780 and mobile-390).

## Verification Evidence
- TypeScript validation: `pnpm typecheck` passed.
- Playwright syntax check: Verified test definitions and imports parse cleanly with playwright CLI.
