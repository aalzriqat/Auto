# Supplier stored-id readers require live organization-owned targets

SCRUM-942. Invariant: a supplier reader uses a document reached through a stored id only when it belongs to the caller's organization and is not soft-deleted. Otherwise it behaves as if the target were absent. Existing finance and cost permissions remain unchanged.

Use ownedSupplierDocument for the direct supplier joins. Keep supplierNavigation.ts byte-identical to main ffa590c2e5df1d498be20280fed4e1be0d9e3bd6, whose statement fingerprints and form allowlist protect the reviewed 897 navigation behavior cells. The complete three-statement ownership decision in navigation must match ownedSupplierDocument through the TypeScript AST parity test in scripts/intelligence/supplierStoredIdRules.test.ts. Both predicates reject absent, foreign and soft-deleted documents. A thin direct-read adapter and the receivable vehicle projection fit the unchanged formatted-line ceilings. Each join performs its existing get in the caller's transaction.

The alternatives were (a) keep the round-1 extraction and re-derive the door rows, axes, cells, form allowlist and imported-helper closure, (b) retain the reviewed navigation implementation with enforced predicate equality, and (c) change a global tenancy helper. Choose (b) for this change. Candidate (a) would remove the duplicate implementation, but it also moves the predicate outside the current navigation proof and requires a new reviewed closure. Updating hashes alone would misstate that proof. Candidate (b) leaves those contracts intact and refuses unilateral predicate changes. It is weaker than a single runtime implementation because the equivalence test must run and remain trustworthy; it is stronger than two unrelated finite behavior tables for detecting predicate drift. Coordinated wrong edits to tests and production remain a review risk. Candidate (c) changes unrelated history/error policy and pinned authorization code: requireOwnedRow throws instead of returning null and does not check deletion, while sameOrgOrNull deliberately retains deleted history.

| Edge | Foreign or deleted target |
| --- | --- |
| vehicleSupplierReceivables.vehicleId to vehicles in list | vehicleLabel is "Vehicle"; vin is absent |
| supplierCostRecoveries.vehicleId to vehicles in list | vehicleLabel is null |
| supplierCostRecoveries.expenseId to expenses in list | expenseTitle is null |
| supplierCostRecoveries.vehicleId to vehicles in reverseReceipt | Refuse with the existing "This car is no longer a sourced vehicle, so its supplier cost recoveries are closed and cannot be reversed." message, before ledger writes. This reveals no fact about a foreign document. |
| Legacy supplier obligation or concession vehicleId to vehicles in evaluateVehicleLink | Deleted vehicles produce the existing NO_VEHICLE verdict. Preserve the existing internal foreign-organization reason. No new repair or backfill is introduced or executed. |
| memberships.roleId to roles in eligibleRecipients | The member is ineligible for supplier alerts. |

The reversal pilot switch remains closed. Historical mechanics tests use the existing test-only switch mock. The repair and alert workers have no public entry, so their additional regressions invoke their internal registered functions. The sale/application facts used for aging remain report-only pending business policy.

