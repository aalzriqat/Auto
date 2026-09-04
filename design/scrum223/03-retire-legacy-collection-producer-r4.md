# SCRUM-223 r4 — Retire the legacy collection producer. Final narrow round.

**Authorized by owner-proxy `c17513`** after r3 `38d69007` took Sonnet MAX (1 CRITICAL / 1 HIGH / 1
factual error) and Codex `high` (2 MEDIUM / 3 LOW / 1 INFO). `c17513` is binding on scope: nine items,
no more. **If r4 takes another HIGH/CRITICAL in its owned core, there is no r5.**

**This is the first contract written under `SCRUM-49 c17523` — the enumeration rule.** Every absence
or completeness claim below carries its enumeration in **§8**, or is written as `NOT ESTABLISHED`.
No `file:line` is attributed to a surface it was not read on.

| | |
|---|---|
| Branch | `agent/scrum-223-retire-legacy-collection-writer` |
| Base | `bf5769ed1e2d793f953b5f894223859b235ca21e` — protected main, exactly |
| Supersedes | `00-…md` @ `39753c802` (r1) · `01-…-r2.md` @ `0679acb52` (r2) · `02-…-r3.md` @ `38d69007` (r3) — **all frozen failed evidence, preserved unchanged** |
| Evidence boundary | every `file:line` **read on `bf5769ed1`**. Verified: `git diff bf5769ed1..HEAD -- convex/ app/ components/ apps/ scripts/ lib/` is **empty**, so this worktree's code tree *is* the base tree; the only changed files are the three design documents above |
| Review seats | Sonnet MAX + Codex `high` |
| Status | design only — no implementation, merge, deploy, activation or production mutation |

---

## §0 Dispositions from the r3 review

| Finding | Finding | Proposed fix |
|---|---|---|
| **Sonnet CRITICAL** — live cross-family double-post in `migrateUnpostedTransactions` | **ACCEPTED** | **NOT APPLICABLE here** — owned by **SCRUM-234**. See §7.3 for the one thing r4 legitimately says about it |
| **Sonnet HIGH** — §2 mischaracterised the `CLAIM_PAYMENT` precedent | **ACCEPTED** | **ADOPTED** — §1 |
| **Sonnet factual** — "six files", five listed | **ACCEPTED** | **ADOPTED and enumerated** — it is five files / ten call sites, §8.1 |
| **Codex MEDIUM-01** — eager chart setup precedes classification | **ACCEPTED** | **SUPERSEDED by ruling** — `c17513` assigns it to **SCRUM-235**; r4 must not reorder it. §4 narrows r4's claim instead of fixing the code |
| **Codex MEDIUM-02** — the proposed Phase-17 surgery destroys the only case that could catch M4 | **ACCEPTED** | **ADOPTED (Codex Option A)** — §5 |
| **Codex LOW** — J2 "byte-unchanged" is false as phrased | **ACCEPTED** | **ADOPTED** — §3 |
| **Codex LOW** — "cannot starve anything" is broader than the fixed scan permits | **ACCEPTED** | **ADOPTED** — §3.3 |
| **Codex LOW** — the dual representation is not type-coupled | **ACCEPTED** | **ADOPTED** — §2 |

Nothing was rejected.

---

## §1 The retirement — and the precedent claim, corrected

`COLLECTION_PAYMENT` becomes **unconstructible** at the category mapper.

⚠️ **r3 §2 called this *"the same structural retirement `CLAIM_PAYMENT` already received."* That was
wrong, and my own r2 had warned against exactly this relabelling.** `CLAIM_PAYMENT` returns `null`
(`accountingMigration.ts:54-68`), and a `null` lands in the **generic** `no_rule_for_category` bucket.
So the precedent does **not** produce the distinguishable reason §2 promises — it produces the
opposite.

**What r4 actually does:** the mapper returns a **discriminated disposition**, and
`RETIRED_COLLECTION` is a distinct member from `UNMAPPED` — a *different* mechanism from
`CLAIM_PAYMENT`'s, not the same one. `CLAIM_PAYMENT` is cited only as evidence that **retiring a
category from this mapper is an established, owner-sanctioned move**, which is all it supports.

