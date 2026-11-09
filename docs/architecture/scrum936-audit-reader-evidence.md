# SCRUM-936 implementer evidence

Baseline: `0498711b0cd642631a4b5c85a1b60fca01c7257f`.
Failing-first: `e5813b68f46b63546c3b448900efec0efa0241e9`.
Supplemental failing-first: `18992de610caea44ce5503f2362bfc27b36f5225`.
Scope: local branch and serial convex-test. Coordinator owns Jira, GitHub, seats,
CI and release. No production data, deployment, push or merge.

## Writer census

An advisory read-only AST census enumerated every `auditLog(...)` call in
`convex/**/*.ts`, excluding `_generated` and test/spec files, at the baseline.
It found 51 calls, 41 used action types and 44 declared types. The three unused
declared types are INIT_CHART, UPDATE_ACCOUNT and ACKNOWLEDGE_CLOSE_WARNINGS.
The exhaustive reader table derives its action union from the schema, removing
the previous separate handwritten union. Current code cannot add a schema action
without classifying it. Historical rows pass through the same projection.

The following lines refer to the baseline. F means owner or `view:finance`, C
means `canReadVehicleCost` (owner or `view:cost_price`), P means owner or
`view:payroll` or `manage:payroll`. S means `STATEMENT_PERMISSIONS`, the F+C pair.
The audit reader itself requires `manage:finance` in every case.

