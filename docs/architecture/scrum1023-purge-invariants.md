# SCRUM-1023 - Invariant Closure Packet: one-time purge of test and incorrect records

Status: PHASE 1 (design, dry run, tests). No deleting code exists or is authorised yet. Phase 2 runs only after the owner approves the exact dry-run manifest.

Owner rulings (2026-11-27): all DELETED deals and DELETED expenses are test or incorrect and are erased with their accounting events, journals and numbers as if never recorded; real, non-deleted data is kept byte-identical; the nine CANCELLED applications (deal numbers 6, 7, 10, 11, 12, 15, 16, 17, 21) and the three REVERSED treasury transfers are tests; deal-number gaps are accepted. Later the same day: deal 6's custody cash 468.500 JOD (journal JE-DPVS8JTXXP) and the same amount in finance-fee expense 6860 are a TEST entry whose resulting balance change is ACCEPTED and must be itemized per account; the 50.000 JOD deposit of 2026-11-14 is real and must survive.

## 1. Precedents and what is deliberately not copied

| Precedent | Causal mechanism (why it works) | Applies here? | Not copied |
|---|---|---|---|
| `convex/orgFinancialReset.ts` `resetOrgFinancialData` | Fail-closed: a table list, a survivor-reference preflight, batch deletes, a census test that fails when a table is added without a ruling | Yes: same list-plus-census discipline (`scripts/purgeImpactMapCensus.test.ts`) | It wipes a whole organization by table. This purge is by explicit ROOT, row by row. |
| `accounting/reversals.ts` | A reversal is an inverted journal; original + reversal net to zero and bump the same running snapshots, so removing both and subtracting both gross amounts restores the pre-posting state | Yes, provided every purged journal is half of a complete pair that nets to zero per account | Reversals append; the purge removes. The unwind rows the unwind produced are removed WITH the root, never alone. |
| `utils/openingVoidProof.ts` | A proof of zero net per account before anything is voided; refusal otherwise | Yes: the per-account net check | The opening void keeps the rows (status change). The purge deletes, so its proof is stricter and has an itemized, owner-approved exception list. |
| `treasuryTransfer.ts` | A transfer is an accountingEvent with no table of its own | The three transfer roots are events | n/a |

Causal invariant that makes the purge safe: a ledger balance is the sum of its journal lines, and each account's running snapshot is the sum of the gross debits and credits ever posted. If the removed lines net to zero per (account, currency, bank, period), every balance is unchanged; the snapshots only need their gross amounts reduced. Where the removed lines do NOT net to zero, the balance changes by exactly that net, which must be stated, itemized and approved before it happens.

## 2. Invariants

