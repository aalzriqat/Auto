# SCRUM-869 supplier account workspace: design packet (pilot gate G10)

Status: design only, for review. Author: Sonnet 5.5 as design author. This is not a review seat and proves nothing about correctness.
Base: `origin/main` 315bcd831. Branch: `claude/scrum869-design`.
Depends on: SCRUM-868 (supplier identity, stage 1). See `docs/architecture/scrum868-supplier-identity-design.md` for N1-N13, slices P1-P7 and OQ-1..OQ-12.
Evidence rule: every file:line below was read on this base. Claims about "no other writer" or "no other caller" are grep enumerations, and the grep is named where it matters. Anything not run or not read is listed in section 8.

## 0. Summary

The pilot needs a place where a finance user opens one supplier and sees what the dealership owes them (A/P) and what they owe the dealership (A/R) as two separate statements, with aging, and settles open items. Today there is no such screen. The pieces exist as separate money tables and separate doors, keyed by supplier name text, shown on the sourcing page and the deal cockpit.

Recommended design: live, cursor-paginated queries over the existing subledger tables through new supplier-keyed indexes (candidate A), with an explicit completeness flag on every figure and a per-currency reconciliation of the subledger totals to the GL control accounts 2400 and 1240 shown beside them. Writes reuse the existing certified doors; the workspace adds no second ledger, no stored balance and no new posting rule in the first slices. A maintained aggregate (candidate B) is the named fallback if a measured bound is hit.

The workspace may only call doors that are enabled and certified for the pilot. Where a door is missing or uncertified (payment reversal, receipt reversal, manual offsets, manual journals), the workspace shows a refusal and the server refuses too.

## 1. Invariants

Numbering is local to this packet (W-n) so reviewers can cite them. Each one maps to the AutoFlow accounting invariants ACC-1..ACC-10 and tenancy rules TEN-1..3 where it restates one.

| Id | Invariant | Why it can break here |
| --- | --- | --- |
| W1 | A/P (we owe the supplier) and A/R (the supplier owes us) are separate obligations. No query, mutation, screen or report subtracts one from the other to produce a balance, a status or a payable amount. An informational net may be shown only when the owner allows it (OQ-4), only per currency, and always labelled as not a balance. | The supplier screen puts both on one page, so a "net due" figure is the natural thing to add. |
| W2 | Per organization, per currency, per control account: the sum of the open subledger amounts shown for all suppliers (including the unlinked bucket) equals the GL balance of 2400 (A/P) and of 1240 (A/R). Any difference is displayed as a reconciliation difference with its cause, never hidden or absorbed. If the reconciliation cannot be computed, the screen says UNAVAILABLE with the reason. | Posting is event-sourced and may sit in the outbox (`postDomainEvent`), so the subledger can lead the GL. There is no A/R reconciliation today (section 3). |
| W3 | Each supplier total on the workspace equals the sum of the source lines the user can open from it. The same line shows the same figure on the sourcing page, the deal cockpit and the workspace. | Three screens read the same rows through different code (section 2). |
| W4 | One allocation per source line per settlement: a single payment or receipt reaches a line once, and its amount is attributed to exact lines. The sum of allocations equals the cash amount. | The existing doors are per line. A multi-line payment must not become a free-form amount. |
| W5 | No over-application: cumulative allocation to a line never exceeds the amount due, compared in integer minor units of that line's currency. No line is paid twice. | Payables hold major-unit floats (`amountPaid` accumulates), recoveries hold minor units (section 3). |
| W6 | No settlement on a CANCELLED line. PAID, DISPUTED and CANCELLED lines refuse settlement. A line cancelled by a sale cancellation cannot receive money afterwards. | Existing refusals in `assertSupplierPayableSettlementStatus`; the workspace must not route around them. |
| W7 | No cross-currency blending. Every figure carries its currency; totals, aging and the reconciliation are per currency. A supplier with lines in two currencies shows two sets of figures and no combined number. | The reconciliation already works per currency; new queries must not collapse it. |
| W8 | Tenancy comes from `ctx.auth` through `requireTenantAuth` and `requireOwnedRow` (TEN-1). No argument carries `orgId` as a trust source. A supplier id from another organization is "not found". | New queries take a `supplierId`. |
| W9 | Every settlement mutation is idempotent under a caller key through `runWithIdempotency`. A repeat returns the first result, a changed payload under the same key is refused, and a refusal writes nothing and claims no key. | `setDisputed` on both payable and receivable has no idempotency today. |
| W10 | Every state-changing finance action writes an immutable `financialAuditLog` entry in the same transaction: actor, supplier, line ids, amounts, currency, account, idempotency key. Entries are never patched or deleted. | The payable payment and dispute doors write no audit entry today. |
| W11 | The workspace calls only enabled, certified doors. A pilot-disabled or uncertified operation is refused on the server before any write and before any idempotency claim, with a truthful message. Hiding a button is not a refusal. | Pilot containment (RT11 doors, customer credit payout, sale invoice receipt, manual journals). |
| W12 | SOURCED vehicles are consignment. No code in this feature derives a supplier amount as sale price minus cost. Amounts come from the stored entitlement, commission or recovery figure only. | The ownership-model labelling in feature 4 touches exactly these rows. |
| W13 | The workspace stores no balance, status or aging figure that the subledger can disagree with. Derived values come from the rows (as `deriveSettlementStatus` does) or from a maintained read model that a reconciliation check compares to the rows (candidate B). | A second balance is a second ledger. |
| W14 | Every list on the workspace is bounded and paginated, and says whether it is complete. A truncated list never presents a partial sum as a total. | Several existing lists truncate silently (section 3). |
| W15 | Alerts are in-app only, per organization, and a failure for one tenant does not stop the batch (TEN-3). | `dispatch` can also send email, WhatsApp and push. |
| W16 | No manual journal and no manual offset is possible from the workspace unless the owner has signed off written rules (OQ-3). Manual journals stay pilot-disabled (SCRUM-810). | Feature 6. |

