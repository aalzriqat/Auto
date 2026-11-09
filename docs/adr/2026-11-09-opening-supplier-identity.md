# Bind opening supplier balances to the supplier master

Status: proposed implementation, SCRUM-868 P5. Base: `2b1ae16ad436f845db6c2aef6b47ff5cc5bb923d`.
Extends the supplier identity design, section 4 and OQ-4, and the P4a/P4b ADRs.
Rulings: SCRUM-868 c23871/c23873, SCRUM-869 c23881, SCRUM-850 c24749.

## Invariant

Every new supplier opening allocation resolves to an active supplier of the
caller's organization; its posted obligation and approved allocation preserve
the same server-read id, name and version, and subsequent settlement proves
that identity without changing the opening amounts or ledger meaning.

The allocation validator has three kinds that create supplier-table rows:
`SUPPLIER_RECOVERABLE` creates `supplierCostRecoveries`; `SUPPLIER_PAYABLE` and
`OTHER_PAYABLE` create `vehicleSupplierPayables`. The first two require an id.
`OTHER_PAYABLE` may optionally select a supplier, but an ordinary named creditor
without a supplier remains valid under OQ-4. A creditor name is never resolved
to a supplier by text. SOURCED vehicles remain consignment.

## Impact map

Enumeration at the base: Graft callers of prepareOpeningAllocations,
openingPayableBasis and requireResolvedSupplierId, then tracked-source searches
of convex, components, apps/mobile, scripts and test-utils for the allocation
validator, opening supplier tables and materializeOpeningAllocations. Graft
locates; the tracked files are the evidence. This map covers opening identity,
not a certification of unrelated financial workflows.

| Door or consumer | Gate and identity behavior |
| --- | --- |
| accountingCutover.draftOpeningBalance | MANAGE_FINANCE; resolve supplier before insert; store canonical draft snapshot |
| editOpeningBalanceDraft | Existing preparer/pending/payroll gates; resolve replacement allocations before patch; retain version increment and editability |
| approveOpeningBalance / shared postOpeningBalanceDraft | Existing second actor and expectedVersion gates; re-resolve active supplier and freeze one snapshot in approved allocations and materialized rows |
| postOpeningBalanceDirect | Existing system-owner gate; same validation and materializer; no new self-approval capability |
| SUPPLIER_RECOVERABLE materialization | Required same-org active id; one master snapshot supplies id/name/version |
| SUPPLIER_PAYABLE materialization | Same required identity gate |
| OTHER_PAYABLE materialization | Chosen supplier is resolved; ordinary creditor has no supplier gate |
| sourcingPayables.markPaid / recordPartialPayment / setDisputed | Existing tenant/finance/basis gates; identified OPENING rows resolve supplier, including inactive; id-less SUPPLIER_PAYABLE refuses coded unresolved identity; ordinary id-less OTHER_PAYABLE remains serviceable |
| supplierCostRecoveries.recordReceipt | Existing tenant/finance/basis/idempotency gates; identified OPENING rows resolve supplier, including inactive; id-less supplier opening refuses coded unresolved identity |
| supplierReceivables.recordReceipt / setDisputed | Existing identity gate applies without blanket OPENING exemption; opening margin rows have no allocation writer in the validator |
| openingSupplierBasis / openingSupplierPosting | Compare canonical ids when either side carries an id; never let a same-name different id match; name fallback only when both sides lack ids for historical replay |
| opening readback, status, pending query, approval panel | Existing finance/cost/payroll access; optional storage fields preserve historical reads; reads never repair drafts |
| sourcingPayables lists, recovery lists, supplierReceivables summary | Existing tenant/finance/cost access; carry stored snapshots; grouping already uses supplier ids |
| supplierStatement, supplier balances, accountingReports reconciliations | Existing reader gates; consume the identified subledger and opening basis; no second ledger or journal supplier dimension |
| financialAuditProjection / financialAudit.listAuditLog | Existing projection/access gates; edit summaries remain metadata only, without allocations, party ids or money; no identity added to audit copies |
| requestOpeningBalanceVoid / approveOpeningBalanceVoid / opening reset cleanup | Existing second-person/version/activity gates and atomic source removal stay unchanged; ids disappear with their source rows, never reassigned |
| Re-entry after approved void | Fresh draft/direct route revalidates active supplier; no reuse of removed snapshots |
| orgFinancialReset / adminOrgs destructive cleanup | Existing reset/admin gates; supplier fields add no new table or survivor and no repair operation |
| SupplierSelect / openingAllocationForm / OpeningAllocationEditor | Existing search/select/create UI, EN/AR and RTL; inline create remains MANAGE_FINANCE on server and client; optional supplier choice for OTHER_PAYABLE |
| Mobile, reversal, unwind, correction | Existing server refusals stay; no new door or caller |

