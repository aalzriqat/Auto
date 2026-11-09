# SCRUM-850 round 3 implementation evidence

Round 4 follow-up for S850-R3-1 is recorded in
[`scrum850-round4-evidence.md`](scrum850-round4-evidence.md), including the
independent reproduction, journal-attestation census and failing-first commit.

Worktree `E:/tmp/auto-850`, branch `claude/scrum850-opening-correction`.
Starting head `25ccde56cbf913c16eaceb6767a07b3abc4a0c73`; supplied PR base
`8909b88892292a99d055be8b8fe5b23a437b6a21`. The fresh fetch found origin/main
one commit ahead. This lane neither merged it nor asserted current-main parity.
The coordinator owns Jira/GitHub and the independent review seats. No external
posts, push, deployment, production access or backend-connected Playwright run.

## Invariant and design

Every stored snapshot gross total and every balance built from it is exact, or
the mutation refuses atomically, or the reader reports UNAVAILABLE/refuses.
Gross operands must be checked before subtraction: an unsafe stored debit can
produce a deceptively safe net. Each cumulative and cross-account addition must
also be checked before another operation can hide its rounding.

Containment preserves Number fields and the eight shard-local counters. The
writer checks both proposed totals before its patch/insert. Its coded
`ACCOUNT_SNAPSHOT_UNSAFE_TOTAL` ConvexError escapes the transaction. Existing
EN/AR error localization carries the clean message. Reader accumulators use the
same checked arithmetic and reuse existing result contracts. BigInt storage
would require schema/API migration, and converting a rounded historical Number
would not restore its lost unit. No schema change or sealed-period rebuild.

Difference from Seat 2's advisory option A: no additional global gross-headroom
preflight on opening admission. Safe shard-local writes may coexist with an
unrepresentable cumulative report; the report then refuses. This satisfies the
owner's explicit exact-or-UNAVAILABLE choice while preserving shard-local OCC
contention and existing indexed reads. A global admission check would add a
different contention/read policy. Seat 2 correctly identified both arithmetic
defects; fixing only statement output would leave persistently rounded shards.

The blast-radius advisory was read-only and was not an independent review seat.
Its design attack identified cross-account sums, historical unsafe operands and
catch boundaries; these were traced in production source and included below.

| Impact area | Decision / evidence boundary |
| --- | --- |
| Writers | One numeric writer, five production callers; census below. |
| Readers | Four shared APIs plus the separate bank reader and downstream report arithmetic; census below. |
| Historical data | Unsafe gross operands refuse, including safe-looking nets. Already-lost precision is not repaired. |
| State transitions | Approval, direct posting, governed void and replacement keep their existing state/version checks. |
| Reversal | Opposite-side postings still retain original history; an unsafe reversal refuses atomically. |
| Idempotency | No new command identity or retry path; existing posting/outbox/reversal controls rerun. |
| Authorization | No grants or pilot flags changed; existing manual-journal disabled control retained. |
| Tenant isolation | Existing organization-indexed reads retained; tenant guard rerun. |
| Ledger | Snapshot failure must roll back journals and aggregate-trigger effects too. |
| Audit | Whole-database refusal comparison includes audits and scheduled functions. |
| UI | Exact formatter replaces the vehicle-selection prefill conversion; mounted boundary test. Other LOWs left alone. |
| E2E | Local public-function harness and component fixtures only; no browser/backend run. |
| Runtime/release | Serial harness cannot prove real OCC, cloud limits or release certification. |

## Findings independently validated

S850-R2-1: the test-only commit is
`adc6ec810ed7c8747dab3519b07034657b77ec50`. A detached proof worktree ran that
exact commit, with no production fix. The registered opening sequence posts
`9007199254740991`, voids it and replaces it with `9007199254740990` on a distinct
shard. Trial balance resolves with a rounded figure instead of refusing. The
same-shard replacement also wrongly succeeds instead of refusing; its proposed
gross debit is mathematically `18014398509481981`, which Number addition cannot
represent exactly. An elapsed-period reproduction resolves with
`9007199254740992` for the exact `9007199254740993` sum. The ordinary
`200003 -> void -> 200002` control passes.

