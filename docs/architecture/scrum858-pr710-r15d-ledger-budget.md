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

## Historical R15d census (superseded below by R15f)

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


## R15f: close the read-headroom class

The original census left source-proof reads outside admission and treated unverified suspense as open. The same class had already escaped R11/R13 provenance admission and R15d cumulative admission. Both R15e findings were reproduced at `df063de1982433159f1dd92e62ef3cb84e48d35e` before production edits. The initial failing-first commit is `66bb1825b7949ee517fb4ed384144e0fcc11b2ba`. The refined mid-stream fixture and exhaustive guard are committed separately at `c5eb559b694ac0a3f49aab69843c40fd62dfbb89`, before the production fix.

| Finding | Baseline result | Required result |
| --- | --- | --- |
| Empty suspense after mixed-control byte exhaustion | `OPENING_SUSPENSE_OPEN_WARNING` despite zero suspense lines | A coded unavailable warning, with no claim of a balance |
| Eleven retained headers, each with an 800,000-byte memo, missing historical journals, and a one-unit recoverable discrepancy | Public reader throws generic `ConvexError`; public checklist throws 16 MiB read error in a concurrently running legacy deposit GL read | Complete evidence or typed refusal, never partial amounts or a generic limit exception |

The initial focused red run had three failures. The expanded red run also exercised nine admission stages and the eleven-header control. Receipts: `E:/tmp/auto710-r15f-red.json`, `E:/tmp/auto710-r15f-red-tests.json`.

### Admission boundary and three states

`openingVerificationContext` supplies a read-only database adapter to the three opening-family readers, supplier payables, suspense, source labelling and the checklist's held-liability proof. Its stream, `take`, `collect`, `first`, `unique` and point reads use the existing `VerificationBudget` policy: 30,000 documents, 14 MiB, and live reserve of 2 MiB, 2,000 documents and 256 ranges. Admission requires another worst-case 1 MiB document. It checks before starting a stream and before every `next`. Each returned document is charged with Convex's size measurement. A serialized queue holds admission and its I/O together, so parallel helper calls cannot spend the same observed room.

The adapter allowlists query builders before invoking them. Unknown terminal methods, database writes, system reads, filters, counts and pagination refuse rather than escaping admission. These readers use indexed, unfiltered streams. Only `ReadHeadroomExhausted` is converted to `UNAVAILABLE/OVER_LIMIT`; other errors retain their server error path. A refused source promise is retained as a refusal, not an empty inventory. The entire reader result is discarded on refusal.

The outer boundaries are explicit at each exported compute reader, including direct `computeCloseChecklist` callers. The shared GL closure keeps its existing bounded cumulative implementation and live admission. Supplier payables now runs after the legacy checklist group, followed by the three opening families, so its budget sees the group's completed I/O. This changes scheduling, not the legacy collectors' queries or payloads.

`openingSuspenseIsOpen` and `orgHasOpeningHistory` return `OPEN | CLEAR | UNAVAILABLE`. Callers compare the literal state. Unavailable history causes an unavailable reconciliation or its acknowledgeable warning. No boolean maps a read refusal to a statement about a balance. Existing statement-of-fact and acknowledgment strings are unchanged.

One transaction-local scope caches the full source identity, including its header inventory and live-journal proof. Allocation discovery, discrepancy labelling, payable references, held-liability discovery and current-journal proof reuse it. Settlement parent reads reuse that inventory. Current org/reset and account state still get admitted reads. Existing callers that do not request the verification context follow their original database paths.

The eleven-header standalone case now fits because it no longer rereads 8.8 MB to label a discrepancy. It truthfully reports GL 70,000, subledger 70,001, discrepancy -1. Requiring OVER_LIMIT for that complete read would reject evidence already available. A 22-header case instead exhausts headroom part-way through a single header stream and must return `UNAVAILABLE/OVER_LIMIT`, with empty currencies/map and no opening difference. Eleven headers in the composite checklist still exhaust its shared transaction and produce an acknowledgeable unavailable warning.

### Complete read census for the PR-owned path

