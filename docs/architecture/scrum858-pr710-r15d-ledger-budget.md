# PR #710 round 15d: cumulative ledger admission

Implementer starting point: `1de40ce6514903f918f8e04572095df98be80058`, branch `claude/scrum858-merge766`, worktree `E:\tmp\auto-710m`. Fetched `origin/main` was `075eaff37306f84b9b0400829aa90ffba3351a3f`, with zero missing main commits. The existing `.gitignore` and `.ignore` changes were excluded from staging.

Test-first commit: `bec120497b01a1c82e7d72c3c90604ae27476543`.

## Finding and invariant

Finding ACCEPTED. The public supplier recoverables query reproduces both transaction-limit failures after provenance succeeds. Proposed bounded-read remedy ADOPTED with an opt-in path through the existing calculation, rather than changing the legacy cumulative API.

Invariant: each opening reconciliation returns the complete authoritative balance or an unavailable result without a partial map. Snapshot selection, original/reversal inclusion, tenant checks, provenance verdicts, and close-warning acknowledgment retain their meaning. No posting, correction, migration, schema, permission, or economic formula changes.

The repeated class is admission of one phase followed by an unadmitted read phase. Earlier instances are the R11 document-limit history and R13 variable-size provenance payloads in `openingClosureReaders.scrum858.test.ts`; R15d reaches the cumulative GL after those protected phases. The structural prevention is one measured reader for the cumulative algorithm, plus the public regressions. A comment or another estimated bytes-per-document allowance would not prevent recurrence.

| Impact area | Scope decision |
| --- | --- |
| Writers | No new ledger or subledger writes |
| Readers | Opening families, payables GL, suspense, and the close composition enumerated below |
| Historical data | Retained periods preserve the journal fallback; elapsed/certified periods preserve snapshots |
| State transitions | Close still requires the existing warnings and owner authority |
| Reversal | Original and reversal postings both remain included; provenance unchanged |
| Idempotency | Read-only calls restart their budget; no economic event or retry identity is created |
| Authorization | Existing public finance/cost gates unchanged |
| Tenant isolation | Existing org indexes and checked parent ownership retained |
| Ledger impact | Complete sums or unavailable; no plug, correction, or truncated population |
| Audit trail | Existing close acknowledgment/audit path retained |
| UI consistency | Same result union and warning strings; no UI source changes |
| End-to-end flow | Public query and close mutation driven through convex-test |
| Release/runtime | No deployment; independent seats and real-backend proof remain separate |

## Red evidence

`pnpm exec vitest run --maxWorkers=1 convex/openingClosureReaders.scrum858.test.ts -t 'cumulative GL'` first found the range defect. The first byte fixture batch exceeded the write/setup transaction's read limit and was rejected as causal evidence. Its seeding batch was reduced to four pairs, without changing the population under test.

The corrected byte run used `-t 'cumulative GL.*bytes|cumulative GL small'`: one failed and one passed. The small-description control returned the literal correct balances. The independent range run failed as reported. Both standalone cumulative GL reads passed under `transactionLimits: true` before the full query failed.

| Failing public test | Server error | Public error |
| --- | --- | --- |
| `cumulative GL after provenance returns OVER_LIMIT without a partial balance ('bytes')` | `Read too much data in a single function execution (limit: 16777216 bytes)`, at `addEntryLines().collect()` | Generic unexpected-error `ConvexError` |
| `cumulative GL after provenance returns OVER_LIMIT without a partial balance ('ranges')` | `Too many index ranges read in a single function execution (limit: 4096)`, at `addEntryLines().collect()` | Generic unexpected-error `ConvexError` |

The tests require `UNAVAILABLE`, reason `OVER_LIMIT`, `isReconciled: false`, empty currencies and balance map, and no opening difference. They do not assert a throw.

## Census

Scope: the PR diff against fetched `origin/main`, its opening readers and the earlier readers composed by `computeCloseChecklist`; expanded with graft call edges and source occurrences. Locations below name the resulting source, not the original finding's offsets.

