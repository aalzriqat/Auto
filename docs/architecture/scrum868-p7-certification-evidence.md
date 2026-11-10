# SCRUM-868 P7 local implementation evidence

## SCRUM-939 follow-up, 2026-11-10

This follow-up is on PR #806, branch `claude/scrum868-p7-e2e-submit-race`,
starting at `a9f48638539154676a9c679074b0bf64a6b3bbd5`, with fetched main
`43b8eafe0df7` and zero commits behind. The earlier sections below are historical
P7 evidence, not certification of this follow-up.

The component test at `8574e06bd6aa658a46d1ca92b81bb95abdee4c30` ran red:
three failures and one passing edit-mode control. The Photos Continue and final
submit were the same DOM node. A fully valid early form submit invoked
`vehicles.create` for a creator and `vehicleEdits.requestCreate` for a requester.
`fireEvent.click` did not reproduce native activation. Reading the supplied
`0db3070ff1dd686e499fb76bd8da488498a9408c.zip` trace confirmed that AR Continue
`call@390` already had Availability and Saving in its after-snapshot. DOM reuse
and early-submit behavior are reproduced locally; the native microtask and
activation ordering in the production component remains inferred.

Fix `626f432e4189d1f417848c0832e942b010591e10` adds distinct button keys and
returns before saving a new vehicle until Availability. Payloads, supplier
snapshots, approval selection, labels and idempotency retirement are unchanged.
The guard protects navigation intent; financial and authorization validation
still belongs to the backend. React documents distinct keys as distinct identity
in [Preserving and Resetting State](https://react.dev/learn/preserving-and-resetting-state).
The [HTML button activation rules](https://html.spec.whatwg.org/multipage/form-elements.html#the-button-element)
submit the form when an activated submit button has a form owner.
These sources support the design, not a claim that browser event timing was traced.

The four component checks then passed. Removing only the keys made the DOM
identity assertion fail (one failed, three passed). Removing only the guard
made the creator and requester early-submit assertions fail (two failed, two
passed). Both protections were restored. No existing VehicleDialog assertion
was changed. Test UUIDs are fixed low-entropy fixture values.

The coordinator's size-fit commit on top of `c8971afc5` keeps one key, on the
submit button. A keyed element and an unkeyed element in one position are
different identities to React, so the submit is still a new DOM node. Both
mutants were rerun against that shape with the same results: removing the key
failed the DOM identity assertion (one failed, three passed), and removing the
guard failed both early-submit assertions (two failed, two passed).

Strict-spec commit `4cf715540fdfcf0b25d2d0c9c5675a3a73280c70` removes swallowed
submit clicks. The supplier journey checks Availability and a complete empty
inventory read before the enabled Add Vehicle button is clicked. Confirm Payment
uses a plain awaited click too. Existing backend and dialog-close assertions
remain. The shared helper checks step 5, an enabled submit and no Saving button,
then awaits the click before checking the unchanged toast and closed dialog.
The nine call sites still consume the same returned make/model/VIN:

- `playwright/fixtures/cashSale.ts:10`
- `playwright/fixtures/financedDeal.ts:460`
- `playwright/tests/financed-deal-economics.spec.ts:89`
- `playwright/tests/pilot-commissions-cash.spec.ts:65`, `:80`, `:134`
- `playwright/tests/profit-approval.spec.ts:48`
- `playwright/tests/sales-wizard-guards.spec.ts:38`
- `playwright/tests/vehicles.spec.ts:12`

Enumeration command: `git grep -n "createVehicle(" -- playwright`. Its other
two hits are the helper declaration and its diagnostic message. All nine calls
are awaited; the required-immediate controls and caller assertions are intact.

The final class census parsed 646 tracked JS/TS files under `components/` and `app/`:
3,834 conditional expressions, 2,463 if statements and 580 JSX type attributes.
It compared both button/submit orders across multiline branches and checked
dynamic type attributes. The sole candidate was VehicleDialog's footer at
line 1233. No if/else candidate was found. The five dynamic attributes belong
to input fields (`listingFields`, `CreateAccountingPeriodDialog`,
`CustomFieldsSection`, `ui/input`) or the `MovementDialog` domain prop in
`PartnerEquityTab`, not a swapped submit control. This is a source census, not
proof about arbitrary runtime spread props or external component implementations.

The final named-file Vitest run passed 142 tests in 11 files with
`--maxWorkers=1 --testTimeout=120000`: every `components/vehicles/*.test.tsx`
and `scripts/regression/scenarioRecord.test.ts`. The scenario validator printed
fingerprint `6e4c46e1d276a3493b76cc76ef4835a70d4a1f9edfc7a9de46283456593b00f6`,
now stored in `vehicle-wizard-final-confirmation.scenario.json`. Its bugRef
names the full tests-only red SHA. The existing vehicle supplier-intake section
in the SCRUM-486 oracle carries a screen-control row, explicitly not backend
financial certification.

Root `pnpm typecheck` passed, including Playwright and the new fixture; it
excludes `convex/`. Separate `pnpm typecheck:convex` passed. Touched-file ESLint
exited zero with zero errors and 83 warnings in the existing VehicleDialog.
Playwright discovery passed with 70 tests in 20 files. Guardrails FAILED at
`c8971afc5`: VehicleDialog measured 1,696 formatted nonblank lines against the
existing 1,690 ceiling (`SIZE-GROWN` and `CEILING-BELOW-CURRENT`). No ceiling
was raised.

The size-fit commit brings the file back to 1,690 lines, and
`node quality/guardrails/check.mjs` exits zero with the ceiling unchanged. It
drops the Continue button's key, which had pushed that tag past 80 columns. It
joins the two early returns in `onSubmit` into one condition with the same
short-circuit order, and it inlines the `stepIsValid` constant in
`handleNextStep`. The named-file Vitest run still passes 142 tests in 11 files.

Baseline identity initially refused eight entries shifted by the one inserted
guard line. The relocation tool compared each call expression to `a9f48638`,
proposed eight safe relocations and zero changed/ambiguous calls, then wrote
only those eight callSiteId positions. No finding or reviewed metadata was
removed or renewed. The post-relocation check passed: 948 baseline entries
matched by surface, file, callSiteId and functionId. Backend finding identity
was not checked by that command.

After the size-fit commit, the eight call sites are on their `a9f48638` lines
again, so the baseline file is restored to its `a9f48638` content and this PR
no longer changes it. The identity check passes with 948 entries.

The small offline markup bridge `VehicleDialogVisualFixture.test.tsx` renders
the real create wizard with synthetic data. Chromium painted it with compiled
`app/globals.css`, no server, auth or backend, and network requests blocked.
All eight PNGs were visually inspected, with zero page horizontal overflow:

- `vehicle-en-375-step4.png`
- `vehicle-en-375-step5.png`
- `vehicle-en-1440-step4.png`
- `vehicle-en-1440-step5.png`
- `vehicle-ar-375-step4.png`
- `vehicle-ar-375-step5.png`
- `vehicle-ar-1440-step4.png`
- `vehicle-ar-1440-step5.png`

PNG directory:
`C:/Users/123/AppData/Local/Temp/claude/E--tmp-auto-781/481625ee-e49b-4d02-bc36-ebcb71386b79/scratchpad/939-renders/`.
Raw red, green, mutant, census, lint and check logs are retained under
`C:/Users/123/AppData/Local/Temp/scrum939-evidence/`.
These static renders verify paint and RTL, not native submit timing or backend
effects. Authenticated E2E, explorer hunters, independent review and a fresh
Sonar analysis (zero new issues and at least 80% new-code coverage) remain
UNAVAILABLE. No push, deployment, production credential or backend browser run
was performed. `.ignore` and `.gitignore` remain outside the patch.

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
