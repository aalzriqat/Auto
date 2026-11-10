# Supplier attention local implementation evidence

Worktree: `E:/tmp/auto-869s4`. Branch: `claude/scrum869-supplier-alerts-v2`.
Current base: `7065336c6f462a4f98cfb44c6a79f52b2e324113`, supplier-links round 2.
The round-1 evidence below is historical; the round-2 section records current checks.
Risk: HIGH because this adds a cost-bearing reader and refactors the existing
reminder worker's eligibility decision. This is implementation evidence, not a seat.

## Change and reader contract

ADR: [supplier attention port](../adr/2026-11-10-supplier-attention-port.md).
The original never-merged attention work is ported from d4c551d2a, fb7ec375a,
dc840b6c3 and 408857137. The old branch remains at
40885713700b70cf99f7403d7d4b86428ccd20d1 and was not modified.

`supplierStatement.attention` reads one family per call using the existing
`by_org_and_supplierId_and_status` index. It requires authenticated tenancy,
an owned supplier, the accounting plan, and finance plus cost access. Missing
either grant returns exactly null. Each native page is at most 50 source
documents and 1 MiB. At most two budgeted sale/application gets enrich a row.
Amounts, due date, days overdue and eligibility are projected to an allowlist.
There is no net, count or total. Separate UI regions retain A/P and A/R.

The same index's missing-id prefix supplies an organisation-wide presence
warning. A byte-aware stream reads at most 51 payables or one A/R row, excludes
ordinary OPENING/OTHER_PAYABLE creditors, and reports INCOMPLETE when absence
cannot be proved. No row is assigned by name. No index or schema was added.

Server time determines the Amman day; the client timestamp refreshes the
subscription hourly and at midnight. Disputed and undated rows stay visible as
held. The existing schedule, recipients, idempotency keys, notification writes,
settlement and correction refusals are unchanged. No money writer was added.

## Commits and failing-first evidence

1. `268b271f81bd219eed4884a1906f619d4f06baab`: ADR first.
2. `3aa21249e061941c07e4edd8a259990dccccaf91`: failing tests.
3. `add70cbbf267ea8c04ed731996573977c8bc9d00`: implementation.
4. The subsequent metadata commit holds this report, the scenarios and matrix.

The initial backend red run had 17 failures because supplierStatement had no
attention export. The component suite could not resolve SupplierAttentionSection.
Those were run before the implementation. Setup mistakes found in earlier
draft fixtures were corrected before committing the red tests; they are not
counted as behavior evidence. Native backend fixture shapes now use schema
types rather than unchecked casts. Scenario-bound registrations are literal.

Two advisory findings were independently reproduced before fixing them:

- A stored recovery NaN returned complete=true, ALERTING and NaN money. The
  reader now rejects malformed recovery operands/currency with a generic coded
  error. The existing formatter's dash was not accepted as backend validation.
- A native SplitRequired response exposed a partially read page and an advancing
  cursor. It now withholds figures, retains the current cursor and suppresses Next.

## Round 1 executed checks

All Vitest commands use named files and `--maxWorkers=1`.

| Check | Observed result |
| --- | --- |
| Every test under components/suppliers, every convex/supplier*.test.ts, plus due-plan/date and headroom utility tests | Final 42 files, 918 passed, zero failed or skipped |
| Attention public-query and component suites | 38 tests passed, including whole-shape permission withholding, identity, date boundary, recovery validation and split/budget controls |
| Scoped coverage, seven test files | 206 passed; five selected modules: 95.85% statements, 96.02% lines, 96.15% functions, 95.97% branches. Original thresholds unchanged |
| Individual new modules | Attention UI 98.14% statements / 100% lines; attention reader 97.82% / 100%; due plan and page reader each 100% / 100%. SupplierStatement overall 86.79% / 86%, including unchanged code |
| Regression library, all seven named files | Initial run: six files and 374 tests passed; refreshRulings failed before collecting tests on a CRLF shebang parse error. Exact LF Git-blob control then passed its five tests, with original checkout bytes restored. All seven have passing results across the two runs; no single all-seven green run is claimed |
| Scenario validator | All 70 tests passed with the 38 new records. Stored hashes are the fingerprints printed in two validator runs, not hand-written substitutes |
| Opening contract provenance | Focused clientPaths test for both actual opening routes passed, as did the compiler inventory control: two passed. A prior broad run had an inventory-control failure while source files were still being added; no full-file green claim |
| pnpm typecheck | Passed; root configuration excludes convex as entry roots |
| pnpm typecheck:convex | Passed with convex/tsconfig.json; separate from the frontend check |
| ESLint on every touched TypeScript/TSX file | Passed with --max-warnings 0 |
| node quality/guardrails/check.mjs | Passed, 1,066 production files measured; no ceiling, threshold or import allowance changed |
| node scripts/contractSkew/checkBaselineIdentity.mjs | 948 baseline identities matched; backend finding identity is outside this tool's measurement |
| Renewal evidence on committed implementation | 948 checked, zero unrenewed, stale, malformed or missing; stacked --pr-base df1fd388bc717dddc946c71fcbde2d3fcf2e8e70. The exact requested command first refused because --reviewed is mandatory; adding --reviewed 68be2346d9e2441e9d5bcf88cb980d9ad9189cd6 passed. Main-base fallback was not needed. Final metadata-head invocation is reported in the handoff |

