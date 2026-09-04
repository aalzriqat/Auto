# SCRUM-223 r2 — Retire the legacy collection-payment migration writer

**Bounded correction round, authorized by owner-proxy `c17421` and reaffirmed by `c17457`/`c17460`.**
This is the *one* correction that ruling permits. It is not an autonomous loop.

| | |
|---|---|
| Branch | `agent/scrum-223-retire-legacy-collection-writer` |
| Base | `bf5769ed1` — protected main, exactly |
| Worktree | `E:\tmp\auto-scrum223` (isolated; no `node_modules` junction) |
| Supersedes | `design/scrum223/00-retire-legacy-collection-writer.md` @ `39753c802` — **frozen failed evidence, preserved unchanged** |
| Evidence boundary | every `file:line` below **read on this branch at `bf5769ed1`** |
| Review seats | Sonnet MAX + Codex `high` |
| Status | design only — no implementation, merge, deploy, migration, activation or production mutation |

**Independent of PR #273.** `convex/accountingMigration.ts` is byte-identical on `bf5769ed1` and
`5f88808df`; SCRUM-222 never touched it.

---

## §0 Disposition of the r1 review — finding and proposed fix on separate axes

Both seats returned REQUEST CHANGES on `39753c802`. Every finding was reproduced against the real
file at the real line; **none was rejected.** Two dispositions differ from what r1 or its reviewers
proposed, and both differences are the owner-proxy's ruling, not mine:

| # | Finding | Finding | Proposed fix |
|---|---|---|---|
| F1 | `RETIRED` rows burn the posting budget forever; no cursor ⇒ other categories permanently unreachable | **ACCEPTED** | **SUPERSEDED** — §1 removes the budget entirely rather than exempting one literal |
| F2 | Retired rows permanently block `signOffCutover` | **ACCEPTED** | **REJECTED by `c17421` §2** — see §4 |
| F3 | r1's K2 contradicted its own §2 (hooks build the gross shape today) | **ACCEPTED** | ADOPTED — §6 |
| F4 | The mapper has a second consumer (`classifyLegacyTransaction`) | **ACCEPTED** | ADOPTED — §3 |
| F5 | No `retired` counter; unbounded duplicate audit rows on retry; raw `err.message` to a public caller | **ACCEPTED** | ADOPTED — §5, §7 |
| F6 | K4 overclaimed audit-log *retrieval* | **PARTIALLY CONFIRMED** — storage is adequate, retrieval is separate debt | ADOPTED as a narrowing — §5.3 |
| F7 | r1 §1 attributed the `MIGRATE_TRANSACTION` write at `:831` to the opening-balance function | **ACCEPTED — my own factual error** | Corrected: it is `auditLogForMigration` (`:820-837`), a Phase-17 backfill helper. The conclusion held — that helper is unreachable from `migrateUnpostedTransactions`, which ends at `:392` |

> **F1's lesson, recorded because it is the recurring defect class in this programme.**
> Splitting one fate into two breaks every consumer that enumerated the old set. r1 split `RETIRED`
> out of `UNMAPPED` *for truthfulness, correctly* — and the loop's budget predicate
> (`accountingMigration.ts:293`) exempts exactly one literal, `"SKIP"`. This is the mirror image of a
> residual subtraction merging two fates: merging hides one, **splitting silently invalidates every
> predicate keyed on the old partition.** After adding a variant, grep every switch, filter and
> counter over that value's space.

---

## §1 The starvation fix — the page *is* the budget, so there is no budget to starve

### 1.1 What is wrong at `bf5769ed1`

```ts
// :275-279  fixed prefix, re-read from zero on every invocation
const txns = await ctx.db.query("transactions")
  .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
  .take(limit * 10);
// :293  one literal is exempt from the budget
for (const tx of txns) { if (results.filter((r) => r.action !== "SKIP").length >= limit) break;
```

Two independent mechanisms, and **both** must go. Exempting `RETIRED` from `:293` fixes neither: with
no cursor the mutation re-reads the same bounded prefix every call, so once that prefix is fully
classified nothing beyond it is ever reachable. The failure is **absolute, not slow.**

### 1.2 The corrected contract

Adopt the resumable-cursor discipline already in this file at
`backfillVehicleInventoryOpeningBalances` (`:524-556`), whose own comment at `:529-532` states this
exact rationale: *"a plain `.take()` re-scans the same fixed prefix every call and can never reach
vehicles beyond it once that prefix is fully skipped/posted."*

