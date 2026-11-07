# Narrow financial reset with survivor preflight

Date: 2026-11-07. Issue: SCRUM-565. Risk: CRITICAL, irreversible deletion.
Status: implementation design, outside the pilot train. No deployment or production execution authorized.

## Invariant and decision

A fresh reset of a suspended organization requires complete, bounded evidence that no excluded reference-bearing state survives. Each committed batch removes owned children before their parents, preserves identity and configuration, and creates no opening entries. Continuations retain the existing generation and refusal rules.

The owner approved this narrow design in SCRUM-565 c24729, following c24726. It supersedes D-19's blanket refusal and narrows D-9 to refuse when a survivor exists. It also supersedes the broader wipe scope in c24724. D-13 remains binding: partial evidence is UNAVAILABLE. D-11 and the SCRUM-559 PENDING-intent refusal remain. This does not implement S2-S4, recovery, reader, cron or webhook changes, or pilot certification.

Design A, chosen: retain the existing reset graph, add the five observed survivor tables and vehicle dependents, and refuse any excluded survivor. A shared reference registry supplies both runtime preflight tables and the schema coverage test. Coverage still rejects missing and stale references. Complete absence, rather than a financial calculation, is the admission evidence.

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

The preflight must finish before generation changes or cleanup writes. Excluded tables use bounded org-index reads. State-family scans stop at 101 rows (100 plus an overflow sentinel). Kept-reference scans stop at 21 rows (20 plus a sentinel), including the entire org event set, which bounds social-trigger thread rebuilds. The shared serialized evidence budget is 256,000 bytes. Each deletion pass has a shared 500-row deletion cap as well as the existing per-table cap. `newTableCounts` is null when a table was not measured, and otherwise an observed prefix capped at batchSize + 1. Any read-bound overflow returns UNAVAILABLE. Runtime read errors abort without writes. Dry runs report the verdict, bounded counts and count scope. Continuations do not reacquire a fresh-start survivor certificate against partially deleted data.

## Five predicted failures

1. An excluded table is omitted or a newly added reference bypasses admission. Parameterized survivor tests and schema coverage must detect this.
2. A full prefix is mistaken for complete evidence. Over-bound terminal cheques or kept references must produce UNAVAILABLE and preserve both orgs.
3. A partial child batch deletes a parent too early. BatchSize 1 graph tests must inspect committed intermediate states, stop and retry to completion.
4. Vehicle deletion leaves a kept reader pointing at a deleted row or changes another tenant. Kept-reference repair tests and whole-schema two-org snapshots must prove the disposition.
5. Fresh-start admission bypasses suspension, deletion ownership or generation handling. Refusal snapshots, generation assertions and continuation tests must prove these rails.

## Official guidance and engineering basis

Checked 2026-11-07 against the installed Convex 1.41 guidelines and current official documentation (installed package 1.42.1; generated guidelines target 1.41):

