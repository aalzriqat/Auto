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
