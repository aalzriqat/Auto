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

**Owner ruling SCRUM-486 c22859 (2026-10-11):** keep the sale-linked zero-value CUSTOMER document as a **PAID, noncollectible internal record**; the FINANCE_COMPANY invoice is the only collectible claim. The measured base `6e2408828` described above creates the zero document OPEN. PR #552 merged its PAID forward fix and harness assertions for the canonical link and absence of an extra CUSTOMER claim at main `e833f0a` (reviewed head `2a0e1d0`). Merge does not establish backend deployment or M486C5 real-backend proof. Retained OPEN zero documents need a target-specific audit before backend deployment. `subledger.listReceivables` status-OPEN reads canonical `receivableDocuments` without an amount filter (`convex/subledger.ts:401-429`), making old OPEN rows candidates until addressed. `collections.listReceivables` reads a different `receivables` table; do not infer its UI result from the canonical document. The mapped numeric reads below do not turn a PAID/zero customer record into a positive customer claim. Sale Trail still labels that internal row “Customer invoice created” even though it now states zero and no amount due; whether that label sufficiently distinguishes an internal record from an issued customer invoice needs owner/rendered review. Exact-main backend and authenticated preview consumer outcomes remain **UNPROVEN** here.

SCRUM-486 c22897-22898 records a real disposable-backend failure on PR #559's candidate merge: 26/27 accounting cases passed, but M486C5 failed because the posted finance-company AR journal line lacked `financeCompanyId`. This is not the still-undispatched main-only release rehearsal. Draft PR #560 at `1b3deda` adds the missing `journalLines` persistence field and failing-first certification assertions for both the original finance-company AR line and its cancellation reversal; trusted PR rehearsal 38160937520 passed 27/27 real-backend cases including M486C5 on candidate merge `e6f41e2`, with preview deletion and exact-head CI green. Independent reviews, normal merge and a new exact-main release rehearsal remain pending. Current main `e833f0a` retains the defect, so the financed journal/consumer row stays **UNPROVEN** for pilot release. PR #551 does not edit that accounting code.

| Source consumer | Candidate operator surface | What this checkout actually supports |
| --- | --- | --- |
| `applications.dealCockpit` via `dealWorkspace.financedDealCockpit` | Financed deal route `/[orgId]/applications/[applicationId]/deal` | For a completed linked sale whose route and customer gap are readable, `resolveCustomerInvoicePosition` derives state from the canonical document's outstanding balance, exempts a zero invoice from posting proof, and returns `CLOSED`/zero. The finance-visible `CustomerInvoiceFact` would display that zero balance as settled; the finance-hidden panel only names an OPEN state. An unproven route/gap instead returns UNKNOWN. This is a source projection, not a rendered preview observation. |
| `sales.dealCockpit` | Sale deal route `/[orgId]/sales/[saleId]/deal` | Uses the same customer-invoice position helper, but returns `money: null` for an application-linked sale. Its finance-hidden UI only prints a qualitative marker when the state is OPEN, so a CLOSED zero customer invoice has no amount tile on this sibling route. Route entry and rendered behavior still need preview replay. |
| `sales.getSaleTrail` | Recent Sales on `/[orgId]/sales` and the sales list's trail dialog | Returns the raw canonical CUSTOMER document. PR #551 now formats `receivable.originalAmountMinor` in its own currency instead of `sale.salePrice` and labels a zero document “No amount due from customer” in EN/AR; a focused rendered component test covers both locales. The customer record must never be presented as a collectible 12,500-JOD debt merely because that is the sale price. Backend status and exact-SHA browser/preview parity remain unverified. |
| `sales.getBillOfSaleEconomics` | `/[orgId]/sales/[saleId]/print` | Its FINANCED branch reads the frozen application/quote snapshot and does not use the canonical customer document for printed figures. Do not infer a zero printed sale from that document. |
| `collections.listReceivables` and `collections.summary` | Accounting Collections tab | They query legacy `receivables`, not canonical `receivableDocuments`; the zero canonical row alone cannot appear in that list or its count. Any separate legacy row still needs journey proof. Payment Links filters legacy rows to positive outstanding amounts and is pilot-disabled. |
| `accountingReports.arAging`; `subledger.listReceivables` | No direct dashboard binding found in the measured `app/` and `components/` generated-API references | Aging scans canonical documents but skips zero outstanding rows before adding buckets/rows. The raw subledger OPEN query can include the old OPEN zero document; the owner-ruled PAID status should remove it from that status-filtered read without deleting its canonical ID. Indirect/API clients, existing retained rows and actual pilot exposure remain unclassified. |

### Customer receipt unwind: cleared cheque returned by bank (SCRUM-723)

The current Accounting Collections tab mounts `ReturnChequeDialog` for a manager; a CLEARED row calls `collections.returnClearedCheque` (`components/accounting/CollectionsTab.tsx:1207-1235`). At base `6e2408828`, that mutation reads a persisted receipt movement and `planReceiptRevocation` enumerates retained-credit `receiptApplications` from its own table (`convex/collections.ts:2298-2535`, `convex/accounting/receiptMovement.ts:487-570`). Those are not proof that a new SCRUM-813 invoice application is reversed. A coordinated finding from internal draft PR #554 reports that returning a cleared cheque leaves its new ACTIVE invoice application in place; the PR's implementation and failing-first reproduction are outside this checkout, so this map treats it as a **reported integration risk**, not a reproduced local result.

For every enabled CASH or FINANCED customer-receipt route that accepts a cleared cheque, replay: apply receipt to the sale's own invoice → read canonical invoice balance, deal cockpit, collections and GL → return that cheque through Accounting Collections → prove the exact application/allocation and receipt posting reversed, invoice debt reopened once, deal/collections/AR/GL consumers converged, and a repeated return refused or replayed without a second effect. Include the paid→open case, partial surviving payments, same-org role authority, second-org refusal and EN/AR rendered states. This exit is **UNPROVEN** until SCRUM-813/SCRUM-723 owner treatment and exact-head preview evidence; do not promote any receipt journey to pilot PASS.

No existing scenario is promoted to pilot PASS from this table. The source locator measures 38 dashboard routes and 692 public Convex declarations at this SHA, but it does not classify final enablement, dynamic UI state, writes or consumer parity. SCRUM-810's manifest and SCRUM-813's Option B implementation are open dependencies.

The protected-main Contract skew run [38141260549](https://github.com/aalzriqat/Auto/actions/runs/38141260549) at `e833f0a` failed its `detect` job with `COVERAGE INCOMPLETE` (exit 9): 991 client call sites found, 990 resolved, one unresolved, plus 1,479 differences from the unproven-path baseline. SCRUM-711 tracks the control-health failure. This is not a confirmed production skew or a frontend/backend parity PASS, and generic successful CI jobs cannot fill that evidence gap. The 1,479 differences need review before any baseline change; they are not attributed to PR #552 by this run alone.

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