| Reader | Read composition and original gap | Result of this change |
| --- | --- | --- |
| `accountingReports.ts:1895`, employee advances | Metered subledger and provenance, then `glNetByAccounts` | GL periods, future probe, snapshots, entries, and lines have measured admission and one document/byte budget |
| `accountingReports.ts:1950`, supplier recoverables | Metered subledger and provenance, then `glNetByAccounts` | Same bounded GL path; both reproductions reach this public query |
| `accountingReports.ts:2022`, partner capital | Metered partners/movements, then `glNetByAccounts` | Same bounded GL path |
| `accountingPeriods.ts:530`, `SharedGlBalances` | Cached an unbounded full GL read | Caches both complete `OK` and `OVER_LIMIT`; a refusal cannot become an empty map |
| `accountingReports.ts:1310`, supplier payables | Count-bounded payable reads and bounded verification, but cumulative snapshots/entries/lines used `.collect()` | Explicitly opts into the measured cumulative scan; existing verification caps remain separate and unchanged |
| `accountingReports.ts:1883`, `openingSuspenseIsOpen` | Control reader bounded document count with `take`, but not bytes/range headroom | Opts into measured streaming/probes/parent reads; an incomplete result still means suspense is open |
| `accountingPeriods.ts:495`, close checklist and mutation | Earlier outbox, sales, draft, unmatched-bank, receivable, vehicle, commission and deposit reads compose with the opening readers | Added GL paths bounded. Existing warning text and acknowledgment flow retained. This is not a claim that every legacy checklist collector is bounded |
| Earlier AR/inventory GL reads, `getPostedLines` | Each collected all org lines before filtering to control accounts, concurrently | Checklist-only account-index projection avoids unrelated descriptions; default standalone behavior retained. The two legacy bulk parent-status `.collect()` reads are retained, avoiding a new range per journal; neither those parent populations nor arbitrarily large relevant line populations are certified as bounded here |
| Existing customer deposits and commission payable reconciliation callees | Their unchanged cumulative calls, plus their existing subledger collectors | Legacy paths unchanged. Their original unmetered populations are a remaining boundary, not certified as bounded here |
| Opening source proof, `openingJournalAccountTotals` | `take(101)` caps rows; it is not a byte/range admission guarantee | Provenance checks unchanged, as requested. Do not read the new GL guarantee as a guarantee about all source-proof reads |

The genuine close cutoff is `period.endDate`: that period is fully elapsed in the cumulative algorithm, even without its snapshot certificate. The journal reproductions therefore cannot truthfully be assigned to that same-period close read. Both resource fixtures also test the public close seam's snapshot totals. The byte fixture exposed a different earlier failure in AR/inventory's concurrent whole-ledger collectors. The supporting account-index projection fixes that earlier failure without changing the rows those consumers intend to sum.

A separate public close test exhausts measured headroom with two legitimate control histories. It checks the existing supplier recoverables unavailable warning, refusal without acknowledgment, and successful owner close after acknowledging the returned warnings.

## Two designs

**A, selected:** add `getCumulativeBalancesAsOfBounded` and pass its result through `SharedGlBalances` and `glNetByAccounts`. Reuse the existing cumulative algorithm with an optional `VerificationBudget`; every period, snapshot, entry, and line is charged using `getDocumentSize`. Before starting an iterator and before its next read, require live transaction headroom. The cumulative caps are 30,000 documents and 14 MiB; these admit the standalone fixtures, so the admission mutant cannot hide behind a small local cap. Keep the existing 2 MiB, 2,000-document and 256-query reserve. Refusal discards the accumulator. Supplier-payables and suspense explicitly opt in; other helper callers retain their default behavior.

**B, rejected:** put mandatory admission inside `getCumulativeBalancesAsOf`. It would require every existing report to consume a tagged result or choose a new error on exhaustion. That broadens the behavioral change beyond the opening readers and can move error precedence in existing reports. It offers a stronger universal default, but this task does not establish those reports' unavailable contracts.

Caller census from `git grep` on fetched main and `graft callers getCumulativeBalancesAsOf --depth all`:

| Existing main caller | A | B |
| --- | --- | --- |
| Trial balance, cumulative branch | Existing array and error behavior retained | Must handle bounded result/error |
| Balance sheet | Retained | Must handle bounded result/error |
| Accounting ledger opening/running balances | Retained | Must handle bounded result/error |
| Customer deposit control balances | Retained | Must handle bounded result/error |
| Commission payable reconciliation | Retained | Must handle bounded result/error |
| VAT report cumulative fallback | Retained | Must handle bounded result/error |
| Supplier payables checked reader | Explicit bounded scan for this reconciliation; verification semantics retained | Shared default would affect it and other checked callers |
| Direct helper tests in phase 18, SCRUM-889 and SCRUM-869 | Default calls retained; regressions run | Return/error contract would require reassessment |
| Income statement, management settlement and dashboard/report consumers | No direct cumulative call in the enumerated main source occurrences; income statement uses `getPostedLines`. Its default path is retained | Indirect consumers would need inspection if report contracts changed |

The control helper's other main callers are supplier-receivables GL verification and direct SCRUM-889/SCRUM-869 tests. Their default call shape is unchanged. The new bounded option is used by suspense.

## Guidance and compatibility

