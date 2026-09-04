# SCRUM-223 r3 — Retire the legacy collection producer. Nothing else.

**Bounded closure design under owner-proxy `c17498` (clean-slate re-narrowing).**
`c17498` supersedes the `c17421` six-point contract wherever the two differ.

| | |
|---|---|
| Branch | `agent/scrum-223-retire-legacy-collection-writer` |
| Base | `bf5769ed1` — protected main, exactly |
| Supersedes | `00-…md` @ `39753c802` (r1) and `01-…-r2.md` @ `0679acb52` (r2) — **both frozen failed evidence, preserved** |
| Evidence boundary | every `file:line` **read on this branch at `bf5769ed1`** |
| Review seats | Sonnet MAX + Codex `high` |
| Status | design only — no implementation, merge, deploy, activation or production mutation |

**This document is deliberately short.** r2 failed by growing into a migration engine for records that
are about to be deleted. A long r3 would repeat that mistake in a different direction.

---

## §1 What `c17498` changed, and what that does to the r2 findings

The binding scope is now only:

```text
after v2 integration/activation
-> no callable production path may originate legacy/gross COLLECTION_PAYMENT authority
-> attempted use of a retired legacy collection migration door must fail truthfully
-> no GL/economic effect may be created from that legacy collection row
```

SCRUM-223 is **not** responsible for making current data migrate. Every r2 finding is therefore
either **dissolved by the ruling** or **retained**, and nothing is carried forward on my own judgment:

| r2 finding | Now |
|---|---|
| **C-02** cursor conflates *inspected* with *disposed* (Codex HIGH) | **DISSOLVED — there is no cursor in r3.** `c17498` forbids designing a durable cursor/checkpoint system for these rows |
| **H-01** retirement write not failure-isolated (Sonnet HIGH) | **DISSOLVED — r3 writes nothing per row.** §4 drops the durable audit row; `c17498` makes it conditional (*"if durable audit is retained"*) |
| **C-01** §4 required a Phase-17 test that §6 makes impossible (Codex HIGH) | **RETAINED and now resolvable.** `c17498` makes "making Phase-17 legacy sign-off succeed on retired collection rows" an explicit **non-goal**, so the fixture changes — §5 |
| **K3 refuted** — `accountingLedger.post` is closed *to clients*, not "closed by construction" | **RETAINED** — §6 wording corrected |
| **K5 refuted** — tests read `LegacyTransactionRow.eventType` | **RETAINED and designed around** — §3.2 keeps that field's shape |
| **STD-01/STD-02** raw detail in a publicly-readable audit row; `.first()` vs `.unique()` | **DISSOLVED with the audit row** (§4) |
| **M-01** K6 needed a runtime-concurrency caveat | **DISSOLVED — no write, no race** |

Five of seven blockers disappear because the *scope* was wrong, not because the engineering was
patched. That is the ruling working as intended.

---

## §2 The retirement

`COLLECTION_PAYMENT` becomes **unconstructible** at the category mapper — the same structural
retirement `CLAIM_PAYMENT` already received (`accountingMigration.ts:54-68`, SCRUM-51, whose comment
cites the owner's disposable-data ruling). If the mapper cannot produce the event type, `:346-348` is
dead and `:365` can never be reached with it.

This is the **narrowest safe boundary**, and it sits before any old-row traversal is asked to prove
anything: the traversal's semantics are not touched at all (§3).

---

## §3 Why r3 needs no cursor, and cannot starve anything

### 3.1 The r1 defect, stated exactly

```ts
// accountingMigration.ts:293 — the page budget
if (results.filter((r) => r.action !== "SKIP").length >= limit) break;
```

r1 introduced `action: "RETIRED"`. That is **not** `"SKIP"`, so every retired row consumed budget
forever, and with no cursor the same prefix was re-read on every call — starving every other
category absolutely.

🔴 **The defect was changing the field the budget keys on.** The fix is to change a field that
**nothing** keys on:

```ts
// retired rows stay in the SKIP family; only the REASON distinguishes them
results.push({ transactionId, action: "SKIP", eventType: null, reason: "retired_under_v2" });
// vs the existing
results.push({ transactionId, action: "SKIP", eventType: null, reason: "no_rule_for_category" });
```

Truthfulness — the legitimate goal of r1's split — is fully served by the distinct `reason`. An
operator can tell *"a rule existed and was withdrawn"* from *"this category was never supported."*
The budget predicate, the traversal, the page semantics and the return shape are **byte-unchanged**.

**Consequences, all of them:** no cursor · no `paginate` (so §2 of r2's one-`.paginate()` hazard
evaporates) · no new starvation surface · no change to `limit` semantics · no change to any existing
caller's expectations except §5's fixture.

A `retired` count is derived from the reason (`results.filter(r => r.reason === "retired_under_v2")`),
requiring no new action literal.

### 3.2 The classifier, shaped to keep K5's readers working

`mapCategoryToEventType` returns a discriminated disposition internally:

```ts
type MigrationDisposition =
  | { kind: "MAPPED"; eventType: MigratableEventType }
  | { kind: "UNMAPPED" }
  | { kind: "RETIRED_COLLECTION" };
```

`classifyLegacyTransaction` (`:71-109`) derives **both** fields from it:

```text
eventType    unchanged shape: the string for MAPPED, null otherwise   <- existing readers keep working
disposition  the new discriminant                                     <- additive
```

This is deliberate. Codex refuted r2's K5 with `accountingPhase6.test.ts:142` and `:244`, which assert
`rows[0].eventType === "EXPENSE_POSTED"`. Keeping `eventType`'s shape means **those assertions do not
change**, and `auditLegacyTransactions` renders retirement distinctly via the additive field. The
same one classifier serves `migrateUnpostedTransactions:311` and `classifyLegacyTransaction:86`, so
retirement cannot be re-interpreted one function away.

---

## §4 No durable audit row — stated as a decision, not an omission

`c17498` makes durable retirement evidence conditional (*"if durable audit is retained…"*). r3 does
**not** retain it:

- The refusal is truthful **to the caller** via `reason: "retired_under_v2"` in the response, which is
  what the launch-path obligation asks for.
- Every row it would describe is deleted by SCRUM-231 before activation, so the record's only reader
  is a dataset that will not exist.
- It carried three of r2's findings (H-01 isolation, STD-01 raw detail in a publicly-readable row,
  STD-02 `.first()` vs `.unique()`), all of which are pure launch-path cost for disposable data.