Source mutation: removing supplierId from the page reader's indexed predicate
made the same-name/id-less test fail with three ids instead of the one linked
id. One intended failure, exit 1; the original source bytes were restored and
the restored full supplier run passed. This is one killed identity mutant,
not complete mutation coverage of every new function.

Local raw reports are under `C:/Users/123/AppData/Local/Temp/`:
869s4-backend-red.json, 869s4-suppliers-final.json,
869s4-regression-final.json, 869s4-opening-contract.json,
869s4-fingerprint-output.log, 869s4-fingerprint-output-2.log and
869s4-coverage/coverage-summary.json.

## Synthetic renders

Directory:
`C:/Users/123/AppData/Local/Temp/claude/E--tmp-auto-781/481625ee-e49b-4d02-bc36-ebcb71386b79/scratchpad/869s4-renders/`.

The real component tests wrote synthetic markup. render.cjs compiles the
application's globals.css, loads the markup with Chromium setContent and aborts
every network request. No dev server or cloud/production backend was used.
The design source is the existing AutoFlow tokens and shared components.
Every capture has the requested direction and scrollWidth equal to its viewport.
Local fallback fonts are used. This is a rendered fixture, not a signed-in journey.

| File | What it shows |
| --- | --- |
| workspace-en-375.png | Stacked A/P and A/R; overdue payable, near-due margin, undated held recovery, incomplete/unlinked warning and Next |
| workspace-en-1440.png | Same records in desktop columns, explicit directions and independent amounts |
| workspace-ar-375.png | Same synthetic obligations in Arabic RTL with isolated amounts/dates |
| workspace-ar-1440.png | Arabic RTL desktop columns and warnings |
| states-en-375.png | Loading, complete empty, read-budget incomplete, unlinked check incomplete and generic localized error |
| states-en-1440.png | Same English states at desktop width |
| states-ar-375.png | Arabic RTL loading, empty, budget/unlinked unavailable and error |
| states-ar-1440.png | Same Arabic states at desktop width |

## Permanent checks, findings and limits

38 new records: `regression/scenarios/{money,permission,tenancy,screen}/supplier-attention-*.scenario.json`.
Four matrix sections: SCRUM869-attention-read, -permissions, -bounds and -screen
in scrum486-certification-oracle.md. These are preventive feature controls;
they do not attach one red SHA to tests renamed or added later.

Advisory Standards: one split correctness finding, reproduced and fixed; one
non-blocking module-cycle heuristic. The existing due module re-exports the
page module, which imports facts back from it. Bindings are consumed after
initialization; native public-query tests exercise the graph. A broader facts
extraction is not claimed here. Advisory Spec: split handling and recovery
validation reproduced and fixed. The suggested formatter-crash consequence was
rejected: the formatter renders a dash; the malformed complete response was real.

No open owner question was found. Explicit limitations remain: settled history
can consume attention pages; native required-split ranges remain unavailable
in this fixed-page UI instead of offering split navigation. Neither condition
is labelled complete, zero or healthy. Full history is navigable through ordinary
pages; unread join/split ranges never advance over unprocessed obligations.

Unverified: hosted Sonar's zero-new-issues gate, exact-head cloud CI, independent
review seats, authenticated hunters, real Convex/OCC/read-limit behavior and
production parity. No release or pilot certificate is claimed. CodeRabbit was
not requested because no PR was opened. No push, deploy, production key/data,
money write, backfill, migration, workflow, release/rehearsal or Playwright edit.
In round 1, the protected ignore files were left untouched. Coordination claim creation
refused because this runtime has no registered session; the coordinator's Jira
c24900 assigns the lane. The parent slice's round-2 changes were not integrated in round 1; they are integrated below.

