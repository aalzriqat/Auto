# Supplier navigation local evidence

Scope: SCRUM-869 feature 1 and SCRUM-887 slice B, base
68be2346d9e2441e9d5bcf88cb980d9ad9189cd6. Round-2 production commit f9216f12b.
This is local implementation evidence, not independent seats, platform/OCC,
pilot certification, deployment verification or P7 launch evidence.

## Round 2 dispositions

All claims were checked against df1fd388b before changes. The three behavioral
defects reproduced before the fixes. This is implementer evidence, not a seat.

| Item | Disposition and evidence |
| --- | --- |
| 1 | Modified using the permitted stable-id option. Each native purchase payable is a relationship, including distinct invoices/acquisition episodes for the same vehicle. Its payable id is the React key across pages; a two-page test proves two ids. The ADR records why a repeat is correct |
| 2 | Fixed. Every computed money row, total, complete flag and reason survives decoration exhaustion. Only source and vehicleSource become null; creation timestamp and supplier snapshot remain available from the carried document |
| 3 | Fixed. Server href is the sole link decision in statement rows and Relationships. No SOURCE_PERMISSION map or per-row permission hook; finance/cost query gates and server authorization remain |
| 4 | Fixed. Readers carry their already-read obligation documents internally, stripped before the public return. No obligation reread or impossible same-snapshot identity-change throw. The optional normalizeId lookup is unnecessary because readObligation was deleted |
| 5 | Fixed. Per-call typed Maps cache vehicle, sale, application, expense and opening gets, including null results. Outstanding money facts share the handler cache. Relationships cache vehicle gets. Only misses ask for headroom |
| 6 | Fixed. Removed onPayableRead, mutable projectedPayable and its dead fallback. Handlers project after money readers return |
| 7 | Fixed. Both money readers run outside the enrichment catch, preserving their existing error contracts. Client error boundaries still show generic localized errors |
| 8 | Fixed. Balances, summary tiles and statements use the one Money implementation in SupplierStatementMoney |
| 9 | Fixed. Relationships use inventory StatusBadge, including green Available and blue Sold |
| 10 | Fixed. Native pagination options survive, overridden by server count, row and byte bounds. The shared boundedCount is moved byte-for-byte from suppliers.ts; registry behavior is unchanged |
| 11 | Fixed with one premise correction. useLanguage originally had isRtl but no dir, so LanguageProvider now exposes its existing direction as dir. Added vehicleSource, shared pagination metadata, Infer row type, cached per-locale formatters and one instant, neutral shared SupplierLoadError, one open decision, import/blank-line cleanup, and moved the FullSupplier type to ProfileSummary to remove the cycle |

## Round 2 red, green and read counts

Ordered local commits: 25126c1da (red tests), 48526abf9 (fixes),
f9216f12b (refactor). Every commit has the requested Codex co-author trailer.
Nothing is pushed, merged or deployed. Owner ignore files are untouched.

Red output, retained in `E:/tmp/869-r2-red.txt`:

```text
Test Files  2 failed (2)
Tests       3 failed | 17 passed (20)
two purchase obligations ... across pages:
  AssertionError: expected Set{ undefined } to deeply equal Set{ ...two ids }
decoration exhaustion ... complete money totals:
  AssertionError: expected [] to deeply equal [ payableId ]
source href alone controls links ...:
  Unable to find an accessible element with the role "link"
```

After the fixes, the same two files passed 20/20. After refactoring and adding
cost controls, all 17 navigation backend cases plus the required actual-opening
route case passed (2 files, 18 passed; the other 231 clientPaths cases were
filtered by the requested test-name selection). The final UI capture run passed
10/10 across navigation and direct-target files.

Affected-module runs, one worker throughout:

- All 30 convex/supplier* test files passed 730 tests. A later focused run also
  passed the newly added settled read-count case, bringing the navigation file
  from 16 to 17 cases.
- All seven components/suppliers test files passed 110 tests.
- All ten components/vehicles test files passed 130 tests.
- Scoped coverage: five named files, 58 tests, eight selected source modules.
  93.42% statements, 97.61% lines, 96.87% functions and 88.16% branches. Existing
  90/90/85/75 thresholds passed unchanged. New cache and clamp modules measured
  100%; row details and Relationships measured 100% statements and lines.
  This is not a hosted Sonar new-code verdict.

Read counts use authenticated registered handlers and a call-through spy on the
real harness db.get, without replacing documents or query results. Distinct-target
responses are checked for complete literal money totals; every fixture checks
completeness. Count scope includes
the organization, role and owned supplier gets, excludes seeding and db.query
range/ledger reads, and uses 100 rows in EACH family (300 obligations).

| Handler/fixture | Round 1 | Round 2 |
| --- | ---: | ---: |
| Outstanding, distinct targets at family bounds | 1503 | 803 |
| Settled, distinct targets at family bounds | 1103 | 803 |
| Outstanding, shared targets at family bounds | 1503 | 7 |
| Relationships, 50 purchases sharing one vehicle | 53 | 4 |

