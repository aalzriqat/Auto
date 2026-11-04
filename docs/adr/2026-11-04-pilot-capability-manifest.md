# Pilot capability manifest: the UI offers only what the server allows

Status: accepted, implemented on branch claude/scrum810-capability-truth. ADR required before a money or permission PR by
SCRUM-760 c24361. Jira: SCRUM-810 (dependencies SCRUM-760, 761, 795, 802, 803, 804, 801, 806, 617, 762).

## Context

The narrow pilot (SCRUM-760 decision B, 2026-10-19) keeps many financial doors shut with compile-time switches. Each switch is a
`true as const` in a leaf module under `convex/utils/` (or `lib/pilotCapabilities.ts`). Three things drift apart:

1. **UI offers a refused action.** On origin/main 30a6429e the Payment Links panel disables "New payment link" but still enables
   "Mark settled" on a pending link, and the server refuses it with `PAYMENT_LINKS_DISABLED` (SCRUM-810 c22842). The Fixed Assets
   tab offers "Capitalize", "Impair" and "Dispose", and the server refuses all three with `FIXED_ASSET_LIFECYCLE_DISABLED`
   (SCRUM-560). Other screens (manual journals, partner distribution, RT11 doors, receipt doors, payout) already gate themselves,
   each in its own way, and nothing proves a future screen will.
2. **A new switch has no owner.** Nothing fails when someone adds a `*_PILOT_DISABLED` constant without refusal copy, a UI gate
   or a recorded list of doors.
3. **Tests can run with a different pilot config than production.** About 100 test files mock a containment module open
   (`openRt11Doors`, `openFixedAssetLifecycle`, `pilotSwitchModule` and others) so that historical lifecycle suites run. Those
   suites say nothing about the shipped configuration, and nothing marks them as such, so a green run reads as pilot evidence.

## Decision

Add one manifest, `lib/pilotCapabilityManifest.ts`, that the UI and the tests both read. It is derived from the very constants the
server reads; it does not replace them and changes no switch value.

