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
  guards, each with the identifier that must appear in the door's source. A door that always refuses is `whole`; a door that is
  shared with enabled behaviour is `conditional`.
- `isPilotSwitchOn(key)`: the one call a screen makes to decide whether to offer an action. The two screens with a verified
  divergence use it. Screens that already gate themselves keep their gate; the test pins that the gate is still present.

Four tests fail when the layers diverge:

1. **Discovery.** Every exported `*_PILOT_DISABLED|REQUIRED|REFUSED` constant (and every key of the two door maps) in `convex/`
   and `lib/` must be a key in `PILOT_SWITCHES`. A new switch cannot ship unregistered.
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
  reference would escape the UI test. The repository has no such call to a registered door today.
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
Shadowed parameters and imports from other packages do not count as Vitest bindings. This follows the
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