Enumerated with `graft callers computeCloseChecklist --direction out --depth all`, the supplier-payables and held-liability callee graphs, the opening-source caller graph, and an AST inventory of `db.query` and `db.get` sites in the listed modules. Locations identify the production read expressions after this change. Every row below uses measured admission; no small fixed `take(n)` is asserted to be a byte bound. At Convex's 1 MiB document maximum, even `take(101)` can request 101 MiB and `take(201)` can request 201 MiB.

| Read location | Reader/helper and population | Admission and refusal |
| --- | --- | --- |
| `convex/accountingReports.ts:81` | `getOrgCurrencyForReports`: `ctx.db .query("orgSettings")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1160` | `hasPendingAffectingPosting`: `ctx.db.get(id)` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1176` | `pendingControlAccountDraftState`: `ctx.db .query("chartOfAccounts")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1180` | `pendingControlAccountDraftState`: `ctx.db .query("manualJournalDrafts")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1184` | `pendingControlAccountDraftState`: `ctx.db .query("openingBalanceDrafts")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1214` | `supplierPayableOpenBalanceAsOf`: `ctx.db .query("openingPayablePayments")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1294` | `laterApControlActivity`: `ctx.db .query("journalLines")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1302` | `laterApControlActivity`: `ctx.db.get(entryId)` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1361` | `readSupplierPayablesReconciliation`: `ctx.db .query("pendingAccountingEvents")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1385` | `readSupplierPayablesReconciliation`: `ctx.db .query("vehicleSupplierPayables")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1399` | `readSupplierPayablesReconciliation`: `ctx.db.query("chartOfAccounts")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1561` | `hasQueuedPosting`: `ctx.db .query("pendingAccountingEvents")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1573` | `openingJournalAccountTotals`: `ctx.db.query("journalLines")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1648` | `openingAllocationAccounts`: `ctx.db.get(accountId)` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1663` | `reconciliationDateUnsupported`: `ctx.db.query("journalEntries")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1794` | `controlSourceFamilyRefusal`: `ctx.db.get(id)` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1800` | `controlSourceFamilyRefusal`: `ctx.db.get(id)` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1812` | `controlSourceFamilyRefusal`: `ctx.db.query("journalEntries")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1816` | `controlSourceFamilyRefusal`: `ctx.db.query("accountingEvents")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1836` | `readControlJournalIds`: `ctx.db.query("journalLines")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1869` | `addSystemAccount`: `ctx.db .query("chartOfAccounts")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:1906` | `openingSuspenseIsOpen`: `guarded.db.query("chartOfAccounts")` | Guarded scope + bounded GL; UNAVAILABLE, never OPEN on refusal |
| `convex/accountingReports.ts:1937` | `readEmployeeAdvancesReconciliation`: `ctx.db.query("employeeAdvances")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:2004` | `readSupplierRecoverablesReconciliation`: `ctx.db.query("supplierCostRecoveries")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:2083` | `readPartnerCapitalReconciliation`: `ctx.db.query("partnerEquity")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accountingReports.ts:2094` | `readPartnerCapitalReconciliation`: `ctx.db .query("partnerEquityTransactions")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/accounting/accountSnapshots.ts:378` | `addPeriodSnapshots`: `ctx.db .query("accountBalanceSnapshots")` | Bounded GL budget; OVER_LIMIT, no balances |
| `convex/accounting/accountSnapshots.ts:399` | `addEntryLines`: `ctx.db .query("journalLines")` | Bounded GL budget; OVER_LIMIT, no balances |
| `convex/accounting/accountSnapshots.ts:457` | `verifyAccountLines`: `ctx.db .query("journalLines")` | Bounded GL budget; OVER_LIMIT, no balances |
| `convex/accounting/accountSnapshots.ts:486` | `resolveParentEntry`: `ctx.db.get(entryId)` | Bounded GL budget; OVER_LIMIT, no balances |
| `convex/accounting/accountSnapshots.ts:510` | `readCumulativeBalances`: `ctx.db .query("accountingPeriods")` | Bounded GL budget; OVER_LIMIT, no balances |
| `convex/accounting/accountSnapshots.ts:535` | `readCumulativeBalances`: `ctx.db .query("journalEntries")` | Bounded GL budget; OVER_LIMIT, no balances |
| `convex/accounting/accountSnapshots.ts:552` | `readCumulativeBalances`: `ctx.db .query("journalEntries")` | Bounded GL budget; OVER_LIMIT, no balances |
| `convex/accounting/accountSnapshots.ts:651` | `readControlAccountBalancesAsOf`: `ctx.db.query("accountingPeriods")` | Bounded GL budget; OVER_LIMIT, no balances |
| `convex/accounting/accountSnapshots.ts:697` | `selectControlReadPeriods`: `ctx.db.query("journalEntries")` | Bounded GL budget; OVER_LIMIT, no balances |
| `convex/accounting/accountSnapshots.ts:707` | `addControlAccountBalance`: `ctx.db.query("journalLines")` | Bounded GL budget; OVER_LIMIT, no balances |
| `convex/accounting/accountSnapshots.ts:713` | `addControlAccountBalance`: `ctx.db.query("accountBalanceSnapshots")` | Bounded GL budget; OVER_LIMIT, no balances |
| `convex/accounting/accountSnapshots.ts:720` | `addControlAccountBalance`: `ctx.db.query("journalLines")` | Bounded GL budget; OVER_LIMIT, no balances |
| `convex/accounting/accountSnapshots.ts:744` | `controlEntryCounts`: `ctx.db.get(entryId)` | Bounded GL budget; OVER_LIMIT, no balances |
| `convex/utils/openingSourceIdentity.ts:150` | `readOpeningSourceIdentity`: `ctx.db.query("openingBalanceDrafts")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/utils/openingSourceIdentity.ts:152` | `readOpeningSourceIdentity`: `ctx.db.query("journalEntries")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/utils/openingSupplierBasis.ts:18` | `postedOpeningResults`: `ctx.db .query("openingBalanceDrafts")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/utils/openingSettlementBasis.ts:73` | `createOpeningSettlementReader`: `ctx.db.get(id)` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/utils/openingSettlementBasis.ts:81` | `createOpeningSettlementReader`: `ctx.db .query("journalLines")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/utils/openingSettlementBasis.ts:98` | `hasCurrentOpeningJournal`: `ctx.db.query("journalEntries")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/utils/openingSettlementBasis.ts:119` | `resolveOpeningSettlementBasis`: `ctx.db.get(orgId)` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/utils/openingSettlementBasis.ts:164` | `resolveOpeningSettlementBasis`: `ctx.db.get(allocation.accountId)` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/utils/openingSettlementBasis.ts:179` | `resolveOpeningSettlementBasis`: `ctx.db.get(draft.journalEntryId)` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/utils/openingUnallocatedLiabilities.ts:14` | `readOpeningUnallocatedLiabilities`: `ctx.db .query("openingBalanceDrafts")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |
| `convex/chartOfAccounts.ts:40` | `resolveSystemAccount`: `ctx.db .query("chartOfAccounts")` | Guarded scope or cached complete source; typed refusal to reader OVER_LIMIT |