Whether `CLAIM_PAYMENT` should also be upgraded to a distinguishable disposition is **out of scope**
and not claimed either way.

---

## §2 One retirement truth, type-coupled, serving migration and audit

`c17513` requires the *same* retirement truth in both the migration mutation and the audit query.
Codex's LOW additionally requires the representation be type-coupled so `eventType`, the disposition,
the raw reason string and a reason-derived counter cannot drift.

```ts
type MigrationDisposition =
  | { kind: "MAPPED"; eventType: MigratableEventType }
  | { kind: "UNMAPPED" }
  | { kind: "RETIRED_COLLECTION" };

// ONE exhaustive projector. Nothing else derives these fields independently.
function projectDisposition(d: MigrationDisposition): {
  eventType: MigratableEventType | null;      // unchanged SHAPE — see §8.2
  disposition: MigrationDisposition["kind"];  // additive
  reason: "retired_under_v2" | "no_rule_for_category" | null;
}
```

Binding consequences:

* **The reason string is not free text.** It is produced only by `projectDisposition`, so a
  reason-derived counter cannot disagree with the disposition.
* **`mapCategoryToEventType` is renamed** — it no longer returns an event type. `classifyLegacyCategory`.
  Its name was becoming a claim about its return — a helper's name is a claim, not a definition, and
  this programme has already been bitten by that once.
* **Both consumers call the same projector.** `migrateUnpostedTransactions` (`:311`) and
  `classifyLegacyTransaction` (`:86`) — the two sites enumerated in §8.3 — so retirement cannot be
  re-interpreted one function away.
* **`retired` is a RETURNED field**, not a local. Stated explicitly because r3 left it ambiguous and
  Codex asked. It is additive to the existing return shape.

---

## §3 What changes in the traversal — stated precisely, not as "unchanged"

### 3.1 The r1 defect, which r4 must not re-introduce

```ts
// accountingMigration.ts:293 — the page budget
if (results.filter((r) => r.action !== "SKIP").length >= limit) break;
```

r1 gave retired rows `action: "RETIRED"`. That is not `"SKIP"`, so retired rows consumed budget
forever, starving every other category. **The defect was changing the field the budget keys on.**
r4 keeps `action: "SKIP"` and distinguishes only via `reason` and `disposition`, which the budget does
not read.

### 3.2 ⚠️ "Byte-unchanged" was false — the honest statement

r3 §3.1 said the traversal, page semantics and return shape are *"byte-unchanged."* **Codex refuted
that and it is refuted correctly.** What is true, precisely:

```text
UNCHANGED   the budget predicate at :293 (still keys on action !== "SKIP")
            the scan query and its limit * 10 window at :275-279
            the already-posted check at :296-304
            auditLegacyTransactions' hasMore / scannedCount / postedCount / unpostedCount  (§8.4)

CHANGED, INTENTIONALLY
            a formerly-MAPPED collection row now takes the SKIP branch, so
              - the loop performs MORE iterations before the budget fills
              - `results` contains more rows
              - `posted` / `wouldPost` decrease and `skipped` increases for any org holding
                legacy COLLECTION_PAYMENT rows
            the return shape gains `retired` and each row gains `disposition`
```

Those counter movements are the *point* of the retirement, not a regression. Stating them is what r3
failed to do.

### 3.3 The starvation claim, narrowed honestly

r3's E4 said retired rows "cannot starve anything." **Too broad.** `:275-279` takes a fixed
`limit * 10` window, so a full prefix of retired *or* already-unmapped rows can hide later mapped rows
on **every** invocation. That is **pre-existing fixed-window behaviour**, it is not introduced by
retirement, and under `c17513` it **does not justify a cursor**.

The honest claim, and the only one r4 makes:

> Within the scanned `limit * 10` window, retiring `COLLECTION_PAYMENT` does not reduce the number of
> **mapped** rows that migrate, because retired rows take the same `SKIP` branch that unmapped rows
> already take and the budget predicate is unchanged.

