# SCRUM-850 round 4 implementation evidence

Worktree `E:/tmp/auto-850`, branch `claude/scrum850-opening-correction`.
Starting head `9b2003b2ac294fe66d1d5a878406de21efb27c25`; supplied base and
freshly fetched origin/main `95ffa13e91e9c619336ac9d4274c560d3b132121`, zero behind
at the start. The coordinator owns Jira, GitHub and independent review seats.
No external posts, push, deployment, production reads or backend-connected
browser tests were performed. Seat 1 LOW findings are unchanged.

## Invariant and independent reproduction

A cutover attestation stores exact reviewed monetary gross totals per currency,
or refuses before writing either its sign-off row or its financial audit copy.
The reviewed production code includes POSTED and REVERSED journals. Thus the
gross history includes the original opening, its linked reversal and replacement.
The safe per-opening BigInt cap and safe account snapshot shards do not cap this
history. No journal is dropped or netted to make the attestation fit.

The new suite uses registered public commands through convex-test for both
reviewed approval and owner direct posting. It posts `9007199254740991` to
CASH_ON_HAND/RETAINED_EARNINGS, requests and independently approves governed void,
then posts `1` to VAT_RECEIVABLE/SALES_TAX_PAYABLE. A signer distinct from the
replacement approver calls sign-off. The tests independently sum retained lines
with BigInt and assert literal exact debit and credit `18014398509481983`.
Every stored account snapshot operand is safe. At the red commit sign-off
instead resolves with both gross totals `18014398509481984`, `isBalanced: true`.

Failing-first commit `a1918002ef42fe9fd8ad0fdf5518fbb1a7468765` contains all
12 literal test names, before any production fix. Full-file run there:

```text
pnpm exec vitest run --maxWorkers=1 convex/accountingCutoverExactness.scrum850.test.ts
Test Files 1 failed (1)
Tests 6 failed | 6 passed (12)
VITEST_EXIT=1
```

Output: `%TEMP%/s850-r4-red-a1918002e.log`. The six failures are both public
unsafe lifecycle cases, isolated unsafe debit/credit history, and both legacy
comparison gross sides. Both ordinary, both below-limit and both currency
controls pass. The first authoring run had nine tests; its four intended failures
are not substituted for the committed twelve-test run.

## Design, review differences and impact

Reuse `addBalanceMinor` and translate only `isUnsafeBalanceError` to
`CUTOVER_UNSAFE_TOTAL`. Unexpected errors escape unchanged. This distinct code
truthfully names journal-based cutover totals; snapshot-specific wording would
misidentify the failed computation. The EN/AR message applies to the sign-off and
the comparison query. The error is thrown during read-only aggregation, before
the sign-off insert and `auditLog`, and remains uncaught by the mutation.

I agree with the reviewer's minimal checked-addition fix. Differences in proof:
I require refusal rather than accepting either success or refusal, and compare
all existing audit rows before/after rather than expecting an empty audit table.
Opening/void legitimately leave earlier audits. I add explicit one-sided corrupt
historical-data fixtures because a balanced overflow is caught by either side
and cannot independently kill removal of the other check. Those controls assert
the arithmetic code, so ordinary unbalanced refusal is insufficient. Currency
fixtures represent retained pre-currency-change history by editing test data;
they do not claim that today's locked currency setting can be changed publicly.
The legacy fixture similarly represents retained migrated history, not an enabled
`transactions` source writer. No existing assertion was changed or weakened.

One read-only advisory design attack found these proof details and verified the
opening/void BigInt path. It is not an independent seat or certification.
`correct` guidance was applied to the repeated gross-aggregation mistake class:
round 3 snapshot accumulators and round 4 journal attestation accumulator are
distinct consumers. Reusing the shared arithmetic and permanent public tests
is the scoped prevention; a new exact storage model is outside this repair.

