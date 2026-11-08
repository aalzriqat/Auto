# SCRUM-850 review round 2

Implementer evidence, 2026-11-08. Worktree `E:\tmp\auto-850`, branch
`claude/scrum850-opening-correction`. Starting commit
`09f74e3a4fb1b66644b614e5df91ac7e8c865d67`. The coordinator owns Jira, GitHub
and independent re-review. No push, deployment, production access or backend
browser run. Existing `.gitignore`, `.ignore` and
`scripts/regression/refreshRulings.test.ts` edits are excluded from staging.

## Independent reproduction and decisions

All three findings are validated in the local serial harness. R1 violates
identity under an unchanged edit; F1 violates reader neutrality of an exact
governed void pair; F2 violates approval of the content actually reviewed.

R1: the actual mounted editor submitted `9007199254740990` instead of
`9007199254740991` JOD minor units. The registered-backend allocation round trip
rehydrated admitted `9007199254740812` as `9007199254740813`. Both GL sides can
change equally, so balancing is insufficient. The existing
`lib/financeFeeTemplateForm.ts:formatMinorAsMajor` slices integer decimal text.
It is reused without changing `fromMinorUnits` or its numeric contract.
`formatExactMinorAmount` in `lib/moneyDisplay.ts` is also integer based but
inserts grouping separators, which the editable money parser rejects. Moving
the formatter into another module would add unnecessary production scope.
Relative imports on the shared form/formatter boundary let the registered test
compile in the Convex TypeScript project as well as the application project.

F1: registered approve, void, re-entry changed all three complete reconciliation
responses from AVAILABLE/reconciled to UNAVAILABLE, and added the employee and
supplier recoverable checklist warnings. `verifiedOpeningVoidPair` already
proves tenant, source, date, period, reviewer, links, currency and exact opposite
line identity. A shared bounded `verifiedOpeningVoidJournalIds` now supplies
exceptions to admission and both reconciliation enumerators. Invalid proofs or
inventory overflow refuse. The employee/recoverable path removes only proved
ids before its existing per-id/batch provenance strategies; it does not expand
the supported source-family allowlist. Supplier discovery charges the proof's
actual document and range reads to its existing discovery allowance. Guarded
opening readers use their existing charged database reader. Ledger lines and
snapshots retain both original and opposite amounts.

F2: a legacy approval after an edit actually posted unseen replacement content;
a legacy rejection after an edit actually rejected it. These are sequential
registered transactions, reproducible without concurrent execution. New
version-aware red cases initially failed at the old argument validator, not at
the desired domain refusal. Those validator failures alone are not the defect
proof; the two legacy cases supply it. Every edit increments an optional stored
version; absent means zero. Both decisions require a safe nonnegative integer
`expectedVersion`, compared before writes. A mismatch throws coded
`OPENING_DRAFT_CHANGED`, localized in English and Arabic. Required validators
refuse old clients. The list and editable-status projections return the version;
the panel sends its rendered version. A hash would require a canonical content
definition and hashing/serialization maintenance, while every content change
already passes through the single edit mutation. Version binding is sufficient
for that write boundary. Convex OCC protects the mutation transaction, not the
earlier human review.

Differences from reviewers: Seat 1's shared-proof recommendation is retained,
but implemented before the existing provenance strategies rather than by
allowlisting `openingBalanceVoid`. This also covers the batch strategy and
preserves its refusal rules. Seat 1's claim that F2 cannot be reproduced in
convex-test is too broad: stale sequential decisions are reproducible; real OCC
timing is not. Seat 2's minimal formatter reuse is retained; the alternative
display formatter is unsuitable for inputs because of grouping separators.
No reviewer proposal is treated as independent certification of this repair.

Five self-attacks: float formatting on either input path; a counterfeit or
damaged reversal; a provenance strategy that loses the exception; a stale or
missing decision version; and a caller/fixture not updated for the required
argument. Negative tests, mutation checks, caller enumeration and both
TypeScript projects address these separately. Runtime OCC remains unverified.