The expanded red run also fails the cross-account, historical unsafe-operand,
reconciliation UNAVAILABLE and vehicle-prefill cases. The vehicle field renders
`9007199254740.990` instead of the expected `9007199254740.991`. Only randomness
is pinned; registered handlers and project business helpers are not mocked.

N1: `git show 72f92b1d9:convex/openingBalanceMaintenance.scrum850.test.ts`
shows `test.each(["approve", "reject"])` with a `%s` template. The actual
registered approve/reject names differ from the later literal `%s` registration.
The legacy scenario now binds to the approve expansion, with only the approve
step and expectations. A companion rejection record binds the reject expansion
and its own step/expectations; both decisions remain explicit tests. The tamper scenario is a preventive control and now has no
`bugRef`. Round-2 claims in `scrum850-round2-evidence.md` that all these records
proved red are superseded by this correction. No assertion was weakened.

Independent historical run at `72f92b1d9b908ad7290843fd31632aafda340372`:
`-t 'SCRUM-850 F1 tampered reversal|SCRUM-850 F2 legacy'` gives **2 failed,
1 passed, 34 unrelated filtered**. The tamper control passes; the approve and
reject expansions both fail because their promises resolve. Output is
`%TEMP%/s850-r3-n1-historical.log`. This validates both N1 dispositions against
the original commit, rather than relying on the reviewer narrative.

The F1 reconciliation test now has an explicit 20-second timeout, matching the
slow-test style in its file. `replaceAll("٫", ".")` resolves S7781 without
changing the parser's accepted input. Existing Arabic/Persian parser controls
remain the behavioral check. Display-only float-format LOWs remain outside this
round's requested prefill fix.

## Snapshot writer census

Scope: tracked production TypeScript under `convex/`, excluding tests/generated
declarations, searched for both gross fields, snapshot table accesses and
`incrementAccountSnapshot` references. Graft caller graph was checked against
the source. These are source observations, not production-data prevalence.

| File:line (round-3 source) | What it writes | Verdict / change |
| --- | --- | --- |
| `convex/accounting/accountSnapshots.ts:41,67-85` | Sole numeric patch/insert of both running gross fields | Both operands and both new totals checked before either snapshot write. |
| `convex/accountingCutover.ts:667` | Opening approval/direct posting | Shared writer; no caller patch. Phase18 and maintenance controls. |
| `convex/financialAudit.ts:567` | Manual journal approval | Shared writer; enabled-build Phase18 control plus shipped pilot-off tests. Production switch unchanged. |
| `convex/accounting/postingEngine.ts:740` | Accounting-event posting | Shared writer; Phase18 and outbox atomicity. |
| `convex/accounting/reversals.ts:381` | Generic event reversal | Shared writer; Phase18 and reversal/bank tests. |
| `convex/openingBalanceMaintenance.ts:99` | Governed opening void | Shared writer; ordinary and all-family maintenance tests. |
| `convex/orgFinancialReset.ts:89,324,333,451` | Table deletion/reference metadata | No numeric writer; reset suites rerun. |
| `convex/schema.ts:5792-5793` | Declares Float64 fields | Unchanged; schema does not enforce integer exactness. |

The outbox posting call is outside its catches. Migration catches a child
`ctx.runMutation` failure, after the child rolls back. `openingChangeBoundary`
rethrows ConvexError. Existing atomicity suites measure serial behavior; this
source trace does not prove every possible live indirect caller or OCC schedule.

## Snapshot reader census

Line references below identify the reviewed operation (some downstream lines
move when catch blocks are added). Each row distinguishes source inspection from
the named executable evidence rather than claiming a boundary reproduction for
every public report.