## 2. Impact map

Method: `git grep` and the Grep tool over `convex/`, `app/`, `components/`, `lib/`, `apps/mobile/`, `regression/`, `docs/`, on this base. Exclusions: `*.test.ts(x)`. The list is the result of those greps, not a proof that nothing else reads these tables (dynamic table names and `ctx.db.query(tableVar)` would not match).

### 2.1 Tables

| Table | Role | Evidence |
| --- | --- | --- |
| `vehicleSupplierPayables` | A/P: what we owe the supplier (major units, float `amountPaid`) | `convex/schema.ts:1802-1809`, shape in `supplierPayableCommon` 90-176 (a stale "no supplier master" comment sits at 92-103) |
| `vehicleSupplierReceivables` | A/R: margin (commission) the supplier owes us (major units) | `convex/schema.ts:1700-1754` |
| `supplierCostRecoveries` | A/R: costs the supplier owes us, e.g. supplier-borne prep (minor units) | `convex/schema.ts:1775-1784`, common 43-63 |
| `supplierCostRecoveryReceipts` | Receipts against a recovery (max 100 per recovery) | `convex/schema.ts:1796-1800`, common 65-88; cap `MAX_RECEIPTS_PER_RECOVERY` in `convex/supplierCostRecoveries.ts` |
| `vehicleOwnershipConversions` | Ownership model change (SOURCED to OWNED) | `convex/schema.ts:1834-1855` |
| `suppliers`, `supplierAliases`, `supplierRegistryState` | Stage-1 identity | `convex/schema.ts:7954-8018` |
| `journalLines` | GL lines. No supplier dimension | `convex/schema.ts:909-946` |
| `financialAuditLog` | Immutable finance audit | `convex/schema.ts:1088-1130` (action types include ALLOCATE_PAYMENT, REVERSE_ALLOCATION) |
| `canonicalPayments`, `paymentAllocations` | Customer-side payment and allocation only | `convex/schema.ts:1011-1084` |
| `accountBalanceSnapshots` (sharded) | Closed-period balances | `convex/accounting/accountSnapshots.ts` (`getCumulativeBalancesAsOf` at 95) |
| `notifications` | In-app alerts | `convex/schema.ts:2658-2686` |
| `expenses` | Vendor and cost bearer | `convex/expenses.ts` (19, 21, 162, 203, 255, 262, 423, 435, 482-552, 594-606, 673-674, 733-760) |

On this base the supplier id is not yet on any of the money tables. That is SCRUM-868 slices P2 and P3.

### 2.2 Mutations and queries that touch supplier money

| Function | Where | What matters for this design |
| --- | --- | --- |
| `sourcingPayables.list` | `convex/sourcingPayables.ts:90-152` | Unbounded `.collect()`, no completeness flag |
| `sourcingPayables.listPipeline` | 173-256 | Pipeline view of consigned vehicles |
| `sourcingPayables.get` | 258-286 | One payable |
| `sourcingPayables.markPaid` | 288-413 | MANAGE_FINANCE, idempotent, minor-unit over-application guard, bank guard `assertSupplierPaymentBank`, posts through `hookSupplierPaymentSettled`. No `financialAuditLog` entry |
| `sourcingPayables.recordPartialPayment` | 432-568 | Same guards as `markPaid`. No audit entry |
| `sourcingPayables.setDisputed` | 577-627 | No idempotency, no audit entry |
| `supplierReceivables.list` | `convex/supplierReceivables.ts:108-148` | `take(500)`, no completeness flag |
| `supplierReceivables.outstandingSummary` | 175-257 | Keyed by supplier name text in a `Map` (196, 206-209, 237-240), bounded at 1000 with a `complete` flag, no UI consumer found |
| `supplierReceivables.recordReceipt` | 268-437 | Idempotent, audited (ALLOCATE_PAYMENT) |
| `supplierReceivables.setDisputed` | 446-490 | No audit entry |
| `assertNoSupplierReceiptsForSale`, `cancelSupplierReceivablesForSale` | 504, 529 | Sale cancellation guards |
| `supplierCostRecoveries.openSupplierCostRecovery` | `convex/supplierCostRecoveries.ts:65-95` | Party taken from `vehicle.sourcedFromName` |
| `supplierCostRecoveries.list` | 170-242 | `take(201)` with `complete` flag |
| `supplierCostRecoveries.recordReceipt` | 319-476 | CASH or BANK_TRANSFER, audited |
| `supplierCostRecoveries.reverseReceipt` | 484-600 | The only reversal door in the supplier family. Not RT11-disabled. Pilot certification not proven |
| `computeSupplierPayablesReconciliation`, `supplierPayablesReconciliation` | `convex/accountingReports.ts:960-1183` | A/P to GL 2400, per currency, org-wide, read limit 4000, UNAVAILABLE reasons. Consumed by `convex/accountingPeriods.ts:390,605` |
| `suppliers.*` | `convex/suppliers.ts` (list 257, search 276, get 315, candidatesFor 331, create 359, update 618, deactivate 642, reactivate 675, addAlias 706, retireAlias 745, initialiseRegistry 772, backfillRegistry 793; `requireSupplierReadAccess` 142) | No UI uses `api.suppliers` on this base |

