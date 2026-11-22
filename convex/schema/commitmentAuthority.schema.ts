import { defineTable } from "convex/server";
import { v } from "convex/values";

export const commitmentAuthorityTables = {
  /**
   * SCRUM-208 c15814 — ONE DURABLE WORK ITEM PER EXACT SOURCE EPISODE, so that
   * vehicle authority settles in its OWN transaction rather than inside the
   * accounting drain.
   *
   * ⚠️ WHY THIS TABLE EXISTS AT ALL. Authority settlement used to run inside
   * `accountingOutbox.markEntryPosted`, under `drainEntries`' per-row
   * `try`/`catch`. That catch is correct for accounting — one bad row must not
   * abort a whole organization's drain — but it made the authority half
   * un-rollbackable: an unexpected failure AFTER a successor root, claim or
   * pointer had been written was caught, the mutation returned normally and
   * COMMITTED the partial state, and it was then labelled INCONSISTENT. Truthful
   * about failure, and still a half-restoration on a money path.
   *
   * Pre-flight guards closed the failure modes anyone had enumerated. They
   * cannot prove the next unenumerated one is impossible, which is the property
   * c15808's postcondition actually demands: source LIVE + successor root and
   * claim OPEN + pointer + truthful projection, or NONE OF IT.
   *
   * So accounting completion and authority settlement become separate durable
   * states. The accounting transaction finishes the reversal and records what
   * authority work is owed; each work item then settles in its own registered
   * mutation, where a throw is a real rollback boundary.
   *
   * ⚠️ THIS IS NOT A BACKFILL SURFACE. Rows are minted only by an accounting
   * reversal completing after this ships. Nothing infers work from a historical
   * POSTED outbox row: missing authority state on an old row is legacy and
   * fails closed. SCRUM-201 owns any live backlog reconciliation.
   */
  commitmentAuthorityWork: defineTable({
    orgId: v.id("organizations"),
    /**
     * The exact immutable identity of one source episode's settlement.
     *
     * `${pendingEvent.idempotencyKey}:${sourceKind}:${holdId ?? depositId}`
     *
     * Every component is a STORED FACT — the outbox row's own
     * `reversed_<applicationKey>`, and the id of the exact slice or deposit.
     * No clock, no "newest row" selector, no history inference. One source
     * episode has exactly one settlement identity, so a re-drained accounting
     * row or a re-run worker cannot mint a second work item, a second root or
     * a second successor claim.
     */
    workKey: v.string(),
    /**
     * READY — owed, and nothing is executing. Dispatchable once due.
     * DISPATCHED — one attempt is claimed and outstanding. ⚠️ THIS IS THE
     *   CLAIM ITSELF: a second dispatcher sees it and does nothing, which is
     *   what makes the budget count executions instead of delivery offers.
     * SETTLED — an expected typed outcome was reached and recorded. Terminal.
     * BLOCKED — TERMINAL; NO AUTOMATIC RETRY. Never a silent give-up.
     *
     *   ⚠️ SCRUM-302 NARROWED THIS, BECAUSE IT USED TO OVERCLAIM. It read
     *   "the execution budget is spent … a repair condition a person must act
     *   on", which was true of the only producer that then existed. It is not
     *   true of every BLOCKED row now: a work item abandoned because its
     *   organization is being irreversibly deleted has spent no budget, and
     *   there is nobody left for whom repair is meaningful. The status carries
     *   exactly one invariant — terminal, no automatic retry — and the
     *   `outcome` says WHY, and therefore whether human repair means anything.
     *
     * ⚠️ SCRUM-208 c15825 — `PENDING` MEANT BOTH "OWED" AND "EXECUTING", AND
     * THAT WAS THE DEFECT. A work row stayed PENDING while its settlement was
     * outstanding, so anything that re-offered PENDING work — the drain-riding
     * sweep, a duplicate schedule — could spend another unit of a budget that
     * was supposed to measure real executions. Splitting the two states is the
     * durable claim the old design had no way to express.
     */
    status: v.union(
      v.literal("READY"),
      v.literal("DISPATCHED"),
      v.literal("SETTLED"),
      v.literal("BLOCKED")
    ),
    /** DIRECT = the deposit itself holds the car. SLICE = one allocation row. */
    sourceKind: v.union(v.literal("DIRECT"), v.literal("SLICE")),
    depositId: v.id("deposits"),
    vehicleId: v.id("vehicles"),
    saleId: v.id("sales"),
    /** Present only for the sliced representation — the exact slice episode. */
    holdId: v.optional(v.id("depositVehicleHolds")),
    /**
     * The accounting row whose completion owed this work.
     *
     * ⚠️ PROVENANCE, NEVER A DECISION INPUT. Authority is decided from the
     * canonical records, not from anything the accounting row says.
     */
    pendingEventId: v.id("pendingAccountingEvents"),
    /**
     * How many settlement executions were ACTUALLY scheduled for this work.
     *
     * ⚠️ DELIBERATELY NOT NAMED `attempts` (SCRUM-208 c15825). The old field
     * counted `beginAuthorityWork` DELIVERIES, and a duplicate delivery spent
     * budget without a settlement ever running — so a row could reach its cap
     * and record "repeated attempts" when fewer had happened. Reusing the
     * familiar name for the corrected meaning is how that reading survives a
     * redesign, so the name went with the defect.
     *
     * Incremented in exactly one place: the dispatcher transaction that mints
     * the attempt row and moves this work to DISPATCHED. One increment, one
     * immutable attempt, one scheduled execution.
     */
    executions: v.number(),
    /**
     * How many of those executions performed NO settlement because a TEMPORARY
     * organization-lifecycle refusal held the work (SCRUM-302).
     *
     * ⚠️ TEMPORARY REFUSALS ONLY. A permanent refusal — irreversible
     * destructive purge — terminalizes the work instead, so it never returns
     * to the retry budget and does not increment this counter.
     *
     * ⚠️ A SEPARATE COUNTER RATHER THAN A DECREMENT, ON PURPOSE. `executions`
     * means "executions actually scheduled"; rolling it back would make it lie
     * about what really ran and would break the monotonicity the attempt
     * identity depends on. So the technical retry budget is
     * `executions - lifecycleHolds`, and a temporary hold costs nothing.
     *
     * ⚠️ THIS IS WHAT STOPS A SUSPEND/REACTIVATE RACE FROM FALSELY EXHAUSTING
     * A CAR'S BUDGET. Without it, five suspensions that each landed between
     * dispatch and settlement would terminalize the work as
     * RETRY_EXHAUSTED — reporting "repeated attempts failed" when no
     * settlement had ever been attempted, on a car whose authority is fine.
     *
     * Optional because rows written before SCRUM-302 do not carry it; absent
     * reads as 0.
     */
    lifecycleHolds: v.optional(v.number()),
    /**
     * How many attempt rows have ever existed for this work. Monotonic, and
     * the second half of an attempt's identity — a stale generation may not
     * write authority or spend budget.
     */
    generation: v.number(),
    /**
     * The one attempt permitted to settle this work right now. Cleared when an
     * attempt is observed failed, so a late execution of it cannot write.
     */
    activeAttemptId: v.optional(v.id("commitmentAuthorityAttempt")),
    /**
     * When this row is next due for whatever its status implies — dispatch
     * while READY, observation while DISPATCHED.
     *
     * ⚠️ THIS IS WHAT MAKES RETRY INDEPENDENT OF ACCOUNTING TRAFFIC. The old
     * retry rode a finished accounting drain, so an organization that never
     * drained again never retried. A static cron reads this due time instead.
     */
    nextActionAt: v.number(),
    lastAttemptAt: v.optional(v.number()),
    /** The typed authority answer. Same taxonomy the outbox row summarises. */
    outcome: v.optional(
      v.union(
        v.literal("RESTORED"),
        v.literal("ACCOUNTING_REVERSED_NO_RESTORABLE_BASIS"),
        v.literal("AUTHORITY_WITHHELD_CANONICAL_UNAVAILABLE"),
        v.literal("ACCOUNTING_REVERSED_NO_AUTHORITY_RIVAL"),
        v.literal("ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_AMBIGUOUS"),
        v.literal("ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_INCONSISTENT"),
        v.literal("ACCOUNTING_REVERSED_AUTHORITY_RETRY_EXHAUSTED"),
        // ⚠️ SCRUM-302 — LIFECYCLE ABANDONMENT, AND IT IS NOT A FAILURE.
        // The organization entered irreversible destructive-purge lifecycle
        // before the active settlement could execute, so settlement was
        // permanently abandoned having performed no authority or economic
        // write. It is NOT retry exhaustion, NOT inconsistent authority, and
        // NOT canonical unavailability — each of those asserts something about
        // the RECORDS, and this asserts something about the ORGANIZATION.
        v.literal("ACCOUNTING_REVERSED_AUTHORITY_ABANDONED_ORG_PURGED")
      )
    ),
    outcomeAt: v.optional(v.number()),
    /**
     * Diagnosis only, and CURATED. Raw technical errors are server-logged and
     * never persisted here — this text reaches every tenant user holding
     * VIEW_FINANCE through the accounting surfaces.
     */
    outcomeDetail: v.optional(v.string()),
    createdAt: v.number(),
    settledAt: v.optional(v.number()),
  })
    // At-most-once. The insert is guarded by an exact lookup on this range.
    .index("by_org_work_key", ["orgId", "workKey"])
    // Per-organization operational visibility, and the reset/delete manifests.
    .index("by_org_status", ["orgId", "status"])
    // The repair queue: found by an exact range, never by scanning text.
    .index("by_org_outcome", ["orgId", "outcome"])
    /**
     * ⚠️ THE ONLY THING THE CRON DISPATCHER READS, AND IT IS DELIBERATELY NOT
     * ORG-SCOPED. A static cron has no tenant to scope to — which is exactly
     * why the dispatcher only SELECTS and SCHEDULES here. Every unit of real
     * per-row work runs in its own mutation, deriving `orgId` from the row, so
     * one poisoned row cannot roll back another dealership's settlement. A
     * throwing call inside a global batch is a cross-tenant outage.
     */
    .index("by_status_next_action", ["status", "nextActionAt"])
    /**
     * The accounting row's summary reads its own work by an EXACT range.
     *
     * It previously used a string-prefix range over `workKey`, which encodes
     * the idempotency key — correct in practice, and one key that is a prefix
     * of another away from silently summarising a different accounting row's
     * work. The relationship is a stored id; it should be read as one.
     */
    .index("by_org_pending_event", ["orgId", "pendingEventId"]),

  /**
   * SCRUM-208 c15825 — ONE IMMUTABLE ROW PER ACTUAL SETTLEMENT EXECUTION.
   *
   * ⚠️ WHY A SECOND TABLE RATHER THAN A COUNTER. The previous design held one
   * number, `attempts`, incremented by whatever delivered a settlement offer.
   * Two things it could not express, and both were blocking findings:
   *
   *  1. **Which execution is allowed to write.** With no durable execution
   *     identity, a late or duplicated settlement could not be told apart from
   *     the current one, so the only guard available was "is the work still
   *     owed" — which is true of both.
   *  2. **What actually happened to an execution.** A settlement that fails
   *     rolls its own transaction back, taking any record of the failure with
   *     it. The count of offers was the only surviving signal, and it counted
   *     the wrong thing.
   *
   * An attempt row is written by the DISPATCHER, in a transaction that commits
   * before the settlement runs — so it survives the settlement's rollback and
   * remains the durable evidence that one execution really was scheduled. The
   * observer then reads the exact scheduled-function document and closes it.
   *
   * ⚠️ APPLICATION STATE IS AUTHORITATIVE; THE SCHEDULER IS A TRANSPORT
   * OBSERVATION. `_scheduled_functions` answers what happened to one exact
   * execution and nothing else. It never decides a business outcome, its raw
   * error text is never persisted or shown to a tenant, and its results are
   * retained only for a bounded window — so a MISSING document is unobservable,
   * never success.
   */
  commitmentAuthorityAttempt: defineTable({
    orgId: v.id("organizations"),
    workId: v.id("commitmentAuthorityWork"),
    /** Monotonic within one work item. `(workId, generation)` is the identity. */
    generation: v.number(),
    /** `${workId}:${generation}` — the unique key that makes the pair exact. */
    attemptKey: v.string(),
    /**
     * The exact scheduled settlement execution this attempt is.
     *
     * ⚠️ OPTIONAL IN THE VALIDATOR ONLY BECAUSE OF WRITE ORDER, NEVER IN
     * PRACTICE. The row must exist before `ctx.scheduler.runAfter` can be told
     * the attempt id, and `runAfter` is what returns this id — so the insert
     * and the patch that fills it are two steps of ONE transaction. It is
     * never observably absent to anything outside that transaction.
     */
    scheduledFunctionId: v.optional(v.id("_scheduled_functions")),
    /**
     * SCHEDULED — dispatched, outcome not yet observed.
     * SUCCEEDED — the settlement committed a typed outcome.
     * FAILED / CANCELED — the execution did not complete. Retryable until the
     *   work's execution budget is spent.
     */
    status: v.union(
      v.literal("SCHEDULED"),
      v.literal("SUCCEEDED"),
      v.literal("FAILED"),
      v.literal("CANCELED")
    ),
    createdAt: v.number(),
    observedAt: v.optional(v.number()),
    /**
     * Diagnosis only, and CURATED. ⚠️ NEVER the scheduler's raw error text:
     * that is a backend stack trace, and these rows are reachable from the
     * accounting surfaces every VIEW_FINANCE user can open. The real error is
     * server-logged for the engineer.
     */
    detail: v.optional(v.string()),
  })
    // Exactly one attempt per (work, generation).
    .index("by_attempt_key", ["attemptKey"])
    // An item's execution history, oldest first, for repair and audit.
    .index("by_org_work", ["orgId", "workId", "generation"])
    // The reset and hard-delete manifests.
    .index("by_org_status", ["orgId", "status"]),

  /**
   * SCRUM-195 — WHO HOLDS A PHYSICAL CAR, AND ON THE STRENGTH OF WHAT.
   *
   * A commitment ROOT is one deal's claim on one physical vehicle. Root
   * identity is SERVER-OWNED: it is never `(customerId, vehicleId)`, never a
   * row count, and never inferred from two facts happening to share a
   * customer. The same customer opening a second, independent deal on the same
   * car is a DIFFERENT root and must be refused while the first one lives.
   *
   * `vehicle.status` is an advisory PROJECTION of this authority — useful to
   * the UI and to legacy callers, never the lock.
   *
   * ⚠️ Exactly one OPEN root may exist per physical vehicle. Two is corrupt
   * historical state, not a tie to be broken: it means one car was promised to
   * two deals, which is the failure this table exists to make impossible.
   */
  commitmentRoots: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    customerId: v.id("customers"),
    /**
     * OPEN — a live deal holds the car.
     * RELEASED — the deal let it go without a sale.
     * CONSUMED — the deal completed into a sale. CONSUMED outranks RELEASED:
     * a deal that became a sale is finished, not merely abandoned.
     */
    status: v.union(v.literal("OPEN"), v.literal("RELEASED"), v.literal("CONSUMED")),
    /**
     * The revision this deal is currently known by. Lineage PROOF, not
     * identity — a quote proves which deal an operation belongs to; it never
     * defines the deal.
     */
    headQuoteId: v.optional(v.id("quotes")),
    /** Set when the deal began life as a reservation rather than a quote. */
    originReservationId: v.optional(v.id("vehicleReservations")),
    openedAt: v.number(),
    openedBy: v.id("users"),
    closedAt: v.optional(v.number()),
    closedReason: v.optional(v.string()),
    /**
     * SCRUM-195 M3 — WRITE-ONCE, on OPEN -> CONSUMED only.
     *
     * The exact sale that ended this deal. Root-level rather than claim-level
     * because a root legitimately carries several live episodes at once, so
     * "which claims did this sale consume" has no defensible answer while
     * "which sale consumed this root" has exactly one.
     *
     * It exists so Phase 3 can go from a cancelled sale back to its root by
     * index instead of reconstructing it from history. Nothing may rewrite it:
     * a deal becomes a sale once.
     */
    consumedBySaleId: v.optional(v.id("sales")),

    /**
     * SCRUM-208 — LINEAGE IDENTITY, so a succession chain has ONE stable name.
     *
     * A root is terminal forever once CONSUMED or RELEASED. A legitimate
     * restoration therefore opens a SUCCESSOR root rather than reviving the
     * dead one — and without a stable lineage id, "the current root for this
     * deal" could only be answered by walking `restoredFromRootId` backwards,
     * a read that grows with the deal's history.
     *
     * ⚠️ ONE CANONICAL ORIGIN REPRESENTATION. Every canonical root COMMITS
     * with `lineageRootId` populated: the origin points at ITSELF and carries
     * `lineageGeneration: 0`. Insert-then-self-patch inside the same mutation
     * is fine — Convex commits the mutation atomically — but no claim may
     * attach and the mutation may not commit until it is written.
     *
     * `lineageRootId === undefined` on an authority read means LEGACY. It
     * FAILS CLOSED and belongs to SCRUM-201's cutover; it is NEVER normalized
     * to "self", because that would silently manufacture an origin for a row
     * that never had one.
     */
    lineageRootId: v.optional(v.id("commitmentRoots")),
    /** 0 at the origin, +1 per successor. Unique within a lineage. */
    lineageGeneration: v.optional(v.number()),
    /**
     * The root this one succeeds. Immutable, and always within the same
     * lineage, org, vehicle and principal. Distinct from
     * `vehicleCommitmentClaims.restoredFromClaimId`: that records the episode
     * chain WITHIN a root, this records the chain BETWEEN roots.
     */
    restoredFromRootId: v.optional(v.id("commitmentRoots")),
  })
    .index("by_org_vehicle_status", ["orgId", "vehicleId", "status"])
    .index("by_org_customer", ["orgId", "customerId"])
    // SCRUM-208 — MAX-GENERATION-FIRST TIP RESOLUTION.
    //
    // The tip is established by taking the HIGHEST generation in the lineage
    // (descending, `take(2)` — two rows at the same generation is corruption),
    // and only then is the OPEN set consulted to CONFIRM OR CONTRADICT it.
    //
    // ⚠️ NOT "find the OPEN root and trust it". An OPEN root sitting BELOW a
    // later terminal generation is corruption, not a valid tip: answering with
    // it regresses authority to an older generation and lets dormant evidence
    // attach behind a root that has already been consumed.
    .index("by_org_lineage_generation", ["orgId", "lineageRootId", "lineageGeneration"])
    .index("by_org_lineage_status", ["orgId", "lineageRootId", "status"])
    // TENANT-SCOPED ON PURPOSE. A bare ["consumedBySaleId"] index would answer
    // "which root did this sale consume" across every organization at once, and
    // the answer is only ever wanted within one. Leading with orgId makes the
    // tenant boundary part of the access path rather than a filter somebody has
    // to remember to apply.
    .index("by_org_consumed_sale", ["orgId", "consumedBySaleId"])
    // SCRUM-444 R5 — "THE DISTINCT RESERVATION ORIGINS OF THIS QUOTE'S DEAL".
    // The reservation-deposit probe seeks `(org, headQuoteId = Q)` and then
    // steps `originReservationId` forward with `.gt(<last origin>).first()`, so
    // it costs one seek per DISTINCT origin and skips every other root that
    // shares one (restoration successors copy `headQuoteId` and
    // `originReservationId`). It never scans the car's history
    // (`by_org_vehicle_status` grows for the life of a car).
    //
    // Both fields are optional. Convex DOES index a row whose field is
    // undefined, and it sorts BEFORE every defined value, so a root headed at Q
    // with no origin sits at the very start of the `(org, Q)` range. The probe's
    // first seek uses `.gt("originReservationId", undefined)` to step over
    // those rows; a root with no `headQuoteId` is never in Q's range at all.
    // No backfill: Convex builds the index on deploy.
    .index("by_org_head_quote_origin", ["orgId", "headQuoteId", "originReservationId"]),

  /**
   * SCRUM-195 — ONE ACQUISITION EPISODE.
   *
   * A claim row is one episode of a deal holding a car on the strength of one
   * piece of evidence — NOT the eternal identity of that evidence. Once
   * CONSUMED or RELEASED the row is terminal FOREVER and may never become
   * ACTIVE again. A legitimate reacquisition opens a NEW row on the SAME root
   * and the SAME evidence, pointing back at its predecessor:
   *
   *   C1 ACTIVE → a sale consumes C1 → C1 stays CONSUMED forever
   *   the sale is reversed and the evidence reinstated → C2 ACTIVE,
   *     restoredFromClaimId = C1
   *   a later sale consumes C2 → C2 stays CONSUMED forever → C3 from C2
   *
   * This mirrors the rule `depositVehicleHolds` already follows — a terminal
   * row is never rewritten into a new life; RETURN_TO_UNALLOCATED and
   * REALLOCATE_TO_VEHICLE both INSERT a fresh hold. The authority and the
   * money now age the same way.
   *
   * ⚠️ EVIDENCE IS TAGGED AND CARRIED, NEVER RE-DERIVED. `evidenceKind` says
   * which of the three references is the defining one, and a restoration
   * carries its predecessor's tag forward rather than assuming a default.
   * Assuming a default is how a reservation's own deposit became a
   * DEPOSIT-kind claim on RESERVATION evidence.
   */
  vehicleCommitmentClaims: defineTable({
    orgId: v.id("organizations"),
    rootId: v.id("commitmentRoots"),
    vehicleId: v.id("vehicles"),
    /** Which reference below is the DEFINING evidence for this episode. */
    evidenceKind: v.union(
      v.literal("DEPOSIT"),
      v.literal("FINANCE"),
      v.literal("RESERVATION")
    ),
    /** ACTIVE holds the car; RELEASED let it go; CONSUMED completed into a sale. */
    status: v.union(v.literal("ACTIVE"), v.literal("RELEASED"), v.literal("CONSUMED")),

    /**
     * The one matching `evidenceKind` is REQUIRED and defining. A row may
     * legitimately carry a second reference for context — a reservation
     * carries the deposit taken with it — which is exactly why the kind tag
     * exists rather than "whichever id happens to be set".
     */
    depositId: v.optional(v.id("deposits")),
    applicationId: v.optional(v.id("financeApplications")),
    reservationId: v.optional(v.id("vehicleReservations")),

    /** The revision this episode was opened under, for audit and stale-head diagnosis. */
    quoteId: v.optional(v.id("quotes")),

    /**
     * The episode this one succeeds. Immutable. Present only on a row created
     * by a legitimate reacquisition of evidence that was already consumed or
     * released, and always on the SAME root, vehicle and evidence.
     */
    restoredFromClaimId: v.optional(v.id("vehicleCommitmentClaims")),
    /**
     * WRITE-ONCE, on ACTIVE → CONSUMED only. Each episode is consumed by at
     * most one sale, which is what makes a scalar sufficient; durable history
     * across repeated sale/reversal cycles is carried by the predecessor
     * chain, not by rewriting this field.
     */
    consumedBySaleId: v.optional(v.id("sales")),

    createdAt: v.number(),
    createdBy: v.id("users"),
    resolvedAt: v.optional(v.number()),
    /** Audit and diagnosis only. Nothing may make a DECISION on this text. */
    resolvedReason: v.optional(v.string()),
  })
    .index("by_org_vehicle_status", ["orgId", "vehicleId", "status"])
    // SCRUM-69 — the finance-held-car guard reads ONLY FINANCE claims. RESERVATION and DEPOSIT
    // rows are insert-only and pile up on a car forever, so a kind-blind scan could be pushed
    // past its bound by unrelated history and refuse a car with no finance hold.
    .index("by_org_vehicle_kind_status", ["orgId", "vehicleId", "evidenceKind", "status"])
    .index("by_root_status", ["rootId", "status"])
    .index("by_consumed_sale", ["consumedBySaleId"])
    .index("by_restored_from", ["restoredFromClaimId"])
    // SCRUM-208 — SUCCESSOR UNIQUENESS, TENANT-SCOPED.
    //
    // ⚠️ THE BARE INDEX ABOVE CANNOT ANSWER THIS QUESTION SAFELY. Asking it
    // for "does this episode already have a successor" and then checking the
    // returned row's org is a post-filter after a bounded read: a corrupt
    // foreign-tenant row ordered first HIDES a valid same-tenant successor,
    // and the answer comes back "none" for a car that has one.
    //
    // Leading with orgId makes the tenant part of the access path, so a
    // `take(2)` on this range is an exact 0 / 1 / more-than-one uniqueness
    // probe — and more-than-one is corruption to refuse, never a set to pick
    // from.
    .index("by_org_restored_from", ["orgId", "restoredFromClaimId"])
    // No by-deposit index. Provenance is answered by the pointer a
    // `depositVehicleHolds` row carries, not by searching the episodes that
    // share a deposit — an index here would only invite that search back.
    .index("by_application", ["applicationId"])
    .index("by_reservation", ["reservationId"])
    // SCRUM-444 R5 — the FUNDED reservation episodes that name a quote. Leading
    // with `(org, quoteId, evidenceKind = "RESERVATION")` and stepping
    // `depositId` forward with `.gt(<last deposit>).first()` costs one seek per
    // DISTINCT funded deposit. `depositId` is undefined on an UNFUNDED
    // reservation's claim (only a funded reservation stamps it) and undefined
    // sorts before every defined value, so `.gt("depositId", undefined)` never
    // returns, and never counts, an unfunded reservation. Claims of other
    // evidence kinds are outside the `RESERVATION` range. No data migration.
    .index("by_org_quote_kind_deposit", ["orgId", "quoteId", "evidenceKind", "depositId"]),
};
