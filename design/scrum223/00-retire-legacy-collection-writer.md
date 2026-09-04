# SCRUM-223 — Retire the legacy collection-payment migration writer

**Design packet, round 1.** Authorized by owner-proxy `c17413`.

| | |
|---|---|
| Branch | `agent/scrum-223-retire-legacy-collection-writer` |
| Base | `bf5769ed1` — protected main, exactly |
| Worktree | `E:\tmp\auto-scrum223` (isolated; no `node_modules` junction) |
| Evidence boundary | every file:line below **read on this branch at `bf5769ed1`** |
| Review seats | Sonnet MAX + Codex `high` |
| Status | design only — no merge, deploy, migration, activation or production mutation |

**Independent of SCRUM-218 and of PR #273.** `convex/accountingMigration.ts` is **byte-identical** on
`bf5769ed1` and `5f88808df` (`git diff --stat` empty), and SCRUM-222 never touched it. This branch can
merge without waiting on #273.

---

## §1 The defect at the exact base

`migrateUnpostedTransactions` (`accountingMigration.ts:258`) is a **public `mutation`**, gated on
`MANAGE_FINANCE` + `requireFeature("accounting")` (`:265-266`). `dryRun` defaults to **true**
(`:268` — `args.dryRun !== false`), so the writing path requires an explicit `dryRun: false`.

When it writes, it builds a gross old-shape payload and posts it directly:

```ts
// :337-341
const payload: Record<string, unknown> = { amountMinor, currency, legacyTransactionId: tx._id.toString() };
// :346-348
} else if (eventType === "COLLECTION_PAYMENT") {
  payload.paymentId = tx._id.toString();
  payload.paymentMethod = "CASH";
// :365-377  — direct postAccountingEvent, eventVersion: 1, variable eventType cast at :367
await postAccountingEvent(ctx, { ..., eventType: eventType as "EXPENSE_POSTED" | "COLLECTION_PAYMENT" | ... });
// :379-382
} catch (err) {
  results.push({ transactionId, action: "FAILED", eventType, reason: message });   // ephemeral
}
```

Three separate problems, all confirmed by reading:

1. **`COLLECTION_PAYMENT` is reachable** — `mapCategoryToEventType:47` maps the `COLLECTION_PAYMENT`
   transaction category straight to the event type.
2. **The payload carries `amountMinor` only.** There is no applied/unapplied split and no version
   marker, so it is exactly the shape SCRUM-218 v2 must never treat as applied AR authority.
3. **A refusal leaves no durable trace.** `migrateUnpostedTransactions` writes **no**
   `financialAuditLog` row at all — verified: the only `MIGRATE_TRANSACTION` write in this file is at
   `:831`, inside the *opening-balance* function, well past this mutation's end at `:392`. The
   `results` array is the entire record and it dies with the response.

---

## §2 Complete runtime writer inventory — re-verified independently at `bf5769ed1`

Sol directed me to use the reviewers' enumeration as a starting point and re-verify it. I did; it
agrees, and I found two things it did not say.

**Every production `postAccountingEvent` call site** (`--glob !*.test.ts`): five sites, four modules.

| # | Call site | Kind / reachability | Can emit `COLLECTION_PAYMENT`? | `PAYMENT_LINK_RECEIVED`? |
|---|---|---|---|---|
| 1 | `accounting/workflowHooks.ts:118` (`postOrEnqueue`) | reached by `hookCollectionPayment` (`collections.ts:1099` cash, `:1404` cheque clearing) and `hookPaymentLinkReceived` (`paymentIntents.ts:507` `markSettled`, `:639` webhook) | **YES** | **YES** |
| 2 | `accountingOutbox.ts:199` (drain) | internal; cron + dispatch | **by REPLAY only** | **by REPLAY only** |
| 3 | `accountingLedger.ts:169` (`post`) | **`internalMutation`** — not client-callable | structurally unreachable today | same |
| 4 | `accountingMigration.ts:365` | **public `mutation`**, `MANAGE_FINANCE` | **YES — the target** | **NO** |
| 5 | `accountingMigration.ts:775` | `internalMutation`; eventType **hardcoded** `"VEHICLE_INVENTORY_OPENING_BALANCE"` | NO | NO |

### §2.1 Two findings the reviewers' enumeration did not contain

**(a) `accountingLedger.post` has ZERO production callers.** Searching the whole worktree for
`internal.accountingLedger.post` returns **only test files** (`accountingPhase2/5/6/7.test.ts`). It is
`internalMutation`, so no client can reach it, and no production code invokes it. Its own comment
(`accountingLedger.ts:135-150`) documents exactly why it was made internal: a public version would let
any `MANAGE_FINANCE` user *"post an arbitrary payload under any event type/source directly from the
client"*, because the dispatcher does an unchecked `payload as unknown as XPayload` cast.

So it is **closed by construction today** — but it takes `eventType: v.string()` and
`payload: v.any()`, so it is an unbounded old-shape minter the moment anything calls it. That is
precisely the case the writer-inventory test must catch (§10 item 8).

