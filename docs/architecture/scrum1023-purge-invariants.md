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

I1. Only named roots start the purge. A root must be deleted (sales, expenses), CANCELLED (applications) or a REVERSED TREASURY_TRANSFER event; a live record is refused as a root.
I2. Every row removed is either a root, structural to a root, or ledger or derived from one. Everything else is byte-identical afterwards.
I3. A row that must survive and mentions a purged id (any field, array, payload, link, sourceId or idempotency key) makes the dry run REFUSE. It is never patched or orphaned silently.
I4. Ledger events leave as complete pairs (original + reversal, both in the set), with their journals and lines.
I5. The removed lines net to zero per (period, account, currency, bank) EXCEPT amounts the owner approved for a named root and account. An approved amount must match the purged lines exactly; any other non-zero net, a missing or a wrong approved amount, refuses.
I6. No removed journal is in a CLOSED or LOCKED period. A period without a record refuses.
I7. Each running snapshot reduced by the removal is at least as large as what is subtracted (no negative gross).
I8. The dry run writes nothing and every read is bounded. A table too large to read completely refuses; it is never silently truncated.
I9. The erase (Phase 2) acts only on a manifest this query returned `ok: true` for, and never touches audit rows unless the owner rules so.

## 3. Impact map (count of tables enumerated: 205, after merging main)

All 205 tables of the schema are classified in `convex/utils/purgeImpactMap.ts`; `scripts/purgeImpactMapCensus.test.ts` fails if the map and the schema ever differ, or if a scanned table lacks an org-leading index. 65 tables are scanned by the manifest (each by its `orgId`-leading index; all 65 already have one, so no index is proposed).

| Class | Tables | Treatment |
|---|---:|---|
| ROOT | 3 (sales, financeApplications, expenses) | start of the purge |
| STRUCTURAL | 19 | join the set when they mention a purged id |
| LEDGER | 3 (accountingEvents, journalEntries, journalLines) | complete pairs, zero net per account except approved exceptions |
| DERIVED | 3 (notifications, commandIdempotency, bankBalanceAggregateItems) | removed with the roots; the bank aggregate is trigger-maintained |
| AUDIT | 2 (financialAuditLog, adminAuditLog) | counted, not removed by default |
| ADJUST | 6 | snapshots reduced by gross; aggregates by trigger |
| REFUSE_IF_REFERENCED | 39 | survivors; a mention refuses |
| KEEP | 17 (customers, quotes, chart, periods, banks, ...) | untouched |
| NOT_APPLICABLE | 113 | other domains, no reference into the set |

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
F3 The approved exception is applied to the wrong root: two roots touching the same account are summed together, so an offsetting error between roots would hide. Mitigated by one exception per root and the item list.
F4 An audit row that explains a state the purge erased. By default audit rows are kept; they then reference ids that no longer exist.
F5 A KEEP table holding a reference the scan does not read (it scans 65 tables, not customers or quotes): checked by hand in production for quotes and vehicles (0 mentions), not enforced by the query.

## 6. Two resolution options

Option A, selective purge (recommended): remove exactly the manifest above, with exceptions itemized. Could break: surviving references (commitmentRoots consumedBySaleId, payrollItems) which must be patched or kept first; the downstream audit logs point at removed ids; deal-number gaps (accepted).

Option B, tombstone/void instead of delete: keep every root and ledger row, mark them void (status), reverse deal 6's two events with real reversal journals, hide them from reports. Could break: nothing is erased, so the owner's "as if never recorded" is not met; reports filtering the voided states must stay correct forever; the deal numbers and notifications remain.

Accounting practice (not verified against a fresh source in this session): erasing posted ledger entries is normally replaced by reversing or correcting entries so the audit trail survives; a physical erase is acceptable only as an owner-ruled, one-time, documented correction of test data in a non-closed period. Option A is chosen because the owner ruled it, with the audit trail kept in the audit logs and one new purge audit row.

## 7. Audit-log rows and unwind rows

- financialAuditLog (65) and adminAuditLog (11) rows that mention the purge set are COUNTED in the manifest (`auditRowsByTable`) and NOT removed. Default recommendation: keep them and add one purge audit row; the owner may rule to erase them, which is a separate approval. Erasing makes the purge less truthful, not more.
- The unwind (dealUnwinds, its custody and forward slices, the unwind-produced reversals and their journals) is structural to application 16 / sale 16 and leaves with them, in the same pair-complete set. It is never removed alone.

## 8. Deal 6's deposit - design decision flagged for review

