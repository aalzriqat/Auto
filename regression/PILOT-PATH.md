# Pilot path: coverage map and gaps (SCRUM-761 / SCRUM-816)

**Current owner contract (SCRUM-813 c22752, 2026-10-10): Option B.** The one-dealer 30-day no-code pilot requires customer receipt application, unwind/refund or retained credit, and audited operator correction across enabled CASH and FINANCED routes before launch. Payment links remain outside pilot scope (SCRUM-813 c22798). The narrower SCRUM-795 controls stay in force until the broader actions are deliberately enabled and certified. SCRUM-760 remains open; this document is a coverage map, not a release verdict.

The recorded rows and gaps below are a **historical through-delivery snapshot** from a static search of `origin/main` test files at `c971e6343` plus the library validator. They were not executed here as a record-driven run; "absent" means not found by that search, not proven missing today. In particular, the old through-delivery list cannot certify the Option B lifecycle.

## Current SCRUM-816 journey expansion (source inventory at main `6e2408828`)

The bidirectional source locator in draft PR #551 finds candidate route/API wiring, not enabled actions or runtime proof. SCRUM-816 requires the following scenario and consumer extensions in the existing SCRUM-342 catalog, SCRUM-761 records, SCRUM-486 financial oracle and SCRUM-617 fact checker. Each row remains **UNPROVEN** pending exact-SHA authenticated UI, disposable-backend, persisted-effect and consumer read-back evidence.

| Pilot slice | Candidate operator route | Required consumer and exit evidence |
| --- | --- | --- |
| Owned CASH | `/[orgId]/sales`, sale/deal workspace | Quote, deposit, completion, canonical invoice, customer receipt application, collection queue, deal state, GL/AR and reports; refund/retained-credit or unwind and correction where applicable. |
| Configured FINANCED | `/[orgId]/sales`, `/[orgId]/applications/[applicationId]/deal` | Approved amount/contribution/deposit/forward and settlement, documents, collections, GL and reports; authorized exits and correction, with privileged approved amount withheld from the legal bill of sale. |
| SOURCED settlement | Deal workspace and `/[orgId]/sourcing` | `THROUGH_DEALERSHIP` supplier payable and AP; `DIRECT_TO_SUPPLIER` dealer margin receivable from supplier and no invented payable or owned gross sale; supplier reads and GL/report parity. Pilot enablement of each route still needs SCRUM-810 classification. |
| Commission | `/[orgId]/commissions`, deal and payroll surfaces | Earned, approved, posted and paid states; deal, commission list, payroll position and P&L must agree at the correct lifecycle point. |
| Lead cross-domain witness | `/[orgId]/leads`, `/[orgId]/leads/[leadId]` | Linked customer/deal, assignment, activity/notifications and dashboard/list after navigation and reload, including role and second-org boundaries. |

### Configured FINANCED zero-value customer document risk

At base `6e2408828`, `completeSale` unconditionally calls `ensureReceivableDocument` for the sale's canonical CUSTOMER invoice with `originalAmountMinor: customerBillableMinor` (`convex/utils/saleCompletion.ts:1825-1839`). A financed plan can set the customer car receivable to zero (`:88-120`), and `createReceivableDocument` initializes even that document with `status: "OPEN"` (`convex/subledger.ts:103-140`). The configured-financier path separately opens the full FINANCE_COMPANY receivable in `applications.finalizeDeal` (`convex/applications.ts:5211-5230`). An existing backend harness test asserts both the full 20,000,000-minor finance-company document and the zero-minor CUSTOMER document (`convex/applications.test.ts:1407-1425`); it does not assert the customer's document status or rendered collections behavior.

