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

## 3. Impact map (count of tables enumerated: 204)

All 204 tables of the schema are classified in `convex/utils/purgeImpactMap.ts`; `scripts/purgeImpactMapCensus.test.ts` fails if the map and the schema ever differ, or if a scanned table lacks an org-leading index. 65 tables are scanned by the manifest (each by its `orgId`-leading index; all 65 already have one, so no index is proposed).

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
| NOT_APPLICABLE | 112 | other domains, no reference into the set |

(Counts per class are those in the file; the total 204 is asserted by the census test.)

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

Verified in production: the 50.000 JOD deposit of 2026-11-14 is not "without refund": it is REFUNDED (refunded 50.000, released 50.000), its DEPOSIT_RECEIVED and DEPOSIT_REFUNDED events are POSTED, and there is no depositApplications row and no sale. The deposit rows hold customerId, quoteId and vehicleId only, none of which is purged (the purge removes the application, not the quote, vehicle or customer). So it needs no re-attachment: it stays on the customer, the quote and the vehicle, status REFUNDED. Screens: customer and quote deposit views are unchanged; the finance application page is gone. A deposit that is still HELD with a purged application would instead keep its customer and quote and show as unattached to a deal; none exists for deal 6. Reviewers should confirm this reading before Phase 2.

The four real deposits applied to purged sales 8, 16 and 19 are REFUNDED and stay; their derived release fields refer to removed applications (ambiguity 7 in the production trace).

## 9. Documents consulted and what could not be checked

Convex documentation, by topic (no live fetch was possible in this session; the design relies on the published limits and behavior as known and on the repo's own tests, so these must be re-read before Phase 2): deleting and writing data (https://docs.convex.dev/database/writing-data), function and transaction limits, 32,000 documents read and 16 MiB per query/mutation and the indexed-range limit (https://docs.convex.dev/production/state/limits), indexes (https://docs.convex.dev/database/reading-data/indexes/), backups and export before a destructive migration (https://docs.convex.dev/database/backup-restore), migrations (https://docs.convex.dev/database/schemas). Accounting practice on correcting versus erasing entries (reversing journals preserve the audit trail) is cited from general practice (for example the audit-trail requirement of accounting standards), not from a fetched source.

Project precedent read: `convex/orgFinancialReset.ts`, `accounting/reversals.ts`, `accounting/accountSnapshots.ts`, `accounting/treasuryTransfer.ts`, `accounting/bankAggregateTriggers.ts`, `utils/openingVoidProof.ts`.

Not checked: the dry run was not executed against production data; the 6000-per-table and 24000-total read caps were not stress-tested at the 32k/16 MiB platform limits; Phase 2 transaction batching, backup and restore are undesigned.
