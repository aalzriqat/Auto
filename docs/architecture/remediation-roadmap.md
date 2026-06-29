# Finance Remediation Roadmap

Date: 2026-06-28

Recommended approach: create a proper accounting foundation first, then migrate workflows behind it. Isolated fixes to `transactions` will not produce a trustworthy accounting system.

## Phase 0 - Stop The Bleeding

Goal: prevent new damage while the accounting foundation is designed.

Actions:

- Disable or restrict financial hard deletes in admin tools.
- Lock direct edits to posted financial records where possible.
- Add idempotency keys to high-risk commands: sale creation, deposit creation, payment recording, cheque clearing, refund approval.
- Enforce requester and approver separation for refunds, cancellations, reschedules, and cashier reconciliation.
- Add server-side validation that every linked entity belongs to the active org before writes.
- Block finance application finalization from bypassing the canonical sale posting path.
- Add warnings in UI/reports that `transactions` is not an accounting ledger until replaced.

Acceptance gates:

- Duplicate button submission cannot create duplicate payments, deposits, or sales.
- Super-admin hard delete cannot remove financial rows without an explicit break-glass workflow.
- Finance-finalized sales and normal sales route through one server-side command.

## Phase 1 - Money, Periods, And Accounts

Goal: introduce the primitives required for accounting correctness.

Actions:

- Add integer minor-unit money fields with `currency` and `scale`.
- Define supported currencies and rounding policy, including JOD three-decimal handling.
- Add `chartOfAccounts`.
- Add `accountingPeriods` with OPEN/CLOSING/CLOSED/LOCKED states.
- Add closed-period validation utilities.
- Add account dimensions: org, branch, vehicle, customer, finance company, salesperson, and optional project/cost center.

Acceptance gates:

- New postings cannot use floating-point amounts.
- New postings cannot target closed periods.
- Trial balance can group by account and period.

## Phase 2 - Posting Engine

Goal: centralize all financial effects.

Actions:

- Add `accountingEvents` with source type, source id, event type, event version, idempotency key, payload hash, actor, and timestamp.
- Add `journalEntries` and `journalLines`.
- Implement a posting engine that validates balanced debit/credit totals.
- Implement reversal and repost primitives.
- Version posting rules for each event type.
- Stop direct inserts into `transactions` for new workflows; keep legacy rows read-only during migration.

Initial event types:

- `deposit.received`
- `deposit.applied`
- `deposit.refunded`
- `deposit.forfeited`
- `sale.completed`
- `sale.cancelled`
- `expense.posted`
- `expense.reversed`
- `payment.received`
- `payment.allocated`
- `payment.refunded`
- `cheque.received`
- `cheque.cleared`
- `cheque.returned`
- `finance.disbursed`
- `commission.accrued`
- `commission.paid`

Acceptance gates:

- Every event posts zero or one balanced journal entry.
- Duplicate idempotency key returns the original event result.
- Reversing an event creates a linked reversal entry and does not mutate the original.

## Phase 3 - Receivables, Payments, And Allocations

Goal: make customer balances reconstructable.

Actions:

- Add receivable document or invoice table separate from installment schedule.
- Add `paymentIntents` for payment links/provider flows.
- Add `payments` with method, direction, verification state, settlement state, provider, external id, and bank reference.
- Add `paymentAllocations` for many-to-many allocation between payments and receivables.
- Add unapplied cash/customer credit handling.
- Add allocation reversal and refund linkage.
- Update collection screens to allocate payments explicitly.

Acceptance gates:

- One payment can allocate across multiple receivables.
- One receivable can be paid by multiple payments.
- Over-allocation is impossible.
- Aging can be rebuilt from documents and allocations.
- Refunds reverse allocations before paying out.

## Phase 4 - Workflow Migration

Goal: move operational modules to the posting engine.

Actions by workflow:

