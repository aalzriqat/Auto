# SCRUM-222 — outbox posting atomicity (revision 1)

**Authorized** by owner-proxy `c17353` — exactly **one** bounded contract-only
correction round. The convergence breaker was deliberately **not** fired: 0
CRITICAL, both families converged on one design mistake, the preferred fix removes
complexity, and both seats validated the load-bearing architecture (isolated
POST/REVERSE worker transaction, scheduler boundary, no-catch financial worker).

**Supersedes** `00-contract.md` @ `f37c09327`, now **FAILED DESIGN-REVIEW
EVIDENCE — preserve, do not implement from it** (`c17353`). Both DESIGN seats
BLOCKED it (Sonnet MAX 1 HIGH / Codex 3 HIGH / 0 CRITICAL either side).
**Base:** protected `main` `bf5769ed1`. **Blocks SCRUM-218.**
**Merge posture:** merge-ready HOLD; not merged even if fully green.

## 0. What changed and why

| # | Defect in `f37c09327` | Correction |
|---|---|---|
| R1 | claim state as a **`status` literal** silently breaks readers; a claimed prepaid row survives cancellation and posts for a **reversed** prepayment | §4 — `status` is never touched; claim state moves to optional operational fields |
| R2 | the worker proved *attempt* eligibility but not **business** eligibility | §3.3 — the posting guards are re-run inside the worker, with a typed non-throwing HELD outcome |
| R3 | only the cron caller was cut over; **three** caller families exist | §3.5 — all three enumerated, redrive semantics specified |
| R4 | the due sweep would revive a known **starvation** class and could strand a claimed row forever | §5 — complete state transitions |
| R5 | "enumerate every reader of `status === \"PENDING\"`" named a search that **misses 6 of 7 readers** | obsolete — §4 removes the need for the audit entirely |
| R6 | citation offsets | fixed in §1/§3 |

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

A throw **after** the first financial write is caught, the mutation returns
normally, and every write staged before the throw **commits**. Convex has no
block-scoped rollback; `try`/`catch` is control flow, not a savepoint.

### 1.2 What is inside that boundary

| Step | Writes |
|---|---|
| `postPendingEntry:193` → `postAccountingEvent` | `accountingEvents`, `journalEntries`, `journalLines`, `accountBalanceSnapshots` |
| `reversePendingEntry:216` → `reverseAccountingEvent` | the same four, reversal side |
| `markEntryPosted:281-292` (**REVERSE only**) | `commitmentAuthorityWork`, `depositApplications` |
| `markEntryPosted:298` | `pendingAccountingEvents` → `POSTED` |
| `markEntryPosted:316-320` | `scheduleAuthorityDispatch` — **scheduled, correctly outside** |

A real late thrower exists: `accounting/accountSnapshots.ts:48-58`
`incrementAccountSnapshot` calls `.unique()`, which throws on more than one
snapshot row for a shard — **after** the event, journal and first line are written.

### 1.3 The REVERSE path has the same defect, with a wider blast radius

`:1164` dispatches both kinds inside the one `try`, and `markEntryPosted` writes
**more** on the reversal path. Both kinds are in scope; fixing POST alone leaves
the larger exposure.

### 1.4 The repository documents this against itself

`accountingOutbox.ts:253-266` — "…that same catch makes the authority half
un-rollbackable … the mutation returns normally and **COMMITS the partial state**
… So each freed source now becomes a durable work item, settled in its OWN
registered mutation where a throw is a real rollback boundary."

SCRUM-208 moved the **authority** half out. **The GL half was never moved.**

---

## 2. The binding invariants

**I1 — atomicity.**

```
SUCCESS   complete event + journal + ALL lines + snapshots + projections
          + the row's completion  -> commit atomically
FAILURE   ZERO event/journal/line/snapshot/projection effect
          + the row survives, durable and retryable/held/failed
            via a SEPARATE state transition
```

**I2 — a claimed row is still an outstanding obligation.** ⚠️ *New in this
revision.* A row that has been picked up but has not committed must remain
visible **as outstanding** to every control, cancellation path, report and
recovery mechanism — period close, source cancellation, GL-state projections,
capitalization evidence — exactly as a `PENDING` row is today.

**I3 — a row whose source has been invalidated must never post.** ⚠️ *New.*
If the triggering source is reversed or cancelled at any point before the
financial transaction commits, the row must not reach the GL, regardless of what
stage of the pipeline it is in.

