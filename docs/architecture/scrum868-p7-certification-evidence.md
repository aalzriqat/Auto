# SCRUM-868 P7 local implementation evidence

Base: `68be2346d9e2441e9d5bcf88cb980d9ad9189cd6`.
Branch: `claude/scrum868-p7-launch-evidence`, worktree `E:/tmp/auto-868p7`.
Round 1: `01ebb04b5cdb351e602719aa6ac740090019cd1b`, Jira SCRUM-868 c24892/c24893, PR #804.
Risk: MEDIUM, read-only certification and release gating. No money writer,
posting, settlement, allocation, schema or public argument changes.
This is an implementer handoff, not pilot certification. Round 2 is local and
unpushed; no deploy, production key or production data was used. The local
`.gitignore` and `.ignore` tooling changes are outside the patch.

## Round 2 dispositions

All seven claims were checked against the branch before changing it.

1. **Fixed.** The eight-row page and parser cap were real. A 1,001-row backend
   fixture reproduced an eight-row first page; the large driver fixture refused
   1,000-row responses. One shared constant now sets the backend/parser cap to
   1,000. MaximumRowsRead 1,001 and maximumBytesRead four MiB remain fail-closed.
2. **Fixed structurally.** P7's duplicate pager and Zod response parser are
   removed. The phase and response validation live in `releaseGuard.ts`, using
   `walkCursorPages`, `isCount` and `parseCursorPage`. Those shared primitives
   moved mechanically to `releaseCursorPages.ts` rather than growing the main
   guard with another loop. `supplierLaunchGate.ts` is deleted. The `.mjs` shell
   calls one phase from `finishSuccessfulRollout`; both successful branches are
   executed with zero, unresolved and unreadable evidence before summary/exit.
   Existing release phases retain exact-deadline acceptance; P7 retains its
   stricter equality refusal. All reject late calls and stalled/repeated cursors.
3. **Fixed with an explicit scope decision.** P3's predicates, page options,
   byte limit and completion shape were local to its driver, not already in its
   utility module. They moved unchanged into that utility; P3 repair/count
   behavior stays unchanged. P7 calls them, including `holdsConcession`, but also
   counts every persisted basis, including terminal history. Held concessions
   with no basis are unresolved; no-basis/non-held applications are exempt.
   The actual P3/P7 comparison test covers these shapes.
4. **Fixed by exemption.** Pending UPDATE requests whose vehicle is missing,
   foreign or deleted cannot be applied. Actual `vehicleEdits.resolve` calls
   refuse with "Vehicle not found." and leave the census tables unchanged.
   Such requests no longer make the census unavailable. A database read failure
   still refuses. No informational counter is needed for a dead request.
5. **Fixed.** One runtime-neutral registry defines tables, reasons and page size;
   validator fields, count type, empty counts and driver table walk derive from it.
   Typed per-table scanners remove the P7 `row as Doc<...>` casts.
6. **Fixed.** Row helpers return reason keys/null, with independent payee/bearer
   reasons for expenses. Receipt/payment handlers share a parent lookup and a
   per-page Map, including cached ordinary-creditor exemptions and receiving-org
   checks. An I/O spy over the real database measures one parent get for two rows
   in each table; no database response is mocked.
7. **Fixed.** `editMissing` names sourced, named, changedName and onAccount; the
   effective-update decision is split to reduce boolean nesting.

The [ADR](../adr/2026-11-10-supplier-launch-evidence.md) records the decisions,
trade-offs and official Convex/Node/TypeScript sources. The eleven-table census
still includes openingPayablePayments, whose identity is inherited from its
same-org payable. Recovery receipts similarly inherit from their recovery.
OQ-3 showroom vendor text and OQ-4 ordinary OTHER_PAYABLE remain exempt.

## Read and call budgets

The fixed driver fixture accepts 5,000 vehicles in **5** calls and 20,000 expenses
in **20** calls, plus **9** calls for the other empty tables: **34**, compared with
**3,134** at eight rows. These are measured driver invocation counts, not CLI
spawn timing. The backend separately walks 1,001 real harness rows as 1,000 + 1.
An initial attempt to insert all 25,000 rows in the harness was stopped for local
cost; it is not evidence. No production wall-clock or platform I/O claim is made.

At most 1,001 scan reads plus 1,000 parent/source gets fit the 32,000-document
limit, with at most 1,001 index ranges against 4,096. Four MiB bounds pagination;
parent gets also consume the sixteen MiB transaction budget. A page with large
parents can still fail at that limit. Native split/read failure refuses rather
than accepting partial counts. No internalAction, new index, schema deploy or
backfill is required for the measured fixture budget.

## Red and green evidence

Round 2 commits follow the requested order:

- `2de1a4f1f44f5783fd96203d1c9ca9423196a808`: failing tests.
- `aad056881`: fixes, after the red run.
- `e6c861a9d`: shared rules/pager refactor.
- Final docs/scenarios commit follows these three; its SHA is in the handoff.