⚠️ **Stale documentation, flagged not fixed:**
`docs/architecture/accounting-implementation-progress.md:302` asserts *"`accountingLedger.post` is the
public surface."* It is `internalMutation`. Doc-only, out of scope, recorded so it is not later read as
evidence.

**(b) The two event types are NOT symmetric, and the ticket treats them as a pair.**
`PAYMENT_LINK_RECEIVED` appears **nowhere** in `accountingMigration.ts` (zero matches), and
`mapCategoryToEventType` (`:41-69`) has no branch producing it. Therefore:

```text
old-shape COLLECTION_PAYMENT      minted by: migration (#4)  + hooks (#1)  + outbox replay (#2)
old-shape PAYMENT_LINK_RECEIVED   minted by:                   hooks (#1)  + outbox replay (#2)
```

**There is no migration writer for `PAYMENT_LINK_RECEIVED` to retire.** Its only originator is the
hook path, which SCRUM-218 upgrades. This materially narrows the ticket, and stating it prevents a
future session hunting for a door that does not exist.

---

## §3 Which writers remain valid v2 producers

- **#1 (the hooks) — valid, and SCRUM-218's responsibility.** These are the intended producers; SCRUM-223
  does not touch them.
- **#5 — valid, unrelated family.** Hardcoded opening-balance event type.
- **#3 — leave internal.** Do not make it public. Add it to the inventory test.
- **#2 (the drain) — not an originator.** It re-posts whatever payload shape was enqueued.
  ⚠️ **An old-shape row already sitting in `pendingAccountingEvents` before v2 activation would be
  replayed by the drain afterwards.** SCRUM-223 does not build a scanner for that — a pre-activation
  legacy scan was retired SCRUM-224's job and the clean-slate ruling deletes those rows. **This is a
  SCRUM-231 cutover precondition** and is recorded there rather than rebuilt here.
- **#4 — RETIRED.** §4.

---

## §4 The retirement — structural, following the precedent already in this file

`mapCategoryToEventType` **already contains a reviewed retirement**: `CLAIM_PAYMENT`
(`accountingMigration.ts:54-68`, SCRUM-51). Its comment records that both review seats independently
found the defect, that returning `null` leaves the row unposted, and — verbatim at `:63-64` — that this
*"is consistent with the owner ruling that current data is disposable."*

**`COLLECTION_PAYMENT` is retired the same way: the event type becomes unconstructible for that
category.** No flag, no version gate at the call site, no legacy rule behind a v2 switch. If the mapper
cannot produce the event type, `:346-348` is dead and `:365` can never be reached with it.

This is a boundary at the **producer**. That matters — see §6.

## §5 RETIRED must not collapse into UNMAPPED

Returning bare `null` routes the row to `:313-316`:

```ts
if (!eventType) {
  results.push({ ..., action: "SKIP", eventType: null, reason: "no_rule_for_category" });
```

`"no_rule_for_category"` would be **false**: a rule existed, was deliberately withdrawn, and the
operator is entitled to know the difference between *"this category was never supported"* and *"this
path was retired and your money was not migrated."*

So the mapper returns a discriminated result, not a nullable string:

```ts
type CategoryMapping =
  | { k: "MAPPED"; eventType: MigratableEventType }
  | { k: "UNMAPPED" }                                  // no rule ever existed
  | { k: "RETIRED"; category: string; reason: string } // withdrawn under v2
```

`RETIRED` yields a distinct `action: "RETIRED"` outcome. **Two different fates must not share one
value** — this is the defect class that has repeatedly bitten this programme, and the fix is to make
them different variants rather than the same `null` distinguished by a comment.

## §6 The version boundary — what SCRUM-223 owns and what it must NOT invent

Sol requires *"one structural/version boundary proving no old-shape payload can reach v2 posting."*
There are two candidate places, and taking the wrong one re-runs the SCRUM-224 failure of inventing
shared infrastructure inside a bounded ticket.

- **Producer-side boundary — SCRUM-223 owns it.** After §4, no runtime path in this repository can
  construct an old-shape `COLLECTION_PAYMENT` payload. That is provable by the writer inventory plus
  the mapper's type.
- **Consumer-side boundary — SCRUM-218 owns it.** A payload-shape discriminator that makes the v2
  posting rule refuse a gross-only payload belongs to SCRUM-218's payload contract, which is currently
  under architecture reset (`c17412`). **SCRUM-223 must not invent a second one**, or the two will
  drift.

**Stated dependency:** SCRUM-223 closes the only *producer*. Full closure of the invariant requires
SCRUM-218's consumer-side discriminator. Neither ticket may claim the invariant alone, and this packet
does not.

## §7 Durable, truthful audit evidence

Requirement: an authorized user who invokes the retired path must get a truthful, durable record — not
a success-shaped or ephemeral result.

