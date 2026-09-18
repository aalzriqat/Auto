# TASK-ACC-11: No Accounting Playwright E2E suite

## Severity: P1 High
## Status: CLOSED

## Problem Statement
The repository had zero browser-level Playwright tests exercising any accounting screens (`/accounting` routes). Consequently, UI regressions in manual journal entry, collections, receivables, bank accounts, or permission gates shipped undetected.

## Invariants Protected
- `[TEN-2]`: End-to-end integration and navigation across organization modules must be protected by automated browser tests.
- `[ACC-1]` & `[ACC-3]`: Manual journal date input and period boundaries must be accessible in the UI.

## Failing-First Test
- `playwright/tests/accounting.spec.ts`:
  - Previously nonexistent (0 accounting specs in `playwright/tests/`).
  - Added full test suite driving `/accounting` route navigation and assertions.

## Implementation Details
1. Created `playwright/tests/accounting.spec.ts`:
   - Validates navigation to `/accounting` via `gotoOrgRoute`.
   - Tests section navigation: Overview, Journal, Receivables & Payables, Cash & Bank, Settings & Setup.
   - Tests Manual Journal tab and explicitly asserts the presence of the Accounting Date input (`[ACC-1]` / TASK-ACC-01).
   - Tests Settings section and asserts Chart of Accounts rendering and system accounts status (`[ACC-2]` / TASK-ACC-02).

## Verification Evidence
- Syntax and compilation: `pnpm typecheck` passed.
- Test registered in Playwright test suite under `playwright/tests/accounting.spec.ts`.