This follows [Convex access-control guidance](https://docs.convex.dev/understanding/best-practices/#use-some-form-of-access-control-for-all-public-functions), [Convex authentication in functions](https://docs.convex.dev/auth/functions-auth), and [OWASP API1:2023 object-level authorization](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/): authorization must cover the referenced object, not just the containing row. The helper is a shared check, not a second authorization system. Public-function harness regressions and selective mutants supply implementation evidence, not cloud or production certification.

## Merged-tree census and exceptions

Rechecked on 2026-11-12 against fetched main ffa590c2. The two incoming main commits change only three test files under convex/, with no production difference in this census from db60cad5. The scope is 33 non-test files: convex/supplier*.ts and convex/utils/supplier*.ts, plus suppliers.ts, accounting/openingSupplierAllocations.ts, utils/openingSupplierBasis.ts, utils/openingSupplierPosting.ts and utils/costBearer.ts. These include the new ownership module. Search terms were ctx.db.get, db.get variants, readCached, readOwned, receivableVehicleMetadata, normalizeId and requireOwnedRow, followed through the consuming helpers. Transitive openingSettlementBasis was checked too. This is a repository census, not a statement about historical writers or live data.

In the table, root files are under convex/ and utils paths are under convex/utils/. Line numbers describe the merged implementation. The first six rows have separate foreign and deleted behavioral tests in supplierStoredIdReaders.scrum942.test.ts and separate production mutants for each check. Navigation and relationships also have separate organization/deletion behavioral mutant kills in supplierNavigation.scrum869.test.ts. Other unchanged guards below are inspected boundaries; this change does not claim a fresh per-site mutant certificate for them.

| Reader and line | Stored id followed | Rule or reason |
| --- | --- | --- |
| supplierReceivables.list, supplierReceivables.ts:143; supplierDocumentOwnership.ts:30 | receivable.vehicleId to vehicles | Shared rule; `receivables list hides a foreign/deleted stored vehicle` |
| supplierCostRecoveries.list, supplierCostRecoveries.ts:218 | recovery.vehicleId to vehicles | Shared rule; `recoveries list hides a foreign/deleted stored vehicle` |
| supplierCostRecoveries.list, supplierCostRecoveries.ts:219 | recovery.expenseId to expenses | Shared rule; `recoveries list hides a foreign/deleted stored expense` |
| supplierCostRecoveries.reverseReceipt, supplierCostRecoveries.ts:556 | recovery.vehicleId to vehicles | Shared rule; `receipt reversal refuses a foreign/deleted stored sourced vehicle`; pilot door still closed |
| evaluateVehicleLink, utils/supplierIdentityRepair.ts:99-102 | payable/receivable/recovery.vehicleId and application.vehicleItems[].vehicleId or vehicleId to vehicles | Shared rule plus existing foreign diagnostic; `supplier identity repair ignores a foreign/deleted stored vehicle` |
| eligibleRecipients, supplierDueAlerts.ts:108 | membership.roleId to roles | Shared rule; `supplier alerts ignore a foreign/deleted stored membership role` |
| owned via saleSource, utils/supplierNavigation.ts:27,43 | obligation.saleId to sales | Same predicate, AST parity and literal sale lookup tests |
| owned via saleSource, utils/supplierNavigation.ts:27,48 | sale.applicationId to financeApplications | Same org; application table has no isDeleted; application lookup foreign tests |
| owned via sourceFor, utils/supplierNavigation.ts:27,61 | openingBalanceDraftId to openingBalanceDrafts | Same org and POSTED; table has no isDeleted; opening lookup foreign tests |
| owned via sourceFor, utils/supplierNavigation.ts:27,67 | recovery.expenseId to expenses | Same predicate; expense lookup deleted and foreign tests |
| owned via sourceFor, utils/supplierNavigation.ts:27,69,74 | obligation.vehicleId to vehicles | Same predicate; expense-vehicle and native/sale-vehicle lookup tests |
| ownedVehicle, supplierRelationships.ts:26-27 | payable.vehicleId to vehicles | Same org and not deleted; `owned relationships refuse distinct deleted and foreign vehicles beside valid stock` |
| eligibleRecipients, supplierDueAlerts.ts:120 | membership.userId to users | Global user identities have no orgId/isDeleted; scoped membership and disabled check apply |
| alertSupplier, supplierDueAlerts.ts:168-172 | obligation id to payable/receivable/recovery; obligation.supplierId to suppliers | Org check and requireOwnedRow; these four tables have no isDeleted |
| reverseReceipt, supplierCostRecoveries.ts:511,545 | receipt.recoveryId to supplierCostRecoveries | requireOwnedRow; table has no isDeleted |
| editMissing, supplierLaunchEvidence.ts:36-38 | edit.vehicleId to vehicles | Same org and not deleted; existing dead pending foreign/deleted edit tests |
| parentLookup, supplierLaunchEvidence.ts:56-57 | receipt.recoveryId or opening payment.payableId to recovery/payable | Same org; neither parent table has isDeleted |
| search/searchForManagement, suppliers.ts:316,441 | alias.supplierId to suppliers | add callback checks org; suppliers have no isDeleted; inactive history is a separate status policy |
| readSupplierSnapshot, utils/supplierRegistry.ts:350-354 | stored/new supplierId to suppliers | Same org; no isDeleted; active status required except proven replay |
| requireResolvedSupplierId, utils/supplierRegistry.ts:376-380 | obligation.supplierId to suppliers | Same org; no isDeleted; inactive suppliers deliberately remain settleable |
| requireSupplierSnapshotForCompletion, utils/supplierRegistry.ts:399-402 | vehicle.sourcedSupplierId or expense.costBearerSupplierId to suppliers | Same org; no isDeleted; inactive completion preserves historical obligations |
| ownedStoredSupplierId, utils/supplierRegistry.ts:415-416 | vehicle.sourcedSupplierId to suppliers | Same org; no isDeleted |
| supplierNameEvidence, utils/supplierRegistry.ts:451-452 | vehicle.sourcedSupplierId to suppliers | Same org; no isDeleted; identity corroboration, not a name-based join |
| collectNameCandidates, utils/supplierRegistry.ts:655-656 | alias.supplierId to suppliers | candidateCollector.note checks org at 609; no isDeleted |
| assertOpeningPayablePosting, utils/openingSupplierPosting.ts:35-37,48-50 | command.sourceId to payable; payload.openingPaymentId to payment | Both check org; neither table has isDeleted |
| assertOpeningRecoveryPosting, utils/openingSupplierPosting.ts:118-125 | command.sourceId to receipt; receipt.recoveryId to recovery | Both check org; neither table has isDeleted |
| openingRecoveryBasis/openingPayableBasis, utils/openingSupplierBasis.ts:91,126 | obligation.openingBalanceDraftId to openingBalanceDrafts | resolveOpeningSettlementBasis checks org and POSTED at utils/openingSettlementBasis.ts:128-136; no isDeleted |
| ownedSale, utils/supplierObligationFacts.ts:101-102 | obligation.saleId to sales | Org checked; deletion intentionally REPORT ONLY under the task's history-policy exception |
| ownedApplication, utils/supplierObligationFacts.ts:113-114 | sale.applicationId to financeApplications | Org checked; no isDeleted |
| readCached, utils/supplierReadCache.ts:30 | ids above to five cached table families | Raw I/O/cache only; the consuming reader above decides ownership and deletion |

supplierIdentityRepair.ts:130 and supplierRegistry.ts:172 read the supplied organization itself, rather than a stored foreign key. Supplier public input ids use requireOwnedRow. suppliers.requireSharedIdentityTarget verifies a new link; update/deactivate/reactivate/addAlias/retireAlias follow no further stored id. supplierConcession and costBearer have org-indexed application/recovery queries and no stored-id get. supplierBearerRefusal checks the vehicle passed by its caller. supplierSettlement and supplierSettlementContainment perform no database reads. No new unchecked stored-id edge arrived from main in the enumerated files.

## Reachability and policy boundaries

The original writer census at db60cad5 found three inserts and nine patches of vehicleSupplierReceivables and supplierCostRecoveries, with no replace. Their production source is unchanged on merged main. openSupplierReceivable's saleCompletion caller verifies vehicle org and deletion; openSupplierCostRecovery's expenses caller verifies a live org vehicle and cost bearer. The OPENING allocation writer stores neither vehicleId nor expenseId. Receipt, dispute, cancellation and repair patches change money/status/audit or supplier identity, not the native source ids. Thus the traced normal product paths do not store foreign native vehicle/expense ids. Direct test writes model corrupt or historical references; a once-valid target may later be deleted. No production incidence is inferred.

sales has isDeleted; financeApplications does not. ownedSale intentionally retains deleted sale facts for this task. Treating those facts as absent can remove THROUGH_DEALERSHIP funding/delivery facts, change the payable model and due rule, and move trigger-derived aging to NO_DUE_DATE. Agreed due dates and obligation amounts remain. Normal sales.softDelete refuses COMPLETED sales. Changing historical aging needs its own business decision.

The two lists retain view:finance plus view:cost_price. Vehicle readers require view:vehicles and expense readers require view:expenses; the sourcing screen does not add those grants. This change does not resolve that separate permission-policy question. The original app/, components/ and apps/mobile/ caller census found no supplierReceivables.list client caller; no client file changed in this lane. Reconciliation journal/event guards under SCRUM-889 remain separate from this decision and its Jira/release status.

## Evidence and limits

Round 1 had ten behavioral failures before the fix and two passing foreign repair/role controls. Round 2 kills twenty selective production mutants: organization and deletion independently at six readers, the shared predicate, its direct adapter, navigation and relationships. The shared-predicate mutants also fail the new AST parity check. In repair, removing only the old explicit org diagnostic is equivalent because the shared rule still refuses; its behavioral org mutant bypasses both org defenses while preserving deletion. Every mutant restores saved bytes in finally and verifies the tracked diff against the pre-mutation diff.

Call-through convex-test measurements on live synthetic targets match before/after: receivables 3 gets and 0 writes; recoveries 4 and 0; historical successful reversal 30 and 18; repair 5 and 1; alerts 5 and 3. Each changed join reads its target once. These are one fixture per path and database API call counts, including actual reads/writes through the harness, not cloud bytes, billing, concurrency or latency. Refusal tests separately compare receipt/recovery/journal/event/idempotency state. The five I/O regressions and AST parity control have SCRUM-761 records and matrix bindings.

Official sources rechecked 2026-11-12: the Convex and OWASP references above, [TypeScript's compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API) for parsed statement comparison, and [Vitest spies](https://vitest.dev/api/vi.html#vi-spyon) for call-through I/O. No new global tenancy policy, schema, index, cache, pagination, migration, backfill, UI or financial capability is introduced. Independent review, browser hunters, real-platform and production verification remain separate gates.
