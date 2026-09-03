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

## Gates

| gate | result |
|---|---|
| `tsc -p convex/tsconfig.json --noEmit` | clean |
| `eslint` on changed files | exit 0, no errors (`any` warnings only, matching neighbours) |
| full `convex` suite | see run below |
| §4.2 real-runtime gate | PASS (twice: Stage A and Stage B) |
| generation-guard mutation | PASS (guard removed → tests fail) |

⚠️ **Three suites (`expoPush`, `scrum121Characterization`, `collections`) failed
once under full-suite parallelism and passed in isolation and on re-run.** They
are load-dependent flakes of the class `accountingOutboxSweep.test.ts:99-114`
documents; none touches the outbox. Recorded rather than silently re-run until
green.

## Evidence boundary

`convex-test` **serializes and models no OCC**, so the true-concurrency half of
duplicate dispatch is UNVERIFIABLE there. What is proven is the state machine's
logic: a second dispatch against a claimed row is a no-op, and a stale
generation cannot write. Real contention remains unproven by this suite.
