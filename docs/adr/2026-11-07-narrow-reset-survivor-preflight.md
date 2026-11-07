# Narrow financial reset with survivor preflight

Date: 2026-11-07. Issue: SCRUM-565. Risk: CRITICAL, irreversible deletion.
Status: implementation design, outside the pilot train. No deployment or production execution authorized.

## Invariant and decision

A fresh reset of a suspended organization requires complete, bounded evidence that no excluded reference-bearing state survives. Each committed batch removes owned children before their parents, preserves identity and configuration, and creates no opening entries. Continuations retain the existing generation and refusal rules.

The owner approved this narrow design in SCRUM-565 c24729, following c24726. It supersedes D-19's blanket refusal and narrows D-9 to refuse when a survivor exists. It also supersedes the broader wipe scope in c24724. D-13 remains binding: partial evidence is UNAVAILABLE. D-11 and the SCRUM-559 PENDING-intent refusal remain. This does not implement S2-S4, recovery, reader, cron or webhook changes, or pilot certification.

Design A, chosen: retain the existing reset graph, add the five observed survivor tables and vehicle dependents, and refuse any excluded survivor. A shared reference registry supplies both runtime preflight tables and the schema coverage test. Coverage still rejects missing and stale references. Complete absence, rather than a financial calculation, is the admission evidence.

### Owner ruling, 2026-11-07, round 2

The owner answered "امسحها مع الباقي (مقترح)": wipe unpaid commissions with the remaining test financial data so the books start from zero. This narrows the earlier SCRUM-565 owed-commissions refusal family under c24729. Owed deal commission lines, unpaid commission amounts on COMPLETED sales, and outstanding opening commission liabilities no longer refuse by themselves. No replacement liability or opening entry is created.

All three source tables already belong to RESET_TABLES. The existing order and CHILD_TABLES edges drain payrollItems, including payslips naming commissionLineIds, commissionSaleIds or openingCommissionLiabilityIds, before those source rows. The reset still refuses live openingBalanceDrafts, even when a draft backs an opening commission. The opening-liability success test explicitly covers historical rows whose draft is missing; it does not authorize deleting or admitting a live draft.

Every other refusal is unchanged: HELD/DEPOSITED cheques, open supplier recoveries, unmatched provider funds, cash drawer state, PENDING payment intents, held captures, excluded survivors and existing authority/deletion protections. The row and byte bounds still produce UNAVAILABLE. The same bounded scans now populate preflight.owedCommissionCounts, with one count per source table and no ids or amounts. A count is exact only after that table's bounded scan completes. Overflow, an unread table or a destructive continuation reports null for that table, never an invented zero. These are source-row counts, not de-duplicated employees or obligations, and cover the complete reset rather than just the next deletion batch.

The coordinator recorded this ruling on SCRUM-565 in comment c24735. The scenario records keep the verified c24729 reference, which is in the rulings snapshot, and cite the dated narrowing in their inputs and test names. No new Jira digest is fabricated.

Design B, rejected: delete every survivor table. This would erase provider evidence, pending messages, approval history and unresolved financial obligations, require wider lifecycle and recovery work, and exceed the owner's narrow approval.

## Impact map

| Area | Disposition |
| --- | --- |
| Writers | `orgFinancialReset.resetOrgFinancialData`, internal mutation, fixed table scope, per-org indexes |
| Readers | Its dry-run and completion response; `orgResetPreflight.countOrgsWithResetInProgress`; release-script attestation |
| Historical data | Inspect rows irrespective of soft-delete status; refuse excluded survivors even if terminal |
| Transitions | Fresh generation, partial batches, completion; missing org and deletion ownership refuse |
| Reversal | No undo, cancellation or refund introduced; owner performs the destructive operation |
| Idempotency | SCRUM-563 generation increments once; continuations resume from remaining rows |
| Authorization | Internal only, suspended org, existing deletion and authority protections |
| Tenant | Index prefix is orgId; tests snapshot a second org |
| Ledger | Existing accounting deletion; chart of accounts behavior unchanged; no openings |
| Audit | Counts and table names, no row ids or amounts in refusals; owner retains run output |
| UI | No UI changes; CRM and Social Inbox records retained with repaired vehicle links |
| E2E | Real-document convex-test through the registered entrypoint, batchSize 1; no cloud or OCC claim |
| Release | Manual backend release remains separate; no deployment in this lane |