```ts
args: { orgId, limit?, dryRun?, cursor: v.optional(v.union(v.string(), v.null())) }

const page = await ctx.db.query("transactions")
  .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
  .paginate({ numItems: limit, cursor: args.cursor ?? null });

for (const tx of page.page) { /* EVERY row inspected and classified — no early break */ }

return { dryRun, posted, wouldPost, skipped, retired, unmapped, failed, results,
         nextCursor: page.continueCursor, isDone: page.isDone };
```

**Invariant P1 — no mid-page break, ever.**
`paginate` yields **one** `continueCursor` for the whole page. Breaking mid-page and returning that
cursor would silently skip every unprocessed row after the break point — converting starvation into
*silent data loss*, which is strictly worse than the defect being repaired. The loop therefore has no
early exit at all.

**Invariant P2 — the page size is the posting budget.**
Because at most `limit` rows are *inspected*, at most `limit` can post. The separate actionable-work
counter at `:293` is deleted outright. This satisfies `c17421` §1's *"RETIRED consumes zero posting
budget"* **structurally rather than by exemption**: no row class can consume another's opportunity,
because there is no shared budget to consume. A future variant added to the disposition union cannot
reintroduce starvation, which the exemption approach could not promise.

**Invariant P3 — monotonic progress.**
Every call advances exactly one page regardless of page composition; `isDone` terminates the walk. An
all-`RETIRED` page still advances.

`limit` changes meaning from *actionable-row budget* to *page size* (cap unchanged at 200). That is a
public API semantics change and is declared, not smuggled: §9 requires the existing callers be
re-read against it.

---

## §2 ⚠️ The production-only hazard this design must not walk into

**`convex-test` does not enforce Convex's one-paginated-query-per-function limit.** This is not
speculative in this repository: a backfill cleared 2,115 tests, full CI, thirteen adversarial review
rounds and a CodeRabbit full-branch review, then failed on its **first production call** for exactly
this reason.

`migrateUnpostedTransactions` calls, inside the same function invocation:

```text
ensurePartnerEquityAccounts   (:287, non-dryRun)
ensureClaimAccounts           (:288, non-dryRun)
postAccountingEvent           (:365, per posted row)
auditLog                      (new, per retired row — §5)
```

If **any** of those contains or later gains a `.paginate()`, this mutation acquires a second
paginated query, every test still passes, and it dies on the first real invocation.

**Required, and it cannot be discharged by the test suite:**

1. A static assertion that the transitive call tree of `migrateUnpostedTransactions` contains
   **exactly one** `.paginate()` — the one in §1.2.
2. A **real runtime invocation against a preview deployment**, recorded with its output. Repository
   validation is not runtime validation; passing against `convex-test` establishes only that the code
   runs under the harness.

The in-file precedent (`:553`) shows a single `.paginate()` inside a `mutation` is an accepted shape
here. It does **not** establish that this call tree has only one — that is what item 1 proves.

---

## §3 One shared migration disposition classifier

`c17421` §3: do not enrich the mapper for one caller and leave another to reinterpret it.

```ts
export type MigrationDisposition =
  | { kind: "MAPPED"; eventType: MigratableEventType }
  | { kind: "UNMAPPED" }                                        // no rule ever existed
  | { kind: "RETIRED_COLLECTION"; category: string; reason: string };  // withdrawn under v2

export function classifyMigrationCategory(category: string, type: "IN" | "OUT"): MigrationDisposition
```

`mapCategoryToEventType` (`:41-69`) is replaced by this single pure function. **Every** consumer reads
the same value:

| Consumer | Use |
|---|---|
| `migrateUnpostedTransactions` (`:311`) | drives `action`, budget-free per §1 |
| `classifyLegacyTransaction` (`:86`) → `auditLegacyTransactions` (`:113`) | renders `RETIRED_COLLECTION` **distinctly** from `UNMAPPED` and from already-migrated |
| `signOffCutover` (`accountingCutover.ts:806`) | **read-only, reason string only** — never to relax the gate (§4) |

`LegacyTransactionRow.eventType: string | null` (`:38`) becomes disposition-carrying. **A changed
return shape is cross-surface by construction**, so §9 requires both typecheck scopes; the root
script excludes `convex/`, and `typecheck:convex` excludes `components/`. Neither alone is total.

**Blast radius measured, not assumed:** `auditLegacyTransactions` has **no UI consumer** — ripgrep
across the worktree (excluding `node_modules`) returns only `convex/accountingPhase6.test.ts:136,215,243`
and `docs/architecture/accounting-implementation-progress.md:470`. The docs line also states the
superseded `limit * 5` / `limit * 10` scan behavior and must be updated with §1.

