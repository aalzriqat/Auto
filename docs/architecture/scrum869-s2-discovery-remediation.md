# SCRUM-869 S2 discovery remediation

## Round 5: current implementation and evidence

Round 4 history discovery (the inventory of every org journal line) and its read-budget figures below are superseded by this section.

Invariant: every GL account that the product can classify as a supplier-recoverable asset and that holds GL evidence (a journal line or a closed-period snapshot) is either compared or the report refuses; the evidence that decides this is independent of the posted opening journal and its retained header, and its cost follows the chart of accounts, never the age of the organization's journal.

Both round-4 seat reports were read; each finding was reproduced before coding (proposed fixes were advisory).
- H2 (Seat 2, HIGH), validated by reproduction at baa40b01f: (i) delete the supplier journal leg and remove it from the retained header; (ii) swap the supplier account to cash in both the leg and the header. Both returned AVAILABLE and reconciled while the omitted account's 100,000 snapshot survived. A header that agrees with the live legs only shows that two altered records agree. Severity note: Seat 1 rated the same repro LOW because it needs two records altered consistently; the fix was built anyway because the report's whole purpose is to catch a ledger that no longer agrees with itself.
- M1 (both seats, MEDIUM, blocking), validated: at 27,000 unrelated lines the report returned UNAVAILABLE (OVER_LIMIT); with 2,000 lines carrying 9,000-character descriptions the harness (transaction limits on) logged "Read too much data in a single function execution (limit: 16777216 bytes)" and the public query returned the generic error.

Impact map (changes only the discovery of compared accounts): writers of journalLines and snapshots are unchanged and untouched; the only reader changed is `discoverSupplierReceivableGlAccounts`, whose single caller is `computeSupplierReceivablesReconciliation`; no schema, index, writer, UI, permission or return-validator change; no backfill; historical rows are read as they are; reversal, retry and idempotency are not applicable (read-only report); tenant isolation holds (every read is `orgId`-scoped and an account of another org refuses).

Design. `openingPolicyForAccount` is the one authority the opening writer uses, and it classifies every custom (no systemKey) ASSET account, as well as canonical 1240, as SUPPLIER_RECOVERABLE. Discovery now reads the chart's ASSET accounts through `by_org_type` (at most 100, else OVER_LIMIT) and, for each such account not already compared, makes two one-row probes (journal line, balance snapshot; at most 30 accounts, else OVER_LIMIT). Any evidence on an uncompared account refuses with OPENING_SOURCE_UNAVAILABLE. The opening journal's lines must also balance (debits equal credits as safe integers), which refuses a journal that lost a leg even when no snapshot survives. The two recovery-family inventories and the `journalLines.by_org` scan are removed; both orphan-family tests still pass because their custom asset account is now caught by class.

