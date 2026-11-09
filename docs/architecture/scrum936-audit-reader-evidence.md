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
| applications.correctExpectedPayment 4052 | CORRECT_EXPECTED_PAYMENT | Methods, dates, cheque ids, reason | applications.get 1550, view:sales; these fields OPEN | Sales policy |
| applications.attestChequeFace 4126 | ATTEST_CHEQUE_FACE | Cheque amount, currency, note | Application/payment finance projection, F | Ordinary finance |
| applications.setSupplierSettlementRoute 4263 | SET_SUPPLIER_SETTLEMENT_ROUTE | Route and supplier label | applications.get, view:sales, OPEN route | Sales policy |
| applications.returnFinanceDisbursementCheque 5540 | RETURN_FINANCE_DISBURSEMENT_CHEQUE | Disbursement amount and source ids | financeApplicationProjection 276, F | Ordinary finance |
| applications.confirmSupplierDisbursement 5838 | CONFIRM_SUPPLIER_DISBURSEMENT | Amount, approval and discrepancy | financeApplicationProjection 316, F | Ordinary finance |
| applications.amendSupplierDisbursementAdvice 6094 | AMEND_SUPPLIER_DISBURSEMENT_ADVICE | Prior/current amount, reference and reason | Same, F | Ordinary finance |
| bankReconciliation.ignoreLine 312 | IGNORE_BANK_STATEMENT_LINE | Amount, bank text, reason | listStatementLines 79, F | Finance-only reader already sees this amount; not a cost leak |
| chartOfAccounts.repairMissingSystemAccounts 788 | REPAIR_MISSING_SYSTEM_ACCOUNTS | Account codes/summary | chart.list 618, F | No monetary copy |
| chartOfAccounts.confirmSystemAccountAdoption 1065 | RESOLVE_SYSTEM_ACCOUNT_ADOPTION | Account codes/system keys | Adoption reader 1001, F | No monetary copy |
| dealCommissions.addLine 275 | ADD_DEAL_COMMISSION_LINE | Employee/line/sale ids, amount | forSale 123, view:commissions | Confirmed public writer/read leak |
| dealCommissions.removeLine 330 | REMOVE_DEAL_COMMISSION_LINE | Employee/amount in before and description | Same | Confirmed public writer/read leak |
| dealUnwind.startDealUnwind 289 | DEAL_UNWIND_STARTED | Remittance, ids, free reason | unwindStatus 967/1020, F or actor; free text F | Full payload uses F; actor tier retains permitted remittance |
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

Final commands, results and mutation evidence are appended after execution.
All Vitest commands name files and use `--maxWorkers=1`. No Playwright, watchers,
Convex deploy, production write or review-evidence JSON is used.

Sources and the rejected writer-only alternative are in the
[ADR](../adr/2026-11-09-financial-audit-reader-permissions.md).
