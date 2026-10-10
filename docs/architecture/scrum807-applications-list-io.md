# SCRUM-807: applications.list query-local point reads

`applications.list` paginates through `financeApplications`, then enriches every row with its customer, vehicle, finance company, salesperson, and quote. The baseline fetched shared company and salesperson documents once per application. The candidate shares each point read within a single query execution. Each execution starts with a fresh cache, so a later reactive rerun reads its current snapshot.

## Isolated platform comparison

On 2026-10-10, two independently created, verified Convex **preview** deployments ran the same synthetic workload against base `01a4ccae07c688978df6a6771e856f6d934b40b9`. The candidate added only the query-local read cache; a temporary preview-only seeder was excluded from the commit. Each preview held 50 DRAFT applications, 50 distinct customers, vehicles, and quotes, and one shared finance company and salesperson. The query requested a 50-item unfiltered page as the seeded organization owner. Both returned 50 rows with identical normalized customer, vehicle, company, salesperson, financed amount and installment fields. The pending-deposit field was also equal, but all rows were DRAFT, so this fixture did not exercise the deposit-resolution read path.

| Actual Convex completion metric | Main source | Candidate source |
| --- | ---: | ---: |
| `databaseIoReadBytes` | 89,990 | 72,350 |
| `databaseReadDocuments` | 304 | 206 |
| `executionTime` (one run, seconds) | 0.0931 | 0.0998 |

The 17,640-byte (19.6%) and 98-document (32.2%) reductions apply **only to this fixture and invocation**. This single latency sample does not show a latency improvement. The original 5.32 GB report's deployment scope, time window, and execution counts remain unverified. `databaseQueries`, subscription reruns, production workload mix, and write overhead were unavailable here. A permissioned tenant query and 90 existing application tests passed in the harness; the harness does not establish platform concurrency or production behavior.

Both preview deployments and preview-scoped keys were deleted after measurement. Raw platform completion logs, normalized row fields, preview identifiers, and cleanup checks are retained outside the repository in `benchmarks/scrum807-applications-{baseline,candidate}-preview-evidence.json` in the SCRUM-807 session workspace. No production deployment was run.
