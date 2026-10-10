# SCRUM-807 ledger pagination platform reproduction

On 2026-10-10, two separate disposable Convex preview deployments reproduced the account-filtered `accountingLedger:listJournalEntries` path. Both were verified as preview deployments in the AutoFlow project. Each received an isolated QA organization, one balanced POSTED JOD entry with two 500-credit lines on the requested account and one 1,000-debit line on the other account, then an authenticated query requesting two entries. Both previews and their temporary preview-only keys were deleted after the run.

| Code under test | Actual Convex result |
| --- | --- |
| `main` at `01a4ccae07c688978df6a6771e856f6d934b40b9` | Failed: `This query or mutation function ran multiple paginated queries. Convex only supports a single paginated query in each function.` |
| Candidate from that base with this PR's single-page change | Succeeded; returned the one expected journal entry. The completion reported 5,196 `databaseIoReadBytes` and 12 `databaseReadDocuments`. |

The local `convex-test` harness allowed the baseline path to paginate twice, so a failing-first regression instruments and counts calls in the affected test. It observed **two** calls before the fix and **one** after it. The complete general-ledger pagination suite passed 10/10 with one worker after the fix, including duplicate-line and cursor traversal coverage; `pnpm typecheck:convex` passed. The platform preview confirms the fixed invocation succeeds, but does not prove concurrent reactive behavior or production frequency. The failed baseline invocation gives no comparable successful billed I/O total, so this fix carries no I/O savings claim.

Raw preview error/usage responses and cleanup records are retained in the SCRUM-807 Codex task workspace. Temporary preview-only seed functions and deploy controllers are excluded from this PR.