Baseline satisfies I2 and I3 *for free*, because one mutation per row leaves no
observable in-between state. **This design creates that window, so it must carry
them explicitly.**

---

## 3. The architecture

Extends the pattern SCRUM-208 certified for authority settlement. **Transaction
boundary only** — no commitment/authority model, no generic workflow engine.

```
selector (read-only; chooses row IDs)
    |
claim mutation      -> operational fields only; NO status change; schedule worker
    |
worker: ONE registered internal mutation, ONE row
    re-read row; prove attempt eligibility; prove BUSINESS eligibility (§3.3)
    postAccountingEvent / reverseAccountingEvent
    (REVERSE) record authority work + commit deferred reversal
    flip THIS row PENDING -> POSTED
    schedule authority dispatch (scheduled, outside)
    -> COMMIT, or throw and roll back ALL of it
    |
observer (separate transaction) -> attempts / lastError / backoff / dead-letter
```

### 3.1 The rollback boundary is `ctx.scheduler.runAfter`, never an inline call

`markEntryPosted:305-307`: *"SCHEDULED, NOT CALLED. A scheduled mutation runs in
its own transaction, outside this one and outside `drainEntries`' catch — which is
the entire point. Calling these inline would rebuild the defect with more steps."*

### 3.2 The worker must not catch

`performAuthoritySettlement:560-576`: *"NOTHING CATCHES IN HERE, AND THAT IS THE
FEATURE … SO DO NOT ADD A `try`/`catch` HERE."*

### 3.3 ⚠️ The worker must re-prove BUSINESS eligibility, not only attempt identity

**This is R2, and it is the correction that prevents a wrong GL entry.**

On the SCRUM-208 precedent, "prove eligibility" means *"am I still the active
attempt"* (`dispatchAuthorityWorkItem:505-509`, `performAuthoritySettlement:600`).
That is **not sufficient here.** Today the business guards run in the drain
immediately before posting:

```
drainEntries:1135-1141   if (p.kind === "POST") {
                            prepaidPostingBlockedReason(ctx, p)
                         ?? payrollPostingBlockedReason(ctx, p)
                         ?? commissionPostingBlockedReason(ctx, p)
```

The worker **must re-run all three against current state**, inside its own
transaction, immediately before posting — **and additionally prove the relevant
source cancellation/reversal conditions** (`c17353` §2), because a source can be
reversed between claim and execution even when no blocker function covers it.

> **Owning the claim is not enough to authorize posting.** A stale worker may not
> post merely because its attempt token is still valid.

Required order, and the order is the contract:

```
re-read the stored row
  -> prove this is the active generation/attempt
  -> RE-PROVE current business eligibility (guards + source not cancelled/reversed)
  -> only then perform the FIRST financial write
``` A guard that returns a reason must
produce a **typed, non-throwing HELD outcome** that releases the claim and leaves
the row `PENDING` — mirroring `postPendingEntry`'s existing precedent of returning
`null` rather than throwing for "no accounting consequence" (`:189-196`).

⚠️ **A held outcome must not throw**, because a throw would roll back the claim
release too and the row would be re-dispatched forever. ⚠️ **And it must not be a
`catch`**, because §3.2 forbids that. It is a *return value*.

⚠️ The guards themselves may throw on malformed data — `drainEntries:1142-1152`
already treats a **throwing guard** as a per-entry failure. That behaviour must be
preserved, and it belongs to the **observer**, not to a catch inside the worker.

### 3.4 Failure bookkeeping — the scheduled-function observer

Store `scheduledFunctionId` on the attempt; the observer reads
`ctx.db.system.get(...)`: `pending`/`inProgress` → look again, spend nothing;
`failed`/`canceled` → record and release with backoff; `success` while still
claimed → **throw**, an invariant violation that must fail visibly
(`observeAuthorityAttempt:684-762`).

Mutation-only; no action tier. Both seats independently preferred this over an
action orchestrator — an action that catches a worker rejection can die before
invoking the recorder, leaving nothing durable, and cannot replace the due-time
recovery mechanism. The owner-proxy's action option is recorded as the
alternative; this contract selects the observer.

### 3.5 ⚠️ All THREE caller families must be cut over (R3)

`drainEntries` has three production caller families. Cutting over only the cron
leaves financial writes inside a catch on the other two:

| Caller | Required change |
|---|---|
| `drainPendingAccountingEvents:1284` (cron/internal) | selector + exact-row dispatch |
| `accountingOutbox.redrive:1322` | must not post inline; schedules work |
| `prepaidExpenses.redriveScheduleEvents:643` | see below |