| Impact area | Disposition |
| --- | --- |
| Writers | One sign-off writer, its returned response and audit copy; aggregation refuses before writes. |
| Readers | `listSignOffs` returns persisted snapshots; no recomputation or historical rewrite. |
| Historical data | Unsafe journal operands/totals refuse; already-rounded attestations are not repaired. |
| State transitions | Both posting routes, governed void and re-entry retain state/version checks. |
| Reversal | Original and reversal remain in gross history. No new spend or reversal door. |
| Idempotency | No new command identity; existing retry and void controls rerun. |
| Authorization | Finance permission and distinct signer unchanged; no flags enabled. |
| Tenant isolation | Organization-indexed reads retained; tenant write guard is required. |
| Ledger | Arithmetic-only reader change, no journal/snapshot writer change or added I/O. |
| Audit | Ordinary snapshot copy equals persisted readback; refusal preserves full prior audit rows. |
| UI | New bilingual error entry only; no tracked sign-off UI caller found in the census below. |
| E2E | Public-function serial harness only. Browser/backend tests prohibited in this lane. |
| Runtime/release | No deploy, real OCC, cloud limits, production prevalence or pilot certification claimed. |

## Gross accumulator and consumer census

Scope: tracked repository source, searched with graft plus `git grep` for
`accountingCutoverSignOffs`, `listSignOffs`, `trialBalanceByCurrency`, the three
cutover exports and every `+=`/`reduce` in `accountingCutover.ts`. Graft cannot
resolve registered-export caller edges, so literal source enumeration supplied
that part of the census. References below use fixed-code line numbers.

| File:line | What it sums or consumes | Verdict and change |
| --- | --- | --- |
| `convex/accountingCutover.ts:206-207` | Both gross journal sides by currency across POSTED/REVERSED history | Reproduced blocker; both use checked addition. |
| `convex/accountingCutover.ts:287-288,321` | Per-opening gross sides | BigInt plus safe-range admission; unchanged. |
| `convex/accountingCutover.ts:1694-1695` | Gross GL sides from posted events with `sourceType=transactions` | Pre-existing sibling excludes opening/void sources; both additions now checked. Ordinary Phase17 comparison retained. |
| `convex/accountingCutover.ts:1672-1673` | Legacy major-unit transactions converted to minor IN/OUT totals | Separate pre-existing legacy cashflow class, not journal debit/credit and not a sign-off snapshot source. Opening/void does not create these rows; unchanged, coordinator follow-up if desired. |
| `convex/financialAudit.ts:247-248` | Manual per-journal line admission | Reachable from opening but BigInt exact/safe-total preflight at cutover `:584-585` precedes it; void verifies/copies exact lines. No wrong stored result through this lifecycle; unchanged. Other manual admission is a separate pre-existing class. |
| `convex/accounting/postingRules.ts:3617-3618` | Event-rule per-journal admission | Opening/void insert direct journals and do not call it. No PR-lifecycle reachability; unchanged. |
| `convex/accountingCutover.ts:1759,1825-1851` | Build snapshot, insert sign-off, return snapshot, pass `after: snapshot` to auditLog | Shared checked sum precedes writes; no storage shape change. |
| `convex/financialAudit.ts:109` | `auditLog` inserts its supplied `after` into financialAuditLog | Copy only, no arithmetic; ordinary persisted copy and refusal preservation tested. |
| `convex/financialAudit.ts:143-208` | `listAuditLog` returns filtered stored audit rows | Copy only, no numeric transformation. Tracked client census found ManualJournalTab using the separate manual-journal commands, no client calling this financial audit reader. |
| `convex/accountingCutover.ts:1855-1866` | `listSignOffs` reads stored snapshots | Unchanged, public persistence assertions. |
| `convex/openingBalanceMaintenance.ts:55` | Sign-off existence blocks void | Existence only, no totals consumed; unchanged. |
| `convex/schema.ts:5956-5981` | Snapshot Float64 schema and org index | Unchanged; schema is not an exact-integer proof. |
| `scripts/orgDeletionCoverage.test.ts:74` | Table name in deletion registry | No numeric consumer; unchanged. |
| `convex/adminOrgs.ts:95`; `convex/orgFinancialReset.ts:88,450` | Export/delete registry for financial audit rows | Table handling only, no snapshot arithmetic; unchanged. The separate adminAudit reader uses its own audit table. |
| Tracked app/components/apps/dealer-worker source | Snapshot/UI consumer census | No `listSignOffs`/`trialBalanceByCurrency` UI reference found in this scoped enumeration. No rendered UI claim. |