| Writer (baseline call lines) | Action | Copied content | Dedicated reader and existing permission | Disposition |
| --- | --- | --- | --- | --- |
| accountingCutover.draftOpeningBalance 430 | CREATE_MANUAL_JOURNAL_DRAFT | Line count | listPendingOpeningBalanceDrafts 1023, manage:finance+C, P for employee controls | Opening policy; current summary safe |
| accountingCutover.editOpeningBalanceDraft 487 | EDIT_OPENING_DRAFT | Safe summaries now; historical draft/totals | Same opening reader | Confirmed legacy leak; validated summary allowlist |
| accountingCutover.postOpeningBalanceDraft 711 (both public doors) | POST_MANUAL_JOURNAL | Total in description and after | postedOpeningAllocationReadback 1603, F+C, employee rows P | Confirmed, public writer reproduction |
| accountingCutover.rejectOpeningBalanceDraft 884 | REJECT_MANUAL_JOURNAL | Creator, free reason | Pending opening reader, C/P | Opening policy |
| accountingCutover.signOffCutover 1855 | POST_EVENT | Complete monetary snapshot | listSignOffs 1872, F | Visible to finance reader; distinct resource policy |
| accountingMigration.auditLogForMigration 794 | MIGRATE_TRANSACTION | Scanned/migrated counts | Migration operator, manage:finance | Count producer retains broader audience |
| accountingPeriods.create 381 | CREATE_PERIOD | Fiscal metadata | periods.list/get 259/282, F | Finance policy |
| accountingPeriods.open 421 | OPEN_PERIOD | Fiscal metadata | Same | Finance policy |
| accountingPeriods.close 790 | CLOSE_PERIOD | Checklist and override text | closeChecklist 715, S | Cost policy |
| accountingPeriods.lock 833 | LOCK_PERIOD | Fiscal metadata | periods.list/get, F | Finance policy |
| accountingPeriods.reopen 884 | REOPEN_PERIOD | Period/reason | periods.list/get, F | Finance policy |
| applications.correctExpectedPayment 4052 | CORRECT_EXPECTED_PAYMENT | Methods, dates, cheque ids, reason | applications.get 1550: view:sales for method/date; collections.listCheques 964: F for cheque ids and cancellationReason | Field projection preserves each reader tier; confirmed cheque evidence leak to sales-only audit viewers |
| applications.attestChequeFace 4126 | ATTEST_CHEQUE_FACE | Cheque amount, currency, note | collections.listCheques 964 and hydrateCheque 430: F, without view:sales | Cleared by real public writer/control: finance-only reader already sees the same amount/id/note |
| applications.setSupplierSettlementRoute 4263 | SET_SUPPLIER_SETTLEMENT_ROUTE | Route and supplier label | applications.get, view:sales, OPEN route | Sales policy |
| applications.returnFinanceDisbursementCheque 5540 | RETURN_FINANCE_DISBURSEMENT_CHEQUE | Disbursement amount and source ids | applications.get 1550: view:sales, then financeApplicationProjection 276: F | Application base gate and finance tier both retained |
| applications.confirmSupplierDisbursement 5838 | CONFIRM_SUPPLIER_DISBURSEMENT | Amount, approval and discrepancy | applications.get: view:sales, then financeApplicationProjection 316: F | Confirmed retained-row application base gate leak |
| applications.amendSupplierDisbursementAdvice 6094 | AMEND_SUPPLIER_DISBURSEMENT_ADVICE | Prior/current amount, reference and reason | Same, view:sales plus F | Application base gate and finance tier both retained |
| bankReconciliation.ignoreLine 312 | IGNORE_BANK_STATEMENT_LINE | Amount, bank text, reason | listStatementLines 79, F | Finance-only reader already sees this amount; not a cost leak |
| chartOfAccounts.repairMissingSystemAccounts 788 | REPAIR_MISSING_SYSTEM_ACCOUNTS | Account codes/summary | chart.list 618, F | No monetary copy |
| chartOfAccounts.confirmSystemAccountAdoption 1065 | RESOLVE_SYSTEM_ACCOUNT_ADOPTION | Account codes/system keys | Adoption reader 1001, F | No monetary copy |
| dealCommissions.addLine 275 | ADD_DEAL_COMMISSION_LINE | Employee/line/sale ids, amount | forSale 123, view:commissions | Confirmed public writer/read leak |
| dealCommissions.removeLine 330 | REMOVE_DEAL_COMMISSION_LINE | Employee/amount in before and description | Same | Confirmed public writer/read leak |
| dealUnwind.startDealUnwind 289 | DEAL_UNWIND_STARTED | Remittance, ids, free reason | unwindStatus 967/1020 requires view:sales, then F or actor; free text F | Full payload uses view:sales+F; actor tier retains permitted remittance under the same base gate |
| dealUnwind.recordDealUnwindForwardReturn 394 | DEAL_UNWIND_FORWARD_RETURNED | Forward reference/state | Same, full detail F | Finance/actor projection |
| dealUnwind.finishDealUnwind 788 | DEAL_UNWIND_REMITTANCE_REFUNDED | Amount and reversed ids | Same | Finance/actor projection |
| dealUnwind.finishDealUnwind 812 | DEAL_UNWIND_COMPLETED | Reference, disposition, inspection text | Same, text F | Finance/actor projection |
| dealUnwind.abandonDealUnwind 886 | DEAL_UNWIND_ABANDONED | Reason and unwind id | Same, reason F | Finance policy |
| deposits.allocateToVehicles 741 | ALLOCATE_DEPOSIT | Vehicle allocations and remainder | quoteAllocation 1096, view:sales | Sales policy |
| deposits.resolveReleasedAllocation 1071 | RESOLVE_DEPOSIT_ALLOCATION | Amount/vehicle/refund details | Same | Sales policy |
| deposits.releaseVehicleAllocation 1296 | RESOLVE_DEPOSIT_ALLOCATION | Amount/quote/reason | Same | Sales policy |
| financialAudit.createManualJournal 427 | CREATE_MANUAL_JOURNAL_DRAFT | Memo and count | listPendingManualJournals 647, manage:finance only | Broad manual-draft policy, positive control |
| financialAudit.approveManualJournal 584 | POST_MANUAL_JOURNAL | Total, draft id and memo | accountingLedger.listJournalEntries/getJournalEntry 90/194, S | Confirmed retained-row sibling; public pilot posting remains blocked |
| financialAudit.rejectManualJournal 632 | REJECT_MANUAL_JOURNAL | Memo/reason/creator | Manual-draft audience, manage:finance | Resource-specific policy |
| migrateConsignedSaleBasis.correctOneSale 426 | MIGRATE_TRANSACTION | Revenue, COGS, margin, journal ids | accountingLedger.getJournalEntry 194, S; sales.get cost projection | Confirmed retained-payload disclosure, internal writer not executed |
| openingBalanceMaintenance.requestVoid 81 | REQUEST_OPENING_VOID | Reason/journal id | status 166, manage:finance+C and manage:payroll for employee controls | Opening policy |
| openingBalanceMaintenance.approveVoid 125 | APPROVE_OPENING_VOID | Requester/reason/reversal id | Same | Opening policy |
| prepaidExpenses.applyScheduleCorrection 1042 | CORRECT_PREPAID_SCHEDULE | Refund/write-off/VAT/reason | listCorrections 1385, F | Finance-only reader already sees amounts |
| prepaidExpenses.correctSchedule 1213 | REQUEST_PREPAID_CORRECTION | Refund/write-off/reason | listPendingCorrectionRequests 1244, F | Ordinary finance |
| prepaidExpenses.approveCorrectionRequest 1314 | APPROVE_PREPAID_CORRECTION | Write-off/reason | Same | Ordinary finance |
| prepaidExpenses.rejectCorrectionRequest 1361 | REJECT_PREPAID_CORRECTION | Write-off/reason | Same | Ordinary finance |
| sales.setCommissionAmount 2317 | SET_COMMISSION_AMOUNT | Before/new commission and delta | dealCommissions.forSale, view:commissions; sales.get 237 and saleRowProjection 113, view:sales PUBLIC_LEGACY | Confirmed public leak; preserve either existing reader grant |
| sourcingPayables.markPaid 513 | ALLOCATE_PAYMENT | Entitlement/payment amounts | list/get 136/343, S | Same cost-protected class |
| sourcingPayables.recordPayment 692 | ALLOCATE_PAYMENT | Entitlement/payment amounts | Same | Same cost-protected class |
| sourcingPayables.setDisputed 805 | SET_SUPPLIER_DISPUTE | Status/supplier/free reason | Same | Cost-protected text |
| supplierCostRecoveries.recordReceipt 471 | ALLOCATE_PAYMENT | Recovery receipt/cumulative amount | list/listReceipts 212/275, S | Confirmed retained-payload leak; pilot writer not executed |
| supplierCostRecoveries.reverseReceipt 604 | REVERSE_ALLOCATION | Receipt/cumulative amount/reason | Same | Confirmed retained-payload sibling |
| supplierReceivables.recordReceipt 483 | ALLOCATE_PAYMENT | Consigned claim/payment amounts | list 135, S | Same cost-protected class |
| supplierReceivables.setDisputed 582 | SET_SUPPLIER_DISPUTE | Status/supplier/reason | Same | Cost-protected text |
| accounting/postingEngine.postAccountingEvent 757 | POST_EVENT | Journal/count plus source ids | accountingLedger, S | Cost policy except cutover sign-off resource |
| accounting/reversals.reverseAccountingEvent 404 | REVERSE_EVENT | Journal/event/source ids and reason | accountingLedger, S | Cost policy |
| utils/saleCancellation.recordWorstAuthorityOutcome 671 | SETTLE_COMMITMENT_AUTHORITY | Commitment/vehicle outcome text | sales.getSaleTrail 531, view:sales | Sales policy |

