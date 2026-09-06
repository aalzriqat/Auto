# SCRUM-222 Stage A — §4.2 real-runtime gate: **PASS**

Authorized by owner ruling `c17365`. This records the gate the contract's §4.2
declared **required**, run against a real Convex deployment rather than the
`convex-test` simulator.

| | |
|---|---|
| Frozen Stage-A SHA | `27123f060b3b383ea9c32e49e4987a06af10469b` |
| Deployment | `gregarious-crow-93` — cloud **DEV**, project `scrum222-gate` |
| Production project | `kindly-hound-172` — **untouched, never contacted** |
| Protected main | `bf5769ed1` — unchanged |
| Run at | `now = 1788470561242` |

## Why a throwaway project rather than the existing dev deployment

The repository's own release waiver records that the shared Convex dev
deployment is disabled on free-plan limits. So the gate runs in a **newly
created, disposable project** (`scrum222-gate`) that shares nothing with
production. A **local** deployment was attempted first and rejected by the
platform: the repo ships `"use node"` actions and the local backend requires
Node 20/22/24, while this machine runs Node 26.

## The control — the row is genuinely legacy-shaped

§4.2 requires the field **completely absent**, not `null` and not `0`. Read back
from the real deployment with `hasOwnProperty`, not from the fixture:

```
key                     status   nextActionAt present in stored doc
gate_legacy_absent      PENDING  false      <-- the row under test
gate_future_scheduled   PENDING  true  (9999999999999)
gate_claimed_overdue    PENDING  true  (1)
gate_already_posted     POSTED   false
```

## The gate — the exact selector, unmodified, on real Convex

`internal.accountingOutbox.selectDueOutboxWork`, executed via `npx convex run`:

```json
{
  "unclaimed": [
    { "idempotencyKey": "gate_legacy_absent", "status": "PENDING",
      "hasNextActionAt": false, "hasDispatchState": false, "hasGeneration": false }
  ],
  "awaitingObservation": [
    { "idempotencyKey": "gate_claimed_overdue", "status": "PENDING",
      "hasNextActionAt": true, "hasDispatchState": true, "hasGeneration": true }
  ]
}
```

**Four properties proved simultaneously, and the negatives matter as much as the
positive:**

1. ✅ A row whose `nextActionAt` is **absent** is returned as **due**. So
   `lte("nextActionAt", now)` admits a missing value as ordering before every
   number, and `eq("dispatchState", undefined)` matches an absent field — on the
   real runtime, not the simulator.
2. ✅ `gate_future_scheduled` is **excluded** — a future `nextActionAt` really
   defers, so the selector is not simply returning everything.
3. ✅ `gate_claimed_overdue` appears **only** in `awaitingObservation` — a
   claimed row is never re-offered as unclaimed work (§5: re-observe, never
   dispatch a second worker).
4. ✅ `gate_already_posted` appears in **neither** range.

**Real Convex agrees with `convex-test` here.** That agreement had to be
measured rather than assumed: this repository has the receipt for the opposite
outcome — a backfill cleared 2,115 tests, full CI and thirteen adversarial
review rounds before failing on its first production call, because `convex-test`
does not enforce Convex's one-paginated-query-per-function limit. The selector
therefore uses `.take()` twice and never `.paginate()`.

## Consequence

**No backfill and no sentinel is required** for legacy rows to remain visible.
The §8 non-goal is not triggered and this does not return to the owner.

## Evidence boundary

Verified on a real **non-production** Convex deployment at the frozen Stage-A
SHA. It certifies the **selector**. It certifies nothing about the worker,
claim, observer or retry paths, none of which exist at Stage A — the three RED
defect reproductions are still RED at this SHA, by design.

## Gate 2 — stale generation: SEQUENCING NOTE, NOT A PASS

`c17365` also requires proving that a stale generation N cannot post, cannot
reverse, cannot complete or release N+1, and produces zero accounting delta —
mutation-proved by removing the generation guard.

**That guard does not exist at Stage A**, which by ruling has no worker. The
metadata it reads exists now; the code paths it must block do not. This gate is
therefore proved as part of Stage B, before Stage B is considered complete, and
is **not** claimed here. Recorded rather than silently reordered.
