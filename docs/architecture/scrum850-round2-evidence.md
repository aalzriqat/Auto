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
| `components/applications/cockpit/DealCockpit.tsx:3764`, `components/applications/DisbursementConfirmationDialog.tsx:124` | Stored approved purchase minor amount passes through a numeric default into an editable string. Predates this PR; follow-up. |
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
| `accounting/bankOpeningReconciliation.ts:89`, `utils/openingSupplierBasis.ts:18-28` | Delegate to current opening identity or POSTED header inventory; VOIDED history is not active bank/supplier opening authority. Unchanged. |
| `utils/openingAdvanceBasis.ts:12-52` | Removed advance is absent; re-entry advance requires new POSTED source. Unchanged. |
| `utils/openingReceivableBasis.ts:15-61` | Removed receivable is absent; replacement requires new source. Unchanged. |
| `utils/openingPrepaidBasis.ts:34-82` | Removed schedule absent; replacement requires new source. Unchanged. |
| `utils/openingPartnerBasis.ts:37-66` | Cleared partner marker is not live opening authority; replacement marker resolves new source. Unchanged. |
| `utils/openingVehicleBasis.ts:43-103` | Cleared stock marker is not live basis; replacement resolves new source. Transitional stock/GL difference remains observable. Unchanged. |
| `utils/openingManagementBasis.ts:9-37` | Requires current POSTED source; settlement-plan presence prevents void. Unchanged. |
| `accountingPeriods.ts:569-655` | Checklist consumes the broken family readers; corrected by their shared proof, warnings tested field by field. |
| `accounting/accountSnapshots.ts:484,536,738` and `accountingLedger.ts:178` | Balance/detail readers retain original and reversal lines; opposite debits/credits net zero. Closed snapshots remain authoritative. Unchanged. |
| `utils/journalReportEligibility.ts:10,39` and `journalReportEligibility.ts:41` | POSTED/REVERSED eligibility includes both sides; no source-family whitelist. Unchanged. |
| `accounting/bankAggregateTriggers.ts:140` | Legacy dimensionless reversal exception requires an accounting event. Opening bank lines already require physical identity; ordinary aggregate uses both eligible sides. Unchanged. |
| `aggregates.ts:417`, `bankAccounts.ts:366` | Eligible bank-line sums retain both sides and preserve physical bank attribution. Existing composite round trip tests literal balance. Unchanged. |
| `accounting/reversals.ts:142`, `accountingOutbox.ts:1911` | Generic reversal refuses opening journals/void source; outbox event reversal is event-bound. Unchanged. |
| `accountingLedger.ts:378-382,499` | Explicit source drilldown and receipt-source reversal; pair has a different receipt tuple. History remains visible. Unchanged. |
| `accounting/invoiceReceiptActivation.ts:161,307,409` | Exact receipt event/journal identity; governed void has no matching event. Unchanged. |
| `utils/supplierObligationDue.ts:632,648`, `utils/supplierPaymentsReconciliation.ts:158` | Journals indexed by the payable's concrete source id; pair has cutover/void tuple. Unchanged. |
| `utils/customerInvoiceObligation.ts:104`, `sourcedAgentImpact.ts:162`, `sales.ts:580-588`, `vehicles.ts:1155,1207,1359,2067` | Sale/vehicle-event source readers, not cutover enumerators. Pair cannot match their object source tuple. Unchanged. |
| `diagnosePrepaidLedgerIntegrity.ts:121`, `migrateCommissionAccruals.ts:339`, `migrateConsignedSaleBasis.ts:233` | Expense/payroll/sale-specific source readers; do not classify a cutover pair as those events. Unchanged. |
| `accountingMigration.ts:549`, `accounting/postingEngine.ts:761`, `financialAudit.ts:534` | Event-specific posting/idempotency or manual-journal readers; pair has no matching event/manual command. Unchanged. |
| `utils/financialGuards.ts:29`, `orgSettings.ts:176`, `adminOrgs.ts:77` | Existence/history guards continue to observe retained financial history. Neutrality does not authorize denomination changes or erase history. Unchanged. |
| `orgFinancialReset.ts:87,329`, `utils/orgResetReferences.ts:33-34`, `transactions.ts:221` | Retain/reset or linked-history readers, not reconciliation classification. Void links remain registered. Unchanged. |
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
mutation results follow.

### Final checks