Anything about rows *outside* the window is **NOT ESTABLISHED** and is not claimed.

---

## §4 No durable audit row — and the claim r4 does *not* make

r4 retains r3's decision: no durable retirement record. The refusal is truthful **to the caller** via
`action: "SKIP"` + `reason: "retired_under_v2"` + `disposition: "RETIRED_COLLECTION"`; every row it
would describe is deleted by SCRUM-231 before activation.

⚠️ **Codex MEDIUM-01, accepted, and the claim narrowed rather than the code changed.** When
`dryRun === false`, `accountingMigration.ts:286-289` runs `ensurePartnerEquityAccounts` and
`ensureClaimAccounts` **before** the classification loop at `:292`. So a live call encountering only
retired rows may still **write chart-of-account rows**, or **throw** a `ConvexError` from
`chartOfAccounts.ts:227-256` on a code conflict, and never return the retirement disposition at all.

`c17513` assigns that to **SCRUM-235** and forbids r4 from reordering it. Therefore r4's §7 obligation
3 is restated with its real scope:

```text
CLAIMED      the retired door creates ZERO accounting-event / journal / allocation / outbox delta
NOT CLAIMED  that a live retired-only call is side-effect free. It may initialise chart accounts,
             or fail on a pre-existing chart conflict, BEFORE classification runs.  -> SCRUM-235
```

The trade-off on forensics is unchanged from r3 §4 and remains overrulable: the smallest safe
re-addition is one `financialAuditLog` row under a **new** action type, which re-opens three r2
findings — which is why it is not the default.

---

## §5 Phase-17 fixtures — Codex Option A, because r3's version killed its own mutant

`accountingPhase17.test.ts` seeds `category: "COLLECTION_PAYMENT"` at **both** `:341` (positive) and
`:360` (negative). **r3 proposed reseeding both with `EXPENSE`.**

⚠️ **That would have left no test anywhere containing a retired collection row**, so mutant **M4**
(treating retirement as sufficient migration proof) would survive with both tests green — and r3 §7
claimed "M4 → E7 fails." **That claim was false.** Codex found it; I accept it.

Worse, `:362` **deliberately skips migration** (`// Deliberately skip migrateUnpostedTransactions.`),
so the negative control proves sign-off refuses an *unmigrated* row — never a *retired* one. It is
already tautological with respect to retirement, and r3's change would have made that permanent.

**r4 adopts Codex Option A:**

```text
:338-355  POSITIVE control -> reseed with a MAPPED category (EXPENSE).
                              It posts one transaction-sourced event and signs off, proving
                              exactly what it always claimed to prove.

:357-367  NEGATIVE control -> KEEPS its COLLECTION_PAYMENT fixture, and additionally
                              CALLS migrateUnpostedTransactions({ dryRun: false }),
                              asserts SKIP / retired_under_v2 / RETIRED_COLLECTION,
                              THEN asserts signOffCutover still rejects.
```

That converts a tautology into the exact clean-slate proof this ticket owes: **running the retired
door cannot make a collection row sign-off-ready.** `signOffCutover` production semantics are
untouched — it stays fail-closed and `RETIRED` is never counted as migrated.

---

## §6 The narrow claim

> `migrateUnpostedTransactions` can no longer originate a legacy/gross `COLLECTION_PAYMENT`
> accounting event.

Not that no old-shape collection event exists anywhere at runtime. Closure is conjunctive:
**SCRUM-223** (this migration producer) · **SCRUM-236** (the live synchronous `hookCollectionPayment`
producer) · **SCRUM-237** (canonical occurrence identity) · **SCRUM-218** (v2 consumer/payload
authority) · **SCRUM-231** (zero pre-v2 state).

⚠️ Carried forward from r3 and still correct: `accountingLedger.post` (`accountingLedger.ts:152-169`,
`eventType: v.string()`, `payload: v.any()`) is **closed to clients, not closed by construction** — an
`internalMutation` is unreachable from a client but runnable by an operator via dashboard or CLI. It
remains a generic privileged producer door and retiring it is **not absorbed here**.