The census is an enumeration of current source, not production history. Writer
descriptions for opening totals, commissions, consigned restatement and supplier
payments/recoveries now omit generated monetary operands. Structured authorized
evidence remains. New receipt reversal reasons move into the structured payload.

## Policy and historical data

One projection follows the shared four-branch query, after filtering/limiting.
Restricted results are an explicit metadata allowlist, fixed description,
withheld marker and safe counts. Payload entity ids, arbitrary text and command
keys are omitted. The resource type and audit-event identity remain visible. Protected source
resource ids are replaced with `WITHHELD`. The SCRUM-850 test now requires this
stronger id exclusion. Opening edit summaries preserve #792's versions/counts/kinds/date/currency
contract through a validated allowlist, rather than returning old snapshots.

P and the maintenance reader's distinct manage-payroll predicate are extracted
without changing their existing grants. Untyped historical edit payloads without
a provable payroll audience stay withheld even after an employee is removed
from the current draft. The shared legacy
detector checks allocation kinds and employee-control accounts. A new indexed
`openingBalanceDrafts.by_org_journal` lookup binds a posted opening to its draft
without scanning history. Payroll-sensitive opening totals follow the opening
readback's P gate. The general ledger's cost-only reader currently has a broader
audience; this change does not alter that separate API.

The tracked `components/`, `app/`, `apps/` consumer inventory contains no caller
of `financialAudit.listAuditLog`. `app/admin/audit/page.tsx:19` reads the separate
`adminAudit.listAuditLog`. UI files, UI text and translations are unchanged.

## Reproductions and controls

The 12 primary literal scenario tests in `financialAudit.scrum936.test.ts` fail
at the first failing-first commit. Its 13th test checks schema/table classification
equality. The supplemental checkpoint adds event-count and unwind-actor parity
tests. Against its committed production sources, all 15 tests fail.
The initial run had fixture errors, which were corrected before that commit.
The committed red run reports 13 failed tests, each on disclosure or missing
classification. Public opening posting tests cover direct and independent
approval, each with one vehicle or one employee advance. Legacy full snapshots,
total-only edits and posted manual journals are seeded with the retained shape.
Commission tests execute the public add/remove/set writers. Migration/recovery
tests seed historical payloads and query the public reader. They do not execute
internal migrations or open disabled receipt doors.

Every leak test exercises default, actor, action and date query branches, source
reader refusal or withholding, original-row owner visibility and unchanged stored
evidence. Explicit non-owner grants restore the full row. Employee posting tests
also prove that cost permission alone does not lift opening payroll withholding.
The pending-manual-draft control proves that ordinary finance detail is retained
where its dedicated reader already serves it.