**Trade-off stated so it can be overruled:** nothing durably records *who attempted* a retired
migration. If that matters for operator forensics, the smallest safe re-addition is one
`financialAuditLog` row with a **new** action type (never `MIGRATE_TRANSACTION`), written inside its
own `try/catch` mirroring `:336`, using `.unique()` on `by_org_action_idempotency` — and that
re-opens exactly the three findings above, which is why it is not the default.

---

## §5 The Phase-17 fixture changes — now an authorized non-goal

`accountingPhase17.test.ts:338-355` seeds a `COLLECTION_PAYMENT` at `:341`, migrates at `:343`, then
asserts `migratedTransactionCount === 1` (`:347`) and `unmigratedTransactionCount === 0` (`:348`).
After retirement that row never posts, `signOffCutover` computes `unmigratedTransactionCount === 1`
and throws at `accountingCutover.ts:839-842`. **r2 required this test to pass unmodified while making
that impossible.**

`c17498` lists *"making Phase-17 legacy sign-off succeed on retired collection rows"* as an explicit
**non-goal**, so the resolution is a fixture change, not a production change:

```text
:338-355  positive control -> reseed with a MAPPED category (EXPENSE). It posts one
                              transaction-sourced event, unmigratedTransactionCount === 0,
                              and the test proves what it always claimed to prove.
:357-365  negative control -> ALSO seeded with COLLECTION_PAYMENT, and it deliberately skips
                              migration. After retirement it would reject even if migration HAD
                              run, so it stops testing its own premise. Reseed it with a MAPPED
                              category too, so the refusal is still caused by "not migrated".
```

⚠️ `:357-365` was raised by neither review seat; it is mine. A negative control that passes for the
wrong reason is worse than one that fails.

**`signOffCutover` production semantics are untouched.** It remains fail-closed for active rows
lacking POSTED proof; `RETIRED` is never counted as migrated; SCRUM-231 is the sole v2 go-live route.

---

## §6 The narrow claim, and the correction K3 forced

**The only claim r3 makes:**

> `migrateUnpostedTransactions` can no longer originate a legacy/gross `COLLECTION_PAYMENT` event.

Not that no runtime old-shape collection event exists anywhere. Closure is conjunctive:
SCRUM-223 (producer) · SCRUM-218 (v2 consumer/payload authority) · SCRUM-231 (zero pre-v2 state).

⚠️ **Corrected from r1/r2, where I said it twice:** `accountingLedger.post`
(`accountingLedger.ts:152-169`, `eventType: v.string()`, `payload: v.any()`) is **closed to clients,
not "closed by construction."** An `internalMutation` is unreachable from a client but **runnable by
an operator through the Convex dashboard or CLI**, subject to `requireTenantAuth`. It therefore
remains a generic privileged producer door. Retiring or constraining it is **explicitly not absorbed
here** — it is a separate authority review.

`PAYMENT_LINK_RECEIVED` stays out: it appears nowhere in `accountingMigration.ts`, so there is no
migration writer for it to retire.

---

## §7 Proof obligations — `c17498`'s list, mapped