⚠️ **`redriveScheduleEvents` passes FAILED rows as an IN-MEMORY CLONE**:

```
prepaidExpenses.ts:688   matches.map(row => row.status === "FAILED" ? { ...row, attempts: 0 } : row)
                 :690   return await drainEntries(ctx, toDrain);
```

The reset is **never persisted**. It works only because `drainEntries` posts
inline in the same mutation. A worker that re-reads storage sees the original
`FAILED` row with exhausted attempts and refuses it as ineligible — **the redrive
button would silently stop working.**

Required: **persist** the `FAILED → PENDING` reset, clear stale claim metadata,
set the row due, then exact-schedule it.

⚠️ **Result semantics change.** Both redrive mutations currently return
`posted/failed/held` counts as though posting finished, and the UI renders that as
completion (`components/accounting/PrepaidExpensesTab.tsx`,
`components/accounting/AccountingSetupTab.tsx`). Under async dispatch those counts
are a **lie**. They must become accepted/scheduled counts, with UI copy and i18n
updated to match. Prepaid **source-debit-first ordering** becomes eventual rather
than synchronous; dependent rows must remain held until the source posts — which
the existing guard already enforces, and §3.3 keeps enforcing in the worker.

### 3.6 At-most-once, and per-row isolation

Two independent defences: the claim/generation guard (a superseded attempt returns
without writing) and `postAccountingEvent`'s idempotency on `idempotencyKey` and on
`(eventType, sourceType, sourceId, eventVersion)` (`postingEngine.ts:100-118`
returns `alreadyPosted` rather than reposting).

⚠️ `eventVersion` occurrence semantics are unchanged (`workflowHooks.ts:141-149`).

Per-row isolation becomes **stronger**, not weaker: each row has its own
transaction rather than sharing one behind a catch.

---

## 4. Schema — `status` is NOT touched (R1)

⚠️ **The previous revision added a claimed literal to `status`. That is withdrawn.**
`status` is a business field read across the codebase, and a fourth value silently
breaks readers that predate it:

| Reader | Effect of a new literal |
|---|---|
| `accountingPeriods.ts:330-341` close checklist | a claimed row **stops blocking period close** |
| `workflowHooks.ts:2422-2435` prepaid reversal cleanup | a claimed row **survives cancellation** → posts for a reversed prepayment |
| `vehicles.ts:1028` `provenAcquisitionEvidence` | capitalization evidence goes **false-negative** |
| `accountingSetup.ts`, `accountingReports.ts`, `reports.ts:409`, `prepaidExpenses.ts:1350`, `utils/prepaidRecognitionEvents.ts:199/228` | outstanding-work projections under-report |

**Binding rule:**

> `pendingAccountingEvents.status` keeps exactly its three values. A row stays
> **`PENDING`** from enqueue until the worker atomically flips it to `POSTED`, or
> the observer dead-letters it to `FAILED`. **Claiming is execution metadata, not
> an accounting outcome.**

Claim state lives in **new optional fields** on the same row:
`dispatchState` · `generation` · `activeAttemptId` · `scheduledFunctionId` ·
`nextActionAt`, plus a due-work index. All optional and additive, so no existing
row changes and no existing reader changes.

A "claimed" row is simply a `PENDING` row that additionally carries an unexpired
active attempt — the exact shape `commitmentAuthorityWork`'s own
`by_status_next_action` index already serves.

Readers verified **safe by construction** and requiring no change:
`retryFailed` (`=== "FAILED"`), `cancelPendingPostByKey`/`BySource`
(`!== "POSTED"`), `queuedEntryStatus` (`neq(status,"POSTED")`),
`accountingMigration`'s presence-only lookups, `vehicles.ts:947-951` (existence).

### 4.1 The semantic matrix (`c17353` §3) — audit by FIELD AND TABLE, never by expression

⚠️ The previous revision required "enumerate every reader of `status === "PENDING"`".
**Six of the real readers do not contain that substring** — they are written
`for (const status of ["PENDING","FAILED"] as const)`. The audit as specified
would have run, found one reader, and reported success. **A search expression is
a discovery aid, never a proof of completeness.**

Below is the semantic matrix over `pendingAccountingEvents` on `bf5769ed1`,
classified by **how each site constrains `status`** — not by how it is spelled.
It found reference sites neither review seat enumerated.

**Class A — status-agnostic. Safe by construction; require NO change.**
Presence-only or `!== POSTED`; an extra non-terminal state is read conservatively.