### 2.3 Creation and cancellation of obligations

| Event | Where |
| --- | --- |
| Sale completion creates receivable and payable. "Unknown supplier" default name; payable has no due date | `convex/utils/saleCompletion.ts:2196-2260` (defaults at 2232, 2246) |
| ON_ACCOUNT vehicle creation makes a payable | `convex/vehicles.ts:156-229` (payable at 217-227) |
| Supplier payments are not projected into the cashbook | `convex/vehicles.ts:2254-2261` |
| Sale cancellation cancels payables and receivables; refused if any payment exists | `convex/utils/saleCancellation.ts:310-379` |
| Status derivation. `paymentDueDate` and `paymentDueTrigger` exist on the schema but no non-test code writes them | `convex/utils/supplierSettlement.ts` (`deriveSettlementStatus`, `settlementView`, `isDue`) |

### 2.4 GL posting

| Rule or hook | Where |
| --- | --- |
| `ruleSupplierPaymentSettled` | `convex/accounting/postingRules.ts:1747-1782` |
| `ruleSupplierReceivableCollected` | 1807-1825 |
| `ruleSupplierCostRecoveryReceived` | 1848-1867 |
| Hooks | `convex/accounting/workflowHooks.ts:1080-1115, 1305-1355` |
| Control accounts | 2400 `ACCOUNTS_PAYABLE_SUPPLIERS`, 1240 `RECEIVABLE_FROM_SUPPLIERS` |

### 2.5 Screens and consumers

| Consumer | Where |
| --- | --- |
| Sourcing page (queries 94-117, `daysOutstanding` 393, `SupplierCostRecoveriesSection` 443, `SupplierPaymentDialog` 445) | `app/(dashboard)/[orgId]/sourcing/client.tsx` |
| Navigation entry "Sourcing", `view:finance` | `lib/navigation.ts:61` |
| Sourcing components | `components/sourcing/*` (recovery receipt call at `SupplierCostRecoveriesSection.tsx:67,125`) |
| Deal cockpit supplier receipt and settlement | `components/applications/cockpit/DealCockpit.tsx` (863, 4015, 4183, 4337, 5436-5721, 7515) and `SupplierSettlementDialog.tsx` |
| Mobile | `apps/mobile/src/features/workspace/modules/sourcing.tsx` |
| Period close | `convex/accountingPeriods.ts:390,605` read the A/P reconciliation |
| Crons | `convex/crons.ts` (collection-reminders at 40-46, calling `processDailyCollectionReminders`, `convex/collections.ts:4278`) |
| Notifications | `convex/utils/notifications.ts` (`dispatch` 37-120, `notifyByPermission` 232) |
| Regression library | `regression/README.md`, `regression/rulings.json`, `regression/PILOT-PATH.md`, `regression/scenarios/money/*.scenario.json`; oracle `docs/architecture/scrum486-certification-oracle.md` |

### 2.6 Pilot containment on this base

| Switch | Where | Effect on this feature |
| --- | --- | --- |
| `SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED` | `convex/utils/rt11DoorContainment.ts:17,32` | Amending supplier disbursement advice is refused. The workspace must not offer it |
| `CUSTOMER_CREDIT_PAYOUT_PILOT_DISABLED`, `SALE_INVOICE_RECEIPT_DOORS_PILOT_DISABLED` | `convex/utils/customerCreditPayoutContainment.ts` | Customer side. Not called by the workspace |
| `MANUAL_JOURNALS_PILOT_DISABLED` | `convex/utils/pilotSwitches.ts` | Offsets by manual journal stay impossible |
| `PAYMENT_LINKS_PILOT_DISABLED` | `lib/pilotCapabilities.ts:2` | Not relevant |

A grep of `rt11DoorContainment.ts`, `pilotSwitches.ts` and `customerCreditPayoutContainment.ts` for the supplier payable, receivable and recovery functions returned nothing. So on this base the payable payment, margin receipt and recovery receipt doors have no pilot switch. They are enabled in code. Whether they are in the pilot manifest and certified is a SCRUM-810 and SCRUM-486 question that this repository does not answer (OQ-2). Until it is answered, this design treats them as "enabled, certification unproven" and marks the workspace settlement slices accordingly.

## 3. What exists, what is missing

Legend: EXISTS means code is present on this base. It does not mean certified.

