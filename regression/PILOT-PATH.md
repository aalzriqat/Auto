# Pilot path: coverage map and gaps (SCRUM-761, owner ruling SCRUM-760 c22474)

Narrowed pilot: ONE dealer, cash sale + financed sale through delivery. This file is what the pilot go/no-go reads for the regression library. Evidence boundary: static search of `origin/main` test files at c971e6343 plus the library validator; **no test in this list was executed here as a record-driven run** (the S3 runner census is the binding proof). "Absent" means "not found by search", not proven missing.

## Recorded as library records (active, bound to existing backend tests)

| Record | Bound test | Ruling |
| --- | --- | --- |
| cash-taxed-owned-sale-gl-subledger-invoice-agree | convex/ownedSaleTaxEndToEnd.test.ts | SCRUM-760#c22465 (R-CONSISTENCY) |
| financed-v2-finalize-freezes-forward-due-and-full-receivable | convex/financeCompanyForward.test.ts | SCRUM-407#c21031 |
| financed-v2-sale-journal-ap-finance-carries-deposit-plus-contribution | convex/financeCompanyForward.test.ts | SCRUM-407#c21031 |
| financed-v2-forward-clears-payable-then-transfer-settles-full-approved | convex/financeCompanyForward.test.ts | SCRUM-407#c21031 |
| financed-v2-commission-base-is-approved-less-contribution | convex/commissionMarginBase.test.ts | SCRUM-407#c21031 |
| financed-appraisal-gap-is-net-shortfall-and-blocks-the-rail | convex/financingEconomics.test.ts | SCRUM-407#c21031 |

Plus, from earlier PRs: three `saleEconomics` rule records and the financed-finalize permission record (refusal half only).

## Gaps (pilot-path steps with no backend test asserting the outcome)

1. **No end-to-end cash flow**: quote -> `sales.create` -> real `collections.recordPayment` on the sale's own receivable -> GL cash/AR -> COMPLETED. Payment is either a generic receivable or the `payInvoice` fixture (scrum571s2*). PAYMENT_LINK is shut, so this is the live receipt route.
2. **No owned cash sale pins the whole journal by account** (cash/AR, revenue, COGS, inventory) with literal numbers. Tax, COGS and the consigned entry are pinned separately.
3. **Cash delivery has no discrete mutation**; HANDOVER is a rail state tied to COMPLETED, so only reader state is tested.
4. **No single financed test chains** quote -> approval -> handover -> finalize -> forward -> `confirmDisbursement` -> reports. Pieces are spread over four files.
5. **Financed revenue/margin on the P&L report (not the commission base) for an owned car is pinned only by v1 pure tests and cockpit readers**; no v2 P&L parity test. The v1 posting-plan tests pin a superseded rule (stale-risk).
6. **Configured-company route with a customer gap through `finalizeDeal` plus the customer's real `recordPayment` on the gap invoice**: untested (gap-in-cash journal pinned on the manual route only).
7. **`confirmDisbursement` ledger outcome** on a real v2 deal is pinned via financeCompanyForward / SCRUM-241, but accountingPhase8's own test is seeded and asserts no ledger.
8. **Cash-sale permission denial is thin**: no test of `sales.create` refused for a role without the permission.
9. **Cash cancel**: covered only by the SCRUM-704 matrix (`describe.each`, so not bindable one record per case yet) and accountingPhase8; no cash-payment refund.
10. **Cash P&L parity beyond revenue 15,000 -> 0** (margin, COGS) not asserted.
11. **Weak existing tests**: accountingPhase2 (4-line count only), accountingPhase0 idempotency (row counts only), sales.test ledger-transaction test (legacy row only). Not recorded; strengthening them is its own `convex/` PR.

## Waiting on others

- SCRUM-795 off-switches (manual journal approval, refund payout, salesperson cash receipt): each refusal gets a permission record once it lands, with its failing-first test.
- SCRUM-413b refusal list: needs a SCRUM-413#description digest; deferred behind this.
- Parameterized tests (SCRUM-704 matrix, SCRUM-27 `describe.each`) need per-case titles or the S3 census.