Verified in production by a bounded read: the 50.000 JOD CASH deposit received 2026-11-14 (journal JE-G3B18J6K3X: Dr 1100 Cash on Hand 50.000, Cr 2100 Customer Deposits Liability 50.000) was REFUNDED on 2026-11-26 (event DEPOSIT_REFUNDED, POSTED, journal JE-RZSH8JZ18S: Dr 2100 50.000, Cr 1100 Cash on Hand 50.000, no bank account). Deposit status REFUNDED, refunded 50.000, released 50.000. There is no depositApplications row and no sale. (The earlier cash statement lists that refund row itself, tagged deal 6, on its 1100 table; reading it as "no refund" was a misreading of the 11-26 row, not a missing row.) The deposit rows hold customerId, quoteId and vehicleId only, none of which is purged (the purge removes the application, not the quote, vehicle or customer). So it needs no re-attachment: it stays on the customer, the quote and the vehicle, status REFUNDED. Screens: customer and quote deposit views are unchanged; the finance application page is gone. A deposit that is still HELD with a purged application would instead keep its customer and quote and show as unattached to a deal; none exists for deal 6. Reviewers should confirm this reading before Phase 2.

The four real deposits applied to purged sales 8, 16 and 19 are REFUNDED and stay; their derived release fields refer to removed applications (ambiguity 7 in the production trace).


## 9. Documents consulted (fetched 2026-11-27) and what could not be checked

Fetched with WebFetch on 2026-11-27, and what each page supports here:

- https://docs.convex.dev/production/state/limits - per query or mutation: 32,000 documents scanned (documents dropped by a `filter` still count), 16 MiB read, 16,000 documents written, 16 MiB written, 4,096 index ranges read (the page defines this as the number of `db.get` and `db.query` calls), 1 second of user-code execution. Supports the bounded design: the manifest's own budget is 24,000 documents (under 32,000) and a table over the 6,000 cap refuses. It also changes one claim: `db.get` calls count toward the 4,096 ranges, and this manifest does a `db.get` per purged event and journal plus one query per journal and snapshot key; with the production set (about 170 events and 120 journals) that is far below 4,096, but the manifest does not count ranges, so Phase 2 must. Phase 2 also has the 16,000-documents-written ceiling per mutation: the set is a few hundred rows, but the erase must still batch with a budget, not assume it fits.
- https://docs.convex.dev/database/reading-data/indexes/ - an index range is a chain of `.eq` comparisons from the first index field; `.withIndex` bounds the documents read, `.filter` does not. Supports reading each table through an `orgId`-leading index (`q.eq("orgId", orgId)`) and never filtering by org; the census test proves all 65 scanned tables have such an index.
- https://docs.convex.dev/database/reading-data/ - `take(n)` returns the first n results, `collect()` returns all matches and assumes the result fits the transaction limits, a `take(10_000)` is used as a safeguard in the page's own example. Supports `take(cap + 1)` so a table over the cap is detected and refused rather than truncated.
- https://docs.convex.dev/functions/internal-functions - internal functions cannot be called from a client; callable from other functions, actions, scheduled functions, crons, the Dashboard and the CLI. Supports `previewPurge` being an `internalQuery` run by the operator only. (The page does not itself say the CLI or Dashboard run is the only intended path; that is this design's choice.)
- https://docs.convex.dev/database/writing-data - `db.delete(id)` removes a document, and a whole mutation is one transaction whose writes apply together. Supports that Phase 2 can erase a batch atomically; it says nothing about the 16,000-write ceiling, which comes from the limits page.
- https://docs.convex.dev/database/backup-restore - a backup is a consistent snapshot; manual backups ("Backup Now") are kept 7 days; `npx convex export` downloads a ZIP of every table; restore is destructive and the page recommends an extra backup before a restore. CORRECTED claim: the page recommends the extra backup before a RESTORE only; it does not say to back up before other destructive changes. Taking a backup before the Phase 2 erase is this design's own requirement (a rollback path for a hard delete), not Convex's instruction.

Not fetched or not supported by a fetched page: accounting practice on correcting versus erasing entries (stated in section 6 as general practice, not from a fetched source); the Convex migrations page was not fetched, because this is a one-time reviewed internal mutation rather than a schema migration.

Project precedent read: `convex/orgFinancialReset.ts`, `accounting/reversals.ts`, `accounting/accountSnapshots.ts`, `accounting/treasuryTransfer.ts`, `accounting/bankAggregateTriggers.ts`, `utils/openingVoidProof.ts`.

Not checked: the dry run was not executed against production data; the per-table and total read caps were not stress-tested near the platform limits; `db.get` / `db.query` range counts are not measured by the manifest; Phase 2 transaction batching, backup and restore are undesigned. After merging origin/main (6f439ec32), the impact map gained `aiDrafts` (NOT_APPLICABLE: customer and user ids and draft text only), forced by the census test.