```text
 1  legacy collection migration producer cannot emit COLLECTION_PAYMENT under v2
    -> mapper cannot construct it; :346-348 unreachable; failing-first test
 2  v1/gross collection payload cannot become v2 receipt authority
    -> SCRUM-218's consumer side. NOT claimed here. Stated split, not silence.
 3  retired door returns a stable operator-facing refusal if still callable
    -> action "SKIP", reason "retired_under_v2", distinct from "no_rule_for_category"
 4  refusal creates zero GL/economic delta
    -> zero accountingEvents, zero journal lines, zero allocations; assert `removed` as well
       as `added` so a cancelled pending post cannot read as "no GL effect"
 5  retry does not create unbounded duplicate evidence
    -> N/A: r3 writes no durable evidence (§4)
 6  SCRUM-231 zero-state proof removes pre-v2 queued/legacy rows before activation
    -> recorded as a SCRUM-231 precondition; NOT built here
```

**Evidence floor:**

```text
E1  legacy COLLECTION_PAYMENT row -> SKIP/retired_under_v2, zero events, zero journal lines
E2  RETIRED and UNMAPPED remain distinguishable in the response and in auditLegacyTransactions
E3  positive controls: EXPENSE_POSTED · DEPOSIT_RECEIVED/REFUNDED · SALE_COMPLETED · PARTNER_DREW ·
    CAPITAL_CONTRIBUTED · VEHICLE_ACQUIRED still migrate, and the Phase-17 backfills still run
E4  a page of retired rows does NOT reduce the number of other rows that migrate   <- kills r1's HIGH
E5  existing eventType readers (accountingPhase6.test.ts:142, :244) pass UNCHANGED
E6  dryRun: true writes nothing
E7  Phase-17 :338-355 and :357-365 pass on their new MAPPED fixtures; signOffCutover still
    fails closed for an unmigrated row
```

**Required mutants:**

```text
M1  give retired rows a non-SKIP action        -> E4 fails (this is r1's exact HIGH, re-armed)
M2  collapse RETIRED_COLLECTION into UNMAPPED  -> E2 fails
M3  leave COLLECTION_PAYMENT in the mapper     -> E1 fails
M4  count RETIRED as migrated in signOffCutover-> E7 fails
```

M1 is the important one: it is a permanent regression test for the defect r1 introduced.

---

## §8 Refutation targets

**J1 — after §2, `migrateUnpostedTransactions` cannot originate `COLLECTION_PAYMENT`.** Scoped to
this mutation only. **Find a construction path within it.**

**J2 — §3.1 changes no traversal, budget or completion semantics whatsoever.** Retired rows take the
`"SKIP"` action that today's unmapped rows already take. **Find any predicate, counter, filter or
caller whose behaviour changes** — including `hasMore`, the four summary counters, and every test in
§7 E3.

**J3 — §3.2 keeps `LegacyTransactionRow.eventType`'s shape, so no existing reader breaks.** **Find a
reader that still breaks**, in `convex/`, `app/`, `components/` or the mobile app.

**J4 — dropping the durable audit row leaves no `c17498` obligation unmet.** **Argue the opposite**
if an operator genuinely cannot resolve a retired attempt from the response alone.

**J5 — the Phase-17 fixture change is the whole of the required test surgery.** **Find another test
that a retired `COLLECTION_PAYMENT` category breaks** — six files call this mutation
(`accountingPhase6/12/13/17/18.test.ts`, incl. `accountingPhase6.test.ts:228`).

"No additional item found, and here is how I looked" is useful. "Confirmed correct" is not.

---

## §9 Explicitly not built (from `c17498`)

No migration of current production/test rows · no durable cursor/checkpoint engine · no attempt to
make Phase-17 legacy sign-off succeed on retired rows · no preservation of old queued collection
events through cutover · no backfill or restatement · no weakening of `signOffCutover` · no second
payload-version discriminator (SCRUM-218 owns it) · no pre-activation legacy scanner (SCRUM-231
deletes those rows) · `accountingLedger.post` untouched. SCRUM-166/188 are not absorbed.

**Alternative considered and not recommended:** retiring the whole `migrateUnpostedTransactions` door
for v2. `c17498` permits it, and under clean slate no legacy row needs migrating at all — but it
breaks six test files and forces a maintenance split for the other categories, which is *wider* than
the narrowest safe boundary the ruling asks for. Recorded so the choice is visible, not silently made.

## §10 Boundary

Design only. No implementation, protected-main merge, production deployment, Accounting activation,
production reset/delete/migration/backfill/restatement, provider or refund operation, or irreversible
live action. `39753c802` and `0679acb52` remain frozen failed evidence. PR #273 untouched at
`5f88808df`. ⚠️ **r3 no longer touches `schema.ts`** (no new action type), so the SCRUM-222 merge
collision declared in r2 §5.2 **no longer applies** — this branch is now independent of #273 in fact
as well as in principle.