- `PILOT_SWITCHES`: every switch, keyed by its constant name, with a reader function that goes through the same export the server uses
  (the constant, or the module's own `is...Disabled` function, so a test that mocks either shows up).
- `PILOT_CAPABILITIES`: one entry per capability. It names its switches, the EN/AR refusal keys, and the public Convex doors it
  guards, each with the identifier that must appear in the door's source. When its switch is on, a door that refuses every invocation is `whole`;
  a door shared with enabled behaviour is `conditional`.
- `isPilotSwitchOn(key)`: the one call a screen makes to decide whether to offer an action. The two screens with a verified
  divergence use it. Screens that already gate themselves keep their gate; the test pins that the gate is still present.

Four tests fail when the layers diverge:

1. **Discovery.** Exported `*_PILOT_DISABLED|REQUIRED|REFUSED` bindings and exported boolean door-map keys in the shared
   whole-root source snapshot must be keys in `PILOT_SWITCHES`. A new switch cannot ship unregistered.
2. **Copy.** Every capability's refusal keys exist in the EN and AR dictionaries, and the AR text differs from the EN text.
3. **Server.** Every registered door's source contains its guard identifier.
4. **UI.** Every `api.<module>.<fn>` reference in `components/`, `app/` or `hooks/` to a `whole` door must be in the
   capability's declared caller list, and each declared caller file must still contain its gate.

Config parity: `test-utils/pilotConfigParity.ts` exports `assertPilotCertifyingConfig()`. It compares each switch's effective
value (after any `vi.mock`) with the value written in the source file. A mismatch throws `NOT PILOT CERTIFIED`. A suite that
claims pilot certification calls it in `beforeAll`. A second test lists the test files that mock a containment module open: each
must carry the header `NON-PILOT-CERTIFYING` or be in the baseline file
`test-utils/nonPilotCertifyingBaseline.json`, which can only shrink. Such a suite can never satisfy SCRUM-760 G2/G3/G7.

## Not done here, on purpose

- Payment links and fixed assets stay off. No switch value changes. The held-funds review and the expiry of an existing pending
  link stay available.
- The `conditional` doors are checked for their guard in the server, but the UI test cannot prove a conditional branch is hidden;
  those need a rendered test per screen (SCRUM-761 replay).
- Only references written as `api.<module>.<fn>` are found. A call through a string-built function name or a re-exported
  reference would escape the UI test. Absence of those forms is not established by this census.
- The test does not prove the gate is applied to the right button, only that the file still holds it. The two fixed screens have
  their own rendered EN/AR tests. The remaining screens keep the render tests they already have.
- The ~100 existing suites that open a door stay as they are, listed in the baseline. Converting them to pilot-certifying tests
  is separate work under SCRUM-761.
- A real-viewport render (phone and desktop, EN and AR, RTL) needs an authenticated backend; this change ran jsdom component
  renders only. That gap is recorded on the PR.

## Consequences

Adding a pilot switch now needs: a manifest entry, refusal copy in both languages, a server guard in each named door, and either a
UI gate or a recorded reason there is no UI. Re-enabling a capability is still a reviewed code change plus its own certification;
flipping a constant in source also changes what the manifest reads, so the parity check alone cannot see it. Two things catch it:
`EXPECTED_SHIPPED` in `lib/pilotCapabilityManifest.test.ts` pins the shipped value of every switch, so a flip fails that test until
the same change edits the table, and the parity check fails when a test mock, a re-export binding (`PILOT_SERVER_BINDINGS`) or a
server guard (`PILOT_SERVER_GUARDS`, which the check calls and expects to throw) disagrees with the shipped value.

## Review remediation from 62b34bf2

Switch discovery keeps the exported pilot name as well as the resolved declaration. It reads the declaration's initializer,
accepts literal booleans, and records nonliteral values as unavailable. Distinct pilot aliases of one declaration remain
distinct switches. The TypeScript checker supplies binding identity and resolves import and export aliases with
[`getAliasedSymbol`](https://github.com/microsoft/TypeScript/blob/v5.9.3/src/compiler/types.ts#L5208).
`getImmediateAliasedSymbol` follows one alias; this check needs the final declaration and separately retains the exported name.
The snapshot compiler host reads only the supplied sources, including the generated server declaration for builder identity.

The mock census resolves local import bindings from `vitest`, including renamed `vi` and `vitest` imports and namespace
imports. It recognizes property access, literal element access, and destructured methods, including renamed destructuring.
Shadowed parameters and imports from other packages do not count as Vitest bindings for precise detection. The round-3
argument rule still includes these calls when a pilot module argument is present. The precise binding distinction follows the
[Vitest API](https://vitest.dev/api/vi.html#vi-domock): `doMock` executes without hoisting and affects subsequent imports.
The census conservatively detects these access forms for both `mock` and `doMock`; it does not infer that hoisting succeeds.

The reverse census discovers `assert*Allowed` and `assert*Enabled` exports from `convex/utils/*Containment.ts`, independently
of the manifest. It scans exported public mutation handlers in top-level non-test `convex/*.ts`, resolving builder and guard
imports through the checker. It examines direct guard invocations, including those nested in conditional branches and callbacks.
Public builders are the aggregate-aware builders in `convex/functions.ts` and the generated public mutation builder.
It does not trace arbitrary helper call graphs or prove which branch executes.

`requestRetainedCreditRefund` is a whole door with its existing `DealInvoiceReceiptsPanel.tsx` caller and `payoutAvailable`
gate. `respondToRetainedCreditRefund` is conditional on APPROVED, custody reconciliation on write-off, and `finalizeDeal` and
`completeDraft` on the refused OTHER deposit treatment. The supplier receipt reversal remains a test-only named exclusion
because the supplier census forbids its name in shipped `lib/` code. Three supplier payment or receipt operations have
reasoned exclusions for their method restrictions. The check asserts that those exclusions still call only the method guard.
Stale exclusions and empty discovery fail.

The `correct` skill's recurring binding-identity class applies here: the previous review controls cover aliased switch
imports, while this review reproduced missed pilot-named exports and renamed Vitest imports. The prevention stays in the
compiler-based discovery and executable negative controls. No financial authority or switch value changes.

Failing-first evidence:

- `pnpm exec vitest run test-utils/pilotConfigParity.test.ts --maxWorkers=1 -t 'R2-F[12]'`: before the fix,
  9 failed and 5 passed. Both export-alias controls and seven mock-access controls failed. After the fix, 14 passed.
- `pnpm exec vitest run lib/pilotCapabilityManifest.test.ts --maxWorkers=1 -t 'R2-F3'`: the initial reverse check failed on
  six unregistered operations. After registration and reasoned exclusions, it passed. Removing just the new refund-request
  whole-door registration then failed with exactly `retainedCreditRefunds.requestRetainedCreditRefund` missing. The registration
  was restored for final validation.

These are local source and test results. They do not certify a real Convex backend, pilot readiness, a deployment, or independent
review. No client component changed, so this remediation does not relocate contract-skew baseline entries.

Final focused command:

```powershell
pnpm exec vitest run test-utils/pilotSourceDiscovery.test.ts test-utils/pilotConfigParity.test.ts lib/pilotCapabilityManifest.test.ts components/accounting/FixedAssetsTab.pilotOff.test.tsx components/accounting/ManualJournalTab.pilotOff.test.tsx scripts/legacyCollectionRefundOptOutCensus.test.ts scripts/supplierSettlementCensus.test.ts convex/scrum802OptOutCensus.test.ts --maxWorkers=1
```

Result: 80 passed and six pre-existing Windows-path failures in `convex/scrum802OptOutCensus.test.ts`.
Both `pnpm typecheck` and `pnpm typecheck:convex` passed. The root configuration excludes `convex`, `test-utils`, `apps`,
`packages`, `dealer-worker`, and `node_modules` as input roots. The Convex configuration includes `convex` and `test-utils`,
excludes `_generated` as an input root, and does not check the frontend, mobile, shared, or worker projects as separate projects.
Imports may still bring excluded files into either compiler graph.

```powershell
pnpm exec eslint lib/pilotCapabilityManifest.ts lib/pilotCapabilityManifest.test.ts test-utils/pilotConfigParity.ts test-utils/pilotConfigParity.test.ts test-utils/pilotSourceDiscovery.ts test-utils/pilotSourceDiscovery.test.ts --max-warnings=0
```

Changed-file lint passed. A separate local ESLint run with SonarJS 4.2.2's recommended rules and cognitive complexity limited
to 14 reported zero errors and warnings. Remote Sonar analysis and fresh review seats remain coordinator work after the push.

```powershell
pnpm exec vitest run test-utils/pilotSourceDiscovery.test.ts test-utils/pilotConfigParity.test.ts lib/pilotCapabilityManifest.test.ts --maxWorkers=1 --coverage --coverage.include=test-utils/pilotSourceDiscovery.ts --coverage.include=test-utils/pilotConfigParity.ts --coverage.include=lib/pilotCapabilityManifest.ts --coverage.reporter=text --coverage.reporter=json-summary --coverage.reporter=json
```

Coverage validation passed all 54 tests and the unchanged configured thresholds. Across these three implementation modules,
line coverage was 99.63% and branch coverage was 93.11%. Comparing added lines from `git diff --unified=0 HEAD` with the V8
statement start-line counts measured 74 added executable lines, all covered. The protected customer-credit containment file's
Git blob remained `af09f908267944be4189ec7720301c775b50c848`, matching the starting HEAD. `git diff HEAD -- convex` was empty.


## Round 3 remediation at 721482d3

The round-2 binding-specific repair still missed local aliases, extracted methods, `bind`, `call` and dynamically imported
Vitest bindings. `/correct` applies to these two distinct review rounds. Prevention is enforced by call structure and the
shared source snapshot, rather than another finite list of callee forms.

| Finding | Failing-first control | Enforced behavior |
| --- | --- | --- |
| R3-F1 mock census | 13 failures across local/extracted/bound/call/dynamic-import aliases, arbitrary callees and unrelated or shadowed bindings | Any non-import call with a readable pilot module argument counts. Static and dynamic imports alone remain negative controls. |
| R3-F2 roots | A mocked `hooks/reviewBarrel.ts` re-export still certified | Binding discovery and the switch census read `pilotSourceSnapshot()`, one cached whole-root map per module load. Unmeasured re-exports refuse certification. |
| R3-F3 destructuring | Six object/array/nested/renamed/default binding controls returned no declaration | Compiler-exported bindings are enumerated even when their value declaration is a `BindingElement`. Their values are unavailable, not guessed from defaults or RHS objects. |
| R3-F4 reversal | Both whole-door scan and actual hooks fixture controls missed `hooks/useSupplierReversal.ts` | Receipt reversal always refuses. Its test-only whole-door scan expects no screen caller. Supplier census includes `hooks`. |
| R3-F5 LOW items | Commission door registration, internal-door exclusion and direct-switch reverse census controls all failed | Both commission mutations are whole doors gated by server `writesEnabled`; internal subledger payment is excluded with a reason; public handlers reading exported pilot switch symbols join the reverse census. |

The failing-first command was:

```powershell
pnpm exec vitest run test-utils/pilotConfigParity.test.ts test-utils/pilotSourceDiscovery.test.ts lib/pilotCapabilityManifest.test.ts scripts/supplierSettlementCensus.test.ts --maxWorkers=1 -t R3 --reporter=verbose
```

Result before the fix: **25 failed, 1 passed**, with unrelated tests filtered out. The passing control imports the module without
replacing it. After implementation, the four-file run passed all 26 round-3 controls but exposed six newly included suites.
Those suites now carry explicit non-certifying labels with the reason. Three match commission table names, two call
`importActual`, and the supplier census reads a containment source file. No baseline entry, assertion or threshold was loosened.

The argument rule deliberately over-approximates: matching uses the discovered module basename, and any argument position
counts, including the module promise form. Bare strings sharing that basename, source reads and `importActual` can also trigger
it. This false-positive policy avoids relying on recognition of an alias's implementation. Precise Vitest detection remains
because it also refuses unreadable mock targets and spies on known switch/guard names without a module literal.

The snapshot traverses root files and non-hidden directories, excluding `node_modules`, `_generated`, `coverage`,
`playwright-report` and `test-results`. It includes `.ts`/`.tsx` production sources and excludes declaration files and
`.test`/`.spec` files. The public mutation census adds the generated server declaration solely for builder identity.
The snapshot is immutable by convention and refreshed when test modules reset; it does not observe edits after creation.

Remaining limits:

- Arbitrary callees with computed paths, a path stored in another variable, or a path nested in an array/object argument are
  not resolved. Recognized Vitest mock methods still fail closed on unreadable first arguments. Dynamic imports alone do not
  count, except imports of the explicitly listed test door-opening helpers.
- The compiler host resolves relative and `@/` imports within the snapshot, not arbitrary external packages or custom runtime
  resolution. Destructuring is discovered conservatively with unavailable values, including literal RHS patterns. A switch
  moved to such a pattern cannot obtain a shipped-value certification.
- The reverse census scans exported public mutations in top-level `convex/*.ts`, with recognized mutation builders and inline
  handler configurations. It finds direct containment-guard calls and direct references to exported switch symbols; it does
  not trace arbitrary helper bodies or custom registration factories. An unregistered helper-mediated switch is not proven absent.
- Screen scans retain literal `api.module.function` reference matching. They do not resolve aliased references, computed access
  or string-built names, nor prove that a gate controls the right rendered action. Supplier scanning also accepts its existing
  colon form and includes mobile source; that is source evidence, not mobile pilot certification.
- These checks measure local source and harness behavior. Independent seats, CI, remote Sonar, authenticated hunters and a
  real-backend certification remain separate evidence. No production source, server guard or switch value changed.

Material design references: the official [TypeScript compiler API guide](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)
describes Program, SourceFile traversal and compiler symbols. The official [Vitest vi API](https://vitest.dev/api/vi.html)
documents `mock`/`doMock`, dynamic-import arguments and static-analysis limits. The installed versions are TypeScript 6.0.3 and
Vitest 4.1.9. The argument over-approximation and unavailable-value policy are project safeguards, not guarantees made by Vitest.


Final self-review extended F3 to arbitrary unavailable exported bindings, not only binding elements. Before the extension,
`pnpm exec vitest run test-utils/pilotSourceDiscovery.test.ts --maxWorkers=1 -t 'other unreadable'` produced **2 failed, 1 passed**:
an unresolved exported pilot name and a pilot-named object without door-map keys were omitted, while the function export was
already unavailable. Discovery now uses the exported declaration when the resolved value declaration is unavailable, and
non-map object values fall back to an unavailable constant. Recognized door-map containers still contribute their switch keys.
The discovery-only green run passed 12 tests but failed the unchanged 90% statement-coverage threshold at 87.67%; the complete
core coverage command below then passed with no threshold change. That isolated command added `--coverage` and
`--coverage.include=test-utils/pilotSourceDiscovery.ts` to the discovery test, with output under `coverage/r3-discovery`.

Final round-3 core validation:

```powershell
pnpm exec vitest run test-utils/pilotSourceDiscovery.test.ts test-utils/pilotConfigParity.test.ts lib/pilotCapabilityManifest.test.ts scripts/supplierSettlementCensus.test.ts --maxWorkers=1 --coverage --coverage.include=test-utils/pilotSourceDiscovery.ts --coverage.include=test-utils/pilotConfigParity.ts --coverage.include=test-utils/pilotSourceSnapshot.ts --coverage.include=lib/pilotCapabilityManifest.ts --coverage.reporter=text --coverage.reporter=json-summary --coverage.reporter=json
```

**86/86 passed**. All 29 R3 controls passed: F1 14, F2 1, F3 9, F4 2, F5 3. Unchanged coverage thresholds passed:
98.65% lines, 95.68% statements, 96.42% functions and 89.17% branches. Across the four measured implementation modules,
49/49 added executable statement-start lines were covered, including the entire new snapshot file. This is local V8 coverage,
not a remote SonarCloud new-code verdict.

The complete changed-file ESLint command was:

```powershell
pnpm exec eslint lib/pilotCapabilityManifest.ts lib/pilotCapabilityManifest.test.ts test-utils/pilotConfigParity.ts test-utils/pilotConfigParity.test.ts test-utils/pilotSourceDiscovery.ts test-utils/pilotSourceDiscovery.test.ts test-utils/pilotSourceSnapshot.ts scripts/supplierSettlementCensus.test.ts convex/dealCommissionLinesLedger.test.ts convex/dealCommissions.test.ts convex/orgFinancialReset.test.ts convex/scrum802CashSaleContainment.test.ts convex/scrum802CashSaleExtras.test.ts --max-warnings=0
```

It reported zero errors and four existing `no-explicit-any` warnings in `orgFinancialReset.test.ts`, so strict warning mode
returned exit 1. That file's sole change is its explanatory header. SonarJS 4.2.2 recommended rules with cognitive complexity
limited to 14 reported two existing smells: a nested ternary in that same test and the supplier census's pre-existing map-key
regex. A multiset comparison against linting each file's exact HEAD text found all six diagnostics inherited and **zero new
warnings or smells**. The fingerprint includes file, rule, message and source line; adding a duplicate diagnostic consumes a
separate count. No suppression, NOSONAR or threshold change was used. No cognitive-complexity violation was reported.

Self-review checked reuse, simplification, scope and efficiency: parity and census share the source snapshot; mock detection
keeps precise checks where they add coverage; controls test the actual detector and source I/O, with fixture restoration.
This is an implementer self-review, not `/simplify` from an independent seat or a certification.


Adjacent suite validation:

```powershell
pnpm exec vitest run components/accounting/FixedAssetsTab.pilotOff.test.tsx components/accounting/ManualJournalTab.pilotOff.test.tsx scripts/legacyCollectionRefundOptOutCensus.test.ts convex/scrum802OptOutCensus.test.ts convex/dealCommissionLinesLedger.test.ts convex/dealCommissions.test.ts convex/orgFinancialReset.test.ts convex/scrum802CashSaleContainment.test.ts convex/scrum802CashSaleExtras.test.ts --maxWorkers=1
```

Result: **133 passed, 6 failed** across nine files. The failures are the six known Windows separator failures in the unchanged
`convex/scrum802OptOutCensus.test.ts`. Combined with the four-file core run: **219 passed, 6 known failures**, 13 named files.
The five backend test changes are explanatory header lines only. All thresholds, the shrink-only baseline, production
containment sources, release waivers and review-evidence files remain unchanged.


Local analysis helpers were run with `node $env:TEMP\scrum810-sonar\check-r3-delta.cjs` and
`node $env:TEMP\scrum810-sonar\changed-coverage-r3.cjs`. They are temporary local measurement scripts, not repository gates.
The first applies the installed SonarJS recommended rules and compares diagnostics with exact HEAD text; the second measures
added executable lines from the V8 report against the diff, including the full newly added snapshot module. Their final results
were zero new diagnostics and 49/49 added executable lines covered.


Final frozen-source `pnpm typecheck` and `pnpm typecheck:convex` both returned exit 0. Root input exclusions are
`node_modules`, `apps`, `packages`, `convex`, `dealer-worker` and `test-utils`. Convex includes backend and test-utils inputs,
excludes `convex/_generated` as input roots, and does not separately check frontend, mobile, shared or worker projects.
Imported dependencies can still enter either graph. These are compiler results, not Convex platform or concurrency evidence.

The protected customer-credit containment blob is unchanged at `af09f908267944be4189ec7720301c775b50c848`.
Only 14 named files were staged. Existing `.gitignore` and `.ignore` edits remain unstaged. No push, merge, deployment,
production read/write, CI run, remote Sonar analysis or independent-seat certification was performed by this lane.

## CI timeout remediation at 8d0fd5a4, 2026-11-04

Run 41865994194 timed out in the Fixed Assets parity hook. Local V8 coverage reproduced the same
`Hook timed out in 10000ms` failure. A diagnostic run measured 9.53 s parsing 1,175 production
sources and 3.08 s binding them. These are local compiler costs, not Convex platform measurements.

The compiler now retains at most two programs per Vitest worker context, keyed by root-file lists and
validated against every source string. Unchanged inputs reuse the program and checker. Changed
inputs pass `oldProgram` and reuse only ASTs whose text is unchanged. The cache survives
`vi.resetModules()`, while changed, added and removed sources invalidate it. The source snapshot
still reads the complete production tree; fixture reloads deliberately reread it to observe edits.
The mock census reads its complete test-file set once and binds one program. An empty export
keeps script-shaped test files in separate module scopes, as Vitest executes them, so a binding
in another file cannot hide a mock invocation. No discovery directory or negative control was removed.

The complete first scan still exceeds 5 s with coverage. UI suites use `beforePilotCertifyingConfig`
for the same assertion with a shared 30 s hook timeout and a measured-cost comment. The new helper
is itself in the protected mock-module list, and certification/mock coexistence checks recognize it.
At the pinned head, the UI caller enumeration is one file, `FixedAssetsTab.pilotOff.test.tsx`.
The other pilot-off suite, `ManualJournalTab.pilotOff.test.tsx`, directly checks its constant.
The two additional measured callers are the parity suite's existing R3-F2 hooks-barrel and F4
manual-journal-guard negative controls; no additional UI callers were invented.

### Design sources

The [TypeScript compiler API guide](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API#writing-an-incremental-program-watcher)
describes program reuse, the `oldProgram` parameter and incremental builders. This analyzer needs
symbols rather than diagnostic/emit caches, so it reuses native `Program` and `SourceFile` objects
without a watcher, incremental output files or a second compiler service.
[Vitest hook timeouts](https://vitest.dev/config/hooktimeout) documents the 10 s Node default and
[Vitest coverage profiling](https://vitest.dev/guide/profiling-test-performance.html#code-coverage)
separates test/import time from coverage work. The compiler work was optimized before adding the
scoped hook timeout; repository-wide timeouts and coverage thresholds are unchanged.

A discarded dependency-prefilter experiment failed the namespace-export controls because
TypeScript 6.0.3 `preProcessFile('export * as ns from "./local";', true, true).importedFiles`
is empty. The committed design preserves the complete file census and compiler-symbol discovery.

### Local timings

The following are individual `performance.now()` samples around the assertion, excluding import,
environment startup and the temporary timing write. The timing probes were removed before final
validation. They are not statistical medians; the shared Windows machine had concurrent activity.
The after samples measure native cache reuse, including source-changing controls, and the cold
Fixed Assets call. A cold-scan speedup is not established.

| Caller | Before plain | After plain | Before V8 coverage | After V8 coverage |
| --- | ---: | ---: | ---: | ---: |
| Fixed Assets, cold worker | 4,722 ms | 7,929 ms | 13,873 ms, hook failed | 12,811 ms, hook passed |
| R3-F2 hooks-barrel control, source changed | 4,576 ms | 3,045 ms | 14,731 ms | 2,778 ms |
| F4 manual-journal guard control, module reset | 5,281 ms | 2,477 ms | 13,886 ms | 2,688 ms |

Unchanged assertions in the instrumented covered parity suite measured 0.06–0.78 ms. The original
failure and the new unchanged-program reuse assertion both ran red before the fix. New controls
also check unchanged AST reuse, module-reset reuse, source/root invalidation, namespace cycles,
escaped exports, unreadable mock targets and isolation of bindings between test files.

### Validation commands and evidence boundary

The complete representative covered run, with timing probes removed, was:

```powershell
pnpm exec vitest run components/accounting/FixedAssetsTab.pilotOff.test.tsx components/accounting/ManualJournalTab.pilotOff.test.tsx test-utils lib/pilotCapabilityManifest.test.ts scripts/supplierSettlementCensus.test.ts --maxWorkers=1 --coverage --coverage.include=test-utils/pilotSourceDiscovery.ts --coverage.include=test-utils/pilotConfigParity.ts --coverage.include=test-utils/pilotConfigHook.ts --coverage.reporter=json-summary --coverage.reporter=json --coverage.reporter=text --coverage.reportsDirectory=coverage/scrum810-final
```

Result: **101/101 passed**, seven files, 142.83 s. Line coverage was 99.18%, statements 95.62%,
functions 95.83% and branches 90.53%. The scoped include list measures the changed helpers rather
than unrelated application modules. The configured 90/90/85/75 statement/line/function/branch
thresholds were unchanged and passed. A diff-to-V8 statement-start comparison measured **30/30
added executable lines covered**. This is local coverage, not a remote SonarCloud new-code verdict.

The preceding broader plain run passed 92/92 tests across both pilot-off files, all three test-utils
suites and the manifest in 128.91 s. The final plain run of the requested five-file set passed
**79/79 tests**, five files, 119.78 s:

```powershell
pnpm exec vitest run components/accounting/FixedAssetsTab.pilotOff.test.tsx components/accounting/ManualJournalTab.pilotOff.test.tsx test-utils --maxWorkers=1
```

Both `pnpm typecheck` and `pnpm typecheck:convex` returned exit 0. Root typecheck excludes
`convex`, `test-utils`, `apps`, `packages`, `dealer-worker` and `node_modules` as input roots.
Convex typecheck includes backend and test-utils roots, excludes `_generated` as input roots,
and does not separately check frontend, mobile, shared-package or worker projects. Imported
dependencies can enter either graph. Neither result proves Convex runtime or concurrency behavior.

Changed-file lint:

```powershell
pnpm exec eslint components/accounting/FixedAssetsTab.pilotOff.test.tsx test-utils/pilotConfigParity.ts test-utils/pilotConfigParity.test.ts test-utils/pilotSourceDiscovery.ts test-utils/pilotSourceDiscovery.test.ts test-utils/pilotConfigHook.ts --max-warnings=0
```

Local SonarJS 4.2.2 recommended rules, with cognitive complexity limited to 14, reported zero new
diagnostics and zero inherited diagnostics in these six files. No suppression or NOSONAR was added.
The independent seats and remote CI/Sonar analysis remain unverified at the remediation commit.
All three PR comment APIs were read. CodeRabbit's conversation says automatic review was skipped;
the review-summary and inline APIs returned empty arrays. No CodeRabbit certification is claimed.

The customer-credit containment blob remains `af09f908267944be4189ec7720301c775b50c848`.
Production sources, thresholds, release waivers, review evidence, `.gitignore` and `.ignore` are
outside this remediation commit. No push, merge, deployment or live financial operation was performed.