## Validation

The initial production-source checkpoint is `371a647993f9f4e02becddfdb459614bdf78bf93`.
The final mixed-reader production-source checkpoint is
`26fe73f57f621a571097d4c75c9cc526b4d0b677`. The following broad-suite results
were measured before the application and cheque refinements; the later focused
reruns and final-head proof are listed separately below.
Initial baseline source notes are committed at `715e1a47e`.

| Check | Result |
| --- | --- |
| First failing-first checkpoint | 13 failed tests at e5813b68f; intended disclosure/classification failures |
| Supplemental checkpoint against its committed production sources | 15 failed tests at 18992de61 |
| Named affected backend suites, initial checkpoint | 67 completed suites, 1,920 tests green after the Phase 10 recheck |
| Additional broad openingClosureReaders.scrum858 suite | INCOMPLETE / failed local verification; interrupted for the machine CPU bound, no threshold or test change |
| Regression validators and required guards | Initial nine-file run: seven passed; tenant guard hook timed out; refreshRulings failed before collection |
| Tenant write guard recheck | 13 passed on unchanged source |
| economicCommandCensus | Passed in the nine-file run |
| refreshRulings recheck | FAIL, zero tests; Rolldown prepends imports before the existing hashbang in refreshRulings.mjs |
| pnpm typecheck | Exit 0 |
| pnpm typecheck:convex | Exit 0 |
| ESLint, all 16 touched TS files | Exit 0, zero errors, one existing unused `user` warning at sales.ts:1408 |
| ESLint, final financialAudit/test/Phase 10 edits | Exit 0, no diagnostics |
| Contract call identity | Exit 0, 945 entries matched; backend finding identity was not measured |
| Contract renewal source freshness after notes commit | Exit 0, 945 checked, zero stale/malformed/missing |
| Source restoration after mutants | 18/18 clean checks after `git checkout HEAD -- <file>` |

The root typecheck excludes convex, apps, packages, dealer-worker and test-utils
as compiler roots. The separate Convex config includes convex and test-utils,
excluding _generated as roots; imported generated declarations remain dependencies.
Neither command is a mobile, shared-package or worker standalone typecheck.

The refreshRulings test/module and their dependency/config pins are unchanged
from the base. The protected test file remains unmodified and unstaged. This
failure is not waived or relabeled as passing. No live Jira refresh was attempted.
The broad SCRUM-858 file is outside the required filename suites selected for
this fix; it entered the broader caller sweep. Its large synthetic journal
fixtures exceeded the thermal budget. Partial execution is not a passed check.

The original Phase 10 assertion expected a protected journal id before a cost
grant. It now requires withholding, then grants cost access and retains the
original id assertion plus a public ledger read of the balanced 3,000/3,000
journal. No financial assertion, permission gate, timeout or threshold was weakened.

### Named suite inventory

Scope: tracked convex test filenames beginning with financialAudit,
accountingCutover, dealCommissions, sales, supplierCostRecoveries,
migrateConsignedSaleBasis, sourcingPayables or supplierReceivables; the SCRUM-850
files; and the broader financialAudit/accountingCutover caller sweep. This is a
local source inventory, not the full repository suite or CI.

