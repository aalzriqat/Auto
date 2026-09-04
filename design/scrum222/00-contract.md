> 🛑 **FAILED DESIGN-REVIEW EVIDENCE — superseded by `01-contract.md`**
> (owner-proxy `c17353`). Both DESIGN seats BLOCKED this revision at `f37c09327`.
> **Preserve for forensics. DO NOT implement from it.** Its §4 status-literal
> choice and its grep-shaped reader audit are the two things `01-contract.md`
> corrects.

# SCRUM-222 — outbox posting atomicity

**Status:** DESIGN CONTRACT ONLY. No implementation. No PR. No production action.
**Base:** protected `main` `bf5769ed1`, branch cut 0/0, nothing inherited.
**Authority:** Jira SCRUM-222 (Highest/CRITICAL), split from the SCRUM-218 v2
DESIGN failure at `c3edd5210` (`c17343`). **SCRUM-222 blocks SCRUM-218.**

⚠️ **Nothing from `c3edd5210` is imported, copied or paraphrased.** That contract is
failed design evidence. This one is written from current `main` only.

**Merge posture:** even if this becomes fully merge-ready it is **not** merged to
protected main. SCRUM-218 resumes only when this capability is in its integration
base — not because a local branch exists.

---

## 1. The defect, mapped against current source

### 1.1 One `try`/`catch` covers every financial write, for BOTH kinds

```
accountingOutbox.ts:1163   try {
              :1164     const resultEventId = p.kind === "POST"
                          ? await postPendingEntry(ctx, p)      // -> postAccountingEvent
                          : await reversePendingEntry(ctx, p);  // -> reverseAccountingEvent
              :1165     await markEntryPosted(ctx, p, resultEventId);
              :1167   } catch (err) {
              :1175     if (await markEntryFailed(ctx, p, message)) failed++;
```

A throw **after** the first financial write is caught. The mutation returns
normally, so every write staged before the throw **commits**. There is no
block-scoped rollback in Convex: `try`/`catch` is control flow, not a savepoint.

### 1.2 What is inside that boundary

| Step | Writes |
|---|---|
| `postPendingEntry:193` → `postAccountingEvent` | `accountingEvents`, `journalEntries`, `journalLines`, `accountBalanceSnapshots` |
| `reversePendingEntry:216` → `reverseAccountingEvent` | the same four, reversal side |
| `markEntryPosted:282-292` (**REVERSE only**) | `commitmentAuthorityWork` (`recordAuthorityWork`), `depositApplications` (`commitDeferredReversal`) |
| `markEntryPosted:298` | `pendingAccountingEvents` → `POSTED` |
| `markEntryPosted:316-320` | `scheduleAuthorityDispatch` — **scheduled, correctly outside** |

A concrete late thrower exists today: `incrementAccountSnapshot`
(`accounting/accountSnapshots.ts:48-58`) calls `.unique()`, which throws when more
than one snapshot row matches a shard — **after** the event, journal and first
line are already written.

### 1.3 ⚠️ The REVERSE audit Sol ordered — same defect, WIDER blast radius

`drainEntries:1164` dispatches both kinds inside the same `try`. The deferred
REVERSE path therefore carries the identical mechanism, and `markEntryPosted`
does **more** on that path: a late throw can commit a partial reversal journal
**plus** partially-written `commitmentAuthorityWork` rows **plus** a
`depositApplications` state transition.

**Both kinds are in scope for this ticket.** Fixing POST alone would leave the
larger of the two exposed.

### 1.4 The repository already documents this defect against itself

`accountingOutbox.ts:253-266`:

> `drainEntries` wraps every row in a `try`/`catch` — correct for accounting,
> because one bad row must not abort an organization's whole drain — but that same
> catch makes the authority half un-rollbackable: an unexpected failure AFTER a
> successor root, claim or pointer was written is caught, the mutation returns
> normally and **COMMITS the partial state** … So each freed source now becomes a
> durable work item, settled in its OWN registered mutation where a throw is a
> real rollback boundary.

SCRUM-208 moved the **authority** half out. **The GL half was never moved.**
This ticket finishes that job.

---

## 2. The binding invariant

