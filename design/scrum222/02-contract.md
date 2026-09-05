# SCRUM-222 — outbox posting atomicity (revision 2, FINAL)

**Authorized** by owner-proxy `c17356` as the **final closure amendment**.
Justification was narrow and is recorded here so it is not mistaken for an open
loop: both families returned **0 CRITICAL and 0 architecture-wrong HIGH**, and
both affirmed the core per-row rollback architecture.

**Supersedes** `01-contract.md` @ `7232f95916` (both seats BLOCK; 3 bounded HIGH,
2 MEDIUM, 3 LOW) and `00-contract.md` @ `f37c09327`. **Both are FAILED
DESIGN-REVIEW EVIDENCE — preserve, do not implement from them.**

**Base:** protected `main` `bf5769ed1`. **SCRUM-222 blocks SCRUM-218.**
**Merge posture:** merge-ready HOLD; not merged even if fully green.

## ⛔ TERMINAL RULE — this contract gets one review, not a round

> This SHA goes to **Sonnet MAX** and **Codex exactly xhigh**. **Both must return
> APPROVE / CLEAN.** Any further BLOCK, HIGH or CRITICAL **ends SCRUM-222 design
> iteration**. There is no further automatic amendment.

Reviewers: a clean approval is a legitimate and expected outcome. Do not
manufacture findings. But do not soften a real one either — the cost of a missed
defect here is a wrong GL entry in production, and this is the last gate.

If both approve: executable RED evidence — **including the real non-production
Convex selector proof (§4.2)** — and only then implementation.

---

## 0. What changed from `7232f95916`

| # | Round-2 finding | Correction |
|---|---|---|
| A1 | I3 blocked a REVERSE whose source was cancelled — i.e. every deferred reversal, forever | §2 — I3 is now **kind-specific** |
| A2 | the observer had no branch for a **missing** `_scheduled_functions` record | §3.4 — absence is an observed failure |
| A3 | a **fourth** `drainEntries` invocation site existed after I claimed three | §3.5 — `drainPendingForOrg` is **retired** |
| A4 | manual retry left stale claim metadata | §5.2 — clear metadata, **advance generation**, persist, "retry queued" |
| A5 | two semantic-matrix classification errors | §4.1 — corrected inline and marked |
| A6 | `convex-test` cannot certify the index question | §4.2 — **required real-runtime gate** |
| A7 | cursor mechanics were inference, not text | §5.1 — stated explicitly |

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
normally, and every write staged before it **commits**. Convex has no
block-scoped rollback; `try`/`catch` is control flow, not a savepoint.

### 1.2 What is inside that boundary

| Step | Writes |
|---|---|
| `postPendingEntry:193` → `postAccountingEvent` | `accountingEvents`, `journalEntries`, `journalLines`, `accountBalanceSnapshots` |
| `reversePendingEntry:216` → `reverseAccountingEvent` | the same four, reversal side |
| `markEntryPosted:281-292` (**REVERSE only**) | `commitmentAuthorityWork`, `depositApplications` |
| `markEntryPosted:298` | `pendingAccountingEvents` → `POSTED` |
| `markEntryPosted:316-320` | `scheduleAuthorityDispatch` — **scheduled, correctly outside** |

A real late thrower exists today: `accounting/accountSnapshots.ts:48-58`
`incrementAccountSnapshot` calls `.unique()`, which throws on more than one
snapshot row for a shard — **after** the event, journal and first line are written.

### 1.3 REVERSE carries the same defect with a wider blast radius

`:1164` dispatches both kinds inside the one `try`, and `markEntryPosted` writes
more on the reversal path. **Both kinds are in scope.**

### 1.4 The repository documents this against itself

`accountingOutbox.ts:253-266` — *"…that same catch makes the authority half
un-rollbackable: an unexpected failure AFTER a successor root, claim or pointer
was written is caught, the mutation returns normally and **COMMITS the partial
state** … So each freed source now becomes a durable work item, settled in its OWN
registered mutation where a throw is a real rollback boundary."*

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

**I2 — a claimed row is still an outstanding obligation.** A row picked up but not
committed must remain visible **as outstanding** to every control, cancellation
path, report and recovery mechanism, exactly as a `PENDING` row is today.

**I3 — source validity is KIND-SPECIFIC.** ⚠️ *Corrected; the previous revision
applied one POST-shaped rule to both kinds and would have held every deferred
reversal forever.*

