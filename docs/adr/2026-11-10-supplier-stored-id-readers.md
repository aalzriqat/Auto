# Supplier joins distinguish display from historical decisions

SCRUM-942, corrected 2026-11-12 r4; see SCRUM-942 c25054. This supersedes the earlier universal deletion-as-absence policy and its incorrect reversal/repair rows. No new financial lifecycle policy is introduced.

## Context and decision

Display and recipient joins hide foreign/deleted targets while keeping the owned money row, its amounts, status and response shape. Historical decision joins refuse foreign targets or return the existing unresolved reason, but retain same-organization deleted history. Deletion never changes a decision main made. Prospective new-operation admission retains main's explicit lifecycle checks: historical settlement does not authorize creating new costs on deleted vehicles.

ownedSupplierDocument remains the display rule equivalent to pinned supplierNavigation.owned. The adjacent supplierDecisionDocument checks organization only; changed historical vehicle decision sites use it. Existing requireOwnedRow and opening/provenance guards remain where they already enforce stronger contracts, as explained in the census.

Sourcing list/get contain both kinds: labels and full joined documents use the display rule, while vatReclassAllowed uses the raw loaded historical vehicle with the decision rule. A deleted local STOCK vehicle keeps its eligibility even when its metadata is hidden. markPaid and recordPartialPayment reject a foreign costOrigin source with existing code SUPPLIER_PAYMENT_REFUSED and generic text. A silent fallback could choose the wrong ledger account. The uncaught error rolls back the idempotency claim, payable patch and all economic/audit writes. Missing-vehicle inventory fallback remains main's behavior; sale-linked and opening payables remain COGS.

recordReceipt does not read the vehicle: the recovery, canonical supplier, source posting and remaining amount admit the receipt. A later receipt and reversal on the same soft-deleted local SOURCED vehicle remain consistent with main. Only the historical reversal suite opens the pilot-disabled door; it stays NON-PILOT-CERTIFYING. New read/decision/role tests have no door mock.

## Census boundary

The r4 report contains the pre-fix table and raw enumeration. Discovery covers tracked references to vehicleSupplierPayables, vehicleSupplierReceivables, supplierCostRecoveries, their receipt tables and openingPayablePayments, regardless of filename, followed into registry, navigation, repair, opening proof and reconciliation helpers. Large report/application/reset modules enter only for their supplier-family operations, not every unrelated get in those files. D = display/recipient; H = historical money/identity/provenance decision; P = prospective creation/edit eligibility; I = root input, indexed read or infrastructure. The table's 'required' column is also the disposition and reason for each unchanged site. Initial-HEAD checks are retained as audit context, not current claims.