| # | Feature | Exists | Missing |
| --- | --- | --- | --- |
| 1 | Supplier screen, detail, statement, separate A/R and A/P, optional informational net | `suppliers` queries exist (`convex/suppliers.ts`) but no screen uses them. Sourcing page lists payables and recoveries per vehicle. `outstandingSummary` totals A/R by supplier name (`supplierReceivables.ts:175-257`), no UI | No supplier list or detail screen. No statement (a dated list of charges and settlements per supplier). Supplier id on money rows (SCRUM-868 P2/P3). Name text is the only key today, so two spellings are two suppliers |
| 2 | Aging and status summaries by supplier, obligation, currency, as-of date | `deriveSettlementStatus` gives NOT_YET_DUE, DUE_ON_SALE, PARTIALLY_PAID, PAID, DISPUTED, CANCELLED (`supplierSettlement.ts`). `daysOutstanding` on the sourcing page (`client.tsx:393`). A/P to GL reconciliation (`accountingReports.ts:960-1183`) | No overdue, because payables and receivables carry no written due date (`paymentDueDate` is never written). No aging buckets. No as-of date. No opening-allocation view. No A/R (1240) reconciliation. Unbounded or silently truncated lists (`sourcingPayables.list`, `supplierReceivables.list`) |
| 3 | Guided settlement: partial and full, exact source line, physical account, reversal or refusal, permissions, audit | Partial and full payable payment (`sourcingPayables.ts:288-568`), margin receipt (`supplierReceivables.ts:268-437`), recovery receipt and its reversal (`supplierCostRecoveries.ts:319-600`). MANAGE_FINANCE on all. Bank guard on payments. Over-application guard | Payable payments: no audit entry, no reversal door. Margin receipts: no reversal door. Dispute toggles: no idempotency, no audit. Multi-line allocation of one payment. Account choice is per dialog, not a workspace flow. Supplier payments are not in the cashbook (`vehicles.ts:2254-2261`), so a cash settlement does not reach the cashier day. Truthful refusal copy where no certified route exists |
| 4 | Ownership model and payee versus cost bearer | `expenses` carries vendor and cost bearer (`expenses.ts` lines listed in 2.1). Ownership models are present on vehicles. `vehicleOwnershipConversions` (`schema.ts:1834-1855`). Recoveries open from the vehicle's `sourcedFromName` (`supplierCostRecoveries.ts:65-95`) | One rule that maps (ownership model, who bore the cost, who is the payee) to the obligation: SOURCED DIRECT_TO_SUPPLIER gives commission due FROM the supplier (A/R); SOURCED THROUGH_DEALERSHIP gives supplier entitlement (A/P); OWNED ON_ACCOUNT gives A/P; supplier-borne prep gives an A/R recovery. Today the creation points are spread across `saleCompletion.ts`, `vehicles.ts` and `supplierCostRecoveries.ts` with no single classifier and no screen showing the class |
| 5 | In-app due and overdue alerts, no WhatsApp or SMS | `dispatch` writes an in-app notification (`utils/notifications.ts:37-120`). Daily org-paginated cron precedent: `collection-reminders` (`crons.ts:40-46`) | A due date to alert on. An in-app-only dispatch variant (the existing `dispatch` may also send email, WhatsApp and push). A supplier due cron. De-duplication so one line alerts once per stage |
| 6 | Audited manual offsets, only with signed-off rules | `MANUAL_JOURNALS_PILOT_DISABLED` (SCRUM-810). No offset door | Signed-off owner and legal rules. Until then the design builds nothing and the UI must not offer netting |

Established practice used (stated from general accounting knowledge, not fetched in this session, see section 8): an AR or AP subledger reconciles to its GL control account; aging buckets are by days past due date; a payment is applied to specific open items; netting between a customer and a vendor is a separate, authorised, documented act.

## 4. Two read-model candidates

Both candidates give the same screens. They differ in where the numbers come from.

### 4.1 Candidate A: live, paginated subledger queries (recommended for the pilot)

How it works:
- New indexes on each of the three obligation tables: `by_org_supplier_currency_status` (order: `orgId`, `supplierId`, `currency`, `status`, then creation time for stable paging). Recoveries use the same pattern. These indexes wait for SCRUM-868 P2/P3 because `supplierId` must exist first.
- A statement is the supplier's lines read through those indexes with cursor pagination (`paginate`), one obligation kind and one currency per page request.
- Summary figures (totals and aging) are computed from the same pages, up to a fixed scan bound per request, returned with `complete: true|false` and the count scanned. If the bound is reached, the screen shows "partial: first N lines" and no total.
- The org-wide reconciliation (W2) is a separate query with its own bound and UNAVAILABLE reasons, following `computeSupplierPayablesReconciliation`.

Convex limits that matter (docs.convex.dev/production/state/limits, fetched 2026-10-29): 32,000 documents scanned and 16 MiB read per function, 4,096 index ranges, 16,000 documents written, 1 second of user-code time, 16 MiB return, 32 indexes per table. The comment in this repository that cites "16,384" is stale; do not copy it.

| For | Against |
| --- | --- |
| No new stored figure, so W13 holds by construction and nothing can drift from the rows | A supplier with thousands of open lines cannot show an exact total in one request. It degrades to "partial" |
| Reactive in Convex: the screen updates when a payment lands | Each page re-reads rows. Recovery receipts are a second table (up to 100 per recovery), so detail views read more |
| No backfill, no new write path, no new OCC hotspot on payments | As-of dates before today need dated payment events. Payables and margin receivables keep a cumulative `amountPaid`. Whether every row keeps a dated payment history was not confirmed (section 8), so past as-of aging is UNAVAILABLE for those until S3 confirms it |
| Smallest slice that can ship, easy to review | Aging recomputed on every read |

Pilot scale (one dealer, Bloom Cars) is well inside the bounds if the number of open lines per supplier stays in the hundreds. That is an assumption to measure on the preview in S3, not a fact.

### 4.2 Candidate B: maintained aggregate (fallback)

How it works:
- A per-(org, supplier, currency, obligation, bucket) balance maintained on every write that changes a line (create, settle, dispute, cancel), either with the `@convex-dev/aggregate` component (already mounted several times in `convex/convex.config.ts:22-40`; README read at github.com/get-convex/aggregate) or a sharded balance table like `accountBalanceSnapshots`.
- Totals become O(log n) reads. Aging buckets need a time-keyed structure, and a bucket changes as the calendar moves, so a daily job must re-bucket or the query must combine a "due date" key with a range sum.
- A backfill and a reconciliation to the rows are mandatory. The bank balance aggregates (`bankBalance*` tables, backfilled in the deploy workflow as `bankBalanceBackfill:runPage`) are the in-repo precedent, including the "unavailable until rebuilt" behaviour.

