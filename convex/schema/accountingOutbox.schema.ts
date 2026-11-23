import { defineTable } from "convex/server";
import { v } from "convex/values";

export const accountingOutboxTables = {
  // Durable outbox for accounting events that could not post at the time of the
  // domain operation (no chart of accounts or no open period). Instead of
  // silently dropping the GL entry, the hook enqueues it here; the events are
  // re-driven (and posted idempotently) when a chart is initialized or a period
  // is opened. This guarantees no financial operation is ever final without a
  // captured, retryable GL record.
  pendingAccountingEvents: defineTable({
    orgId: v.id("organizations"),
    kind: v.union(v.literal("POST"), v.literal("REVERSE")),
    status: v.union(v.literal("PENDING"), v.literal("POSTED"), v.literal("FAILED")),
    idempotencyKey: v.string(),
    accountingDate: v.number(),
    actorId: v.id("users"),
    branchId: v.optional(v.id("branches")),
    reason: v.optional(v.string()),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    /**
     * SCRUM-208 — WHAT THE VEHICLE AUTHORITY DID AFTER THIS REVERSAL POSTED.
     *
     * ⚠️ NOT `lastError`. Once the journal exists the money has already moved
     * back, so a vehicle-authority result is expected business behaviour and
     * not a posting failure. Routing it through `lastError` would make a
     * condition a human must repair indistinguishable from a transient error
     * the drain will retry — and the retry would fail identically forever.
     *
     * RESTORED — the customer's commitment is LIVE again, verified: successor
     *   episode, OPEN root, live source, moved pointer, truthful vehicle
     *   projection. ⚠️ It used to also mean "the car was freed" and "the car
     *   was already free" — an audit record asserting a restoration that never
     *   happened, which is worse than the silence it replaced (SCRUM-208
     *   c15808). Those cases now have their own names.
     * ..._NO_RESTORABLE_BASIS — nothing to restore, lawfully: money already
     *   gone, the deal did not end for this reason, the car has since been
     *   sold, or the record predates the canonical model.
     * AUTHORITY_WITHHELD_CANONICAL_UNAVAILABLE — the organization is not on
     *   the canonical authority, so nothing was examined. The majority case
     *   until SCRUM-201's cutover, and it must not read as either neighbour.
     * ..._NO_AUTHORITY_RIVAL — something else legitimately still holds it; the
     *   reversal stands and the vehicle does not move.
     * ..._BLOCKED_AMBIGUOUS — two OPEN roots. A durable repair condition,
     *   findable by index rather than by reading error strings.
     */
    authorityOutcome: v.optional(
      v.union(
        v.literal("RESTORED"),
        v.literal("ACCOUNTING_REVERSED_NO_RESTORABLE_BASIS"),
        v.literal("AUTHORITY_WITHHELD_CANONICAL_UNAVAILABLE"),
        v.literal("ACCOUNTING_REVERSED_NO_AUTHORITY_RIVAL"),
        v.literal("ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_AMBIGUOUS"),
        // The canonical records contradict each other, or the restoration's
        // postcondition did not hold. A DIAGNOSIS: the repairer is told what
        // disagrees with what.
        v.literal("ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_INCONSISTENT"),
        // ⚠️ SCRUM-208 c15825 — THE ABSENCE OF A DIAGNOSIS, AND A SEPARATE
        // AUDIT FACT. Repeated settlement executions failed for unexpected
        // technical reasons and the budget is spent, so nobody knows what the
        // authority state is. This used to be recorded as
        // BLOCKED_INCONSISTENT, which told the repairer the records
        // contradicted each other when nothing had established that.
        v.literal("ACCOUNTING_REVERSED_AUTHORITY_RETRY_EXHAUSTED"),
        // ⚠️ SCRUM-302 — THE ORGANIZATION, NOT THE RECORDS. Irreversible
        // destructive-purge lifecycle began before the active settlement could
        // execute, so it was permanently abandoned with zero authority and
        // zero economic effect. Ranked above RETRY_EXHAUSTED in
        // AUTHORITY_SEVERITY for one reason only: a clean sibling must never
        // bury a permanent lifecycle abandonment in the worst-of summary. That
        // ordering is NOT a claim that this is "worse accounting".
        v.literal("ACCOUNTING_REVERSED_AUTHORITY_ABANDONED_ORG_PURGED")
      )
    ),
    authorityOutcomeAt: v.optional(v.number()),
    /** Diagnosis only. Nothing may make a decision on this text. */
    authorityOutcomeDetail: v.optional(v.string()),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
    // POST shape (mirrors PostCommand)
    eventType: v.optional(v.string()),
    sourceType: v.string(),
    sourceId: v.string(),
    eventVersion: v.optional(v.number()),
    occurredAt: v.optional(v.number()),
    currency: v.optional(v.string()),
    payload: v.optional(v.any()),
    // REVERSE shape
    originalEventId: v.optional(v.id("accountingEvents")),
    resultEventId: v.optional(v.id("accountingEvents")),

    // ─── SCRUM-222 — EXECUTION METADATA IS NOT AN ACCOUNTING OUTCOME ────────
    //
    // `status` above stays exactly PENDING / POSTED / FAILED. A row claimed by
    // a worker is STILL `PENDING`, because period close, cancellation hooks,
    // reporting projections and evidence checks all read that field and were
    // written when three values existed. An earlier revision of this design put
    // the claim in `status`; its sharpest consequence was not a stale control
    // but a WRONG GL ENTRY — a claimed prepaid amortization row no longer
    // matched `hookPrepaidExpenseAmortizationsReversed` (which enumerates only
    // PENDING/FAILED), so the worker posted an amortization for a REVERSED
    // prepayment. Fourteen exact-status readers would have had to learn a
    // fourth literal, and a fifteenth proved absent. These fields make that set
    // empty by construction.
    //
    // ⚠️ ALL OPTIONAL AND ADDITIVE, AND THE ABSENCE IS LOAD-BEARING. Every
    // pre-SCRUM-222 row is valid unchanged, and an absent `nextActionAt` means
    // "due now" rather than "invisible" — which is what a legacy backlog must
    // mean. That the index actually behaves that way is not assumed here; it is
    // proved against a real deployment (contract §4.2).
    /**
     * `DISPATCHED`: a worker attempt is outstanding. `PERIOD_HELD` (SCRUM-807): parked
     * until a period covers `accountingDate`; neither due-work range matches it, so
     * nothing re-selects it until `wakePeriodHeldRows` releases it. Absent = unclaimed.
     */
    dispatchState: v.optional(v.union(v.literal("DISPATCHED"), v.literal("PERIOD_HELD"))),
    /** Bumped on every claim and every manual revive; a stale worker loses. */
    generation: v.optional(v.number()),
    activeAttemptId: v.optional(v.string()),
    scheduledFunctionId: v.optional(v.id("_scheduled_functions")),
    /** When this row next becomes selectable. Absent = immediately due. */
    nextActionAt: v.optional(v.number()),
    /**
     * SCRUM-807 — set only while the row is HELD waiting for an accounting
     * period to cover `accountingDate`. It lets a period opening find exactly
     * the rows it unblocks by index. Absent for every other hold, for failures
     * in backoff, and for rows written before this field existed (those are
     * claimed once, re-evaluated and then marked like any new hold).
     */
    holdKind: v.optional(v.literal("PERIOD")),
  })
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_idempotency", ["orgId", "idempotencyKey"])
    // SCRUM-807 — the period-held rows a period now covers, in date order.
    .index("by_org_hold_date", ["orgId", "holdKind", "accountingDate"])
    // SCRUM-222 — the due-work index, mirroring `commitmentAuthorityWork`'s
    // `by_status_next_action`. One index serves both selector ranges:
    // unclaimed work (`dispatchState` absent) and claimed work awaiting
    // observation (`DISPATCHED`), each bounded by `nextActionAt`.
    .index("by_dispatch_next_action", ["status", "dispatchState", "nextActionAt"])
    // Lets a cancelled/voided source (e.g. a warranty/GAP deferral whose sale
    // was cancelled) sweep every one of its own not-yet-posted queued POSTs in
    // one query, not just the one idempotencyKey it happens to know about —
    // a recurring source (monthly F&I recognition) can have more than one
    // stuck entry across different periods. See cancelPendingPostsBySource.
    .index("by_org_source", ["orgId", "sourceType", "sourceId"])
    // SCRUM-208 — the repair queue. An authority condition a human must act on
    // is found by an exact range, never by scanning `lastError` for wording.
    .index("by_org_authority_outcome", ["orgId", "authorityOutcome"]),
};
