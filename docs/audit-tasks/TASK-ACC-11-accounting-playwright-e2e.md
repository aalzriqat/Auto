# TASK-ACC-11: No Accounting Playwright E2E suite

## Severity: P1 High

## Problem Statement
The repository had zero browser-level Playwright tests exercising any accounting screens (`/accounting` routes). Consequently, UI regressions in manual journal entry, collections, receivables, bank accounts, or permission gates shipped undetected.

## Failing-First Test
- E2E Spec: `playwright/tests/accounting.spec.ts`
- Navigates through accounting tabs, verifies tab rendering, tests manual journal creation, verifies collections and cheque actions, and tests bank accounts and setup status.

## Implementation Details
1. Create `playwright/tests/accounting.spec.ts` with comprehensive browser test scenarios:
   - Organization accounting workspace navigation and tab switching.
   - Manual journal form entry with accounting date, debit/credit balancing, and submission.
   - Collections tab verification: receivables list, cheque deposit/clear confirmation prompts.
   - Bank accounts tab verification: account cards, reconciliation targets, and confirmation guards.
   - Setup tab verification: chart of accounts status and periods.

## Verification Evidence
- Status: Planned for implementation.