| For | Against |
| --- | --- |
| Exact totals at any size in one read | A second copy of the balance (W13). Every write path that changes a line must also update it, and there are at least six (create, three receipts or payments, dispute, cancel) plus any future one |
| Fast summary screens | Backfill, deploy-time rebuild, and a drift reconciliation to build and certify. More surface for the SCRUM-486 matrix |
| Natural place for aging buckets | The aggregate adds writes to hot payment paths, so more OCC retries when two users settle the same supplier |

### 4.3 Recommendation

Candidate A for the pilot, because it adds no second balance, needs no backfill, and every figure can be checked against rows and against the GL on the same screen. Candidate B is kept as the named fallback if S3 measures that a realistic supplier exceeds a scan bound or if aging recomputation is too slow. The slices are written so S4 to S9 do not depend on which candidate S3 picks: screens call `supplierWorkspace.*` queries whose result shape (figure, currency, complete flag, reconciliation) is the same either way.

## 5. Slices

Each slice is independently reviewable and mergeable, ships behind the existing finance permissions, and does not enable a deferred financial operation. "Failing-first" means the listed backend test is committed red before the code and shown red at the parent commit. Money and permission slices go to the two review seats (Codex and Opus); UI-only slices follow the UI verification rule (desktop and mobile, English and Arabic, RTL, loading, empty, error).

Dependency note: S1 and S2 do not need the supplier id and can start now. S3 onward need SCRUM-868 P2 and P3 merged. S8 needs OQ-1 and OQ-7. S9 is not built unless OQ-3 is answered.

### S1: audit and idempotency gaps on existing doors

Scope: add a `financialAuditLog` entry to `sourcingPayables.markPaid`, `recordPartialPayment`, `setDisputed` and to `supplierReceivables.setDisputed`; add idempotency to both `setDisputed` doors; add completeness flags to `sourcingPayables.list` and `supplierReceivables.list` (return `complete`, no silent truncation). No behaviour change to amounts or postings.
Failing-first tests (backend):
- A partial payment writes exactly one audit entry with actor, line, amount, currency, account, key; a replay with the same key writes none.
- `setDisputed` replay with the same key is a no-op; a changed payload under the same key is refused.
- A list over the bound returns `complete: false`.
SCRUM-486 rows: payable partial payment, payable full payment, dispute toggle (each with its audit assertion).
SCRUM-761 scenarios: W-S1-a "partial payment leaves an audit entry"; W-S1-b "dispute replay changes nothing".
UI: none. Real-backend proof: run in the SCRUM-762 rehearsal as public API cases.

### S2: A/R 1240 reconciliation and per-currency reconciliation report

Scope: a reconciliation for A/R matching the A/P one: margin receivables plus cost recoveries against GL 1240, per currency, with UNAVAILABLE reasons and an explicit "unlinked" row. Reuse the structure of `computeSupplierPayablesReconciliation`. Extend the period-close consumer only if the owner wants it as a close gate (not decided here).
Open check inside this slice: trace which account `ruleSupplierCostRecoveryReceived` (`postingRules.ts:1848-1867`) debits and credits. This packet did not trace it. If recoveries do not use 1240, the reconciliation must say which control account they belong to and the statement must not add them to the 1240 total.
Failing-first tests: reconciliation difference is detected when a receipt is posted to the GL but not the subledger, and the reverse; a currency with rows and no GL balance is a difference, not zero; the outbox-pending case reports pending, not a difference.
SCRUM-486 rows: A/R margin and recovery reconciliation, both directions.
SCRUM-761 scenarios: W-S2-a "A/R subledger equals 1240", W-S2-b "queued posting shows as pending".

### S3: supplier-keyed read model (candidate A) and obligation classifier

Depends on: SCRUM-868 P2, P3.
Scope: the indexes in 4.1; queries `supplierWorkspace.list`, `.statement` (per obligation kind and currency, cursor paged), `.aging` (buckets by days past due, status counts, per currency, with `asOf`); an "Unlinked" bucket for rows with no supplier id; a server-side `classifyObligation` (feature 4) used by the statement; per-figure `complete` flag; the link to the S2 and existing A/P reconciliation. `asOf` other than today returns UNAVAILABLE for any obligation kind without dated payment history (to be confirmed here). Rows with no due date go to a "No due date" bucket and are never counted as overdue.
Measure on the preview: lines per supplier, documents scanned, time, and decide candidate A or B in the slice's PR description with the numbers.
Failing-first tests: per-supplier totals equal row sums; a supplier with two currencies returns two figures and no blend; another organization's supplier id returns not found; DISPUTED lines appear in their own bucket and in the total, never dropped; CANCELLED excluded from open totals and listed in the statement; no-due-date lines are not overdue.
SCRUM-486 rows: statement total equals subledger sum; aging buckets (hand-computed, section 6); currency separation.
SCRUM-761 scenarios: SC-869-2 (aging) and the totals scenario.
Real-backend proof: authenticated preview query returns the same totals as the sourcing page for the same supplier.

### S4: workspace screens, read only

