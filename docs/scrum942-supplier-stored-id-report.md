# SCRUM-942 implementation evidence

Truth surface: worktree E:\tmp\auto-942, branch claude/scrum942-supplier-stored-id-tenancy, base db60cad5ed0538729d4b0483e821cafc96566248. Initial fetch found zero commits behind origin/main. No live data was read. Harness evidence does not certify Convex cloud execution, concurrency, production state, or pilot readiness.

## Census before production edits

Line numbers below refer to the base commit. Searches used PowerShell Select-String because rg is unavailable. Patterns: ctx.db.get(, readCached(, normalizeId, requireOwnedRow, and db.get variants. Each fetched document was traced through its consumer, not classified from a get alone. Caller and writer searches used git grep on origin/main and a TypeScript type-checker walk over all non-test, non-generated convex sources for ctx.db.insert/patch/replace whose table argument or id type is one of the two obligation tables.

Files read in full: convex/supplierBalances.ts, supplierCostRecoveries.ts, supplierDueAging.ts, supplierDueAlerts.ts, supplierIdentityRepair.ts, supplierLaunchEvidence.ts, supplierReceivables.ts, supplierRelationships.ts, suppliers.ts, supplierStatement.ts; convex/utils/supplierAttention.ts, supplierConcession.ts, supplierDueAlertPlan.ts, supplierDueDates.ts, supplierIdentityRepair.ts, supplierLaunchRegistry.ts, supplierNames.ts, supplierNavigation.ts, supplierObligationDue.ts, supplierObligationFacts.ts, supplierObligationPage.ts, supplierPaymentAmounts.ts, supplierPaymentsReconciliation.ts, supplierReadCache.ts, supplierRegistry.ts, supplierSettledRows.ts, supplierSettlement.ts, supplierSettlementContainment.ts, openingSupplierBasis.ts, openingSupplierPosting.ts, costBearer.ts; convex/accounting/openingSupplierAllocations.ts. The brief's convex/openingSupplierAllocations.ts is actually under convex/accounting/. There are no other production supplierSettlement*.ts files in the enumerated root and utils globs.

Schema inspection: roles (1367), vehicles (1476), sales (2169), and expenses (2567) have isDeleted. financeApplications (3120), suppliers (8088), supplierAliases (8140), vehicleSupplierPayables (1871), vehicleSupplierReceivables (1754), supplierCostRecoveries (1842), supplierCostRecoveryReceipts (1865), openingPayablePayments (6146), and openingBalanceDrafts (1301) do not. users (201) are global and use disabled; organizations (220) have deletion-request/purge state, not isDeleted.

| Base file:line | Public entry or internal-only entry | Stored edge | Org checked before use? | Soft-delete before change |
| --- | --- | --- | --- | --- |
| supplierReceivables.ts:139 | supplierReceivables.list | vehicleSupplierReceivables.vehicleId -> vehicles | No | No; fix |
| supplierCostRecoveries.ts:216 | supplierCostRecoveries.list | supplierCostRecoveries.vehicleId -> vehicles | No | No; fix |
| supplierCostRecoveries.ts:217 | supplierCostRecoveries.list | supplierCostRecoveries.expenseId -> expenses | No | No; fix |
| supplierCostRecoveries.ts:554 | supplierCostRecoveries.reverseReceipt | supplierCostRecoveries.vehicleId -> vehicles | No | No; fix; currently behind pilot block |
| supplierCostRecoveries.ts:509,543 | reverseReceipt | supplierCostRecoveryReceipts.recoveryId -> supplierCostRecoveries | Yes, requireOwnedRow | N/A, no isDeleted |
| supplierDueAlerts.ts:107 | internal processOrgSupplierDueAlerts, via runOrgSupplierDueAlerts/processSupplierDueAlerts; no public caller | memberships.roleId -> roles | Yes | No; fix |
| supplierDueAlerts.ts:119 | same internal worker | memberships.userId -> users | N/A, global users; membership already scoped to org | N/A; disabled checked |
| supplierDueAlerts.ts:167-171 | same internal worker | obligation row.id -> vehicleSupplierPayables/vehicleSupplierReceivables/supplierCostRecoveries; obligation.supplierId -> suppliers | Yes on obligation and requireOwnedRow supplier | N/A, none has isDeleted |
| supplierLaunchEvidence.ts:36 | internal scanPage only | vehicleEdits.vehicleId -> vehicles | Yes | Yes |
| supplierLaunchEvidence.ts:56 | internal scanPage only | supplierCostRecoveryReceipts.recoveryId -> supplierCostRecoveries; openingPayablePayments.payableId -> vehicleSupplierPayables | Yes, parentLookup | N/A, no isDeleted |
| supplierRelationships.ts:26 | supplierRelationships.vehicles | vehicleSupplierPayables.vehicleId -> vehicles | Yes | Yes |
| suppliers.ts:316 | suppliers.search | supplierAliases.supplierId -> suppliers | Yes, add callback | N/A, no isDeleted |
| suppliers.ts:441 | suppliers.searchForManagement | supplierAliases.supplierId -> suppliers | Yes, add callback | N/A, no isDeleted |
| utils/supplierNavigation.ts:27 via 43 | supplierStatement.outstanding/settled | obligation.saleId -> sales | Yes, owned | Yes |
| utils/supplierNavigation.ts:27 via 48 | supplierStatement.outstanding/settled | sales.applicationId -> financeApplications | Yes, owned | N/A, no isDeleted |
| utils/supplierNavigation.ts:27 via 61 | supplierStatement.outstanding/settled | opening obligation.openingBalanceDraftId -> openingBalanceDrafts | Yes, owned | N/A, no isDeleted; POSTED required |
| utils/supplierNavigation.ts:27 via 67 | supplierStatement.outstanding/settled | supplierCostRecoveries.expenseId -> expenses | Yes, owned | Yes |
| utils/supplierNavigation.ts:27 via 69,74 | supplierStatement.outstanding/settled | native obligation.vehicleId -> vehicles | Yes, owned | Yes |
| utils/supplierReadCache.ts:30 | statement, relationships, aging, balances, attention; internal alert worker | cache miss for tables above | Raw cache is not an authority; checked by consumers above and facts below | Consumer-dependent; never certify cache alone |
| utils/supplierObligationFacts.ts:101 | supplierDueAging.list; supplierBalances.list/get; supplierStatement.outstanding/attention; internal alert worker | payable/receivable.saleId -> sales | Yes | No; REPORT ONLY by instruction |
| utils/supplierObligationFacts.ts:113 | same entries | sales.applicationId -> financeApplications | Yes | N/A, no isDeleted |
| utils/supplierIdentityRepair.ts:98 | internal repairPage only, no public caller | payable/receivable/recovery.vehicleId or application.vehicleItems[].vehicleId/vehicleId -> vehicles | Yes; preserves internal VEHICLE_OTHER_ORG | No; fix deleted -> NO_VEHICLE |
| utils/supplierRegistry.ts:350 | snapshotSupplier/ForProvenReplay, via vehicle intake/edit, expenses.create/update/markPaid, openingBalances draft/preview/post | new or persisted supplierId -> suppliers | Yes | N/A, no isDeleted |
| utils/supplierRegistry.ts:376 | supplierReceivables.recordReceipt/setDisputed; supplierCostRecoveries.recordReceipt; sourcingPayables settlement | obligation.supplierId -> suppliers | Yes | N/A, no isDeleted |
| utils/supplierRegistry.ts:399 | sale completion and expenses paid side effects, supplierCostRecoveries opener | vehicles.sourcedSupplierId or expenses.costBearerSupplierId -> suppliers | Yes | N/A, no isDeleted |
| utils/supplierRegistry.ts:415 | vehicles conversion | vehicles.sourcedSupplierId -> suppliers | Yes | N/A, no isDeleted |
| utils/supplierRegistry.ts:451 | vehicle first-link checks and internal repairPage | vehicles.sourcedSupplierId -> suppliers | Yes | N/A, no isDeleted |
| utils/supplierRegistry.ts:655 | suppliers.create/update/candidatesFor | supplierAliases.supplierId -> suppliers | Yes, candidateCollector.note | N/A, no isDeleted |
| utils/openingSupplierPosting.ts:35-36 | sourcingPayables.markPaid/recordPartialPayment through posting engine | posting command.sourceId -> vehicleSupplierPayables | Yes | N/A, no isDeleted |
| utils/openingSupplierPosting.ts:48-50 | same entries | payload.openingPaymentId -> openingPayablePayments | Yes | N/A, no isDeleted |
| utils/openingSupplierPosting.ts:118-119 | supplierCostRecoveries.recordReceipt through posting engine | command.sourceId -> supplierCostRecoveryReceipts | Yes | N/A, no isDeleted |
| utils/openingSupplierPosting.ts:124 | same entry | receipt.recoveryId -> supplierCostRecoveries | Yes | N/A, no isDeleted |
| utils/openingSupplierBasis.ts:91,126 via requireOpeningSettlementBasis | supplierCostRecoveries.list/recordReceipt/reverseReceipt; supplierReceivables.outstandingSummary; sourcingPayables settlement/readers | opening obligation.openingBalanceDraftId -> openingBalanceDrafts | Yes, delegated basis checks org, POSTED, allocation/result identity | N/A, no isDeleted |

Non-stored-id reads included in search results: supplierIdentityRepair.ts:130 and supplierRegistry.ts:172 read the supplied organization id itself. Supplier public input ids use requireOwnedRow. suppliers.requireSharedIdentityTarget at 249 validates a new link; mutations update/deactivate/reactivate/addAlias/retireAlias do not follow any further stored document id. supplierConcession and costBearer were read fully: their database access is org-indexed application/recovery queries, with no get/readCached/normalized-id get. costBearer.supplierBearerRefusal checks org and deletion on its supplied vehicle. supplierSettlement and supplierSettlementContainment contain no database reads.

## Writer findings and reachability

| Writer at base | Verification of stored ids |
| --- | --- |
| supplierReceivables.ts:78 openSupplierReceivable insert | Helper itself trusts args. The sole production caller, utils/saleCompletion.ts:2547, uses prepareSaleCompletion: vehicle.orgId at 521 and assertVehicleNotDeleted at 535. The sale is inserted in the same completion transaction. |
| supplierCostRecoveries.ts:74 openSupplierCostRecovery insert | Helper itself trusts expense/vehicle documents. Sole production caller expenses.recordPaidExpenseSideEffects at 329 first calls assertLiveOrgVehicle and assertCostBearerAllowed, whose supplierBearerRefusal checks org/isDeleted. create and markPaid reach it with an expense created for or fetched under the authenticated org. |
| accounting/openingSupplierAllocations.ts:47 insert | OPENING union branch carries neither vehicleId nor expenseId. The supplier is resolved in the org; no native target is stored. |
| supplierReceivables.ts:443,549,561,644 patches | Receipt, dispute/lift, and sale cancellation change money/status/audit fields, never vehicleId/saleId/orgId. Public input row uses requireOwnedRow; cancellation filters by org. |
| supplierCostRecoveries.ts:143,456,589 patches | Expense reversal, receipt, and receipt reversal change status/money/audit, never vehicleId/expenseId/orgId. |
| supplierIdentityRepair.ts:180,202 patches | Supplier id and repair stamp only, never vehicleId/expenseId/orgId. |

Type-aware insert/patch/replace census over non-test non-generated convex TypeScript found the three inserts and the nine patches above, and no replace for these tables. This enumerates current writers, not deleted code or production data. A foreign native vehicleId/expenseId is not reachable through the normal product paths traced here; the exploit fixtures plant corrupt/historical links directly. A target may be deleted later. No production incidence or higher severity is inferred. The helper-level lack of assertions is documented, not widened into a writer rewrite.

## Mechanism and design attack

See adr/2026-11-10-supplier-stored-id-readers.md. The helper lifts navigation's existing ownership/deletion predicate. A thin direct reader and the receivable vehicle projection share its module to fit unchanged formatted-line ceilings. Each direct join still performs one get, and navigation retains its existing cache/headroom read. No global history policy changed. Authorizations and return shapes stay unchanged. An advisory read-only design agent independently flagged the deleted-role edge; it is not a review seat. The real harness reproduces both extra edges before the fix.

Impact map: writers retain ids and existing guards; readers use the predicate; historical bad targets become absent; reversal refuses before ledger writes; idempotency rolls back on refusal; no added spending, ledger postings, schema, indexes, audit shape, UI, migration, backfill, or deploy. Role deletion suppresses notifications. Tests cover unchanged receipt/recovery/ledger/command state on refused reversal. Runtime/platform/production verification remains unavailable here.

## Report-only findings

1. sales has isDeleted, financeApplications does not. ownedSale ignores sale deletion. The schema permits a deleted sale with open supplier obligations, and the reader still counts those obligations because it uses their own statuses/amounts. Normal sales.softDelete refuses COMPLETED sales; cancellation owns supplier teardown, so no ordinary completed-sale deletion path is established here. Historical/corrupt data remains possible. Treating a deleted sale as absent removes THROUGH_DEALERSHIP route/funding facts, switches payable model to OWNED_ON_ACCOUNT_PAYABLE, and without an agreed date changes the rule to TERMS_NOT_RECORDED. A direct receivable loses its application's handover fact and changes to DELIVERY_NOT_RECORDED. Any trigger-derived due date becomes null and aging becomes NO_DUE_DATE, not overdue. An agreed due date still wins, and outstanding amounts remain. This policy was not changed.
2. Vehicle readers require view:vehicles; expenses.list requires view:expenses, and its cost-detail list requires view:expenses plus view:cost_price. The two supplier lists require view:finance plus view:cost_price only. Sourcing page RoleGuard requires view:finance and the client/section checks the finance/cost pair, without vehicle/expense grants. The recovery screen therefore does not already supply those extra grants. Search over app/, components/, apps/mobile/ found no production caller of supplierReceivables.list (listReceiptBankOptions is a different function); direct API access still has the pair-only policy. No permission gate changed.
3. SCRUM-889: source guards exist at this base for journalEntryId and originalEventId references, and reconciliationOrgReferences.scrum889.test.ts exercises them. Harness run and live Jira status are recorded below; code closure is distinct from issue/release closure.

## Five ways this fix could still be wrong

1. A stored-id edge escaped the stated file/pattern census or lives outside its scope. The report names the denominator and transitive opening basis path; independent review still needs to check it.
2. Deleted sale history may need to keep financial obligations due. The facts helpers remain unchanged pending a business ruling, so that broader policy remains open.
3. A shared predicate could suppress valid metadata or change navigation budgets. Existing navigation tests and the absence of new I/O check repository behavior, not cloud byte accounting.
4. A late reversal guard or swallowed error could commit a partial reversal. The tests use real recorded receipts/journals and compare persisted state, while the production pilot gate remains closed.
5. The internal repair/alert entry could be bypassed or a new consumer could use a raw cache document. Internal registered-entry regressions and predicate mutants measure the current paths, not future callers or Convex cloud concurrency.

## Execution results

Red run: 12 tests, 10 behavior failures and 2 existing foreign-check controls passed. Both reversal failures were promise-resolved assertions after actual successful reversal, not a setup refusal. No production edit preceded this run.

| Verification | Result |
| --- | --- |
| New suite on red commit a5067e919b789a8c6a5015639c8075dcbcfbfc1a | 10 failed, 2 passed; 12 literal registrations |
| New suite after fix | 12 passed; pre-commit combined run with recovery-identity and opening-management suites: 73 passed |
| convex/supplierNavigation.scrum869.test.ts | 17 passed; repeated with new suite: 29 passed combined |
| convex/supplierReceivables.test.ts | 21 passed |
| convex/supplierReceivablesReconciliation.scrum869.test.ts | 105 passed |
| convex/supplierCostRecoveries.test.ts | 27 passed |
| convex/supplierIdentityRepair.test.ts | 25 passed |
| convex/supplierDueAlerts.scrum869.test.ts | 80 passed |
| convex/supplierSettlementContainment.test.ts | 12 passed; shipped pilot block unchanged |
| convex/reconciliationOrgReferences.scrum889.test.ts | 43 passed |
| convex/supplierRecoveryIdentity.scrum868.test.ts and convex/openingManagementSettlement.test.ts | Passed in the 73-test pre-commit combined run |
| scripts/tenantWriteGuard.test.ts | 13 passed |
| scripts/intelligence/permissionMatrix.test.ts | 12 passed |
| scripts/intelligence/supplierNavigationDoors.test.ts | Absent on this branch; not counted |
| scripts/regression/scenarioRecord.test.ts | 70 passed; validates all 12 new records |
| node quality/guardrails/check.mjs | Pass; 1072 production files measured, existing 265 import-boundary exceptions unchanged. Formatted nonblank counts: supplierReceivables 727 <= effective base ceiling 730; supplierCostRecoveries 764 <= 765. No ceiling/baseline/allowlist edit. |
| ESLint --max-warnings=0 | All 7 changed TypeScript files passed, individually named. All 15 changed Markdown/JSON files were also supplied with --no-warn-ignored; the repo config supplies no ESLint rules for them. |
| pnpm typecheck | Pass; excludes convex/ as root input, so it is not the Convex backend typecheck (transitive imports may still reach backend types) |
| pnpm typecheck:convex | Pass; tsc -p convex/tsconfig.json --noEmit |
| git diff --check | Pass |

Every Vitest command used explicit named files, --maxWorkers=1 and --testTimeout=120000. refreshRulings.test.ts was not run or counted, per the brief. No client file under app/ or components/ changed. No contract-skew renewal was needed.

SCRUM-889 answer: the stored journal/event org guards are implemented at this base and its 43 harness tests pass, so the cited code defect is closed here.
Jira SCRUM-889 remains To Do with no resolution on the live read. This session did not close it or claim deployment/production verification.

## Differences from the brief and verification corrections

- Two additional soft-delete holes were included from the census: the internal repair vehicle and internal alert role. Their tests call registered internal functions because no public entry reaches them. Making them public merely for testing would weaken the API boundary.
- No new migration/backfill was written or run. Adding a read guard to the existing repair helper prevents it trusting a deleted target; it does not change its pages, writes or rollout driver.
- The actual opening writer is convex/accounting/openingSupplierAllocations.ts, not the root path in the brief.
- A small direct-read adapter and the receivable metadata projection moved into the new helper module because inline wrappers exceeded the unchanged Prettier-based size ceilings. The native recovery variable also removes repeated OPENING discrimination without changing the output contract.
- The first typecheck caught an overly narrow generic constraint in the lifted predicate. Retaining the original runtime property checks fixed it. The first guardrails run caught size growth and was corrected. The first scenario validation rejected a prose seed action; the records now use fixture.seedStoredId and recomputed canonical fingerprints. The initial batched ESLint invocation was collapsed by the Windows pnpm shim into one path; every file was rerun separately and passed.
- One premature overlapping Convex typecheck was explicitly stopped, then rerun to completion, to respect the workstation's two-job cap. It is not counted as a pass.
- PowerShell WriteAllText was used for controlled CRLF edits. No convex-lint edit refusal occurred. No gate, test, threshold, validator shape, schema, index, CI or config was weakened or changed.
- The design attack was advisory only. Independent final review seats, scripted browser E2E, screen audit and explorer swarm were not run in this implementer lane. The coordinator retains review/release ownership. No readiness or certification claim follows from these harness results.
- No Jira/Slack posts, push, deploy, stash, reset, clean or repository-file deletion occurred. Only named task files are staged. No production/showroom records or production organization ids were used.

## Per-check mutation proof

All ten mutants below ran after fix commit 3b5c7c6bc57a373cc35f6096f6dc5b47e92554d1. Each exited 1 with the named behavioral assertions. After each run the changed file was restored with git -C E:\tmp\auto-942 restore --source=HEAD --worktree -- <file>, and the restored bytes were compared after newline normalization. No tests or typechecks ran concurrently with mutants.

| Removed check or bypass | File | Tests that failed |
| --- | --- | --- |
| shared-org-conjunct | convex/utils/supplierDocumentOwnership.ts | receivables list hides a foreign stored vehicle<br>recoveries list hides a foreign stored vehicle<br>recoveries list hides a foreign stored expense<br>receipt reversal refuses a foreign stored sourced vehicle<br>supplier alerts ignore a foreign stored membership role |
| shared-deletion-conjunct | convex/utils/supplierDocumentOwnership.ts | receivables list hides a deleted stored vehicle<br>recoveries list hides a deleted stored vehicle<br>recoveries list hides a deleted stored expense<br>receipt reversal refuses a deleted stored sourced vehicle<br>supplier identity repair ignores a deleted stored vehicle<br>supplier alerts ignore a deleted stored membership role |
| direct-reader-ownership | convex/utils/supplierDocumentOwnership.ts | receivables list hides a foreign stored vehicle<br>receivables list hides a deleted stored vehicle<br>recoveries list hides a foreign stored vehicle<br>recoveries list hides a deleted stored vehicle<br>recoveries list hides a foreign stored expense<br>recoveries list hides a deleted stored expense<br>receipt reversal refuses a foreign stored sourced vehicle<br>receipt reversal refuses a deleted stored sourced vehicle |
| receivable-vehicle-projection | convex/utils/supplierDocumentOwnership.ts | receivables list hides a foreign stored vehicle<br>receivables list hides a deleted stored vehicle |
| recovery-list-vehicle | convex/supplierCostRecoveries.ts | recoveries list hides a foreign stored vehicle<br>recoveries list hides a deleted stored vehicle |
| recovery-list-expense | convex/supplierCostRecoveries.ts | recoveries list hides a foreign stored expense<br>recoveries list hides a deleted stored expense |
| receipt-reversal-vehicle | convex/supplierCostRecoveries.ts | receipt reversal refuses a foreign stored sourced vehicle<br>receipt reversal refuses a deleted stored sourced vehicle |
| alert-role-ownership | convex/supplierDueAlerts.ts | supplier alerts ignore a foreign stored membership role<br>supplier alerts ignore a deleted stored membership role |
| repair-vehicle-deletion | convex/utils/supplierIdentityRepair.ts | supplier identity repair ignores a deleted stored vehicle |
| navigation-owned-target | convex/utils/supplierNavigation.ts | supplier navigation by canonical id > missing target permissions preserve labels without links and foreign or deleted targets disclose no label |

The shared org predicate mutant fails five foreign cases. The shared deletion predicate mutant fails six deleted cases. The direct read adapter mutant fails all eight public-edge cases. The per-site mutants fail their two cells, except the new repair deletion guard, whose one deleted cell fails while its pre-existing foreign guard remains. The navigation mutant fails its existing canonical-id metadata refusal case. These are ten measured mutants, not a claim of exhaustive mutation coverage.

After restoration, the new suite and supplierNavigation.scrum869.test.ts passed together: 2 files, 29 tests, 8.43 seconds. The worktree was clean before recording these results. The Convex subtree at the tested fix commit is eec69b12dcd5c3800410c19fd7f2a32debefd505. The final fix commit amends this report only; that subtree must remain identical. This keeps two commits in the lane while retaining post-commit mutation evidence.

Author self-review: the production diff retains one shared ownership/deletion decision, no new authorization mechanism, no catch-and-commit path, and the existing source refusal before ledger writes. The helpers have real callers and no speculative options. The public tests use real harness documents and real receipts/journals; only the pre-existing pilot-switch test adapter, clock, and rate limiter are mocked. Literal titles, seeded expectations and the red failure output were checked. This is author review, not either independent final review seat.

Next move: coordinator reviews the frozen final head with the required independent seats, then owns any PR, CI and release steps. Nothing was pushed or deployed by this session.