`PAYMENT_LINK_RECEIVED` stays out: **NOT ESTABLISHED that it has any migration writer** — see §8.5,
which enumerates rather than asserts.

---

## §7 Proof obligations, evidence floor, mutants

### 7.1 `c17498` / `c17513` obligations

```text
1  the legacy collection migration producer cannot emit COLLECTION_PAYMENT under v2
   -> the mapper cannot construct it; :346-348 unreachable; failing-first test
2  a v1/gross collection payload cannot become v2 receipt authority
   -> SCRUM-218/236/237. NOT claimed here. Stated split, not silence.
3  the retired door returns a stable operator-facing refusal
   -> SKIP + retired_under_v2 + RETIRED_COLLECTION, distinct from no_rule_for_category
   -> SCOPED by §4: zero GL delta is claimed; side-effect freedom is NOT (SCRUM-235)
4  the refusal creates zero GL/economic delta
   -> assert `removed` as well as `added`, so a cancelled pending post cannot read as "no effect"
5  retry does not create unbounded duplicate evidence      -> N/A, r4 writes no durable evidence
6  SCRUM-231 zero-state proof                              -> recorded as its precondition, not built
```

### 7.2 Evidence floor

```text
E1  legacy COLLECTION_PAYMENT row -> SKIP / retired_under_v2 / RETIRED_COLLECTION,
    zero accountingEvents, zero journal lines, zero allocations, zero outbox rows.
    ⚠️ MUST pass dryRun: false explicitly — :268 defaults dryRun to TRUE
E2  RETIRED_COLLECTION and UNMAPPED remain distinguishable in the mutation response AND in
    auditLegacyTransactions — the one-projector requirement of §2
E3  positive controls still migrate: EXPENSE_POSTED · DEPOSIT_RECEIVED/REFUNDED · SALE_COMPLETED ·
    PARTNER_DREW · CAPITAL_CONTRIBUTED · VEHICLE_ACQUIRED, and the Phase-17 backfills still run
E4  within the scanned limit*10 window, a page of retired rows does not reduce the number of
    MAPPED rows that migrate                                            <- narrowed per §3.3
E5  existing eventType readers pass UNCHANGED (accountingPhase6.test.ts:142, :244 — §8.2)
E6  dryRun: true writes nothing
E7  Phase-17 :338-355 signs off on its new MAPPED fixture; :357-367 RUNS migration on a
    COLLECTION_PAYMENT row, gets the retired disposition, and signOffCutover STILL rejects
E8  the counter movements of §3.2 are asserted, not merely tolerated: for an org holding legacy
    COLLECTION_PAYMENT rows, `skipped` rises and `posted`/`wouldPost` fall by the same count
```

### 7.3 SCRUM-234 — cross-ticket regression evidence, without absorbing it

`c17513` permits using SCRUM-234's double-post fixture as regression evidence. The precise, bounded
statement:

```text
E9  a modern receipt created through recordPayment, followed by
    migrateUnpostedTransactions({ dryRun: false }), produces NO second COLLECTION_PAYMENT
    accounting event — because the category is retired at the mapper.
```

⚠️ **E9 does not close SCRUM-234, and r4 does not claim it does.** SCRUM-234 is the *dedupe-blindness
class*: the migration's already-posted check queries `sourceType: "transactions"` while the real event
is sourced elsewhere. Retirement removes the **collection instance** of that class; it does nothing
for **SCRUM-188**, the same class for `SALE_COMPLETED` / `VEHICLE_SALE`, and it does nothing before
r4 is implemented. SCRUM-234 remains open on its own terms and is not absorbed.

### 7.4 Required mutants

```text
M1  give retired rows a non-SKIP action           -> E4 fails   (r1's exact HIGH, re-armed)
M2  collapse RETIRED_COLLECTION into UNMAPPED     -> E2 fails
M3  leave COLLECTION_PAYMENT in the mapper        -> E1, E9 fail
M4  count RETIRED as migrated in signOffCutover   -> E7 fails   <- only kills under §5's fixture
M5  derive `reason` outside projectDisposition    -> E2 fails   (the drift Codex named)
```