## R1 editable money census

Locations below are the pre-fix locations at `09f74e3a4`. Scope: tracked
`components/**` and `app/**`; searches include `fromMinorUnits`, `toFixed`,
`String`/`toString` of minor amounts, division by currency factors/powers and
editable state initializers. Display-only hits were checked separately.
Reachability is source-inspected, not a production prevalence claim.

| Site | Reachability and verdict |
| --- | --- |
| `components/accounting/setup/OpeningBalanceCard.tsx:344-345` | Pending preparer edit; debit and credit are parsed and resubmitted. New in this PR, repaired. Zero sides remain empty. |
| `components/accounting/setup/openingAllocationForm.ts:65` | All eleven pending allocation kinds share the conversion. New in this PR, repaired. |
| `components/accounting/setup/OpeningAllocationEditor.tsx:146` | Available opening-stock choice fills an editable vehicle allocation. Predates this PR; lossy float conversion, follow-up. |
| `components/sourcing/SupplierCostRecoveriesSection.tsx:97` | Receipt dialog defaults remaining minor balance, then submits payment. Predates this PR; follow-up. |
| `components/applications/cockpit/CustomerFinanceCompanyPaymentCard.tsx:102` | Awaiting finance-company payment default, then submitted. Predates this PR; follow-up. |
| `components/applications/cockpit/DealCustodyDialogs.tsx:157` | Suggested custody amount is editable and submitted. Predates this PR; follow-up. |
| `components/applications/cockpit/DealCustodyDialogs.tsx:356` | Existing custody amount initializes editable state. Predates this PR; follow-up. |
| `components/applications/cockpit/HandoverCostsPanel.tsx:2499` | Actual fee minor amount initializes edit state. Predates this PR; follow-up. |
| `components/applications/cockpit/RecordLegalInvoiceDialog.tsx:110` | Stored legal invoice initializes editable amount. Predates this PR; follow-up. |
| `components/applications/cockpit/RecordSubmittedQuotationDialog.tsx:175,203,313` | Stored/calculated quotation money initializes or updates editable amount. Predates this PR; follow-up. |
| `components/sales/wizard/components/DepositAllocationPanel.tsx:80` | Stored deposit allocation initializes editable amount. Predates this PR; follow-up. |
| `lib/financeFeeTemplateForm.ts:105,171` | Existing finance fee input formatter uses exact string slicing; reused, no arithmetic change. |

The shared allocation conversion covers CUSTOMER_RECEIVABLE, CUSTOMER_DEPOSIT,
EMPLOYEE_ADVANCE, EMPLOYEE_COMMISSION, VEHICLE_INVENTORY, PARTNER_CAPITAL,
PREPAID_EXPENSE, SUPPLIER_RECOVERABLE, SUPPLIER_PAYABLE, OTHER_PAYABLE and
UNALLOCATED_LIABILITY. The table test round-trips their complete family payloads
at one minor unit, 4001 minor units and admitted upper values for JPY/USD/JOD
(scales 0/2/3). Admission of the numeric upper values is checked with the same
minor/major round-trip predicate used by `validateOpeningRow`; family identity
is tested in the existing registered composite fixture.

Read-only hits, unchanged: `OpeningAllocationEditor.tsx:189-190,261`,
`OpeningBalanceCard.tsx:141,362,625-637`,
`OpeningBalanceApprovalPanel.tsx:126-128`, fixed-asset/partner/prepaid report
values, opening management settlement displays, bank and cash-drawer displays,
financial report helpers, commission/deposit presentation and cockpit money
labels. They do not initialize an editable string in the enumerated code.
No editable conversion was found in tracked `app/**` in this census. Other
existing input sites above are source-confirmed candidates, not reproduced
backend defects or changes authorized by this PR.

## F1 journal reader census