`CLAIM_PAYMENT` remains `UNMAPPED` (SCRUM-51, `:54-68`) — it was never mapped under v2, so it is not
a retirement and must not be relabelled as one.

---

## §4 Legacy `signOffCutover` stays fail-closed — my proposed fix was rejected

r1 proposed teaching `signOffCutover` to count `RETIRED` as disposed. **`c17421` §2 rejects that**,
and the rejection is correct: it would weaken an existing monetary gate to accommodate a workflow
being retired from v2 launch.

The mechanism, verified at the real lines:

```ts
// accountingCutover.ts:814-818   counts ALL active legacy transactions
// :824-826                       credits only POSTED accounting events
// :839-842                       throws, explicitly non-overridable
```

A retired collection row is active and never POSTED, so it reads as an unresolved migration failure
forever.

**Binding disposition:**

```text
legacy signOffCutover  -> remains fail-closed for active rows lacking legacy POSTED proof
                       -> must NOT count RETIRED as MIGRATED
SCRUM-231 clean slate  -> the sole v2 go-live route; deletes current test/demo legacy rows
```

The successor states explicitly that invoking legacy sign-off against a dataset containing retired
collection rows is **unsupported and fail-closed**, and directs the operator to the SCRUM-231
clean-slate cutover. `signOffCutover` may consult §3's classifier **only** to make its refusal
message truthful — naming retired rows as retired rather than as "still unmigrated" — without
changing `unmigratedTransactionCount`, the throw at `:839-842`, or any count feeding it.

`accountingPhase17.test.ts:327-355` remains a **positive control**: it must keep passing unmodified.
A successor that inverts it has weakened the gate.

**Real Jira relationship exists:** SCRUM-223 **blocks** SCRUM-231. Prose is not the dependency record.

---

## §5 Exactly-once durable retirement evidence

### 5.1 The gap the existing helper does not close

`auditLog` (`financialAudit.ts:72-90`) **accepts an `idempotencyKey` and never reads it** — it is a
bare `ctx.db.insert`. Passing a key therefore buys nothing. The index
`by_org_action_idempotency` (`schema.ts:791`, `["orgId","actionType","idempotencyKey"]`) exists and
is referenced **nowhere else in `convex/`** — declared, unused.

So exactly-once is a **read-before-insert in the retirement path**, not a parameter:

```ts
const key = `retire_collection_v1_${tx._id}`;          // deterministic from the source row
const prior = await ctx.db.query("financialAuditLog")
  .withIndex("by_org_action_idempotency", (q) =>
     q.eq("orgId", orgId).eq("actionType", "RETIRE_MIGRATION_CATEGORY").eq("idempotencyKey", key))
  .first();                                             // NOT .unique()
if (!prior) await auditLog(ctx, { ..., idempotencyKey: key });
```

`.first()` rather than `.unique()` is deliberate: a duplicate makes `.unique()` throw *before* the
caller can recover, so an idempotency probe built on it is poisoned by the very partial write it
exists to survive.

That `auditLog` is not exactly-once for its **existing** callers is pre-existing, out of scope, and
recorded here rather than fixed (adversarial-review policy 5).

### 5.2 The action type is `RETIRE_MIGRATION_CATEGORY`, not `MIGRATE_TRANSACTION`

Reusing `MIGRATE_TRANSACTION` would be F1's defect one table over: a retirement is not a migration,
and collapsing them makes the audit trail lie.

⚠️ **Action types are declared in TWO places and both must change:** `schema.ts:741-779` (the
`v.union` of literals) and `financialAudit.ts:18-68` (the `AuditActionType` union). Changing one is a
drift trap.

⚠️ **Merge hotspot, declared:** `schema.ts` is also modified by SCRUM-222 (`bf5769ed1..5f88808df`).
Regions differ — SCRUM-222 touches outbox fields, this touches the `financialAuditLog` union near
`:778` — but the file collides. **#273 merges first; this branch rebases onto it, never the reverse.**

### 5.3 Scope of the evidence claim (narrowed per F6)

Claimed: **durable, indexable, exactly-once storage** of each retirement, resolvable by
`(orgId, actionType, idempotencyKey)`.
**Not** claimed: a complete historical query surface. `listAuditLog` (`financialAudit.ts:120`) has no
cursor or resource lookup and caps its window; broader audit retrieval is separate debt and is not
load-bearing for this ticket.