| Check | Measured result |
| --- | --- |
| New R1/F1/F2 checks after final mutant restoration | 10 passed, 37 unrelated name-filtered cases, 3 files. The two legacy parameter variants became one explicit registration that executes both decision shapes; no assertion was removed. |
| Existing affected backend batch | 600 passed, 17 named files, including the complete tenant guard suite. |
| UI/form/formatter/approval/offline visual batch | 86 passed, 8 named files. EN/AR fixture assertions and existing captures retained; this round did not measure browser viewport layout. |
| Supplemental reconciliation/contract/index/budget batch | 13 files passed; the complete 14-file run had 506 passes and one scenario-library binding failure. It is not relabelled green. |
| Corrected maintenance and complete scenario validator | 106 passed in `convex/openingBalanceMaintenance.scrum850.test.ts` and `scripts/regression/scenarioRecord.test.ts`; 36 maintenance + 70 validator checks. |
| Other regression validators | `localExecution`, `pilotDoorAnalysis`, `pilotDoorInventory`, `prRunner`, `refreshRulings`, `implFixture`: passed in the 7-file run. That run had 378 passes and one live-library failure for five prose-valued inputs, repaired to short tokens. A later isolated library run exposed the parameterized-binding refusal, also repaired. Validators were not changed. |
| `pnpm typecheck` | Exit 0 after final source cleanup. Root application roots exclude `convex`, `test-utils`, `apps`, `packages` and `dealer-worker`; this is not the backend check. |
| `pnpm typecheck:convex` | Exit 0 after final source cleanup. Checks `convex/**` and `test-utils/**`, plus imported dependencies; generated files are excluded as roots. |
| ESLint on all changed TS/TSX | 34 measured files, zero errors/warnings. The installed Convex plugin 1.2.2 supplies a legacy recommended config while the repo spreads a flat array. A temporary in-memory translation preserved all recommended rules and overrides. No repository lint configuration changed. Silent CLI exit-zero results were not used as measurement. |
| Local Sonar/typed rule check | SonarJS 4.2.2 `no-invariant-returns`, cognitive ceiling 14, TypeScript `require-await` and `prefer-optional-chain`: 3 related backend modules, zero errors/warnings. This is local evidence, not a live SonarCloud verdict. |
| Lint setup diagnostics | Initial programmatic loading failed on the installed legacy config. An exploratory core `require-await` check incorrectly flagged promise-forwarding handlers; the official TypeScript rule permits these. A whole-config typed experiment also flagged native-table-id rules on existing/custom reader methods. The final independent typed check measures the requested async/optional-chain rules; the complete repository-config lint pass remains separately measured above. |
| Final tenant write audit and coverage | 2 actual whole-backend gate checks passed; 11 unrelated analyzer tests filtered. Coverage remains 574 total mutations, 386 analyzed, 15 no-args-block and 173 no-org skips. No allowlist or count changed. |
| `git diff --check` | Passed. |
| Scenario source/ancestry check | 6/6 new records contain their literal named test in `72f92b1d9`, which is an ancestor preceding R1's first repair. The legacy title retains its original literal `%s`; its current explicit registration exercises both legacy shapes. |

The 17-file backend command named:

```text
convex/openingBalanceMaintenance.scrum850.test.ts
convex/accountingPhase17.test.ts
convex/accountingPhase18.test.ts
convex/chartOfAccounts.management.test.ts
convex/manualJournalsPilotOff.scrum795.test.ts
convex/openingAllocatedAdvances.test.ts
convex/openingAllocatedPartners.test.ts
convex/openingAllocatedPrepaids.test.ts
convex/openingAllocatedReceivables.test.ts
convex/openingBalanceBankIdentity.test.ts
convex/openingCommissionPayroll.test.ts
convex/openingNamedDeposits.scrum858.test.ts
convex/openingSuspense.scrum858.test.ts
convex/openingClosureReaders.scrum858.test.ts
convex/supplierReceivablesReconciliation.scrum869.test.ts
convex/reconciliationOrgReferences.scrum889.test.ts
scripts/tenantWriteGuard.test.ts
```

Supplemental named suites included
`scripts/contractSkew/clientPaths.test.ts`, `scripts/contractSkew/census.test.ts`,
`convex/supplierPayablesReconciliation.scrum651.test.ts`,
`convex/supplierPayablesReconciliation.scrum876.opening.test.ts`,
`convex/supplierPayablesReconciliation.scrum876.test.ts`,
`convex/openingBankReconciliation.scrum858.test.ts`,
`convex/bankReconciliation.test.ts`, `convex/openingBalanceIndexReads.test.ts`
and `convex/openingCommissionReadBudget.test.ts`. Both requested contract-skew
test files passed. Their parent batch's library failure is recorded above.