Pre-fix locations at `09f74e3a4`. Scope: tracked `convex/**` production TS,
excluding generated files and tests. Enumeration combined all `journalEntries`
accesses with category/source-family/cutover predicates and indirect opening
basis readers. Writers and schema declarations were inspected but are not
reader claims. Source-indexed readers for another concrete economic object
cannot receive an opening pair with the governed pair's source tuple.

| Reader / file:line | Effect of governed void pair; verdict |
| --- | --- |
| `utils/openingVoidProof.ts:40,72` | Proves each pair and admits re-entry; shared verified-id inventory replaces local enumeration. |
| `openingBalanceMaintenance.ts:38-63,139-151` | Current-source/operations inspection; shared activity proof, valid pair neutral, malformed proof refuses. |
| `accountingReports.ts:1744-1812,1838-1892` | Employee advances and supplier recoverables reject reversal family, including batch strategy. Broken; repaired before strategy selection with verified ids. |
| `accountingReports.ts:2377-2440` | Supplier receivables rejects additional REVERSED cutover. Broken; repaired using the same verified ids with existing discovery budget. |
| `accountingReports.ts:1284-1311` | Later AP activity date classifier. Current reconciliations see both pair lines before cutoff; historical current-state requests already refuse. Unchanged. |
| `accountingCutover.ts:214-246` | POSTED opening selector ignores reversed original; REVERSAL is not an opening. Admission delegates to shared proof. |
| `accountingCutover.ts:1340-1352,1574` | Readback selects active POSTED opening, otherwise retained history. VOIDED is not active authority. Unchanged. |
| `utils/openingSourceIdentity.ts:160-180` | Enumerates POSTED headers and live POSTED OPENING_BALANCE cutovers. Pair does not become active source; bounds still refuse. |
| `utils/openingSettlementBasis.ts:92-111` | Current source requires POSTED opening and live header. Removed sources are not active; replacement is. Unchanged. |
| `utils/openingAdvanceBasis.ts:12-52` | Removed advance is absent; re-entry advance requires new POSTED source. Unchanged. |
| `utils/openingReceivableBasis.ts:15-61` | Removed receivable is absent; replacement requires new source. Unchanged. |
| `utils/openingPrepaidBasis.ts:34-82` | Removed schedule absent; replacement requires new source. Unchanged. |
| `utils/openingPartnerBasis.ts:37-66` | Cleared partner marker is not live opening authority; replacement marker resolves new source. Unchanged. |
| `utils/openingVehicleBasis.ts:43-103` | Cleared stock marker is not live basis; replacement resolves new source. Transitional stock/GL difference remains observable. Unchanged. |
| `utils/openingManagementBasis.ts:9-37` | Requires current POSTED source; settlement-plan presence prevents void. Unchanged. |
| `accountingPeriods.ts:569-655` | Checklist consumes the broken family readers; corrected by their shared proof, warnings tested field by field. |
| `accounting/accountSnapshots.ts` and `accountingLedger.ts` | Balance/detail readers retain original and reversal lines; opposite debits/credits net zero. Closed snapshots remain authoritative. Unchanged. |
| `utils/journalReportEligibility.ts` and `journalReportEligibility.ts` | POSTED/REVERSED eligibility includes both sides; no source-family whitelist. Unchanged. |
| `accounting/bankAggregateTriggers.ts:140` | Legacy dimensionless reversal exception requires an accounting event. Opening bank lines already require physical identity; ordinary aggregate uses both eligible sides. Unchanged. |
| `aggregates.ts`, `bankAccounts.ts` | Eligible bank-line sums retain both sides and preserve physical bank attribution. Existing composite round trip tests literal balance. Unchanged. |
| `accounting/reversals.ts:142`, `accountingOutbox.ts:1911` | Generic reversal refuses opening journals/void source; outbox event reversal is event-bound. Unchanged. |
| `accountingLedger.ts:378-382,499` | Explicit source drilldown and receipt-source reversal; pair has a different receipt tuple. History remains visible. Unchanged. |
| `accounting/invoiceReceiptActivation.ts:161,307,409` | Exact receipt event/journal identity; governed void has no matching event. Unchanged. |
| `utils/supplierObligationDue.ts:632,648`, `utils/supplierPaymentsReconciliation.ts:158` | Journals indexed by the payable's concrete source id; pair has cutover/void tuple. Unchanged. |
| `utils/customerInvoiceObligation.ts:104`, `sourcedAgentImpact.ts:162`, `sales.ts`, `vehicles.ts` | Sale/vehicle-event source readers, not cutover enumerators. Pair cannot match their object source tuple. Unchanged. |
| `diagnosePrepaidLedgerIntegrity.ts:121`, `migrateCommissionAccruals.ts`, `migrateConsignedSaleBasis.ts` | Expense/payroll/sale-specific source readers; do not classify a cutover pair as those events. Unchanged. |
| `accountingMigration.ts`, `accounting/postingEngine.ts`, `financialAudit.ts` | Event-specific posting/idempotency or manual-journal readers; pair has no matching event/manual command. Unchanged. |
| `utils/financialGuards.ts`, `orgSettings.ts:176`, `adminOrgs.ts` | Existence/history guards continue to observe retained financial history. Neutrality does not authorize denomination changes or erase history. Unchanged. |
| `orgFinancialReset.ts`, `utils/orgResetReferences.ts`, `transactions.ts` | Retain/reset or linked-history readers, not reconciliation classification. Void links remain registered. Unchanged. |
| `e2eBootstrap.ts:233-253` | Cleanup requires a live authentic opening; VOIDED source is intentionally refused. Unchanged. |

