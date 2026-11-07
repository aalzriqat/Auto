# Opening balance editing, voiding, and corrections

Date: 2026-11-08. Issue: SCRUM-850, comments c24748/c24749.
Status: part 1 accepted for implementation; part 2 design only.
Baseline inspected: a01d5fe5c7d6a665a51c6dd55b2165e554191258.

## Owner authority and invariant

Owner request: "We need to be able to update, delete or change the registered opening balance before or after starting operating on the system."

The coordinator supplied these owner rulings, selected in Arabic on 2026-11-08:

1. "Pending draft (not yet approved): editable in place, same validation, still needs a second-person approval."
2. "Posted opening balance, BEFORE operations start (no ledger activity other than the opening itself): full void and re-entry is allowed with a second person's approval."
3. "AFTER operations start: no deletion. A documented correction entry dated at the opening date, approved by a second person, changing only the named lines; refused when it conflicts with later activity (e.g. removing an opening car since sold, reducing a supplier payable below what was paid)."

Invariant: an opening change preserves the same economic position in the general ledger, account snapshots, bank attribution, and native subledgers, or refuses atomically; posted journal history remains readable and approval cannot come from the requester or preparer of the relevant operation.

An edited pending draft remains pending, retains its preparer, and can be edited by that preparer alone. It passes the same currency, date, account, bank, allocation, payroll, and exact-money validation as a new draft. Approval revalidates the latest stored content. An owner has no single-person void exception.

## Evidence and impact map

The enumeration starts with `postOpeningBalanceDraft`, follows `materializeOpeningAllocations` and every arm of `materializeOpeningRow`, and follows the called writers `materializeOpeningCommission`, `insertOpeningDeposit`, and `ensureReceivableDocument`/`createReceivableDocument`. `graft callers` in both directions and `graft grep openingBalanceDraftId` supplied the cross-reference inventory. Source files, rather than the index, were inspected. Scope is current repository source at the baseline, not production rows written by deleted historical code.

| Family | Opening writer / recorded identity | Consumers and later writers | Void before activity |
| --- | --- | --- | --- |
| Journal header and lines | `convex/accountingCutover.ts`, draft `journalEntryId`, `sourceType=cutover` | `accountingReports`, `accountingLedger`, `financialAudit`, `accounting/reversals` | Retain lines; mark original REVERSED and insert a linked POSTED reversal at the opening date with opposite sides and the same physical bank |
| Account snapshots | `incrementAccountSnapshot` in the shared poster | `accounting/accountSnapshots`, period closing, trial balance | Apply the opposite amounts through the same snapshot writer; require the original period still open, so sealed snapshots cannot be silently invalidated |
| Bank attribution and report eligibility | wrapped mutation triggers in `functions.ts`, `aggregates.ts`, `accounting/bankAggregateTriggers.ts`, `utils/journalReportEligibility.ts` | `bankAccounts`, `bankBalanceBackfill`, `accounting/bankLineAggregate` | Use the wrapped database writer for reversal lines and header changes; retain both sides of the historical attribution |
| Opening stock basis | vehicle result, `vehicles.openingBalanceDraftId` | `utils/openingVehicleBasis`, sales and vehicle cost writers, `OpeningCostBadge` | Clear the posted basis marker, retain the vehicle, purchase price, opening import evidence and command identity; refuse a sold or otherwise consumed basis |
| Customer receivable | receivable result plus canonical document result | `utils/openingReceivableBasis`, `collections`, `subledger`, reconciliation reports | Delete the untouched opening-created legacy row and its canonical document; refuse altered balances or downstream references |
| Employee advance | advance result | `utils/openingAdvanceBasis`, `employeeAdvances`, `payroll`, `employeeAdvanceRecoveries` | Delete the untouched opening advance; refuse any recovery |
| Prepaid benefit | schedule result | `utils/openingPrepaidBasis`, `prepaidExpenses`, amortization and consumer reports | Delete the untouched OPENING schedule; refuse recognition, cancellation, refund, or write-off |
| Supplier recoverable | recovery result | `utils/openingSupplierBasis`, `supplierCostRecoveries`, recovery receipts and reconciliation | Delete the untouched opening claim; refuse receipts or recovered money |
| Supplier / other payable | payable result | `utils/openingSupplierBasis`, `sourcingPayables`, `openingPayablePayments`, supplier reconciliation | Delete the untouched opening payable; refuse payments or changed amount |
| Employee commission | commission result, `openingDraftId` | `utils/openingCommissionLiabilities`, `payroll`, `openingManagementSettlement` | Delete the untouched liability; refuse payment or payroll attachment |
| Partner capital | partner result, opening minor amount and draft marker | `accounting/openingPartnerAllocations`, `utils/openingPartnerBasis`, `partnerEquity` and its transactions | Clear opening amount and marker, retain the original zero-base partner master; refuse subsequent movements |
| Named customer deposit | deposit result | `utils/openingDepositBasis`, deposit applications, payouts, forwards, commitment readers, customer-deposit reconciliation | Delete the untouched HELD opening deposit; refuse applications, payouts, canonical receipt, or commitment references |
| Unallocated liability / suspense | result carries purpose; no native liability row | opening readback and close checks | Reverse the GL line; preserve the allocation and purpose in draft history |
| Draft and audit | `openingBalanceDrafts`, `auditLog` | pending approval panel, opening status and readback, source identity readers | Keep the complete posted draft, immutable allocations/results, requester, approver, reason, times, and linked reversal; terminal status VOIDED excludes it from active source identity |