## Scope and reference dispositions

Schema enumeration covers every typed `v.id("vehicles")` and references to each newly deleted table. Vehicle photos are `vehicles.imageIds`, not a separate table; edit photos are `vehicleEdits.payload.imageIds`. There is no separate typed vehicle-document table in this schema. Existing finance appraisal and ownership-conversion documents use `documentStorageIds`.

Newly deleted tables from that enumeration: vehicleCommitmentClaims, commitmentRoots, depositApplications, financeCompanyForwards, financeCompanyForwardSlices, vehicles, vehicleLandedCosts, vehicleCostCorrections, consignedSaleCorrections, vehicleSupplierReceivables, vehicleSupplierPayables, vehiclePriceHistory, vehicleOwnershipConversions, vehicleReservations, vehicleStatusRequests, vehicleEdits, test_drives, workOrders, vehicleValuations, depositRequests, depositVehicleHolds, socialPosts, profitApprovalRequests. Existing expenses, journal lines, sales, quotes, applications, appraisals, payments and deposit cancellation rows already belong to the reset graph.

Keep customers, leads, Social Inbox conversations and events, finance companies, suppliers and aliases, memberships, roles, settings, branches, bank definitions and valuation companies. Clear kept optional vehicle links on leads, tasks, instagramEvents, facebookEvents, marketplaceRequestMatches and marketplaceResponses. Set socialConversations.vehicleIds to [] and vehicleCount to 0 together. Delete vehicle custom-field values while preserving other custom-field values and field definitions. Marketplace inventory matches also lose their stale estimate and become ELIGIBLE; inventory replies become NOT_AVAILABLE and lose their stale offer. Message history and other metadata stay. Inventory-dependent required references are deleted, rather than made nullable. Exact runtime table sets and ordering are checked against the schema.

Storage choice: retain blobs referenced by vehicle, edit, ownership-conversion and social-post rows. A blob id has no tenant ownership metadata and may be shared with kept rows or another organization; deleting it without a complete ownership/reference proof risks another tenant's data. This operation removes metadata, not a certified physical erasure of media. Existing finance-appraisal blob handling remains as before. This is a deliberate residual, not a claim that files were erased.

The preflight must finish before generation changes or cleanup writes. Excluded tables use bounded org-index reads. State-family scans stop at 101 rows (100 plus an overflow sentinel). Their shared serialized evidence budget stays 256,000 bytes. Each deletion pass has a shared 500-row deletion cap as well as the existing per-table cap. `newTableCounts` is null when a table was not measured, and otherwise an observed prefix capped at batchSize + 1. Any read-bound overflow returns UNAVAILABLE. Runtime read errors abort without writes. Dry runs report the verdict, bounded counts and count scope. Continuations do not reacquire a fresh-start survivor certificate against partially deleted data.

### Owner ruling, 2026-11-07, round 3

The owner approved bounding only kept rows that need a vehicle write. The 20-row bound now applies per kept table to a present vehicleId, a present matchedVehicleId, a nonempty vehicleIds array, or a custom-field value whose entityType is vehicle. One shared predicate and scan helper supply admission and cleanup. All eight tables are measured before any reference repair, so a later-table overflow cannot commit an earlier partial repair. Every destructive continuation repeats this check. No survivor or risky-family refusal changes.

Each kept table has its own 1,000-row scan bound and 512 KiB serialized byte budget. The iterator reads at most 1,001 rows to distinguish completion from overflow. A scan past either bound is UNAVAILABLE, even with zero references. More than 20 candidates also remains UNAVAILABLE. Preflight counts report scanned rows; an OVER_BOUND refusal reports the offending scan or write count. The kept scans do not consume the survivor/family evidence budget. No schema index is added.

These bounds account for the current mutation's two scans on a fresh destructive call. Eight tables times two scans times 1,001 is at most 16,016 direct document reads. Eight times two times 512 KiB is 8 MiB serialized evidence. Reserving the existing 500-row RESET_TOTAL_DELETE_BATCH leaves 15,484 documents under the documented 32,000-document transaction limit, before existing probes and helpers. The unchanged 256,000-byte survivor/family budget leaves approximately 7.76 MiB of the 16 MiB read limit after direct kept evidence, for deletion rows and other reads. Dry runs and destructive continuations scan kept tables once.