## Verification log

The failing-first commit is `72f92b1d9` (full SHA in the scenario records).
Its named tests precede all repairs. Command:

```text
pnpm exec vitest run --maxWorkers=1 components/accounting/setup/OpeningBalanceMaintenance.scrum850.test.tsx components/accounting/setup/openingRehydration.scrum850.test.ts convex/openingBalanceMaintenance.scrum850.test.ts -t 'SCRUM-850 (R1|F1|F2)'
Test Files 3 failed (3)
Tests 8 failed | 3 passed | 37 skipped (48)
```

The skipped count is the deliberate name filter on unrelated existing tests,
not skipped scenario implementations. Red output is retained locally at
`%TEMP%/s850-round2-red-commit.log`. Initial test-authoring runs exposed invalid
extra fixture metadata and one non-admitted USD upper value; both were corrected
before the red commit. The committed JPY/USD ordinary controls pass; JOD fails
on the exact one-unit change. The component and backend fail independently.

R1 focused green: 5 passed, 43 unrelated filtered cases. F1 focused green:
2 passed, 35 unrelated filtered cases. Complete maintenance after F2: 37 passed.
UI/form/formatter/visual batch: 86 passed across 8 named files. Final checks and
mutation results are appended below after execution.

## Research and evidence limits

Checked official sources on 2026-11-08:

- [ECMAScript toFixed](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-number.prototype.tofixed): formats the Number supplied to it; discarded integer precision cannot be recovered by decimal formatting.
- [Convex validators](https://docs.convex.dev/functions/validation): required argument validation provides the old-client fail-closed boundary; optional schema version preserves existing documents.
- [Convex application errors](https://docs.convex.dev/functions/error-handling/application-errors): structured ConvexError data carries the clean coded refusal; write failures remain thrown.
- [Convex OCC and atomicity](https://docs.convex.dev/database/advanced/occ): transactional conflict detection supports atomic version comparison/edit/posting, not the client review interval.
- [RFC 9110 If-Match](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1): the expected-version design follows the conditional-write principle of rejecting changes against a different representation.

No independent seats, cloud limits/OCC scheduling, real-backend scenario
certification, production data prevalence, live Sonar result, signed-in screen
audit or explorer hunt is claimed. No generated API declaration was regenerated
or staged; no module was added to the backend public API. This lane does not
activate uncertified pilot doors or certify a release.