**Reuse `financialAuditLog`, do not add a table.** It already carries `MIGRATE_TRANSACTION`
(`schema.ts:754`) and is the established durable audit surface. A new action literal
`RETIRE_MIGRATION_CATEGORY` records: org, actor, `resourceType: "transactions"`, `resourceId` (the
transaction id), the category, the retirement reason, and the run's timestamp.

Rules:
- **Written only on a real invocation (`dryRun: false`).** A dry run reports and writes nothing.
- **Written even though nothing posted** — that is the entire point.
- **No journal, no accounting event, no v2 collection authority** is created on this path.
- The response reports `action: "RETIRED"` with the reason; it must never be counted in `posted`.

⚠️ **Action types are declared in TWO places and both must change:** `schema.ts:741-779` and
`financialAudit.ts:31`. Adding one and not the other is a drift trap.

⚠️ **Merge hotspot, declared:** `schema.ts` is also modified by SCRUM-222 (`bf5769ed1..5f88808df`).
The regions differ — SCRUM-222 touches outbox fields, this touches the `financialAuditLog` union near
`:778` — but the file collides. #273 merges first; this branch rebases onto it, never the reverse.

## §8 Positive controls — the migration subsystem stays alive

Retirement is scoped to the collection/payment semantics only. These must keep working, and are
required evidence, not optional:
`EXPENSE_POSTED` · `DEPOSIT_RECEIVED`/`DEPOSIT_REFUNDED` · `SALE_COMPLETED` · `PARTNER_DREW` ·
`CAPITAL_CONTRIBUTED` · `VEHICLE_ACQUIRED`, plus the Phase-17 minor-unit backfills (`:407`, `:439`,
`:465`, `:524`) and the opening-balance path (`:757`).

`CLAIM_PAYMENT` stays unmapped (SCRUM-51). **SCRUM-166 and SCRUM-188 fixes are NOT absorbed here** —
they share this file but are different mechanisms.

## §9 Explicitly forbidden

- No `appliedMinor = amountMinor` default.
- No deriving authority by inspecting mutable receivable outstanding.
- No calling a legacy posting rule behind a v2 flag.
- No reconstructing v2 receipt authority from legacy gross rows.
- No wholesale disabling of the migration subsystem.

## §10 Failing-first evidence

1. A legacy `COLLECTION_PAYMENT` transaction cannot post as v2 authority — `action: "RETIRED"`, zero
   accounting events, zero journal lines.
2. The retirement writes a **durable** `financialAuditLog` row; a response-only mutant is killed.
3. Retry of the same retired migration → no duplicate GL and no duplicate economic effect.
4. Mutant defaulting `appliedMinor = amountMinor` → killed.
5. Mutant deriving `appliedMinor` from current mutable outstanding → killed.
6. Direct `postAccountingEvent` with an old-shape collection payload → structurally impossible from
   any runtime path (writer inventory proves it).
7. **Positive controls:** every §8 category still migrates.
8. **Writer-inventory test fails when a new runtime collection-event writer appears** without an
   explicit v2/legacy classification — covering `accountingLedger.post` gaining a production caller.
9. `RETIRED` and `UNMAPPED` are distinguishable in the response and in the audit trail; a mutant
   collapsing them → killed.
10. `dryRun: true` writes **nothing** — no audit row, no event.

## §11 Completeness claims, as refutation targets

Framing these as falsifiable targets worked on SCRUM-218 r3 (H1/H2/H4 refuted with counterexamples,
H3/H5 held with the search method stated), so it is repeated deliberately.

**K1 — the five call sites are every production `postAccountingEvent` caller at `bf5769ed1`.** Measured
by ripgrep over `convex/` excluding `*.test.ts`. **Find a sixth**, including dynamic dispatch, a
re-export, an action calling a mutation by string reference, or a scheduled function.

**K2 — after §4, no runtime path can construct an old-shape `COLLECTION_PAYMENT` payload.** **Find a
construction path** that reaches `postAccountingEvent` with that event type — via the outbox replaying
a stored row, a test helper reachable in production, or `accountingLedger.post` gaining a caller.

**K3 — `PAYMENT_LINK_RECEIVED` has no migration writer to retire.** Zero matches in
`accountingMigration.ts`. **Find a migration or admin path that mints it.**

**K4 — `financialAuditLog` is sufficient durable evidence** and no dedicated table is required, given
the clean-slate ruling removed the historical-reconciliation requirement. **Argue the opposite if an
operator genuinely cannot resolve a retired attempt from an audit row.**

**K5 — retirement does not break any other migration category.** §8 lists what I believe is affected.
**Find a category or backfill that breaks.**

"No additional item found, and here is how I looked" is a useful answer. "Confirmed correct" is not.

## §12 Boundary

Design only. No merge, deployment, production migration, reset, Accounting activation, provider
operation, production-data mutation, backfill or restatement. `accountingLedger.post` stays internal.
Documentation defect in §2.1(a) is recorded, not fixed.