Written only on `dryRun: false`. Written **even though nothing posted** — that is the point. Creates
no journal, no accounting event, no v2 collection authority.

---

## §6 The retirement itself, and the narrowed completeness claim

`COLLECTION_PAYMENT` becomes **unconstructible** for that category at the classifier — the same
structural retirement `CLAIM_PAYMENT` already received (`:54-68`, SCRUM-51). No flag, no version gate
at the call site, no legacy rule behind a v2 switch. `:346-348` becomes dead and `:365` can never be
reached with that event type.

**The only claim this ticket makes** (`c17421` §4):

> `migrateUnpostedTransactions` can no longer originate a legacy/gross `COLLECTION_PAYMENT` event.

It does **not** claim no runtime old-shape collection event exists anywhere. r1's K2 claimed that and
**contradicted r1's own §2**: `makeCollectionHook` (`workflowHooks.ts:810-829`) builds the gross-only
payload today and never consults the mapper, and the outbox replays it verbatim. Closure is
conjunctive across three tickets:

```text
SCRUM-223 -> migration producer retired
SCRUM-218 -> v2 consumer/payload authority; old gross shape not accepted as v2 authority
SCRUM-231 -> zero pre-v2 queued/legacy state at activation
```

`PAYMENT_LINK_RECEIVED` stays out: it appears **nowhere** in `accountingMigration.ts`, and
`classifyMigrationCategory` has no branch producing it. **There is no migration writer for it to
retire** — stated so a future session does not hunt for a door that does not exist.

`accountingLedger.post` (`accountingLedger.ts:169`) has **zero production callers** — only
`internal.accountingLedger.post` in tests. It is `internalMutation`, so closed by construction today,
but takes `eventType: v.string()` and `payload: v.any()`, making it an unbounded old-shape minter the
moment anything calls it. Covered by the writer-inventory test (§8 item 10). ⚠️
`docs/architecture/accounting-implementation-progress.md:302` calls it *"the public surface"* — false;
doc-only, recorded not fixed.

---

## §7 Truthful results and stable public errors

- Distinct `retired` and `unmapped` counters. An all-retired page must not report four zeroes as
  though nothing was examined.
- `action: "RETIRED"` is never counted in `posted` or `wouldPost`.
- `:379-382` currently returns `err.message` to a public caller. Replace with a **stable
  operator-facing code**; log the raw error server-side via `console.error` and keep detail in the
  audit record. This is the standing repository rule: log raw server-side, return generic.
- `dryRun: true` stays fully read-only — no audit row, no event, no patch.

---

## §8 Evidence floor — failing-first

`c17421` §6's list, plus four items this packet adds (11–14).

```text
 1  50+ retired rows before a valid EXPENSE -> the EXPENSE row is reached via cursor
 2  all-retired page -> retired > 0; posted/wouldPost truthful; cursor advances
 3  exact retirement replay -> exactly ONE durable audit identity
 4  UNMAPPED stays distinguishable from RETIRED in response and audit
 5  auditLegacyTransactions renders RETIRED distinctly from UNMAPPED and migrated
 6  legacy signOffCutover with a retired active row -> still fails closed, stable truthful reason
 7  clean unrelated legacy dataset -> existing signOffCutover behavior byte-unchanged
 8  writer inventory -> no migration producer of PAYMENT_LINK_RECEIVED
 9  migration writer -> cannot construct COLLECTION_PAYMENT after retirement
10  writer-inventory test fails if a new runtime collection-event writer appears
    (covers accountingLedger.post gaining a production caller)
11  hook old-shape producer -> explicitly NOT claimed closed by this ticket
12  raw-error mutant -> public caller receives a stable code; detail retained server-side
13  dryRun: true -> writes nothing at all
14  positive controls, every one still migrates: EXPENSE_POSTED · DEPOSIT_RECEIVED/REFUNDED ·
    SALE_COMPLETED · PARTNER_DREW · CAPITAL_CONTRIBUTED · VEHICLE_ACQUIRED, plus the Phase-17
    backfills (:407, :439, :465, :524) and the opening-balance path (:757)
```

**Required mutants (each must fail before the fix and be killed after):**