The `subledger.listReceivables` status-OPEN query reads canonical `receivableDocuments` without an amount filter (`convex/subledger.ts:401-429`), so this zero-value OPEN document is a candidate in that read. `collections.listReceivables` reads a different `receivables` table; do not infer its UI result from the canonical document. For the configured FINANCED journey, inspect each actual collection, aging, deal and bill-of-sale consumer and the lawful exit before classifying the zero document as harmless or erroneous. Its real-preview outcome and owner ruling remain **UNPROVEN** (SCRUM-816; coordinated with SCRUM-813 / PR #552).

| Source consumer | Candidate operator surface | What this checkout actually supports |
| --- | --- | --- |
| `applications.dealCockpit` via `dealWorkspace.financedDealCockpit` | Financed deal route `/[orgId]/applications/[applicationId]/deal` | For a completed linked sale whose route and customer gap are readable, `resolveCustomerInvoicePosition` derives state from the canonical document's outstanding balance, exempts a zero invoice from posting proof, and returns `CLOSED`/zero. The finance-visible `CustomerInvoiceFact` would display that zero balance as settled; the finance-hidden panel only names an OPEN state. An unproven route/gap instead returns UNKNOWN. This is a source projection, not a rendered preview observation. |
| `sales.dealCockpit` | Sale deal route `/[orgId]/sales/[saleId]/deal` | Uses the same customer-invoice position helper, but returns `money: null` for an application-linked sale. Its finance-hidden UI only prints a qualitative marker when the state is OPEN, so a CLOSED zero customer invoice has no amount tile on this sibling route. Route entry and rendered behavior still need preview replay. |
| `sales.getSaleTrail` | Recent Sales on `/[orgId]/sales` and the sales list's trail dialog | Returns the raw canonical CUSTOMER document. The dialog adds a “receivable created” step whenever it exists, but formats `sale.salePrice` beside its document number rather than `receivable.originalAmountMinor`. `sales.list` includes completed application-linked sales, so this is a reachable source-level presentation mismatch for a zero customer invoice; exact rendered EN/AR behavior remains unverified. |
| `sales.getBillOfSaleEconomics` | `/[orgId]/sales/[saleId]/print` | Its FINANCED branch reads the frozen application/quote snapshot and does not use the canonical customer document for printed figures. Do not infer a zero printed sale from that document. |
| `collections.listReceivables` and `collections.summary` | Accounting Collections tab | They query legacy `receivables`, not canonical `receivableDocuments`; the zero canonical row alone cannot appear in that list or its count. Any separate legacy row still needs journey proof. Payment Links filters legacy rows to positive outstanding amounts and is pilot-disabled. |
| `accountingReports.arAging`; `subledger.listReceivables` | No direct dashboard binding found in the measured `app/` and `components/` generated-API references | Aging scans canonical documents but skips zero outstanding rows before adding buckets/rows. The raw subledger OPEN query has no amount filter and can include the zero document. Indirect/API clients and actual pilot exposure remain unclassified. |

No existing scenario is promoted to pilot PASS from this table. The source locator measures 38 dashboard routes and 692 public Convex declarations at this SHA, but it does not classify final enablement, dynamic UI state, writes or consumer parity. SCRUM-810's manifest and SCRUM-813's Option B implementation are open dependencies.

The active SCRUM-761 record `lead-creation-consumers-same-org` now binds a backend harness witness in `convex/dashboardAggregates.test.ts`. It creates a lead through the public mutation, then checks the lead list, workspace customer and assignee, dashboard totals, CREATED activity, assignment and creation notifications, and a second organization's empty reads and refusal of the foreign lead. This proves the listed assertions in the serial `convex-test` harness only. Authenticated rendered EN/AR, reload behavior, role combinations, and exact-SHA preview remain **UNPROVEN**.

### Reverse consumer candidates at this SHA

These are direct generated-API references reachable from a dashboard page's static import closure. They identify screens to replay after the underlying command; the runtime payload and accounting values are still unverified.

| Consumer query | Candidate dashboard route(s) |
| --- | --- |
| `sales.dealCockpit`, `dealWorkspace.financedDealCockpit` | Financed deal and sale deal routes |
| `collections.listReceivables`, `accountingLedger.listJournalEntries`, `accountingReports.incomeStatement` | Accounting route |
| `sourcingPayables.list`, `sourcingPayables.listPipeline` | Sourcing route |
| `sales.listCommissionsPaginated` | Commissions route |
| `payroll.listRuns`, `payroll.listRunItems` | Payroll route |
| `leads.list`, `dashboard.stats` | Lead/dashboard routes |

The same measured dashboard scope has **no direct page-import route** for `supplierReceivables.list` or `supplierReceivables.outstandingSummary`; `supplierReceivables.recordReceipt` is wired to the financed and sale deal routes. The deal cockpit projects a supplier claim (`convex/sales.ts`), and the container has permission-focused UI tests, so the absent direct list binding alone does not establish a missing operator screen. `sourcingPayables.recordPartialPayment` likewise has no direct dashboard binding in this scope. Classify these under final SCRUM-810 pilot enablement and inspect indirect/mobile callers before deciding whether they are required doors or intentional exclusions.

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

## SCRUM-795 item 3 (no salesperson cash receipts)

- Record sales-member-cannot-post-a-deposit is bound to convex/depositRequests.test.ts (failing-first under #364). It claims ONLY deposits.create: that test does not assert deposits.allocateToVehicles, releaseVehicleAllocation, depositRequests.confirm or vehicles.createReservation, so those doors have no record yet (gap).
- It cites SCRUM-760#c22465 (R-PERMISSION); SCRUM-760 c22474 is not in the snapshot, so it is not cited as a ruling id.
- AF-98's template pin (PR #518, convex/utils/permissions.test.ts) is not bound yet; bind it once merged.
- Items 1 (manual journals) and 2 (refund payout) await their PRs.

- Added (AF-98 verified, I re-read both bodies): sales-member-cannot-confirm-a-deposit-request (depositRequests.confirm; refusal + no money rows) and sales-member-cannot-allocate-or-release-a-deposit-hold (the test calls allocateToVehicles, releaseVehicleAllocation and resolveReleasedAllocation x2; the record's single step names allocateToVehicles as the representative and claims only that the hold row is unchanged, NOT the money tables).
- vehicles.createReservation with a deposit stays a GAP: its test (DA-01) uses a custom-permission editor, not the SALES template, so it proves 'lacking confirm:finance_disbursement is refused', not 'SALES is refused'. The SALES half needs PR #518's template pin.