- Sales: one canonical sale completion command; post revenue, AR/cash, tax if applicable, inventory relief, COGS, deposit application, and commission accrual.
- Deposits: post customer deposit liability on receipt, reclassify on application, refund, or forfeit.
- Finance applications: add approved amount, financed amount, disbursed amount, fees, shortfall, finance-company receivable, and settlement events.
- Cheques: support received, deposited, cleared, returned before clear, returned after clear, replaced, and fee events.
- Bank transfers: add pending verification and reconciliation before final cash posting.
- Payment links: add provider webhook verification, provider event idempotency, settlement, fee, and failure states.
- Expenses: lock posted expenses; updates require reversal/repost.
- Work orders: route cost posting through expense or inventory cost adjustment events.
- Fixed assets: add capitalization, depreciation, disposal, and gain/loss events.
- Partner equity: replace editable balances with contribution/draw/allocation events.
- Claims: add claim receivable/payable and settlement events.

Acceptance gates:

- Every operational workflow has an explicit event-to-journal mapping.
- No domain module inserts ledger rows directly.
- Reversals exist for every posted workflow.

## Phase 5 - Ledger-backed Reporting

Goal: make reports authoritative and scalable.

Actions:

- Build projections from journal lines and subledger events.
- Replace P&L with account-based report from trial balance projection.
- Replace accounting ledger tab with journal entry/line browser.
- Replace collections aging with allocation-derived projection.
- Add subledger-to-control-account reconciliation reports.
- Replace capped financial totals with export jobs or paginated aggregation.
- Add rebuild jobs and reconciliation checks.

Acceptance gates:

- Trial balance balances for every period.
- P&L ties to revenue and expense accounts.
- Receivables aging ties to AR control account.
- Customer deposits tie to customer deposits liability account.
- Cashier reports tie to cash account and bank deposits.

## Phase 6 - Backfill And Parallel Run

Goal: preserve history and prove the new model before switching.

Actions:

- Snapshot legacy `transactions`, sales, deposits, receivables, payments, cheques, and expenses.
- Map historical records to opening balances and synthetic accounting events where reliable.
- Mark records that cannot be reconstructed as migration adjustments.
- Run legacy reports and new reports in parallel.
- Reconcile differences by period, account, customer, vehicle, and payment method.
- Keep legacy tables read-only until audit signoff.

Acceptance gates:

- Opening balances are approved.
- Differences between legacy and new reports are explained.
- New reports become authoritative only after reconciliation signoff.

## Phase 7 - Hardening And Governance

Goal: make the finance platform durable under real usage.

Actions:

- Add property-based tests for balanced postings and allocation invariants.
- Add concurrency tests for duplicate payment callbacks and duplicate user submissions.
- Add permission tests for segregation of duties.
- Add closed-period tests.
- Add report reconciliation tests.
- Add operational runbooks for payment provider failures, returned cheques, cashier variance, and period close.
- Add monitoring for posting failures, unallocated payments, unmatched provider events, and subledger/control mismatches.

Acceptance gates:

- Test suite blocks unbalanced journals.
- Monitoring alerts on unmatched money movement.
- Finance close can be run and reviewed repeatably.

## Recommended Implementation Order

1. Phase 0 controls.
2. Money model, chart of accounts, and periods.
3. Accounting event registry and posting engine.
4. Receivable/payment/allocation subledger.
5. Sales, deposits, refunds, and cancellations.
6. Cheques, bank transfers, and payment links.
7. Finance applications and finance-company receivables.
8. Inventory, expenses, work orders, fixed assets, partner equity, claims, and commissions.
9. Ledger-backed reports and reconciliation.
10. Backfill, parallel run, and signoff.

## Test Suite Priorities

- Balanced journal invariant for every posting rule.
- Idempotent sale creation, deposit creation, payment record, cheque clear, and provider callback.
- Duplicate payment callback posts once.
- Partial payment allocation and over-allocation prevention.
- One payment across multiple receivables.
- Multiple payments against one receivable.
- Refund reverses allocation and journal impact.
- Sale cancellation reverses sale, inventory, deposit application, commission, and receivable impact.
- Expense correction uses reversal/repost.
- Cleared cheque return reopens AR and posts bank fee.
- Cashier cannot approve own reconciliation.
- Requester cannot approve own refund/reschedule/cancellation.
- Closed period rejects normal posting.
- Reports tie to trial balance and subledger control accounts.