## Five predicted failures and tests

1. A catch might commit certification/audit writes. Refusal tests compare the
   empty sign-off table and unchanged full audit rows, after public lifecycle setup.
2. One side could remain unchecked. Isolated debit and credit histories assert
   the arithmetic code, and each check gets its own source mutant.
3. Netting or excluding originals could hide overflow. BigInt retained gross
   literals and exact ordinary persisted `600008` require the full history.
4. A global total could mix currencies. Each currency is safe while their mixed
   sum exceeds MAX_SAFE_INTEGER; sign-off still stores both buckets exactly.
5. Overbroad refusal could reject ordinary/near-limit sign-off or either posting
   route. Both routes persist `600008` and safe boundary `9007199254740990` exactly.

## Verification record

Initial and restored fixed-code new suites: 12 passed. All measured commands
name test files and use `--maxWorkers=1`. No unavailable property is represented
as passing. Completed positive runs cover 77 distinct named files and 2407
tests, counting the new R4 suite once and excluding red/mutant runs and repeats.

### Named existing cutover tests

Enumeration command: `git grep -l -E 'accountingCutover|signOffCutover|listSignOffs|compareLegacyToGL' -- 'convex/*.test.ts'`.
It finds the new R4 file plus these 32 existing files. Batches 01-07 execute
every existing file in full, with no name filters: 824 tests passed.

```text
convex/accountingPhase17.test.ts
convex/accountingPhase18.test.ts
convex/adminOrgs.test.ts
convex/chartOfAccounts.management.test.ts
convex/costDisclosure.scrum902f.test.ts
convex/costReaders.scrum902d.test.ts
convex/manualJournalsPilotOff.scrum795.test.ts
convex/openingAllocatedAdvances.test.ts
convex/openingAllocatedPartners.test.ts
convex/openingAllocatedPrepaids.test.ts
convex/openingAllocatedReceivables.test.ts
convex/openingBalanceBankIdentity.test.ts
convex/openingBalanceIndexReads.test.ts
convex/openingBalanceMaintenance.scrum850.test.ts
convex/openingBankReconciliation.scrum858.test.ts
convex/openingClosureReaders.scrum858.test.ts
convex/openingCommissionPayroll.test.ts
convex/openingCommissionReadBudget.test.ts
convex/openingInventoryCap.scrum858.test.ts
convex/openingManagementSettlement.test.ts
convex/openingNamedDeposits.scrum858.test.ts
convex/openingPrepaidConsumerReports.test.ts
convex/openingPrepaidRounding.scrum858.test.ts
convex/openingRehearsalPublicComposite.test.ts
convex/openingRemainingFamilies.test.ts
convex/openingReversalDoors.scrum858.test.ts
convex/openingStockCashBankReplay.test.ts
convex/openingSupplierLiabilityReplay.test.ts
convex/openingSuspense.scrum858.test.ts
convex/supplierPayablesReconciliation.scrum876.opening.test.ts
convex/supplierReceivables.test.ts
convex/supplierReceivablesReconciliation.scrum869.test.ts
```

There is no dedicated `convex/accounting/accountSnapshots*.test.ts` in tracked
source. The direct-import census (`git grep -l 'accounting/accountSnapshots' -- '*test.ts'`)
has 14 files, all run in batches 01, 04, 07-10: Phase14, Phase5, Phase18,
OutboxAtomicity, ReversalBankIdentity, bankAccounts, financedConsignedSettlement,
openingBankReconciliation, openingClosureReaders, reconciliationOrgReferences,
supplierPayablesReconciliation SCRUM-651, SCRUM-876, SCRUM-876 opening and
supplierReceivablesReconciliation SCRUM-869. This is the stated snapshot-test scope.

