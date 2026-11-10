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