| Named file | Result |
| --- | --- |
| `convex/accountingCutoverExactness.scrum850.test.ts` | PASS |
| `convex/accountingCutoverLegacyExactness.scrum850.test.ts` | PASS |
| `convex/accountingGenericReversalAuthority.test.ts` | PASS |
| `convex/accountingMigrationRetirement.test.ts` | PASS |
| `convex/accountingPhase10.test.ts` | PASS after strengthened contract recheck (10 tests) |
| `convex/accountingPhase17.test.ts` | PASS |
| `convex/accountingPhase18.test.ts` | PASS |
| `convex/accountingPhase7.test.ts` | PASS |
| `convex/accountingPhase9.test.ts` | PASS |
| `convex/accountingReleaseRehearsal.test.ts` | PASS |
| `convex/accountingSourceFamilyRetired.test.ts` | PASS |
| `convex/adminOrgs.test.ts` | PASS |
| `convex/applications.test.ts` | PASS |
| `convex/bankReconciliation.test.ts` | PASS |
| `convex/chartOfAccounts.management.test.ts` | PASS |
| `convex/claimsRetirement.test.ts` | PASS |
| `convex/commitmentRestorationSpine.test.ts` | PASS |
| `convex/consignedSaleCostAccessRule.scrum886.test.ts` | PASS |
| `convex/costDisclosure.scrum902f.test.ts` | PASS |
| `convex/costReaders.scrum902d.test.ts` | PASS |
| `convex/dealCommissions.test.ts` | PASS |
| `convex/dealCommissionsPilot.test.ts` | PASS |
| `convex/dealUnwind.test.ts` | PASS |
| `convex/financeDisbursementChequeReturn.test.ts` | PASS |
| `convex/financedConsignedSettlement.test.ts` | PASS |
| `convex/financialAudit.scrum936.test.ts` | PASS |
| `convex/manualJournalAccountingDate.test.ts` | PASS |
| `convex/manualJournalsPilotOff.scrum795.test.ts` | PASS |
| `convex/manualJournalsPilotOffControl.scrum795.test.ts` | PASS |
| `convex/migrateConsignedSaleBasis.test.ts` | PASS |
| `convex/migrateConsignedSaleBasisProdShape.test.ts` | PASS |
| `convex/multiVehicleDepositAllocation.test.ts` | PASS |
| `convex/openingAllocatedAdvances.test.ts` | PASS |
| `convex/openingAllocatedPartners.test.ts` | PASS |
| `convex/openingAllocatedPrepaids.test.ts` | PASS |
| `convex/openingAllocatedReceivables.test.ts` | PASS |
| `convex/openingBalanceBankIdentity.test.ts` | PASS |
| `convex/openingBalanceIndexReads.test.ts` | PASS |
| `convex/openingBalanceMaintenance.scrum850.test.ts` | PASS |
| `convex/openingBankReconciliation.scrum858.test.ts` | PASS |
| `convex/openingClosureReaders.scrum858.test.ts` | INCOMPLETE (CPU bound) |
| `convex/openingCommissionPayroll.test.ts` | PASS |
| `convex/openingCommissionReadBudget.test.ts` | PASS |
| `convex/openingInventoryCap.scrum858.test.ts` | PASS |
| `convex/openingManagementSettlement.test.ts` | PASS |
| `convex/openingNamedDeposits.scrum858.test.ts` | PASS |
| `convex/openingPrepaidConsumerReports.test.ts` | PASS |
| `convex/openingPrepaidRounding.scrum858.test.ts` | PASS |
| `convex/openingRehearsalPublicComposite.test.ts` | PASS |
| `convex/openingRemainingFamilies.test.ts` | PASS |
| `convex/openingReversalDoors.scrum858.test.ts` | PASS |
| `convex/openingStockCashBankReplay.test.ts` | PASS |
| `convex/openingSupplierLiabilityReplay.test.ts` | PASS |
| `convex/openingSuspense.scrum858.test.ts` | PASS |
| `convex/orgDeletionManifestRatchet.scrum563.test.ts` | PASS |
| `convex/prepaidExpenses.test.ts` | PASS |
| `convex/sales.test.ts` | PASS |
| `convex/salesCommissionEntry.test.ts` | PASS |
| `convex/salesListPagination.test.ts` | PASS |
| `convex/salesTemplateMoneyDoors.test.ts` | PASS |
| `convex/scrum486Certification.test.ts` | PASS |
| `convex/sourcingPayables.test.ts` | PASS |
| `convex/supplierCostRecoveries.test.ts` | PASS |
| `convex/supplierPayablesReconciliation.scrum876.opening.test.ts` | PASS |
| `convex/supplierReceivables.test.ts` | PASS |
| `convex/supplierReceivablesReconciliation.scrum869.test.ts` | PASS |
| `convex/supplierSettlementAudit.test.ts` | PASS |
| `convex/validations/sales.test.ts` | PASS |
All Vitest commands name files and use `--maxWorkers=1`. No Playwright, watchers,
Convex deploy, production write or review-evidence JSON is used.

Sources and the rejected writer-only alternative are in the
[ADR](../adr/2026-11-09-financial-audit-reader-permissions.md).


### Regression validators

All commands used named files and `--maxWorkers=1`.

| File | Result |
| --- | --- |
| scripts/regression/scenarioRecord.test.ts | PASS; final new-record recheck recorded below |
| scripts/regression/implFixture.test.ts | PASS; final new-record recheck recorded below |
| scripts/regression/localExecution.test.ts | PASS |
| scripts/regression/pilotDoorAnalysis.test.ts | PASS |
| scripts/regression/pilotDoorInventory.test.ts | PASS |
| scripts/regression/prRunner.test.ts | PASS |
| scripts/regression/refreshRulings.test.ts | FAIL before collection; repeated unchanged |
| scripts/tenantWriteGuard.test.ts | PASS, 13 tests on unchanged rerun |
| scripts/economicCommandCensus.test.ts | PASS |

### Initial mutation results