```
I3-POST   A queued POST whose source has been cancelled or reversed must NEVER
          post. It TERMINATES the way existing cancellation helpers already
          terminate it — deletion — never by holding.

I3-REV    A queued REVERSE re-proves the EXACT ORIGINAL ACCOUNTING-EVENT /
          REVERSAL OBLIGATION: correct tenant, the original event still POSTED,
          the reversal date and idempotency identity intact.
          It MUST NOT require the domain source to still be active.
          The source being cancelled is often precisely WHY the reversal exists.
```

**Why I3-REV must be written this way.** `workflowHooks.ts:257-258` — *"No open
period — defer the reversal to the outbox instead of skipping it"* — so cancelling
a completed sale when no period covers the date queues a REVERSE row **while the
sale commits `CANCELLED` in the same mutation**. A source-active requirement would
hold that reversal forever and leave the original journal economically live
against a cancelled operation. Five producers reach this path:
`workflowHooks.ts:258` (generic `reverseEventIfPosted`), `:2317`, `:2406`,
`collections.ts:1596`.

Baseline satisfies I2 and I3 *for free* — one mutation per row leaves no
observable in-between state. **This design creates that window, so it carries them
explicitly.**

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
    re-read row; prove active generation/attempt; prove BUSINESS eligibility (§3.3)
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

### 3.3 Owning the claim does not authorize posting

> **A stale worker may not post merely because its attempt token is still valid.**

Required order, and the order is the contract:

```
re-read the stored row
  -> prove this is the active generation/attempt
  -> RE-PROVE current eligibility, per §2's kind-specific I3
  -> only then perform the FIRST financial write
```

For a **POST**, re-proof means the three existing guards run against current
state — `drainEntries:1135-1141`, `prepaidPostingBlockedReason` ??
`payrollPostingBlockedReason` ?? `commissionPostingBlockedReason` — **plus**
I3-POST source cancellation/reversal. For a **REVERSE**, re-proof means I3-REV
only.

**Three worker outcomes, not two:**

| condition | outcome |
|---|---|
| transient prerequisite unavailable (a guard returns a reason) | **HELD** — typed non-throwing return; claim released; **zero attempts**; `nextActionAt` advanced |
| POST whose source is permanently cancelled/reversed | **TERMINAL** — matches existing cancellation-helper semantics (deletion), no GL write |
| REVERSE | validate the original event/obligation only; never the domain source |

⚠️ **A held outcome must not throw** — a throw would roll back the claim release
and re-dispatch forever. ⚠️ **And it must not be a `catch`** — §3.2 forbids that.
It is a **return value**, mirroring `postPendingEntry:189-196`, which already
returns `null` rather than throwing for "no accounting consequence".

⚠️ A guard may itself **throw** on malformed data. `drainEntries:1142-1152`
already treats a throwing guard as a per-entry failure; that behaviour is
preserved and belongs to the **observer**, never to a catch inside the worker.

### 3.4 Failure bookkeeping — the scheduled-function observer

Store `scheduledFunctionId` on the attempt; the observer reads
`ctx.db.system.get(...)`:

| scheduler state | action |
|---|---|
| `pending` / `inProgress` | observe again later; **spend nothing** |
| `failed` / `canceled` | record one curated failure, release with backoff |
| **absent / `null`** ⚠️ | **observed worker failure** — release the claim, record failure, back off, dead-letter at the ceiling |
| `success` while still claimed | **throw** — an invariant violation that must fail visibly |

⚠️ **The absent-record branch is new and load-bearing.** The previous revision
listed only three branches, and §5 says an unknown outcome is re-observed and
never re-dispatched — so a lost or expired scheduler record would re-observe
forever and strand the row permanently. The precedent already handles this: in
`observeAuthorityAttempt:707-741` the `scheduled &&` guards let a null record fall
through to `attemptStatus = "FAILED"` and release. **I under-copied the pattern I
was citing; this restores it.**

Never persist a raw scheduler error string — `state.error` is a backend stack
trace (`observeAuthorityAttempt:731-737` logs it server-side only).

Duplicate execution after uncertain delivery is made safe by the generation guard
plus posting/reversal idempotency (§3.6).

**Rejected alternative, recorded:** an internal action awaiting the worker call
and invoking a recorder. Both seats independently preferred the observer: an
action can catch a worker rejection and then die before invoking the recorder,
leaving nothing durable, and it cannot replace due-time recovery.

### 3.5 Every invocation site of `drainEntries` — enumerated from the CALLEE