`getOrgCurrencyForReports` reads `orgSettings` through the same scope when called by partner capital. `openingAccountAllowsFamily` delegates its database lookup to the listed `resolveSystemAccount`. `withOpeningDifferenceReport` and `orgHasOpeningHistory` use the listed, cached `loadOpeningSourceIdentity` inventory. Provenance maps evaluate cached journal/event documents without additional database reads. The AST inventory does not claim to enumerate dynamic methods; the adapter intercepts those at the database boundary.

### Explicit legacy boundary

These pre-existing checklist reads stay outside this PR's admission guarantee and keep their original collectors: pending/failed outbox, sales, manual drafts, unmatched bank lines; AR and vehicle-inventory control projection including their bulk parent reads; prepaid schedule/source reads; customer-deposit subledger/source/cumulative GL reads; commission-payable and commission-recognition source/cumulative GL reads. Their populations can still exceed a transaction's platform limits. Moving supplier payables after this group prevents the new guarded reader from racing them, but does not certify an arbitrarily large legacy group. The guarded checklist's later held-liability read is covered above; the legacy customer-deposit reader's own call keeps its original path.

### Guidance and design choices

Checked the official [Convex limits](https://docs.convex.dev/production/state/limits), [transaction headroom documentation](https://docs.convex.dev/database/writing-data), and [Convex custom-context pattern](https://stack.convex.dev/custom-functions). The native transaction-limit option bounds nested calls but refuses by throwing, and the documentation states that actual consumption can exceed the bound by an overage. These read-only helpers need typed, acknowledgeable results in the same transaction. Streaming admission with the existing reserve policy preserves that contract without new remote functions, pagination or aggregates. The database adapter applies the documented context-customization pattern locally to this PR's readers. It is not an alternative transaction engine.

[AS 2810](https://pcaobus.org/oversight/standards/auditing-standards/details/AS2810) separates a detected misstatement from inability to obtain sufficient evidence. That distinction supports separate discrepancy, suspense-open and unavailable states here. It does not certify this implementation or turn this product into an audit opinion.

The duplicate balance adder is shared. The two reported sequential await loops now use async iteration. Their reads must remain sequential: the next period/account is admitted after the previous read spends its budget. Parallelizing them to satisfy a style rule would violate admission. No NOSONAR or rule suppression was added.

Five failure predictions: an inner catch hides the typed refusal; a new database terminal bypasses the adapter; parallel readers see the same unspent headroom; cached refusal becomes empty source history; mid-stream partial headers become a complete proof. The stage guard, two reproductions, complete-history control and three source mutants address these cases. An advisory source review found the unknown-terminal forwarding gap; the adapter now refuses unknown methods before invocation. This review is not a required independent seat.

### New warning

- EN: `[OPENING_SUSPENSE_UNAVAILABLE] The opening-balance suspense balance could not be verified. Review the opening source and ledger, then re-check.`
- AR: `[OPENING_SUSPENSE_UNAVAILABLE] تعذر التحقق من رصيد حساب فروقات الأرصدة الافتتاحية. راجع مصدر الأرصدة الافتتاحية ودفتر الأستاذ، ثم أعد التحقق.`

The dialog maps the raw EN server text to `ClosePeriodWarnOpeningSuspenseUnavailable`. EN/AR component tests verify display and verbatim acknowledgment. No existing warning text changed.

### Regression library and evidence boundary

Five new money records bind the reproductions, complete-history reuse and exhaustive admission-stage guard to `SCRUM-858#c23884`. The seven `opening-cumulative-*` records now use that ruling's existing snapshot digest `9059cd797e6988004a40e71e4fad981195a23b61bbcb97bb049cbe295786491d`; scenario fingerprints remain unchanged because the scenarios themselves did not change. The validator accepts the new references. The new single-stream record uses 22 headers so removal of its admission exceeds the real harness byte ceiling before a later guard can conceal it.

Local commands, test counts, mutant source/restoration hashes and final baseline evidence are recorded in the implementation handoff and `E:/tmp/auto710-r15f-*` receipts. The SonarCloud API initially reports three unresolved issues; the local counterparts are repaired, but a fresh cloud analysis requires the coordinator's push. Harness limits, component renders and source review do not establish native read-ahead behavior, cloud scheduling/OCC, actual UI role/device hunters, or production correctness. No push, deployment or environment listing was performed.

The 22-header fixture was also run with all eight affected production modules restored temporarily to df063de19: one selected failure, zero passes, then byte-identical restoration of all eight modules. The initial 18-header variant reached a later existing GL refusal and was therefore a passing preventive control; it was increased to 22 headers to expose missing source-stream admission itself. No passing control is claimed as a red reproduction.


### R15f final local validation

| Check | Result |
| --- | --- |
| Initial three finding reproductions at df063de19 | 0 passed, 3 failed, 83 unselected |
| Expanded initial red run | 1 passed, 12 failed, 83 unselected; includes nine stage variants |
| Refined 22-header stream against all eight original production modules | 0 passed, 1 failed, 87 unselected; all source bytes restored |
| Full requested/discovered selection, 59 files | 1,442 passed, 1 failed; additionally refreshRulings failed before collection. The assertion failure was the new scenario's prose input token, corrected to ALL_MEASURED_ADMISSIONS |
| Final validator rerun | scenarioRecord: 70 passed against 1,013 records (1,009 active, four retired). Extra refreshRulings utility still fails before collection |
| Supplement, six files | 261 passed, 0 failed/skipped; includes all 27 close-dialog tests, 70 validator tests and four supplier suites |
| Final R15f public-seam cases | Five passed, 83 intentionally unselected. Exhaustive guard executes all 224 measured admission stages |
| Distinct assertions from full selection plus corrected/supplemental receipts | 1,605 passed across 62 executed test files, 0 failed/skipped assertions. The extra 63rd file, refreshRulings, has a parse failure and is not certified |
| Both TypeScript configurations | Passed separately; root excludes Convex/apps/packages/dealer-worker/test-utils entry roots, Convex includes convex/test-utils and excludes generated entry roots; imports can pull excluded paths into either program |
| ESLint on all 12 changed TS/TSX files | Zero errors; one unchanged react-hooks/set-state-in-effect warning in the dialog |
| Local Sonar counterparts plus complexity/nested-conditional checks | Duplicate adder removed; each reported await loop removed from ordinary-loop diagnostics; no new diagnostics. Other baseline findings remain. This is not SonarCloud analysis |
| SonarCloud unresolved API before/after local work | Three OPEN issues both times: S4144 and two S9382. Coordinator push and fresh analysis remain required |
| Baseline identity and metadata | 945 identities match; seven appended evidence-blobs segments in three shards, one safe 137-to-139 call relocation; zero other metadata changes |
| Requested mutants a/b/c | Each one selected failure, zero passes; original/restored SHA-256 match in every case |

The unchanged-file Vite/shebang parse failure is recorded in SCRUM-879 comment c24609 under the owner's test-only MEDIUM follow-up rule. No suite was disabled or skipped. The original broad run's failure remains in its receipt; the corrected scenario validator's pass is a separate receipt. The final commit-specific evidence CLI result is in the handoff, because its reviewed SHA does not exist until commit.


## R15g: typed opening reader

This section replaces R15f's dynamic-adapter description and source line locations. At pinned head `c931eef71b370a445dde5405b9a73c4786dc6cb7`, the unchanged supplier registry guard reproduced seven `db-indirect-call` violations: the database crossed `Reflect.get`, `Reflect.apply` and `.bind` in `OpeningVerificationScope.database`. The guard passed 46 assertions and failed its real-tree census. Its rules and allowlists remain unchanged.

`OpeningDatabaseReader` holds the native database as `QueryCtx["db"]`. Its `get`, `query` and `normalizeId` methods call that database directly. `OpeningQueryInitializer`, `OpeningQuery` and `OpeningOrderedQuery` preserve Convex's table/index/document types and query-stage ordering. Their supported terminals are `collect`, `take`, `first`, `unique` and async iteration. The types omit pagination, filters, counts, search and system-table access. The table type excludes the three registry master tables.

Guarded contexts carry `reader` and omit `db`. Replacing the declared native `db` with a structural adapter would lose the Convex declaration at context handovers, which the same guard correctly rejects. `openingDatabase` selects the admitted reader, or creates a scope-free adapter for a legacy native context. The latter calls native terminal methods and native iteration, preserving the legacy read strategy. The existing ID-only `get` overload is retained because these callers use it; the installed Convex API supports it for compatibility.

The scope retains the 30,000-document / 14 MiB budget, serialized admission queue, pre-`next` headroom check, per-document stream charge and WeakMap source-proof reuse. `VerificationBudget` itself is byte-identical after LF normalization to the pinned head. Resource exhaustion still refuses the complete result. OPEN, CLEAR and UNAVAILABLE, warning texts, snapshots, organization checks and financial switches retain their existing behavior.

### Changed declarations and callers

The following census comes from parsed top-level declarations against the pinned head. It includes type aliases whose consumers acquire the new context type. Unchanged public legacy report declarations remain on their original source paths.

| File | Changed declarations |
| --- | --- |
| `convex/accounting/accountSnapshots.ts` | `getCumulativeBalancesAsOfBounded`, `cumulativeReadBudget`, `getCumulativeBalancesAsOfChecked`, `addPeriodSnapshots`, `addEntryLines`, `verifyControlLineParents`, `verifyAccountLines`, `resolveParentEntry`, `readCumulativeBalances`, `BoundedControlBalances`, `getControlAccountBalancesAsOf`, `readControlAccountBalancesAsOf`, `ControlBalanceReader`, `selectControlReadPeriods`, `addControlAccountBalance`, `controlEntryCounts` |
| `convex/accountingPeriods.ts` | `openingFamilyWarnings` |
| `convex/accountingReports.ts` | `getOrgCurrencyForReports`, `hasPendingAffectingPosting`, `pendingControlAccountDraftState`, `supplierPayableOpenBalanceAsOf`, `laterApControlActivity`, `computeSupplierPayablesReconciliation`, `readSupplierPayablesReconciliation`, `orgHasOpeningHistory`, `withOpeningDifferenceReport`, `hasQueuedPosting`, `openingJournalAccountTotals`, `openingAccountAllocationsSupported`, `openingControlCoverage`, `openingAllocationAccounts`, `reconciliationDateUnsupported`, `controlSourceFamilyRefusal`, `readControlJournalIds`, `readSourceBatches`, `addSystemAccount`, `glNetByAccounts`, `openingSuspenseIsOpen`, `computeEmployeeAdvancesReconciliation`, `readEmployeeAdvancesReconciliation`, `computeSupplierRecoverablesReconciliation`, `readSupplierRecoverablesReconciliation`, `computePartnerCapitalReconciliation`, `readPartnerCapitalReconciliation` |
| `convex/chartOfAccounts.ts` | `resolveSystemAccount` |
| `convex/utils/openingAccountPolicy.ts` | `openingAccountAllowsFamily` |
| `convex/utils/openingSettlementBasis.ts` | `ReadCtx`, `createOpeningSettlementReader`, `hasCurrentOpeningJournal`, `resolveOpeningSettlementBasis`, `requireOpeningSettlementBasis` |
| `convex/utils/openingSourceIdentity.ts` | `OpeningVerificationScope`, `scopes`, `openingVerificationSource`, `openingVerificationContext`, `verifyOpeningRead`, `loadOpeningSourceIdentity`, `readOpeningSourceIdentity` |
| `convex/utils/openingSupplierBasis.ts` | `Ctx`, `postedOpeningResults` |
| `convex/utils/openingUnallocatedLiabilities.ts` | `readOpeningUnallocatedLiabilities` |

The source-identity module also adds the typed reader/query classes, `OpeningReadCtx`, `OpeningVerificationCtx` and `openingDatabase`, and removes `isDocumentStream`. `openingSupplierBasis` consumers of its `Ctx` alias include `openingRecoveryReferenceCounts`, `parentReference`, `openingRecoveryBasis` and `openingPayableBasis`. `OpeningSettlementReader` and `addControlJournalLines` consume the widened read-only context through their existing aliases.

The inspected main declarations are byte-identical after LF normalization: `trialBalance`, `incomeStatement`, `computeIncomeStatement`, `balanceSheet`, both public deposit/commission reconciliation queries, supplier-receivables reconciliation, their three compute functions, `computeRecognizedCommissionAsOf`, `computeCommissionRecognitionDivergence` and `accountingPeriods.create`. The complete `accountingLedger.ts` and `vatReport.ts` files also match main. The snapshot writer and legacy cumulative-balance entry point match the pinned head.

### Design and verification boundary

The [Convex reading guide](https://docs.convex.dev/database/reading-data) documents indexed, lazy query chains and incremental iteration. The [Convex limits](https://docs.convex.dev/production/state/limits) apply to the complete transaction. An explicit adapter preserves those native operations while exposing the smaller verification interface. The narrowed methods and stage types also follow the installed Convex 1.42.1 declarations in `server/database.ts` and `server/query.ts`. There is no departure from those API contracts; the adapter adds the existing application budget policy.

A compile probe accepts the supported index/order/terminal/get/normalizeId calls and reports exactly eight expected missing-property errors for pagination, filtering, counting, insert, patch, delete, system access and raw `db`. The unchanged registry suite passes 47/47. The opening-reader suite passes 88/88. Separate frontend and Convex typechecks and changed-file ESLint pass. Local Sonar equivalents report zero new findings for cognitive complexity, nested conditionals, identical functions and awaits in ordinary loops, compared with the pinned source. This is not a fresh SonarCloud analysis.

All three requested 15f mutants are killed by their intended single-test failures. Each original/restored file SHA-256 matches. The restored five-case 15f selection passes. Exact commands, source comparison, per-file counts and mutation/restoration hashes are retained in `E:/tmp/auto710-r15g-evidence/` for the coordinator. The final handoff distinguishes assertion passes from collection failures and records the complete scripts-folder result.

The inspected Playwright run 42097847076 records the unexpected role capture-failure JSON and a failed 48-frame inventory. Its downloaded diagnostic says CAPTURE_FAILED while the page is open, visible and connected, without a page crash or browser disconnect. The run log also records Chromium empty-image retries. No evidence connects this capture failure to the opening-reader refactor. Playwright source is unchanged.

These are source, compiler and serial harness checks. Native backend metering/read-ahead, cloud scheduling/OCC, rendered role/device hunters, fresh SonarCloud analysis and final independent seats remain separate evidence. The coordinator owns push and certification. No deployment or production mutation is part of this lane.


### R15g final measured controls

| Command / scope | Result |
| --- | --- |
| Registry guard at pinned c931 | 46 passed, one failed; seven indirect calls |
| Final unchanged registry guard | 47 passed, zero violations |
| Requested/discovered selection | 1,490 passed, zero failed/skipped assertions across 60 files; refreshRulings failed before collection |
| Additional direct-consumer suites | 1,113 passed across 28 files, zero failures/skips |
| Complete scripts folder, one worker | 6,583 passed, 22 failed, five skipped; seven additional collection failures; 185 files. RED |
| Ten failed script files with all nine production modules restored to c931 | 50 passed, the same 22 failed and seven collection failures. All nine fixed modules restored byte-identically |
| Restored R15f selection | Five passed, 83 unselected |
| Admission stages | Exactly 224, proven by a temporary stronger equality assertion; original test SHA-256 restored to 4eda16f4643be528d2a982ddc721f2926c542ec5e31b37cfb5038274b27d6c9b |
| Mutants a/b/c | Each exits one with one selected failure, zero passes. Original/restored production hashes match |
| Convex and root TypeScript | Both pass separately, zero errors |
| ESLint on all nine changed TS files | Zero errors/warnings |
| Local Sonar equivalents | Zero new inspected-rule diagnostics across nine files; cloud analysis remains unverified |

The 22 script assertion failures comprise 20 Windows symlink EPERM cases, one tab-filename ENOENT case and one CRLF-sensitive release source matcher. The real rollout fail function exists and exits nonzero; its matcher works after LF normalization. Five collection failures show shebang/import-hoisting parser errors, and two contract-skew CLI suites report an invalid/unexpected token with no precise loader cause established. The five existing skipped cases remain unverified. SCRUM-879 c24612 records the full census and pinned-source control. No assertion, threshold, skip or gate was changed. Registry, tenant-write and protected-source guards pass 47, 13 and three assertions respectively.

The Playwright artifact contains all 48 role PNGs, including the named expenses image. The run reports 562 passing Playwright tests and then refuses the extra capture-failure JSON. This refines the earlier capture diagnosis; it does not make the red inventory gate pass or establish the exact capture failure cause.