I1. Only named roots start the purge. A sale root must be deleted AND CANCELLED, an expense root deleted, an application root CANCELLED, a transfer root a REVERSED TREASURY_TRANSFER event; a live record is refused as a root.
I2. Every row removed is either a root, structural to a root, or ledger or derived from one. Everything else is byte-identical afterwards.
I3. A row that must survive and mentions a purged id (any field, array, payload, link, sourceId or idempotency key) makes the dry run REFUSE. It is never patched or orphaned silently. scripts/purgeImpactMapCensus.test.ts derives from the schema validator tree every `v.id()` that points into a purgeable table and fails unless its source table is scanned (66 tables by org index, the three root tables, journal lines through their parent journal, the organization row by id) or listed by name in PURGE_REFERENCE_COVERAGE; mutation controls prove the check can fail. The ONE exception is a kept row tied to the purge by a single clearable link field (R8): it is listed in `fieldClears` with its guarding state, not refused; a deposit's `resolutionSaleId` is listed only for an owner-approved exact deposit id and refuses (FIELD_CLEAR_NEEDS_APPROVAL) otherwise. The id-token scan finds ids as whole tokens only (see A4).
I4. Ledger events leave as complete pairs (original + reversal, both in the set), with their journals and lines.
I5. The removed lines net to zero per (period, account, currency, bank) EXCEPT what an owner-approved exception explains. An exception is {rootId, eventIds, journalIds, expectedNets[(periodId, accountId, currency, bankAccountId?, netMinor)]}: only the events and journals it names by exact id are exempt from pairing, its expectation is compared with the net of ITS OWN named journals per period (so two roots can neither share nor offset one), and whatever the expectations do not explain must still net to zero per key. A mismatch is EXCEPTION_MISMATCH, an unexplained net NONZERO_NET, a named id outside the purge set EXCEPTION_ROOT_NOT_IN_PURGE. A journal with no period is netted in a NONE bucket and refuses PERIOD_UNKNOWN.
I6. No removed journal is in a CLOSED or LOCKED period. A period without a record refuses.
I7. Each running snapshot reduced by the removal is at least as large as what is subtracted (no negative gross).
I8. The dry run writes nothing and every read is bounded. A table too large to read completely refuses; it is never silently truncated.
I10. A joinable row joins only if every reference it holds into a root-class table (sale, application, expense) is itself in the purge set; otherwise SHARED_WITH_LIVE and it does not join (claim chains through `restoredFromClaimId`, idempotency rows that mix live and purged ids). A purged row in a live money state (PURGE_LIVE_STATES: canonicalPayments VERIFIED/PENDING_SETTLEMENT/SETTLED, customerFinanceCompanyPayments CONFIRMED, paymentAllocations ACTIVE, receivableDocuments OPEN/PARTIALLY_PAID/PAID/WRITTEN_OFF, depositApplications APPLIED/REVERSING, depositCancellationPendings PENDING/QUARANTINED/FORFEITED, financeDealCustody OPEN, vehicleCommitmentClaims ACTIVE, vehicleSupplierPayables PENDING/NOT_YET_DUE/DUE_ON_SALE/PARTIALLY_PAID/PAID/DISPUTED, dealUnwinds ACTIVE, commandIdempotency STARTED) refuses LIVE_STATE_ROW unless its exact id is in `approvedLiveRowIds`; an approved id that is not in the set refuses APPROVED_ROW_NOT_IN_PURGE. The census requires every purgeable table with a status lifecycle to be a live state or justified in PURGE_NOT_LIVE_STATUS.
I11. Ledger pairs are complete in BOTH directions for events and journals: the original names its reverser and the reverser names the original, both purged, journals POSTED or REVERSED; a reversal that was itself reversed needs its reverser in the set.
I9. The erase (Phase 2) acts only on a manifest this query returned `ok: true` for, and never touches audit rows unless the owner rules so.

## 3. Impact map (count of tables enumerated: 205, after merging main)

All 205 tables of the schema are classified in `convex/utils/purgeImpactMap.ts`; `scripts/purgeImpactMapCensus.test.ts` fails if the map and the schema ever differ, or if a scanned table lacks an org-leading index. 66 tables are scanned by the manifest (each by its `orgId`-leading index; all 66 already have one, so no index is proposed), plus the three root tables as survivors, journal lines through their parent journal, and the organization row by id.

| Class | Tables | Treatment |
|---|---:|---|
| ROOT | 3 (sales, financeApplications, expenses) | start of the purge |
| STRUCTURAL | 19 | join the set when they mention a purged id |
| LEDGER | 3 (accountingEvents, journalEntries, journalLines) | complete pairs, zero net per account except approved exceptions |
| DERIVED | 3 (notifications, commandIdempotency, bankBalanceAggregateItems) | join when they mention a purged id (a purged journal LINE id is such a token, so `bankBalanceAggregateItems` of purged lines join before the survivor check); the aggregate rows are trigger-maintained, so Phase 2 must delete them through the trigger-wrapped path |
| FORWARD_LINKED | 1 (commercialDeals) | a deal only purged rows point at joins; one a live sale or application also holds stays, and that is not a refusal |
| AUDIT | 2 (financialAuditLog, adminAuditLog) | counted, not removed by default |
| ADJUST | 6 | snapshots reduced by gross; aggregates by trigger |
| REFUSE_IF_REFERENCED | 39 | survivors; a mention refuses |
| KEEP | 17 (customers, quotes, chart, periods, banks, ...) | untouched |
| NOT_APPLICABLE | 112 | other domains, no reference into the set (commercialDeals moved out: sales and applications point at it) |

(Counts per class are those in the file; the total 205 is asserted by the census test.)

## 4. Attack list (what an adversary or a mistake would do)