⚠️ **Method matters, and is stated so it can be re-run.** The previous revision
enumerated the callers a *review* had named and asserted exhaustiveness; a fourth
existed. This enumeration is a repo-wide grep of the **callee** across all `.ts`:

| invocation site | reached by | disposition |
|---|---|---|
| `accountingOutbox.ts:1192` (`drainPendingForOrg:1182`) | `claimsRetirement.test.ts:332` only | **RETIRED — see below** |
| `accountingOutbox.ts:1233` (`drainPageAndContinue:1221`) | `drainPendingAccountingEvents:1284` (cron/internal) and `redrive:1322` (operator) | cut over |
| `prepaidExpenses.ts:690` (`redriveScheduleEvents:643`) | operator | cut over, see §3.5.1 |

Every other repo hit is the definition (`:1101`), an import
(`prepaidExpenses.ts:52`), or a comment. **After retirement there are exactly two
invocation sites.**

**Falsifier, stated deliberately:** any new call site of `drainEntries` invalidates
this table. The verification floor carries a repo assertion so the class cannot
recur silently.

**`drainPendingForOrg` is retired.** Its only direct invocation is
`claimsRetirement.test.ts:332`; it has **no cursor and no pass budget**, so it also
lacks the starvation protection `drainPageAndContinue` exists to provide. Keeping
a second, strictly-less-safe entry point to the same defect class is the drift that
produced this finding. The test is pointed at the surviving entry point, and
`retryFailed`'s doc comment at `:1342` — which currently reads *"call
redrive/drainPendingForOrg after"* — is updated.

#### 3.5.1 Redrive must become durable, and must stop reporting false success

⚠️ `redriveScheduleEvents` passes FAILED rows as an **in-memory clone**:

```
prepaidExpenses.ts:688   matches.map(row => row.status === "FAILED" ? { ...row, attempts: 0 } : row)
                 :690   return await drainEntries(ctx, toDrain);
```

The reset is **never persisted**. It works only because `drainEntries` posts
inline in the same mutation. A worker that re-reads storage sees the original
`FAILED` row with exhausted attempts and refuses it — **the redrive button would
silently stop working.**

Required for **both** redrive doors: **persist** the FAILED→PENDING reset, clear
stale claim metadata, **advance the generation**, set the row due, then
exact-schedule the stored row.

⚠️ **Result semantics change.** Both mutations currently return `posted/failed/held`
counts as though posting finished, and the UI renders that as completion
(`components/accounting/PrepaidExpensesTab.tsx`,
`components/accounting/AccountingSetupTab.tsx`). Under async dispatch those counts
are a **lie**. They become **accepted/scheduled** counts and must read **"retry
queued"**, never "posting completed", with UI copy and i18n updated to match.

Prepaid **source-debit-first ordering** becomes eventual rather than synchronous;
dependent rows must remain held until the source posts, which the existing guard
enforces and §3.3 keeps enforcing in the worker.

### 3.6 At-most-once, and per-row isolation

Two independent defences: the claim/generation guard (a superseded attempt returns
without writing) and `postAccountingEvent`'s idempotency on `idempotencyKey` and
on `(eventType, sourceType, sourceId, eventVersion)` (`postingEngine.ts:100-118`
returns `alreadyPosted` rather than reposting).

⚠️ `eventVersion` occurrence semantics are unchanged (`workflowHooks.ts:141-149`).

Per-row isolation becomes **stronger**: each row gets its own transaction rather
than sharing one behind a catch.

---

## 4. Schema — `status` is NOT touched

`pendingAccountingEvents.status` keeps exactly `PENDING` / `FAILED` / `POSTED`.
A row stays **`PENDING`** from enqueue until the worker atomically flips it to
`POSTED`, or the observer dead-letters it to `FAILED`.

> **Execution metadata is not an accounting outcome.**

Claim state lives in **new optional fields** on the same row: `dispatchState` ·
`generation` · `activeAttemptId` · `scheduledFunctionId` · `nextActionAt`, plus a
due-work index. All optional and additive: no existing row changes, no existing
reader changes. A "claimed" row is simply a `PENDING` row carrying an unexpired
active attempt — the shape `commitmentAuthorityWork`'s `by_status_next_action`
index already serves.

### 4.1 The semantic matrix — audit by FIELD AND TABLE, never by expression

⚠️ Round 1 required enumerating readers of `status === "PENDING"`. **Six real
readers do not contain that substring** (`for (const status of
["PENDING","FAILED"] as const)`). A search expression is a discovery aid, never a
proof of completeness.