The four branch mutants bypassed the shared projection only for that branch.
Every mutation ran a named suite with one worker. Every source was restored with
`git checkout HEAD -- <file>`, followed by `git status --porcelain <file>` with
empty output. Every mutant produced failed tests rather than a worker startup or
parse failure. The opening-summary mutation used the SCRUM-850 maintenance suite;
the others used financialAudit.scrum936.test.ts.

| Mutant | Failed tests | Restored clean |
| --- | --- | --- |
| `branch:actor` (branch-actor) | 14 | Yes |
| `branch:action` (branch-action) | 14 | Yes |
| `branch:date` (branch-date) | 14 | Yes |
| `branch:default` (branch-default) | 14 | Yes |
| `classification` (missing-post-journal-classification) | 6 | Yes |
| `new-action` (new-unclassified-action) | 1 | Yes |
| `mayReadOpeningAudit` (opening-policy-bypass) | 3 | Yes |
| `mayReadJournalAudit` (journal-policy-bypass) | 5 | Yes |
| `mayReadAuditDetails` (all-details-bypass) | 14 | Yes |
| `auditObject` (object-projection-missing) | 7 | Yes |
| `openingAuditSummary` (opening-summary-missing) | 4 | Yes |
| `isOpeningAuditSummary` (historical-summary-trust) | 1 | Yes |
| `unwindActorAuditAmounts` (unwind-amounts-missing) | 1 | Yes |
| `projectAuditRow` (row-projection-bypass) | 14 | Yes |
| `canReadOpeningPayroll` (payroll-read-grant-denied) | 4 | Yes |
| `canManageOpeningPayroll` (payroll-maintenance-overgrant) | 2 | Yes |
| `containsEmployeeAdvanceControl` (payroll-source-missed) | 2 | Yes |
| `mayReadUnwindActorEvidence` (unwind-actor-grant-denied) | 1 | Yes |


Twelve helper functions were mutated explicitly: mayReadOpeningAudit,
mayReadJournalAudit, mayReadAuditDetails, auditObject, openingAuditSummary,
isOpeningAuditSummary, unwindActorAuditAmounts, projectAuditRow,
canReadOpeningPayroll, canManageOpeningPayroll, containsEmployeeAdvanceControl,
and mayReadUnwindActorEvidence. The other six mutations cover branch admission,
missing posted-journal classification and a newly unclassified schema action.
There are no surviving mutants in this set.

### Baseline review and evidence limits

The first renewal check refused 62 stale entries. Their 22 referenced exports
retain identical argument and explicit return validators at the PR base and the
implementation head, after line-ending normalization. Eighteen exported
declarations are unchanged. The four changed declarations are
sourcingPayables.markPaid, dealUnwind.recordDealUnwindForwardReturn,
dealCommissions.addLine and supplierCostRecoveries.recordReceipt. Their changes
are amount-free audit descriptions or the equivalent shared permission predicate.

Only those 62 entries received appended renewal notes in 15 shards. Comparing
parsed entries before and after confirms that all other fields and prior renewal
text are unchanged. No write mode, expiry change, fingerprint change, extractor
change, issue change or UNKNOWN-to-PASS conversion was used. The normal read-only
command then checked all 945 entries with zero stale evidence. This measures
source/blob attribution, not live contract compatibility or runtime correctness.

The initial fourteen SCRUM-761 records cover fourteen behavioral tests, plus the separate
classification test, under `SCRUM-936-audit-reader-confidentiality` in the SCRUM-486 matrix. The existing legacy-edit and direct-employee records also name the mutable
historical employee snapshot and payroll-view-without-maintenance-authority
void controls. Their literal tests are present at the
supplemental failing-first checkpoint.

No Playwright, screen rendering, explorer swarm, real-backend rehearsal, platform
OCC/limits test, live function-spec comparison, production-data prevalence query,
Jira/GitHub/Slack update, formal seat, CI, deployment, push or merge was performed.
The two scoped advisory reviewers ran no tests and issued no certification. The
coordinator owns the remaining review and runtime gates. The existing large
DealCockpit baseline shard exceeded the commit hook's secret-scan size cap; no
full secret-scan coverage is claimed.

Graft generated .gitignore/.ignore changes. They remain unstaged, along with
local .s936-* logs and proof helpers. The generated API declaration, protected
refreshRulings test and test-results tree were never staged.


A restored proof run initially passed all 63 backend tests and the implementation
fixture check, but the record validator rejected two additional records that
reused an existing test registration and contained prose tokens. Their controls
were consolidated into the original legacy-edit and direct-employee records,
with short tokens and the supplemental failing-first SHA. The validator was not
changed or weakened. Final restored results are recorded after the rerun.