Round-1 counts were measured by temporarily loading the five relevant source
files from df1fd388b, running only the named cost checks, then restoring exact
backup bytes in finally. Before-count output is in 869-r2-before-counts.txt and
869-r2-before-settled-count.txt under E:/tmp. The worst distinct-source count is
3 gets per native payable/receivable, 2 per recovery, plus 3 auth/supplier gets.
The source-get maxima are therefore 1500 to 800 for outstanding and 1100 to 800
for settled. A normal membership adds the three measured fixed gets. An
impersonation membership adds one unchanged grant get in requireTenantAuth, so
the full query bounds become 1504 to 804 and 1104 to 804 for that auth path.
That additional grant read is source-derived, not measured by these normal-role
fixtures. The row bound and headroom limit reads; this is not cloud billing,
latency, concurrency or OCC evidence.

Mutant: restoring the totals/rows-dropping branch inside addSupplierRowContext's
budget catch killed the decoration-exhaustion regression (1 failed, 16 filtered).
The failure was the missing payable id; original source bytes were restored and
the later coverage run passed. Output: `E:/tmp/869-r2-mutant.txt`.

## Round 2 checks and scenarios

- Both final typechecks pass: pnpm typecheck excludes convex/;
  pnpm typecheck:convex uses convex/tsconfig.json. The root check first caught
  the absent dir property; exposing the provider's actual direction fixed it.
- ESLint passes max-warnings 0 on touched TypeScript sources and tests. The
  generated API declaration is ignored by repository policy and was excluded
  from the final lint invocation after the initial ignored-file warning.
- Guardrails pass with 1064 production files; no ceiling or threshold changed.
- Identity: 948 entries matched after nine mechanically proven call-site
  relocations. Initial renewal check correctly reported 13 stale entries.
  Scoped implementer source review refreshed only those entries' evidence,
  preserving fingerprints, causes, multiplicity, issues and expiry. The
  source-committed check reports 948 checked, zero stale, unrenewed, malformed
  or missing. Repeat the same check after the documentation commit.
- Twenty-seven navigation scenario records now bind to 27 literal checks.
  Twelve changed/new fingerprints are copied from scenarioRecord.test.ts's
  expected-value output and stored in the records. The three defect records
  bind bugRef to full red commit 25126c1da; cost controls are preventive, with
  no false failing-first claim. No descriptive idempotency keys were added.
- The full seven-file regression run had six passing files and 374 passing
  tests; refreshRulings failed to import because the Windows checkout's CRLF
  shebang reached Vite mid-line. The same five refresh tests then passed with
  a temporary LF normalization proven equal to the committed Git blob. Original
  checkout bytes were restored and hashes compared equal. All seven files have
  passing results across those runs (379 tests); no single all-seven green
  invocation is claimed. No test, threshold or gate was changed for this control.

The advisory Standards and Spec agents found no material production-code
mismatch before the final small LanguageProvider direction addition; two
unused/orphaned declarations/comments were cleaned up. These
reads are not independent certification seats or a claim that /simplify ran.

## Round 2 renders and boundaries

Same directory as below, with real component markup, application CSS, blocked
network and synthetic data only. r2-render.cjs compiles CSS and uses Chromium.
The initial GPU capture failed; --disable-gpu produced all twelve captures.
Every capture reports the requested width, equal scrollWidth and correct ltr/rtl.
States include the neutral direct-target error as well as Relationships states.

| View | EN, 375 / 1440 | AR RTL, 375 / 1440 |
| --- | --- | --- |
| Outstanding and Relationships | r2-outstanding-en-375.png, r2-outstanding-en-1440.png | r2-outstanding-ar-375.png, r2-outstanding-ar-1440.png |
| Settled and Relationships | r2-settled-en-375.png, r2-settled-en-1440.png | r2-settled-ar-375.png, r2-settled-ar-1440.png |
| Loading, empty and errors | r2-states-en-375.png, r2-states-en-1440.png | r2-states-ar-375.png, r2-states-ar-1440.png |

playwright/tests/vehicles.spec.ts is the vehicles-page E2E, not a Vitest file.
It creates inventory through an authenticated app and live backend. It was not
run against an unknown environment: no isolated backend/app is supplied, and
this task forbids Convex deploys and production data. Treat that runtime check
as UNAVAILABLE, not passed. Existing component controls and the synthetic
captures do not replace it. Real-backend hunters, trusted release evidence,
independent seats, hosted CI and Sonar remain unverified. No production key,
production data, deploy, watcher or dev server was used.

## Round 1 evidence retained for history

The ADR is `docs/adr/2026-11-10-supplier-statement-links-and-relationships.md`.
It contains the reader/index/bound/permission/field census, existing routes,
official Convex/Next/WAI sources, exclusions and five predicted failures.
No index or schema was added. No money writer, release script, workflow or
Playwright source changed. No production data, keys or cloud backend was used.