A1 Purge a live record by passing its id as a root: refused by I1 (`ROOT_NOT_ELIGIBLE`).
A2 Hide an unreversed money movement inside a test deal (deal 6): refused unless the owner names the exact accounts and amounts; a typo in the amount refuses (`EXCEPTION_MISMATCH`).
A3 An exception that covers one of two moved accounts: the other stays non-zero and refuses (`NONZERO_NET`).
A4 A surviving row that mentions a purged id only in free text or an idempotency key: caught by the id-token scan across every scanned table (`SURVIVING_REFERENCE`). Not caught: an id glued into a longer token with no separator.
A5 A purged journal in a closed period, whose snapshot cannot be re-derived: refused (`CLOSED_PERIOD`).
A6 Snapshot shards that cannot absorb the reduction: refused (`SNAPSHOT_UNDERFLOW`).
A7 A table that grows past the read cap between the dry run and the erase: refused (`OVER_BOUND`) rather than half-read; Phase 2 must re-run the manifest and compare hashes in one transaction.
A8 A reversal half left behind: refused (`INCOMPLETE_REVERSAL_PAIR`, `JOURNAL_NOT_PAIRED`).

## 5. Five predicted ways the purge could still be wrong

F1 A real row mixed with a test id in one document (a payroll item listing a real and a purged sale; a commandIdempotency row). The scan only sees "mentions", so these appear as surviving references or are absorbed as derived rows; the owner must decide each mixed row (payrollItems, commitmentRoots).
F2 Shard attribution of the snapshots: the posting shard is not recorded, so the gross is subtracted from the total across shards, not the shard it was added to; any consumer that reads one shard (not the sum) would see a different number than before.
F3 (closed in round 1) An exception applied to the wrong root: it used to be summed across roots. Each exception is now compared with the net of its OWN named journals per period, so swapped or offsetting expectations refuse (EXCEPTION_MISMATCH).
F4 An audit row that explains a state the purge erased. By default audit rows are kept; they then reference ids that no longer exist.
F5 (closed in round 1) A KEEP table holding a reference the scan does not read: the census now derives every reference into a purgeable table from the schema and fails unless its source table is scanned or named in PURGE_REFERENCE_COVERAGE (empty today: the eight references the first walk found in unscanned tables, the organization scan fields, journalLines, and the sales/application link fields, are all scanned now).

## 6. Two resolution options

Option A, selective purge (recommended): remove exactly the manifest above, with exceptions itemized. Could break: surviving references (commitmentRoots consumedBySaleId, payrollItems) which must be patched or kept first; the downstream audit logs point at removed ids; deal-number gaps (accepted).

Option B, tombstone/void instead of delete: keep every root and ledger row, mark them void (status), reverse deal 6's two events with real reversal journals, hide them from reports. Could break: nothing is erased, so the owner's "as if never recorded" is not met; reports filtering the voided states must stay correct forever; the deal numbers and notifications remain.

Accounting practice (not verified against a fresh source in this session): erasing posted ledger entries is normally replaced by reversing or correcting entries so the audit trail survives; a physical erase is acceptable only as an owner-ruled, one-time, documented correction of test data in a non-closed period. Option A is chosen because the owner ruled it, with the audit trail kept in the audit logs and one new purge audit row.

## 7. Audit-log rows and unwind rows

- financialAuditLog (65) and adminAuditLog (11) rows that mention the purge set are COUNTED in the manifest (`auditRowsByTable`) and NOT removed. Default recommendation: keep them and add one purge audit row; the owner may rule to erase them, which is a separate approval. Erasing makes the purge less truthful, not more.
- The unwind (dealUnwinds, its custody and forward slices, the unwind-produced reversals and their journals) is structural to application 16 / sale 16 and leaves with them, in the same pair-complete set. It is never removed alone.

## 8. Deal 6's deposit - design decision flagged for review

Verified in production by a bounded read: the 50.000 JOD CASH deposit received 2026-11-14 (journal JE-G3B18J6K3X: Dr 1100 Cash on Hand 50.000, Cr 2100 Customer Deposits Liability 50.000) was REFUNDED on 2026-11-26 (event DEPOSIT_REFUNDED, POSTED, journal JE-RZSH8JZ18S: Dr 2100 50.000, Cr 1100 Cash on Hand 50.000, no bank account). Deposit status REFUNDED, refunded 50.000, released 50.000. There is no depositApplications row and no sale. (The earlier cash statement lists that refund row itself, tagged deal 6, on its 1100 table; reading it as "no refund" was a misreading of the 11-26 row, not a missing row.) The deposit rows hold customerId, quoteId and vehicleId only, none of which is purged (the purge removes the application, not the quote, vehicle or customer). So it needs no re-attachment: it stays on the customer, the quote and the vehicle, status REFUNDED. Screens: customer and quote deposit views are unchanged; the finance application page is gone. A deposit that is still HELD with a purged application would instead keep its customer and quote and show as unattached to a deal; none exists for deal 6. Reviewers should confirm this reading before Phase 2.