```text
M1  reintroduce the actionable-budget break        -> item 1 fails (starvation returns)
M2  break mid-page and return continueCursor       -> rows after the break are silently skipped
M3  drop the cursor arg, restore take(limit*10)    -> item 1 fails
M4  collapse RETIRED_COLLECTION into UNMAPPED      -> items 4 and 5 fail
M5  count RETIRED as migrated in signOffCutover    -> item 6 fails (gate weakened)
M6  omit the read-before-insert idempotency probe  -> item 3 fails (duplicate audit rows)
M7  reuse MIGRATE_TRANSACTION as the action type   -> item 3's identity is not isolable
M8  make the audit row response-only               -> item 3 fails (no durable record)
```

M2 is the mutant that proves Invariant P1, and no existing test would catch it — it is the failure
mode this correction could most easily introduce while appearing to fix F1.

**Cannot be discharged by tests, per §2:** the single-`.paginate()` proof and a recorded preview-
deployment invocation.

**Existing callers to re-read against the changed `limit` semantics and return shape:**
`accountingPhase6.test.ts:157,182,188` · `accountingPhase12.test.ts:336` ·
`accountingPhase13.test.ts:167` · `accountingPhase17.test.ts:327,343` ·
`accountingPhase18.test.ts:127,175`. `accountingPhase6.test.ts:182-188` invokes the mutation twice
and its expectations are sensitive to §1.

---

## §9 Completeness claims, as named refutation targets with falsifiers

Framing claims as falsifiable targets refuted three of five in r1 and three of six on SCRUM-218 r3,
so it is repeated deliberately. **"Confirmed correct" is not a useful answer.**

**K1 — the five production `postAccountingEvent` call sites are complete at `bf5769ed1`**
(`workflowHooks.ts:118` · `accountingOutbox.ts:199` · `accountingLedger.ts:169` ·
`accountingMigration.ts:365` · `:775`). Measured by ripgrep over `convex/` excluding `*.test.ts`.
**Find a sixth** — dynamic dispatch, a re-export, an action invoking a mutation by string reference,
or a scheduled function.

**K2 (narrowed from r1, which overclaimed) — after §6, `migrateUnpostedTransactions` cannot
originate a `COLLECTION_PAYMENT` event.** Scoped to this mutation only. **Find a construction path
that still reaches `postAccountingEvent` with that event type from within this mutation.**

**K3 — `PAYMENT_LINK_RECEIVED` has no migration or admin producer.** Zero matches in
`accountingMigration.ts`. **Find one.**

**K4 — §1's cursor guarantees monotonic progress for every page composition.** **Find an input
where a row is inspected twice, or never** — an equal-key ordering collision under `by_org`, a row
inserted or deleted mid-walk, a cursor invalidated between calls, or a page whose processing throws
after a partial write. *(Note the Convex commit rule: a caught exception still commits writes already
made; only an uncaught throw rolls back — so the `:379` catch is inside this attack surface.)*

**K5 — the §3 classifier's three consumers are all of them.** **Find a fourth reader of
`mapCategoryToEventType`'s value, or of `LegacyTransactionRow.eventType`,** in `convex/`, `app/`,
`components/` or the mobile app.

**K6 — §5's read-before-insert is exactly-once under retry.** **Find an interleaving that writes two
rows** for one transaction id, given `convex-test` serializes and models no OCC — say so explicitly if
the property is unprovable in this harness rather than treating it as passed.

---

## §10 Explicitly forbidden

No `appliedMinor = amountMinor` default · no deriving authority from mutable receivable outstanding ·
no calling a legacy posting rule behind a v2 flag · no reconstructing v2 receipt authority from legacy
gross rows · no wholesale disabling of the migration subsystem · no weakening `signOffCutover` · no
second payload-version discriminator (that is SCRUM-218's, and two would drift) · no pre-activation
legacy scanner (retired SCRUM-224's job; clean slate deletes those rows — recorded as a SCRUM-231
cutover precondition). SCRUM-166 and SCRUM-188 are **not** absorbed: same file, different mechanisms.

## §11 Boundary

Design only. No implementation, protected-main merge, production deployment, Accounting activation,
production reset/delete/migration/backfill/restatement, real provider or refund operation, secret
disclosure, or irreversible live action. `accountingLedger.post` stays `internalMutation`.
`39753c802` remains frozen failed evidence. PR #273 untouched at `5f88808df` and must not be rebased.

**`c17421` §7 circuit breaker remains binding.** If either seat returns a new CRITICAL/HIGH showing
retired rows can starve unrelated migration, the migration writer can still originate
`COLLECTION_PAYMENT`, retirement is indistinguishable or ephemeral on a real invocation, or this
correction weakens an unrelated monetary control — **stop and return to owner-proxy. No further
autonomous correction round.**