### Initial restored proof and scenario inventory

After source restoration, both backend files passed all 63 tests. The corrected
record and implementation-fixture validators then passed all 71 tests. The
initial combined run had one record-format failure, which was corrected by
consolidating duplicate registrations, not by weakening the validator. A final
AST recount over 371 tracked production TypeScript files in convex, excluding
_generated and test/spec files, confirms 51 auditLog calls and 41 used action
types. The schema/table test covers all 44 declared action types.

| Scenario record | Literal test | Failing-first commit |
| --- | --- | --- |
| `scrum936-application-reader-gates` | SCRUM-936 application audit details inherit both sales and finance read gates | `c941eba60f4c1125e78775b329702a50d5cd57ef` |
| `scrum936-cheque-face-reader-control` | SCRUM-936 cheque face audit remains visible to its dedicated finance-only reader | `9956ef3e01b055416dd920bce89aa85210949c8f` |
| `scrum936-commission-add` | SCRUM-936 adding a deal commission audit inherits the commission reader gate | `e5813b68f46b63546c3b448900efec0efa0241e9` |
| `scrum936-commission-remove` | SCRUM-936 removing a deal commission audit inherits the commission reader gate | `e5813b68f46b63546c3b448900efec0efa0241e9` |
| `scrum936-commission-set` | SCRUM-936 setting a sale commission audit inherits its dedicated reader gate | `e5813b68f46b63546c3b448900efec0efa0241e9` |
| `scrum936-event-line-count` | SCRUM-936 restricted posted events retain their line count without source text | `18992de610caea44ce5503f2362bfc27b36f5225` |
| `scrum936-expected-payment-reader-tiers` | SCRUM-936 expected payment audit separates open method metadata from finance cheque evidence | `9956ef3e01b055416dd920bce89aa85210949c8f` |
| `scrum936-legacy-cost-receipt` | SCRUM-936 historical supplier cost receipt audit inherits cost reader gates | `e5813b68f46b63546c3b448900efec0efa0241e9` |
| `scrum936-legacy-cost-reversal` | SCRUM-936 historical supplier cost receipt reversal audit inherits cost reader gates | `e5813b68f46b63546c3b448900efec0efa0241e9` |
| `scrum936-legacy-manual-post` | SCRUM-936 legacy posted manual journal totals and memo are withheld while pilot posting stays blocked | `e5813b68f46b63546c3b448900efec0efa0241e9` |
| `scrum936-legacy-migration-cogs` | SCRUM-936 historical consigned migration COGS audit inherits cost reader gates | `e5813b68f46b63546c3b448900efec0efa0241e9` |
| `scrum936-legacy-opening-edit` | SCRUM-936 legacy opening edit draft and total copies are projected in every branch | `18992de610caea44ce5503f2362bfc27b36f5225` |
| `scrum936-post-opening-approve-employee` | SCRUM-936 approved singleton employee posting audit inherits payroll withholding | `e5813b68f46b63546c3b448900efec0efa0241e9` |
| `scrum936-post-opening-approve-vehicle` | SCRUM-936 approved singleton vehicle posting audit inherits cost withholding | `e5813b68f46b63546c3b448900efec0efa0241e9` |
| `scrum936-post-opening-direct-employee` | SCRUM-936 owner-direct singleton employee posting audit inherits payroll withholding | `18992de610caea44ce5503f2362bfc27b36f5225` |
| `scrum936-post-opening-direct-vehicle` | SCRUM-936 owner-direct singleton vehicle posting audit inherits cost withholding | `e5813b68f46b63546c3b448900efec0efa0241e9` |
| `scrum936-unwind-actor-parity` | SCRUM-936 unwind actors retain permitted remittance amounts while finance text stays withheld | `18992de610caea44ce5503f2362bfc27b36f5225` |

### Final mixed-reader controls and proof boundaries

The application base-gate checkpoint `c941eba60f4c1125e78775b329702a50d5cd57ef`
reported **1 failed, 15 passed**. Its initial action set also included a synthetic
cheque attestation payload. Source review cleared that action: collections already
exposes the attestation amount, id and note under view:finance alone. That action
was removed from the application-gate case and replaced by a real public-writer
positive control. The three supplier-disbursement/advice actions retain the
application reader's view:sales base gate plus finance tier. The unwind full and
actor tiers also retain view:sales.

The real cheque writer controls at
`9956ef3e01b055416dd920bce89aa85210949c8f` reported **2 failed, 16 passed**:
the first exposed an over-restrictive attestation classification; the second
exposed cheque ids and correction reason to a sales-only audit viewer. The fix
preserves finance-only attestation visibility and projects expected-payment
method/date for sales readers separately from cheque ids/reason for finance
readers. Both tests exercise all four audit branches, public source-reader
controls, authorized full-row controls, and unchanged stored audit evidence.