Scope: supplier list, supplier detail with two separate statements (A/P and A/R) and the aging panel, the reconciliation panel, the unlinked bucket, links to source lines (vehicle, deal). Navigation entry under finance. No net balance and no netting control anywhere. If OQ-4 allows an informational net, it is a labelled, per-currency line. Mobile and Arabic RTL. Strings go in the project's existing translation files (location not traced in this packet).
UI states to prove: loading, empty supplier, error, partial ("first N lines"), reconciliation UNAVAILABLE, two currencies, disputed and cancelled lines, long Arabic names, phone and desktop, roles without finance permission (route hidden and query refuses).
Failing-first tests: a user without `view:finance` gets a permission error from every `supplierWorkspace.*` query (permission matrix row).
SCRUM-761: screen replays for each state above (screen-only scenarios become browser replays).

### S5: single-line settlement from the workspace

Scope: from a statement line, open the existing guided dialogs for the line's kind: payable partial or full (`recordPartialPayment`, `markPaid`), margin receipt (`supplierReceivables.recordReceipt`), recovery receipt (`supplierCostRecoveries.recordReceipt`). The physical cash or bank account is chosen per settlement and validated by the existing bank guard. The workspace passes a server-generated idempotency key per dialog open. A server-side allow-list (`supplierWorkspace` door manifest) names exactly the doors it may call; a test fails if the workspace code calls any other money mutation. Corrections: show "Refused: no certified reversal route" for payable payments and margin receipts. Recovery receipt reversal (`reverseReceipt`) is exposed only if OQ-2 says it is certified for the pilot; otherwise it is refused with the same truthful message (and the sourcing page entry is a separate decision, noted in OQ-2).
Failing-first tests: over-application refused with nothing written; settlement of PAID, DISPUTED, CANCELLED refused; repeated key returns the first result; a payment without finance permission refused before any write; account of the wrong currency or inactive account refused; the allow-list test.
SCRUM-486 rows: partial then full payable payment; partial margin receipt; recovery receipt; each with the audit entry and GL posting asserted.
SCRUM-761 scenarios: SC-869-3 (collect receivable partial and full), SC-869-4 (settle payable partial and full), SC-869-5 (refuse where no route).
Real-backend proof: SCRUM-762 public API cases for each door, then an authenticated preview journey: open supplier, pay part, see statement, aging and reconciliation change by exactly the amount.

### S6: multi-line allocation of one payment or receipt

Scope: one cash amount allocated to several exact lines of one supplier, one direction, one currency. A new append-only `supplierSettlementGroups` header (org, supplier, direction, currency, total, account, key, actor, line allocations) written in the same mutation as the per-line door logic, so each line still goes through the same guards and posting. All-or-nothing: one line refused means nothing is written. A fixed maximum number of lines per group (set and justified in the slice from the write-count and time limits). Default allocation suggestion is oldest first, but the user confirms exact amounts (OQ-9).
Failing-first tests: sum of allocations must equal the cash amount; no line over-applied; one invalid line rolls back all; replay returns the first group; two concurrent groups on the same line cannot both succeed (note that convex-test serialises, so OCC is proved only on the real backend).
SCRUM-486 rows: three-line payment hand-computed in section 6; partial across lines.
SCRUM-761 scenarios: SC-869-3 and SC-869-4 multi-line variants.
This slice adds a table, so it needs the invariant closure packet before code.

### S7: expense-originated obligations (feature 4, expense side)

Depends on: SCRUM-868 expense slice (vendor and cost-bearer supplier ids on expenses).
Scope: show on the statement the expense that created a supplier recovery or entitlement, with vendor/payee versus cost bearer labelled, via `classifyObligation`. No new obligation is created from an expense unless an existing certified door already does so; otherwise the line shows "not an obligation" and links to the expense.
Failing-first tests: for each of the four ownership cases in the issue, the classifier returns the stated side (A/R or A/P) and the statement places the line there; SOURCED never uses sale price minus cost.
SCRUM-761 scenarios: SC-869-6 (ownership cases).

### S8: in-app due and overdue alerts

Blocked on OQ-1 (what "due" means per obligation) and OQ-7 (audience and lead time).
Scope: an in-app-only notification path (a new function that writes `notifications` and never schedules email, WhatsApp, SMS or push, plus a test that fails if it reaches those), a daily org-paginated cron modelled on `collection-reminders`, one try/catch per organization so one failing tenant does not halt the batch (TEN-3), de-duplication key per (line, stage), recipients by finance permission through `notifyByPermission`.
Failing-first tests: a line due tomorrow alerts once and not again on the next run; an org that throws does not stop the others; no outbound channel is scheduled; a line without a due date never alerts as overdue.
SCRUM-761 scenario: alerting scenario in the library (backend replay).

### S9: manual offsets (not built unless the owner rules)

Blocked on OQ-3. Until then the deliverable is negative: no offset mutation exists, the UI offers no netting, and a regression scenario asserts there is no combined A/P and A/R settlement door and that manual journals remain refused. If the owner supplies signed-off rules, a separate packet designs the offset (entries, approval, audit, reversal) before any code.

### S10: release evidence and manifest

Scope: add the workspace doors and queries to the pilot manifest (SCRUM-810), register every scenario above in `regression/scenarios/` with steps, inputs, expected result and the ruling id (ruling ids to be added to `regression/rulings.json` when the owner rules on OQ-1..OQ-9), lowest level per scenario, SCRUM-762 public API cases for the money rows, one authenticated real-preview journey, exact-SHA trusted evidence (SCRUM-812). Anything not run is reported UNPROVEN or BLOCKED.