Red output is retained locally in `E:/tmp/p7-r2-red2.txt` and
`E:/tmp/p7-r2-red-rollout.txt`:

```text
Test Files  2 failed (2)
Tests       7 failed | 37 passed (44)
Test Files  1 failed (1)
Tests       2 failed (2)
```

The failures are the eight-row backend page, refusal of the large driver
fixture, dead edits yielding UNAVAILABLE after successful approval-refusal
assertions, and absence of the shared success helper. This is not a measured
1.3–2.6-hour production reproduction. The old page-size/spawn mechanism is real;
the elapsed-time estimate remains an estimate.

Green after fixes: 46/46 focused cases. After extraction: 73/73 including the
existing P3 suite. Full affected module/rollout command: **339/339 in 13 files**,
including releaseGuard tests, every named rollout suite, P3 repair, P7 census
and releaseEntrypoints. The final test-only literal registrations also pass
30/30. Vitest always uses one worker and named files.

Scoped coverage across the guard, shared pager, P7 census/registry and P3 utility:
**98.35% statements, 97.01% branches, 99.29% functions, 99.51% lines**. Existing
90/85/75/90 thresholds were not changed. This is V8 coverage, not hosted Sonar.

The first broader run caught a deadline-equality regression in two existing
phase tests; the implementation was corrected, with those assertions intact.
A source-order assertion now follows the shared success helper instead of an
inlined exit. A local CRLF mismatch in the actual Node entrypoint test was
corrected by restoring LF bytes in the `.mjs` working copy, with no changed
assertion. Typechecking also caught a framework-private `_handler` access in
the I/O test; that test now instruments the shared typed handler directly.

A source mutant restores the dead-source throw. The selected three literal
missing/foreign/deleted controls fail (exit 1, READY expected but UNAVAILABLE
received). Original bytes are restored and verified against the committed
source, then the census is rerun green. This tests the repaired reason rather
than an unrelated error.

## Regression and remaining verification

The earlier forty P7 records remain. Seven new records cover large-fixture
call budget, verified success exit, historical/held concessions, parent cache
and all three dead-source shapes. The existing empty-exit and other gate records
bind the moved literal tests. Fingerprints printed by scenarioRecord's failure
output are stored in the records. Only the unchanged literal pagination test
carries a new bugRef to the full round-2 red SHA. Idempotency keys remain KEY_1.
The matrix is `SCRUM868-P7-launch-evidence` in scrum486-certification-oracle.md.
A supplementary seven-file regression-script run stalled in Git-backed fixture
machinery and was stopped, so that broader script suite is not a passed check.
A separate retry failed to start its fork worker; another hit an unchanged
five-second test timeout under local load. The library is rerun separately with
its assertions/timeouts unchanged. The final sequential run of scenarioRecord,
the census, release guard and rollout tests passes **121/121** with
`--maxWorkers=1 --pool=threads`. The
[documented threads pool](https://vitest.dev/config/pool) avoids the fork-start
failure without changing a test timeout or assertion. The normal forks run's
startup/test/cleanup timeouts remain recorded as local infrastructure failures.
The library's conservative raw skip-option scan mistakes a release callback
property for a runner option, so the two test fixtures use a computed callback
key; the callback still throws and no test is skipped or weakened.

Root `pnpm typecheck` passes; it excludes convex (apart from imported types/modules)
and does not check `.mjs`. Separate `pnpm typecheck:convex` passes. A direct Node
import of releaseGuard succeeds with its explicit .ts imports. Touched ESLint
has zero errors/warnings. Guardrails pass with unchanged ceilings/count targets;
baseline call identity matches 948 entries. Committed-tree renewal with
--check-evidence, --reviewed and --pr-base at the pinned base checks 948 entries:
zero unrenewed, stale, malformed or missing. The owner's shorter invocation
without --reviewed refuses because that required argument is missing; it is not
a passing check. Playwright discovery passes: 70 tests in 20 files, including
both supplier journeys. A final renewal is rerun after this documentation update.
Local Node is 26.4.0; the Node 22 CI runtime was checked against its documentation,
not executed locally.

Standards and Spec advisory readers found zero validated production defects.
They are not independent certification seats. Hosted CI/Sonar (including zero
new issues and analyzer cognitive complexity), independent seats, CodeRabbit
coverage, actual disposable-backend/browser journeys, EN/AR phone/desktop
screen audit, explorer hunters, cloud limits/OCC and production counts remain
UNAVAILABLE in this local handoff. No NOSONAR or threshold/gate relaxation was
introduced. Existing supplier EN/AR journeys are discovered, not certified here.

No owner credential/configuration action is required. Any real nonzero count
stays refused for coordinator/owner disposition. Pagination is a completed walk,
not a deployment-wide atomic snapshot. SCRUM-868/760 remain unclosed.