Historical supplier ids and snapshot versions remain optional in storage.
There is no migration. A pending name-only supplier draft reads unchanged and
can be edited by its preparer to select an id. Posting it without that edit
refuses. Posted name-only drafts retain snapshot-name verification for replay.
New payments/receipts against their id-less supplier rows refuse with
SUPPLIER_IDENTITY_UNRESOLVED. The user supplied a counts-only production read
dated 2026-11-09 reporting zero opening drafts; this session does not access
production or independently certify that count. A discovered real stranded
supplier row blocks rollout and needs an owner decision, not a guessed link.

Retries at settlement retain the existing command fingerprint/key and first
snapshot; they must not add another occurrence or journal. Opening approval
and direct posting retain their existing commitment/state refusal on repeat,
so repeat requests cannot duplicate an opening. No amount, currency, account,
status policy, due date, ledger dimension or monetary formula changes here.
Opening preparation uses direct awaited database reads, including supplier
resolution, so contract-skew can retain allocation provenance.

## Two designs and choice

1. Resolve names at settlement or keep exempting OPENING rows. This permits
   ambiguous names and leaves the approved financial source without identity.
2. Resolve ids at preparation and again at posting, persist the posting
   snapshot on the allocation and obligation, and compare ids thereafter.
   Choose this. Draft snapshots describe preparation; posting captures the
   master at commitment, as P4a does. A rename never substitutes the party and
   settlement does not require an active supplier. Repeated reads of a posted
   source never refresh its snapshot.

Expected refusals use existing supplier ConvexError codes. Unexpected failures
must rethrow a generic error after server logging, preserving rollback. No
callback or stored promise is introduced for database reads in opening helpers.

## Exclusions

P6 journal supplier dimensions, P7 launch evidence, migration/backfill/repair,
mobile enablement, supplier reversal/unwind/correction, and SCRUM-850 Part 2
correction design. Pending draft editability, reviewed-version binding and
second-person void/re-entry approval are preserved.

## Five predicted failures and checks

1. Only one writer is protected. Attack create, edit, approve and direct post
   with missing, foreign, deleted and name-only identity; assert no write delta.
2. A supplied name or version wins over the master. Send forged snapshots,
   rename between preparation and approval, and verify stored master values.
3. Same-name parties satisfy provenance. Substitute another supplier id on
   each opening obligation and require public readback/settlement refusal.
4. Removing the exemption strands ordinary creditors or inactive suppliers.
   Settle an id-less OTHER_PAYABLE, settle identified inactive obligations, and
   refuse legacy id-less supplier rows without rewriting readable history.
5. Retries duplicate money or edits bypass review. Retry settlement with the
   same key, repeat opening posting, and try a stale expectedVersion after a
   pending draft edit; verify original snapshots and two-way row equality.

## Sources and evidence boundary

Checked 2026-11-09: [Convex schemas](https://docs.convex.dev/database/schemas),
[validation](https://docs.convex.dev/functions/validation), and
[ConvexError application errors](https://docs.convex.dev/functions/error-handling/application-errors).
Optional schema fields preserve old documents while backend boundary checks
require ids on new money. Structured errors carry stable client-safe codes.
[Sage supplier opening balances](https://desktophelp.sage.co.uk/sage200/sage200standard/content/Screens/PL/SupplierOpeningBalanceInv.htm)
records outstanding balances against an individual supplier account at the
start of live transactions. [Sage opening balance setup](https://ca-kb.sage.com/portal/app/portlets/results/viewsolution.jsp?Highlight=opening+balance&solutionid=240304191309360)
describes the corresponding payable control-account total. These support
party-level subledger detail reconciled to the existing GL opening, not a new
income/cost event. AutoFlow owner rulings govern its specific gates.

convex-test proves harness behavior, not cloud schema deployment, OCC or
production parity. Independent seats, browser hunters, real-backend execution
and hosted Sonar need their own evidence before release.