| Target table / stored edge | Function(s) | Class | Check at initial HEAD | Required check / disposition |
|---|---|---|---|---|
| vehicles / receivable.vehicleId | supplierReceivables.list via receivableVehicleMetadata | D | shared org + deletion | Keep; money row remains |
| vehicles / recovery.vehicleId | supplierCostRecoveries.list | D | readOwned org + deletion | Keep |
| expenses / recovery.expenseId | supplierCostRecoveries.list | D | readOwned org + deletion | Keep |
| vehicles / recovery.vehicleId | supplierCostRecoveries.reverseReceipt | H | readOwned org + deletion | Org-only named helper; retain deleted SOURCED history |
| supplierCostRecoveries / receipt.recoveryId | supplierCostRecoveries.reverseReceipt, assertOpeningRecoveryPosting | H | requireOwnedRow or explicit org | Keep stronger existing guards; table has no deletion flag |
| vehicles / id-less money row or concession.vehicleId | evaluateVehicleLink called by repairPage PAYABLES/RECEIVABLES/RECOVERIES/CONCESSIONS | H | explicit foreign reason plus shared deletion suppression | Named org-only helper, retain VEHICLE_OTHER_ORG; deletion must not remove identity evidence |
| vehicles / payable.vehicleId | sourcingPayables.payableListRows (list + listBounded) | D | org only | shared org + deletion for label/VIN |
| sales / payable.saleId | sourcingPayables.payableListRows (list + listBounded) | D | org only | shared org + deletion; stop downstream customer read when absent |
| customers / sale.customerId | sourcingPayables.payableListRows (list + listBounded) | D | org only | shared org + deletion |
| users / payable.paidBy | sourcingPayables.payableListRows | D | global identity | Keep; users have no orgId/isDeleted; no change to global actor-name policy |
| vehicles / payable.vehicleId | sourcingPayables.get | D | org only | shared org + deletion for full joined vehicle |
| sales / payable.saleId | sourcingPayables.get | D | org only | shared org + deletion for full joined sale |
| customers / sale.customerId | sourcingPayables.get | D | org only | shared org + deletion |
| customers / deposit or reservation.customerId | sourcingPayables.listPipeline | D | org only | shared org + deletion; keep depositTotal and vehicle row |
| vehicles / payable.vehicleId | payableAcceptsVatReclass through payableListRows, get and markPaid | H | org only, opening false | Named org-only helper on raw loaded vehicle, independently of display projection; preserve deleted-stock eligibility |
| vehicles / payable.vehicleId; payable / command.sourceId | supplierPaymentVatPostingRefusal (posting engine and outbox) | H | org checks on payable and vehicle, source/payload identity and positive safe tax validation | Keep existing stronger revalidation and history behavior unchanged; no deletion filter. The measured third vehicle get in a full VAT settlement reaches this defense, in addition to markPaid's eligibility and costOrigin reads. |
| vehicles / payable.vehicleId | sourcingPayables.markPaid costOrigin | H | raw read, no org check | Refuse foreign with existing coded SUPPLIER_PAYMENT_REFUSED; deleted same-org preserves status choice; missing keeps main fallback |
| vehicles / payable.vehicleId | sourcingPayables.recordPartialPayment costOrigin | H | raw read, no org check | Same as markPaid |
| roles / membership.roleId | supplierDueAlerts.eligibleRecipients | D | shared org + deletion | Keep rule; restore exact main get line then predicate next line; live/deleted custom and system Owner pairs |
| users / membership.userId | supplierDueAlerts.eligibleRecipients | D | exists and not disabled | Keep; global identity has no orgId/isDeleted |
| payable/receivable/recovery / alert obligation id | supplierDueAlerts.alertSupplier | H | explicit org then supplier requireOwnedRow | Keep; tables have no deletion flag |
| suppliers / obligation.supplierId | supplierDueAlerts.alertSupplier | H | requireOwnedRow | Keep; no deletion flag and existing not-found semantics |
| vehicles / payable.vehicleId | supplierRelationships.ownedVehicle | D | org + deletion | Keep reviewed navigation behavior |
| sales / obligation.saleId | supplierNavigation.owned via saleSource | D | org + deletion | Keep PR809-pinned implementation |
| financeApplications / sale.applicationId | supplierNavigation.owned via saleSource | D | org + deletion predicate | Keep; table has no deletion flag |
| openingBalanceDrafts / obligation.openingBalanceDraftId | supplierNavigation.sourceFor | D | org + POSTED | Keep; no deletion flag |
| expenses / recovery.expenseId | supplierNavigation.sourceFor | D | org + deletion | Keep pinned implementation |
| vehicles / obligation.vehicleId or expense.vehicleId | supplierNavigation.sourceFor | D | org + deletion | Keep pinned implementation |
| sales / obligation.saleId | supplierObligationFacts.ownedSale via payableFacts/receivableFacts | H | org only | Keep historical funding/aging facts; this is not navigation metadata |
| financeApplications / sale.applicationId | supplierObligationFacts.ownedApplication via payableFacts/receivableFacts | H | org only | Keep historical handover/disbursement facts; no deletion flag |
| vehicles / pending edit.vehicleId | supplierLaunchEvidence.editMissing | P | org + not deleted | Keep main prospective UPDATE eligibility; deleted edit cannot resolve |
| recovery/payable / receipt.recoveryId or payment.payableId | supplierLaunchEvidence.parentLookup | H | org + identity inherited from parent | Keep; no deletion flag |
| suppliers / alias.supplierId | suppliers.search, searchForManagement | D | add checks org | Keep; no deletion flag; inactive search policy separate |
| suppliers / obligation.supplierId | requireResolvedSupplierId | H | explicit org, inactive history accepted | Keep; no deletion flag; existing coded refusal/replay contract |
| suppliers / frozen vehicle/expense supplierId | requireSupplierSnapshotForCompletion, ownedStoredSupplierId, supplierNameEvidence | H | explicit org | Keep; no deletion flag; frozen identity and name corroboration preserved |
| suppliers / newly supplied supplierId | readSupplierSnapshot, assertSharedIdentityTarget | P | org plus active/replay policy | Keep stronger prospective admission; not a stored vehicle-liveness join |
| suppliers / alias.supplierId | collectNameCandidates/candidateCollector.note | D | org | Keep; no deletion flag |
| vehicleSupplierPayables / command.sourceId | assertOpeningPayablePosting | H | org plus origin/basis/source proof | Keep stronger proof, no deletion flag |
| openingPayablePayments / payload.openingPaymentId | assertOpeningPayablePosting | H | org, parent, sequence, currency, amount, LIVE, basis | Keep; state is financial lifecycle, not soft deletion |
| supplierCostRecoveryReceipts / command.sourceId | assertOpeningRecoveryPosting | H | org plus parent/status/basis | Keep; no deletion flag |
| openingBalanceDrafts / obligation draft reference | openingRecoveryBasis, openingPayableBasis via requireOpeningSettlementBasis | H | org + POSTED + allocation/result/journal proof | Keep stronger provenance proof; no deletion flag |
| journalEntries/accountingEvents/accounts / source and journal ids | readSupplierPaymentsReconciliation/readGlPaid/controlDebitMinor; supplierReceiptsMinor; pendingAffectingPostingState | H | org/source query + line org/currency and event ownership checks | Keep historical POSTED/REVERSED evidence; not labels |
| accountingEvents / posting result.eventId | postSupplierCostRecoveryReceived | H | existing posting result state + event identity | Keep trusted result of same transaction, not caller/stored cross-tenant vehicle metadata |
| vehicles / new expense.vehicleId | expenses.create/update via supplierBearerRefusal | P | owned live vehicle, bearer/source policy | Keep main creation policy; do not broaden new expense admission |
| vehicles / new sale/acquisition source | completeSale/postVehicleAcquisitionIfOwned | P | owned live caller vehicle; supplier snapshot validation | Keep writers; never introduce foreign ids |
| receivable/payable/recovery root ids | public receipt/payment/dispute/list-bank/list-receipt handlers | I/H | requireOwnedRow, or explicit root org check | Keep error and replay semantics; root tables lack deletion flags |
| obligations / org+vehicle/sale/expense/status indexes | saleCancellation, saleCompletion, financialGuards, supplierCostRecoveryConversionRefusal, vehicleSupplierIdentity, applications, vehicles | H/P | org-indexed rows, input vehicle authority checked by caller | Keep; no stored target get; reversal/conversion policies unchanged |
| obligations / posted opening allocations | applyOpeningSupplierAllocation, opening validators | H/P | current draft/source/account org + allocation identity | Keep; opening rows do not store native vehicle/expense ids |
| obligation families / organization reset and void references | orgFinancialReset, openingResetCleanup, openingVoidCleanup, openingVoidReferences, orgResetReferences, orgResetSurvivorPreflight, adminOrgs | I/H | org-scoped census and reference manifests | Keep destructive lifecycle/provenance machinery; no metadata decoration and no new entry point |
| supplier balances in reports | accountingReports, reportDealFigures, dealSettlementFigures | H | org-indexed amounts and historical owned economic inputs | Keep historical calculations; no deletion-as-absence on money |
| tables/schema/trigger registration/bootstrap | schema, postingRules, postingEngine, workflowHooks, e2eBootstrap | I | typed schema, transactional posting and test-only fixture setup | Keep; no additional supplier display target join |
| cached five-table reads | supplierReadCache.readCached | I | raw scoped request cache | Keep; consumers enforce D/H semantics; cache does not authorize |