- [Transaction limits](https://docs.convex.dev/production/state/limits): read and write budgets are per execution. Retain bounded batches and abort on incomplete evidence.
- [Pagination](https://docs.convex.dev/database/pagination): one paginated query per function and explicit completion. The survivor guard uses bounded indexed probes; it does not combine paginations or interpret a prefix as the whole table.
- [Scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions): scheduled work is durable; scheduling a deletion does not establish completion. Preserve the existing operator-driven batch machinery and refuse surviving active families.
- [Deleting files](https://docs.convex.dev/file-storage/delete-files): database row removal does not remove stored files. Blob deletion requires a separate ownership decision; retained files are disclosed above.

Documentation supports the design, not platform execution or concurrency. Those remain unverified in this local-only lane.

## Owner runbook

After independent review, merge and the normal backend release, the owner performs these steps. An agent must not execute them against a deployment.

1. Suspend the selected org using `adminOrgs:suspendOrg` with `{ "orgId": "<selected org>", "reason": "Owner-approved test-data reset" }`, authenticated as a super admin. Confirm suspension.
2. Invoke `orgFinancialReset:resetOrgFinancialData` with `{ "orgId": "<selected org>", "dryRun": true, "batchSize": 100 }`. Read `preflight`, its table counts, `newTableCounts` and `perTable`. Counts are bounded batch counts, not a full inventory.
3. Stop on REFUSED or UNAVAILABLE, authority state, pending intents, held provider capture, cash state, or deletion ownership. Resolve through separately approved workflows. Do not delete survivor rows manually or clear generation fields.
4. Invoke the same function with `{ "orgId": "<selected org>", "dryRun": false, "batchSize": 100 }`. Repeat the exact arguments while `remaining > 0`. An interrupted run resumes with these arguments. Never unsuspend during a partial reset.
5. Read the completion result with `remaining === 0` and `resetCompleted === true`. Record `resetGeneration` and use a final dry run to check counts. No opening entries are created. Retained media blobs are not erased.
6. Unsuspend using `adminOrgs:unsuspendOrg` with `{ "orgId": "<selected org>" }` after completion. Existing incomplete-reset protection remains binding.

## Evidence

Red and green runs, final table lists, release-attestation disposition and unverified checks are recorded here before the implementation commit.

## Design-attack disposition

The advisory pre-code design review found five relevant gaps. All findings were validated against this checkout: missing vehicle-dependent tables, retained-reference projections, social-trigger fanout, lifecycle cycles/child deferral, and the incompatible release attestation. The first four are addressed by the enumerated scope, real-trigger repair tests, row/byte bounds, required-reference schema coverage and batchSize-1 parent-retention controls. Optional self-lineage and reverse lifecycle links have exact pinned dispositions; reservation sources drain before claims so the expiry cron cannot operate a surviving reservation against deleted claim/root authority. Reset protocol cursor links are optional internal cleanup metadata, consumed by openingResetCleanup and removed at completion, not a live financial authority.

The release finding remains an operational blocker. The existing `SCRUM-565/N9/v2` query now truthfully returns `freshStartsBlocked: false`. The controller in `scripts/resetInProgressPreflight.mjs` still requires true, and refuses false. No replacement synchronization guarantee or gate weakening is authorized. The owner must decide that protocol before this can become a deployable release path. Removing the script's hashbang fixes the local Vite import parser; its release decision logic is unchanged.

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

Additional bounded family probes are postDatedCheques, supplierCostRecoveries, dealCommissionLines, openingCommissionLiabilities, sales, unmatchedProviderFunds and cashDrawerSessions. Any surviving prepaid schedule, payment intent or reminder already refuses through the stronger all-rows survivor policy. All held provider capture rows continue to refuse, including RESOLVED review rows. Commission admission checks each real schema source, not a nonexistent `commissions` table.

The exact kept vehicle fields cleared are leads.vehicleId, tasks.vehicleId, instagramEvents.vehicleId, facebookEvents.vehicleId, socialConversations.vehicleIds with vehicleCount, marketplaceRequestMatches.matchedVehicleId and marketplaceResponses.vehicleId. Vehicle custom-field rows are deleted selectively. The two optional org opening-cleanup cursor references are protocol metadata, not authority, and are consumed by the existing cleanup and removed at completion. Retained opening drafts refuse a fresh start; existing continuation cleanup still clears their payable result backlinks.

- Final focused verification after the generation-order correction and cleanup helper split: 224 tests passed, 0 failures, exit 0. Includes the 30-case entrypoint suite, shared reference coverage, supplier guard, regression validator and the 26-case release controller suite. ESLint on every touched TS/MJS file: exit 0, no errors or warnings. Both root and Convex typechecks passed; the final Convex check is repeated after the helper split.
- `pnpm typecheck` uses the root config, which excludes convex, test-utils, apps, packages and dealer-worker as root inputs (imports may still pull dependencies in). `pnpm typecheck:convex` includes convex and test-utils and excludes convex/_generated as root inputs. Neither is a mobile or worker typecheck.
- Tenant write census remained 571 total, 383 analyzed, 15 without an args block, 173 without orgId. Its ownership audit and the economic-command census passed in the complete run. No pinned count was changed.
- Jira was read before implementation. A later refresh returned UNAUTHORIZED/re-authentication required; no final Jira update was posted. No production access or deployment occurred.

- Final complete run after all source changes: 396 tests passed, 0 failed tests, 0 failed suites, exit 0. Command: `pnpm exec vitest run --maxWorkers=1` with every `convex/orgFinancialReset*.test.ts`, every `convex/orgResetPreflight*.test.ts`, `scripts/orgFinancialResetReferenceCoverage.test.ts`, `scripts/orgDeletionCoverage.test.ts`, `convex/orgDeletionManifestRatchet.scrum563.test.ts`, `convex/orgPurgeLifecycle.scrum297.test.ts`, `convex/adminOrgs.test.ts`, `scripts/supplierMasterGuards.test.ts`, `scripts/resetInProgressPreflight.test.ts`, `scripts/tenantWriteGuard.test.ts`, `scripts/economicCommandCensus.test.ts`, `scripts/authorityLifecycleManifests.test.ts`, and `scripts/regression/scenarioRecord.test.ts`. No watcher or deployment was used.
- Final `pnpm typecheck:convex`: exit 0 after the cleanup helper split. Root `pnpm typecheck`: exit 0. Touched-file ESLint: exit 0, no warnings. `git diff --check`: exit 0.