```
SUCCESS
  complete accounting event + journal + ALL lines + snapshots + projections
  + the pending row's completion
  -> commit atomically

FAILURE ANYWHERE IN POSTING
  -> ZERO accounting event / journal / line / snapshot / projection effect
  -> the pending row survives, durable and retryable/held/failed
     via a SEPARATE state transition
```

**A catch that surrounds financial writes inside the same mutation does not
satisfy this invariant.** Neither does a catch that merely records the failure
more carefully.

---

## 3. The architecture — extend a certified in-repo pattern, do not invent one

SCRUM-208 already built and certified this exact shape for authority settlement.
This contract applies it to GL posting. **Precedent for the transaction boundary
only** — no commitment/authority model is imported, and this does not become a
generic workflow engine.

```
selector  (no financial writes, chooses row IDs only)
    |
    v
per-row claim mutation      -> insert attempt, ctx.scheduler.runAfter(0, worker), patch row CLAIMED
    |
    v
worker: ONE registered internal mutation, ONE pending row
    re-read row, prove eligibility
    postAccountingEvent / reverseAccountingEvent
    (REVERSE) record authority work + commit deferred reversal
    mark THIS row POSTED
    -> COMMIT, or throw and roll back ALL of it
    |
    v
observer (separate transaction)  -> attempts / lastError / backoff / dead-letter
```

### 3.1 The rollback boundary is `ctx.scheduler.runAfter`, not an inline call

`markEntryPosted:305-307` states the mechanism explicitly:

> ⚠️ **SCHEDULED, NOT CALLED.** A scheduled mutation runs in its own transaction,
> outside this one and outside `drainEntries`' catch — which is the entire point.
> **Calling these inline would rebuild the defect with more steps.**

An inline call from a mutation shares the caller's transaction and provides no
boundary. This is the single most important implementation constraint here.

### 3.2 The worker must not catch

`performAuthoritySettlement:560-576` is the certified precedent, and its warning
transfers verbatim:

> ⚠️ **NOTHING CATCHES IN HERE, AND THAT IS THE FEATURE** … ⚠️ **SO DO NOT ADD A
> `try`/`catch` HERE.** Converting a throw into a recorded outcome from inside this
> mutation reintroduces the exact defect: the writes made before it would commit.

Expected business answers must be **typed return values that never throw**
(a rule resolving to "no accounting consequence" already returns `null` —
`postPendingEntry:189-196`). Anything that genuinely throws is precisely the case
that must roll back rather than be described.

### 3.3 Failure bookkeeping — two viable shapes, one recommended

Sol's ruling names "an internal action/orchestrator catches the failed mutation
call … **or an equivalent design with the same transactional property**."

**Option A — scheduled-function observer (RECOMMENDED; proven in-repo).**
`observeAuthorityAttempt:684-760` stores `scheduledFunctionId` on the attempt row
and later reads `ctx.db.system.get(scheduledFunctionId)`:

* `pending` / `inProgress` → push `nextActionAt` out, spend nothing
* `failed` / `canceled` → record and release for retry
* `success` **while still claimed** → **throw**, because that is an invariant
  violation and must fail visibly rather than be papered over

Mutation-only, no action, and `convex-test` models `_scheduled_functions`, so it
is testable at the level the bug lives.

**Option B — action orchestrator.** An internal action calls the worker mutation,
catches the rejected call, and invokes a separate recorder mutation. Equivalent
transactional property; adds an action tier and its own retry semantics.

**Recommendation: Option A**, because it is already certified in this exact file
and needs no new execution tier. Reviewers should attack that choice.

### 3.4 At-most-once under duplicate delivery

`dispatchAuthorityWorkItem:508-509` is the precedent — a single eligibility re-read
inside the claiming transaction is "the at-most-once guard for a duplicate
schedule, a re-drained accounting row, and the cron racing the latency schedule."

Required here: a duplicate or concurrent dispatch of one pending row must produce
**one economic posting and one terminal queue result**. Two independent defences,
both required:

1. the claim/generation guard (an inactive or superseded attempt returns, never writes);
2. `postAccountingEvent`'s existing idempotency on `idempotencyKey` and on
   `(eventType, sourceType, sourceId, eventVersion)`.