## Red, green and mutation evidence

- Red commit 096fb6e91: nine backend assertions failed for missing navigation
  context/query; UI suite could not resolve the new relationship component.
  Additional direct-vehicle test failed module resolution before its component
  existed. The implementation commit message records these failures.
- Full affected-module run: 39 named files, 1198 tests passed, one worker.
  Scope: every components/suppliers test and convex/supplier* test, plus the
  entire contractSkew/clientPaths test and pilotRoleAuditEvidence test. The
  latter includes 126 role-audit controls. Both actual opening routes passed.
- After replacing parameterized registrations with literal tests, the final
  navigation/backend/registry control passed 90 tests in four files. Every
  EN/AR assertion is retained in an explicit bounded two-locale loop. There
  are 20 new literal test registrations.
- Final scoped coverage: seven named test files, 122 passing tests; eight
  selected modules measured, 92.47% statements, 96.79% lines, 100% functions,
  86.14% branches. Repository thresholds remain 90/90/85/75 respectively.
  This is not a hosted Sonar new-code verdict. VehicleListStatusBadge is an
  unchanged extraction and is outside this selected coverage measurement.
- Mutant: removing sourcedSupplierId from the SOURCED index predicate makes
  the canonical-relationship assertion fail, showing same-name and id-less
  extra ids. One intended failing test, ten filtered; source restored and
  subsequently revalidated. No mutant is committed.
- Regression library: full seven-file run initially had five green files and
  two failures (parameterized scenario bindings and CRLF shebang import).
  After literal bindings and a local LF normalization equal to the exact Git
  blob, the two failed files passed 75/75 (scenarioRecord 70, refreshRulings 5).
  All seven files therefore have passing results across these runs; no single
  all-seven green rerun is claimed. The original checkout CRLF bytes were
  restored after this control; refreshRulings has no Git diff or status change.

## Other checks

- `pnpm typecheck`: passed; root configuration excludes convex/.
- `pnpm typecheck:convex`: passed with convex/tsconfig.json.
- ESLint on all touched source/test files: no errors. The vehicle page has
  58 existing explicit-any warnings; its 57 lines containing any exactly
  match the base after sorting. All other touched TypeScript files also pass
  with max-warnings 0. No lint policy was changed.
- Guardrails: pass, 1062 production files measured; no ceiling was raised.
- Baseline identity: 948 entries matched; backend finding identity is outside
  that tool's claim.
- Exact requested renewal command refuses with `--reviewed <rev> is required`.
  Adding `--reviewed 68be2346d9e2441e9d5bcf88cb980d9ad9189cd6` passes:
  948 checked, zero unrenewed, stale, malformed or missing entries. Nine moved
  SupplierDetailScreen call-site entries retain their existing fingerprints,
  expiry and causes, with native relocation and blob-review renewal evidence.

## Synthetic renders

Directory:
`C:/Users/123/AppData/Local/Temp/claude/E--tmp-auto-781/481625ee-e49b-4d02-bc36-ebcb71386b79/scratchpad/869s3-renders/`.
The component tests write real markup; render.cjs compiles application CSS,
uses Chromium setContent and aborts every network request. No dev server runs.
All twelve captures have scrollWidth equal to the requested viewport and the
expected ltr/rtl direction. Local fallback fonts are used.

| Files | What they show |
| --- | --- |
| outstanding-en-375.png, outstanding-en-1440.png | Outstanding source link, A/P, payee, created time, formatted JOD amount; separate empty A/R; both relationship types and incomplete notices |
| outstanding-ar-375.png, outstanding-ar-1440.png | Same synthetic facts with Arabic text and RTL; stock labels isolated with bdi |
| settled-en-375.png, settled-en-1440.png | Settled source link, actual paid amount and metadata; relationships |
| settled-ar-375.png, settled-ar-1440.png | Arabic/RTL settled view and relationships |
| states-en-375.png, states-en-1440.png | Localized loading, empty and generic error states |
| states-ar-375.png, states-ar-1440.png | Arabic/RTL loading, empty and generic error states |

## Permanent scenarios and remaining boundaries

Twenty `supplier-navigation-*.scenario.json` records reside under money (5),
permission (7), tenancy (2) and screen (6). Each stores the fingerprint printed
by scenarioRecord.test.ts and binds to one literal executable registration.
The four SCRUM869-navigation matrix sections are in
`docs/architecture/scrum486-certification-oracle.md`. All data are synthetic;
there are no descriptive idempotency keys.

No owner question remains for this slice. Legacy id-less records are excluded
without name matching; their count is omitted because no bounded aggregate
count exists and a complete count would require scanning their full ranges.
The unchanged target vehicles.get manually checks tenancy, redacts cost and
has preexisting pending-request scan limitations; this slice does not certify
its global scan bound or describe it as requireOwnedRow-based. Hosted Sonar,
independent certification seats, real-backend hunters and release gates remain
unverified here. Nothing is pushed, merged or deployed.