### Completed batches and exact named file manifests

Each batch runs `pnpm exec vitest run --maxWorkers=1` followed by the paths below.
Logs are `%TEMP%/s850-r4-suiteNN.log`. A passed batch means every named file
completed, not an inferred pass from partial output.

| Batch | Files | Tests | Result |
| --- | ---: | ---: | --- |
| 01 | 4 | 115 | Passed |
| 02 | 5 | 82 | Passed |
| 03 | 5 | 144 | Passed |
| 04 | 4 | 152 | Passed, including complete 88-test closure-reader file |
| 05 | 5 | 112 | Passed |
| 06 | 5 | 75 | Passed |
| 07 | 4 | 144 | Passed |
| 08 | 5 | 90 | Passed |
| 09 | 5 | 310 | Passed |
| 10 | 6 | 159 | Passed |
| 11 | 12 | 520 | Passed, including tenant write guard and both contract suites |
| 12 | 9 | 113 | Passed |
| Regression validators | 7 | 379 | Passed |

```text
01: convex/accountingPhase17.test.ts convex/accountingPhase18.test.ts convex/openingBalanceIndexReads.test.ts convex/openingBalanceMaintenance.scrum850.test.ts
02: convex/adminOrgs.test.ts convex/chartOfAccounts.management.test.ts convex/costDisclosure.scrum902f.test.ts convex/costReaders.scrum902d.test.ts convex/manualJournalsPilotOff.scrum795.test.ts
03: convex/openingAllocatedAdvances.test.ts convex/openingAllocatedPartners.test.ts convex/openingAllocatedPrepaids.test.ts convex/openingAllocatedReceivables.test.ts convex/openingBalanceBankIdentity.test.ts
04: convex/openingBankReconciliation.scrum858.test.ts convex/openingClosureReaders.scrum858.test.ts convex/openingCommissionPayroll.test.ts convex/openingCommissionReadBudget.test.ts
05: convex/openingInventoryCap.scrum858.test.ts convex/openingManagementSettlement.test.ts convex/openingNamedDeposits.scrum858.test.ts convex/openingPrepaidConsumerReports.test.ts convex/openingPrepaidRounding.scrum858.test.ts
06: convex/openingRehearsalPublicComposite.test.ts convex/openingRemainingFamilies.test.ts convex/openingReversalDoors.scrum858.test.ts convex/openingStockCashBankReplay.test.ts convex/openingSupplierLiabilityReplay.test.ts
07: convex/openingSuspense.scrum858.test.ts convex/supplierPayablesReconciliation.scrum876.opening.test.ts convex/supplierReceivables.test.ts convex/supplierReceivablesReconciliation.scrum869.test.ts
08: convex/manualJournalsPilotOffControl.scrum795.test.ts convex/accountingOutboxAtomicity.test.ts convex/accountingReversalBankIdentity.test.ts convex/orgFinancialReset.test.ts convex/orgFinancialResetNarrow.scrum565.test.ts
09: convex/accountingPhase14.test.ts convex/accountingPhase5.test.ts convex/financedConsignedSettlement.test.ts convex/accountingGenericReversalAuthority.test.ts convex/accountingPhase2.test.ts
10: convex/supplierPayablesReconciliation.scrum651.test.ts convex/supplierPayablesReconciliation.scrum876.test.ts convex/reconciliationOrgReferences.scrum889.test.ts convex/bankAccounts.test.ts convex/generalLedgerPagination.test.ts convex/vatReport.test.ts
11: scripts/tenantWriteGuard.test.ts scripts/contractSkew/census.test.ts scripts/contractSkew/clientPaths.test.ts lib/errors.test.ts lib/i18n/appraisalAttribution.test.ts lib/i18n/closingReadinessReasons.test.ts lib/i18n/collectionsIncompleteWording.scrum265.test.ts lib/i18n/deployedStageLabels.test.ts lib/i18n/keyCoverage.test.ts lib/i18n/minimumPriceUpliftCopy.test.ts lib/i18n/vehicleCostCorrectionCopy.test.ts lib/i18n/whoActsGroups.test.ts
12: components/accounting/setup/OpeningAllocationEditor.test.tsx components/accounting/setup/OpeningAllocationVisualFixture.test.tsx components/accounting/setup/OpeningBalanceApprovalContainer.test.tsx components/accounting/setup/OpeningBalanceApprovalPanel.test.tsx components/accounting/setup/OpeningBalanceMaintenance.scrum850.test.tsx components/accounting/setup/OpeningDepositUi.scrum858.test.tsx components/accounting/setup/openingRehydration.scrum850.test.ts components/accounting/setup/openingAllocationForm.test.ts lib/financeFeeTemplateForm.test.ts
Regression: scripts/regression/scenarioRecord.test.ts scripts/regression/localExecution.test.ts scripts/regression/pilotDoorAnalysis.test.ts scripts/regression/pilotDoorInventory.test.ts scripts/regression/prRunner.test.ts scripts/regression/refreshRulings.test.ts scripts/regression/implFixture.test.ts
```