The eight UI suites were `components/accounting/setup/`'s
`OpeningBalanceApprovalContainer.test.tsx`, `OpeningBalanceApprovalPanel.test.tsx`,
`OpeningBalanceMaintenance.scrum850.test.tsx`, `openingRehydration.scrum850.test.ts`,
`openingAllocationForm.test.ts`, `OpeningAllocationVisualFixture.test.tsx`,
`OpeningDepositUi.scrum858.test.tsx`, plus `lib/financeFeeTemplateForm.test.ts`.
Existing assertion changes only add the required decision-version argument;
financial expectations, permissions and refusal assertions are retained.

### Mutation checks on committed source

All mutants were repeated against code commit `45b84ab9d`. Each restoration used
`git checkout HEAD -- <explicit files>`, followed by an empty scoped
`git status --short` result for those files. No source edit was outstanding when
the mutations began. Local outputs are `%TEMP%/s850-mutant-r1-final.log`,
`s850-mutant-f1-final.log`, `s850-mutant-f2-final.log` and
`s850-new-tests-final-green.log`.

| Mutant | Expected detection and actual result |
| --- | --- |
| R1: restore red-commit card/form float rehydration | 3 failed, 2 passed, 42 unrelated filtered. Component mutation arguments, registered allocation round trip and JOD all-family table each fail. JPY/USD controls pass. Both files restored. |
| F1: remove verified-id exceptions from both report enumerators | Re-entry still succeeds through admission; complete reconciliation equality fails. 1 failed, 1 tamper control passed, 34 unrelated filtered. Report file restored. |
| F2: remove version checks from approve and reject | Both stale decisions wrongly succeed. 2 failed, 1 legacy-contract control passed, 33 unrelated filtered. Cutover file restored. |
| Restored final source | New tests green: 10 passed, 37 unrelated filtered, 3 files. |

### Contract baseline checks

Initial identity check refused four moved calls. The exact command
`node scripts/contractSkew/relocateBaseline.mjs --base 09f74e3a4fb1b66644b614e5df91ac7e8c865d67 --write`
proved and relocated the two identical card calls, and refused the two changed
panel calls. The base is the starting commit where the recorded locations were
true, not main. The two panel locations were updated individually with source
review notes covering the new `expectedVersion` argument.

After committing those changes, the requested renewal check found four stale
statement entries due only to the changed `accountingReports.ts` declaration
module. Those four entries received individual notes and current client/backend
Git blob evidence. No other entry was renewed; the tool's write mode was never
used. All eight affected entries retain their UNKNOWN verdict, cause,
fingerprint, multiplicity, issue and expiry. These notes are implementer source
review, not independent seats or runtime evidence.

Final commands/results:

```text
node scripts/contractSkew/checkBaselineIdentity.mjs
Call identity check: 945 baseline entries matched (surface, file, callSiteId, functionId).
Backend finding identity was not checked.

node scripts/contractSkew/renewBaselineReviewed.mjs --reviewed c82890bd --check-evidence --pr-base 9d017020af68b5201f108ce97fb54c5596f74676
renewal evidence: 945 renewed entries checked, 0 unrenewed, 0 stale, 0 malformed, 0 missing
```

No new finding was added to the baseline. No live backend-spec extraction or
production contract-skew verdict is claimed by these credential-free checks.

## Research and evidence limits

Checked official sources on 2026-11-08:

- [ECMAScript toFixed](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-number.prototype.tofixed): formats the Number supplied to it; discarded integer precision cannot be recovered by decimal formatting.
- [Convex validators](https://docs.convex.dev/functions/validation): required argument validation provides the old-client fail-closed boundary; optional schema version preserves existing documents.
- [Convex application errors](https://docs.convex.dev/functions/error-handling/application-errors): structured ConvexError data carries the clean coded refusal; write failures remain thrown.
- [Convex OCC and atomicity](https://docs.convex.dev/database/advanced/occ): transactional conflict detection supports atomic version comparison/edit/posting, not the client review interval.
- [RFC 9110 If-Match](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1): the expected-version design follows the conditional-write principle of rejecting changes against a different representation.
- [TypeScript require-await](https://typescript-eslint.io/rules/require-await/): unlike the core ESLint rule, the typed rule permits an async function that forwards a Promise without a local await. This explains the exploratory lint false positives.

No independent seats, cloud limits/OCC scheduling, real-backend scenario
certification, production data prevalence, live Sonar result, signed-in screen
audit or explorer hunt is claimed. No generated API declaration was regenerated
or staged; no module was added to the backend public API. This lane does not
activate uncertified pilot doors or certify a release.

## Commits and changed files

History order through the last code commit; the final evidence-only commit follows these. Every commit has the required `(SCRUM-850)` subject suffix and Codex co-author trailer.

| Commit | Subject |
| --- | --- |
| `72f92b1d9b908ad7290843fd31632aafda340372` | test: reproduce opening round two money and review defects (SCRUM-850) |
| `3a1dcf6284a164780dd73e45e9db5f6bd28b944a` | fix: preserve exact opening draft money on rehydration (SCRUM-850) |
| `c393b9a20c4098560f274e99acaa76fc45fe3f3e` | fix: recognize verified opening void pairs in reconciliation readers (SCRUM-850) |
| `6be9f80a2c2f44a4855fe0bd6e439fa2e40811b7` | fix: bind opening decisions to the reviewed draft version (SCRUM-850) |
| `51d4dc132446194e0e80fa894dd40d8b5515c4d7` | fix: clarify opening void null result and bounded reference scan (SCRUM-850) |
| `d42a68bd020ba11e3d03cba1c9565ac0cb88b682` | test: keep opening round trips and browser replay contracts typed (SCRUM-850) |
| `f8a5069950a8e34adf59c3407513908df1f5e9db` | docs: bind opening round two regressions and design evidence (SCRUM-850) |
| `1ef53c2ac482a159fa49f6fda538d7ad7ac1e8cb` | docs: review opening contract call moves and version arguments (SCRUM-850) |
| `3c3c9a13a616100d5539a78d87c66bb93744cd71` | docs: renew affected statement declaration evidence individually (SCRUM-850) |
| `43f69749aaa9e46c92057cd9ad1e879f1d37b541` | test: use scenario input tokens and assert the void request result (SCRUM-850) |
| `45b84ab9d430b6ed08e8b361db21570babbb10fe` | test: register the legacy decision scenario explicitly (SCRUM-850) |

Changed-file enumeration (47 paths against the starting commit):

```text
components/accounting/setup/OpeningAllocationVisualFixture.test.tsx
components/accounting/setup/OpeningBalanceApprovalContainer.test.tsx
components/accounting/setup/OpeningBalanceApprovalPanel.test.tsx
components/accounting/setup/OpeningBalanceApprovalPanel.tsx
components/accounting/setup/OpeningBalanceCard.tsx
components/accounting/setup/OpeningBalanceMaintenance.scrum850.test.tsx
components/accounting/setup/OpeningDepositUi.scrum858.test.tsx
components/accounting/setup/openingAllocationForm.ts
components/accounting/setup/openingMoneyInput.ts
components/accounting/setup/openingRehydration.scrum850.test.ts
convex/accountingCutover.ts
convex/accountingPhase17.test.ts
convex/accountingPhase18.test.ts
convex/accountingReports.ts
convex/chartOfAccounts.management.test.ts
convex/manualJournalsPilotOff.scrum795.test.ts
convex/openingAllocatedAdvances.test.ts
convex/openingAllocatedPartners.test.ts
convex/openingAllocatedPrepaids.test.ts
convex/openingAllocatedReceivables.test.ts
convex/openingBalanceBankIdentity.test.ts
convex/openingBalanceMaintenance.scrum850.test.ts
convex/openingBalanceMaintenance.ts
convex/openingCommissionPayroll.test.ts
convex/openingNamedDeposits.scrum858.test.ts
convex/openingSuspense.scrum858.test.ts
convex/schema.ts
convex/utils/errors.ts
convex/utils/openingMaintenanceErrors.ts
convex/utils/openingVoidProof.ts
convex/utils/openingVoidReferences.ts
docs/adr/2026-11-08-opening-balance-edit-void-correct.md
docs/architecture/scrum486-certification-oracle.md
docs/architecture/scrum850-part1-local-evidence.md
docs/architecture/scrum850-round2-evidence.md
lib/financeFeeTemplateForm.ts
lib/i18n/domains/common.ts
playwright/opening-proof/opening-onboarding.spec.ts
regression/scenarios/money/opening-maintenance-exact-rehydration.scenario.json
regression/scenarios/money/opening-maintenance-legacy-decision-refuses.scenario.json
regression/scenarios/money/opening-maintenance-stale-approval-refuses.scenario.json
regression/scenarios/money/opening-maintenance-stale-rejection-refuses.scenario.json
regression/scenarios/money/opening-maintenance-tampered-void-readers-refuse.scenario.json
regression/scenarios/money/opening-maintenance-void-reader-neutrality.scenario.json
scripts/contractSkew/needs-evidence-baseline/components+accounting+=financial=reports=tab.tsx.json
scripts/contractSkew/needs-evidence-baseline/components+accounting+setup+=opening=balance=approval=panel.tsx.json
scripts/contractSkew/needs-evidence-baseline/components+accounting+setup+=opening=balance=card.tsx.json
```

The final source is committed. Scoped status checks for all four mutated source files are empty after restoration. The working tree retains only the three explicitly excluded local edits after the evidence document is committed. None of those paths, `.env.local`, `convex/_generated/api.d.ts` or `review-evidence/*.json` appears in this change.