`utils/openingResetCleanup.ts` is the shared cleanup boundary. Its current reset helpers cover payable ids and source references, while the broader suspended-org reset enumerates whole financial tables. Part 1 will put an exhaustive allocation-result-to-target resolver in that shared module and use it in both the existing reset helpers and the narrow void. The void must not call the suspended-org batch reset, clear retained allocation proof, scan-delete an org, or maintain a separate payable-source list. The resolver covers the result validator's complete discriminated union; a new kind must cause a type error until classified. Literal fixture expectations independently cover its families.

Historical rows without matching result identity, malformed links, partial resets, or incomplete inventories refuse. No migration guesses an opening's provenance. The UI uses a server-resolved capability and permission-filtered content; it cannot authorize a void. Finance authority is required on all commands, payroll authority when payroll allocations are present, and cost authority before returning cost-bearing draft content. Every caller-supplied draft id uses `requireOwnedRow`.

## Two void designs

**A, chosen: one bounded approval transaction.** Store a request on the posted draft. Approval reads the complete org-wide POSTED and REVERSED ledger inventory, verifies previously governed void pairs, validates every materialized target and its downstream references, and requires the original period to remain open. It then removes opening-only projections, posts the reversal, updates snapshots, marks the draft VOIDED, and writes an audit row in the same mutation. No intermediate economic state is committed. Bounds refuse rather than delete a partial set. Request and approval repeat activity checks, including queued or existing accounting events, so intervening operations invalidate a request. Replay returns the existing verified reversal without new writes. Fresh opening admission ignores only verified governed void pairs, never a category or a bare REVERSED status.

**B, rejected: suspended multi-batch reset and replacement.** Freeze economic writes, drain children in batches using the org reset, then re-enter. This scales beyond a single mutation but suspends an operating org, spans transactions, risks deleting unrelated financial rows, and needs a recovery protocol. It does not meet the owner's atomic opening-only void rule. The existing admin reset retains its own contract.

A legitimate void does not delete opening stock import commands or partner masters: those predate materialization and are necessary to re-enter an opening. Reversing journal lines, rather than removing old lines, keeps report eligibility and bank aggregates consistent with their existing consumers. Other open periods do not authorize a void after operations in any period. A closed opening period requires separate finance review; this lane does not reopen or rewrite closed snapshots or invalidate signed cutover attestations.

## Two correction designs for part 2

**C, preferred for later implementation: named immutable correction commands with atomic deltas.** A separate pending correction records the base draft, stable row keys, before/after values, opening accounting date, reason, and preparer. A second actor approves after re-reading the affected native rows and later activity. Post only the net delta journal and apply matching native deltas. Preserve the original opening and each correction, and make source readers resolve the original plus the certified correction chain. Examples: an unsold opening car may change basis only if no sale/cost consumption depends on the old amount; a payable cannot fall below payments, and an advance cannot fall below recoveries. Repeated approval identifies the same command and emits no second delta. Correcting a correction is another named command, not deletion. The chain needs a version token so later activity or another correction invalidates stale approval. Closed periods require explicit policy for reopening, rebuilding dependent snapshots and re-signing, before implementation can accept opening-date deltas there.