This arithmetic reserves headroom, not a universal full-mutation ceiling. Blocked-parent probes, opening cleanup, aggregate triggers and deletion-row sizes consume it. In particular, an event patch recomputes its conversation by reading the customer's platform history before filtering the thread. Twenty writes can cause twenty such reads. Serialized JSON size is an evidence budget, not a measurement of Convex engine bytes. A large row or trigger workload can still exhaust platform limits; an uncaught platform error aborts the entire mutation, including the generation patch. No partial scan or platform error certifies PASS. Cloud execution and transaction usage remain unverified in this lane.

The two-org regression seeds 27 rows in every kept table, only one needing a vehicle write per table. It includes customer-linked event threads and more than 256,000 bytes of retained content, then runs the real entrypoint with batchSize 1 through completion. It checks dry-run immutability, removed vehicle references, byte-identical unrelated rows and org B, and a completed generation. Separate controls preserve refusal for 21 linked events, 21 vehicle custom fields on a continuation, 1,001 unrelated rows and a table over 512 KiB.

The existing generation tests now follow c24729's conditional admission. Their dry runs and survivor refusals retain no-write checks. The opening-payable tests expect same-org legacy vehicle AP to be deleted once reset reaches those rows, while other-org AP and historical allocation assertions stay unchanged. The stock test proves the sale replay's exact VEHICLE_NOT_FOUND code and snapshots all schema tables around both the sale and opening replay refusals. Its opening allocation attempt retains the existing native ConvexError not-found refusal. Neither attempt posts or restores the removed car.

## Five predicted failures

1. An excluded table is omitted or a newly added reference bypasses admission. Parameterized survivor tests and schema coverage must detect this.
2. A full prefix is mistaken for complete evidence. Over-bound terminal cheques or kept references must produce UNAVAILABLE and preserve both orgs.
3. A partial child batch deletes a parent too early. BatchSize 1 graph tests must inspect committed intermediate states, stop and retry to completion.
4. Vehicle deletion leaves a kept reader pointing at a deleted row or changes another tenant. Kept-reference repair tests and whole-schema two-org snapshots must prove the disposition.
5. Fresh-start admission bypasses suspension, deletion ownership or generation handling. Refusal snapshots, generation assertions and continuation tests must prove these rails.

## Official guidance and engineering basis

Checked 2026-11-07 against the installed Convex 1.41 guidelines and current official documentation (installed package 1.42.1; generated guidelines target 1.41):

