# SCRUM-222 Stage B — implementation evidence

Authorized by owner ruling `c17365`. Nothing merged, nothing deployed to
production. Protected main remains `bf5769ed1`.

## What shipped

| Requirement (`c17365`) | Where |
|---|---|
| bounded exact-row selector | `selectDueOutboxRows` + `dispatchDueOutboxWork` |
| claim generation | `claimOutboxRow` |
| `scheduler.runAfter` boundary | `claimOutboxRow` → `postOutboxRow` |
| isolated worker, no catch around financial writes | `postOutboxRow` |
| POST re-proves business authority | `postOutboxRow`, period + prepaid/payroll/commission guards |
| REVERSE delegates to `reverseAccountingEvent` | `postOutboxRow` → `reversePendingEntry` |
| observer outside the financial transaction | `observeOutboxAttempt` |
| held rows burn nothing and do not starve | `holdOutboxRow` (+ `nextActionAt` advance) |
| manual retry: new generation, "retry queued" | `reviveFailedEntry`, `retryFailed` |
| `drainPendingForOrg` retired | deleted; falsifier test |

`drainEntries` no longer posts. It schedules one claim per row, so row isolation
comes from **each row having its own transaction** rather than from a `catch`
that could not roll back.

## Gate 1 — §4.2 selector, re-run on Stage B code

The selector was refactored into `selectDueOutboxRows`, shared by the dormant
diagnostic query and the production dispatcher, so the certified query and the
shipped query are literally the same function. Re-run on `gregarious-crow-93`
(cloud DEV, throwaway project `scrum222-gate`; production `kindly-hound-172`
never contacted):

```json
"unclaimed": [
  { "idempotencyKey": "gate_stageb_legacy", "status": "PENDING",
    "hasNextActionAt": false, "hasDispatchState": false, "hasGeneration": false }
]
```

A genuinely legacy-shaped row is still returned as due. ✅

## ⭐ Unplanned live evidence: the whole pipeline ran on real Convex

Deploying Stage B registered the `dispatch-outbox-work` cron, which then
processed the gate fixtures unattended. The resulting rows are stronger evidence
than any static query, because the selector, claim, worker, hold and observer
all ran on a real deployment:

| row | outcome | what it proves |
|---|---|---|
| `gate_legacy_absent` (no SCRUM-222 fields at all) | claimed `generation 1`, worker re-proved eligibility, **HELD** with `attempts: 0`, claim released, reason recorded | a legacy row is selectable, claimable and **held without burning an attempt** — end to end, on real Convex |
| `gate_claimed_overdue` (claimed, scheduler record absent) | **absent-record branch** fired: `attempts: 1`, claim released, `"this posting attempt could not be observed"` | fixture 18 on the real runtime, not only in `convex-test` |
| `gate_future_scheduled` | untouched, `attempts: 0` | a future `nextActionAt` really defers |
| `gate_already_posted` | untouched | terminal rows are never re-selected |

## Gate 2 — stale generation, MUTATION-PROVED

Required by `c17365`, and unprovable on unpatched main because neither the
generation nor the worker exists there. The stale state is built through **real
doors**: `claimOutboxRow` issues generation N, the scheduled worker is genuinely
`cancel`led so the real observer sees a dead execution and releases, and
`claimOutboxRow` then issues N+1.

```
[POST]    N cannot post    -> SUPERSEDED, zero GL delta, N+1 still owns the claim
[REVERSE] N cannot reverse -> SUPERSEDED, zero GL delta, original still POSTED
```

**Mutation proof.** Deleting the two guard lines in `postOutboxRow`:

```
-  if (row.activeAttemptId !== args.attemptId) return { outcome: "SUPERSEDED" };
-  if (row.generation !== args.generation)     return { outcome: "SUPERSEDED" };
```

flips both tests from SUPERSEDED to **POSTED** — the stale worker writes a
journal. Both fail. Guard restored and re-verified green. The guard is
load-bearing and the tests detect its absence.

## The three original RED reproductions are now GREEN