**D, rejected: full reversal and replay after operations.** Reverse the entire opening and recreate it, then replay every dependent sale, receipt, payroll, supplier settlement, depreciation, deposit application, and report snapshot. This changes unnamed lines and historical dependency identities, requires a general replay engine, and can erase or double-count later activity. It violates the owner's named-line correction constraint.

Part 2 must define row-specific conflict floors and correction-aware source proofs across all readers in the map, historical and closed-period reporting, correction reversal, concurrency on source versions, and pilot activation review. Part 1 introduces no after-operations correction door and enables no deferred financial workflow.

## Five predicted failure modes and proof obligations

The pre-implementation advisory design review inspected the sources and identified additional refusal obligations. Pending or approved `openingManagementSettlementPlans` depend on the posted opening even without a journal. Unpaid `payrollItems.openingCommissionLiabilityIds`, collection approval requests, cheques, allocations, receipt applications, and deposit commitment children also consume source identity before payment. The reset survivor registry in `utils/orgResetReferences.ts` additionally names claims, collection reminders, and payment intents. Void must refuse these later references rather than delete them. These are source-inspected design findings, not an independent review seat or executed evidence.

1. A ledger-only reversal leaves native AP, AR, stock, or commission liabilities alive. Drive all materialization families through registered posting and void commands; assert their literal minor amounts disappear or return to zero while masters survive.
2. A status/category shortcut admits a fresh opening after an ordinary reversal, or forgets activity in a different period. Verify linked governed pairs with original and opposite lines; refuse all other POSTED/REVERSED journals org-wide, including activity inserted after request and direct posting attempts.
3. The requester's approval, changed tenant id, payroll restriction, or a stale edited draft bypasses review. Exercise registered functions with real memberships, foreign documents, and same-actor requests; compare the complete table state before and after each refusal.
4. Ledger, trial balance, account snapshots, or bank attribution disagree after void. Read the actual report and bank consumers and literal per-account nets, retain original/reversal history, and refuse sealed periods instead of rewriting sealed snapshots.
5. Retry, damaged provenance, a downstream child, or a transaction-limit refusal commits half a cleanup. Validate before writes, leave unexpected errors uncaught so Convex rolls back, replay approved requests without writes, and assert every schema table is unchanged on refusal with the scheduler clock frozen.

## Sources and verification boundary

Checked 2026-11-08:

- [Convex mutations and transactions](https://docs.convex.dev/functions/mutation-functions): a mutation runs transactionally. This supports combining source checks and the entire unwind in one mutation; a multi-action workflow would not supply that atomicity.
- [Convex writing data](https://docs.convex.dev/database/writing-data): native transactional writes and transaction headroom support bounded reads and fail-closed approval. Reuse `inTurn` for sequential bounded steps, rather than starting unbounded sibling I/O.
- [Oracle journal reversals](https://docs.oracle.com/en/cloud/saas/financials/26a/faiac/journal-reversals.html): reversal journals link to the posted original and can switch debit and credit. This ADR chooses that method and retains original entries.
- [University of Virginia accounting journals training](https://uvafinance.virginia.edu/sites/uvafinance/files/2022-05/Accounting%20Journals%20%26%20Accounting%20Adjustments-%20Learner%20Copy.pdf), journal reversal section: original and reversal remain in the ledger as the audit trail. Part 2 uses documented adjustments rather than rewriting posted lines.

Risk: HIGH financial and permission change. Registered-function convex-test evidence establishes application behavior in the serial harness, not OCC, Convex cloud limits, production data parity, or release certification. The coordinator owns Jira and final independent seats. No deployment, push, or pilot certification is authorized in this lane. Rendered desktop/mobile EN/AR verification and all three bug hunters remain separate evidence, never inferred from TypeScript or unit tests.