Suggested PR title: `SCRUM-869: show bounded, cost-gated supplier attention`.

Five-line summary:

1. Port the original reminder eligibility decision and Needs attention view.
2. Keep canonical-id A/P and A/R separate, with due, overdue and held states.
3. Bound native pages and joins; withhold unread figures and unlinked counts.
4. Enforce tenant, finance, cost and plan gates with EN/AR and RTL states.
5. Add 38 permanent scenarios, matrix rows, local coverage and eight fixture renders.


## Round 2 rebase and conflict resolution (2026-11-10)

Rebased the same four ordered commits onto parent
`7065336c6f462a4f98cfb44c6a79f52b2e324113`. The backup branch remains at
`305da9422f558f217d4e72c51590b72d2365714e`. No push, merge or deployment.
All four messages retain the requested Codex co-author trailer.

1. `5bf850703`: ADR.
2. `949d15ab3ea20dad6d2d54d6376cebdc0f62d417`: tests only.
3. `ba36f0245`: feature and conflict integration.
4. The amended scenarios/evidence commit holds this round-2 report.

The feature conflicted in two files:

- `supplierStatement.ts`: retain the parent's cache import and unchanged
  outstanding/settled implementation, together with attention's pagination,
  owner-role, Amman-date and attention imports.
- `supplierObligationDue.ts`: export payableFacts and receivableFacts using
  the parent's optional SupplierReadCache parameter and cached implementation.
  Delete the conflict's old budgetedReader/ReadBudgetExhausted branch. Keep
  the original page export through supplierObligationPage.

The integration passes one cache per supplier-scoped page into both fact
readers and catches SupplierReadBudgetExhausted in attention. A budget cut
still returns no figures, no count/total, false completeness and the input
cursor. The no-supplierId path passes undefined and keeps direct gets, without
adding caching or join-budget checks. A temporary call-through harness probe
with two receivables sharing one sale asserted one scoped get versus two
org-wide gets and identical 3,000,000-minor-unit row amounts. It passed; original
test bytes were restored. This measures helper get I/O, excluding auth and
query ranges, and makes no cloud cost, byte, latency or concurrency claim.

Attention reuses boundedCount from paginationBounds, retaining its previous
undefined/nonfinite fallback and exact 50-row / 1 MiB caps. It uses the shared
Money already adopted by the parent and now reads useLanguage().dir. No link
or client permission map was added. Server href remains the link authority.

No assertion changed for the parent integration. The rebased tests-only files
are byte-identical to 3aa21249e's files; the final attention tests are
byte-identical to the round-1 backup. Thus no bound scenario test changed and
all 38 stored attention fingerprints remain unchanged. The library validator
verified them (70 tests passed); no hashes were recomputed by hand.

### Red, green and mutation evidence

At tests-only `949d15ab3`, the backend run had **16 failed, 1 passed**, exit 1.
Failures report the absent supplierStatement.attention export. The single
passing generic plan-refusal assertion is not evidence of a working gate at
that commit. The component suite failed before collection because
SupplierAttentionSection was absent. Logs: `869s4-r2-red.log`,
`869s4-r2-red.json` and `869s4-r2-ui-red.log` in the OS temp directory.