**Class A — status-agnostic. Safe by construction; require NO change.**

```
accountingOutbox.ts:57,99   enqueuePendingPost / Reversal        presence (.unique)
accountingOutbox.ts:134,163 cancelPendingPostByKey / BySource    !== POSTED
workflowHooks.ts:83         postOrEnqueue pre-check              kind POST && !== POSTED
workflowHooks.ts:1308,1391  commission check / queuedEntryStatus neq(POSTED)
expenses.ts:105 · payroll.ts:496 · commissionSourceLedger.ts:160
accountingMigration.ts:608,655 · migrateConsignedSaleBasis.ts:240
vehicles.ts:948 · orgSettings.ts:171  (by_org_status, orgId only)
```

**Class B — exact status equality; each would break if a fourth literal existed.**

```
accountingPeriods.ts:332,340    close checklist            <- would stop blocking close
workflowHooks.ts:2426           prepaid reversal cleanup   <- would post for a REVERSED source
vehicles.ts:1028                provenAcquisitionEvidence  <- false negative
accountingOutbox.ts:1063        markEntryFailed            <- ⚠️ CORRECTED, see below
accountingSetup.ts:102          Setup pending list
accountingReports.ts:1234,1239  commission controls
reports.ts:416                  GL-state projection
prepaidExpenses.ts:666,1357     redrive / listSchedules
prepaidRecognitionEvents.ts:201,230
accountingOutbox.ts:1189,1233   drain selectors (this ticket's own)
accountingOutbox.ts:1310        listPending (operator UI)
```

**Class C — lifecycle / structural, no status predicate.**

```
adminOrgs.ts:61          ORGANIZATION_DELETION_STEPS   by_org_status
orgFinancialReset.ts:50  RESET_TABLES
schema.ts:391            commitmentAuthorityWork.pendingEventId  (FK; "PROVENANCE, NEVER A DECISION INPUT")
accountingSetup.ts:22    Id<> in a returned shape
Doc<> helpers: accountingOutbox.ts:195,216,231,336,1088,1103 ·
               accountingReports.ts:1170 · prepaidExpenses.ts:656,662 ·
               prepaidRecognitionEvents.ts:218
```

⚠️ **Two classification errors from the previous revision, corrected and marked
rather than quietly fixed:**

1. `markEntryFailed:1063` re-reads the row and requires exact `status !==
   "PENDING"` before recording a failure. It was filed under Class C `Doc<>`
   helpers; it is **Class B**. Under this design it is unaffected — the enum never
   changes — but the classification was wrong.
2. `prepaidSourceLedger.ts:78` is a **comment**, not a `Doc<>` annotation, and is
   removed from the Class C bucket. Its safety conclusion stands: the function
   reads `eventType` / `accountingDate` / `payload`, never `status`.

**Class B has fourteen sites.** Teaching fourteen readers a fourth status — and
proving no fifteenth exists — is strictly worse than never changing the enum.
**§4 makes Class B empty by construction.**

⚠️ **A semantic matrix beats a grep and still requires adversarial checking.**
This one shipped with two mis-classifications. It is published as evidence the
surface was examined semantically, not as a guarantee of infallibility.

### 4.2 ⚠️ The Convex index question — REQUIRED REAL-RUNTIME GATE

Owner ruling: a missing optional field behaves as `undefined` for index/filter
semantics; `q.eq("field", undefined)` matches documents where the field is absent;
`undefined` sorts before `null` and ordinary values. **Therefore a legacy row with
no `nextActionAt` is index-representable and no data backfill is required merely
to make old rows visible.**

⚠️ **`convex-test` alone will NOT certify our compound query.** This repository
has documented precedent for simulator/runtime divergence: `convex-test` did not
enforce Convex's one-paginated-query-per-function limit, and a backfill cleared
2,115 tests, full CI and thirteen adversarial review rounds before failing on its
first production call.

**Binding gate (`c17356`):** after DESIGN approval and before implementation is
accepted, run **the exact selector** against a **genuinely legacy-shaped row**
(the `nextActionAt` field completely absent — not `null`, not `0`) on a **real
non-production Convex deployment**, and record the result.

```
real legacy-shaped row, nextActionAt COMPLETELY ABSENT
        -> the ACTUAL proposed selector query, on a real dev deployment
        -> the row is returned as due
```