- [Transaction limits](https://docs.convex.dev/production/state/limits): read and write budgets are per execution. Retain bounded batches and abort on incomplete evidence.
- [Writing data](https://docs.convex.dev/database/writing-data), rechecked for round 2 on 2026-11-07: use native mutation deletes and preserve the existing indexed, child-first batching. Commission counts reuse the admission reads, adding no second scan or separate deletion mechanism.
- [Pagination](https://docs.convex.dev/database/pagination): one paginated query per function and explicit completion. The survivor guard uses bounded indexed probes; it does not combine paginations or interpret a prefix as the whole table.
- [Scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions): scheduled work is durable; scheduling a deletion does not establish completion. Preserve the existing operator-driven batch machinery and refuse surviving active families.
- [Deleting files](https://docs.convex.dev/file-storage/delete-files): database row removal does not remove stored files. Blob deletion requires a separate ownership decision; retained files are disclosed above.

Documentation supports the design, not platform execution or concurrency. Those remain unverified in this local-only lane.

## Owner runbook

After independent review, merge and the normal backend release, the owner performs these steps. An agent must not execute them against a deployment.

1. Suspend the selected org using `adminOrgs:suspendOrg` with `{ "orgId": "<selected org>", "reason": "Owner-approved test-data reset" }`, authenticated as a super admin. Confirm suspension.
2. Invoke `orgFinancialReset:resetOrgFinancialData` with `{ "orgId": "<selected org>", "dryRun": true, "batchSize": 100 }`. Read `preflight`, its table counts, `newTableCounts` and `perTable`. Also read `preflight.owedCommissionCounts` for dealCommissionLines, sales and openingCommissionLiabilities. These counts show owed source rows that the completed reset will wipe under the owner's 2026-11-07 ruling, including rows deferred behind payroll items. They are exact within the preflight bound; null means unmeasured or incomplete. Stop on UNAVAILABLE or REFUSED. `newTableCounts` and `perTable` describe bounded batches, not a full inventory.
3. Stop on REFUSED or UNAVAILABLE, authority state, pending intents, held provider capture, cash state, or deletion ownership. Resolve through separately approved workflows. Do not delete survivor rows manually or clear generation fields.
4. Invoke the same function with `{ "orgId": "<selected org>", "dryRun": false, "batchSize": 100 }`. Repeat the exact arguments while `remaining > 0`. An interrupted run resumes with these arguments. Never unsuspend during a partial reset.
5. Read the completion result with `remaining === 0` and `resetCompleted === true`. Record `resetGeneration` and use a final dry run to check counts. No opening entries are created. Retained media blobs are not erased.
6. Unsuspend using `adminOrgs:unsuspendOrg` with `{ "orgId": "<selected org>" }` after completion. Existing incomplete-reset protection remains binding.

## Evidence

Red and green runs, final table lists, release-attestation disposition and unverified checks are recorded here before the implementation commit.

## Design-attack disposition

The advisory pre-code design review found five relevant gaps. All findings were validated against this checkout: missing vehicle-dependent tables, retained-reference projections, social-trigger fanout, lifecycle cycles/child deferral, and the incompatible release attestation. The first four are addressed by the enumerated scope, real-trigger repair tests, row/byte bounds, required-reference schema coverage and batchSize-1 parent-retention controls. Optional self-lineage and reverse lifecycle links have exact pinned dispositions; reservation sources drain before claims so the expiry cron cannot operate a surviving reservation against deleted claim/root authority. Reset protocol cursor links are optional internal cleanup metadata, consumed by openingResetCleanup and removed at completion, not a live financial authority.

The existing `SCRUM-565/N9/v2` query truthfully returns `freshStartsBlocked: false`. The controller in `scripts/resetInProgressPreflight.mjs` still requires true and refuses false. Round 3 enumerated tracked references with `git grep -n -E 'resetInProgressPreflight|runResetPreflight' -- .github package.json scripts` and a whole tracked-tree search excluding generated graft cards and fixture timing data. The matches are the controller, its tests, the query's documentation and this ADR. No workflow, package script or release script calls it in this branch. Per the round-3 instruction, leave this unused controller unchanged. It does not attest conditional admission or solve the older no-new-start synchronization problem. Any future wiring needs a separately authorized protocol decision. No release gate is weakened here.

## Executed evidence

- Original red commit `0293aebfd`: 21 failures, 0 passes on unchanged main behavior.
- Expanded red commit `126a2c376ea8f038fafe8b1c4996bf8e27a9f1ca`: 28 failures, 0 passes against main `684ba04d002edfcbee20162bdad1a2fbfc61a7a5`. Candidate sources were copied aside, main's two source files installed for the control, and candidate bytes restored in a finally block. No stash, reset or deployment was used.
- Expanded narrow suite: 28 passes. The same case titles now have literal registrations because the strict regression validator does not certify parameterized bindings. No validator was relaxed.
- Before the hashbang correction: 269 tests passed but the command exited 1 because the release-preflight suite failed to import. This is not a passing full gate.
- Contract identity: 945 entries matched, 0 stranded. Narrow renewal evidence: 945 checked, 0 unrenewed/stale/malformed/missing before the final commit; repeated on the final commit separately.

The five predictions bind, respectively, to the survivor-table cases plus schema coverage; `over-bound terminal cheques are UNAVAILABLE, not a partial PASS` and `wide retained evidence is UNAVAILABLE even below the row bound`; `clean fresh reset drains vehicles and the five tables; retries preserve kept rows and org B`; `kept vehicle references clear with their projections, other content and org B stay identical` plus the over-bound linked-thread case; and the existing fresh-start, generation, suspension and deletion-ownership suites. Shared media retention has its own real-storage check.

Local harness evidence does not establish Convex cloud limits, OCC, scheduled-job interleavings, production data parity, authenticated browser hunters, Sonar results, CI, either independent review seat, merge or deployment. None of those was performed here.

- Final red commit `9b584a38bcabd2735393acb807cb807a7d1b8f59`: 30 failures, 0 passes against unchanged main. This adds the two distinct owed-commission sources identified by advisory review and keeps exact scenario registrations. Final narrow green: 30 passes.
- The advisory final source review established no additional HIGH/CRITICAL deletion defect beyond the disclosed release blocker. Its generation-order observation is corrected: the generation patch now precedes kept-reference cleanup as well as accounting deletion. Both new commission refusal tests snapshot the whole application schema and include two orgs.
- Complete pre-final run: 394 tests passed, 0 failures, exit 0, including all reset/preflight files, organization deletion/purge guards, supplier/tenant/economic census guards, authority manifest, release controller and regression-library validation. The final two commission cases and generation statement move are checked again below.

## Exact admission and repair sets

The excluded survivor table set is: applicationDocuments, bankStatementLines, cashMovements, claims, collectionReminders, customerFinanceCompanyPayments, dealerProductDeferrals, dealUnwinds, employeeAdvanceRecoveries, fixedAssetEvents, manualJournalDrafts, marketplaceWhatsAppFlows, openingBalanceDrafts, partnerEquityTransactions, paymentIntents, prepaidExpenseSchedules.

Additional bounded family probes are postDatedCheques, supplierCostRecoveries, dealCommissionLines, openingCommissionLiabilities, sales, unmatchedProviderFunds and cashDrawerSessions. Any surviving prepaid schedule, payment intent or reminder already refuses through the stronger all-rows survivor policy. All held provider capture rows continue to refuse, including RESOLVED review rows. Under the round-2 owner ruling, the three commission probes report owed counts and enforce evidence bounds; they no longer add RISKY_STATE refusals.

The exact kept vehicle fields cleared are leads.vehicleId, tasks.vehicleId, instagramEvents.vehicleId, facebookEvents.vehicleId, socialConversations.vehicleIds with vehicleCount, marketplaceRequestMatches.matchedVehicleId and marketplaceResponses.vehicleId. Vehicle custom-field rows are deleted selectively. The two optional org opening-cleanup cursor references are protocol metadata, not authority, and are consumed by the existing cleanup and removed at completion. Retained opening drafts refuse a fresh start; existing continuation cleanup still clears their payable result backlinks.

- Final focused verification after the generation-order correction and cleanup helper split: 224 tests passed, 0 failures, exit 0. Includes the 30-case entrypoint suite, shared reference coverage, supplier guard, regression validator and the 26-case release controller suite. ESLint on every touched TS/MJS file: exit 0, no errors or warnings. Both root and Convex typechecks passed; the final Convex check is repeated after the helper split.
- `pnpm typecheck` uses the root config, which excludes convex, test-utils, apps, packages and dealer-worker as root inputs (imports may still pull dependencies in). `pnpm typecheck:convex` includes convex and test-utils and excludes convex/_generated as root inputs. Neither is a mobile or worker typecheck.
- Tenant write census remained 571 total, 383 analyzed, 15 without an args block, 173 without orgId. Its ownership audit and the economic-command census passed in the complete run. No pinned count was changed.
- Jira was read before implementation. A later refresh returned UNAUTHORIZED/re-authentication required; no final Jira update was posted. No production access or deployment occurred.

- Final complete run after all source changes: 396 tests passed, 0 failed tests, 0 failed suites, exit 0. Command: `pnpm exec vitest run --maxWorkers=1` with every `convex/orgFinancialReset*.test.ts`, every `convex/orgResetPreflight*.test.ts`, `scripts/orgFinancialResetReferenceCoverage.test.ts`, `scripts/orgDeletionCoverage.test.ts`, `convex/orgDeletionManifestRatchet.scrum563.test.ts`, `convex/orgPurgeLifecycle.scrum297.test.ts`, `convex/adminOrgs.test.ts`, `scripts/supplierMasterGuards.test.ts`, `scripts/resetInProgressPreflight.test.ts`, `scripts/tenantWriteGuard.test.ts`, `scripts/economicCommandCensus.test.ts`, `scripts/authorityLifecycleManifests.test.ts`, and `scripts/regression/scenarioRecord.test.ts`. No watcher or deployment was used.
- Final `pnpm typecheck:convex`: exit 0 after the cleanup helper split. Root `pnpm typecheck`: exit 0. Touched-file ESLint: exit 0, no warnings. `git diff --check`: exit 0.

## Round-2 executed evidence

- Failing-first commit `8ce619aa9594c55a81f029c768affb251a04a440`, with production source still at `a7bd5c7bf`: `pnpm exec vitest run --maxWorkers=1 convex/orgFinancialResetNarrow.scrum565.test.ts` reported 4 failed and 27 passed, exit 1. Three failures were the owed-source refusal/count expectations; the fourth was the missing overflow-count report. Green with the source change: 31 passed, exit 0.
- The three replacement tests seed two owed rows, one settled row and two payroll items in each of two organizations. The first committed batch leaves the second payslip and every source row; repeated real-entrypoint batches complete deletion for A. Whole-schema org-B snapshots, kept customers/users and the empty final owed counts are asserted. A separate case checks all three source-table overflows without weakening UNAVAILABLE.
- Complete named reset/guard command: all `convex/orgFinancialReset*.test.ts` and `convex/orgResetPreflight*.test.ts`, plus `scripts/orgFinancialResetReferenceCoverage.test.ts`, `scripts/resetInProgressPreflight.test.ts`, `scripts/orgDeletionCoverage.test.ts`, `convex/orgDeletionManifestRatchet.scrum563.test.ts`, `convex/orgPurgeLifecycle.scrum297.test.ts`, `convex/adminOrgs.test.ts`, `scripts/regression/scenarioRecord.test.ts`, `scripts/regression/implFixture.test.ts`, `test-utils/pilotConfigParity.test.ts`, `scripts/tenantWriteGuard.test.ts`, `scripts/economicCommandCensus.test.ts`, `scripts/supplierMasterGuards.test.ts` and `scripts/authorityLifecycleManifests.test.ts`, using `pnpm exec vitest run --maxWorkers=1`: 452 passed across 22 files, exit 0. An earlier run had 450 passed and 2 failed while scenario titles and the non-pilot suite label were being updated. Neither guard was changed.
- After adding the overflow scenario record, `scripts/regression/scenarioRecord.test.ts`: 70 passed, exit 0. All four cited test titles were read successfully from their named file at failing-first commit `8ce619aa9594c55a81f029c768affb251a04a440` using `git show`.
- Public mutation inventory and its analyzer: 52 passed across `scripts/regression/pilotDoorInventory.test.ts` and `scripts/regression/pilotDoorAnalysis.test.ts`, exit 0. Inventory counts remain 405 public mutations: EXCLUDED_GUARDED 30, ENABLED_CERTIFIED 35, UNCLASSIFIED 170, NON_FINANCIAL 170. Tenant counts remain 571/383/15/173; economic-command census remains 156. No pinned count changed.
- `pnpm typecheck` and `pnpm typecheck:convex` passed, exit 0. Root exclusions remain convex, test-utils, apps, packages, dealer-worker and node_modules as root inputs; imported dependencies may still enter. The Convex config includes convex and test-utils, excluding convex/_generated as root inputs. These do not certify mobile/worker builds.
- Touched-file ESLint with `--max-warnings=0`: exit 0. Local SonarJS comparison against `a7bd5c7bf`, with cognitive complexity capped at 14, nested-ternary and duplicated-branch rules: zero new issues; new/extracted functions have no violations. Pre-existing issues remain in unchanged functions. Hosted Sonar analysis is not verified. No NOSONAR was added.
- Contract identity: 945 matched, zero stranded, exit 0. Reviewed-blob freshness is checked after the implementation commit, because it refuses dirty evidence files.
- At implementation commit `9dd4581d552bc10b61523280885911d2beba8069`, `node scripts/contractSkew/renewBaselineReviewed.mjs --reviewed c82890bd --check-evidence --pr-base 684ba04d0`: 945 checked, zero unrenewed, stale, malformed or missing, exit 0. No baseline entry needed renewal.
- `pnpm exec vitest run --maxWorkers=1 scripts/regression/localExecution.test.ts`: 193 passed, exit 0. This validates the local regression runner contract, not production reset behavior.
- Advisory pre-code design review identified the live-opening-draft limitation. It is preserved and disclosed above. This advisory review is not either independent review seat. No browser hunter, cloud/OCC run, production data access, deployment, merge or push occurred. Jira refresh/update remains unavailable due to reauthentication. The existing release-attestation blocker remains unchanged.
- Local review-state check remains BLOCKED with independent coverage 0/2 and no closing approval; CodeRabbit is UNAVAILABLE. These gates were not bypassed or claimed as passing. The owner/coordinator retains the independent review and release steps.

## Round-3 executed evidence

- The original CI expectations reproduced at `8e770ccf076a0cd0a495a164bfdfdb461bd98e11`: generation 2 failed / 14 passed, remaining families 2 failed / 3 passed, stock replay 1 failed / 12 passed. Total: 5 failed / 29 passed, exit 1. The payable failure is the widened RESET_TABLES vehicleSupplierPayables deletion, not an opening-cleanup authorization change. Every other payable assertion stays intact; intermediate batches still retain the legacy AP while payment children remain.
- Failing-first commit `e911b34d228b70ad0ce761b39eed82be190647d9` contains the new large-kept-table test. With production files explicitly checked out from `8e770ccf0`, the narrow suite had 1 failed / 33 passed, exit 1: admission returned UNAVAILABLE instead of PASS. Production files were restored from HEAD afterward. The current narrow suite passes 34 tests.
- The whole-org-bound mutant changes only the scan-overflow decision back to `found.length > RESET_KEPT_READ_BOUND`, retaining the independent larger byte budget. The new positive test kills it: 1 failed / 33 passed, exit 1. Candidate source bytes were restored in a finally block. This separates the incorrect 20-row whole-org bound from the earlier shared-byte-budget failure.
- The requested checks plus additional regression tooling ran with `pnpm exec vitest run --maxWorkers=1` on named files. All 792 test cases in 29 files passed, with zero failed, pending or todo cases. The command nevertheless exited 1 because an extra author-tool suite, scripts/regression/refreshRulings.test.ts, failed to import its unchanged hashbang-bearing refreshRulings.mjs under Vite/Rolldown on this workstation. It executed zero tests. Both files are byte-identical to 8e770ccf0; they remain outside this reset change. This run is not reported as a green aggregate command.
- The remaining reset-caller sweep ran ten more named files with one worker: 524 passed, zero failures or skips, exit 0. The preview/rehearsal-named tests ran only in convex-test or injected test boundaries, not a deployment. Across the two commands, 1,316 cases passed in 39 files; the extra failed-to-load author-tool suite remains explicitly unavailable.
- Search scope: rg is unavailable on this workstation, so tracked-file git grep covered convex/, scripts/ and test-utils/. No test still asserts Fresh financial resets are disabled or FRESH_RESET_STARTS_BLOCKED. The remaining FRESH_RESET_STARTS_BLOCKED matches are the false constant, its admission predicate, and its query import/output. A second search enumerated reset entrypoint/helper callers and retained-vehicle or legacy-survival phrases. Every reset-calling test file found was executed. Unrelated legacy-survival matches in accountingPhase12, documents, noCompanyChequeFlags and supplierDueAging are not reset assertions. No caller or guard pin was relaxed.
- Root pnpm typecheck passed, exit 0. Its root inputs exclude convex, test-utils, apps, packages, dealer-worker and node_modules; imported dependencies can still enter. pnpm typecheck:convex passed, exit 0; it includes convex and test-utils and excludes convex/_generated as root inputs. Neither check certifies mobile or worker builds.
- Touched-source/test ESLint with --max-warnings=0 passed. A local SonarJS 4.2.2 comparison against 8e770ccf0 used cognitive complexity capped at 14, nested-condition and nested-ternary rules, and duplicated-branch checks: zero new issues. The unchanged clearVehicleReference function has the same pre-existing complexity 17 finding. No NOSONAR was added. Hosted Sonar is not verified.
- GitHub run 42372131031's convex-backend log independently confirms exactly the two imports and two fullApi entries added by Linux codegen. Those four lines were applied by hand. No Windows codegen was run or trusted; a new Linux CI run is not claimed.
- Contract identity: 945 matched, zero stranded, exit 0. The reviewed-evidence freshness command is recorded after the implementation commit below; no baseline entry has been changed.
- Tenant guard pins stay totalMutations 571, analysed 383, skippedNoArgsBlock 15, skippedNoOrgId 173. Economic-command population stays 156. Public inventory stays 405: EXCLUDED_GUARDED 30, ENABLED_CERTIFIED 35, UNCLASSIFIED 170, NON_FINANCIAL 170. The guards and inventories are unchanged and their tests passed.
- The ten scenario records changed or added are the large-kept-table admission record (retaining the original linked-thread id), independent kept-byte overflow, actual-reference write overflow, kept scan overflow, continuation custom-field overflow, clean fresh generation admission, cash survivor generation refusal, selected-control opening supplier payable, queued opening other payable, and old opening stock replay. Preventive overflow/generation controls claim no invented failing-first bug. The changed large-history bugRef names e911b34d228b70ad0ce761b39eed82be190647d9; the unchanged byte-overflow regression title exists at its historical 9b584a38bcabd2735393acb807cb807a7d1b8f59. Both title bindings were verified with git show and Select-String.
- The advisory design review is not either independent certification seat. Final seats, /simplify, CodeRabbit coverage, hosted CI/Sonar, scripted browser E2E, screen audit, explorer swarm, cloud/OCC and production verification remain unverified. CodeRabbit's PR conversation says review was skipped; review and inline-comment arrays were empty when read. Jira refresh/update is unavailable because the connector requires reauthentication. No push, merge, deployment, environment listing, production data access or reset execution occurred.

### Per-file execution counts

Counts below come from the two native Vitest JSON reports. Every listed row passed. The failed-to-import refreshRulings suite is excluded from these passing rows and disclosed above.

| File | Passed |
| --- | ---: |
| convex/adminOrgs.test.ts | 18 |
| convex/openingRemainingFamilies.test.ts | 5 |
| convex/openingStockCashBankReplay.test.ts | 13 |
| convex/orgDeletionManifestRatchet.scrum563.test.ts | 7 |
| convex/orgFinancialReset.test.ts | 31 |
| convex/orgFinancialResetBeginPath.scrum565.test.ts | 4 |
| convex/orgFinancialResetFreshStart.scrum565.test.ts | 8 |
| convex/orgFinancialResetNarrow.scrum565.test.ts | 34 |
| convex/orgFinancialResetOrgIndex.test.ts | 3 |
| convex/orgFinancialResetPayroll.test.ts | 1 |
| convex/orgFinancialResetReferences.test.ts | 21 |
| convex/orgFinancialResetRequiredRefs.test.ts | 18 |
| convex/orgPurgeLifecycle.scrum297.test.ts | 8 |
| convex/orgResetGeneration.scrum563.test.ts | 16 |
| convex/orgResetPreflight.test.ts | 10 |
| scripts/authorityLifecycleManifests.test.ts | 3 |
| scripts/economicCommandCensus.test.ts | 19 |
| scripts/orgDeletionCoverage.test.ts | 8 |
| scripts/orgFinancialResetReferenceCoverage.test.ts | 51 |
| scripts/resetInProgressPreflight.test.ts | 26 |
| scripts/supplierMasterGuards.test.ts | 47 |
| scripts/tenantWriteGuard.test.ts | 13 |
| test-utils/pilotConfigParity.test.ts | 54 |
| scripts/regression/implFixture.test.ts | 1 |
| scripts/regression/localExecution.test.ts | 193 |
| scripts/regression/pilotDoorAnalysis.test.ts | 39 |
| scripts/regression/pilotDoorInventory.test.ts | 13 |
| scripts/regression/prRunner.test.ts | 58 |
| scripts/regression/scenarioRecord.test.ts | 70 |
| convex/accountingPhase17.test.ts | 56 |
| convex/accountingReceiptMovement.test.ts | 52 |
| convex/openingAllocatedPrepaids.test.ts | 13 |
| convex/openingAllocatedReceivables.test.ts | 46 |
| convex/openingBankReconciliation.scrum858.test.ts | 38 |
| convex/openingCleanupPreviewRehearsal.test.ts | 26 |
| convex/openingCommissionPayroll.test.ts | 24 |
| convex/openingManagementSettlement.test.ts | 46 |
| convex/supplierReceivablesReconciliation.scrum869.test.ts | 105 |
| scripts/accountingPreviewRehearsal.test.ts | 118 |