| Check | Round 2 result |
| --- | --- |
| Focused attention public-query and component suites | 2 files, 38 passed |
| Every supplier component test, convex/supplier*.test.ts, convex/utils/supplier*.test.ts and transactionReadHeadroom | 43 explicitly named files, 945 passed, zero skipped; file enumeration in 869s4-r2-supplier-files.txt |
| Every components/vehicles test | 10 explicitly named files, 130 passed, zero skipped |
| scripts/regression/*.test.ts | All 7 attempted: 6 files / 374 passed; refreshRulings failed before collection on the pre-existing Windows CRLF shebang transform. Its exact LF Git-blob control passed 5/5, with original checkout bytes restored and hash-equal. All seven have passing results across runs, not one all-seven green invocation |
| Scenario validator within that run | 70 passed; committed library has no problems; all 38 attention records retain their stored fingerprints |
| Focused opening provenance, clientPaths.test.ts -t "both actual opening routes" | 1 passed, 231 unrelated cases filtered by the requested selector |
| Scoped V8 coverage, 7 named files / 221 tests | 96.31% statements (209/217), 96.59% lines (170/176), 96.07% functions, 96.47% branches; unchanged configured thresholds |
| Individual coverage | Attention UI 98.14% statements / 100% lines; attention reader 97.82% / 100%; due plan and page reader 100% / 100%; supplierStatement 88.67% / 88% including unchanged code |
| pnpm typecheck | Passed; root excludes convex as entry roots, not a backend typecheck |
| pnpm typecheck:convex | Passed using convex/tsconfig.json |
| ESLint | All 13 touched non-generated TS/TSX files passed, --max-warnings 0 |
| Guardrails | Pass, 1,068 production files measured; no threshold, ceiling or allowance changed |
| Baseline identity | 948 matched; backend finding identity is not measured by this command |
| Committed-tree renewal evidence | --check-evidence --reviewed 7065336c6f462a4f98cfb44c6a79f52b2e324113 --pr-base 7065336c6f462a4f98cfb44c6a79f52b2e324113: 948 checked, zero unrenewed/stale/malformed/missing; no baseline edits |
| API declaration registration/order | Both blocks contain 378 identical module paths in ordinal order, including utils/supplierAttention and utils/supplierObligationPage |

The API-order proof is `C:/Users/123/AppData/Local/Temp/869s4-r2-api-order.mjs`:
extract paths from each block, assert each equals its sorted copy using
`(a, b) => a < b ? -1 : a > b ? 1 : 0`, reject duplicates, assert both new
modules present, and assert import/fullApi path arrays equal. This proof
script's comparator is not application code. Windows codegen was not invoked.

Mutation: changing the attention catch from SupplierReadBudgetExhausted to
TypeError killed `large joined sale documents withhold figures as incomplete
without advancing the cursor` (one intended failure, exit 1). The public query
threw SUPPLIER_ATTENTION_UNAVAILABLE instead of returning the expected empty
READ_BUDGET page. Source bytes were restored and hash-equal; the restored
backend suite passed all 20 tests. This is one killed error-identity mutant,
not complete mutation coverage.

Reports under `C:/Users/123/AppData/Local/Temp/`:
`869s4-r2-suppliers.json`, `869s4-r2-vehicle-regression.json`,
`869s4-r2-coverage/coverage-summary.json`, `869s4-r2-refresh-lf.log`,
`869s4-r2-opening.log`, `869s4-r2-mutant.log`, `869s4-r2-restored.log`,
`869s4-r2-io.log`, `869s4-r2-eslint.log`, `869s4-r2-guardrails.log`,
`869s4-r2-typecheck.log`, `869s4-r2-typecheck-convex.log`,
`869s4-r2-renewal.log`. The named vehicle/regression enumeration is
`869s4-r2-vehicle-regression-files.txt`.

### Round 2 synthetic captures

Same requested 869s4-renders directory as above. New component markup was
written into r2-markup by the coverage run; r2-render.cjs compiled AutoFlow's
actual globals.css and used a fresh Chromium page for each capture. Every
network request was aborted. All eight were inspected, have the expected
direction and no horizontal overflow. These are synthetic renders with local
fallback fonts, not authenticated journeys or assistive-technology tests.

- r2-workspace-en-375.png
- r2-workspace-en-1440.png
- r2-workspace-ar-375.png
- r2-workspace-ar-1440.png
- r2-states-en-375.png
- r2-states-en-1440.png
- r2-states-ar-375.png
- r2-states-ar-1440.png

Workspace captures show separate A/P/A/R, overdue, near-due and held amounts,
incomplete/unlinked notices and continuation. States captures show loading,
complete empty, budget/unlinked unavailable and localized error. The measured
width/direction evidence is r2-render-evidence.json. The design source is the
existing AutoFlow design system; no visual redesign was made.

### Boundaries and next work

Hosted Sonar zero-new-issues and new-code coverage, exact-head cloud CI,
independent seats, authenticated hunters, real Convex limits/OCC and production
parity remain unverified. The existing vehicles-page Playwright test creates
inventory; it was not executed because no verified isolated authenticated
app/backend was supplied and this lane forbids servers, deployment and
production access. Its absence remains a runtime-evidence gap, not a pass.
The parent supplier vehicle target tests passed within the supplier run.

Standards/Spec self-inspection found no additional integration defect: cache
scope, error identity, complete withholding, finite clamp behavior and all four
permission gates are retained. This is implementer inspection, not an
independent seat or hosted Sonar evidence. ADR sources (Convex pagination,
limits/read sets and WAI alert/status guidance) were rechecked on 2026-11-10.

The required graft build appended its cache rule to .gitignore. Its contents
were preserved, not staged or reverted; .ignore was not modified. A temporary
assume-unchanged index flag allowed the rebase without rewriting ignore bytes;
it is removed before handoff. The repeated tooling side effect triggered the
correct skill; its prior 2026-10-13/22/25 observations and this occurrence are
recorded in existing memory. Tool-side prevention is outside this rebase's
scope and needs a separate reviewed follow-up. Coordination claim creation
again refused because this runtime has no registered session; c24900 and the
user's explicit assignment identify lane ownership. No claim was completed
under someone else's session.

Next: coordinator reviews the rebased head, supplies isolated runtime proof
and independent seats, and owns the serial PR/CI train. No push is authorized.


## Round 3 quality implementation (2026-11-10)

Worktree E:/tmp/auto-869s4, branch claude/scrum869-supplier-alerts-v2. Round-2 starting head 669d91d578f06fb1865dfd5d3449f0c46a2d5920, stacked parent 7065336c6f462a4f98cfb44c6a79f52b2e324113. No push, PR, merge, deployment, server, watcher or production access. Protected ignore files remain unstaged and unchanged by implementation edits. No backup-branch operation was performed.

### Claim dispositions

| Item | Disposition and reproduction at round-2 source | Final change and evidence |
| --- | --- | --- |
| 1 | Accepted and expanded. Page's scopedRecoveryFacts checked only supplierId calls and threw plain Error; readRow only reports ConvexError data faults. Disputed payable settlement could skip operand conversion. Receivables already converted each operand but a negative received amount could make the remainder unsafe. | Checks live in shared facts for every scope. Worker tests use real stored documents, report bad rows before writes, and verify usable sibling delivery. Two independent red commits and a killed operand mutant below. |
| 2 | Accepted. Three branches repeated the same native-index selection and always computed totals. Due and Page imported each other. | One family factory/table and scoped index; always-nullable split metadata; paginationOpts only; aging alone computes totals and preserves its public shape. Facts moved to a third module, original four Due exports removed, duplicate imports removed. Outstanding/statement reader bodies compare byte-for-byte after newline normalization against the money-fix commit. |
| 3 | Modified as explicitly requested. bounded already delegated arithmetic to boundedCount but duplicated defaults; maximumRowsRead was 50, independent of requested 25, not equal to numItems. nowMs was ignored. | Shared clamp with preserved nonfinite defaults; common incomplete-page construction and one complete derivation. Keep independent 50-row / 1 MiB bounds. Validate and use nowMs exactly as outstanding. Existing midnight expected values stay, with current caller-time inputs; new cached-time/invalid-clock test failed before the change. ADR cites Convex caching guidance. |
| 4 | Accepted. attention repeated the system-owner/both-grants decision after requireTenantAuth. | Module-local mayReadStatement is shared by attention and unlinkedAttention. Tenant auth and impersonation liveness still run first, and grant denial returns exactly null. tenancy.ts is unchanged. |
| 5 | Modified. Local catch duplicated the existing supplier read failure mechanism. | Reuse supplierNavigationFailure, retaining coded auth/plan/time refusals. Keep SUPPLIER_ATTENTION_UNAVAILABLE because SupplierAttentionError's EN/AR coded message uses it; raw errors remain logged server-side and mapped generically. Existing navigation behavior and tests remain. |
| 6 | Accepted. Org-wide unlinked scan joined every supplier page and fetched up to 51 rows before some(). | Separate unlinkedAttention query, keyed by orgId/kind and gated by tenant, finance, cost and accounting. Named boundedPresence stops at first qualifying row, preserves headroom/51-row incompleteness and ordinary-creditor exemption. Public permission cases plus actual harness metrics: 1 document read and 0 writes among 51 qualifying documents. |
| 7 | Accepted. Attention repeated permissions, plan subscription/note and a timer. | Statement passes enabled and one nowMs. One active timer refreshes hourly or at Amman midnight with cached formatter helper; parent uses PERMISSIONS constants. No client query hook wrapper. Next advances using the cursor supplied by the sole eligibility condition in the view. Statement/Card/Tabs preserve language direction. |
| 8 | Modified. Side bundle already used defineBilingualMessages, so parity was already checked. | Attention pairs now directly belong to suppliersMessages. Reuse SuppliersBalancesAsOf, loadErrorMessage and shared positive-days rendering. Keep Next records / Previous records: available supplier pair pages suppliers, not records, and would change both language meanings. Twenty-one retained attention pairs compare identically. Split existing navigation message pairs to meet the unchanged size guard. |

### Failing-first evidence and commit order

First tests-only commit e0dcf977376e29b57b07be727215727e0ccd4f06: named worker file, selector unusable money, 5 intended failures and 1 passing receivable control (73 unrelated cases filtered). Recovery NaN/fractional/unsafe-gross variants returned 6 alerts / 0 skipped instead of 3 / 1; unsafe recovered and disputed unsafe payable silently returned 0 skipped. Log: C:/Users/123/AppData/Local/Temp/869s4-r3-red-committed.log. The initial behavior fix is 24341d304, followed by item refactor commits.

Advisory static inspection later suggested a separate receivable remainder gap. The public worker reproduced it at tests-only commit 17a653a1f40c3832c96c88af546f5b9ea9e203d7: 1 intended failure, 6 alerts / 0 skipped instead of 3 / 1. Log: 869s4-r3-remainder-red.log. Fix cc962c76c adds its safe-result check. This second test/fix pair follows the refactors because the finding arrived later. No reordering of prior commits or protected ignore-file changes was attempted.

The additional caller-time test failed before implementation: the ignored argument produced daysOverdue 1 instead of 0. Log: 869s4-r3-clock-red.log. Its final assertions cover the supplied day and NaN/infinite/fractional/out-of-window refusals.

An early mutant attempt overlapped a running green job, which invalidated that run and captured temporary source in a local commit. The temporary source was restored and that commit amended to the one-line intended fix after a serial green run. The first mutant also timed out before starting its worker, so it is not mutation evidence. Logs are retained, but none of those outcomes is counted as green or killed. Subsequent mutations and staging ran serially.

### Assertions and permanent records

No existing money, cost, permission, cursor, read-budget or threshold assertion was weakened. One existing expected field changed: the joined-sale-budget test now expects the independent unlinked query to return NONE rather than INCOMPLETE. It still requires an empty incomplete attention page, READ_BUDGET, isDone=false and the unchanged cursor. With independent queries, the empty missing-id range has its own budget and cannot inherit a supplier join failure. A mutant that forces that query to return INCOMPLETE fails exactly this assertion.

The old midnight test name/inputs now use validated caller time; its expected day, step and as-of values are unchanged. Component network mocks route the new independent endpoint and mount the real parent statement to exercise shared access and timer behavior. Render capture calls write only synthetic markup. No component assertion changed. New worker/permission tables became literal registrations with the same helper assertions because the scenario library rejects parameterized bindings. The original parameterized red names are not misrepresented as later literal names: their records are preventive controls without bugRef. The unchanged receivable-remainder test alone carries its own red SHA.

Sixteen changed records comprise 14 additions and 2 updated records, bringing this attention/worker group to 52. Their stored fingerprints come from scenarioRecord.test.ts's printed expected values (869s4-r3-fingerprints-initial.log and 869s4-r3-fingerprints-new.log). Scenario validation subsequently passed 70/70; the full library run passed too. Matrix additions: SCRUM869-worker-money-guard and SCRUM869-attention-presence-access. Existing Amman and join-budget rows were updated. No high-entropy idempotency value was added.

### Executed verification

All Vitest commands used named files and --maxWorkers=1. The supplier manifest is C:/Users/123/AppData/Local/Temp/869s4-r2-supplier-files.txt (43 existing files, complete component/supplier utility/worker enumeration). Results: 43 files, 959 tests passed, zero skipped. Log/report: 869s4-r3-suppliers.log and .json. Scoped coverage over 12 touched production modules: statements 95.90%, branches 92.03%, functions 95.74%, lines 97.94%. Page is measured: 17/17 lines, 18/18 statements, 10/10 branches. Facts has 63/63 lines and 77/80 statements. JSON inventory is 869s4-r3-coverage/coverage-summary.json; no absent/zero-case file is claimed covered.

After the final presentation/domain split, all 8 component files passed again (128 tests). UI/domain scoped coverage: 98.73% statements, 100% lines; log 869s4-r3-ui-final.log and summary 869s4-r3-ui-coverage/coverage-summary.json. This is local scoped coverage, not a hosted Sonar new-code verdict.

All 7 scripts/regression test files ran together: 379 passed, zero skipped. refreshRulings.mjs was temporarily set to the exact committed LF blob because this Windows checkout's CRLF shebang fails the transformer; its original bytes were restored in finally. This is not a claim that the original CRLF bytes passed. Log/report: 869s4-r3-regression.log and .json.

Serial final mutants:
- Recovery operand check replaced with false: literal unsafe-gross worker test fails with 6 alerts / 0 skipped versus 3 / 1. Log 869s4-r3-mutant-money-final.log.
- Independent presence query forced to INCOMPLETE: existing joined-budget assertion fails. Log 869s4-r3-mutant-independent-presence.log.
Both source files were restored byte-for-byte. The restored selectors pass together: 2/2, log 869s4-r3-restored-final.log. Earlier complete restored attention/worker run: 107/107, log 869s4-r3-restored.log.

pnpm typecheck passes after final UI/domain changes (root excludes convex as entry roots; transitive imports may still be checked). pnpm typecheck:convex checks the separate Convex project; the final repeat log is 869s4-r3-typecheck-convex-final.log. Root log: 869s4-r3-typecheck-final.log. Early generic index-type compiler failures were fixed with one schema-derived bridge at the shared pager; the table/facts pairing is native-query-bound, documented in the ADR, and tested for all three kinds.

Touched-file ESLint: 18 files, --max-warnings=0, pass (869s4-r3-eslint-final.log). Guardrails: pass, 1,069 production files measured, no limit/baseline/waiver change (869s4-r3-guardrails-final.log). Formatted nonblank counts from the real guardrail measureLines: statement 605/614, shared 423/600, Due 684/1117, Facts 340/600, Page 94/600, suppliers domain 585/600, navigation messages 61/600. Comments were not trimmed to fit.

checkBaselineIdentity: 948 baseline call identities matched; backend finding identity is explicitly not measured by this command (869s4-r3-identity.log). The focused opening-route test passes 1/1, with 231 unrelated tests filtered, log 869s4-r3-opening.log. api.d.ts has 379 entries in each block, both ordinal sorted, unique and identical, with Facts registered. Script: 869s4-r3-api-order.mjs.

Committed-tree renewal runs after this evidence/scenarios commit: node scripts/contractSkew/renewBaselineReviewed.mjs --check-evidence --reviewed 7065336c6f462a4f98cfb44c6a79f52b2e324113 --pr-base 7065336c6f462a4f98cfb44c6a79f52b2e324113. The parser requires a SHA after --reviewed. Read its actual final result in C:/Users/123/AppData/Local/Temp/869s4-r3-renewal-final.log and the final handoff; no baseline entry was edited.

### Synthetic renders

Design source: AutoFlow's existing globals.css, Tailwind tokens and shared components. Fresh Chromium pages, synthetic fixtures, all network requests aborted, local fallback fonts. All 24 captures have expected direction and zero horizontal overflow in r3-render-evidence.json. Representative populated, empty, loading, error, incomplete and unlinked captures were visually inspected across EN/AR and phone/desktop. No signed-in journey or assistive-technology behavior is claimed.

Directory: C:/Users/123/AppData/Local/Temp/claude/E--tmp-auto-781/481625ee-e49b-4d02-bc36-ebcb71386b79/scratchpad/869s4-renders/

- r3-empty-ar-1440.png
- r3-empty-ar-375.png
- r3-empty-en-1440.png
- r3-empty-en-375.png
- r3-error-ar-1440.png
- r3-error-ar-375.png
- r3-error-en-1440.png
- r3-error-en-375.png
- r3-incomplete-ar-1440.png
- r3-incomplete-ar-375.png
- r3-incomplete-en-1440.png
- r3-incomplete-en-375.png
- r3-loading-ar-1440.png
- r3-loading-ar-375.png
- r3-loading-en-1440.png
- r3-loading-en-375.png
- r3-populated-ar-1440.png
- r3-populated-ar-375.png
- r3-populated-en-1440.png
- r3-populated-en-375.png
- r3-unlinked-ar-1440.png
- r3-unlinked-ar-375.png
- r3-unlinked-en-1440.png
- r3-unlinked-en-375.png

### Remaining evidence boundary

Hosted Sonar 0-new-issues/new-code coverage, cloud CI, independent certification seats, authenticated three-hunter journeys, real Convex limits/OCC and production parity remain UNVERIFIED. The advisory was read-only static inspection, not a required review seat. It proposed the reproduced receivable remainder case; the implementer did not self-certify a seat. The existing exact-SHA release and pilot gates remain unchanged. No enabled financial operation, correction door or deployment credential was touched.

The correct skill was invoked for the recurring safe-net/unsafe-gross class (earlier SCRUM-850 memory plus this lane). Prevention is in shared backend fact checks and real-document worker tests, rather than unenforced prose; the existing memory was updated instead of duplicated. Industry sources and the query/pagination/read/status decisions are linked in the ADR.

### Round 3 code/test commits before this documentation commit

- e0dcf977376e29b57b07be727215727e0ccd4f06 test(SCRUM-869): expose unusable money in org-wide alert worker
- 24341d304e3e3fb59bebd8e1c70904b9f1ad1e33 fix(SCRUM-869): validate obligation operands for every alert scope
- 37053200e098fb226b80460c983823cc9b0b23e1 refactor(SCRUM-869): share obligation facts and consolidate native paging
- dc69bab9645bf259ed4ce78f956efd93731386c8 refactor(SCRUM-869): simplify attention paging and honor validated query time
- b4217787baa02ec234160053037b8b5a00e2b8d5 refactor(SCRUM-869): centralize soft statement access decision
- a76f297ace438123d3e2078ea8b75290e1272f4e refactor(SCRUM-869): reuse supplier read failure mapping
- 3218219bf89d88e9cd4f1b2db82b22b15c89d123 refactor(SCRUM-869): cache unlinked presence independently per organization
- 96b49ff8e1f651a9032a4b0cc360e09ed628915a refactor(SCRUM-869): share statement access and one attention clock
- e11cb943c671eb6ac7f5c71610013e9ab4ae24c0 refactor(SCRUM-869): consolidate supplier messages and overdue rendering
- 17a653a1f40c3832c96c88af546f5b9ea9e203d7 test(SCRUM-869): expose unsafe receivable remainder from safe operands
- cc962c76cc8aa2149119acf3303924f619f43c13 fix(SCRUM-869): refuse unrepresentable receivable remainders
- bbab0761acb6787937147a0668fff28c8b8cb986 refactor(SCRUM-869): preserve schema types through the shared pager
- 62a259c205852b5df54a3e4c051b2dd8f4d637f5 refactor(SCRUM-869): split supplier presentation and bind literal scenarios

### Changed scenario fingerprints

| Record | Printed fingerprint stored |
| --- | --- |
| supplier-attention-amman-boundary | 588bd78d45c6485991f5406c1703f792fbeaaa3ab043dc0fc6d57f82f3375dd1 |
| supplier-attention-cached-caller-time | b448d979c19c521a924de37759ecadf23e998ff739ca9d7f8ccf9e1538420cce |
| supplier-attention-joined-read-budget | f6442a5b1928adcb9abbbe16a1d0ec43c7d77068a0a2a6de8512491605e94370 |
| supplier-attention-presence-first-match | 00426dedfc20820210cf1cf235428bfc2ac71f721032357559504f66120ac481 |
| supplier-attention-presence-independent | 1fd0e286fad3bf9a0850d912b7a863907aedae8759f173886014ed0e294a72f0 |
| supplier-attention-presence-plan | 0bef0a842e07bb57d7665c1e97f3c9cd17420b1f9bf7330fe6d320afc50d8635 |
| supplier-attention-presence-tenant | 067a5313b8b0f230a2e9d9f5e5db12ac13860abb0b7e10561e6891cf7e3a20df |
| supplier-attention-presence-without-cost | 44b59016bd21b3c6cd4b529dc9d6e8545db41881d72ddd2e776ab9cc61b6f418 |
| supplier-attention-presence-without-finance | cf4f3973482d51c7e3785edb1ae509db2ce4b6f4244a467e2bfeda3dc3ea34f1 |
| supplier-worker-payable-gross-guard | 6914ae8e7a70f3d1801e74097c4f011ff5d19284ecc638674514a8724e8e286d |
| supplier-worker-receivable-gross-control | a02f8ef8a9a747986c7ddc2ca51bf1f4484a8bddce8df1549ec20bc0c1a10248 |
| supplier-worker-receivable-net-guard | 4670cf02d573020245f823354493df194f837d76cd617e25e48bc9f4e23d7326 |
| supplier-worker-recovery-fractional | 8191ba45cbdd571e75d269ecda9e4884437b8d16736f7cfafa0775dff19e1ecb |
| supplier-worker-recovery-money-guard | cf1fc8863573edf54d8dd11982b3988906108e9e32d0a5612b6c24030d7911fb |
| supplier-worker-recovery-nan | 4e0dc5662103957f079d4fd7a1dfb817741c28f980906b30b33a5b44c5dfcb6d |
| supplier-worker-recovery-unsafe-recovered | 7bf5184fcdb7f414220474d61810336f6f4de2430f789fef02d4df239321a365 |