## Alternatives and consequences

Retain r2 candidate (b): supplierNavigation stays byte-identical to main ffa590c2. Unifying the runtime predicates would move a permission decision outside PR809's reviewed closure and require a fresh caller/form/behavior proof; renewing hashes alone is insufficient. The duplicate is guarded by complete body comparison and declaration checks: exactly two simple parameters, no executable defaults/rest/destructuring/decorators/overloads, and pinned type parameters, modifiers and return type. The decision helper has the same declaration closure and its own organization-only body contract. Adversarial controls and deleted/live system Owner/custom role behavior complement syntax checks. Coordinated wrong edits to tests and source remain a review risk.

No schema, index, permission grant, client field, amount formula, pilot switch, migration, repair execution or new financial door is added. Prospective supplierBearerRefusal and launch editMissing preserve their existing deletion checks. Historical ownedSale/ownedApplication retain funding/delivery/aging facts. Broader global membership liveness, opaque source-id suppression and permission-policy changes stay outside this lane (coordinator SCRUM-879).

## Verification and sources

Public-function harness tests cover all changed query/mutation decisions, literal amounts, real softDelete transitions, atomic foreign refusal and retry. Existing pinned navigation/tenancy and pilot parity checks remain required. Selective production mutants must fail behavior and be restored with native Git. Actual call-through harness I/O compares main/candidate reads and writes; it does not measure cloud billing, platform execution or concurrency. The reversal switch remains closed, and no local result is pilot/release certification.

Official documentation checked before design: [Convex access control](https://docs.convex.dev/understanding/best-practices/), [atomicity](https://docs.convex.dev/database/advanced/occ), [OWASP API1](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/) and [TypeScript compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API). They support referenced-object authorization, uncaught atomic refusal and declaration-tree inspection. Historical deletion semantics follow the owner requirement and production lifecycle, not a universal soft-delete convention.