```
accountingOutbox.ts:57   enqueuePendingPost            presence (.unique)
accountingOutbox.ts:99   enqueuePendingReversal        presence (.unique)
accountingOutbox.ts:134  cancelPendingPostByKey        kind POST && status !== POSTED
accountingOutbox.ts:163  cancelPendingPostsBySource    by_org_source, !== POSTED
workflowHooks.ts:83      postOrEnqueue pre-check       kind POST && status !== POSTED
workflowHooks.ts:1308    commission queued check       neq(status, POSTED)
workflowHooks.ts:1391    queuedEntryStatus             neq(POSTED) then FAILED?FAILED:PENDING
expenses.ts:105          queued expense post           presence
payroll.ts:496           queued payroll post           neq(status, POSTED)
commissionSourceLedger.ts:160  queued sale_completed   neq(status, POSTED)
accountingMigration.ts:608,655 exposure checks         presence
migrateConsignedSaleBasis.ts:240                       presence
vehicles.ts:948          hasQueuedVehicleAcquisition   presence
orgSettings.ts:171       org-has-activity probe        by_org_status, orgId only
```

**Class B — EXACT status equality. Every one breaks if a fourth literal is added.**

```
accountingPeriods.ts:332,340   close checklist          PENDING / FAILED   <- stops blocking close
workflowHooks.ts:2426          prepaid reversal cleanup PENDING/FAILED loop <- ⚠️ posts for a REVERSED source
vehicles.ts:1028               provenAcquisitionEvidence status === PENDING <- false negative
accountingSetup.ts:102         Setup pending list       PENDING
accountingReports.ts:1234,1239 commission controls      PENDING + FAILED
reports.ts:416                 GL-state projection      PENDING/FAILED loop
prepaidExpenses.ts:666         redriveScheduleEvents    PENDING/FAILED loop
prepaidExpenses.ts:1357        listSchedules            PENDING/FAILED loop
prepaidRecognitionEvents.ts:201,230                     PENDING/FAILED loops
accountingOutbox.ts:1189,1230  drain selectors          PENDING   (this ticket's own)
accountingOutbox.ts:1310       listPending (operator)   args.status
```

**Class C — lifecycle / structural coupling, no status predicate.**

```
adminOrgs.ts:61          ORGANIZATION_DELETION_STEPS   by_org_status
orgFinancialReset.ts:50  RESET_TABLES
schema.ts:391            commitmentAuthorityWork.pendingEventId  (FK; "PROVENANCE, NEVER A DECISION INPUT")
accountingSetup.ts:22    Id<"pendingAccountingEvents"> in a returned shape
Doc<> helpers: accountingOutbox.ts:195,216,231,336,1060,1088,1103 ·
               accountingReports.ts:1170 · prepaidExpenses.ts:656,662 ·
               prepaidRecognitionEvents.ts:218 · prepaidSourceLedger.ts:78
```

**The conclusion the matrix forces:** Class B has **thirteen** sites, not the
seven either seat enumerated. Teaching thirteen readers a fourth status — and
proving no fourteenth exists — is strictly worse than never changing the enum.
**§4's structural rule makes Class B empty by construction**, and Class A and C
are unaffected either way. The matrix is published as evidence that the surface
was examined semantically, not as a list of edits to make.

### 4.2 The Convex index question — RESOLVED by `c17353`, still proven empirically

Owner-proxy ruling: a missing optional field behaves as `undefined` for
index/filter semantics; `q.eq("field", undefined)` matches documents where the
field is absent, and `undefined` sorts before `null` and ordinary values.
**Therefore a legacy row with no `nextActionAt` is index-representable and no data
backfill is required merely to make old rows visible.**

⚠️ **The empirical fixture remains mandatory** (`c17353`). Documentation
establishes the platform rule; it does not establish that **our** compound-index
selector expresses it correctly. Evidence case 11 must demonstrate:

```
a real legacy-shaped row, nextActionAt COMPLETELY ABSENT
        -> the ACTUAL proposed selector query
        -> the row is returned as due
```

That tests our query shape rather than extrapolating from a document. If the
actual selector does **not** return it, the design needs a sentinel or a backfill,
and backfill is a §8 non-goal that returns to owner-proxy.

### 4.3 Held vs failed must stay distinguishable

`markEntryHeld:1088-1092` patches only `lastError` — no attempt, no dead-letter.
`markEntryFailed:1060-1079` increments attempts and dead-letters at
`MAX_ATTEMPTS = 10` (`:184`). Preserve both.

