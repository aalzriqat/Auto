# SCRUM-868 P7 local implementation evidence

Base: `68be2346d9e2441e9d5bcf88cb980d9ad9189cd6`.
Branch: `claude/scrum868-p7-launch-evidence`, worktree `E:/tmp/auto-868p7`.
Risk: MEDIUM, read-only certification and release gating. No money writer,
posting, settlement, allocation, schema or public argument changes.
This is an implementer handoff, not pilot certification. Nothing was pushed,
merged or deployed, and this session read no production data or key.

## Requirements and behavior

SCRUM-868 description and c23871/c23873/c24878-c24888, the full supplier design,
P4a/P4b/P5 ADRs, and SCRUM-760/761/762 informed the implementation. The earlier
blanket OPENING exemption is closed by P5. OQ-3 ordinary SHOWROOM vendor text
and OQ-4 ordinary OTHER_PAYABLE creditors remain exempt.

The [ADR](../adr/2026-11-10-supplier-launch-evidence.md) gives the eleven-table
census, exact identity fields, parent links, exemptions, index and budgets.
`openingPayablePayments` is added to the ten-table design list because P5
supplier payments inherit their identity from the payable. Recovery receipts
similarly inherit from their recovery. OWNED ON_ACCOUNT creditors are counted
on acquisition payables because the vehicle has no purchaseSupplierId field.

`supplierLaunchEvidence.scanPage` is internal and read-only. It scans globally
with native creation-time pagination, so an orphan organization cannot hide a
money row. Eight returned documents and at most eight parent/source reads per
call, row and byte budgets, one paginate call, and no database writes. Native
SplitRequired refuses rather than treating a potentially incomplete page as
complete. An exception returns fixed coded UNAVAILABLE without partial counts.

`supplierLaunchGate.ts` validates the complete response shape, walks all eleven
tables to READY, and refuses unsafe counts, non-progressing/repeated cursors,
unknown fields, failed calls, deadlines and page caps. Public summaries carry
fixed table/reason codes and counts. Raw ids, names, amounts and cursors are
not logged. The actual rollout phase is exercised with failed CLI responses.

`rolloutRelease.mjs` invokes the phase before both successful exits, including
the empty-org exit. A populated rollout keeps the existing separately authorized
P3 repair unchanged and checks the resulting data before success. Refusal says
DEPLOYED but INCOMPLETE. The existing operator query authority suffices; no new
secret, key, environment, branch protection or workflow YAML is introduced.
The exact-SHA trusted-accounting-release-verdict remains a separate gate.

## Executed evidence

- ADR committed first as `5e4b62141`; tests second as `b03672f33`.
- Red at the test stage: 18 backend cases fail because the new query module is
  absent; the release suite cannot import its absent module. An earlier fixture
  setup error was corrected before this red run and is not counted as evidence.
- Final new production modules plus library: 112 tests pass across
  `convex/supplierLaunchEvidence.test.ts`, `scripts/supplierLaunchGate.test.ts`,
  `scripts/supplierLaunchRollout.test.ts`, and
  `scripts/regression/scenarioRecord.test.ts`, with one Vitest worker.
- Scoped coverage of the two new production modules: statements 99.24%, branches
  96.32%, functions 100%, lines 100%. This is not a hosted Sonar result.
- Ten named census/rollout files pass 203 tests: the new census/gate plus
  accountantCommissionsRollout, accountantCostPriceRollout, dealNumberRollout,
  releaseEntrypoints, sourcedCostMirrorRollout, supplierIdentityRollout,
  supplierRegistryRollout and supplierVatHoldRollout. releaseEntrypoints needs
  the 30-second test timeout on this Windows machine; no assertion changed.
- P2/P3/P4a/P4b/P5 existing backend files, new evidence files and scenarioRecord
  pass 264 tests in the broader ten-file command; refreshRulings initially fails
  to load because of the known CRLF shebang issue. LF normalization in the local
  refreshRulings.mjs working copy gives 5/5 and zero Git diff for that file.
- Source mutant: remove openingPayablePayments from the production release
  census. The independent eleven-table test fails with the missing literal.
  The exact original bytes are restored and the new suite passes.
- Both root `pnpm typecheck` and separate `pnpm typecheck:convex` pass. Root tsc
  excludes convex; neither typecheck checks .mjs. Actual Node entrypoint tests
  execute the release scripts separately.
- Touched ESLint passes with zero errors and warnings. Guardrails pass with no
  raised file ceiling or new count pin. Call identity matches all 948 baseline
  entries. Committed-tree renewal with --reviewed and --pr-base both set to
  the pinned base checks 948 entries: zero unrenewed, stale, malformed or missing.
- `pnpm playwright test --list` discovers 70 tests in 20 files, including both
  EN and AR supplier journeys. It runs no browser. Test code remains outside
  the Vitest file naming pattern under playwright.

## Regression and runtime boundary

Forty new preventive records under `regression/scenarios/{money,screen}/supplier-p7-*`
include thirteen P2-P4b registration gaps and the two browser replays. Their
fingerprints come from the repository scenarioFingerprint function and validate
against the complete library. The digest-only c23871/c23873 ruling snapshots
are derived from fresh Jira text; the same method reproduces the existing
c23794 digest. No preventive record carries bugRef.

The matrix row is SCRUM868-P7-launch-evidence in
`scrum486-certification-oracle.md`. Existing P2-P4b rows retain the new bindings;
P5's existing 52 registrations are preserved. Previously unbound boundary tests
inside already registered repair/first-link doors are not presented as new
money behavior or new independent runtime certification.

`playwright/tests/supplier-identity.spec.ts` contains two literal authenticated
journeys. They select the supplier in an opening allocation and SOURCED vehicle,
then select that party's payable and pay it. The payment does not change its
immutable party. They assert supplier ids/names after reload, the independent
100003 minor-unit opening/payment literal, zero journal change from consignment
intake, RTL and isolated amount direction. They accept only the runner-local
Convex URL, block cloud Convex HTTP and nonlocal WebSockets, and disable service
workers for interception. The shared operator UI and public backend are real.

Docker reports no running daemon on this machine. The worktree contains no
environment file or authenticated browser state. Therefore the browser journeys
were discovered and statically inspected, not executed. No Playwright was run
against cloud or production. Phone/desktop screen audit, the explorer hunters,
real-backend execution, Convex cloud behavior/OCC, connected codegen freshness,
independent seats, CodeRabbit and hosted CI/Sonar remain UNAVAILABLE here.
The generated API declaration was extended offline using the existing template.

No owner decision is needed for credentials or configuration. A real nonzero
launch count must stay refused and be dispositioned by the coordinator/owner;
this change invents no exception for any historical test recovery. It supplies
no production count and cannot certify launch. Pagination proves the completed
walk, not an atomic deployment-wide snapshot or later administrative patches.

## Advisory review

Two read-only advisory axes inspected candidate a44dc148d. Standards found no
actionable issue. Spec found one LOW metadata error: thirteen public-door
scenario actors said RELEASE_OPERATOR instead of their fixture OWNER. The
records are corrected, their fingerprints recomputed, and scenarioRecord passes
70/70 again. These inspections are not formal certification seats. The local
review-state gate records the tests and deliberately remains INCOMPLETE for
missing independent coverage and closing approval. It authorizes no release.