### Slice order

S1, S2 (now, parallel) then S3, S4, S5, S6, S7, S8, S10. S9 only on ruling. S3 and S4 must merge before S5, because settlement from a screen that cannot show the result is not a guided operation.

## 6. Hand-computed examples (SCRUM-486 oracle inputs)

Currency JOD (3 decimals). Minor unit = 0.001.

Example 1: payable partial and full. Supplier S, SOURCED THROUGH_DEALERSHIP, stored entitlement 8,000.000 (an input to the row, not derived from price minus cost). Pay 3,000.000: PARTIALLY_PAID, remaining 5,000.000, GL 2400 down by 3,000.000. Pay 5,000.000: PAID, remaining 0. A further 0.001 is refused (no write). Pay 5,000.001 instead of 5,000.000: refused as over-application, nothing written.

Example 2: margin receipt. Supplier T, SOURCED DIRECT_TO_SUPPLIER, commission 500.000 due from T. Receipt 200.000: PARTIAL, remaining 300.000, GL 1240 down by 200.000. Receipt 350.000: refused.

Example 3: no netting. Supplier S has A/P open 5,000.000 and A/R open 300.000 in JOD. The statement shows both. GL 2400 stays 5,000.000 and 1240 stays 300.000. If the owner allows an informational net, it reads "5,000.000 payable and 300.000 receivable, not netted; difference 4,700.000 (information only)". Paying S 5,000.000 leaves A/R 300.000 open.

Example 4: currency separation. A/P USD 1,000.00 open and A/R JOD 100.000 open for the same supplier: two figures, no combined number.

Example 5: aging as of 2026-10-31, due dates known. Lines 1,000.000 due 2026-10-31 (current), 2,000.000 due 2026-10-20 (11 days: 1-30), 3,000.000 due 2026-09-15 (46 days: 31-60), 4,000.000 due 2026-06-01 (152 days: over 90), 500.000 with no due date (No due date), 700.000 DISPUTED due 2026-10-01 (Disputed bucket). Open total 11,200.000 = 1,000 + 2,000 + 3,000 + 4,000 + 500 + 700. Overdue total (1-30, 31-60, 61-90, over 90, excluding No due date and Disputed): 9,000.000.

Example 6: multi-line payment (S6). Open lines 2,000.000 and 1,500.000 and 1,000.000 for supplier S; pay 3,200.000: allocations 2,000.000 / 1,200.000 / 0.000 gives line 1 PAID, line 2 PARTIALLY_PAID remaining 300.000, line 3 untouched; sum 3,200.000 equals cash.

Bucket edges (0 days = current, 1-30, 31-60, 61-90, over 90) are a proposal, not a ruling (OQ-1).

## 7. Predicted ways this design could be wrong (self-attack)

1. The supplier link is not clean. Legacy rows are keyed by free-text names, with "Unknown supplier" defaults (`saleCompletion.ts:2232, 2246`). If P2/P3 backfill leaves ambiguous or unlinked rows, per-supplier totals will not add up to the GL. Mitigation: an always-visible Unlinked bucket that is part of the W2 reconciliation, and the workspace says "supplier totals incomplete" while any unlinked amount is non-zero. Detection: S3 test with a mix of linked and unlinked rows. If the unlinked share is large at pilot, the pilot should not use the workspace figures as the dealer's truth until it is resolved.
2. Candidate A hits a bound or is slower than assumed. Three tables plus up to 100 receipts per recovery make a supplier with many lines expensive, and a statement page may scan more than expected because of status filtering. Mitigation: cursor paging, the `complete` flag, and a measurement in S3 before committing to A. Detection: document counts on the preview. Fallback: candidate B.
3. The workspace becomes a second ledger or drifts from the doors. Storing totals (B), caching in client state, or adding a settlement group (S6) whose allocations disagree with per-line rows would break W3, W4 and W13. Mitigation: no stored balance in S3 to S5, S6 writes the group in the same mutation as the per-line doors, and a reconciliation test compares group sums to line sums. Detection: S2 and a post-settlement equality assertion in every S5 and S6 test.
4. The workspace exposes a door that is not certified, or a refusal exists only in the UI. Recovery receipt reversal exists and is not RT11-disabled; payable payments and margin receipts may not be in the pilot manifest at all. Mitigation: the server-side allow-list manifest, a test that fails when a new money mutation is called from workspace code, and OQ-2 answered before S5. Detection: the allow-list test, SCRUM-810 manifest review. Residual: if OQ-2 is not answered, S5 stays BLOCKED, not PASS.
5. Dates and units are wrong. Overdue needs a due date that no code writes (`paymentDueDate` never set), so any default would produce false overdue; payables are major-unit floats while recoveries are minor units, so sums can differ by a float hair; as-of aging from a cumulative `amountPaid` gives wrong history for past dates; and "today" depends on timezone. Mitigation: no due date means no overdue and no alert; all comparisons and sums in integer minor units of the line's currency; past as-of dates UNAVAILABLE where no dated payment events exist; a single server-side clock and timezone rule decided with OQ-1. Detection: S3 bucket-edge tests (day 0, 1, 30, 31) and a float-hair test.

## 8. Open questions for the owner

Each of these is a money or policy rule that agents must not decide. The default stated is what the design does until the owner rules.