The supplied local `refreshRulings.test.ts` edit was exercised as supplied,
never edited or staged. No scenario validator or ruling digest was changed.

### TypeScript, lint and contract evidence

Both `pnpm typecheck` and `pnpm typecheck:convex` exited zero without diagnostics.
Root application roots exclude `convex`, `test-utils`, `apps`, `packages` and
`dealer-worker`. The Convex config includes `convex/**` and `test-utils/**` and
excludes generated files as roots. Both compilers still follow imports.
Logs: `%TEMP%/s850-r4-type-root.log`, `%TEMP%/s850-r4-type-convex.log`.

`pnpm exec eslint convex/accountingCutover.ts convex/accountingCutoverExactness.scrum850.test.ts convex/utils/errors.ts lib/i18n/domains/common.ts`
exited zero, with no errors or warnings. No adapter/config change was needed.
Self-review applied engineering-principles, clean-code-guard and test-guard.
Explicit literal test registrations are retained for scenario source binding;
shared test bodies avoid duplicated setup. This is not an independent seat.

`node scripts/contractSkew/checkBaselineIdentity.mjs` matched all 945 identities
before and after the implementation commit. Backend finding identity was not
measured by that check. No client call moved, so relocation was unnecessary;
using main or another base to rewrite unmoved calls would add no evidence.

The first renewal check correctly refused uncommitted backend changes. After
implementation commit `0c8c943a8f9e159722bbffd9fa75c9159c03bdc1`, the required
check found exactly four stale entries: approve/reject draftId in
OpeningBalanceApprovalPanel and direct/draft lines in OpeningBalanceCard.
Each unchanged client call and opening export's argument validators was reviewed
against `9b2003b2ac294fe66d1d5a878406de21efb27c25`, the last recorded true source.
Only each entry's renewal string was appended with current evidence blobs.
No fingerprint, expiry, multiplicity, identity, rationale or extractor changed.
No renewal tool write mode was used. Notes were committed as
`f38c73f708f3f20001338585800f715b9926dddf`.

```text
node scripts/contractSkew/renewBaselineReviewed.mjs --reviewed c82890bd --check-evidence --pr-base 95ffa13e91e9c619336ac9d4274c560d3b132121
renewal evidence: 945 renewed entries checked, 0 unrenewed, 0 stale, 0 malformed, 0 missing
```

### Mutation and persisted-reproduction controls

All mutants start after the fix and baseline commits, with clean source at
`f38c73f708f3f20001338585800f715b9926dddf`. Only
`convex/accountingCutover.ts` changes during each of the five mutants. Each runs
the complete twelve-test R4 file, and each restores with
`git checkout HEAD -- convex/accountingCutover.ts` in a finally block. Each
restoration checks `git status --porcelain -- convex/accountingCutover.ts` and
asserts the output is empty. No broad suite overlaps these source mutations.