The four real deposits applied to purged sales 8, 16 and 19 are REFUNDED and stay; their derived release fields refer to removed applications (ambiguity 7 in the production trace). Their `resolutionSaleId` is NOT cleared on its own: the manifest refuses (FIELD_CLEAR_NEEDS_APPROVAL) until the owner passes each exact deposit id in `approvedFieldClearIds`, and then lists the clear with the deposit's status, its resolution treatment and the fixed consequence (an empty field changes two eligibility gates, see section 10).


## 9. Documents consulted (fetched 2026-11-27) and what could not be checked

Fetched with WebFetch on 2026-11-27, and what each page supports here:

- https://docs.convex.dev/production/state/limits - per query or mutation: 32,000 documents scanned (documents dropped by a `filter` still count), 16 MiB read, 16,000 documents written, 16 MiB written, 4,096 index ranges read (the page defines this as the number of `db.get` and `db.query` calls), 1 second of user-code execution. Supports the bounded design: the manifest's own budget is 24,000 documents (under 32,000) and a table over the 6,000 cap refuses. It also changes one claim: `db.get` calls count toward the 4,096 ranges, and the manifest reads each table once by index and reuses the rows (no `db.get` per event or journal), plus one query per journal and snapshot key; with the production set (about 170 events and 120 journals) that is far below 4,096, and the manifest now counts the ranges (`totals.rangesRead`, budget about 3,500, every db.get and db.query charged BEFORE it runs); Phase 2 must do the same. Phase 2 also has the 16,000-documents-written ceiling per mutation: the set is a few hundred rows, but the erase must still batch with a budget, not assume it fits.
- https://docs.convex.dev/database/reading-data/indexes/ - an index range is a chain of `.eq` comparisons from the first index field; `.withIndex` bounds the documents read, `.filter` does not. Supports reading each table through an `orgId`-leading index (`q.eq("orgId", orgId)`) and never filtering by org; the census test proves all 66 index-scanned tables have such an index.
- https://docs.convex.dev/database/reading-data/ - `take(n)` returns the first n results, `collect()` returns all matches and assumes the result fits the transaction limits, a `take(10_000)` is used as a safeguard in the page's own example. Supports `take(cap + 1)` so a table over the cap is detected and refused rather than truncated.
- https://docs.convex.dev/functions/internal-functions - internal functions cannot be called from a client; callable from other functions, actions, scheduled functions, crons, the Dashboard and the CLI. Supports `previewPurge` being an `internalQuery` run by the operator only. (The page does not itself say the CLI or Dashboard run is the only intended path; that is this design's choice.)
- https://docs.convex.dev/database/writing-data - `db.delete(id)` removes a document, and a whole mutation is one transaction whose writes apply together. Supports that Phase 2 can erase a batch atomically; it says nothing about the 16,000-write ceiling, which comes from the limits page.
- https://docs.convex.dev/database/backup-restore - a backup is a consistent snapshot; manual backups ("Backup Now") are kept 7 days; `npx convex export` downloads a ZIP of every table; restore is destructive and the page recommends an extra backup before a restore. CORRECTED claim: the page recommends the extra backup before a RESTORE only; it does not say to back up before other destructive changes. Taking a backup before the Phase 2 erase is this design's own requirement (a rollback path for a hard delete), not Convex's instruction.

Not fetched or not supported by a fetched page: accounting practice on correcting versus erasing entries (stated in section 6 as general practice, not from a fetched source); the Convex migrations page was not fetched, because this is a one-time reviewed internal mutation rather than a schema migration.

Project precedent read: `convex/orgFinancialReset.ts`, `accounting/reversals.ts`, `accounting/accountSnapshots.ts`, `accounting/treasuryTransfer.ts`, `accounting/bankAggregateTriggers.ts`, `utils/openingVoidProof.ts`.