**M4 is the mutant r3 claimed to kill and did not.** Under §5's corrected fixture it is killed,
because a retired row is actually present in a sign-off test.

---

## §8 ENUMERATIONS — mandatory under `SCRUM-49 c17523`

Every claim here states the surface, the method, the candidate set, the classification of each
candidate, and why the set is closed.

**Surface for all of §8:** `bf5769ed1e2d793f953b5f894223859b235ca21e`. Verified as this worktree's
code tree by `git diff --stat bf5769ed1..HEAD -- convex/ app/ components/ apps/ scripts/ lib/`
returning **empty**; the only files differing from base are the three `design/scrum223/*.md`
documents.

### 8.1 Callers of `migrateUnpostedTransactions` — **five files, ten call sites, zero production callers**

*Method:* whole-worktree literal search for `migrateUnpostedTransactions`, excluding only `design/**`
(which contains no code). Every hit classified:

```text
convex/accountingMigration.ts:258                        the definition
convex/accountingPhase6.test.ts:157, :182, :188, :228    4 call sites
convex/accountingPhase12.test.ts:336                     1
convex/accountingPhase13.test.ts:167                     1
convex/accountingPhase17.test.ts:327, :343               2
convex/accountingPhase18.test.ts:127, :175               2
convex/accountingPhase17.test.ts:362                     NOT a call site — a comment,
                                                         "Deliberately skip migrateUnpostedTransactions."
docs/architecture/accounting-implementation-progress.md:473, :501   documentation, not a caller
```

*Why the set is closed:* the search covered every file in the worktree; a caller of a Convex mutation
must name it as `api.accountingMigration.migrateUnpostedTransactions`, so a literal match on the
function name is exhaustive for call sites. **`app/`, `components/` and `apps/` produced zero hits** —
there is no UI, server-action or mobile caller.

⚠️ **Corrects r3 §8, which said "six files" and listed five. It is five files and ten call sites.**

⚠️ **Surfaced only by doing the enumeration, and named by neither review seat:**
`docs/architecture/accounting-implementation-progress.md:473` documents the mapper as handling
`COLLECTION_PAYMENT`. **r4 makes that line stale** and it must be updated with the retirement, or the
repository's own architecture doc will contradict the code.

### 8.2 Readers of `auditLegacyTransactions` / `LegacyTransactionRow.eventType` — **three call sites, all tests**

*Method:* whole-worktree literal search for `auditLegacyTransactions`, excluding `design/**`.

```text
convex/accountingMigration.ts:113                the definition
convex/accountingPhase6.test.ts:136, :215, :243  3 call sites — the ONLY readers
docs/architecture/accounting-implementation-progress.md:470   documentation, not a reader
```

*Why the set is closed:* same argument as §8.1 — a query consumer must name
`api.accountingMigration.auditLegacyTransactions`. Zero hits in `app/`, `components/`, `apps/`.

*Consequence:* the assertions at `accountingPhase6.test.ts:142` and `:244` read
`rows[0].eventType`, so §2's projector must keep `eventType`'s **shape** (string for MAPPED, `null`
otherwise) — which it does. `disposition` is additive, so those assertions do not change.

### 8.3 Consumers of the category classifier — **two**

```text
convex/accountingMigration.ts:311   migrateUnpostedTransactions
convex/accountingMigration.ts:86    classifyLegacyTransaction (feeding auditLegacyTransactions)
```

*Method:* literal search for `mapCategoryToEventType` within `convex/accountingMigration.ts`, the
file that defines it; it is not exported, so no cross-file consumer is possible. That non-export is
what closes the set — **and it is also why the §2 rename is safe.**

### 8.4 Fields of `auditLegacyTransactions`' return that r4 does *not* change

`hasMore`, `scannedCount`, `postedCount`, `unpostedCount`. *Method:* these are computed from the
POSTED/unposted classification and the scan window, neither of which r4 touches. **Codex independently
reached the same conclusion on r3.** Two independent derivations, stated as such rather than as one
assertion repeated.