Same fixtures, same real unmocked fault (duplicate snapshot rows make
`incrementAccountSnapshot`'s `.unique()` throw mid-write), opposite outcome:

* one failed POST → **zero** events, journals, lines, unbalanced journals;
* retrying → **no** second event or journal for one obligation;
* one failed REVERSE → **no** reversal footprint, original left `POSTED`.

## ⚠️ A real behaviour change, flagged rather than absorbed

`authorityOutcomePersistence.test.ts` injects a scheduler rejection inside
`markEntryPosted`'s eager authority dispatch. Under the old per-row catch the
accounting stayed `POSTED` and only the latency optimisation was lost. **A
worker that must not catch cannot keep catching the one throw we find
convenient**, so that throw now rolls the whole transaction back and the row
retries.

This is safe rather than merely acceptable — nothing partial is written and the
re-run posts idempotently — and in production the path is essentially
unreachable, because the seam exists only so a test can make it reject and
`ctx.scheduler.runAfter` inside a mutation is transactional. Recorded because
"a transport hiccup now discards completed accounting work and retries it" is a
trade the owner should see rather than discover.

## Round 2 — the three review findings, and what they cost

`89a3a35f4` is frozen as the BLOCKED artifact both seats reviewed. Sonnet MAX and
Codex `xhigh` each returned BLOCK; neither found the architecture wrong. Owner
ruling `c17371` authorised exactly the corrections below.

**B01 — the branch did not compile, and my gate evidence hid it.** I published
"typecheck clean" on the strength of `tsc -p convex/tsconfig.json` alone. That
project **excludes `components/`**, so it could not see that two backend return
shapes had changed under their consumers: `AccountingSetupTab.tsx:140-141` read
`outcome.posted` / `outcome.failed` from `{ scheduled }`, and
`PrepaidExpensesTab.tsx:136,141-142` read the same names from
`{ revived, scheduled }` — six real `TS2339` errors. The English and Arabic
strings still said "{posted} posted, {failed} failed" on a `MANAGE_FINANCE`
control, which would have **moved this ticket's lie one layer up** rather than
removing it: the outbox would stop claiming to have posted, and the toast above
it would carry on claiming it.

> **A changed return shape is cross-surface by construction** — a backend
> function's consumers are, by definition, not in the backend's own tsconfig. The
> scoped check for the surface you edited is the one most likely to miss them.

**B02 — `retryQueued: true` queued nothing.** `retryFailed` revived the row and
scheduled no claim, leaving the row to the next cron tick while telling the
operator it was already moving. **My own test could not have caught it**: it
called the mutation and then drove the queue by hand, so it was measuring the
test's sweep, not the code's. The regression test now asserts the side effect the
action itself must produce — a scheduled `claimOutboxRow` for that exact row —
before anything is pumped, and then settles *without dispatching*.

**B03 — eager dispatch, ruled cron-only.** Not implemented, and now not required:
the owner retired it from ordinary `enqueuePendingPost` / `enqueuePendingReversal`
rather than have a sale depend on `scheduler.runAfter` availability to save one
dispatcher cadence. Recorded at the code site. Contract item §5.1's eager-dispatch
clause is superseded for the ordinary enqueue path; the operator doors still
dispatch eagerly.

**F2 — split out as SCRUM-225** (deferred REVERSE recovery held by the period
gate). Verified pre-existing on `bf5769ed1`, where `drainEntries:1121` ran the
identical `checkPostingAllowed` ahead of the `kind === "POST"` branch at `:1135`.

## Gates

⚠️ **Both typecheck gates are required, and the round-1 evidence cited only one.**
The repository has no total typecheck: the root project excludes `convex`, and the
convex project excludes `components`. Whichever one you run is blind to the other
side of the call.

Coverage of the changed surfaces is total between the two, and checked rather
than assumed: `convex/tsconfig.json` pulls in `../test-utils/**/*` explicitly
(root excludes it), so the new harness helpers are typechecked by the convex
project rather than by nothing.

| gate | command | result |
|---|---|---|
| root / web typecheck | `pnpm typecheck` | **0 errors** — the gate B01 was hiding behind; it reported 6 × `TS2339` before the fix |
| convex typecheck (incl. `test-utils/`) | `pnpm typecheck:convex` | **0 errors** |
| lint, changed files | `npx eslint <8 files>` | **0 errors** (166 `any` warnings, matching neighbours) |
| full convex suite | `npx vitest run convex/` | **3500 tests · 3478 passed · 0 failed · 22 skipped · 189/189 files · `success: true`** (JSON reporter) |
| i18n key coverage | `npx vitest run lib/i18n/keyCoverage.test.ts` | 8/8 |
| tenant write-guard | `npx vitest run scripts/tenantWriteGuard.test.ts` | 8/8 after re-pinning (see below) |
| §4.2 real-runtime gate | cloud DEV `scrum222-gate` | PASS (twice: Stage A and Stage B) |
| generation-guard mutation | guard lines removed | PASS — both tests flip `SUPERSEDED` → `POSTED` |
| B02 absence mutant | schedule removed | PASS — `[B02]` fails on **both** assertions independently (`expected [] to have a length of 1`; `expected 'PENDING' to be 'POSTED'`), while the pre-existing `[GREEN]` test **passes against the mutant**, which is the blindness itself |

⚠️ **The round-1 figure "3494 passed / 22 skipped" is not reproducible from
`npx vitest run convex/` and is not carried forward.** That command collects 189
files and 3500 tests on this tree (3499 before the `[B02]` test was added), all
189 accounted for against disk. The earlier number came from a scope I have not
been able to reconstruct, so it is restated from measurement rather than quoted.

### Two gates that were never run in round 1, and what they found

**`scripts/tenantWriteGuard.test.ts` was RED and nobody had looked.** Stage B
added four registered mutations, so the pinned coverage counts moved
`totalMutations` 481→485 and `skippedNoOrgId` 151→155. **`analysed` is unchanged
at 315 and the security assertion itself — "every mutation that takes an `orgId`
proves ownership before writing a caller-supplied id" — passed throughout.** The
four (`dispatchDueOutboxWork`, `claimOutboxRow`, `postOutboxRow`,
`observeOutboxAttempt`) take a `rowId` or nothing rather than an `orgId`, which
is the same shape SCRUM-208's authority half already justified in that file, and
they are `internalMutation`s with no public entry point. Re-pinned with the
per-mutation reasoning the file's own convention requires. *The pin did exactly
its job: it refuses to let new mutations land without someone stating why they
are out of the analysed surface.*

**`scripts/releaseEntrypoints.test.ts` — one test UNAVAILABLE locally, not
passing.** "the deploy step's own shell REFUSES when main has moved" spawns
`/bin/bash` with a Windows temp path whose separators are stripped
(`C:Users123AppDataLocal…step.sh: No such file or directory`, exit **127**) — the
same broken-bash environment that made the Bash tool unusable for this entire
session. It cannot be caused by this branch: `git diff --name-only
bf5769ed1..HEAD -- scripts/ .github/` is **empty**. Recorded as unavailable
rather than counted as a pass.

⚠️ **Load-dependent flakes, recorded rather than re-run until green.** Across
three full-suite runs, exactly one test failed in each of the first two — a
5000 ms timeout in `socialInbox.test.ts`, then a `finishAllScheduledFunctions`
pump exhaustion in `collections.test.ts` — *different files each time*, both
green in isolation (23/23 in 2.75 s; 24/24 in 3.22 s), and neither touches the
outbox. The third run was clean. They are the class
`accountingOutboxSweep.test.ts:99-114` documents.

## Evidence boundary

`convex-test` **serializes and models no OCC**, so the true-concurrency half of
duplicate dispatch is UNVERIFIABLE there. What is proven is the state machine's
logic: a second dispatch against a claimed row is a no-op, and a stale
generation cannot write. Real contention remains unproven by this suite.
