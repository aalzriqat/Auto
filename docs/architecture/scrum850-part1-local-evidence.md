# SCRUM-850 part 1 — local implementation evidence

## Review round 2

Round 2 starts at `09f74e3a4fb1b66644b614e5df91ac7e8c865d67` on the same branch.
See [round 2 evidence](scrum850-round2-evidence.md) for the independent
reproductions, R1 editable-input census, F1 reader census, alternatives, red and
green runs, mutation checks, checks and remaining runtime gaps. The new red
commit precedes the individual R1, F1 and F2 repair commits. The scenario records
and SCRUM-486 rows bind to literal test names in that red commit.

The earlier results below describe part 1's original implementation, not round
2 certification. No Jira/GitHub action, independent review seat, push or deploy
is performed by this implementer. No generated API declaration is regenerated
or staged.

Date: 2026-11-08. Base: `a01d5fe5c7d6a665a51c6dd55b2165e554191258`.
Branch: `claude/scrum850-opening-correction`. No push or deployment.

## Change and retained boundary

The ADR chooses one atomic, bounded void approval transaction, with a different
requester and approver. It reverses the retained opening journal and removes only
unchanged opening-created source rows, clearing opening markers on retained stock
and partner masters. Both request and approval recheck activity and dependencies.
A verified governed reversal pair alone may be excluded from fresh-opening
admission. Ordinary reversals and later ledger activity remain blockers.

Part 2 is design only: immutable named-line correction commands with net journal
and native deltas, source versions and conflict floors. Full reversal/replay after
operations is rejected.

## Materialization coverage

`openingMaterializedTargets` in `convex/utils/openingResetCleanup.ts` is shared by
reset cleanup and the opening-only void. Its exhaustive allocation-result switch
covers all eleven allocation kinds. `scripts/openingVoidCoverage.scrum850.test.ts`
also checks schema source markers and incoming typed references against the void
registries. This is a source/schema census of the current checkout, not a claim
about production data or future unregistered writers.

The composite registered-function fixture exercises vehicle basis markers,
customer legacy and canonical receivables, employee advances, prepaid schedules,
supplier recoverables, supplier and other payables, commission liabilities,
named deposits, partner opening capital, and GL-only unallocated liability.
Eight native source tables (nine fixture rows) become empty; vehicle and partner
masters survive with opening markers/basis cleared. Journal history, immutable
allocation evidence and the reversal survive. Bank attribution, actual trial
balance readers and account snapshots are asserted.

Literal JOD minor units: original debit and credit each `1960018`; retained
original plus reversal debit and credit each `3920036`, every account net zero;
bank `300003 -> 0 -> 300003` after a fresh opening using the same masters.

## Red and green evidence

- ADR commit: `6a5a574d1`.
- Failing-first commit: `c2a275b2572b56ac39a24516b853ab5b0c131faf`.
  It contains all thirty exact backend test registrations named in the scenario
  records. Initial run: 26 failures because commands were absent. Subsequent
  attacks exposed an unlisted native source and reversal-of-void (two real
  failures), and ambiguous opening headers (one real failure), before repair.
- Implementation commit: `6359992c709eef8d14398f24eba9665b31a6b203`.
- Final affected run: **82/82 passed**, including **30/30** new registered backend
  cases, the schema/reference census and the root generic reversal suites.
- Final focused UI/form and command/tenant census run: **54/54 passed**.
- New scenario records and implementation-name validation: **71/71 passed**.

All Vitest invocations used named files and `--maxWorkers=1`. The broad requested
batch ran **1254 cases: 1253 passed, one inventory failure**. The failure was the
public mutation inventory missing the three new commands. Those are now recorded
as **UNCLASSIFIED**, preserving the separate pilot activation/certification gate;
the repaired inventory rerun passed **13/13**. The broad batch itself was not
rerun or relabelled green.

That batch covered every existing `convex/opening*.test.ts` and
`convex/orgFinancialReset*.test.ts`, tenant guard, economic command census,
public mutation inventory, reset reference coverage, `scripts/regression`, pilot
config parity, i18n coverage and affected UI tests. The requested globs
`convex/accountingCutover*.test.ts` and `convex/accounting/reversals*.test.ts`
matched no files. Existing reversal tests live at the Convex root:
`accountingGenericReversalAuthority`, `accountingReversalBankIdentity` and
`accountingReversalKeyIdentity`; these passed in the final affected run.

## Other checks

| Check | Local result |
| --- | --- |
| `pnpm typecheck` | Passed; application scope excludes `convex/` |
| `pnpm typecheck:convex` | Passed; backend scope |
| ESLint on touched TS/TSX | Passed; generated API declaration is repository-ignored by ESLint |
| SonarJS 4.2.2, five new backend modules plus card/form | Cognitive threshold 14, no nested ternary, no await-in-loop: passed |
| Existing reset helpers | Inherited await loops and one complexity-18 function remain; no whole-file strict-rule pass is claimed |
| `git diff --check` | Passed |
| `checkBaselineIdentity.mjs` | 945 matched call identities, zero stranded; backend finding identity is outside this check |
| `renewBaselineReviewed.mjs --reviewed c82890bd --check-evidence --pr-base a01d5fe5c` | 945 renewed, zero unrenewed/stale/malformed/missing |

Seven affected baseline entries were reviewed individually with exact normalized
Git client/backend blob evidence: two opening-card calls, two approval-panel
calls, and three manual-journal calls affected by the financial-audit declaration
change. Two identical card call expressions moved to lines 373/376. No expiry,
fingerprint, cause, multiplicity, UNKNOWN verdict or gate threshold was weakened.
Tenant census is 574 total/386 analyzed; its two skip counts remain 15/173.
Economic command census is 159. Public pilot inventory is 408, with the new three
commands UNCLASSIFIED pending separate certification.

The LF-only worktree repair of `scripts/regression/refreshRulings.test.ts` retains
Git blob `be18a2db1fe3ebb6ff1cd4b7d9b742b447c3628e`; it is not staged.

## Screen evidence and limits

Actual components were rendered through the existing test boundaries, styled
with the project's compiled CSS and captured with Chromium at 390 and 1440 px:
edit/request/approve in EN and AR, twelve renders. The measured pages had no
horizontal overflow, buttons stayed in view and Arabic used RTL. These are
offline component-layout checks with fonts falling back and animation disabled,
not an authenticated role/tenant/browser/backend end-to-end run. No dev server
or watcher was started.

The thirty scenario records use existing recorded opening-family and permission
ruling digests. The coordinator supplied SCRUM-850 c24748/c24749 decisions but
not verbatim comment bodies or digests; exact SCRUM-850 digest attribution remains
a coordinator follow-up. No live Jira verification is claimed.

Convex cloud limits, scheduling/OCC, component-table byte equality, production
parity, the signed-in roles × languages × viewports hunter, the unscripted explorer,
real-backend scenario certification and independent Codex/Opus review seats are
unverified. A read-only advisory design attack is not a review seat. This work
does not certify the pilot or activate part 2 corrections.