| File:line / reader | Sum | Existing refusal and change |
| --- | --- | --- |
| `convex/accounting/accountSnapshots.ts:104` cumulative | Shards, periods and partial-period lines per account/currency | Coded ConvexError; shared `balanceAdder:498` checks each gross operand/addition. Public replacement/period tests. |
| Same `:121` bounded | Same sum with read budget | Exact-code catch returns existing `OVER_LIMIT`, no partial balances. Employee-advance public control. |
| Same `:199` checked | Same sum plus reference verification | Same `OVER_LIMIT`; supplier-payables public control. |
| Same `:621` control | Account-scoped shards/periods/lines | Same `OVER_LIMIT`; supplier-receivables public control. |
| Same `:391,722` feeds | Stored runningDebitMinor/runningCreditMinor | Both feed the checked shared adder; no separate unchecked accumulator. |
| `convex/accountingReports.ts:264,277,326` trial balance | Cumulative/ranged gross, then currency gross across accounts | Checked shared/ranged/currency additions; clean coded refusal. Replacement and cross-account tests. |
| Same `:481,526-536` balance sheet | Snapshot balances, type totals, P&L, equation | Every category sum and equation addition checked; clean coded refusal. Live/elapsed and ordinary controls. |
| Same `:1446,1532` supplier payables | Gross checked read, then net across control accounts | Checked currency adds; existing `verifyOpeningRead` maps exact code to UNAVAILABLE/OVER_LIMIT. |
| Same `:1963-1971` GL reconciliation helper | Bounded gross read, then control-account net by currency | Checked net adds; same exact-code boundary returns existing UNAVAILABLE/OVER_LIMIT for advance/recoverable/partner readers. |
| Same `:1983` opening suspense | Checked control-account gross, net | Non-OK already becomes existing UNAVAILABLE; shared check supplies refusal. |
| Same `:2705-2744` supplier receivables | Control gross, then cross-account net and discrepancy | Checked sums; exact-code catch returns existing UNAVAILABLE/OVER_LIMIT with complete:false. |
| Same `:3053,3091` customer deposits | Cumulative gross, then cross-account credit minus debit | Checked adds; exact-code catch returns existing UNAVAILABLE/OPENING_SOURCE_UNAVAILABLE. No new result contract. |
| Same `:3211-3219` commission payable | Cumulative gross, then cross-control-account net | Checked sums; existing clean query-refusal style. |
| Same `:882` comparison | GL minus subledger | Checked subtraction; callers retain their existing refusal boundary. |
| `convex/accountingPeriods.ts:533` checklist | Shares bounded GL read and reconciliations | Inherits existing UNAVAILABLE warnings or clean reader refusal; no rounded figure admitted. No caller edit needed. |
| `convex/accountingLedger.ts:269,294,313,324-328` activity | Snapshot opening + preceding same-date gross + page/running totals | Each addition checked; clean coded refusal, unchanged ordinary pagination contract. |
| `convex/vatReport.ts:67,77,88,92,101` VAT | Cumulative/ranged gross, currency output/input and net due | Every arithmetic combination checked; coded refusal. Cumulative overflow public control. |
| `convex/bankAccounts.ts:388-397,412,422,431` bank | Snapshot gross across shards/periods, current aggregate net, attribution and residual | Both gross sides checked before netting; all later sums checked. Existing BALANCE_HISTORY_INCOMPLETE/null response reused. |
| `convex/accountingReports.ts:2472,2540` | Snapshot existence probes | No numeric sum; unchanged. |

`verifyOpeningRead` catches only the specific coded numeric refusal in addition
to its existing typed read-headroom refusal. Programming errors still escape;
no write boundary catches this error and returns success.

## Self-attack predictions

1. Same-shard refusal could leave a journal, audit or scheduler effect: compare
   every schema table plus `_scheduled_functions` before/after registered approval.
2. Different shards could bypass the write guard: public report must refuse the
   cumulative gross sum, including the elapsed-period snapshot path.
3. An unsafe stored operand could cancel to a safe net: retained-operand control.
4. Safe per-account totals could overflow across accounts: statement control and
   checked downstream currency/category aggregations.
5. A shared exception could change reconciliation availability contracts: assert
   existing status/reason/complete:false and empty results on public readers.
6. Ordinary event, reversal, manual and opening postings could be broken: rerun
   all five writer controls, while preserving the manual pilot-off test.

## Verification record

No unmeasured property is labelled PASS. Every Vitest command names files and
uses `--maxWorkers=1`. Initial larger groups were interrupted for thermal cost;
their partial output is not counted as a passed suite. Individual reruns below
are the evidence for the completed checks.

