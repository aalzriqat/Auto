# Audit Tasks Master Register

This directory tracks the investigation, failing-first tests, implementation, verification, and status of every finding identified in the Claude audit report across Accounting and Unified Deal stories.

## Summary Status

| Task ID | Component | Title | Severity | Status | Verified |
|---|---|---|---|---|---|
| [TASK-ACC-01](./TASK-ACC-01-manual-journal-date.md) | Accounting | Manual journal UI omits `accountingDate` | P0 Critical | CLOSED | Verified |
| [TASK-ACC-02](./TASK-ACC-02-system-accounts-repair.md) | Accounting | Missing required system account not repairable in-product | P0 Critical | CLOSED | Verified |
| [TASK-ACC-03](./TASK-ACC-03-claims-tab-writers.md) | Accounting | Claims tab is a dead UI (retired writers) | P1 High | CLOSED | Verified |
| [TASK-ACC-04](./TASK-ACC-04-cheque-confirmation.md) | Accounting | Cheque Deposit/Clear mutate without confirmation | P1 High | CLOSED | Verified |
| [TASK-ACC-05](./TASK-ACC-05-collections-permissions.md) | Accounting | Collections / Cash Drawer actions shown without permission | P1 High | CLOSED | Verified |
| [TASK-ACC-06](./TASK-ACC-06-one-click-confirmations.md) | Accounting | Other one-click actions lack confirmation (Bank accounts, Period Lock) | P2 High | CLOSED | Verified |
| [TASK-ACC-07](./TASK-ACC-07-selectors-pagination.md) | Accounting | Selectors capped at first 100 customers/vehicles | P2 High | CLOSED | Verified |
| [TASK-ACC-08](./TASK-ACC-08-general-ledger-view.md) | Accounting | "Transaction Register" is not the GL | P2 Low | CLOSED | Verified |
| [TASK-ACC-09](./TASK-ACC-09-backend-lifecycles-ui.md) | Accounting | Backend-only lifecycles with no UI (reopen, retry, unmatch) | P2 Low | CLOSED | Verified |
| [TASK-ACC-10](./TASK-ACC-10-accessibility-labels.md) | Accounting | Icon-only buttons lack labels; a11y/Arabic issues | P3 Low | CLOSED | Verified |
| [TASK-ACC-11](./TASK-ACC-11-accounting-playwright-e2e.md) | Accounting | No Accounting Playwright E2E suite | P1 High | CLOSED | Verified |
| [TASK-DEAL-01](./TASK-DEAL-01-quote-economics-lineage.md) | Unified Deal | `createFromQuote` drops quote economics (target / first payment) | Critical | CLOSED | Verified |
| [TASK-DEAL-02](./TASK-DEAL-02-solver-first-payment.md) | Unified Deal | Solver defaults first payment to 0 and persists it | High | CLOSED | Verified |
| [TASK-DEAL-03](./TASK-DEAL-03-financing-plan-contradiction.md) | Unified Deal | Financing-plan card reads `quote.downPayment` -> contradiction | High | CLOSED | Verified |
| [TASK-DEAL-04](./TASK-DEAL-04-cockpit-closing-bindings.md) | Unified Deal | Cockpit lacks `recordLegalInvoice`, `classifyDealAccounting`, `reconcileDealFee` | High | CLOSED | Verified |
| [TASK-DEAL-05](./TASK-DEAL-05-failure-reason-writer.md) | Unified Deal | Failure reason / appraisal-fee responsibility have no writer | Low | CLOSED | Verified |
| [TASK-DEAL-06](./TASK-DEAL-06-employee-custody-ledger.md) | Unified Deal | Employee custody read-only / off-ledger, no reversal | Critical | CLOSED | Verified |
| [TASK-DEAL-07](./TASK-DEAL-07-unskip-financed-e2e.md) | Unified Deal | Financed-deal & responsive Playwright specs unconditionally skipped | High | CLOSED | Verified |
| [TASK-DEAL-08](./TASK-DEAL-08-approver-identity.md) | Unified Deal | Live completion blocked — no second Bloom Cars approver identity | Low | CLOSED | Verified |