Not checked: the dry run was not executed against production data; the per-table and total read caps and the range budget were only exercised with small test limits, not near the platform limits; the 16 MiB read limit is NOT budgeted (audit `before` / `after` fields are `v.any`, so a large row could exceed it, and the query then fails closed with the generic error of `previewPurge`, not with a structured refusal); Phase 2 transaction batching, backup and restore are undesigned. After merging origin/main (6f439ec32), the impact map gained `aiDrafts` (NOT_APPLICABLE: customer and user ids and draft text only), forced by the census test.

## 10. PR #908 round 1: what changed and what Phase 2 must still do

Changes (each has a failing-first test in convex/purgeTestRecords.scrum1023.links.test.ts, ...scope.test.ts or the census):

- R1 order: journals and journal lines join the set INSIDE the closure fixpoint (events bring journals, journals bring lines, line ids pull in `bankBalanceAggregateItems`), and only then do survivors, the join guard and the live-state check run. A `bankStatementLines.matchedJournalLineId` on a purged line is a SURVIVING_REFERENCE.
- R2: the three root tables are read as survivors (a live sale naming a purged application, an application naming a purged sale), and the organization row is token-scanned.
- R6 bounds: one ReadBudget (documents and index ranges) is charged before every read; the first exhausted budget ends the scan with a structured OVER_BOUND; rows already read are reused (no db.get per event or journal).
- R7: a commercial deal only purged rows point at goes with them; one a live row also holds stays.
- R8 field clears (`fieldClears` in the manifest, Phase 2 empties the field and nothing else; every entry carries its guarding field and value, so the owner can judge it): depositVehicleHolds.appliedSaleId when the slice is RELEASED_AWAITING_DECISION or RESOLVED (saleCancellation.ts empties it on release, and no reader uses it outside APPLIED); `vehicles.soldBySaleId` when the vehicle is not SOLD (`assertSoldVehicleOwnedBySale` needs it only for a SOLD car). A row is cleared only when no OTHER field of it names the purge set. commitmentRoots.consumedBySaleId stays a refusal (the schema says write-once, nothing may rewrite it) and payrollItems.commissionSaleIds stays a refusal (a payroll fact; the owner has not decided).
- Round 2 / deposits.resolutionSaleId: NOT a plain history link, and the round 1 text ("saleCancellation.ts clears it the same way") was untrue as written. What the code does: saleCancellation.ts empties it in two places, when it reopens an APPLIED deposit to HELD and when it reinstates the hold of a HELD deposit whose hold was closed, each time together with resolvedBy, resolvedAt, resolutionTreatment and resolutionReason; depositHelpers.ts (lines 579, 697, 749 and 1175) and openingDepositApplication.ts (line 62) set it whenever a deposit is applied, released or given a treatment for a sale, and no code path empties it on a REFUNDED or FORFEITED deposit (a grep of `resolutionSaleId` over convex/ outside tests finds only those writers, the two saleCancellation.ts clears and the two readers; I did not re-verify the reviewers' further citation of saleCompletion.ts:1409-1419). An empty field changes two gates: identityCorrectionShowroomRefund.ts requires it empty on a REFUNDED deposit (so the deposit becomes valid showroom-refund proof), and openingDepositRefunds.ts refuses an opening deposit that still has it. So the clear is a refusal (FIELD_CLEAR_NEEDS_APPROVAL) unless the owner passes the exact deposit id in `approvedFieldClearIds`; when approved it is listed with the deposit's status, resolution treatment and the fixed consequence text. An approved id that is not a clear this purge lists refuses (APPROVED_ROW_NOT_IN_PURGE on `approvedFieldClearIds`).
- Round 2 / ledger joins: a journal reached only through a purged event's `journalEntryId` (no `accountingEventId` back-link) and the lines of a journal pass the same join guard as every other row; one that names a live sale, application or expense is SHARED_WITH_LIVE and is not added.
- Round 2 / legacy `transactions`: a purged `transactions` row that is not deleted refuses (LEGACY_TRANSACTION_ROW) unless its exact id is in `approvedLiveRowIds`, because it feeds the profit and loss report and the dashboard and the ledger net-zero proof does not cover it.
- Round 2 / exceptions: an exempt event must be POSTED and not a reversal, an exempt journal POSTED, not a reversal and not reversed (otherwise EXCEPTION_MISMATCH); every event and journal an exception names must be reachable from its `rootId` through id tokens without passing through another root (otherwise EXCEPTION_NOT_FROM_ROOT); repeated ids count once; net keys are structured, never built by joining caller strings with a separator; an expectation whose account id is not a chart-of-accounts id refuses instead of being read.
- Round 2 / bounds: `reserve` also refuses when no document room is left, and an exhausted scan reports OVER_BOUND without the stale-approval, exception and pairing refusals that only compare against rows it did not read. `readTables` still continues past a table over the per-table cap (so every oversized table is reported at once); that table is absent from the scan and the refusal is OVER_BOUND, so `ok` cannot be true.
- R9: the manifest lists storageIds ({table, id, storageId}) of purged rows from PURGE_STORAGE_FIELDS (financeAppraisals, financeDealFees, vehicleSupplierPayables documentStorageIds), census-derived from the schema.

Phase 2 obligations (not built here, listed so the erase cannot forget them):

1. Re-run the manifest and compare its hash INSIDE the erase transaction; act only on an ok: true manifest of the same hash.
2. Delete only through the trigger-wrapped writers (convex/functions.ts internalMutation), so the journalLines trigger maintains `bankBalanceAggregateItems`, `bankBalanceGrossShards` and `bankBalanceAggregateStates`; a raw db handle would leave them stale.
3. Decrement `accountBalanceSnapshots` per shard and never leave a shard negative (the manifest only proves the SUM across shards is large enough; the posting shard is not recorded).
4. Take a backup first (`npx convex export` or Backup Now) and keep the manifest with it.
5. Delete the listed storage files (storageIds) after the rows, tolerating an already-deleted file.
6. Recompute the expense dashboard summaries (dashboardExpenseMonths, dashboardExpenseSummaryState) for the months of purged expenses.
7. Stay under 4,096 index ranges and 16,000 documents written per mutation: batch with a budget and make each batch resumable (the dry run's set is a few hundred rows, but nothing may assume it).
8. Apply the `fieldClears` (and only those fields) before deleting the roots they point at, and re-check each clear's guarding state (`guardField` = `guardValue`) inside the erase transaction: a row that left that state since the dry run is not cleared.
9. Let the journalLines trigger delete the bank aggregate items of purged lines; do not also delete them explicitly (the same row would be deleted twice).
10. Check that the `journalReportEligibility` cursor does not point at a purged row.
11. An ACCEPTED quote whose commercial deal is erased must not allow a second conversion (`by_org_quote`): decide that before the erase.
12. For every legacy `transactions` row that leaves, state its P&L effect first (the dry run only refuses the non-deleted ones unless approved).
13. For every `commandIdempotency` row that leaves (a COMPLETED one that names no live root is absorbed), check that deleting it cannot let a real command be replayed.

Test provenance (round 1 and round 2, so the claim "failing-first" is not stretched). Failed first for their stated reason: the closure-order, root-survivor, join-guard, live-state, budget, field-clear, storage and exception-scope tests of round 1 (red-r1-links.log: 13 failed, red-r1-scope.log: 14 failed; red-r3-oldshape.log: two offsetting unreversed events tied to the exception root passed under the old exception shape) and the round 2 tests in red-r2-round2.log (the deposit approval, hold and vehicle guard values, forward-linked journal, legacy transaction, exempt status, root reachability, duplicate id, structured key, budget room and exhaustion-noise tests; the approved-deposit cases there failed because the new `approvedFieldClearIds` argument did not exist yet). Characterization tests that PASSED under the old code and guard against regression only: foreign-organization root, payroll item refusal, consumed commitment root refusal, PERIOD_UNKNOWN, an incomplete pair, a lone unpaired journal, and (round 2) an account id that is not an id. The organization-row token-scan test had no captured red run in round 1; round 2 captured one by disabling the scan in the working tree (red-r2-orgrow-scan-removed.log) and restoring it. The range-count bound (scope.test.ts) failed in round 1 only because a field did not exist; round 2 made it an exact equality and showed it red against a deliberate per-event `db.get` (red-r2-m2-perrow-get.log: 87 against 79), and the second-link guard of a field clear against a mutant that removes it (red-r2-m1-second-link-mutant.log).
