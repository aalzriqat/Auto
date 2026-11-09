# Supplier navigation local evidence

Scope: SCRUM-869 feature 1 and SCRUM-887 slice B, base
68be2346d9e2441e9d5bcf88cb980d9ad9189cd6. Implementation commit e2c67b6f1.
This is local implementation evidence, not independent seats, platform/OCC,
pilot certification, deployment verification or P7 launch evidence.

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