### 8.5 A migration writer for `PAYMENT_LINK_RECEIVED` — **NOT ESTABLISHED, and not needed**

r3 asserted *"it appears nowhere in `accountingMigration.ts`, so there is no migration writer for it
to retire."* Under `c17523` that phrasing overreaches: absence from one file does not establish
absence of a migration writer.

**What is established:** `migrateUnpostedTransactions` maps only the categories the classifier
enumerates, and `PAYMENT_LINK_RECEIVED` is not among them — so **this mutation** cannot originate it.
**What is NOT established:** that no other migration-shaped producer exists anywhere. r4 does not need
that stronger claim, and does not make it. SCRUM-236 owns the live payment-link producer question,
and its own §6 records that payment-link's production source identity is `paymentIntents`.

---

## §9 Refutation targets

**J1 — after §1, `migrateUnpostedTransactions` cannot originate `COLLECTION_PAYMENT`.** Scoped to this
mutation. **Find a construction path within it.** Codex found none on r3 and noted the residual cast
member should be deleted as dead authority-bearing code; r4 deletes it.

**J2 — §3.2's changed/unchanged split is exactly right.** Not "nothing changes" — r3 said that and was
refuted. **Find a predicate, counter, filter, returned field or caller that moves and is not in the
CHANGED list**, or one listed as CHANGED that does not actually move.

**J3 — §8's enumerations are closed.** ⚠️ **This is the target that matters most, because §8 is the
first use of the new rule.** For each of §8.1–§8.5: **find a candidate the method could not reach** —
a dynamic dispatch, a re-export, a string built at runtime, a generated client, a non-`convex/`
surface I did not search. If the method cannot reach it, the set is not closed and the claim must
become NOT ESTABLISHED.

**J4 — §5's corrected fixture actually kills M4.** **Show M4 surviving** under the proposed
`:357-367`, or show the change breaking another Phase-17 assertion.

**J5 — E9 is bounded correctly.** **Argue that r4 either over-claims** (implying SCRUM-234 is closed)
**or under-claims** (retirement removes more of 234's exposure than E9 states).

**J6 — §4's narrowed obligation-3 scope is honest.** **Find a GL/economic delta** a retired-only live
call can still produce that §4 does not disclose — beyond the chart-account writes routed to
SCRUM-235.

"No additional item found, **and here is how I looked**" is useful. "Confirmed correct" is not.

---

## §10 Explicitly not built

No migration of current rows · no cursor/checkpoint engine · no eager-account-setup reorder
(**SCRUM-235**) · no attempt to make Phase-17 legacy sign-off succeed on retired rows · no
preservation of queued collection events through cutover · no backfill, restatement or production
history repair · no weakening of `signOffCutover` · no second payload-version discriminator
(SCRUM-218/237) · no pre-activation legacy scanner (SCRUM-231 deletes those rows) ·
`accountingLedger.post` untouched · **SCRUM-234 and SCRUM-188 are not absorbed** · SCRUM-166 not
absorbed.

**Alternative considered and not recommended:** retiring the whole `migrateUnpostedTransactions` door.
`c17498` permits it and under clean slate no legacy row needs migrating — but it breaks five test
files (§8.1) and forces a maintenance split for the other categories, which is wider than the
narrowest safe boundary. Recorded so the choice is visible.

## §11 Boundary

Design only. No implementation, protected-main merge, production deployment, Accounting activation,
production reset/delete/migration/backfill/restatement, provider or refund operation, or irreversible
live action. `39753c802`, `0679acb52` and `38d69007` remain frozen failed evidence. Protected main
`bf5769ed1`. PR #273 untouched at `5f88808df` and not rebased — **r4 touches no `schema.ts`**, so this
branch remains independent of #273 in fact as well as in principle.

**`c17513` circuit breaker:** if r4 receives another HIGH or CRITICAL in its owned core, **there is no
r5** — stop and return to owner-proxy.