Research checked before implementation: [Convex transaction limits](https://docs.convex.dev/production/state/limits), [document size measurement](https://docs.convex.dev/database/types), and [transaction headroom](https://docs.convex.dev/database/writing-data). The documented limits are 16 MiB, 32,000 scanned documents and 4,096 index ranges. Use real document sizes and remaining transaction metrics, rather than JSON size estimates or fixed bytes per row.

Streaming with a checked `next()` is used instead of repeated pagination. These reconciliations must return one complete point-in-time comparison in one query; a truncated page cannot be called a balance. There is no new pagination protocol, aggregate, schema or backfill. This follows the documented headroom API. The reserve remains a policy for later work, not proof about unrelated concurrent collectors.

Five failure modes considered: partial snapshot map escaping a refusal; small caps concealing a missing admission check; a shared refusal interpreted as zero; accidentally switching closed periods to journal sums; and an unavailable result turning close into an unacknowledgeable exception. Regressions cover the two resource failures, exact small balances, retained snapshot closes, unavailable acknowledgment, and READY/legacy posted-line parity. A 4,000-journal relevant AR control retains the real AR blocker without a platform error. A per-parent-get mutant fails that control; the bulk reader was restored with matching SHA-256 `c6fecb7d88898c1e3b423a052f3a21f27c85a7a154c4c20f42e09bf1cbbc862e`.

## Verification and remaining boundaries

| Command/check | Measured result |
| --- | --- |
| `pnpm exec vitest run --maxWorkers=1 @testFiles --reporter=json --outputFile=E:/tmp/auto710-r15d-regression-final.json` | 67 files, 1,580 passed, 0 failed, 0 skipped |
| Final restored `convex/openingClosureReaders.scrum858.test.ts` suite within the 67-file run | 83 passed, 0 failed, 0 skipped |
| `scripts/regression/scenarioRecord.test.ts` | 70 passed |
| `scripts/tenantWriteGuard.test.ts` | 13 passed |
| `scripts/protectedSourcePins.test.ts` | 3 passed; no pin or census test threshold changed |
| `pnpm typecheck:convex` | Passed; Convex and test-utils entry roots, generated files excluded as entry roots; skipLibCheck enabled |
| `pnpm typecheck` | Passed; root entry exclusions are node_modules, apps, packages, convex, dealer-worker and test-utils. Imports may pull excluded files into the program |
| `pnpm exec eslint` on the four changed TypeScript files | Passed, no diagnostics |
| Local Sonar native ESLint S3776/S3358 rules | No new findings. Six pre-existing report complexity findings unchanged; old control-reader complexity 53 removed through extraction; no new function above 15 |
| `node scripts/contractSkew/checkBaselineIdentity.mjs` | 945 matching call identities; does not certify backend finding identity |
| Parsed baseline comparison against pre-fix HEAD | 945 non-renewal entries unchanged; seven freshness segments appended across three shards |
| Admission mutant | Removed both new admission checks only in `VerificationBudget.read`; both reproductions failed with limit errors; 2 failed, 0 passed, 80 unselected |

The mutant was restored from a file copy. Before/after SHA-256 is `3626d483194949982aed3342cf9cd885a077c895aef92b19b938ea68143bd64b`. The full restored reader suite passed afterward. Local Sonar rule checks are not a new SonarCloud analysis.

After the fixing commit, run:

```powershell
node scripts/contractSkew/renewBaselineReviewed.mjs --check-evidence --pr-base 075eaff37306f84b9b0400829aa90ffba3351a3f --reviewed <full HEAD>
```

The commit-specific output is reported in the implementation handoff. Seven new terminal `evidence-blobs` segments name the unchanged client file and updated backend declaration blob. No fingerprint, cause, multiplicity, expiry, original rationale or previous segment changed. The baseline findings remain UNKNOWN.

The command audit is a local artifact, `E:/tmp/auto710-r15d-command-audit.md`, captured from the implementer transcript. It includes unsuccessful discovery, fixture, parser/bootstrap and zero-test attempts. Those attempts are not counted as passing gates. Validation evidence JSON/logs and the 67-file selection list share the `E:/tmp/auto710-r15d-` prefix.

Full regression file counts follow. The final 67-file run includes all literal scenario bindings and the large relevant AR control; every listed file passed. The earlier 67-file run passed 1,579 tests, and the added AR control raises the final count to 1,580.

| Test file | Passed |
| --- | --- |
| `convex/accountingGenericReversalAuthority.test.ts` | 21 |
| `convex/accountingMigrationRetirement.test.ts` | 10 |
| `convex/accountingPhase14.test.ts` | 4 |
| `convex/accountingPhase18.test.ts` | 7 |
| `convex/accountingPhase2.test.ts` | 16 |
| `convex/accountingPhase4.test.ts` | 3 |
| `convex/accountingPhase5.test.ts` | 26 |
| `convex/accountingPhase6.test.ts` | 9 |
| `convex/accountingPhase7.test.ts` | 3 |
| `convex/accountingPhase8.test.ts` | 16 |
| `convex/accountingPhase9.test.ts` | 17 |
| `convex/accountingReservedOccurrenceIngress.test.ts` | 38 |
| `convex/accountingReversalKeyIdentity.test.ts` | 26 |
| `convex/accountingSourceFamilyRetired.test.ts` | 11 |
| `convex/bankReconciliation.test.ts` | 20 |
| `convex/commissionAccrualTiming.test.ts` | 76 |
| `convex/consignedQueuedVat.scrum782.test.ts` | 28 |
| `convex/costCorrectionRehearsalPublic.test.ts` | 8 |
| `convex/costDisclosure.scrum902f.test.ts` | 13 |
| `convex/costReaders.scrum902.test.ts` | 18 |
| `convex/costReaders.scrum902c.test.ts` | 14 |
| `convex/costReaders.scrum902d.test.ts` | 18 |
| `convex/costSweep.scrum902g.test.ts` | 3 |
| `convex/dealCommissionLinesLedger.test.ts` | 17 |
| `convex/dealCommissions.test.ts` | 25 |
| `convex/deposits.test.ts` | 35 |
| `convex/fixedAssetLifecycleContainment.scrum560.test.ts` | 33 |
| `convex/generalLedgerPagination.test.ts` | 9 |
| `convex/journalReportEligibility.test.ts` | 11 |
| `convex/legacyCollectionRefundContainment.test.ts` | 26 |
| `convex/migrateExpenseReversals.test.ts` | 3 |
| `convex/multiVehicleDepositAllocation.test.ts` | 94 |
| `convex/openingAllocatedAdvances.test.ts` | 32 |
| `convex/openingAllocatedPartners.test.ts` | 33 |
| `convex/openingAllocatedPrepaids.test.ts` | 13 |
| `convex/openingAllocatedReceivables.test.ts` | 46 |
| `convex/openingBankReconciliation.scrum858.test.ts` | 38 |
| `convex/openingClosureReaders.scrum858.test.ts` | 83 |
| `convex/openingCommissionPayroll.test.ts` | 24 |
| `convex/openingDepositFinancedSkip.scrum858.test.ts` | 1 |
| `convex/openingInventoryCap.scrum858.test.ts` | 21 |
| `convex/openingManagementSettlement.test.ts` | 46 |
| `convex/openingNamedDeposits.scrum858.test.ts` | 39 |
| `convex/openingPrepaidConsumerReports.test.ts` | 3 |
| `convex/openingPrepaidRounding.scrum858.test.ts` | 3 |
| `convex/openingRehearsalPublicComposite.test.ts` | 40 |
| `convex/openingRemainingFamilies.test.ts` | 5 |
| `convex/openingReversalDoors.scrum858.test.ts` | 7 |
| `convex/openingStockCashBankReplay.test.ts` | 13 |
| `convex/openingSuspense.scrum858.test.ts` | 11 |
| `convex/prepaidExpenses.test.ts` | 89 |
| `convex/reconciliationOrgReferences.scrum889.test.ts` | 43 |
| `convex/reportGlParity.test.ts` | 11 |
| `convex/saleCancellationOutcomeMatrix.test.ts` | 24 |
| `convex/scrum350DepositVoidSurvivor.test.ts` | 1 |
| `convex/scrum486Certification.test.ts` | 64 |
| `convex/supplierPayablesReconciliation.scrum651.test.ts` | 24 |
| `convex/supplierPayablesReconciliation.scrum876.opening.test.ts` | 7 |
| `convex/supplierPayablesReconciliation.scrum876.test.ts` | 26 |
| `convex/supplierReceivables.test.ts` | 21 |
| `convex/supplierReceivablesReconciliation.scrum869.test.ts` | 94 |
| `convex/supplierSourcingCostGate.scrum902.test.ts` | 13 |
| `convex/transactionsLegacyWriteContainment.test.ts` | 6 |
| `convex/unwindRehearsalPublic.test.ts` | 16 |
| `convex/vatReport.test.ts` | 9 |
| `scripts/protectedSourcePins.test.ts` | 3 |
| `scripts/tenantWriteGuard.test.ts` | 13 |

No deployment, environment-variable listing, push, release waiver change, or review-evidence write. Independent final-head seats, CI/SonarCloud, screen hunters and real-backend execution remain outside this implementer run. Local convex-test results do not prove OCC, cloud runtime limits/read-ahead, metric-check cost, or production-data prevalence.