### 4.4 A new attempt table joins the destructive manifests

If claim state uses a separate table rather than fields on the row, it **must** be
added to `ORGANIZATION_DELETION_STEPS` (`adminOrgs.ts:44`, where
`pendingAccountingEvents` sits at `:61` and `commitmentAuthorityWork` at `:60`) and
to `RESET_TABLES` (`orgFinancialReset.ts:35`), **ordered before** the pending row.
Otherwise org deletion or financial reset leaves orphaned tenant rows and
scheduled references. Fields-on-the-row avoid this entirely, which is one more
reason to prefer them.

---

## 5. State transitions — complete, because underspecifying them revives a known defect (R4)

⚠️ `accountingOutboxSweep.test.ts:117-151` is an **existing regression** for this
exact starvation class: 55 held rows ahead of 5 valid ones, asserting the held
rows burn **zero attempts**. A due sweep whose held branch only patches
`lastError` (today's behaviour) leaves those rows **immediately due forever**, so
every tick re-selects them and the valid work behind them is never offered.

Binding transitions:

| From | Event | To |
|---|---|---|
| PENDING, unclaimed, due | selector claims | PENDING + active attempt, observation deadline set |
| claimed | worker posts | **POSTED** (atomic with the journal) |
| claimed | worker's business guard returns a reason | **PENDING**, claim released, **zero attempts consumed**, `nextActionAt` pushed **forward** |
| claimed | worker throws | rolled back; observer records the attempt, applies backoff, releases |
| claimed | observation deadline passes, outcome unknown | **the sweep re-observes** — never dispatches a second worker |
| PENDING | attempts reach MAX_ATTEMPTS | **FAILED**, dead-lettered, `retryFailed` can revive it |

⚠️ **A held row must move its `nextActionAt` forward.** Otherwise it starves the
queue. ⚠️ **The sweep must select due *claimed* rows for observation**, or a lost
observer strands a row permanently — the authority precedent does this and the
previous revision omitted it.

### 5.1 Latency and liveness are different mechanisms

* **Eager dispatch targets the EXACT row.** N receipts must never produce N
  cursorless org-wide sweeps.
* **Liveness is a fixed tick over `nextActionAt`**, like `dispatch-authority-work`
  (`crons.ts:115-120`). `markEntryPosted:309-315` and `crons.ts:103-110`:
  *"retry LIVENESS comes from `dispatchDueAuthorityWork` reading `nextActionAt`,
  never from accounting traffic."*
* **Recovery must not depend on a period reopen or chart init.** Today
  `drainPendingAccountingEvents` is scheduled only from `accountingPeriods.ts:285`
  (open), `:696` (**reopen**) and `chartOfAccounts.ts:571` (chart init), plus its
  own pagination continuation — confirmed exhaustive by both seats.
* Losing an eager schedule costs **latency only**, never liveness.
* Work per tick must be **bounded**, and ordering must not let one org starve
  others.

---

## 6. Failing-first evidence

Each must be **RED against `bf5769ed1` before any implementation edit**, evidence
preserved. Every failure fixture asserts the **whole accounting footprint** —
`accountingEvents`, `journalEntries`, `journalLines`, `accountBalanceSnapshots`,
and for REVERSE also `commitmentAuthorityWork` and `depositApplications` — never
only the row's status.

1. fault after event/journal creation, before lines/snapshots → **all GL writes absent**
2. fault after the first journal line → zero delta
3. success → complete balanced journal **and** row `POSTED`, atomically
4. one bad row + one good row → bad row durable, good row posts in its own transaction
5. duplicate dispatch of one row → one economic event, one terminal result
6. retry after a transient failure → one final journal, no duplicate event
7. persistent deterministic failure → bounded attempts/backoff, durable manual-attention state, **no partial GL on any attempt**
8. receipt-triggered scheduling → the **exact row**; N receipts ≠ N org-wide drains
9. liveness **when the eager schedule is lost or fails**
10. the same for a **REVERSE** row — partial authority/deposit state also absent
11. a **legacy-shaped** row (no new fields) still posts — and **empirically proves §4.1's index question**
12. a held row burns no attempts; a failing row reaches `FAILED` and `retryFailed` finds it
13. ⚠️ **source invalidated between claim and worker** → no GL write, no throw, row returns to a retryable state, and cancellation/reporting readers see it as outstanding throughout (I3)
14. ⚠️ **a claimed row still blocks period close** and still appears in every outstanding-work projection (I2)
15. ⚠️ **starvation beyond one page** — held rows ahead of valid work, modelled on `accountingOutboxSweep.test.ts:117-151`; the valid rows must post and the held rows must burn zero attempts
16. ⚠️ **lost observer** → the due sweep re-observes and recovers; no permanently claimed row
17. ⚠️ **caller matrix** — both redrive doors: persisted FAILED reset, exact-row scheduling, truthful accepted/scheduled result, authorization preserved, duplicate click safe

⚠️ Fault injection must be a **real throw from inside the posting path**. A seam
that *returns* an error cannot reproduce a transaction defect.

⚠️ `convex-test` **serializes everything and models no OCC**, so case 5's
*true-concurrency* half is unprovable there; what it proves is duplicate/sequential
delivery and the claim guard. It **does** model `_scheduled_functions`, which is
what cases 9 and 16 need. True concurrency requires a real Convex runtime.

## 7. Absence mutants

**Every killer either exists on `bf5769ed1` or is required by this document.**

| Mutant | Killed by | Killer |
|---|---|---|
| catch the posting exception inside the worker | 1, 2, 10 | required §3.2 |
| mark the row POSTED before the journal is complete | 1, 2, 3 | required §3 |
| the failure recorder shares the financial transaction | 1, 2, 7 | required §3.4 |
| call the worker inline instead of scheduling it | 1, 2 | required §3.1 |
| **skip the business guards in the worker** | **13** | **required §3.3** |
| **make the held outcome throw instead of returning** | 12, 13 | required §3.3 |
| **add a claimed literal to `status`** | **13, 14** | **required §4** |
| drop the claim/generation guard | 5, 6 | required §3.6 |
| **cut over only the cron caller** | **17** | **required §3.5** |
| **keep the in-memory FAILED clone** | **17** | **required §3.5** |
| org-wide sweep per receipt instead of exact-row dispatch | 8 | required §5.1 |
| remove the due-work sweep, keeping only eager dispatch | 9 | required §5.1 |
| **hold without advancing `nextActionAt`** | **15** | **required §5** |
| **sweep selects only unclaimed rows** | **16** | **required §5** |
| selector skips rows with absent `nextActionAt` | 11 | required §4.2 |
| route a held row through the attempt counter | 12 | exists (`markEntryHeld:1088` vs `markEntryFailed:1060`) |
| fix POST only, leave REVERSE on the caught path | 10 | required §1.3 |

## 8. Non-goals

The SCRUM-218 receipt split · the 2110 account · `collectionPayloadVersion` ·
`accountingMigration`'s durable refusal (**SCRUM-223**) · SCRUM-208's
commitment/authority model beyond the transaction-boundary pattern · a generic
workflow/job engine · provider ingress · refunds · **production migration or
backfill** (see §4.1 — if the index question forces one, that returns to
owner-proxy).

## 9. What reviewers are asked to attack

Whether §3 yields a real rollback boundary on **both** kinds · whether any
financial write can still occur inside a catch · whether §3.3's held return can
strand or double-dispatch a row · whether §3.5's caller cutover is complete and
whether any **fourth** caller exists · whether §4 leaves any reader wrong ·
whether §5's transitions actually prevent starvation and permanent claims ·
whether §4.1's question is stated honestly and case 11 would really prove it ·
whether §6's fault injection reproduces a **throw** · every §7 killer · drift
into §8.

**Governance (`c17353`), stated precisely because the previous revision's wording
was too blunt:**

* any **CRITICAL** → **stop**, return to owner-proxy;
* any new **HIGH that shows the fundamental per-row rollback/retry architecture is
  wrong** → **stop**;
* a **bounded HIGH from an enumerated caller or state-machine omission does not
  automatically prove the architecture failed** — but it must still be explicitly
  dispositioned before implementation.

This is the **one** authorized correction round. Reviewers should say plainly
which of those three categories any finding falls into, because that
classification decides whether work continues.

## 10. Known-unresolved, carried forward rather than hidden

* whether `payrollPostingBlockedReason` and `commissionPostingBlockedReason`
  carry the same post-claim source-invalidation exposure the prepaid guard does
  (Sonnet did not trace them) — §3.3 covers all three by construction, but the
  reproduction exists only for prepaid;
* whether an **eighth** reader of `status` exists beyond the seven enumerated —
  §4 makes this moot by never changing the enum, which is why it is preferred;
* the §4.1 Convex index question.