Initial authoring run: backend defects failed as intended; the first component
attempt failed on its missing localStorage fixture. The fixture was corrected
before committing the red tests. No fixture failure is counted as red evidence.

Committed red proof in `E:/tmp/auto-850-r3-red`:

```text
git rev-parse HEAD: adc6ec810ed7c8747dab3519b07034657b77ec50
pnpm exec vitest run --maxWorkers=1 convex/openingBalanceMaintenance.scrum850.test.ts components/accounting/setup/OpeningAllocationVisualFixture.test.tsx -t 'SCRUM-850 R3'
Test Files 2 failed (2)
Tests 6 failed | 1 passed | 39 skipped (46)
```

The skipped tests are unrelated name-filtered cases. Red output:
`%TEMP%/s850-r3-red-adc6ec810.log`. Full maintenance and visual-fixture green
before mutation: 46 passed, 2 files. The first backend typecheck found an async
callback typing error in a new test; it was corrected before the final check.

| Check | Measured outcome |
| --- | --- |
| New red cases at `adc6ec810` | 6 failed, ordinary control passed; 39 unrelated filtered, 2 named files. |
| Historical N1 at `72f92b1d9` | 2 legacy variants failed, preventive tamper passed; 34 unrelated filtered. |
| Full maintenance + visual fixture before mutants | 46 passed, 2 files. |
| Writer/reset/tenant batch | 120 passed, 8 files; named below. |
| Supplier payable readers | 57 passed, 3 files; named below. |
| Supplier receivables/references/suspense | 159 passed, 3 files; named below. |
| Bank/ledger/VAT readers | 104 passed, 4 files; named below. |
| Regression validators, initial 7-file batch | 378 passed, 1 fingerprint failure. The failure was the new vehicle record's hand-computed fingerprint; regenerated with the unchanged validator's own functions. No validator changed. |
| Complete scenario library after fingerprint correction | 70 passed in scenarioRecord.test.ts. Final repeat covers the split N1 and parser-control records. |
| `pnpm typecheck` | Completed without diagnostics. Root application roots exclude convex, test-utils, apps, packages and dealer-worker; imported dependencies are still followed. |
| `pnpm typecheck:convex` after callback fix | Exit 0. Includes convex/** and test-utils/**; generated files excluded as roots, imported declarations still followed. |
| ESLint on 13 touched TS/TSX files | 0 errors, 1 pre-existing no-explicit-any warning at OpeningAllocationEditor.tsx:178. The same `as any` is at starting-head line 177. Other LOWs intentionally unchanged. |
| Contract identity | 945 matched; no call moved, so no relocation tool needed. |
| Contract renewal after individual notes | 945 checked; 0 unrenewed, stale, malformed or missing. |
| Contract census standalone | 29 passed. |
| Contract clientPaths standalone | 232 passed. |
| Complete openingClosureReaders.scrum858.test.ts standalone | 88 passed, including both large range fixtures and snapshot close controls. |
| Restored full maintenance | 43 passed after both mutants. |
| Restored visual fixture + fee parser | 20 passed, including all 3 visual fixture tests (EN, AR, boundary prefill) and 17 parser/form tests. |

ESLint was measured through the installed ESLint API. A temporary adapter
accepts either the installed Convex plugin's flat recommended array or its
legacy recommended object, preserving the recommended rules and overrides. The
first attempted legacy-only adapter failed on a flat-config import. No repo
lint config was edited; the final temporary config was removed. This is local
lint evidence, not a SonarCloud verdict.

Named writer/reset/tenant files:

```text
convex/accountingPhase18.test.ts
convex/manualJournalsPilotOff.scrum795.test.ts
convex/manualJournalsPilotOffControl.scrum795.test.ts
convex/accountingOutboxAtomicity.test.ts
convex/accountingReversalBankIdentity.test.ts
convex/orgFinancialReset.test.ts
convex/orgFinancialResetNarrow.scrum565.test.ts
scripts/tenantWriteGuard.test.ts
```

Phase18 proves ordinary posting, reversal, manual approval and opening approval
through each of the four shared callers. Its existing enabled-build leaf mock
is unchanged. Maintenance's ordinary void/replacement covers the fifth caller.
The separate pilot-off file confirms the shipped manual door remains disabled.

Named reader files:

```text
convex/supplierPayablesReconciliation.scrum651.test.ts
convex/supplierPayablesReconciliation.scrum876.test.ts
convex/supplierPayablesReconciliation.scrum876.opening.test.ts
convex/supplierReceivablesReconciliation.scrum869.test.ts
convex/reconciliationOrgReferences.scrum889.test.ts
convex/openingSuspense.scrum858.test.ts
convex/openingBankReconciliation.scrum858.test.ts
convex/bankAccounts.test.ts
convex/generalLedgerPagination.test.ts
convex/vatReport.test.ts
```

The seven validator files were `scripts/regression/`'s `scenarioRecord.test.ts`,
`localExecution.test.ts`, `pilotDoorAnalysis.test.ts`, `pilotDoorInventory.test.ts`,
`prRunner.test.ts`, `refreshRulings.test.ts` and `implFixture.test.ts`. The protected
local refreshRulings test edit was exercised as supplied, never modified/staged.
The six non-library files passed in the initial batch; the library's corrected
standalone run is separately recorded, rather than relabelling the first batch.

The first combined four-file post-mutation repeat ended with exit -1 and no
test summary. It is not a pass. Its named files were rerun in the smaller
successful groups above. The interrupted initial reader/contract groups are
likewise superseded only by the complete standalone/bounded-group results,
never by inference from their partial logs. No assertion, test threshold,
authorization, scenario validator or production gate was weakened.

A later library repeat rejected literal Arabic input strings under the
repository's ASCII-token rule. The parser record now names those existing
synthetic fixtures with short tokens; its bound test contains and executes the
actual Unicode strings. Expected minor units are the test's literal 12500 and
grouping remains refused. The validator was not broadened to admit prose or
Unicode. This initial schema failure is not counted as a pass.

### Mutation checks

Mutants were applied after source commit `36e35b09752522f929bbbd82e0b39fa2c898d436`
(baseline-only head `533fb90bf`). Only `convex/accounting/accountSnapshots.ts`
was edited. Both runs restore with `git checkout HEAD --` that explicit path;
both scoped `git status --short --` outputs were empty afterward.

| Mutant | Detection |
| --- | --- |
| Replace both writer checked additions with unchecked addition | Unsafe replacement wrongly succeeds: 1 failed, 42 unrelated filtered; exit 1. `%TEMP%/s850-r3-mutant-writer.log`. |
| Replace both shared reader gross additions with unchecked addition | Replacement statement and reconciliation contract tests fail: 2 failed, 41 unrelated filtered; exit 1. `%TEMP%/s850-r3-mutant-reader.log`. |

### Contract evidence

`checkBaselineIdentity.mjs` matched all 945 identities before renewal. There are
no moved calls, so relocation was unnecessary. The required check command was:

```text
node scripts/contractSkew/renewBaselineReviewed.mjs --reviewed c82890bd --check-evidence --pr-base 8909b88892292a99d055be8b8fe5b23a437b6a21
```

It initially found exactly 15 stale entries: nine bank-create properties, four
statement dates and two VAT dates. Each was reviewed individually against its
unchanged client call and the modified backend declaration module. Appended
notes end with current client/backend `evidence-blobs`. Only renewal strings
changed, in two baseline files. No entry/fingerprint/expiry/extractor was
weakened; no renewal write mode was used. After committing those notes as
`533fb90bf`, the check reports 945 checked, 0 unrenewed, 0 stale, 0 malformed,
0 missing. These are implementer source reviews, not seats or live extraction.

## Official sources and limits

Freshly read for this round:

- [ECMAScript MAX_SAFE_INTEGER](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-number.max_safe_integer)
  and [isSafeInteger](https://tc39.es/ecma262/multipage/numbers-and-dates.html#sec-number.issafeinteger): safe bounds apply to operands and accumulated results.
- [Convex data types](https://docs.convex.dev/database/types) and
  [validators](https://docs.convex.dev/functions/validation): `v.number()` is Float64, not an exact-integer guarantee; Int64 is a distinct schema/API type.
- [Convex application errors](https://docs.convex.dev/functions/error-handling/application-errors): structured clean refusal with ConvexError; mutation failure must propagate.
- [Convex OCC/atomicity](https://docs.convex.dev/database/advanced/occ): transaction rollback and serializability are platform guarantees, not concurrency proof supplied by convex-test.
- [ECMAScript replaceAll](https://tc39.es/ecma262/multipage/text-processing.html#sec-string.prototype.replaceall): literal all-occurrences replacement preserves this parser normalization.

No live historical-data prevalence, cloud/OCC scheduling, independent seats,
SonarCloud verdict, authenticated phone/desktop EN/AR audit or release
certification is claimed. No API module was added; `convex/_generated/api.d.ts`
was neither regenerated nor staged. The three protected local edits remain
outside the commits. This work does not enable a deferred financial operation.

## Commits and changed paths

History order before the final evidence commit:

| Commit | Change |
| --- | --- |
| `adc6ec810ed7c8747dab3519b07034657b77ec50` | Test-only red cases, N1 explicit test names and F1 timeout. |
| `36e35b09752522f929bbbd82e0b39fa2c898d436` | Checked snapshot writes/readers, exact prefill, parser method, localization, ADR/matrix and initial scenario records. |
| `533fb90bf682cf658009c95cc86864eb5b1a8796` | Only 15 individual renewal strings in two contract baseline files. |
| `4edb2e5580ae334cc6afc03c34a97d4602aafb7d` | Separate approve/reject scenario bindings, six truthful new bugRef entries, parser preventive record and matrix corrections. |

The final evidence commit also records explicit primary-test shard steps and
uses allowed fixture tokens in the parser record. All subjects end `(SCRUM-850)`
and all commits carry the requested Codex co-author trailer. Nothing was pushed.

Changed-path enumeration for this round (29 paths against starting head):

```text
components/accounting/setup/OpeningAllocationEditor.tsx
components/accounting/setup/OpeningAllocationVisualFixture.test.tsx
convex/accounting/accountSnapshots.ts
convex/accountingLedger.ts
convex/accountingReports.ts
convex/bankAccounts.ts
convex/openingBalanceMaintenance.scrum850.test.ts
convex/utils/errors.ts
convex/utils/money.ts
convex/utils/openingSourceIdentity.ts
convex/vatReport.ts
docs/adr/2026-11-08-opening-balance-edit-void-correct.md
docs/architecture/scrum486-certification-oracle.md
docs/architecture/scrum850-round3-evidence.md
lib/financeFeeTemplateForm.ts
lib/i18n/domains/common.ts
regression/scenarios/money/opening-maintenance-legacy-decision-refuses.scenario.json
regression/scenarios/money/opening-maintenance-legacy-rejection-refuses.scenario.json
regression/scenarios/money/opening-maintenance-tampered-void-readers-refuse.scenario.json
regression/scenarios/money/opening-money-arabic-separator-preserved.scenario.json
regression/scenarios/money/opening-snapshot-cross-account-containment.scenario.json
regression/scenarios/money/opening-snapshot-ordinary-replacement.scenario.json
regression/scenarios/money/opening-snapshot-period-overflow.scenario.json
regression/scenarios/money/opening-snapshot-reader-unavailable.scenario.json
regression/scenarios/money/opening-snapshot-replacement-exactness.scenario.json
regression/scenarios/money/opening-snapshot-writer-atomic-refusal.scenario.json
regression/scenarios/money/opening-vehicle-prefill-exactness.scenario.json
scripts/contractSkew/needs-evidence-baseline/components+accounting+=bank=accounts=tab.tsx.json
scripts/contractSkew/needs-evidence-baseline/components+accounting+=financial=reports=tab.tsx.json
```

A durable gross-exactness lesson was recorded in the owner's memory folder,
with a pointer in its MEMORY.md. Those personal-memory files are outside the
repository commits. The detached proof worktree is retained at
`E:/tmp/auto-850-r3-red` (last used for the historical N1 run).