Options weighed (Convex indexes: https://docs.convex.dev/database/reading-data/indexes/ , limits: https://docs.convex.dev/production/state/limits):
- (a) Stamp a family tag on each journal line with an index. Selective and exact, but a schema change with a deploy-time index backfill, a write per posting on the hottest table, and fail-closed handling of untagged legacy lines. A one-way door; deferred.
- (b) A maintained count or a posting-time rule. Not independent evidence, and a refusal in a posting rule is not enforcement. Rejected.
- (c) Paginate across calls. Changes the public contract. Rejected.
- (d) Chosen: independent chart-class coverage. No schema change.

Production evidence (read-only counts, no row content): 5 organizations, each at most 4 journal lines, one recovery-receipt journal in total, zero custom ASSET accounts, 14 to 15 asset accounts per organization. Nothing in production is refused or limited by the new rules.

Trade-offs, stated rather than hidden:
1. An undeclared custom ASSET account that carries GL evidence refuses the report permanently (OPENING_SOURCE_UNAVAILABLE), even if it is, for example, petty cash and unrelated to suppliers. Bloom Cars has none. A narrower rule needs an explicit chart marker, a schema decision for the owner.
2. More than 30 uncompared custom asset accounts, or more than 100 asset accounts, give OVER_LIMIT.
3. The recovery-family account-set and family debit-equals-credit checks are gone. A family leg moved onto a non-ASSET custom account is not caught by class; a misposting still shows as a displayed difference whenever the subledger disagrees, but a coordinated offsetting forgery of both records remains a ledger-integrity concern outside this report.
4. The pilot-history assertion changed on purpose from "more than 18,000 documents read" (a measure of the old scan) to "fewer than 2,000", and the 3,000-receipt test also asserts ranges and documents stay under the Convex limits.

Five predicted failures and their status: a non-supplier custom asset account causes a false refusal (accepted, trade-off 1); the idle-account cap gives OVER_LIMIT (tested at 30 and 31); a family leg on a non-ASSET custom account is missed (accepted, trade-off 3); raising the discovery ranges to 160 breaks the worst-case bound (it is 3,895 + 160 = 4,055 ranges, below 4,096, asserted by the existing budget test); the balance proof wrongly refuses a legitimate multi-currency journal (opening lines are already forced to the journal currency, so the sums are of one currency).

Read budget: discovery allowance is a constant 1,000 documents and 160 ranges (it was 10,661 documents borrowed). Non-discovery reserves are unchanged at 21,239 documents and 3,895 ranges at the default caps. Static whole-report bound including the refusal sentinel: 31,901 documents (floor of the budget) and 4,055 ranges.

Measured in the convex-test harness (documents, ranges, JSON bytes of every document read by the computation):
- 27,000 unrelated lines: 23 documents, 21 ranges, 9,692 bytes (reviewed head: OVER_LIMIT from about 26,658 lines, 26,665 documents at 26,656 lines).
- 2,000 unrelated lines with 9,000-character descriptions: 23 documents, 21 ranges, 9,702 bytes (reviewed head: 18,769,196 bytes over 2,013 documents, Seat 2).
- Pilot fixture, 3,000 receipts and 3,000 reversals: 46 documents, 37 ranges (round 4: 18,039 documents, 41 ranges).
The byte test runs with `convexTestWithComponents(..., { transactionLimits: true })`, which enforces Convex's document, range and byte limits in the harness. This is harness I/O only: the real runtime, OCC and production data parity are not established.

Failing-first (red at baa40b01f with the new tests only): r5 H2(i), H2(ii), M1(a), M1(b) failed; the idle-account control passed. Green after the fix. Two source mutants each killed tests: removing the balance proof is killed by H2(iii); disabling the class-coverage refusal is killed by both orphan-family tests and H2(ii). Seven permanent scenarios and the oracle rows were added.

Shared primitive for the sibling PR #710 (not edited here): an indexed family tag on journalLines (an optional source type with an index on org, source type and journal entry), added with a bounded, resumable, idempotent backfill and a fail-closed path for untagged lines. It would serve #710's per-journal range finding and let both reports read recovery-family lines selectively. It is a one-way door (write amplification and an index backfill), so it needs an owner decision.

## Round 4: implementation and evidence (history discovery superseded by round 5)

Invariant: every supplier-recovery GL account, including surviving snapshots, participates in the independent comparison or the report refuses; ordinary pilot receipt/reversal history fits the bounded read strategy. No snapshot reconstruction or correction posting.

Both full reports at f10c54c58 were read. Independently reproduced before coding:
- HIGH: after allocation/recovery loss the correct 100,000 difference became an empty reconciliation when only the supplier journal leg was deleted. The independent snapshot consumer still returned 100,000.
- MEDIUM: real opening/expense/receipt reconciled at 220,000; adding 3,000 receipt journals and 3,000 reversals (two lines each, net zero, unchanged snapshots) caused OVER_LIMIT.
- Author attack: replace the supplier leg with an equal cash debit. Journal count and balance remain unchanged, but snapshot 100,000 disappears from old discovery. This also failed at the original head.
- M4 initially passed: retain the journal under a non-cutover/non-recovery source while deleting its referenced chart/lines/snapshots and recovery. This isolates the journal-presence retirement guard.

Opening discovery now proves the exact retained-header account/debit/credit multiset against GL lines, plus currency/date correspondence. Balance alone misses balanced loss/replacement. Missing header authority already refuses. Snapshot balances remain the balance source.

History discovery obtains both complete bounded family journal inventories, then joins them to one complete bounded journalLines.by_org inventory in memory. All POSTED/REVERSED family journals require nonempty balanced safe-integer line coverage and the existing account classification. Both orphan-family refusals remain. Unrelated org lines consume the budget too. A family stamp/index plus writer/backfill would improve selectivity but expands this report remediation into a migration. Raising the per-journal range cap cannot accommodate several thousand beside the GL/outbox worst case.

The historical 13-area impact map below applies except its runtime/discovery details, superseded here. No writer/schema/UI/permission/return-validator change. Existing reset retirement, all-compared-account drafts, generic logged error and coded refusals remain covered.

Five predicted failures: partial opening loss; balanced account replacement; history range exhaustion; retained journal falsely retired; batching drops an orphan family. New/existing tests cover them. Advisory design/Standards/Spec checks found no scoped blocker in restored source; they are not certification seats.

Read budget: caps remain rows 4,000 per subledger, in-flight/drafts 400 each, GL 2,400 documents, 25 opening proofs and 26 accounts. Discovery retains 100 ranges and borrows unused documents after reserving actual larger subledger/proof counts and full in-flight/GL caps. Missing allocations still reserve all 26 accounts. Per opening row: declaration basis <=105, recovery basis <=105, recovery reference scan <=101 =311, rounded to320 documents and24 ranges. Shared unique current parent plus <=201 cached lines reserves202 further documents. A contradictory parent refuses before another line inventory. Earlier canonical unique() bounds later system-account lookup in the same query snapshot.

At all default caps non-discovery reserves **21,239 documents / 3,895 ranges**; discovery may spend10,661 documents there. With fewer rows/proofs it borrows more. Every inventory uses remaining+one sentinel and refuses truncation. Static whole-report bound including sentinel: **31,901 documents / 3,995 ranges**, below32,000/4,096. Pilot fixture forwarded real harness I/O: **18,039 documents /41 ranges**, computation only (public auth excluded; absent get/unique/first charged as one document). This is harness I/O, not Convex platform limit enforcement. Bytes against16MiB, runtime, OCC and Date.now cache remain unmeasured. Total organization lifetime history can eventually exhaust this bounded inventory; no indefinite availability or family-selective I/O claim. LOW byte/runtime/cache, orphan-GL integrity, unused export, labels and maintainability stay SCRUM-879.

Failing-first reports: C:/tmp/714-r4-red.json (two intended assertion failures), C:/tmp/714-r4-red-replacement.json (one). Four source mutants each killed one new case: remove line-count proof; remove multiset identity check; restore per-journal line range; remove journal-presence retirement guard. Restored by file copy with SHA256 F08C6EF516FB8EFB6E314949EF449587EE50C1F86A9037958D00BD1D152169C5. Named restored suites **111/111** (87 A/R+24 A/P), zero skips, one worker; C:/tmp/714-r4-final.json. Four permanent scenarios/oracle rows. Definition validation461 records, zero problems (not461 executions). Convex typecheck and changed-file ESLint pass; convex/test-utils included, generated entry roots excluded, frontend/scripts projects not checked.

Official ACCA example1 and Convex limits/indexes linked below were fetched again. Sources support design, not implementation proof. Both final reviewer seats and /simplify remain pending. No certification, review-evidence JSON, PR merge, deploy or production verification. Recurrence prevention (correct): allocation-only and surviving-leg-only discovery both lost coverage; exact correspondence plus permanent corruption tests enforce the lesson.

## Historical round 3 packet (superseded above)

Invariant: the GL side is discovered independently of surviving supplier rows,
opening allocations and headers; lost current authority produces a difference or
UNAVAILABLE, while a completed financial reset retires its deleted authority.

## Impact map and design

| Area | Inspected surface and consequence |
| --- | --- |
| Writers | `accountingCutover.postOpeningBalanceDirect` / `openingAllocations`, `postingEngine`, `supplierCostRecoveryPosting`, `postingRules`; none changed. Journal entries store sourceType/sourceId, lines store their journalEntryId/accountId. |
| Readers | New report's `computeSupplierReceivablesReconciliation`, `openingRecoveryBasis`, `requireOpeningSettlementBasis`, `loadOpeningSourceIdentity`, `getControlAccountBalancesAsOf`; pending draft helper shared with A/P. Graft's caller graph includes module import edges; this is the scoped inspected reader set, not a claim that every graph node executes the new helper. |
| Historical data | Current live opening selected by GL journal identity. Retained headers checked for absent journal, referenced chart accounts, journal lines AND snapshots. Reference-only legacy stubs still supply recovery-id contradiction evidence. |
| Transitions | Current POSTED opening owns one header. Duplicate, reversed or unowned cutover authority refuses. Future openings use the journal's effective date for cutoff membership. |
| Reversal/unwind | Bounce, return, void, refund, cancel, reversal and merge gain no writer or new financial capability. Existing queued reversal and excluded-status tests remain; retained reversed opening authority refuses. Reset has real continuation-to-completion regression coverage. |
| Idempotency | Read-only query; no event, projection, key or retry writer introduced. |
| Authorization | Existing VIEW_FINANCE and accounting feature checks retained. |
| Tenancy | Queries scoped by org indexes; journal lines and chart accounts rechecked against the same org. Existing foreign-org/permission tests retained. |
| Ledger | Snapshot-aware balance consumer retained (ACC-2). Discovery uses source-family lines for identities, never to replace snapshot amounts. No A/R/A/P netting and no correcting entry. |
| Audit | Nothing persisted. Results expose existing coded refusal or complete per-currency difference. |
| UI | No client added or changed. Existing bilingual GL label and return validator preserved. |
| E2E | Backend report seam and real opening/reset writers in convex-test. Trusted authenticated PR check observed separately; local harness is not a real Convex/platform or screen audit. |
| Runtime/release | Indexed, bounded discovery: 1,000 extra documents (+ one over-limit sentinel), 100 ranges, and at most 1 + openingRecoveries compared accounts. Source identity adds a bounded 101-journal probe. Formula is a static upper-bound calculation, not measured byte/runtime I/O. No deployment. |

Options considered: another allocation scan cannot establish completeness;
refusing every retained header breaks completed resets; discovering GL account
identities and proving retirement addresses both. The existing #710 branch also
starts from opening journal lines, but its ABSENT-with-headers refusal is not
copied because it would retain the reset defect. No dependency on that branch.

The advisory design check identified two gaps before implementation: cap the
discovered account count used by the existing GL budget, and distinguish reset
from current journal loss using retained account identities. Both are included.
The source prefixes supplierCostRecoveries and supplierCostRecoveryReceipts are
scanned independently. Ordinary expense recognition uses expenses and canonical
1240; the two prefix scans do not inventory every supplier expense journal.
Unknown recovery-family account legs refuse instead of disappearing.

The final self-attack found that missing journal/chart metadata alone could
still coexist with retained GL lines or snapshots. Both cases falsely matched
at the first pushed head 4245efa21, and the snapshot-aware consumer independently
read 100,000 minor units. That head is superseded. Retirement now also requires
indexed absence probes for both GL storage paths, inside the same discovery
budget. The probe checks identity presence rather than a net total, so zero-net
residue also refuses. Advisory design and Spec rechecks found no scoped concern;
neither executed tests or certified the result.

Five predicted failures: lost allocations hide a balance; lost header hides a
balance; orphan recovery-family custom GL disappears; old reset headers poison a
fresh opening (or a missing current journal is wrongly called a reset); discovery
omits pending drafts or cutoff checks. The first four have dedicated corruption
or lifecycle regressions; existing custom-draft and future-cutoff tests remain.

## Finding validation

Both findings ACCEPTED; proposed fixes MODIFIED after independent reproduction.
On the clean main integration of cdc9ccf1, new tests retained and independently
read 100,000 minor units from GL after deleting allocation/header/recovery data.
Four cases falsely matched: allocation loss, header loss, and both orphan source
prefixes. Actual reset-to-completion returned OPENING_SOURCE_UNAVAILABLE. The
fresh-opening fixture initially tried to recreate a retained period; corrected
setup reuses it, and then failed for the same report refusal. Three additional
authority-loss/reversal/duplicate controls were already green before the fix.

Red runs: `C:/tmp/714-red.json` (5 intended assertion failures plus one corrected
setup failure), `C:/tmp/714-red-fresh.json` (1 intended assertion failure).
The advisory Standards/Spec checks found a valid-caller regression in the first
implementation: custom partner-capital equity was classified with the writer's
permission flag false and refused. A real opening with a custom equity
counterpart reproduced the refusal (`C:/tmp/714-red-capital.json`). Recognition
now includes the supported custom capital shape as outside A/R, independently of
allocation survival; no posting permission changes. The scoped advisory Spec
recheck found that concern addressed. These checks are not certification seats.

Mutation evidence: omitting `discoverSupplierReceivableGlAccounts` kills eight
of the nine original new cases, including all four false-match reproductions and
the three existing-green authority controls. Forcing retained-header refusal
kills both reset cases (including the ninth case). Restoring false for custom
capital recognition kills its new test. Each failure is an intended report
assertion, not setup/timeout. The source was restored from a saved file copy and
hash-checked. The mutations exercise the new discovery function and its refusal
path; the existing budget test still checks the expanded static formula.

The two retirement GL regressions failed first at the report assertion
(`C:/tmp/714-red-retirement-gl.json`). Omitting the GL-presence refusal kills both.

Named one-worker restored control: 107/107 (83 A/R + 24 A/P), zero skipped.
Twelve new permanent scenario records extend the oracle; the library definition
validator reads 457 records with zero problems. That does not claim 457 scenario
executions. Convex typecheck and changed-file ESLint pass. Convex includes
`convex/` and `test-utils/`, excludes generated entry roots, and does not check
the frontend or scripts project.
These are local convex-test evidence, not platform/OCC/production certification.

## Sources checked

- [ACCA FA1, example 1](https://www.accaglobal.com/content/dam/acca/global/PDF-students/fia/examreports/FA1/FA1%20examiners%20report%20spet-19-aug20.pdf): an error can affect the control account, the list of balances, or both. This supports independent comparison; report-only behavior is SCRUM-869 c23880 OQ-10.
- [Convex indexes](https://docs.convex.dev/database/reading-data/indexes/): source-prefix ranges and journal-entry indexes use maintained native queries.
- [Convex application errors](https://docs.convex.dev/functions/error-handling/application-errors): deliberate client-safe refusals are distinct from unexpected errors; existing generic error boundary retained.
- [Convex limits](https://docs.convex.dev/production/state/limits): document/range budgets are statically bounded; real-backend byte/runtime limits remain unmeasured (SCRUM-879).

Recurrence prevention (`correct`): #710's allocation-loss class (recorded in
`reference_reconciliation_account_discovery_is_independent.md`) and this round's
independently reproduced #714 failures demonstrate recurrence. The correction is
GL-based discovery plus permanent deletion/lifecycle tests, rather than another
instruction-only rule. Broader shared-helper/maintenance work stays in SCRUM-879.
