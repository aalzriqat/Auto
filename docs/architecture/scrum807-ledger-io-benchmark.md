# SCRUM-807 account-filtered ledger I/O measurement

Measured on 2026-10-10 in two new disposable Convex preview deployments of the AutoFlow project. Baseline was `main` at `01a4ccae07c688978df6a6771e856f6d934b40b9`; candidate was that exact base plus the account-filtered `journalLines` index change in this PR. Each preview was verified as a preview deployment before seeding. Both previews and the two-hour preview-only deploy key were deleted after measurement.

Each preview used an isolated QA organization with 50 POSTED, balanced JOD journal entries and 22 lines per entry (1,100 total lines). Each entry had one line for the requested account and 21 unrelated lines. The same authenticated `accountingLedger:listJournalEntries` invocation requested 50 entries filtered by that account. The returned journal numbers, dates, statuses, and currencies matched exactly. This is one synthetic invocation per checkout, not production usage.

| Platform completion metric | Baseline (`energetic-seal-747`) | Candidate (`hearty-elk-996`) |
| --- | ---: | ---: |
| `databaseIoReadBytes` | 467,438 | 62,788 |
| `databaseReadDocuments` | 1,206 | 156 |
| `executionTime` (seconds) | 0.483285 | 0.211303 |
| `databaseQueries` | Unavailable | Unavailable |

The platform completion logs also reported `databaseReadBytes` equal to `databaseIoReadBytes` for both invocations. `databaseQueries` was not in those logs and is **unverified**. The latency values are single samples; they establish no latency distribution. The benchmark does not measure subscription reruns, production frequency, or concurrent mutation behaviour.

The preview-only seed function and controller are temporary local benchmark tools and are excluded from the production diff. The [sanitized platform evidence](scrum807-ledger-io-evidence.json) records the completion metrics, result-parity check and cleanup status without temporary identifiers. The full raw response and normalized rows remain in the SCRUM-807 Codex task workspace. The candidate was measured from the baseline plus the three production/test file changes before they were committed.