If it is not returned, the design needs a sentinel or a backfill — and backfill is
a §8 non-goal that returns to owner-proxy.

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
scheduled references. Fields-on-the-row avoid this entirely and are preferred.

---

## 5. State transitions

⚠️ `accountingOutboxSweep.test.ts:117-151` is an **existing regression** for the
starvation class: 55 held rows ahead of 5 valid ones, asserting the held rows burn
**zero attempts**. A due sweep whose held branch only patches `lastError` leaves
those rows immediately due forever, so every tick re-selects them.

| From | Event | To |
|---|---|---|
| PENDING, unclaimed, due | selector claims | PENDING + active attempt, observation deadline set |
| claimed | worker posts | **POSTED**, atomic with the journal, **claim metadata cleared** |
| claimed | guard returns a reason (transient) | **PENDING**, claim released, **zero attempts**, `nextActionAt` advanced |
| claimed | POST source permanently cancelled | **terminal** per I3-POST; no GL write |
| claimed | worker throws | rolled back; observer records the attempt, backs off, releases |
| claimed | observation deadline passes, outcome unknown | **the sweep re-observes** — never dispatches a second worker |
| claimed | scheduler record **absent** | observed failure → release, back off, dead-letter at the ceiling (§3.4) |
| PENDING | attempts reach MAX_ATTEMPTS | **FAILED**, dead-lettered, **claim metadata cleared**, `retryFailed` can revive it |

⚠️ **A held row must advance `nextActionAt`**, or it starves the queue.
⚠️ **The sweep must select due *claimed* rows for observation**, or a lost
observer strands a row permanently.
⚠️ **Both terminal transitions clear claim metadata** (mirroring
`blockAuthorityWork`, which writes `activeAttemptId: undefined`).

### 5.1 Latency and liveness are different mechanisms

* **Eager dispatch targets the EXACT row.** N receipts must never produce N
  cursorless org-wide sweeps.
* **Liveness is a fixed tick over `nextActionAt`**, like `dispatch-authority-work`
  (`crons.ts:115-120`, every minute). `markEntryPosted:309-315` and
  `crons.ts:103-110`: *"retry LIVENESS comes from `dispatchDueAuthorityWork`
  reading `nextActionAt`, never from accounting traffic."*
* **Recovery must not depend on a period reopen or chart init.** Today
  `drainPendingAccountingEvents` is scheduled only from `accountingPeriods.ts:285`
  (open), `:696` (**reopen**) and `chartOfAccounts.ts:571` (chart init), plus its
  own pagination continuation — confirmed exhaustive by both seats.
* Losing an eager schedule costs **latency only**, never liveness.
* Work per tick must be **bounded**; ordering must not let one org starve others.

⚠️ **`drainPageAndContinue`'s cursor and `MAX_DRAIN_PASSES` self-continuation are
preserved WHOLESALE.** Only the per-row leaf action changes: post-inline becomes
claim-and-schedule. This is stated rather than left as inference because a
freshly-unblocked backlog (a reopened period with thousands of held rows) drains
via that near-zero-delay continuation chain, and a 1-minute global tick alone
would be a latency regression.

### 5.2 Manual retry