⚠️ **`eventVersion` occurrence semantics are unchanged by this ticket.** It
discriminates repeated economic occurrences (`workflowHooks.ts:141-149`); it is
not a schema version and must not be repurposed.

### 3.5 Scheduling — latency and liveness are DIFFERENT mechanisms

The drain-storm prohibition and the liveness requirement are the same design
question, and SCRUM-208 already answered it (`markEntryPosted:309-315`):

> ⚠️ **THIS IS A LATENCY OPTIMISATION, NOT THE RETRY MECHANISM** … retry LIVENESS
> comes from `dispatchDueAuthorityWork` reading `nextActionAt`, **never from
> accounting traffic** — so an organization that never drains again still retries.

and `crons.ts:103-110`:

> ⚠️ **THIS IS DELIBERATELY NOT ATTACHED TO ACCOUNTING TRAFFIC.** The predecessor
> re-offered owed work when an organization's accounting drain finished, which
> meant an organization that stopped draining stopped retrying … A fixed tick over
> `nextActionAt` is the whole point.

Binding consequences:

* **Eager dispatch targets the EXACT row** just enqueued. One receipt schedules
  work for one row. **N receipts must never produce N cursorless org-wide sweeps.**
* **Liveness comes from a bounded due-work sweep** over `nextActionAt`, on a fixed
  tick — like `dispatch-authority-work` (`crons.ts:115-120`, every minute).
* **Recovery must not depend on someone reopening a period or initialising a
  chart.** Today `drainPendingAccountingEvents` is scheduled only from
  `accountingPeriods.ts:285` (open), `:696` (**reopen**), `chartOfAccounts.ts:571`
  (chart init), plus its own pagination continuation — correct for the original
  park reason, insufficient as a general recovery path.
* Losing an eager schedule must cost latency only, never liveness.

### 3.6 Per-row isolation is preserved, not weakened

One bad row must still not abort unrelated rows. Under this design that property
comes from each row having its **own transaction**, which is strictly stronger
than a shared transaction with a catch.

---

## 4. Schema — what `pendingAccountingEvents` lacks today

Verified at `schema.ts:226-310`. Present: `status` (`PENDING|POSTED|FAILED`),
`idempotencyKey`, `accountingDate`, `actorId`, `attempts`, `lastError`,
`authorityOutcome*`, POST/REVERSE shape fields. Indexes: `by_org_status`,
`by_org_idempotency`, `by_org_source`, `by_org_authority_outcome`.

**Absent, and required by §3:** a claimed/dispatched state · `nextActionAt` ·
an attempt identity (`generation` / `activeAttemptId` / `scheduledFunctionId`) ·
a due-work index.

### 4.1 ⚠️ The legacy-row trap — this is the highest-risk part of the change

Existing `PENDING` rows have **no** `nextActionAt`. A due-work selector keyed on
`nextActionAt` would **never see them**, and they would stop draining silently —
converting a visible backlog into an invisible one.

Binding requirements:

* the selector must find legacy rows that predate the field (treat absent
  `nextActionAt` as immediately due, or backfill it as part of the same change,
  and **state which**);
* a fixture must seed a legacy-shaped row **with no new fields at all** and prove
  it still posts. A suite seeded only with new-shape rows tests only the branch
  that was built, and would pass while the backlog is stranded;
* adding the new status literal must not make existing readers of
  `status === "PENDING"` wrong. Every reader must be enumerated, including period
  close, the Accounting → Setup pending list, and `retryFailed`.

### 4.2 Held vs failed must stay distinguishable

`markEntryHeld:1088-1092` patches only `lastError` — it never counts an attempt
and never dead-letters, which is right for a self-resolving blocker.
`markEntryFailed:1060-1079` counts attempts and dead-letters at
`MAX_ATTEMPTS = 10` (`:184`). This distinction must survive the refactor; a held
row must not start burning attempts, and a genuinely failing row must still reach
`FAILED` and remain reachable by `retryFailed`.

---

## 5. Failing-first evidence (Jira SCRUM-222, all 12 required)