| Id | Question | Default until ruled |
| --- | --- | --- |
| OQ-1 | What makes each obligation due, and when is it overdue? Payable due on sale, N days after sale, a supplier-specific term, or on demand? Receivable (commission) due on sale or N days? Recovery due N days after opening? Which timezone defines "today"? Are the aging bucket edges 0 / 1-30 / 31-60 / 61-90 / over 90 acceptable? | No due date means "No due date" bucket, no overdue, no alerts (S8 blocked) |
| OQ-2 | Which supplier doors are in the pilot manifest and certified: payable partial and full, margin receipt, recovery receipt? Is any reversal or correction (payable payment, margin receipt, recovery receipt reversal `reverseReceipt`) indispensable for launch? | All treated as "enabled, certification unproven"; S5 BLOCKED on the answer; reversal refused for payables and margin receipts; recovery reversal refused in the workspace |
| OQ-3 | Are there signed-off owner and legal rules for netting a supplier's A/R against A/P (feature 6)? | None exist; nothing built; the UI offers no netting (S9) |
| OQ-4 | May the screen show an informational net per currency (clearly "not a balance")? | Not shown |
| OQ-5 | Which permissions map to "manager or accountant"? Is MANAGE_FINANCE (existing on all doors) right for settling and VIEW finance for reading? | MANAGE_FINANCE to settle, `view:finance` to read |
| OQ-6 | Should supplier cash settlements reach the cashbook and cashier day (today they do not, `vehicles.ts:2254-2261`)? | Unchanged; the workspace states that supplier settlements are not in the cashbook |
| OQ-7 | Who receives due and overdue alerts and how many days before due? | None (S8 blocked) |
| OQ-8 | Do DISPUTED lines count in the open total and in aging? | Shown in their own bucket and included in the total, never dropped |
| OQ-9 | For a payment across several lines: must the user enter exact amounts per line, or may the system allocate oldest first and let the user confirm? | User confirms exact amounts, oldest-first suggested |
| OQ-10 | Is one organization-wide A/R and A/P reconciliation (rather than per supplier) enough for period close, or must close be blocked on a difference? | Reconciliation is displayed only, not a close gate |

### 8.1 Rulings, 2026-10-29

These supersede the defaults above. Jira SCRUM-869 records them: c23881 for OQ-2, c23883 for OQ-1 and OQ-7, and c23880 for the coordinator decisions.

- **OQ-1 (owner): due dates and aging.** An agreed due date always wins. The triggers by ownership model:
  - SOURCED, THROUGH_DEALERSHIP: the payable is due once the deal is completed and the dealership holds cleared proceeds.
  - SOURCED, DIRECT_TO_SUPPLIER: the commission receivable is due on completed delivery, and no supplier payable is created.
  - OWNED, ON_ACCOUNT: the supplier's agreed terms apply.
  - Cost recovery: due when the documented reimbursement becomes collectible.

  With no reliable date or trigger, the line shows "No due date" and is never overdue. The aging buckets are Current, 1-30, 31-60, 61-90 and 90+ days overdue, measured in Asia/Amman time. Disputed amounts appear separately and stay in the gross balance.
- **OQ-2 (owner): pilot doors.** Payable payment, consignment margin receipt and cost-recovery receipt are in the pilot and must be certified. Their reversal and correction doors are excluded and must refuse server-side. S5 is unblocked for these three doors.
- **OQ-7 (owner): alerts.** In-app alerts only, to Owner, Finance Manager and authorised accounting staff. They fire 3 days before due, on the due date, at 7 days overdue, then weekly while overdue. Alerts are never duplicated and never cross tenants. A line with no due date gets no overdue alert, and a disputed line gets no payment reminder. S8 is unblocked.
- **OQ-3 and OQ-4 (coordinator, within existing rulings):** no netting and no net figure.
- **OQ-5 (coordinator):** each reused door keeps its existing permission, and the workspace grants nothing new.
- **OQ-6 (coordinator):** each door's cashbook behaviour stays unchanged.
- **OQ-8 (coordinator):** disputed amounts are shown separately, stay in the gross balance and in aging, and are excluded from "payable now".
- **OQ-9 (coordinator):** the user types the exact amount for each line. Nothing is pre-filled or allocated oldest-first.
- **OQ-10 (coordinator):** the reconciliation is displayed and never posted, and it is not a close gate.

## 9. Evidence limits (what was not checked)

- Accounting practice (subledger to control account, aging, allocation to open items) is stated from general knowledge. No standard or textbook was fetched in this session.
- Convex limits come from docs.convex.dev/production/state/limits, fetched 2026-10-29. The Aggregate component docs page timed out; the GitHub README for `get-convex/aggregate` was used instead.
- Jira text of SCRUM-869 came in the task brief. Jira comments, SCRUM-810 and SCRUM-486 details, and the signed-off rulings were not read; they are not in this repository. The "six issue scenarios" are referred to here as SC-869-1..6 in feature order (1 supplier statement, 2 aging, 3 collect receivable, 4 settle payable, 5 refuse without route, 6 ownership cases); reconcile the numbering with the Jira text before registering them.
- No test, build or typecheck was run (CPU cap; design only). No code was written.
- Whether every obligation table keeps dated payment events (needed for past as-of aging) was not confirmed; the design marks past as-of UNAVAILABLE until S3 confirms.
- Which GL account `ruleSupplierCostRecoveryReceived` uses was not traced; S2 must confirm before the A/R reconciliation claims coverage of recoveries.
- The impact map is a grep enumeration (section 2). Dynamic table access would not appear in it.
- UI translation file locations and the existing Arabic copy were not inspected.
- The line numbers are for 315bcd831; other lanes (notably SCRUM-868 P2) will move them.