After that fix, seven named files passed **307 tests**:
financialAudit.scrum936, openingBalanceMaintenance.scrum850, accountingPhase7,
accountingPhase10, accountingPhase17, applications and dealUnwind. This is the
latest production-source checkpoint, `26fe73f57f621a571097d4c75c9cc526b4d0b677`.
The broad 67-suite/1,920-test result above belongs to the earlier checkpoint;
it is not claimed as a complete rerun against the latest production source.

The final seventeen scenario records pass scenarioRecord and implFixture:
**2 files, 71 tests passed**. The cheque-face record uses numeric 12500 for the
canonical face amount; no validator changed. Both root and Convex typechecks
were rerun on the latest production source and exited 0. The latest financialAudit
and test ESLint run exited 0 with no diagnostics. The unchanged-source guard
and broader validator results, including the two explicit limitations, remain
as itemized above.

The scoped advisory recheck closed its application/PDC/unwind findings statically
at that source checkpoint. It ran no tests, edited no files and is not a formal
seat or runtime certification.

### Final production-source mutation replay

Each of the following nineteen mutations produced actual failed tests and exit 1.
Each was restored by `git checkout HEAD -- <file>`, then proved clean by empty
`git status --porcelain <file>` output. The four branch and missing-classification
mutants are repeated here against the latest production source. Thirteen helper
functions are covered, including expectedPaymentAuditSummary. No assertion,
timeout, authz gate or pilot switch was weakened. No mutant survived.

| Mutant | Failed tests | Restore clean |
| --- | --- | --- |
| branch-actor (`branch:actor`) | 17 | Yes |
| branch-action (`branch:action`) | 17 | Yes |
| branch-date (`branch:date`) | 17 | Yes |
| branch-default (`branch:default`) | 17 | Yes |
| missing-post-journal-classification (`classification`) | 6 | Yes |
| new-unclassified-action (`new-action`) | 1 | Yes |
| opening-policy-bypass (`mayReadOpeningAudit`) | 3 | Yes |
| journal-policy-bypass (`mayReadJournalAudit`) | 5 | Yes |
| all-details-bypass (`mayReadAuditDetails`) | 17 | Yes |
| object-projection-missing (`auditObject`) | 8 | Yes |
| opening-summary-missing (`openingAuditSummary`) | 4 | Yes |
| historical-summary-trust (`isOpeningAuditSummary`) | 1 | Yes |
| unwind-amounts-missing (`unwindActorAuditAmounts`) | 1 | Yes |
| row-projection-bypass (`projectAuditRow`) | 17 | Yes |
| payroll-read-grant-denied (`canReadOpeningPayroll`) | 4 | Yes |
| payroll-maintenance-overgrant (`canManageOpeningPayroll`) | 2 | Yes |
| payroll-source-missed (`containsEmployeeAdvanceControl`) | 2 | Yes |
| unwind-actor-grant-denied (`mayReadUnwindActorEvidence`) | 1 | Yes |
| expected-payment-summary-missing (`expectedPaymentAuditSummary`) | 1 | Yes |

### Final contract note renewal

The latest financialAudit reader changes made three entries for
financialAudit:createManualJournal stale. Its entire exported command declaration,
argument validator and explicit return validator are unchanged from the PR base
after normalizing line endings. Only those three existing entries received further
appended source/blob notes in the ManualJournalTab shard. All non-renewal fields
and each prior renewal string are unchanged. This supplements the earlier notes
on 62 unique entries; it does not add a waiver, extend an expiry or turn UNKNOWN
into PASS. No baseline write mode or extractor change was used.

### Restored final-source checks

After all nineteen mutants were restored, the combined named proof passed
**4 files, 137 tests**: financialAudit.scrum936 (18),
openingBalanceMaintenance.scrum850 (48), scenarioRecord (70), and implFixture (1).
The required tenantWriteGuard and economicCommandCensus rerun passed
**2 files, 32 tests**. ESLint on all sixteen touched TypeScript files exited 0
with zero errors and the same pre-existing sales.ts:1408 unused-variable warning.
The final-head rerun and read-only contract command outputs accompany the
implementer handoff; no CI or release gate pass is claimed by these local checks.

Comparing every edited baseline shard against the PR base confirms fifteen
shards, sixty-two unique entries with appended notes, zero changed non-renewal
fields, unchanged shard metadata, and every prior renewal string preserved.
The three latest notes append to entries already among those sixty-two.