Each must be **RED against `bf5769ed1` before any implementation edit**, with the
RED evidence preserved. Every failure fixture asserts the **whole accounting
footprint** — `accountingEvents`, `journalEntries`, `journalLines`,
`accountBalanceSnapshots`, and for REVERSE also `commitmentAuthorityWork` and
`depositApplications` — never only the pending row's status.

1. fault after event/journal creation, before lines/snapshots complete → **all GL writes absent**
2. fault after the first journal line → zero event/journal/line/snapshot delta
3. success → complete balanced journal **and** row `POSTED`, atomically
4. one bad row + one good row → bad row durable/retryable, good row still posts in its own transaction
5. two concurrent dispatches of one row → one economic event, one terminal queue result
6. retry after a transient failure → one final journal, no duplicate event
7. persistent deterministic failure → bounded attempts/backoff, durable manual-attention state, **no partial GL on any attempt**
8. receipt-triggered scheduling → work scheduled for the **exact row**; N receipts do **not** create N whole-org drains
9. recovery proves liveness **even if the eager schedule is lost or fails**
10. the same for a **REVERSE** row (§1.3) — partial authority/deposit state must also be absent
11. a **legacy-shaped** pending row (no new fields) still posts (§4.1)
12. a held row does not burn attempts; a failing row still reaches `FAILED` and `retryFailed` finds it (§4.2)

⚠️ Fault injection must be a **real throw from inside the posting path**, not a
test double that returns an error — the defect is specifically about what a throw
does to a transaction. A seam that returns instead of throwing cannot reproduce it.

⚠️ `convex-test` **serializes everything and models no OCC**. Case 5's
*concurrency* claim is therefore **not** provable there; what is provable is
duplicate/sequential delivery and the claim guard. Any true-concurrency assertion
requires a real Convex runtime, and the contract records that boundary rather than
overstating the harness.

## 6. Absence mutants

Mutating a condition that exists cannot detect a control that was never written.
**Every killer below either exists on `bf5769ed1` or is required by this
document** — cited, not assumed.

| Mutant | Killed by | Killer |
|---|---|---|
| catch the posting exception **inside** the worker mutation | 1, 2, 10 | required §3.2 |
| mark the row `POSTED` before the journal is complete | 1, 2, 3 | required §3 |
| the failure recorder shares the financial transaction | 1, 2, 7 | required §3.3 |
| call the worker inline instead of scheduling it | 1, 2 | required §3.1 |
| drop the claim/generation guard | 5, 6 | required §3.4 |
| schedule an org-wide sweep per receipt instead of exact-row dispatch | 8 | required §3.5 |
| remove the due-work sweep, keeping only eager dispatch | 9 | required §3.5 |
| key liveness on period-open / chart-init only | 9 | required §3.5 |
| selector skips rows with absent `nextActionAt` | 11 | required §4.1 |
| route a held row through the attempt counter | 12 | exists (`markEntryHeld:1088`) vs (`markEntryFailed:1060`) |
| fix POST only, leave REVERSE on the caught path | 10 | required §1.3 |

## 7. Non-goals

Not owned here; drift into any of them stops and returns to owner-proxy:
the SCRUM-218 receipt split · the 2110 liability account · `collectionPayloadVersion`
· `accountingMigration` durable refusal (**SCRUM-223**) · SCRUM-208's
commitment/authority model beyond the transaction-boundary pattern · a generic
workflow/job engine · provider ingress · refunds · production migration or backfill.

## 8. What reviewers are asked to attack

Whether §3 actually yields a real rollback boundary on **both** kinds · whether any
financial write can still occur inside a catch · whether Option A's observer can
mis-read an outcome or lose a row · at-most-once under duplicate delivery, and
which part of it `convex-test` genuinely proves · §4.1's legacy trap and every
enumerated `status === "PENDING"` reader · whether held/failed semantics survive ·
whether liveness truly survives a lost eager schedule · whether §5's fault
injection reproduces a **throw** rather than a returned error · any drift into §7.

**Governance:** this is a CRITICAL-severity prerequisite. A CRITICAL finding, or a
new architectural HIGH introduced by this design, returns to owner-proxy rather
than starting an automatic patch cycle.