| Mutant | Target function | Result |
| --- | --- | --- |
| Uncheck sign-off debit addition | `sumAllPostedJournalLinesByCurrency` | Killed by unsafe debit history arithmetic-code test; 1 failed, 11 passed, exit 1. |
| Uncheck sign-off credit addition | `sumAllPostedJournalLinesByCurrency` | Killed by unsafe credit history arithmetic-code test; 1 failed, 11 passed, exit 1. |
| Uncheck comparison debit addition | `compareLegacyToGL` | Killed by legacy unsafe gross debit test; 1 failed, 11 passed, exit 1. |
| Uncheck comparison credit addition | `compareLegacyToGL` | Killed by legacy unsafe gross credit test; 1 failed, 11 passed, exit 1. |
| Replace shared checked call with unchecked `total + minor` | `addCutoverMinor` | Both public boundary routes and four isolated-side tests fail; 6 failed, 6 passed, exit 1. |

Logs: `%TEMP%/s850-r4-mutant-signoff-debit.log`,
`s850-r4-mutant-signoff-credit.log`, `s850-r4-mutant-legacy-debit.log`,
`s850-r4-mutant-legacy-credit.log`, `s850-r4-mutant-checked-helper.log`.

An additional diagnostic restores the starting `accountingCutover.ts` from
`9b2003b2ac294fe66d1d5a878406de21efb27c25`, and temporarily instruments only
the new test's assertion boundary to call `listSignOffs` after successful
sign-off. This independently measures persistence, not just the mutation's
response. The stored snapshot matches the response, and the exact assertion
fails as follows:

```text
R4_PERSISTED_GROSS: JOD, isBalanced true,
  totalDebitsMinor 18014398509481984, totalCreditsMinor 18014398509481984
AssertionError: expected 18014398509481984n to be 18014398509481983n
Tests 1 failed | 11 skipped (12)
REPRODUCTION_EXIT=1
```

The eleven skipped tests are unrelated cases filtered for this diagnostic;
none is skipped in the full red or green run. Both source and test are restored
with `git checkout HEAD --` their exact paths, and scoped Git status is empty.
Log: `%TEMP%/s850-r4-persisted-reproduction.log`. This temporary diagnostic is
not substituted for the committed failing-first evidence.

After every mutant and diagnostic is restored, the complete R4 file passes:
`Test Files 1 passed (1); Tests 12 passed (12)`, exit zero. Log:
`%TEMP%/s850-r4-restored-green.log`. The final evidence-only commit does not
change production code, tests, scenario records or baseline entries.

### Commit and file record

| Commit | Files changed |
| --- | --- |
| `a1918002ef42fe9fd8ad0fdf5518fbb1a7468765` | New `convex/accountingCutoverExactness.scrum850.test.ts` only; failing-first. |
| `0c8c943a8f9e159722bbffd9fa75c9159c03bdc1` | `convex/accountingCutover.ts`, `convex/utils/errors.ts`, `lib/i18n/domains/common.ts`, ADR, SCRUM-486 matrix, round-3 evidence pointer, this round-4 evidence file, twelve new money scenario records. |
| `f38c73f708f3f20001338585800f715b9926dddf` | Only four individual renewal strings in the OpeningBalanceCard and OpeningBalanceApprovalPanel baseline shards. |

The final evidence-only commit completes this record. Every subject ends
`(SCRUM-850)` and every commit carries
`Co-Authored-By: Codex gpt-6.1-sol <noreply@openai.com>`. No push was performed.
The complete change is 22 paths, including the twelve scenario records. Their
names and bindings are listed in the certification matrix. Personal memory was
updated in the existing gross-exactness lesson and index, outside the repository.

## Official sources and limitations

Checked on 2026-11-09:

- [ECMAScript Number.isSafeInteger](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-number.issafeinteger): safe operands and accumulated Number results must stay within the exact integer range.
- [Convex types](https://docs.convex.dev/database/types): `v.number()` stores Float64; exact Int64 is a different API/schema contract.
- [Convex application errors](https://docs.convex.dev/functions/error-handling/application-errors): structured `ConvexError.data` carries the clean code/message.
- [Convex OCC and atomicity](https://docs.convex.dev/database/advanced/occ): mutation transactions roll back on propagated failure. The serial convex-test observations do not prove cloud concurrency or platform limits.

No new module needs API registration. `convex/_generated/api.d.ts` was not
regenerated or staged. Protected initial local edits and unrelated untracked
files remain outside this lane's commits. Independent seats, all three bug
hunters, authenticated phone/desktop EN/AR rendering, live historical data and
exact-head CI remain with the coordinator; none is inferred from local checks.

## Review round 5: S850-R4-1 legacy cashflow exactness

This section supersedes round 4's decision to leave the legacy IN/OUT totals
unchecked. Starting HEAD was `158690502674f1bd10257286ce0defba45179e84` on
`claude/scrum850-opening-correction`, in `E:/tmp/auto-850`. Fetched origin/main
was `95ffa13e91e9c619336ac9d4274c560d3b132121`, zero behind. The coordinator
owns Jira, GitHub and independent seats. This lane performs no external posts,
push, browser tests, deployment or production reads.

### Invariant, reproduction and reviewer differences

A financial comparison returns exact monetary totals or refuses with a coded
error. A rounded total must not be returned as complete. Both review reports
were read first. Seat 1 LOW-A and Seat 2 S850-R4-1 identify the same lines.

The independent new file is
`convex/accountingCutoverLegacyExactness.scrum850.test.ts`. It calls the registered
public query with an authorized same-org identity, JOD configuration and three
retained synthetic rows. All IN, and separately all OUT, use major amounts
`4503599627370.496`, `4503599627370.496`, `0.001`. The safe converted minor
operands are `4503599627370496`, `4503599627370496`, `1`. Their exact mathematical
total is `9007199254740993`; the red query resolves with `9007199254740992`.
No GL event is seeded, so GL overflow cannot accidentally satisfy the refusal.
Fixture setup is outside the rejection assertion.

Failing-first commit `79260cee658a894ab55eec20f6143839af93df01` contains all twelve
literal named tests and no production fix. Its full-file run is recorded in
`%TEMP%/s850-r5-red-79260cee6.log`:

```text
pnpm exec vitest run --maxWorkers=1 convex/accountingCutoverLegacyExactness.scrum850.test.ts
Test Files 1 failed (1)
Tests 2 failed | 10 passed (12)
exit 1
```

The failures are IN and OUT coded-refusal expectations resolving with rounded
values. The ten controls pass: ordinary exact `3003`, safe-boundary exact
`9007199254740990`, and independently a large row before the start, after the
end, or soft-deleted, for each direction. The exclusion fixtures include both
date endpoints and would overflow if the excluded row participated. Both totals,
transaction count and unmigrated count are checked.

I agree with the reviewer's minimal fix. Both legacy totals reuse
`addCutoverMinor`; the existing code `CUTOVER_UNSAFE_TOTAL` truthfully identifies
the failed cutover aggregate. No helper, error code, schema or API shape is added.
The existing error's journal-oriented follow-up advice is retained. My proof
adds separate lower-date, upper-date and deletion controls for both directions,
with a retained safe boundary rather than only ordinary filtered amounts. The
legacy public writer is retired, so fixtures explicitly seed retained history;
this does not claim an enabled current writer or production prevalence.

`engineering-principles` changed the scope decision: the complete module was
swept rather than treating safe row conversion as proof of safe aggregation.
`correct` applies to the repeated unchecked gross-total class: round 4's journal
consumer and round 5's distinct legacy cashflow consumer. Shared checked
arithmetic and public regression tests are the scoped prevention. A new storage
representation or repository-wide lint is outside this authorized module repair.

### Module arithmetic census

Scope is the whole tracked `convex/accountingCutover.ts` at fixed-code line
numbers, not a ranked subset. Literal searches covered `+=`, `-=`, `reduce(`,
`+ `, ` - ` and `addCutoverMinor`; a TypeScript AST walk enumerated every binary
addition/subtraction/compound addition/subtraction and every reduce call. Graft
located the query but cannot resolve registered-export caller edges. Literal
tracked-source enumeration supplements it.

| File:line | What is computed | Exactness verdict and change |
| --- | --- | --- |
| `convex/accountingCutover.ts:159-166` | Shared cutover addition wrapper | Delegates to `addBalanceMinor`, checking both operands and result with Number.isSafeInteger; translates only its known error. Unchanged. |
| `convex/accountingCutover.ts:206-207` | Per-currency retained POSTED/REVERSED journal gross debit and credit | Both checked by `addCutoverMinor`. Unchanged; R4 suite rerun. |
| `convex/accountingCutover.ts:287-288` | Entered opening debit and credit totals | BigInt accumulation of individually safe operands. Exact; unchanged. |
| `convex/accountingCutover.ts:336` | Opening suspense difference | BigInt subtraction, then Number conversion after gross cap. Valid nonnegative admitted sides fit the safe range; invalid negative lines still fail journal admission. No cumulative Number sum; unchanged. |
| `convex/accountingCutover.ts:1672` | Legacy IN cashflow total | Reproduced unsafe cumulative Number addition; changed to `addCutoverMinor(legacyInMinor, minor)`. |
| `convex/accountingCutover.ts:1673` | Legacy OUT cashflow total | Reproduced unsafe cumulative Number addition; changed to `addCutoverMinor(legacyOutMinor, minor)`. |
| `convex/accountingCutover.ts:1694-1695` | Migrated transaction GL gross debit and credit | Both checked by `addCutoverMinor`. Unchanged; R4 suite rerun. |
| `convex/accountingCutover.ts:470,664,1603,1761` | Draft version, line ordinal, result multiplicity, unmigrated row count | Counters rather than money. Unchanged. |
| `convex/accountingCutover.ts:1802-1805` | Refusal explanation | String concatenation rather than money. Unchanged. |

The AST census finds no reduce call or other Number addition/subtraction in this
module beyond the rows above. Unary signs on the suspense difference select a
single amount; they do not aggregate money. No unchecked cumulative Number money
total remains in this module under this enumeration.

Observed siblings outside scope, unchanged and not claimed as newly reproduced
bugs: `convex/financialAudit.ts:247-248` manual-journal reduce totals;
`convex/accounting/postingRules.ts:431` contra accumulation, `:2635` net delta,
and `:3617-3618` journal gross totals. Those call paths and their upstream bounds
need their own investigation by the coordinator. This is not a repo-wide census.

### Impact and self-attack

| Area | Disposition |
| --- | --- |
| Writers and historical data | Query only. Retained rows are read, not rewritten. No historical repair. |
| Readers | Only legacy comparison totals change on unsafe histories. Successful shape and currency warning remain. |
| State transitions, reversal and idempotency | No transition, spend, schedule or reversal door is introduced. Repeated reads remain reads. |
| Authorization and tenant isolation | Existing MANAGE_FINANCE check and transactions.by_org scope retained. No supplied document id or permission change. Tenant guard rerun. |
| Ledger and audit | No GL, snapshot or audit writer is edited. Existing sign-off/listSignOffs and opening/void tests rerun. |
| UI and E2E | No UI edit. Serial public-query harness evidence only; no browser verification. |
| Runtime and release | No deployment, cloud/OCC, real-data or pilot-certification claim. Independent seats and exact-head CI remain with the coordinator. |

Five predicted failure modes are checked: a missing IN guard; a missing OUT
guard; over-refusal of ordinary/safe-boundary totals; aggregation before date
filtering; aggregation before deletion filtering. Each has a named public-query
test. The first two also receive source mutants after committing the fix.

### Execution record

The first fixed-file run passed all twelve tests (exit 0), log
`%TEMP%/s850-r5-first-green.log`. Required complete named-file batches, final-HEAD
green, mutants, typechecks, lint, validators and contract renewal results are
recorded below after execution. No pending measurement is counted as passed.