`retryFailed:1358` today patches exactly `{ status: "PENDING", attempts: 0,
lastError: undefined }`. Under this design it must additionally **clear stale
attempt/scheduler metadata and advance the generation**, so a revived row is
**immediately** selector-eligible rather than reading as claimed. Its
authorization (`MANAGE_FINANCE`), its FAILED-only precondition and its "does not
itself post" contract are unchanged — but its doc comment, which names the retired
`drainPendingForOrg`, is updated.

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
11. a **legacy-shaped** row (no new fields) still posts — **plus §4.2's real-runtime gate**
12. a held row burns no attempts; a failing row reaches `FAILED` and `retryFailed` finds it
13. **claimed POST whose source is cancelled** → the cancellation helper deletes the row **and the stale worker writes nothing** (I3-POST)
13b. **queued REVERSE for each producer family still posts** although its domain source is cancelled (I3-REV)
14. a **claimed row still blocks period close** and still appears in every outstanding-work projection (I2)
15. **starvation beyond one page** — modelled on `accountingOutboxSweep.test.ts:117-151`; valid rows post, held rows burn zero attempts
16. **lost observer** → the due sweep re-observes and recovers; no permanently claimed row
17. **caller matrix** — both redrive doors: persisted FAILED reset, generation advanced, exact-row scheduling, truthful **accepted/scheduled** result, authorization preserved, duplicate click safe
18. **missing `_scheduled_functions` record** → observed failure, claim released, backoff applied, dead-letters at the ceiling; **not** perpetual observation
19. **`retryFailed` on a row carrying stale claim metadata** → selected by the "unclaimed, due" query on the **very next tick**, not merely eventually
20. **repo assertion**: `drainEntries` has no invocation site outside the cut-over set (§3.5's falsifier)

⚠️ Fault injection must be a **real throw from inside the posting path**. A seam
that *returns* an error cannot reproduce a transaction defect.

⚠️ `convex-test` **serializes everything and models no OCC**, so case 5's
*true-concurrency* half is unprovable there; what it proves is duplicate/sequential
delivery and the claim guard. It **does** model `_scheduled_functions`, which is
what cases 9, 16 and 18 need. True concurrency requires a real Convex runtime.

## 7. Absence mutants

**Every killer either exists on `bf5769ed1` or is required by this document.**

| Mutant | Killed by | Killer |
|---|---|---|
| catch the posting exception inside the worker | 1, 2, 10 | required §3.2 |
| mark the row POSTED before the journal is complete | 1, 2, 3 | required §3 |
| the failure recorder shares the financial transaction | 1, 2, 7 | required §3.4 |
| call the worker inline instead of scheduling it | 1, 2 | required §3.1 |
| skip the business guards in the worker | 13 | required §3.3 |
| make the held outcome throw instead of returning | 12, 13 | required §3.3 |
| **apply source-invalidation to a REVERSE row** | **13b** | **required §2 I3-REV** |
| **omit the missing-scheduler-record branch** | **18** | **required §3.4** |
| add a claimed literal to `status` | 13, 14 | required §4 |
| drop the claim/generation guard | 5, 6 | required §3.6 |
| cut over only the cron caller | 17 | required §3.5 |
| **leave `drainPendingForOrg` reachable** | **20** | **required §3.5** |
| keep the in-memory FAILED clone | 17 | required §3.5.1 |
| **report posted/failed counts from an async redrive** | **17** | **required §3.5.1** |
| org-wide sweep per receipt instead of exact-row dispatch | 8 | required §5.1 |
| remove the due-work sweep, keeping only eager dispatch | 9 | required §5.1 |
| **drop the cursor / pass budget from the sweep** | **15** | **required §5.1** |
| hold without advancing `nextActionAt` | 15 | required §5 |
| sweep selects only unclaimed rows | 16 | required §5 |
| **terminal transition leaves claim metadata** | **19** | **required §5, §5.2** |
| selector skips rows with absent `nextActionAt` | 11 | required §4.2 |
| route a held row through the attempt counter | 12 | exists (`markEntryHeld:1088` vs `markEntryFailed:1060`) |
| fix POST only, leave REVERSE on the caught path | 10 | required §1.3 |

## 8. Non-goals

The SCRUM-218 receipt split · the 2110 account · `collectionPayloadVersion` ·
`accountingMigration`'s durable refusal (**SCRUM-223**) · SCRUM-208's
commitment/authority model beyond the transaction-boundary pattern · a generic
workflow/job engine · provider ingress · refunds · **production migration or
backfill** (see §4.2 — if the real-runtime gate forces one, that returns to
owner-proxy).

## 9. What reviewers are asked to attack

Whether §3 yields a real rollback boundary on **both** kinds · whether any
financial write can still occur inside a catch · whether I3's kind-split is
correct and complete, and whether I3-REV's re-proof is sufficient · whether the
observer's four branches cover every scheduler state · whether §3.5's
callee-derived enumeration is right and whether retiring `drainPendingForOrg`
breaks anything · whether §4.1's corrected matrix is now accurate · whether §5's
transitions prevent starvation, permanent claims and stale-metadata revival ·
whether §4.2's gate is stated strongly enough · every §7 killer · drift into §8.

**Terminal rule restated:** both seats must APPROVE. Any BLOCK, HIGH or CRITICAL
ends SCRUM-222 design iteration.

## 10. Known-unresolved, carried forward rather than hidden

* whether `payrollPostingBlockedReason` and `commissionPostingBlockedReason` carry
  the same post-claim source-invalidation exposure the prepaid guard does — §3.3
  covers all three by construction, but the reproduction exists only for prepaid;
* the real Convex behaviour behind §4.2, until the gate is actually run;
* true-concurrency behaviour of claim-versus-cancel and claim-versus-close, which
  `convex-test` structurally cannot certify.
