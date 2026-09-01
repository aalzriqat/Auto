import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { paymentMethodValidator, acquisitionPaymentMethodValidator } from "./utils/paymentMethods";
import { trustPassportFieldValidators } from "./utils/vehicleStatusGuards";
import {
  appraisalStatusValidator,
  approvedPurchaseBasisValidator,
  creditDecisionValidator,
  customerContributionSettlementValidator,
  dealerContributionSettlementValidator,
  feeAccountingTreatmentValidator,
  feePartyValidator,
  feeResponsibilityValidator,
  financeCompanyRuleSnapshotValidator,
  financeFeeTemplateValidator,
  financeFeeTypeValidator,
  financingFailureReasonValidator,
  gapResolutionValidator,
  handoverStatusValidator,
  ltvBasisValidator,
  quotationCalculationSnapshotValidator,
  quotationSourceValidator,
  settlementStatusValidator,
} from "./utils/financingEconomics";
import { consignedSettlementRouteValidator } from "./utils/vehicleOwnership";

const organizationDeletionRequestStatus = v.union(
  v.literal("PENDING_REVIEW"),
  v.literal("REJECTED"),
  v.literal("APPROVED"),
  v.literal("RUNNING"),
  v.literal("COMPLETED"),
  v.literal("FAILED")
);

export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    disabled: v.optional(v.boolean()),
    disabledAt: v.optional(v.number()),
    disabledReason: v.optional(v.string()),
    clerkDeletedAt: v.optional(v.number()),
    // Server-known language for email/WhatsApp notifications — the client's
    // locale toggle (LanguageProvider) lives only in localStorage, so this
    // mirrors it server-side whenever an authenticated user changes it.
    locale: v.optional(v.union(v.literal("en"), v.literal("ar"))),
    // Staff member's own WhatsApp number for receiving notifications —
    // distinct from customers.whatsapp (a customer's contact number).
    whatsappPhone: v.optional(v.string()),
  }).index("by_clerkId", ["clerkId"])
    .index("by_email", ["email"]),

  organizations: defineTable({
    name: v.string(),
    createdAt: v.number(),
    suspended: v.optional(v.boolean()),
    suspendedAt: v.optional(v.number()),
    suspendedReason: v.optional(v.string()),
    deletionRequestedAt: v.optional(v.number()),
    deletionRequestId: v.optional(v.id("organizationDeletionRequests")),
    /**
     * SCRUM-208 — WHICH COMMITMENT AUTHORITY THIS DEALERSHIP RUNS ON.
     *
     * Canonical-state admission is ONE per-org rule, not per-field `undefined`
     * semantics reinvented on every column. Before activation the canonical
     * access paths are simply not consulted for authority; after it, a missing
     * canonical field is CORRUPTION rather than a default.
     *
     *   undefined | 0  → legacy
     *   1              → canonical V1
     *   anything else  → REFUSE
     *
     * ⚠️ AN UNSUPPORTED VERSION IS REFUSED, NEVER CLAMPED. "Unknown, so treat
     * it as the newest I know" is how a half-deployed backend silently grants
     * itself authority it was never activated for. Activation is per org, so a
     * cross-tenant sweep legitimately meets both legacy and canonical rows in
     * one batch — that is normal, and never a reason to fail the batch.
     */
    commitmentAuthorityVersion: v.optional(v.number()),
  }),

  organizationDeletionRequests: defineTable({
    orgId: v.id("organizations"),
    orgName: v.string(),
    requestedBy: v.id("users"),
    requestedAt: v.number(),
    reason: v.optional(v.string()),
    status: organizationDeletionRequestStatus,
    reviewedBy: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    reviewNotes: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    failedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    currentStepIndex: v.optional(v.number()),
    deletedCounts: v.optional(v.record(v.string(), v.number())),
    lastProcessedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_status_and_requestedAt", ["status", "requestedAt"]),

  commandIdempotency: defineTable({
    orgId: v.id("organizations"),
    operation: v.string(),
    idempotencyKey: v.string(),
    status: v.union(v.literal("STARTED"), v.literal("COMPLETED")),
    result: v.optional(v.any()),
    // Canonical hash of the request inputs. When present, replaying the same
    // key with materially different inputs is rejected instead of silently
    // returning the prior result.
    fingerprint: v.optional(v.string()),
    createdBy: v.optional(v.id("users")),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  })
    .index("by_org_operation_key", ["orgId", "operation", "idempotencyKey"])
    .index("by_org_createdAt", ["orgId", "createdAt"]),

  // ─── Phase 1 + 2: Accounting foundation and ledger ────────────────────────

  chartOfAccounts: defineTable({
    orgId: v.id("organizations"),
    code: v.string(),
    name: v.string(),
    nameAr: v.optional(v.string()),
    type: v.union(
      v.literal("ASSET"),
      v.literal("LIABILITY"),
      v.literal("EQUITY"),
      v.literal("REVENUE"),
      v.literal("COGS"),
      v.literal("EXPENSE"),
      v.literal("OTHER_INCOME"),
      v.literal("OTHER_EXPENSE"),
    ),
    subtype: v.optional(v.string()),
    normalBalance: v.union(v.literal("DEBIT"), v.literal("CREDIT")),
    parentAccountId: v.optional(v.id("chartOfAccounts")),
    isControlAccount: v.boolean(),
    allowManualPosting: v.boolean(),
    currencyRestriction: v.optional(v.string()),
    active: v.boolean(),
    systemKey: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.optional(v.id("users")),
    updatedAt: v.number(),
    updatedBy: v.optional(v.id("users")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_code", ["orgId", "code"])
    .index("by_org_systemKey", ["orgId", "systemKey"])
    .index("by_org_type", ["orgId", "type"]),

  accountingPeriods: defineTable({
    orgId: v.id("organizations"),
    startDate: v.number(),
    endDate: v.number(),
    fiscalYear: v.number(),
    periodNumber: v.number(),
    status: v.union(
      v.literal("FUTURE"),
      v.literal("OPEN"),
      v.literal("CLOSING"),
      v.literal("CLOSED"),
      v.literal("LOCKED"),
    ),
    closedBy: v.optional(v.id("users")),
    closedAt: v.optional(v.number()),
    reopenedBy: v.optional(v.id("users")),
    reopenedAt: v.optional(v.number()),
    reopenReason: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.optional(v.id("users")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_year_period", ["orgId", "fiscalYear", "periodNumber"])
    .index("by_org_startDate", ["orgId", "startDate"]),

  accountingEvents: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    eventType: v.string(),
    sourceType: v.string(),
    sourceId: v.string(),
    eventVersion: v.number(),
    idempotencyKey: v.string(),
    occurredAt: v.number(),
    accountingDate: v.number(),
    currency: v.string(),
    payload: v.any(),
    payloadHash: v.optional(v.string()),
    status: v.union(
      v.literal("PENDING"),
      v.literal("POSTED"),
      v.literal("FAILED"),
      v.literal("REVERSED"),
    ),
    createdBy: v.id("users"),
    createdAt: v.number(),
    reversedByEventId: v.optional(v.id("accountingEvents")),
    reversalOfEventId: v.optional(v.id("accountingEvents")),
    journalEntryId: v.optional(v.id("journalEntries")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_eventType", ["orgId", "eventType"])
    .index("by_org_source", ["orgId", "sourceType", "sourceId"])
    .index("by_org_idempotency", ["orgId", "idempotencyKey"])
    .index("by_org_event_source_version", ["orgId", "eventType", "sourceType", "sourceId", "eventVersion"])
    // Lets a report load one event type for just its own window instead of the
    // org's whole history — the reversals the operational P&L needs are only
    // ever the ones dated inside the window being reported.
    .index("by_org_eventType_date", ["orgId", "eventType", "accountingDate"]),

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
        v.literal("ACCOUNTING_REVERSED_AUTHORITY_RETRY_EXHAUSTED")
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
  })
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_idempotency", ["orgId", "idempotencyKey"])
    // Lets a cancelled/voided source (e.g. a warranty/GAP deferral whose sale
    // was cancelled) sweep every one of its own not-yet-posted queued POSTs in
    // one query, not just the one idempotencyKey it happens to know about —
    // a recurring source (monthly F&I recognition) can have more than one
    // stuck entry across different periods. See cancelPendingPostsBySource.
    .index("by_org_source", ["orgId", "sourceType", "sourceId"])
    // SCRUM-208 — the repair queue. An authority condition a human must act on
    // is found by an exact range, never by scanning `lastError` for wording.
    .index("by_org_authority_outcome", ["orgId", "authorityOutcome"]),

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
     * BLOCKED — the execution budget is spent. Terminal, and a repair
     *   condition a person must act on; never a silent give-up.
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
        v.literal("ACCOUNTING_REVERSED_AUTHORITY_RETRY_EXHAUSTED")
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

  journalEntries: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    accountingEventId: v.optional(v.id("accountingEvents")),
    journalNumber: v.string(),
    accountingDate: v.number(),
    periodId: v.optional(v.id("accountingPeriods")),
    sourceType: v.string(),
    sourceId: v.string(),
    category: v.union(
      v.literal("SYSTEM"),
      v.literal("MANUAL"),
      v.literal("REVERSAL"),
      v.literal("ADJUSTMENT"),
      v.literal("OPENING_BALANCE"),
    ),
    memo: v.string(),
    status: v.union(
      v.literal("DRAFT"),
      v.literal("VALIDATED"),
      v.literal("POSTED"),
      v.literal("REVERSED"),
    ),
    currency: v.optional(v.string()),
    reversalOfJournalEntryId: v.optional(v.id("journalEntries")),
    reversedByJournalEntryId: v.optional(v.id("journalEntries")),
    postedBy: v.id("users"),
    postedAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_date", ["orgId", "accountingDate"])
    .index("by_org_period", ["orgId", "periodId"])
    .index("by_org_source", ["orgId", "sourceType", "sourceId"])
    .index("by_accounting_event", ["accountingEventId"]),

  journalLines: defineTable({
    orgId: v.id("organizations"),
    journalEntryId: v.id("journalEntries"),
    lineNumber: v.number(),
    accountId: v.id("chartOfAccounts"),
    debitMinor: v.number(),
    creditMinor: v.number(),
    currency: v.string(),
    scale: v.number(),
    accountingDate: v.number(),
    exchangeRate: v.optional(v.number()),
    reportingDebitMinor: v.optional(v.number()),
    reportingCreditMinor: v.optional(v.number()),
    branchId: v.optional(v.id("branches")),
    vehicleId: v.optional(v.id("vehicles")),
    customerId: v.optional(v.id("customers")),
    financeCompanyId: v.optional(v.id("financeCompanies")),
    salespersonId: v.optional(v.id("users")),
    cashierId: v.optional(v.id("users")),
    description: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_journal_entry", ["journalEntryId"])
    .index("by_org_account", ["orgId", "accountId"])
    .index("by_org_account_date", ["orgId", "accountId", "accountingDate"])
    .index("by_org_customer", ["orgId", "customerId"]),

  // ─── Phase 3: Receivables, payments, and allocations subledger ────────────

  receivableDocuments: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    documentType: v.union(
      v.literal("INVOICE"),
      v.literal("INSTALLMENT"),
      v.literal("DEBIT_ADJUSTMENT"),
      v.literal("CREDIT_ADJUSTMENT"),
      v.literal("WRITE_OFF"),
      v.literal("REFUND_PAYABLE"),
    ),
    documentNumber: v.string(),
    payerType: v.union(v.literal("CUSTOMER"), v.literal("FINANCE_COMPANY")),
    customerId: v.optional(v.id("customers")),
    financeCompanyId: v.optional(v.id("financeCompanies")),
    sourceType: v.string(),
    sourceId: v.string(),
    originalAmountMinor: v.number(),
    currency: v.string(),
    scale: v.number(),
    issueDate: v.number(),
    dueDate: v.number(),
    status: v.union(
      v.literal("OPEN"),
      v.literal("PARTIALLY_PAID"),
      v.literal("PAID"),
      v.literal("WRITTEN_OFF"),
      v.literal("CANCELLED"),
      v.literal("REVERSED"),
    ),
    accountingEventId: v.optional(v.id("accountingEvents")),
    reversedDocumentId: v.optional(v.id("receivableDocuments")),
    createdAt: v.number(),
    createdBy: v.id("users"),
    // Set only when status transitions to CANCELLED (saleCancellation.ts).
    // Historical AR reports (arAging, subledgerReconciliation) need this to
    // tell "was open as of asOfDate, cancelled later" (still counts) apart
    // from "already cancelled by asOfDate" (must not count) — the receivable's
    // CURRENT status alone can't make that distinction for a past asOfDate.
    cancelledAt: v.optional(v.number()),
    cancelledBy: v.optional(v.id("users")),
    cancellationReason: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_org_source", ["orgId", "sourceType", "sourceId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_dueDate", ["orgId", "dueDate"]),

  canonicalPayments: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    direction: v.union(v.literal("IN"), v.literal("OUT")),
    payerType: v.optional(v.union(v.literal("CUSTOMER"), v.literal("FINANCE_COMPANY"))),
    customerId: v.optional(v.id("customers")),
    financeCompanyId: v.optional(v.id("financeCompanies")),
    method: v.union(
      v.literal("CASH"),
      v.literal("BANK_TRANSFER"),
      v.literal("CARD"),
      v.literal("PAYMENT_LINK"),
      v.literal("CHEQUE"),
      v.literal("INTERNAL_TRANSFER"),
      v.literal("TRADE_IN"),
      v.literal("OTHER"),
    ),
    amountMinor: v.number(),
    currency: v.string(),
    scale: v.number(),
    receivedAt: v.optional(v.number()),
    verifiedAt: v.optional(v.number()),
    settledAt: v.optional(v.number()),
    status: v.union(
      v.literal("DRAFT"),
      v.literal("PENDING_VERIFICATION"),
      v.literal("VERIFIED"),
      v.literal("PENDING_SETTLEMENT"),
      v.literal("SETTLED"),
      v.literal("FAILED"),
      v.literal("RETURNED"),
      v.literal("REVERSED"),
      v.literal("REFUNDED"),
      v.literal("VOIDED"),
    ),
    externalReference: v.optional(v.string()),
    provider: v.optional(v.string()),
    providerTransactionId: v.optional(v.string()),
    idempotencyKey: v.string(),
    cashierSessionId: v.optional(v.id("cashierReconciliations")),
    originalPaymentId: v.optional(v.id("canonicalPayments")),
    reversalPaymentId: v.optional(v.id("canonicalPayments")),
    accountingEventId: v.optional(v.id("accountingEvents")),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_idempotency", ["orgId", "idempotencyKey"]),

  paymentAllocations: defineTable({
    orgId: v.id("organizations"),
    paymentId: v.id("canonicalPayments"),
    receivableDocumentId: v.id("receivableDocuments"),
    amountMinor: v.number(),
    currency: v.string(),
    scale: v.number(),
    allocationDate: v.number(),
    status: v.union(
      v.literal("ACTIVE"),
      v.literal("REVERSED"),
    ),
    reversalOfAllocationId: v.optional(v.id("paymentAllocations")),
    reversedByAllocationId: v.optional(v.id("paymentAllocations")),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_payment", ["paymentId"])
    .index("by_receivable", ["receivableDocumentId"])
    .index("by_org_status", ["orgId", "status"]),

  // ─── Phase 7: Financial audit log ─────────────────────────────────────────

  financialAuditLog: defineTable({
    orgId: v.id("organizations"),
    actorId: v.id("users"),
    actionType: v.union(
      v.literal("CREATE_PERIOD"),
      v.literal("POST_EVENT"),
      v.literal("POST_MANUAL_JOURNAL"),
      v.literal("CREATE_MANUAL_JOURNAL_DRAFT"),
      v.literal("REJECT_MANUAL_JOURNAL"),
      v.literal("REVERSE_EVENT"),
      v.literal("OPEN_PERIOD"),
      v.literal("CLOSE_PERIOD"),
      v.literal("LOCK_PERIOD"),
      v.literal("REOPEN_PERIOD"),
      v.literal("INIT_CHART"),
      v.literal("UPDATE_ACCOUNT"),
      v.literal("MIGRATE_TRANSACTION"),
      v.literal("ALLOCATE_PAYMENT"),
      v.literal("REVERSE_ALLOCATION"),
      v.literal("IGNORE_BANK_STATEMENT_LINE"),
      v.literal("CORRECT_PREPAID_SCHEDULE"),
      v.literal("REQUEST_PREPAID_CORRECTION"),
      v.literal("APPROVE_PREPAID_CORRECTION"),
      v.literal("REJECT_PREPAID_CORRECTION"),
      v.literal("RESOLVE_SYSTEM_ACCOUNT_ADOPTION"),
      v.literal("ACKNOWLEDGE_CLOSE_WARNINGS"),
      v.literal("SET_COMMISSION_AMOUNT"),
      // Multi-vehicle reservation-deposit allocation — see depositAllocation.ts.
      v.literal("ALLOCATE_DEPOSIT"),
      v.literal("RESOLVE_DEPOSIT_ALLOCATION"),
      v.literal("SET_SUPPLIER_SETTLEMENT_ROUTE"),
      v.literal("CONFIRM_SUPPLIER_DISBURSEMENT"),
      // Correcting a mistyped settlement advice. Distinct from recording one so
      // the audit trail shows an amendment as an amendment — a second
      // CONFIRM would read as a second payment.
      v.literal("AMEND_SUPPLIER_DISBURSEMENT_ADVICE"),
      // The vehicle commitment authority's result after a cancellation —
      // restored, rival, blocked, nothing to restore, or withheld because the
      // organization is not on the canonical authority yet. See
      // utils/saleCancellation.ts.
      v.literal("SETTLE_COMMITMENT_AUTHORITY"),
    ),
    resourceType: v.string(),
    resourceId: v.string(),
    description: v.string(),
    before: v.optional(v.any()),
    after: v.optional(v.any()),
    idempotencyKey: v.optional(v.string()),
    occurredAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_actor", ["orgId", "actorId"])
    .index("by_org_action", ["orgId", "actionType"])
    .index("by_org_action_idempotency", ["orgId", "actionType", "idempotencyKey"])
    .index("by_org_time", ["orgId", "occurredAt"]),

  // ─── Phase 10: True two-person manual-journal approval ────────────────────

  manualJournalDrafts: defineTable({
    orgId: v.id("organizations"),
    status: v.union(
      v.literal("PENDING_APPROVAL"),
      v.literal("POSTED"),
      v.literal("REJECTED"),
    ),
    memo: v.string(),
    lines: v.array(v.object({
      accountId: v.id("chartOfAccounts"),
      debitMinor: v.number(),
      creditMinor: v.number(),
      description: v.optional(v.string()),
    })),
    // SCRUM-50: the accounting date the preparer declared for the economic
    // event. OPTIONAL only so drafts written before SCRUM-50 remain readable —
    // `approveManualJournal` REFUSES a draft without one rather than inferring
    // a date. Every new draft is required to carry it.
    accountingDate: v.optional(v.number()),
    idempotencyKey: v.string(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    reviewedBy: v.optional(v.id("users")),
    decidedAt: v.optional(v.number()),
    rejectionReason: v.optional(v.string()),
    journalEntryId: v.optional(v.id("journalEntries")),
  })
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_time", ["orgId", "createdAt"])
    .index("by_org_idempotency", ["orgId", "idempotencyKey"]),

  // GL Phase 17 hardening: opening balances get the same two-person
  // segregation of duties as manual journals — a direct-lines posting to
  // system-controlled accounts is exactly the highest-risk control point
  // manualJournalDrafts already exists to protect, and a one-time seed entry
  // is no less risky for being one-time. See accountingCutover.ts.
  openingBalanceDrafts: defineTable({
    orgId: v.id("organizations"),
    status: v.union(
      v.literal("PENDING_APPROVAL"),
      v.literal("POSTED"),
      v.literal("REJECTED"),
    ),
    lines: v.array(v.object({
      accountId: v.id("chartOfAccounts"),
      debitMinor: v.number(),
      creditMinor: v.number(),
      description: v.optional(v.string()),
    })),
    asOfDate: v.number(),
    memo: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    // The currency these minor-unit line amounts were ENTERED in, snapshotted
    // at draft time. Not derivable from the org later: orgSettings only locks
    // the org currency once a row exists in one of six financial tables, and
    // openingBalanceDrafts is not one of them — so a fresh org (exactly the
    // onboarding case) could draft in JOD, switch to USD, and approve. Scale is
    // per-currency (3 for JOD/KWD/BHD/OMR, 2 otherwise), so that re-denominates
    // 1,000.000 JOD into 10,000.00 USD with no conversion. Optional because
    // rows drafted before this field existed cannot have it.
    currency: v.optional(v.string()),
    // Display identity of the preparer, snapshotted for the same reason: user
    // rows are hard-deleted on offboarding (memberships.ts), which would leave
    // the approver reviewing a draft prepared by "Unknown" — and the whole
    // point of the two-person control is knowing who the other person was.
    preparedByName: v.optional(v.string()),
    reviewedBy: v.optional(v.id("users")),
    decidedAt: v.optional(v.number()),
    rejectionReason: v.optional(v.string()),
    journalEntryId: v.optional(v.id("journalEntries")),
    // True when an owner posted this without a second approver, via
    // accountingCutover.postOpeningBalanceDirect. Absent on rows that went
    // through the two-person review, and on every row predating that route —
    // so read it as "known to have skipped review", never as "reviewed".
    autoApproved: v.optional(v.boolean()),
  })
    .index("by_org_status", ["orgId", "status"]),

  roles: defineTable({
    orgId: v.id("organizations"), // Roles are scoped to orgs allowing custom roles
    name: v.string(), // "OWNER", "SALES", etc.
    permissions: v.array(v.string()),
    isSystemOwnerRole: v.optional(v.boolean()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  }).index("by_org", ["orgId"]),

  memberships: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    roleId: v.id("roles"),
    branchId: v.optional(v.id("branches")),
    commissionRate: v.optional(v.number()), // % of gross profit per sale
    impersonationGrantId: v.optional(v.id("impersonationGrants")), // set when this membership exists only for an active super-admin impersonation session
    offboardingStatus: v.optional(
      v.union(v.literal("PENDING_EXTERNAL_REMOVAL"), v.literal("EXTERNAL_REMOVAL_RETRYING"))
    ),
    offboardingRequestedAt: v.optional(v.number()),
    offboardingRequestedBy: v.optional(v.id("users")),
    offboardingAttempts: v.optional(v.number()),
    offboardingLastAttemptAt: v.optional(v.number()),
    offboardingLastError: v.optional(v.string()),
    offboardingNextRetryAt: v.optional(v.number()),
    // "Last seen" timestamp for the Team > Members presence indicator. Written
    // by memberships.touchLastSeen, throttled client-side (PresenceTracker)
    // and server-side to a few writes per user per hour — deliberately NOT a
    // live heartbeat/interval, to avoid repeating the liveChatPresence cost
    // (see convex/schema.ts liveChatPresence comment) on a much lower-value feature.
    lastSeenAt: v.optional(v.number()),
    // Opts this member out of the generated-lead round robin (social, website,
    // WhatsApp, marketplace trade-ins). They keep every lead already assigned
    // to them and can still be assigned one by hand — this only removes them
    // from automatic distribution, for someone on leave, a manager who holds
    // the SALES role for reporting, or a rep who shouldn't take new work.
    excludeFromLeadAutoAssignment: v.optional(v.boolean()),
  })
    .index("by_user", ["userId"])
    .index("by_org", ["orgId"])
    .index("by_org_user", ["orgId", "userId"]),

  membershipOffboardingJobs: defineTable({
    membershipId: v.id("memberships"),
    orgId: v.id("organizations"),
    userId: v.id("users"),
    clerkId: v.string(),
    requestedBy: v.id("users"),
    requiresClerkUserDeletion: v.boolean(),
    status: v.union(v.literal("PENDING"), v.literal("RETRYING"), v.literal("SUCCEEDED")),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    lastAttemptAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    succeededAt: v.optional(v.number()),
  })
    .index("by_membership", ["membershipId"])
    .index("by_status_and_nextAttemptAt", ["status", "nextAttemptAt"])
    .index("by_org", ["orgId"]),

  // Cross-tenant, super-admin–only table. A single user deletion can span
  // multiple orgs; orgId is optional (null = global event). All access paths
  // must go through requireSuperAdmin — never exposed to org-scoped queries.
  userOffboardingReviews: defineTable({
    orgId: v.optional(v.id("organizations")),
    userId: v.id("users"),
    clerkId: v.string(),
    source: v.union(v.literal("clerk_user_deleted"), v.literal("admin_requested")),
    status: v.union(v.literal("PENDING_REVIEW"), v.literal("RESOLVED")),
    membershipCount: v.number(),
    ownerOrgIds: v.array(v.id("organizations")),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
    resolvedBy: v.optional(v.id("users")),
    notes: v.optional(v.string()),
  })
    .index("by_org_status", ["orgId", "status"])
    .index("by_status", ["status"])
    .index("by_user", ["userId"])
    .index("by_user_status", ["userId", "status"]),

  invitations: defineTable({
    orgId: v.id("organizations"),
    email: v.string(),
    roleId: v.id("roles"),
    createdBy: v.optional(v.id("users")),
    ownerRoleAuthorizedAt: v.optional(v.number()),
    tokenHash: v.optional(v.string()),
    status: v.optional(
      v.union(v.literal("PENDING"), v.literal("ACCEPTED"), v.literal("EXPIRED"), v.literal("REVOKED"))
    ),
    source: v.optional(v.union(v.literal("EMAIL_INVITE"), v.literal("DIRECT_ACCOUNT"))),
    expiresAt: v.optional(v.number()),
    acceptedAt: v.optional(v.number()),
    acceptedBy: v.optional(v.id("users")),
    updatedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_email", ["email"])
    .index("by_org_email", ["orgId", "email"])
    .index("by_tokenHash", ["tokenHash"])
    .index("by_status_and_expiresAt", ["status", "expiresAt"]),

  vehicles: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    vin: v.optional(v.string()),
    make: v.string(),
    model: v.string(),

    year: v.number(),
    trim: v.optional(v.string()),
    mileage: v.number(),
    color: v.string(),
    fuelType: v.string(),
    transmission: v.string(),
    purchasePrice: v.optional(v.number()), // Might be hidden from salespeople
    landedCostTotal: v.optional(v.number()),
    minimumProfit: v.optional(v.number()), // Preset minimum profit required
    sellingPrice: v.number(),
    status: v.union(
      v.literal("AVAILABLE"),
      v.literal("RESERVED"),
      v.literal("SOLD"),
      v.literal("IN_INSPECTION"),
      v.literal("IN_REPAIR"),
      v.literal("ARCHIVED"),
      v.literal("SOURCING")
    ),
    // The status a deposit/reservation hold promoted this vehicle away from, so
    // releasing the hold restores where it actually came from. Without it, a
    // released hold always fell back to AVAILABLE — which silently converted a
    // special-order car (SOURCING) into what looks like owned stock on the lot.
    // Set when syncVehicleHoldStatus promotes to RESERVED, cleared on release.
    preHoldStatus: v.optional(v.union(v.literal("AVAILABLE"), v.literal("SOURCING"))),
    /**
     * The sale that owns this vehicle's SOLD status.
     *
     * SCRUM-212. `status: "SOLD"` on its own is a projection with no author,
     * so any door holding *a* sale for this car could undo a SOLD that a
     * DIFFERENT, later sale had established — restoring the car out from under
     * a live COMPLETED sale, and leaving it available to sell a third time.
     *
     * Written by `markVehicleAsSold` in the same transition that sets SOLD and
     * cleared by `restoreVehicleFromSale` in the transition that clears it, so
     * every ordinary door keeps the pair consistent.
     *
     * ⚠️ NOT an invariant the database enforces, and an earlier version of this
     * comment overstated it as one. `adminData.adminUpdateRecord` patches
     * `vehicles` with a `v.any` payload and `vehicles` is not in
     * `FINANCIAL_TABLES`, so a super-admin can set SOLD with no owner, or name
     * the wrong one. The guard fails closed for exactly that reason rather than
     * assuming the pair is well-formed. Narrowing that editor is tracked
     * separately (SCRUM-212-R3).
     *
     * NOT a duplicate of `commitmentRoots.consumedBySaleId`, and deliberately
     * not derived from it: `consumeRootForSale` returns early when no open
     * root exists, so that stamp is absent for every sale with no commitment
     * lineage. Sale ownership of the INVENTORY projection has to be answerable
     * for every sale, including those, which is why it lives here.
     */
    soldBySaleId: v.optional(v.id("sales")),
    // Sourced / drop-ship vehicles: dealer locates from another dealer on demand
    sourceType: v.optional(v.union(v.literal("STOCK"), v.literal("SOURCED"))),
    sourcedFromName: v.optional(v.string()),
    sourceCost: v.optional(v.number()),
    // When a sourced car physically reached the dealership. Arrival cannot be
    // expressed through `status`: a special-order car that arrives while a
    // customer deposit is holding it must stay RESERVED, and the status guard
    // refuses to move a vehicle out of RESERVED anyway — so "on order" vs
    // "arrived" had no representation for exactly the cars that need it.
    arrivedAt: v.optional(v.number()),
    notes: v.optional(v.string()),
    imageIds: v.optional(v.array(v.id("_storage"))),
    // Phase 61 — trust passport (widen-only). Dealer self-service form (vehicle
    // create/edit) only ever writes NONE/SELF_REPORTED — PARTNER_VERIFIED is
    // reserved for a future partner-API integration and is set via the admin
    // data browser (convex/adminData.ts ADMIN_TABLES) until that exists.
    inspectionStatus: v.optional(
      v.union(v.literal("NONE"), v.literal("SELF_REPORTED"), v.literal("PARTNER_VERIFIED"))
    ),
    accidentDisclosed: v.optional(v.boolean()),
    ownerCount: v.optional(v.number()),
    dealerGuarantee: v.optional(v.boolean()),
    createdAt: v.optional(v.number()),
    addedBy: v.optional(v.id("users")),
    updatedBy: v.optional(v.id("users")),
    updatedAt: v.optional(v.number()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    // The special-order pipeline wants sourced cars in a few statuses. Without
    // sourceType in the key it had to fetch every AVAILABLE vehicle — the whole
    // lot — and discard almost all of them.
    .index("by_org_sourceType_status", ["orgId", "sourceType", "status"])
    .index("by_org_vin", ["orgId", "vin"])
    .searchIndex("search_make", { searchField: "make", filterFields: ["orgId", "isDeleted"] })
    .searchIndex("search_vin", { searchField: "vin", filterFields: ["orgId", "isDeleted"] }),

  vehicleLandedCosts: defineTable({
    vehicleId: v.id("vehicles"),
    orgId: v.id("organizations"),
    items: v.array(v.object({
      label: v.string(),
      amount: v.number(),
      // Which account this specific line was paid from — persisted per item
      // (not one picker for the whole edit) so a later reduction/removal
      // reverses against the account it actually came from, not whatever's
      // selected on that later call. Optional/backward compatible: rows
      // written before this field existed have none, treated as CASH (the
      // old normalizePaymentMethod default) wherever it's read.
      paymentMethod: v.optional(paymentMethodValidator),
    })),
    total: v.number(),
    updatedAt: v.number(),
    updatedBy: v.id("users"),
  }).index("by_org_vehicle", ["orgId", "vehicleId"]),

  // Audit trail for vehicles.correctAcquisitionCost — preserves the original
  // value whenever a vehicle's already-posted acquisition cost is corrected,
  // since the GL adjustment alone (VEHICLE_ACQUISITION_COST_CORRECTED) doesn't
  // by itself explain why purchasePrice changed after the fact.
  vehicleCostCorrections: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    previousCost: v.number(),
    newCost: v.number(),
    reason: v.string(),
    // Drives the GL counter-account (see ruleVehicleAcquisitionCostCorrected)
    // — optional/backward compatible for corrections that predate this field.
    correctionType: v.optional(v.union(
      v.literal("PRIOR_PERIOD_RESTATEMENT"),
      v.literal("SUPPLIER_INVOICE_ERROR"),
      v.literal("CASH_REFUND"),
      v.literal("VENDOR_CREDIT"),
    )),
    correctedBy: v.id("users"),
    createdAt: v.number(),
  }).index("by_org_vehicle", ["orgId", "vehicleId"]),

  /**
   * One row per historical consigned sale restated from principal to agent
   * basis, written by migrateConsignedSaleBasis.
   *
   * This is the migration's audit trail AND its idempotency key. The GL is
   * already protected — postOrEnqueue drops a duplicate idempotency key — but
   * "it posted nothing the second time" is not the same as being able to show
   * an auditor which sales were touched, by whom, on what evidence, and that
   * the correction left profit unchanged. That is what this table is for, and
   * why it stores the amounts rather than pointing at the journal and hoping.
   *
   * `originalJournalEntryIds` links back to the entries being corrected. The
   * correction is a NEW entry, never an edit of those — the original posting
   * and its restatement both stay on the books, which is the only version of
   * this an auditor can follow.
   */
  consignedSaleCorrections: defineTable({
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
    vehicleId: v.id("vehicles"),
    currency: v.string(),
    originalJournalEntryIds: v.array(v.id("journalEntries")),
    /**
     * How far this correction actually got.
     *
     * The distinction this exists to make: a correction dated into a closed or
     * not-yet-existing period does not post — it queues to the outbox. That is
     * the NORMAL case for historical restatements, since the periods being
     * corrected are usually closed. Recording such a row as done meant the
     * pre-check reported `alreadyCorrected` forever while no journal had ever
     * been written, and a dead-lettered event would never be noticed.
     *
     *  - PENDING_POSTING — the event is durably queued; no journal yet.
     *  - POSTED — the journal exists. Only this counts as corrected.
     *  - FAILED — the event neither posted nor queued, or its outbox entry
     *    dead-lettered. A retry re-raises the event under the same key, so it
     *    cannot double-post; a dead-lettered outbox row must be redriven by an
     *    operator first (accountingOutbox.retryFailed), because postOrEnqueue
     *    treats any unposted queued row as already handled.
     *
     * This tracks the JOURNAL only. Whether the operational ledger was also
     * restated is `reportingBasisStatus` below — two ledgers with two failure
     * modes, and folding them into one status made a queued correction whose
     * transaction row needed a human permanently unpromotable: nothing ever
     * wrote its journal id, and the impact report went on reporting an
     * already-corrected sale as fully overstated, inviting a second manual
     * correction.
     */
    status: v.union(
      v.literal("PENDING_POSTING"),
      v.literal("POSTED"),
      v.literal("FAILED")
    ),
    /** Why the row is FAILED. Absent otherwise. */
    statusReason: v.optional(v.string()),
    /**
     * Whether the sale's `transactions` row was restated onto the agent basis.
     *
     *  - RESTATED — done, or there was no such row to restate.
     *  - REQUIRES_RECONCILIATION — the row could not be identified
     *    unambiguously (a vehicle sold twice, an amount already netted down by
     *    deposits), so it was left alone rather than guessed at. The journal
     *    correction is unaffected and proceeds on its own.
     */
    reportingBasisStatus: v.optional(
      v.union(v.literal("RESTATED"), v.literal("REQUIRES_RECONCILIATION"))
    ),
    /** Why the reporting basis needs a human. Absent when RESTATED. */
    reportingBasisReason: v.optional(v.string()),
    /** The idempotency key of the correcting event, so a retry reuses its identity. */
    eventIdempotencyKey: v.optional(v.string()),
    /**
     * Absent until the correction actually posts. The event is durable either
     * way; only the journal id is not yet knowable.
     */
    correctionJournalEntryId: v.optional(v.id("journalEntries")),
    /** When the journal was confirmed to exist — the moment status became POSTED. */
    postedAt: v.optional(v.number()),
    /**
     * The `transactions` row whose reporting basis was restated to the agent
     * margin, so Sales Reports, Dashboard and P&L agree about a historical
     * sourced month. Absent when the row could not be identified — see
     * REQUIRES_RECONCILIATION.
     */
    recognizedRevenueTransactionId: v.optional(v.id("transactions")),
    revenueReclassifiedMinor: v.number(),
    commissionRecognizedMinor: v.number(),
    cogsReversedMinor: v.number(),
    /**
     * Stored even though it is always zero. The migration's entire licence to
     * run unattended is that it cannot move profit; recording the number it
     * actually computed means a later reader can verify that claim per row
     * instead of taking it on trust.
     */
    netIncomeDeltaMinor: v.number(),
    correctedBy: v.id("users"),
    correctedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_sale", ["orgId", "saleId"])
    .index("by_status", ["status"]),

  /**
   * What a supplier owes the DEALERSHIP on a consigned sale he was paid for
   * directly.
   *
   * The mirror of `vehicleSupplierPayables`, and it exists for the same reason
   * that one does: a general-ledger balance is not a subledger. On the
   * DIRECT_TO_SUPPLIER route the buyer pays the supplier the whole
   * 12,500, the supplier keeps his 9,500 entitlement, and the dealership's
   * 3,000 agency margin stays with him until he settles it. Debiting
   * Receivable from Suppliers records that the money is owed; only this records
   * WHICH deal it is owed on, how much of it has since arrived, when, by what
   * means, and against which reference — the things an aging report and a
   * supplier conversation are actually made of.
   *
   * Supplier identity is snapshot-based for exactly the reason spelled out on
   * `vehicleSupplierPayables.sourcedFromName`: there is no supplier master to
   * point at, and a foreign key to a table that does not exist looks like
   * referential integrity while providing none.
   */
  vehicleSupplierReceivables: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    saleId: v.id("sales"),
    sourcedFromName: v.string(),
    /** The dealership's agency margin on the deal — what the supplier owes back. */
    amountDue: v.number(),
    currency: v.string(),
    status: v.union(
      v.literal("OPEN"),
      v.literal("PARTIALLY_PAID"),
      v.literal("PAID"),
      v.literal("DISPUTED"),
      // Not one of the four the requirement names, and deliberately kept: a
      // sale can be cancelled, and a claim against a deal that no longer exists
      // is not "open". Without it, cancelling would either strand a live
      // receivable or delete the record of one that existed.
      v.literal("CANCELLED")
    ),
    /**
     * Cumulative amount collected. `remainingAmount` is NOT stored — a second
     * copy of a figure derivable from two others is a figure that can disagree
     * with them, and this one decides whether a supplier still owes money.
     */
    amountReceived: v.optional(v.number()),
    receiptMethod: v.optional(paymentMethodValidator),
    /** Cheque number or transfer reference for the most recent receipt. */
    receiptReference: v.optional(v.string()),
    /** The bank or cash account the money arrived in. */
    receiptAccountId: v.optional(v.id("chartOfAccounts")),
    receiptNotes: v.optional(v.string()),
    /**
     * How many receipts have posted. The GL event's idempotency key includes
     * it, so a second instalment of the same amount is a distinct event rather
     * than a duplicate the outbox silently drops.
     */
    receiptSeq: v.optional(v.number()),
    /** When the claim was settled in full. */
    settledAt: v.optional(v.number()),
    settledBy: v.optional(v.id("users")),
    disputeReason: v.optional(v.string()),
    disputedAt: v.optional(v.number()),
    disputedBy: v.optional(v.id("users")),
    cancelledAt: v.optional(v.number()),
    cancelledBy: v.optional(v.id("users")),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_sale", ["orgId", "saleId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_sale", ["saleId"]),

  vehicleSupplierPayables: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    saleId: v.optional(v.id("sales")),
    // Supplier identity is SNAPSHOT-BASED for this workflow, deliberately.
    // No canonical supplier entity exists in AutoFlow — suppliers are a name on
    // a vehicle — so there is nothing for a `supplierId` to point at. Do not
    // fabricate or persist one until supplier master data is introduced: a
    // foreign key to a table that does not exist is worse than an honest name,
    // because it looks like referential integrity and provides none.
    //
    // Introduce a supplier master separately if AutoFlow needs statements
    // across multiple vehicles, supplier-level aging, contact or tax identity,
    // consolidated balances, or supplier analytics. That is a subsystem with
    // its own lifecycle, permissions, deduplication and migration — not a field
    // to be smuggled into an accounting correction.
    sourcedFromName: v.string(),
    amountDue: v.number(),
    currency: v.string(),
    // PENDING is retained permanently as a legacy value. Every row written
    // before consigned-agent accounting carries it, and dropping it from the
    // union would make those rows unreadable — a schema change that destroys
    // access to existing payables is a worse outcome than one extra literal.
    // `deriveSettlementStatus` maps it to DUE_ON_SALE for every reader.
    status: v.union(
      v.literal("PENDING"),
      v.literal("NOT_YET_DUE"),
      v.literal("DUE_ON_SALE"),
      v.literal("PARTIALLY_PAID"),
      v.literal("PAID"),
      v.literal("DISPUTED"),
      v.literal("CANCELLED")
    ),
    // How `amountDue` was arrived at. Recorded rather than inferred: the same
    // number reached by an agreed cost and by a percentage of the sale means
    // different things when the sale price later changes.
    settlementCalculationMethod: v.optional(
      v.union(
        v.literal("AGREED_SOURCE_COST"),
        v.literal("PERCENTAGE_OF_SALE"),
        v.literal("FIXED_AMOUNT"),
        v.literal("OTHER")
      )
    ),
    settlementCalculationNote: v.optional(v.string()),
    // Cumulative. `remainingAmount` is deliberately NOT stored — a second copy
    // of a figure derivable from two others is a figure that can disagree with
    // them, and this one decides whether a supplier is still owed money.
    amountPaid: v.optional(v.number()),
    /**
     * How many payments have posted. Carried into the GL event's version and
     * idempotency key, because `postAccountingEvent` dedupes on
     * (eventType, sourceType, sourceId, eventVersion) — without it a second
     * instalment silently returns "already posted" and the ledger records one
     * payment where the subledger records several.
     */
    paymentSeq: v.optional(v.number()),
    paymentDueTrigger: v.optional(
      v.union(
        v.literal("ON_SALE"),
        v.literal("ON_SETTLEMENT_RECEIPT"),
        v.literal("FIXED_DATE"),
        v.literal("ON_DEMAND")
      )
    ),
    paymentDueDate: v.optional(v.number()),
    paidAt: v.optional(v.number()),
    paidBy: v.optional(v.id("users")),
    paymentMethod: v.optional(paymentMethodValidator),
    /** Cheque number or transfer reference. */
    paymentReference: v.optional(v.string()),
    /** The bank or cash account the payment left. */
    paymentAccountId: v.optional(v.id("chartOfAccounts")),
    paymentNotes: v.optional(v.string()),
    documentStorageIds: v.optional(v.array(v.id("_storage"))),
    disputedAt: v.optional(v.number()),
    disputedBy: v.optional(v.id("users")),
    disputeReason: v.optional(v.string()),
    // Portion of amountDue that is input VAT paid to the supplier (tax-inclusive,
    // not additive) — feeds the VAT return's input side. Optional/backward compatible.
    taxAmount: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    cancelledBy: v.optional(v.id("users")),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_vehicle", ["vehicleId"])
    .index("by_sale", ["saleId"])
    .index("by_org_status", ["orgId", "status"]),

  vehiclePriceHistory: defineTable({
    vehicleId: v.id("vehicles"),
    orgId: v.id("organizations"),
    oldPrice: v.number(),
    newPrice: v.number(),
    changedBy: v.id("users"),
    changedAt: v.number(),
  }).index("by_org_vehicle", ["orgId", "vehicleId"]),

  /**
   * When a vehicle stopped being the supplier's and became the dealership's.
   *
   * Ownership itself is derived from `sourceType` (see utils/vehicleOwnership),
   * which makes the current state impossible to contradict — but it also means
   * the past is gone the moment the flag flips. A car sold last month as the
   * supplier's agent and bought in this week would read, forever after, as
   * ordinary stock the dealership always owned, and the agent-basis sale behind
   * it would look like a mistake rather than what was correct at the time.
   *
   * Append-only. Nothing here is ever edited: a conversion recorded wrongly is
   * corrected by a further row, because the whole point is that the sequence
   * survives.
   */
  vehicleOwnershipConversions: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    fromSourceType: v.union(v.literal("STOCK"), v.literal("SOURCED")),
    toSourceType: v.union(v.literal("STOCK"), v.literal("SOURCED")),
    /** Snapshotted, not joined: the supplier's name on the vehicle can change afterwards. */
    supplierName: v.optional(v.string()),
    /** What the supplier was owed while it was consigned, as it stood at conversion. */
    supplierEntitlementAtConversion: v.optional(v.number()),
    /** What the dealership agreed to buy it for. */
    purchaseAmount: v.optional(v.number()),
    purchaseDate: v.optional(v.number()),
    paymentMethod: v.optional(v.string()),
    /** The payable this conversion created or settled, when one exists. */
    supplierPayableId: v.optional(v.id("vehicleSupplierPayables")),
    documentStorageIds: v.optional(v.array(v.id("_storage"))),
    notes: v.optional(v.string()),
    convertedBy: v.id("users"),
    convertedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"]),

  vehicleReservations: defineTable({
    vehicleId: v.id("vehicles"),
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    depositAmount: v.optional(v.number()),
    depositAmountMinor: v.optional(v.number()),
    depositCurrency: v.optional(v.string()),
    depositMethod: v.optional(v.union(
      v.literal("CASH"),
      v.literal("BANK_TRANSFER"),
      v.literal("PAYMENT_LINK"),
      v.literal("CARD"),
      v.literal("CHEQUE"),
      v.literal("OTHER")
    )),
    depositId: v.optional(v.id("deposits")),
    expiresAt: v.optional(v.number()),
    status: v.union(v.literal("ACTIVE"), v.literal("RELEASED"), v.literal("CONVERTED"), v.literal("EXPIRED")),
    reservedBy: v.id("users"),
    reservedAt: v.number(),
    releasedAt: v.optional(v.number()),
    releasedBy: v.optional(v.id("users")),
    expiredAt: v.optional(v.number()),
    /**
     * SCRUM-208 — the CURRENT episode this reservation holds its car through.
     *
     * A reservation holds exactly one vehicle, so a scalar is sufficient and a
     * pointer set would be a lie about the cardinality. Maintained across
     * restoration rather than rediscovered: `by_reservation` is a bare history
     * locator that answers "every episode this reservation ever had", which is
     * not the same question as "which episode is live now".
     */
    currentCommitmentClaimId: v.optional(v.id("vehicleCommitmentClaims")),
  })
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_org_vehicle_status", ["orgId", "vehicleId", "status"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_status_expiresAt", ["status", "expiresAt"])
    // SCRUM-208 — EXPIRY-AWARE LIVENESS, EXACT IN THE INDEX.
    //
    // Reservation liveness needs TWO exact ranges, because `expiresAt` is
    // optional and an absent value is a legitimate "never expires":
    //
    //   ACTIVE with expiresAt absent            → live
    //   ACTIVE with expiresAt > decisionNow     → live
    //
    // An absent `expiresAt` can never satisfy a `>` comparison, so folding
    // both into one range would silently drop every non-expiring reservation.
    //
    // ⚠️ THE RANGE MUST EXPRESS LIVE BEFORE ANYTHING IS TAKEN. Loading ACTIVE
    // rows and testing expiry afterwards is prohibited: a page filled with
    // expired-but-unswept rows hides the live one behind them, and the caller
    // reads "nothing holds this car" from a bounded page rather than from the
    // data.
    .index("by_org_vehicle_status_expiresAt", ["orgId", "vehicleId", "status", "expiresAt"]),

  vehicleStatusRequests: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    requestedBy: v.id("users"),
    requestedStatus: v.union(
      v.literal("AVAILABLE"),
      v.literal("RESERVED"),
      v.literal("SOLD"),
      v.literal("IN_INSPECTION"),
      v.literal("IN_REPAIR"),
      v.literal("ARCHIVED")
    ),
    notes: v.optional(v.string()),
    status: v.union(v.literal("PENDING"), v.literal("APPROVED"), v.literal("REJECTED")),
    resolvedBy: v.optional(v.id("users")),
    resolvedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_vehicle", ["vehicleId"]),

  vehicleEdits: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.optional(v.id("vehicles")), // Null means it's a creation request
    requestedBy: v.id("users"),
    type: v.union(v.literal("CREATE"), v.literal("UPDATE")),
    payload: v.object({
      vin: v.optional(v.string()),
      make: v.optional(v.string()),
      model: v.optional(v.string()),
      year: v.optional(v.number()),
      trim: v.optional(v.string()),
      mileage: v.optional(v.number()),
      color: v.optional(v.string()),
      fuelType: v.optional(v.string()),
      transmission: v.optional(v.string()),
      purchasePrice: v.optional(v.number()),
      purchasePaymentMethod: v.optional(acquisitionPaymentMethodValidator),
      minimumProfit: v.optional(v.number()),
      sellingPrice: v.optional(v.number()),
      status: v.optional(v.string()),
      sourceType: v.optional(v.union(v.literal("STOCK"), v.literal("SOURCED"))),
      sourcedFromName: v.optional(v.string()),
      sourceCost: v.optional(v.number()),
      notes: v.optional(v.string()),
      imageIds: v.optional(v.array(v.id("_storage"))),
      ...trustPassportFieldValidators,
    }), // The partial vehicle data
    status: v.union(v.literal("PENDING"), v.literal("APPROVED"), v.literal("REJECTED")),
    resolvedBy: v.optional(v.id("users")),
    resolvedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"]),

  customers: defineTable({
    orgId: v.id("organizations"),
    firstName: v.string(),
    lastName: v.string(),
    phone: v.optional(v.string()),
    whatsapp: v.optional(v.string()),
    instagramUserId: v.optional(v.string()),
    facebookUserId: v.optional(v.string()),
    email: v.optional(v.string()),
    nationalId: v.optional(v.string()),
    address: v.optional(v.string()),
    employment: v.optional(
      v.object({
        employer: v.string(),
        title: v.optional(v.string()),
        salary: v.number(),
        hireDate: v.optional(v.number()),
      })
    ),
    financials: v.optional(
      v.object({
        totalMonthlyDebt: v.number(),
        dbr: v.optional(v.number()), // Debt Burden Ratio
      })
    ),
    createdAt: v.optional(v.number()),
    createdBy: v.optional(v.id("users")),
    source: v.optional(v.string()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_email", ["orgId", "email"])
    .index("by_org_phone", ["orgId", "phone"])
    .index("by_org_whatsapp", ["orgId", "whatsapp"])
    .searchIndex("search_firstName", { searchField: "firstName", filterFields: ["orgId", "isDeleted"] })
    .searchIndex("search_lastName", { searchField: "lastName", filterFields: ["orgId", "isDeleted"] }),

  customerMerges: defineTable({
    orgId: v.id("organizations"),
    survivorId: v.id("customers"),
    loserId: v.id("customers"),
    mergedBy: v.id("users"),
    mergedAt: v.number(),
    reassignedCounts: v.record(v.string(), v.number()),
  }).index("by_org", ["orgId"]),

  leads: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    customerId: v.id("customers"),
    assignedUserId: v.optional(v.id("users")),
    vehicleId: v.optional(v.id("vehicles")),
    source: v.string(),
    // Structured attribution alongside the free-text `source` above — see
    // docs/dealer_network_marketplace_master_plan.md Phase 58. Only
    // "marketplace" is a defined value today; kept a loose string (not a
    // union) so future sources (e.g. the Social Command Center spine) don't
    // require a schema migration to add a literal.
    sourceChannel: v.optional(v.string()),
    marketplaceRequestId: v.optional(v.id("marketplaceRequests")),
    stage: v.union(
      v.literal("NEW"),
      v.literal("CONTACTED"),
      v.literal("INTERESTED"),
      v.literal("TEST_DRIVE"),
      v.literal("NEGOTIATION"),
      v.literal("RESERVED"),
      v.literal("WON"),
      v.literal("LOST")
    ),
    notes: v.optional(v.string()),
    createdBy: v.optional(v.id("users")),
    updatedAt: v.optional(v.number()),
    updatedBy: v.optional(v.id("users")),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_stage", ["orgId", "stage"])
    .index("by_org_assigned", ["orgId", "assignedUserId"])
    .index("by_org_customer", ["orgId", "customerId"]),

  // Append-only audit trail for leads. Rows are never patched or deleted —
  // not even when the lead itself is soft-deleted — so the timeline stays
  // truthful across a delete/restore cycle. Every writer funnels through
  // convex/utils/leadActivity.ts; one row per changed field, so a single
  // `leads.update` that moves stage and salesperson emits two rows.
  leadActivities: defineTable({
    orgId: v.id("organizations"),
    leadId: v.id("leads"),
    // Absent for automation writes with no signed-in caller: social webhooks,
    // marketplace conversions, and stage advances triggered by a test drive
    // or a completed sale. `actorLabel` names the source in that case.
    actorUserId: v.optional(v.id("users")),
    actorLabel: v.optional(v.string()),
    action: v.union(
      v.literal("CREATED"),
      v.literal("STAGE_CHANGED"),
      v.literal("ASSIGNED"),
      v.literal("UNASSIGNED"),
      v.literal("UPDATED"),
      v.literal("DELETED"),
      v.literal("RESTORED"),
      // A salesperson's own progress update. The only action a user can author
      // directly, and still append-only: each update is its own row rather
      // than an overwrite of the lead's single `notes` field, so the history
      // of what was tried survives instead of being replaced.
      v.literal("NOTE")
    ),
    // The lead column that moved. Values are stored as rendered strings, not
    // raw ids, so the timeline still reads correctly after the referenced
    // customer/vehicle/user row is renamed or removed.
    field: v.optional(v.string()),
    fromValue: v.optional(v.string()),
    toValue: v.optional(v.string()),
    note: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_org_lead", ["orgId", "leadId", "createdAt"])
    .index("by_org_created", ["orgId", "createdAt"]),

  sales: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    vehicleId: v.id("vehicles"),
    customerId: v.id("customers"),
    salespersonId: v.id("users"),
    salePrice: v.number(),
    saleDate: v.number(), // timestamp
    status: v.union(v.literal("PENDING"), v.literal("COMPLETED"), v.literal("CANCELLED")),
    idempotencyKey: v.optional(v.string()),

    // Deal Structuring Fields
    taxRate: v.optional(v.number()),
    taxAmount: v.optional(v.number()),
    dealerFees: v.optional(v.number()),
    downPayment: v.optional(v.number()),
    tradeInVehicleId: v.optional(v.id("vehicles")),
    tradeInValue: v.optional(v.number()),
    financingType: v.optional(v.union(v.literal("CASH"), v.literal("FINANCED"), v.literal("LEASE"))),
    loanAmount: v.optional(v.number()),
    apr: v.optional(v.number()),
    termMonths: v.optional(v.number()),
    warrantySold: v.optional(v.number()),
    gapSold: v.optional(v.number()),
    // Portion of warrantySold/gapSold owed to the third-party underwriter
    // (dealer resells, doesn't underwrite) — the remainder is the dealer's
    // own margin, deferred and recognized ratably over the term below. Same
    // decimal-major-unit convention as every other money field on this table
    // (salePrice, dealerFees, warrantySold, ...); converted to minor units
    // only at GL-posting time. See ruleSaleCompleted and dealerProductDeferrals.
    warrantyCost: v.optional(v.number()),
    warrantyTermMonths: v.optional(v.number()),
    gapCost: v.optional(v.number()),
    gapTermMonths: v.optional(v.number()),
    applicationId: v.optional(v.id("financeApplications")),
    quoteId: v.optional(v.id("quotes")),
    leadId: v.optional(v.id("leads")),
    // Where the buyer's money went on a consigned (SOURCED) sale, recorded per
    // deal because it is a fact about the agreement rather than about the
    // vehicle. THROUGH_DEALERSHIP: gross landed in the dealership's account on
    // the supplier's behalf, so his share is a liability from the moment it
    // arrives. DIRECT_TO_SUPPLIER: the buyer paid the supplier, nothing gross
    // ever reached these books, and the only asset is the margin he now owes
    // back.
    //
    // Absent on every non-consigned sale and on consigned rows written before
    // the route was recorded; readers must treat absent as THROUGH_DEALERSHIP,
    // which is what those rows actually posted (see
    // consignedSettlementRoute()). It is deliberately NOT defaulted at write
    // time, so a row that predates the field stays distinguishable from one
    // where somebody chose THROUGH_DEALERSHIP.
    supplierSettlementRoute: v.optional(
      v.union(v.literal("THROUGH_DEALERSHIP"), v.literal("DIRECT_TO_SUPPLIER"))
    ),
    /**
     * What the dealership earned on a consigned sale, in minor units, frozen at
     * completion. Written on every sourced sale — INCLUDING a zero — because
     * zero is the fact that most needs recording.
     *
     * Absent means the row predates this field, and readers must treat that as
     * UNKNOWN rather than as zero. Never defaulted at write time, for the same
     * reason `supplierSettlementRoute` above is not.
     *
     * The cockpit previously inferred a zero margin from the ABSENCE of a
     * `vehicleSupplierReceivables` row, on the grounds that sale completion
     * opens one only when the margin is positive. That inference was unsound:
     * absence is also what a legacy sale looks like, and what a `hardDeleteOrg`
     * that fails between deleting receivables and deleting sales leaves behind.
     * Either way the screen would have reported a deal settled with money still
     * uncollected. A fact this important is recorded, not deduced from a gap.
     */
    consignedMarginMinor: v.optional(v.number()),
    /**
     * The currency `consignedMarginMinor` is denominated in — the org's, as it
     * stood when the sale completed.
     *
     * Stored rather than assumed, like every other money row in this schema
     * (`vehicleSupplierReceivables.currency`, `financeDealFees.currency`,
     * `deposits.currency`). The cockpit resolves its own currency from
     * `financeApplications.economicsCurrency`, and `orgSettings` does not count
     * `financeApplications` among the rows that lock an org's currency — so a
     * young org can record deal economics in JOD and later switch to USD. The
     * reader would then have subtracted USD cents from JOD fils and published
     * the difference as profit.
     */
    consignedMarginCurrency: v.optional(v.string()),
    /**
     * What the supplier is owed for the car, in minor units, frozen at
     * completion — his entitlement, denominated in `consignedMarginCurrency`.
     *
     * Recorded rather than re-derived because every later reader needs it and
     * every source it could be re-derived FROM can move underneath them: the
     * vehicle's `sourceCost` is editable, and the capitalized cost is a sum over
     * rows that can be added after the sale. The cockpit renders this as the
     * supplier's settlement line on both routes.
     *
     * Cancellation does NOT read it: `makeReversalHook` reverses the original
     * journal entry line for line, which is stronger — it cannot disagree with
     * what was posted even if this field were wrong. Said explicitly because the
     * opposite claim was written here first, and a comment that overstates who
     * depends on a field is how a field survives long after its last reader.
     *
     * Absent means the row predates this field: UNKNOWN, never zero. A zero
     * entitlement and an unrecorded one are different facts, and only one of
     * them means "the supplier is owed nothing".
     */
    consignedSupplierEntitlementMinor: v.optional(v.number()),
    /**
     * What a third party paid the supplier DIRECTLY, in minor units, frozen at
     * completion. Written only on the direct route; absent on
     * THROUGH_DEALERSHIP, where nobody pays him directly and the dealership
     * owes him his entitlement as a payable instead.
     *
     * On a cash direct sale this is the sale price — the buyer pays him. On a
     * financed direct sale it is the finance company's approved purchase
     * amount, which is frequently NOT the sale price. Recording which quantity
     * actually applied is what stops a later reader from assuming the sale
     * price and reopening the defect this field was added to close: the
     * dealership's claim is `this − entitlement`, so a claim can never exceed
     * the dealership money the supplier is genuinely holding.
     *
     * Read by `sales.recalculateCommission`, which measures the salesperson's
     * commission on what this sale actually recognized. On a FINANCED direct row
     * its absence is refused rather than defaulted — see `commissionableEarnings`
     * in convex/utils/saleCompletion.ts.
     */
    consignedSupplierGrossReceiptMinor: v.optional(v.number()),
    canonicalReceivableDocumentId: v.optional(v.id("receivableDocuments")),
    commissionAmount: v.optional(v.number()), // Calculated at sale time
    // How many COMMISSION_ADJUSTED corrections have been posted against this
    // sale's accrual. Monotonic, never reset — it discriminates each
    // correction's idempotency key (see hookCommissionAdjusted), so reusing a
    // number would make the ledger silently drop a real correction. Absent on
    // rows that predate corrections, and on any commission never corrected.
    commissionAdjustmentSeq: v.optional(v.number()),
    commissionPaidAt: v.optional(v.number()),
    commissionPaidBy: v.optional(v.id("users")),
    commissionPaymentMethod: v.optional(paymentMethodValidator),
    commissionPaymentIdempotencyKey: v.optional(v.string()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_salesperson", ["orgId", "salespersonId"])
    // Same ordering guarantee as by_org_saleDate, but scoped to one
    // salesperson. by_org_salesperson orders by _creationTime, so paging a
    // single rep's commissions through it would order by when the row was
    // created rather than the sale date the UI sorts and displays — a draft
    // created early but completed later would land in the wrong page.
    .index("by_org_salesperson_saleDate", ["orgId", "salespersonId", "saleDate"])
    .index("by_org_saleDate", ["orgId", "saleDate"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_quote", ["quoteId"])
    .index("by_lead", ["leadId"]),

  // GL Phase 19: the dealer's margin on a resold warranty/GAP product is
  // deferred at sale and recognized ratably over the product's term — one row
  // per product per sale. Same recognized/lastRecognizedYearMonth tracking
  // shape as fixedAssets' depreciation fields; see crons.ts's monthly
  // fi-commission-recognition job and recognizeDeferredCommissionForMonth.
  dealerProductDeferrals: defineTable({
    orgId: v.id("organizations"),
    saleId: v.id("sales"),
    productType: v.union(v.literal("WARRANTY"), v.literal("GAP")),
    totalMarginMinor: v.number(),
    currency: v.string(),
    termMonths: v.number(),
    recognizedMinor: v.number(),
    // Contractual month count actually recognized so far — distinct from
    // recognizedMinor/lastRecognizedYearMonth, which alone can't tell
    // recognizeDeferredCommissionForMonth whether the *next* call is the
    // final contractual month (the one that must absorb the remainder so the
    // deferral finishes in exactly termMonths, not termMonths+1).
    monthsRecognized: v.optional(v.number()),
    lastRecognizedYearMonth: v.optional(v.string()), // "YYYY-MM"
    status: v.union(v.literal("ACTIVE"), v.literal("FULLY_RECOGNIZED"), v.literal("CANCELLED")),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_status", ["status"])
    .index("by_sale", ["saleId"]),

  // One row per PREPAID expense: its full amount is capitalized to the Prepaid
  // Expenses asset when paid, then released to the matching operating-expense
  // account ratably over termMonths by the monthly amortization cron. Same
  // shape and recognition discipline as dealerProductDeferrals above (idempotent
  // per yearMonth, strict month ordering, final month absorbs the remainder).
  prepaidExpenseSchedules: defineTable({
    orgId: v.id("organizations"),
    expenseId: v.id("expenses"),
    currency: v.string(),
    totalMinor: v.number(),
    termMonths: v.number(),
    // The expense-category account the released amount is booked to (e.g.
    // RENT_EXPENSE). Stored so recognition posts to the same account the
    // original expense would have hit, without re-deriving from category later.
    expenseSystemKey: v.string(),
    startYearMonth: v.string(), // "YYYY-MM" — the month recognition begins (expense.date's month, or expense.amortizationStartDate's if given)
    recognizedMinor: v.number(),
    // Contractual month count actually recognized so far — distinct from
    // recognizedMinor/lastRecognizedYearMonth, which alone can't tell the
    // recognizer whether the *next* call is the final contractual month (the
    // one that must absorb the remainder so the schedule finishes in exactly
    // termMonths, not termMonths+1).
    monthsRecognized: v.optional(v.number()),
    lastRecognizedYearMonth: v.optional(v.string()), // "YYYY-MM"
    status: v.union(
      v.literal("ACTIVE"),
      v.literal("FULLY_AMORTIZED"),
      v.literal("CANCELLED"),
    ),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_status", ["status"])
    .index("by_expense", ["expenseId"]),

  // One row per failed cron catch-up attempt on a schedule — the cron's
  // aggregate stats.failed counter used to discard which schedule/org/error
  // caused a failure, leaving nothing an accountant or support engineer could
  // act on. Kept until resolvedAt is set (by a successful manual retry).
  prepaidAmortizationFailures: defineTable({
    orgId: v.id("organizations"),
    scheduleId: v.id("prepaidExpenseSchedules"),
    yearMonth: v.string(), // the run's target month when the failure occurred
    errorMessage: v.string(),
    createdAt: v.number(),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_schedule", ["scheduleId"]),

  // Audit trail for a schedule correction (partial refund, non-refundable
  // write-off, or term change) — the only way to adjust a schedule short of
  // the full reversal path. One row per correction event; scheduleView reads
  // the schedule's own totalMinor/termMonths for current state, this table is
  // the "what happened and why" history for the accountant-facing UI.
  prepaidScheduleCorrections: defineTable({
    orgId: v.id("organizations"),
    scheduleId: v.id("prepaidExpenseSchedules"),
    refundMinor: v.number(), // cash/bank refund received for the unused portion, 0 if none
    refundTaxMinor: v.optional(v.number()), // VAT portion of the refund, 0/undefined if none
    refundPaymentMethod: v.optional(paymentMethodValidator),
    writeOffMinor: v.number(), // non-refundable unused portion expensed immediately, 0 if none
    previousTermMonths: v.number(),
    newTermMonths: v.number(),
    reason: v.string(),
    reference: v.optional(v.string()), // vendor credit-note / reference number, refund corrections only
    // The date the correction's GL entries book at, when the accountant chose
    // one rather than taking "now" — a credit note received 30 June and entered
    // 3 July belongs in June. Absent on term-only corrections (they post
    // nothing) and on every row written before this was offered, which booked
    // at their own createdAt.
    accountingDate: v.optional(v.number()),
    actorId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_schedule", ["scheduleId"]),

  // Maker-checker gate for a non-owner's write-off correction (an asset ->
  // P&L accelerated expense — the highest-risk correction shape). Refund-only
  // and term-only corrections, and any correction submitted by the owner,
  // apply immediately via prepaidExpenseSchedules.correctSchedule and never
  // create a row here. Same pending -> approved/rejected idiom as
  // profitApprovalRequests / vehicleStatusRequests.
  prepaidCorrectionRequests: defineTable({
    orgId: v.id("organizations"),
    scheduleId: v.id("prepaidExpenseSchedules"),
    refundMinor: v.number(),
    refundTaxMinor: v.optional(v.number()),
    refundPaymentMethod: v.optional(paymentMethodValidator),
    writeOffMinor: v.number(),
    newTermMonths: v.number(),
    reason: v.string(),
    reference: v.optional(v.string()),
    // Carried from request to approval so the approver books the date the maker
    // meant, not the date they happened to click. Re-validated on approval —
    // its period can close in between.
    accountingDate: v.optional(v.number()),
    status: v.union(v.literal("PENDING"), v.literal("APPROVED"), v.literal("REJECTED")),
    requestedBy: v.id("users"),
    decidedBy: v.optional(v.id("users")),
    decidedAt: v.optional(v.number()),
    decisionNote: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_org_status", ["orgId", "status"])
    .index("by_schedule", ["scheduleId"]),

  expenses: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    vehicleId: v.optional(v.id("vehicles")), // Optional because there might be general expenses
    title: v.string(), // e.g., "Brake replacement", "Detailing", "Office supplies"
    amount: v.number(),
    date: v.number(),
    category: v.union(
      v.literal("REPAIR"),
      v.literal("MAINTENANCE"),
      v.literal("DETAILING"),
      v.literal("TRANSPORT"),
      v.literal("MARKETING"),
      v.literal("OFFICE"),
      v.literal("SALARIES"),
      v.literal("RENT"),
      v.literal("UTILITIES"),
      v.literal("FEES"),
      v.literal("PREPAID"),
      v.literal("OTHER")
    ),
    isPrepaid: v.optional(v.boolean()),
    amortizationMonths: v.optional(v.number()),
    // When the prepaid coverage/service actually begins, if later than `date`
    // (e.g. insurance paid in June covering July onward). Optional — defaults
    // to `date` when absent, preserving old behavior for every existing row.
    amortizationStartDate: v.optional(v.number()),
    // Portion of amount that is input VAT paid (tax-inclusive, not additive) —
    // feeds the VAT return's input side. Optional/backward compatible.
    taxAmount: v.optional(v.number()),
    status: v.optional(v.union(v.literal("PENDING"), v.literal("PAID"))),
    idempotencyKey: v.optional(v.string()),
    paymentMethod: v.optional(paymentMethodValidator),
    vendor: v.optional(v.string()),
    payerId: v.optional(v.id("users")),
    notes: v.optional(v.string()),
    // Set once, at posting time (recordPaidExpenseSideEffects), from the same
    // capitalizeToInventory decision that drove the GL posting — never
    // re-derived from category/vehicle-status later, so a vehicle sold after
    // this expense was capitalized can't retroactively change history, and a
    // post-sale repair correctly expensed to GL can't retroactively get pulled
    // into a vehicle's cost basis. capitalizedAmount is the exact net-of-VAT
    // amount actually debited to Vehicle Inventory (see computeVehicleCapitalizedCost).
    accountingTreatment: v.optional(
      v.union(v.literal("CAPITALIZED_INVENTORY"), v.literal("PERIOD_EXPENSE"))
    ),
    capitalizedAmount: v.optional(v.number()),
    // Accounting date of the offsetting reversal entry, set by
    // expenses.reverseExpense to the same instant it hands reverseAccountingEvent
    // as reversalDate. reverseExpense also soft-deletes the row, so this is what
    // lets the operational P&L tell "reversed" (really posted, really expensed in
    // its own month, credited back in a later one) apart from "deleted before it
    // ever posted" (no GL footprint, correctly invisible) — without it, filtering
    // isDeleted silently erased posted history from the report while the ledger
    // kept it. Absent on rows reversed before this field existed until
    // backfillExpenseReversedAt runs.
    reversedAt: v.optional(v.number()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_org_date", ["orgId", "date"])
    // Finds expenses whose *reversal* lands in a reporting window even though
    // the expense itself is dated long before it — a date-range scan over
    // `by_org_date` would never reach them.
    .index("by_org_reversedAt", ["orgId", "reversedAt"]),

  tasks: defineTable({
    orgId: v.id("organizations"),
    assignedTo: v.id("users"), // The salesperson or employee responsible
    title: v.string(),
    description: v.optional(v.string()),
    dueDate: v.number(), // Timestamp for the deadline/schedule
    status: v.union(v.literal("PENDING"), v.literal("COMPLETED"), v.literal("CANCELLED")),
    priority: v.optional(v.union(v.literal("HIGH"), v.literal("MEDIUM"), v.literal("LOW"))),
    statusNote: v.optional(v.string()), // Notes when cancelled or rescheduled
    communicationMethod: v.optional(v.union(v.literal("PHONE"), v.literal("EMAIL"), v.literal("FAX"))),
    alarmTriggered: v.optional(v.boolean()), // Track if the cron has sent the notification
    // Optional associations
    customerId: v.optional(v.id("customers")),
    leadId: v.optional(v.id("leads")),
    vehicleId: v.optional(v.id("vehicles")),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_assignedTo", ["orgId", "assignedTo"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_status_alarm", ["status", "alarmTriggered"])
    .index("by_org_customer", ["orgId", "customerId"]),

  taskHistory: defineTable({
    orgId: v.id("organizations"),
    taskId: v.id("tasks"),
    userId: v.id("users"),
    action: v.union(
      v.literal("CREATE"),
      v.literal("UPDATE"),
      v.literal("RESCHEDULE"),
      v.literal("CANCEL"),
      // Additive, mirroring leadActivity's own DELETED literal. CANCEL already
      // means something different and user-visible (the task stayed, its status
      // changed), so reusing it would make the trail lie about what happened.
      // The row outlives the task deliberately: getHistory hides a deleted
      // task, but the entry is what makes the deletion answerable for later.
      v.literal("DELETE"),
      v.literal("STATUS_CHANGE")
    ),
    details: v.string(),
    note: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_task", ["taskId"]),

  notifications: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    // Legacy plain-text fields — kept for old rows and for admin-authored
    // broadcasts (type: "system.announcement"), which skip the registry
    // since a super admin types free-form text rather than picking a key.
    title: v.optional(v.string()),
    message: v.optional(v.string()),
    // New typed path: a key into lib/notifications/types.ts, rendered
    // bilingually via lib/notifications/render.ts using `data`.
    type: v.optional(v.string()),
    category: v.optional(v.string()),
    priority: v.optional(
      v.union(v.literal("urgent"), v.literal("normal"), v.literal("low"))
    ),
    data: v.optional(v.any()),
    isRead: v.boolean(),
    isArchived: v.optional(v.boolean()),
    archivedAt: v.optional(v.number()),
    link: v.optional(v.string()), // Optional URL to navigate to when clicked
    relatedTaskId: v.optional(v.id("tasks")),
  })
    .index("by_user", ["userId"])
    .index("by_org_user", ["orgId", "userId"])
    // Unread badge/count without a full-table filter scan.
    .index("by_org_user_read", ["orgId", "userId", "isRead"])
    .index("by_org_user_category", ["orgId", "userId", "category"])
    // Paginated history filtered by archived state without post-cursor memory filtering.
    .index("by_org_user_archived", ["orgId", "userId", "isArchived"]),

  notificationPreferences: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    category: v.string(),
    emailEnabled: v.boolean(),
    whatsappEnabled: v.boolean(),
    pushEnabled: v.optional(v.boolean()),
  }).index("by_org_user_category", ["orgId", "userId", "category"]),

  // One row per (device, org, user) a user has enabled Web Push on. A push
  // endpoint is scoped to the browser origin, not to an AutoFlow org — a
  // user who belongs to several orgs on the same device reuses the same
  // endpoint across all of them, so the natural key is the full triple, not
  // endpoint alone (that would let enabling push in org B silently steal the
  // row from org A).
  pushSubscriptions: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    userAgent: v.optional(v.string()),
    deviceName: v.optional(v.string()),
    enabled: v.boolean(),
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_org_user", ["orgId", "userId"])
    .index("by_endpoint_org_user", ["endpoint", "orgId", "userId"])
    // Cross-org/user lookup used only to purge every row tied to an endpoint
    // the push service reports as gone (HTTP 404/410) — see removeByEndpoint.
    .index("by_endpoint", ["endpoint"]),

  notificationBroadcasts: defineTable({
    orgId: v.optional(v.id("organizations")), // omitted = platform-wide
    title: v.string(),
    message: v.string(),
    link: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    recipientCount: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_org", ["orgId"]),

  // Product-wide "What's New" log — every tenant sees the same entries.
  // Super-admin authored (see convex/changelog.ts); creating an entry can
  // optionally also fire a notificationBroadcast so users get an in-app
  // ping, not just a page to check. Bilingual per-entry (not routed through
  // lib/i18n, since content is free-form copy, not a fixed set of keys).
  changelogEntries: defineTable({
    type: v.union(v.literal("FEATURE"), v.literal("FIX"), v.literal("IMPROVEMENT")),
    titleEn: v.string(),
    titleAr: v.string(),
    descriptionEn: v.string(),
    descriptionAr: v.string(),
    publishedAt: v.number(),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
    updatedBy: v.optional(v.id("users")),
  })
    .index("by_publishedAt", ["publishedAt"]),

  // Published native builds of the Expo mobile app, for the APK-fallback
  // updater. Only NATIVE builds live here (a new APK the user sideloads) —
  // JS-only changes ship over-the-air via expo-updates and never touch this
  // table. The app compares its own buildNumber to the newest row's and, when
  // behind, prompts the user to download the APK.
  mobileAppReleases: defineTable({
    platform: v.union(v.literal("ANDROID"), v.literal("IOS")),
    // Monotonic build ordinal — higher means newer. A numeric compare, so 12
    // always beats 9 (unlike a naive string compare of "1.10" vs "1.9").
    buildNumber: v.number(),
    versionName: v.string(), // human label, e.g. "1.4.0"
    runtimeVersion: v.string(),
    apkUrl: v.string(), // self-hosted signed APK (Huawei has no Play Store)
    releaseNotesEn: v.optional(v.string()),
    releaseNotesAr: v.optional(v.string()),
    mandatory: v.optional(v.boolean()),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_platform_build", ["platform", "buildNumber"]),

  // Expo push tokens for the native app, one row per user per device. Distinct
  // from pushSubscriptions (browser Web Push / VAPID) and from
  // marketplaceBuyerPushTokens (anonymous buyers keyed by publicId). Granting
  // the OS notification permission and registering a token here IS the mobile
  // push opt-in — delivery to these is not gated by the web `pushEnabled`
  // preference. NOTE: Expo delivers Android push via FCM, so it does not reach
  // devices without Google Play Services (e.g. Huawei/HMS).
  mobilePushTokens: defineTable({
    userId: v.id("users"),
    token: v.string(), // ExponentPushToken[...]
    platform: v.union(v.literal("IOS"), v.literal("ANDROID")),
    deviceName: v.optional(v.string()),
    createdAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_token", ["token"]),

  test_drives: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    customerId: v.id("customers"),
    salespersonId: v.id("users"),
    startTime: v.number(),
    endTime: v.optional(v.number()),
    demoPlateNumber: v.optional(v.string()),
    notes: v.optional(v.string()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_org_customer", ["orgId", "customerId"]),

  workOrders: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    status: v.union(v.literal("OPEN"), v.literal("IN_PROGRESS"), v.literal("COMPLETED")),
    title: v.string(),
    totalCost: v.number(),
    tasks: v.array(
      v.object({
        id: v.string(),
        description: v.string(),
        partsCost: v.number(),
        laborCost: v.number(),
        mechanicName: v.optional(v.string()),
        completed: v.boolean(),
      })
    ),
    expenseId: v.optional(v.id("expenses")),
    notes: v.optional(v.string()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"]),

  financeCompanies: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    profitRate: v.number(), // e.g. 5.5 for 5.5%
    maxTermMonths: v.number(), // e.g. 72
    gracePeriodMonths: v.number(), // e.g. 3
    insuranceRate: v.optional(v.number()), // e.g. 3.5 for 3.5%
    adminFees: v.optional(v.number()), // Processing Fees
    commission: v.optional(v.number()), // Commission
    includesCommissionInDebt: v.optional(v.boolean()),
    maxFinancingLTV: v.optional(v.number()), // e.g. 85 for 85% Loan-to-Value
    isActive: v.boolean(),
    acceptedStatuses: v.optional(v.array(v.id("orgCustomerStatuses"))), // undefined/empty = accepts all
    deactivatedAt: v.optional(v.number()),
    deactivatedBy: v.optional(v.id("users")),

    // --- Dealer-side purchase rules -------------------------------------
    // The fields above describe the loan the company sells the CUSTOMER. These
    // describe the purchase it makes from the DEALERSHIP, which is a different
    // transaction with different terms and was previously unmodelled — only
    // maxFinancingLTV existed, and nothing server-side ever read it.
    //
    // Every one is optional so the 25 existing companies keep working
    // untouched; `buildRuleSnapshot` supplies conservative defaults.
    //
    // Bumped by finance.updateCompany on any rule change, and pointed at by the
    // immutable financeCompanyRuleVersions row an application snapshots.
    ruleVersion: v.optional(v.number()),
    defaultLtvPercent: v.optional(v.number()),
    minimumLtvPercent: v.optional(v.number()),
    ltvBasis: v.optional(ltvBasisValidator),
    minimumCustomerFirstPaymentMinor: v.optional(v.number()),
    allowedAppraisalVariancePercent: v.optional(v.number()),
    // Whether the company may buy at the dealer's submitted quotation when the
    // independent appraisal lands lower, and by how much it may fall short.
    allowsQuotationAboveAppraisal: v.optional(v.boolean()),
    lowerAppraisalTolerancePercent: v.optional(v.number()),
    quotationExceptionApproval: v.optional(
      v.union(v.literal("AUTOMATIC"), v.literal("MANUAL"))
    ),
    // How the company settles: whether the dealer wires its contribution
    // separately or the company nets it out, and whether customer money the
    // company collects is passed through to the dealer inside the purchase
    // price or retained. Both patterns are real; neither can be assumed.
    dealerContributionSettlement: v.optional(dealerContributionSettlementValidator),
    customerContributionSettlement: v.optional(customerContributionSettlementValidator),
    feesDeductedFromSettlement: v.optional(v.boolean()),
    // Whether the customer's first payment offsets the unfinanced share. The
    // quotation solver only applies when it does; unset makes the solver
    // decline rather than assume.
    customerFirstPaymentOffsetsUnfinancedShare: v.optional(v.boolean()),
    feeTemplates: v.optional(v.array(financeFeeTemplateValidator)),
  }).index("by_org", ["orgId"]),

  /**
   * Immutable snapshot of a finance company's dealer-side rules, written once
   * per version whenever those rules change.
   *
   * Applications point at a version and also carry an inline copy, so a
   * historical deal's terms cannot be rewritten by editing the company later —
   * which is exactly what would happen if the rules were only ever read live.
   */
  financeCompanyRuleVersions: defineTable({
    orgId: v.id("organizations"),
    companyId: v.id("financeCompanies"),
    version: v.number(),
    snapshot: financeCompanyRuleSnapshotValidator,
    note: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.optional(v.id("users")),
  })
    .index("by_org", ["orgId"])
    .index("by_company", ["companyId"])
    .index("by_company_version", ["companyId", "version"]),

  vehicleValuations: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    companyId: v.id("financeCompanies"),
    valuationAmount: v.number(),
    expiresAt: v.optional(v.number()), // timestamp
  })
    .index("by_org", ["orgId"])
    .index("by_vehicle", ["vehicleId"])
    .index("by_company", ["companyId"]),

  guarantors: defineTable({
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    firstName: v.string(),
    lastName: v.string(),
    nationalId: v.string(),
    phone: v.string(),
    relationship: v.optional(v.string()),
    income: v.optional(v.number()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_customer", ["customerId"]),

  quotes: defineTable({
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    vehicleId: v.id("vehicles"),
    // When set, this quote covers multiple vehicles (or several units of the
    // same model — each still its own inventory row/VIN). vehicleId/vehiclePrice
    // above become derived convenience values (first line item / sum of all
    // line items) for single-vehicle readers that haven't been updated yet.
    vehicleItems: v.optional(v.array(v.object({
      vehicleId: v.id("vehicles"),
      unitPrice: v.number(),
    }))),
    companyId: v.optional(v.id("financeCompanies")), // Null if cash deal
    mode: v.optional(v.union(
      v.literal("CASH"),
      v.literal("CONFIGURED_FINANCE_COMPANY"),
      v.literal("MANUAL_FINANCE_COMPANY"),
      v.literal("INTERNAL_INSTALLMENT"),
      v.literal("LEASE"),
    )),
    leadId: v.optional(v.id("leads")), // Set when the quote was generated from a lead's context

    // Core parameters
    vehiclePrice: v.number(),
    // The dealer's own margin on the deal, as the client that built the quote
    // defines it. Checked against the vehicle's `minimumProfit` by
    // convex/utils/profitApproval.ts. Optional only for quotes written before
    // that check existed — new quotes always carry it (absent is read as 0).
    desiredProfit: v.optional(v.number()),
    downPayment: v.number(),
    termMonths: v.number(),

    // Financing Engine output
    totalFinancedAmount: v.optional(v.number()), // Principal + Insurance + Fees
    monthlyInstallment: v.optional(v.number()),
    profitRateApplied: v.optional(v.number()),
    totalProfit: v.optional(v.number()),

    recipientName: v.optional(v.string()), // Who the quote is addressed to (e.g. a financing company, for installment deals)
    manualProviderName: v.optional(v.string()),
    manualProfitRate: v.optional(v.number()),
    manualInsuranceRate: v.optional(v.number()),
    manualAdminFees: v.optional(v.number()),
    manualCommission: v.optional(v.number()),
    manualIncludesCommissionInDebt: v.optional(v.boolean()),

    status: v.union(v.literal("DRAFT"), v.literal("SHARED"), v.literal("ACCEPTED"), v.literal("EXPIRED")),
    expiresAt: v.optional(v.number()),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_customer", ["customerId"])
    .index("by_vehicle", ["vehicleId"])
    .index("by_status", ["status"])
    .index("by_lead", ["leadId"]),

  applicationStatusLog: defineTable({
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    fromStatus: v.optional(v.string()),
    toStatus: v.string(),
    changedBy: v.id("users"),
    changedAt: v.number(),
    note: v.optional(v.string()),
  })
    .index("by_application", ["applicationId"])
    .index("by_org", ["orgId"]),

  financeApplications: defineTable({
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
    customerId: v.id("customers"),
    vehicleId: v.id("vehicles"),
    // Mirrors quotes.vehicleItems — snapshotted at application creation so
    // finalization can complete a sale per vehicle without re-reading the quote.
    vehicleItems: v.optional(v.array(v.object({
      vehicleId: v.id("vehicles"),
      unitPrice: v.number(),
    }))),
    /**
     * SCRUM-208 — the CURRENT episode PER VEHICLE, not one scalar.
     *
     * ⚠️ A SCALAR HERE WOULD BE WRONG BY CONSTRUCTION. The acquisition path
     * opens one claim PER VEHICLE in the normalized item set, so a single
     * `currentCommitmentClaimId` could only ever name one of them and every
     * other car on the application would fall back to a history search.
     *
     * ⚠️ THE CARDINALITY AUTHORITY IS THE NORMALIZED SET, NOT THIS FIELD AND
     * NOT `vehicleItems`. `vehicleItems` is ABSENT on single-vehicle
     * applications — the commonest shape — so code reading it directly sees
     * zero vehicles for a perfectly ordinary application. The authority is
     * `vehicleItems ?? [{ vehicleId }]`, exactly as the acquisition path
     * normalizes it.
     *
     * Vehicle ids within the set are UNIQUE: a duplicate REFUSES before any
     * claim, root, pointer or status write, and is never silently
     * deduplicated — a repeated car is a caller bug, and collapsing it would
     * post one vehicle's authority under another's intent. The persisted order
     * is canonical (ascending by vehicle id) so two equal sets never compare
     * unequal on order alone.
     */
    currentCommitmentClaims: v.optional(v.array(v.object({
      vehicleId: v.id("vehicles"),
      claimId: v.id("vehicleCommitmentClaims"),
    }))),
    companyId: v.optional(v.id("financeCompanies")),
    salespersonId: v.id("users"),

    status: v.union(
      v.literal("DRAFT"),
      v.literal("PENDING_DOCS"),
      v.literal("UNDER_REVIEW"),
      v.literal("APPROVED"),
      v.literal("REJECTED"),
      v.literal("CLOSED"),
      v.literal("CANCELLED")
    ),

    notes: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    quoteModeAtSubmission: v.optional(v.union(
      v.literal("CASH"),
      v.literal("CONFIGURED_FINANCE_COMPANY"),
      v.literal("MANUAL_FINANCE_COMPANY"),
      v.literal("INTERNAL_INSTALLMENT"),
      v.literal("LEASE"),
    )),
    manualFinanceSnapshot: v.optional(v.object({
      providerName: v.optional(v.string()),
      profitRate: v.optional(v.number()),
      insuranceRate: v.optional(v.number()),
      adminFees: v.optional(v.number()),
      commission: v.optional(v.number()),
      includesCommissionInDebt: v.optional(v.boolean()),
      totalFinancedAmount: v.optional(v.number()),
      monthlyInstallment: v.optional(v.number()),
      totalProfit: v.optional(v.number()),
    })),
    approvedBy: v.optional(v.id("users")),
    approvedAt: v.optional(v.number()),
    finalizedSaleId: v.optional(v.id("sales")),
    finalizationIdempotencyKey: v.optional(v.string()),
    disbursedAt: v.optional(v.number()),
    disbursedAmountMinor: v.optional(v.number()),
    disbursementIdempotencyKey: v.optional(v.string()),
    // التنازل بالسيارة للعميل — vehicle handover to the customer, registered
    // before finalizeDeal is allowed to run.
    vehicleHandoverAt: v.optional(v.number()),
    vehicleHandoverBy: v.optional(v.id("users")),
    vehicleHandoverNotes: v.optional(v.string()),
    // How and when the deal's payment is expected to be received, registered
    // before finalizeDeal — generalizes the finance-company-only disbursement
    // flow to also cover cash/in-house-installment/cheque/bank deals.
    expectedPaymentMethod: v.optional(v.union(
      v.literal("CASH"),
      v.literal("INTERNAL_INSTALLMENT"),
      v.literal("CHEQUE"),
      v.literal("BANK_TRANSFER"),
    )),
    expectedPaymentDate: v.optional(v.number()),
    expectedPaymentRegisteredAt: v.optional(v.number()),
    expectedPaymentRegisteredBy: v.optional(v.id("users")),
    cancelledBy: v.optional(v.id("users")),
    cancelledAt: v.optional(v.number()),
    cancellationReason: v.optional(v.string()),
    underwritingSnapshot: v.optional(v.object({
      salaryAtSubmission: v.optional(v.number()),
      employerAtSubmission: v.optional(v.string()),
      jobTitleAtSubmission: v.optional(v.string()),
      totalMonthlyDebtAtSubmission: v.optional(v.number()),
      proposedMonthlyInstallment: v.optional(v.number()),
      dbrAtSubmission: v.optional(v.number()),
      guarantorsAtSubmission: v.optional(v.array(v.object({
        guarantorId: v.id("guarantors"),
        firstName: v.string(),
        lastName: v.string(),
        nationalIdLastFour: v.string(),
        phone: v.string(),
        income: v.optional(v.number()),
        relationship: v.optional(v.string()),
      }))),
      customerStatusAtSubmission: v.optional(v.string()),
      // NOTE: a vehicleValuations row, which is a mutable per-(vehicle, company)
      // number with no provider, date or document — NOT an independent
      // appraisal. And ltvAtSubmission is financedAmount ÷ that number, a
      // derived ratio rather than the company's applied LTV rule. The
      // financeAppraisals table and appliedLtvPercent below are the real ones;
      // these two stay for the historical record and are never read as either.
      vehicleValuationAtSubmission: v.optional(v.number()),
      ltvAtSubmission: v.optional(v.number()),
    })),

    // --- Lifecycle dimensions -------------------------------------------
    // `status` above conflates all five of these. It stays as the legacy
    // field every existing reader still uses; these carry the real state.
    creditDecision: v.optional(creditDecisionValidator),
    appraisalStatus: v.optional(appraisalStatusValidator),
    gapResolution: v.optional(gapResolutionValidator),
    settlementStatus: v.optional(settlementStatusValidator),
    handoverStatus: v.optional(handoverStatusValidator),

    // --- Dealer-side economics ------------------------------------------
    // All in minor units of `economicsCurrency`. Deliberately NOT reusing
    // quotes.totalFinancedAmount, which is the customer's Murabaha principal
    // and was being read as four other things — see the module header on
    // packages/shared/src/financingEconomics.ts.
    economicsCurrency: v.optional(v.string()),
    vehiclePurchaseCostMinor: v.optional(v.number()),
    targetSellingAmountMinor: v.optional(v.number()),

    // What the dealership actually sent the finance company. Calculated by
    // default but overridable, because the number sent is a commercial
    // decision and storing a computed value as if it were the submitted
    // document would be a lie about a real artefact.
    submittedQuotationMinor: v.optional(v.number()),
    submittedQuotationSource: v.optional(quotationSourceValidator),
    submittedQuotationOverrideReason: v.optional(v.string()),
    // Mode, inputs, solver result, rule version and override, frozen at the
    // moment the quotation was recorded.
    quotationCalculationSnapshot: v.optional(quotationCalculationSnapshotValidator),
    estimatedDealerBorneExpensesMinor: v.optional(v.number()),
    quotationBufferMinor: v.optional(v.number()),
    submittedQuotationAt: v.optional(v.number()),
    submittedQuotationBy: v.optional(v.id("users")),
    dealerEstimateMinor: v.optional(v.number()),

    // What the company will actually buy at, and on what basis. Stored, never
    // inferred from the appraisal: a tolerance rule can approve at the
    // quotation despite a lower appraisal, and a negotiated third figure is
    // neither of the two.
    appliedLtvPercent: v.optional(v.number()),
    approvedDealerPurchaseAmountMinor: v.optional(v.number()),
    /**
     * Bumped by every write that moves the deal's economics, and projected as
     * the `economicsStamp` a handover confirmation must hand back.
     *
     * A COUNTER rather than a digest of the figures. The first version of this
     * stamp was `v1|<approved>|<funded>|<contribution>`, issued to every caller
     * who could load the deal — which handed the exact amounts
     * `redactSettlementEvidence` withholds to callers it withholds them from,
     * in a form anyone could read straight off. Hashing the tuple would not
     * have fixed it either: the format is known and at 100% LTV the search
     * collapses to one figure, so the digest is invertible in practice.
     *
     * Absent on rows written before this field existed, which reads as
     * revision 0 — consistent for every caller, so no one is locked out.
     *
     * ⚠️ Every writer of the approved amount or its derived split must bump
     * this. `convex/economicsRevisionGuard.test.ts` fails CI if one does not:
     * a forgotten bump is fail-OPEN, and would let a stale confirmation seal.
     */
    economicsRevision: v.optional(v.number()),
    approvedPurchaseBasis: v.optional(approvedPurchaseBasisValidator),
    approvedPurchaseAppraisalId: v.optional(v.id("financeAppraisals")),
    approvedPurchaseExceptionRuleVersion: v.optional(v.number()),
    approvedPurchaseApprovedBy: v.optional(v.id("users")),
    approvedPurchaseApprovedAt: v.optional(v.number()),
    approvedPurchaseNotes: v.optional(v.string()),

    // Funding composition. Derived server-side from the three inputs above on
    // every write, never accepted from a client.
    financeCompanyFundedPortionMinor: v.optional(v.number()),
    unfinancedPortionMinor: v.optional(v.number()),
    customerFirstPaymentMinor: v.optional(v.number()),
    // Customer money that goes to the FINANCE COMPANY. Must never create a
    // dealer-side customer receivable.
    customerContributionToFinanceCompanyMinor: v.optional(v.number()),
    dealerContributionMinor: v.optional(v.number()),
    dealerContributionSettlement: v.optional(dealerContributionSettlementValidator),
    customerContributionSettlement: v.optional(customerContributionSettlementValidator),

    // Who the finance company actually pays when the car is the supplier's.
    //
    // Not derivable, and not the same question as who owns the car: the same
    // consigned vehicle can be financed with the cheque made out to the
    // dealership or made out to the supplier, and only the agreement says
    // which (`حسب ملكية السيارة`). Recorded here rather than on the sale
    // because the sale does not exist yet when the deal is arranged, and
    // `finalizeDeal` is what carries it onto the sale.
    //
    // Absent means THROUGH_DEALERSHIP — the same reading `consignedSettlementRoute`
    // gives an absent route on a sale, and what every financed consigned deal
    // finalized before this field existed actually posted. Reading absent as
    // anything else would restate them.
    supplierSettlementRoute: v.optional(consignedSettlementRouteValidator),

    // The finance company's disbursement TO THE SUPPLIER, on the direct route.
    //
    // Kept apart from `disbursedAt`/`disbursedAmountMinor` above, which mean
    // money that arrived in the dealership's own bank. This money never touches
    // the dealership's books: it is a fact read off the settlement advice,
    // recorded because it is what makes the supplier's margin collectable, and
    // it posts no journal. Folding the two together would let a disbursement
    // the dealership never received satisfy a check for one it did.
    supplierDisbursementConfirmedAt: v.optional(v.number()),
    supplierDisbursedAmountMinor: v.optional(v.number()),
    supplierDisbursementReference: v.optional(v.string()),
    supplierDisbursementConfirmedBy: v.optional(v.id("users")),
    /**
     * Whether the recorded advice agrees with what the deal was approved at.
     *
     * The dealership's ruling is one payment, for the approved amount — so a
     * different figure is a contradiction between two records of the same fact,
     * not a partial payment. The first attempt at enforcing that REFUSED the
     * mismatched advice, and refusing turned out to be worse than the problem:
     *
     *   - the approval is immutable once the deal is finalized, so there was no
     *     legal way to make the two agree and the advice could never be
     *     recorded at all;
     *   - `supplierDisbursementConfirmedAt` therefore stayed absent, and that
     *     field is what stops a sale being cancelled after the finance company
     *     has paid. A mismatched advice — evidence the supplier WAS paid — left
     *     the sale freely cancellable. The enforcement disarmed the guard it
     *     was meant to strengthen.
     *
     * So the advice is now always recorded, and a disagreement is recorded WITH
     * it as a state a human has to resolve. `REQUIRES_RECONCILIATION` is not a
     * softer CONFIRMED: it says the dealership holds two contradictory records
     * of one payment and does not yet know which is true.
     *
     * Absent means the advice predates this field. It means an advice is ON
     * FILE — NOT that the amounts agreed. The claim that they must have is
     * false: the pre-status writer validated only that the amount was positive
     * and never compared it against `approvedDealerPurchaseAmountMinor`, and
     * that comparison first exists in this release. `redactSettlementEvidence`
     * normalizes absence to `CONFIRMED` for DISPLAY, and says the same thing
     * there — do not read either as evidence of agreement, and never branch on
     * `status === "CONFIRMED"` from a redacted payload to decide whether a
     * disbursement reconciled. Ask the raw fields, as `dealCockpit` does.
     */
    supplierDisbursementStatus: v.optional(
      v.union(v.literal("CONFIRMED"), v.literal("REQUIRES_RECONCILIATION"))
    ),
    /**
     * What the deal was approved at when the advice was recorded, in minor
     * units. Frozen alongside the advice so the discrepancy stays legible even
     * if the approval is later corrected through its own audited path — without
     * it, "the advice disagreed" becomes unfalsifiable the moment either side
     * moves. Written only when the two disagree.
     */
    supplierDisbursementApprovedAtRecordingMinor: v.optional(v.number()),

    // Settlement. `expected` is what the company owes; `actual` is what turned
    // up. Keeping them apart is the whole reason confirmDisbursement could not
    // handle a partial or late remittance.
    expectedDealerRemittanceMinor: v.optional(v.number()),
    actualDealerReceiptTotalMinor: v.optional(v.number()),
    customerFinancingPrincipalMinor: v.optional(v.number()),
    estimatedClosingExpensesMinor: v.optional(v.number()),
    actualClosingExpensesMinor: v.optional(v.number()),
    targetNetProceedsMinor: v.optional(v.number()),

    // The legally documented transaction price — the invoice and purchase
    // agreement, not a figure the system worked out.
    //
    // This is the ninth of nine amounts the deal keeps SEPARATELY, and the only
    // one revenue may ever be posted from. Neither the dealer's target selling
    // amount nor the finance company's approved purchase amount is revenue:
    // both are real, both are stored, and neither is the invoice. Deriving this
    // from either of them is the specific thing that is not allowed, because a
    // financed deal's paperwork is what determines who sold what to whom.
    //
    // Unset means nobody has recorded the document yet, which is why
    // `accountingClassification` exists rather than a default being assumed.
    legalInvoiceAmountMinor: v.optional(v.number()),
    legalInvoiceNumber: v.optional(v.string()),
    legalInvoiceDate: v.optional(v.number()),
    legalInvoiceRecordedBy: v.optional(v.id("users")),
    legalInvoiceRecordedAt: v.optional(v.number()),
    /** Who the invoice was actually issued to, which a financed deal makes a real question. */
    legalInvoiceIssuedTo: v.optional(
      v.union(v.literal("CUSTOMER"), v.literal("FINANCE_COMPANY"), v.literal("OTHER"))
    ),
    legalInvoiceIssuedToOther: v.optional(v.string()),

    // Whether the deal's accounting treatment has actually been established.
    //
    // PENDING_CLASSIFICATION is the honest default for a financed deal: until
    // the invoice, the purchase agreement and the settlement advice say how the
    // purchase amount and the dealer contribution are documented, there is no
    // sale amount to post that would not be a guess. CLASSIFIED is set by a
    // person, never inferred.
    accountingClassification: v.optional(
      v.union(v.literal("PENDING_CLASSIFICATION"), v.literal("CLASSIFIED"))
    ),
    accountingClassifiedBy: v.optional(v.id("users")),
    accountingClassifiedAt: v.optional(v.number()),
    accountingClassificationNotes: v.optional(v.string()),

    /**
     * The settlement plan this deal was actually recognised from.
     *
     * Server-owned and written only by finalization, beside the sale id and the
     * idempotency key it belongs with. It is the record of WHICH plan posted:
     * the fee rows behind it can be corrected afterwards, and when they are,
     * what the journal says must still be traceable to the figures that produced
     * it rather than to whatever those rows say later.
     */
    financedSaleRecognitionFingerprint: v.optional(v.string()),

    /**
     * N — what the financing company still owed when the sale was recognised.
     *
     * Frozen at finalization, beside the plan that produced it, and the figure
     * `confirmDisbursement` measures an actual receipt against. Re-deriving it at
     * receipt time would compare the money that arrived against economics that
     * may have moved since — a deposit resolved, a fee corrected — and call a
     * correct payment wrong.
     */
    financedSaleNetReceivableMinor: v.optional(v.number()),

    // Appraisal gap and its negotiated split. The gap negotiated is the RAW
    // difference against the submitted quotation, not the change in the
    // company's funded portion.
    rawAppraisalGapMinor: v.optional(v.number()),
    customerGapShareMinor: v.optional(v.number()),
    dealerGapShareMinor: v.optional(v.number()),
    customerGapCashToDealerMinor: v.optional(v.number()),
    customerGapInstallmentToDealerMinor: v.optional(v.number()),
    customerGapToFinanceCompanyMinor: v.optional(v.number()),
    gapResolvedAt: v.optional(v.number()),
    gapResolvedBy: v.optional(v.id("users")),
    gapResolutionNotes: v.optional(v.string()),

    // Failure. The appraisal-fee treatment keys off the reason, not the status.
    failureReason: v.optional(financingFailureReasonValidator),
    failureNotes: v.optional(v.string()),
    failedAt: v.optional(v.number()),
    failedBy: v.optional(v.id("users")),
    appraisalFeeResponsibility: v.optional(feeResponsibilityValidator),
    appraisalFeeResponsibilityReason: v.optional(v.string()),

    companyRuleSnapshot: v.optional(financeCompanyRuleSnapshotValidator),
    companyRuleVersionId: v.optional(v.id("financeCompanyRuleVersions")),

    // Set by the migration on rows whose pre-existing figures cannot be
    // reinterpreted safely. Reported on, never silently cleared.
    needsFinancingReconciliation: v.optional(v.boolean()),
    financingReconciliationReason: v.optional(v.string()),
    // Written only by migrateFinancingEconomics. Deliberately not one of the
    // business dimensions: keying the backfill on `creditDecision` meant the
    // live mutations that now maintain it also set the migration's own
    // completion sentinel, so any legacy row a user touched mid-migration was
    // skipped forever — without its rule snapshot, its remaining dimensions,
    // or its reconciliation flag.
    financingBackfilledAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_customer", ["customerId"])
    .index("by_vehicle", ["vehicleId"])
    .index("by_status", ["status"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_reconciliation", ["orgId", "needsFinancingReconciliation"]),

  /**
   * Every appraisal ever recorded against one application.
   *
   * Deliberately per-application rather than per-(vehicle, company) like
   * `vehicleValuations`: that table holds one mutable number shared by every
   * deal the vehicle appears in, so re-using a vehicle in a later application
   * silently overwrote the basis the earlier deal was approved on. History here
   * is append-only — a reappraisal supersedes its predecessor rather than
   * replacing it.
   */
  financeAppraisals: defineTable({
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    vehicleId: v.id("vehicles"),
    companyId: v.optional(v.id("financeCompanies")),
    appraisalAmountMinor: v.number(),
    currency: v.string(),
    // Who performed it. The independent appraisal is performed or approved by
    // the financing company; a dealer estimate is not an appraisal and is
    // marked as such so it can never be mistaken for one.
    providerType: v.union(
      v.literal("FINANCE_COMPANY"),
      v.literal("INDEPENDENT"),
      v.literal("DEALER_ESTIMATE")
    ),
    providerName: v.optional(v.string()),
    appraisedAt: v.number(),
    documentStorageIds: v.optional(v.array(v.id("_storage"))),
    isReappraisal: v.boolean(),
    reappraisalReason: v.optional(v.string()),
    status: v.union(
      v.literal("RECORDED"),
      v.literal("APPROVED"),
      v.literal("SUPERSEDED"),
      v.literal("REJECTED")
    ),
    supersededAt: v.optional(v.number()),
    supersededByAppraisalId: v.optional(v.id("financeAppraisals")),
    notes: v.optional(v.string()),
    recordedBy: v.id("users"),
    recordedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_application", ["applicationId"])
    .index("by_vehicle", ["vehicleId"]),

  /**
   * One itemized cost on one financed deal, estimated and actual side by side.
   *
   * ## Why both, and why neither defaults to the other
   *
   * A quotation is prepared days before the costs are known, so the dealership
   * has to work from estimates — and a deal is not closed on estimates. Storing
   * one number that starts as an estimate and is later overwritten by the
   * actual destroys the comparison the whole reconciliation depends on, and
   * makes "was this ever checked?" unanswerable. `estimatedAmountMinor` and
   * `actualAmountMinor` are therefore independent, and **an unset actual is not
   * zero and not the estimate** — it means nobody has paid or recorded it yet.
   *
   * ## No plugs
   *
   * Nothing here is ever back-solved from a quotation, a target or a residual.
   * A deal with no fees itemized has no fees, and reports a lower total —
   * which is the honest figure. The alternative, inferring an allowance from
   * the difference between two other numbers, turns arithmetic into a business
   * fact nobody stated.
   *
   * ## Accounting treatment is explicit, always
   *
   * `accountingTreatment` is required. Defaulting it — say, treating every
   * dealer-borne amount as a selling expense — is wrong for most of these: an
   * appraisal fee the dealership swallows is an expense, an amount the customer
   * still owes is a receivable, and money an employee fronted is a payable to
   * that employee. The party who paid does not determine the treatment either,
   * which is why `paidBy` and `accountingTreatment` are separate fields.
   */
  financeDealFees: defineTable({
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    feeType: financeFeeTypeValidator,
    description: v.optional(v.string()),
    currency: v.string(),

    /** What the deal was quoted on. Usable operationally; never closure evidence. */
    estimatedAmountMinor: v.optional(v.number()),
    /** What was actually paid. Unset means unpaid or unrecorded — not zero. */
    actualAmountMinor: v.optional(v.number()),

    paidBy: feePartyValidator,
    paidTo: feePartyValidator,
    /** Required. See the note above — never inferred from `paidBy`. */
    accountingTreatment: feeAccountingTreatmentValidator,
    includedInQuotation: v.boolean(),
    deductedFromSettlement: v.boolean(),
    refundable: v.boolean(),

    /** Set when an employee holding deal custody laid this out. */
    custodyId: v.optional(v.id("financeDealCustody")),
    paidAt: v.optional(v.number()),
    receiptReference: v.optional(v.string()),
    documentStorageIds: v.optional(v.array(v.id("_storage"))),

    /** Whether the line came from the company's fee template or was typed. */
    source: v.union(v.literal("COMPANY_TEMPLATE"), v.literal("MANUAL")),

    /**
     * Set only when a person has confirmed the actual against its evidence.
     * Deliberately not derived from `actualAmountMinor` being present: an
     * amount somebody typed and an amount somebody checked are different
     * claims, and closure requires the second.
     */
    reconciledAt: v.optional(v.number()),
    reconciledBy: v.optional(v.id("users")),
    reconciliationNotes: v.optional(v.string()),

    /** Voided rather than deleted, so a removed cost still has a trace. */
    voidedAt: v.optional(v.number()),
    voidedBy: v.optional(v.id("users")),
    voidReason: v.optional(v.string()),

    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_application", ["applicationId"])
    .index("by_custody", ["custodyId"]),

  /**
   * Money handed to an employee to go and pay a financed deal's closing costs.
   *
   * ## Why this is NOT `employeeAdvances`
   *
   * It looks like one, and putting it there would take money from a person.
   * `payroll.ts` sweeps **every** `OUTSTANDING` row in `employeeAdvances` for a
   * user and deducts it from that month's salary. Deal custody is not a salary
   * advance: the employee is holding the dealership's cash to spend on the
   * dealership's behalf, settles it by producing receipts and returning the
   * balance, and is frequently owed money rather than owing it. Recovering it
   * from their pay would dock them for expenses they have already covered.
   *
   * ## The identity it has to close
   *
   * ```
   * issued - returned - actualExpenses = remainingBalance
   * ```
   *
   * `reconcileEmployeeCustody` in the shared engine computes it, and returns a
   * **signed** balance on purpose: an advance of 700 against 650 of expenses
   * with 50 returned reconciles to zero, while the same advance against 750 of
   * expenses leaves the dealership owing the employee 50. Collapsing those into
   * one unsigned "variance" is how a reimbursement silently becomes a shortage.
   *
   * `reimbursedMinor` is what has actually been paid back, and the engine nets
   * it so a caller reads what is still OUTSTANDING rather than what was
   * incurred — a figure named "due" that does not move after payment is a
   * double payment waiting to happen.
   *
   * Note what is deliberately NOT stored: the employee's own money. It is not
   * independent information — it is exactly the amount by which expenses exceed
   * what they were given and did not return — and holding it as its own figure
   * let it be added to the advance, cancelling the debt it was recording.
   * `reimbursedMinor` is different and IS stored, because money owed and money
   * actually paid back are separate facts and only the second closes the record.
   */
  financeDealCustody: defineTable({
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    /** The employee holding the money. */
    userId: v.id("users"),
    currency: v.string(),

    /** Cash handed over. The sum of every issuance on this custody record. */
    issuedMinor: v.number(),
    /** Unspent cash the employee gave back. */
    returnedMinor: v.number(),
    /** Money the dealership has actually paid back to the employee. */
    reimbursedMinor: v.number(),

    status: v.union(
      v.literal("OPEN"),
      v.literal("RECONCILED"),
      /** Closed with a difference nobody could account for, recorded as such. */
      v.literal("WRITTEN_OFF")
    ),
    reconciledAt: v.optional(v.number()),
    reconciledBy: v.optional(v.id("users")),
    reconciliationNotes: v.optional(v.string()),
    writeOffReason: v.optional(v.string()),

    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_application", ["applicationId"])
    .index("by_org_user", ["orgId", "userId"])
    .index("by_org_status", ["orgId", "status"]),

  /**
   * Every movement on a custody record, so the totals above are a sum of events
   * rather than a number somebody patched.
   *
   * Without this, correcting a mistyped issuance means overwriting a total and
   * losing the fact that it ever differed — the same defect the override table
   * exists to prevent one layer up.
   */
  financeDealCustodyEntries: defineTable({
    orgId: v.id("organizations"),
    custodyId: v.id("financeDealCustody"),
    kind: v.union(
      v.literal("ISSUED"),
      v.literal("RETURNED"),
      v.literal("REIMBURSED"),
      /**
       * Cancels an earlier entry, netted against that entry's own kind.
       *
       * Without it the documented "correct it with another entry" workflow
       * could only be performed by recording something untrue: a mistyped
       * ISSUED of 7,000 could be offset only by a RETURNED of 6,300, asserting
       * as fact that the employee handed back cash they never received.
       */
      v.literal("REVERSAL")
    ),
    /** Required on a REVERSAL, forbidden otherwise. */
    reversesEntryId: v.optional(v.id("financeDealCustodyEntries")),
    amountMinor: v.number(),
    method: v.optional(
      v.union(
        v.literal("CASH"),
        v.literal("BANK_TRANSFER"),
        v.literal("CHEQUE"),
        v.literal("CARD")
      )
    ),
    reference: v.optional(v.string()),
    note: v.optional(v.string()),
    occurredAt: v.number(),
    recordedBy: v.id("users"),
    recordedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_custody", ["custodyId"]),

  /**
   * Audit trail for every manual override of a financing figure.
   *
   * Separate from `applicationStatusLog`, which records status transitions
   * only. An override that changed a number without changing a status left no
   * trace at all before this.
   */
  financeApplicationOverrides: defineTable({
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    field: v.string(),
    previousValue: v.optional(v.string()),
    newValue: v.string(),
    reason: v.string(),
    changedBy: v.id("users"),
    changedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_application", ["applicationId"]),

  deposits: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    customerId: v.id("customers"),
    quoteId: v.optional(v.id("quotes")),
    reservationId: v.optional(v.id("vehicleReservations")),
    amount: v.number(),
    amountMinor: v.optional(v.number()),
    currency: v.optional(v.string()),
    method: v.optional(v.union(
      v.literal("CASH"),
      v.literal("BANK_TRANSFER"),
      v.literal("PAYMENT_LINK"),
      v.literal("CARD"),
      v.literal("CHEQUE"),
      v.literal("OTHER")
    )),
    status: v.union(
      v.literal("HELD"),
      v.literal("APPLIED"),
      v.literal("REFUNDED"),
      v.literal("FORFEITED"),
      v.literal("VOIDED")
    ),
    // Whether this deposit is currently contributing to the vehicle's RESERVED
    // hold. Kept separate from `status` so a rejected application can release
    // the vehicle immediately while the deposit itself stays HELD pending a
    // manager's manual refund/forfeit decision.
    holdActive: v.boolean(),
    /**
     * How much of this row has actually been paid back out or written off
     * through `deposits.release`.
     *
     * A row is not all-or-nothing once its quote carries several cars: part can
     * be credited against one car's live invoice while the remainder is
     * refunded. `status` records only whichever happened last, so it cannot say
     * how much money is still owed to the customer — and releasing on the row's
     * face value paid out amounts that had already come off an invoice.
     */
    releasedAmountMinor: v.optional(v.number()),
    /**
     * The refunded and forfeited parts of `releasedAmountMinor`, kept apart.
     *
     * `status` cannot tell them apart once a row can be released more than
     * once: it records only the last thing that happened, so a 3,000 cash
     * refund followed by a 2,000 forfeiture reported all 5,000 as forfeited.
     */
    refundedAmountMinor: v.optional(v.number()),
    forfeitedAmountMinor: v.optional(v.number()),
    /**
     * How many times this row has been released. Drives the accounting identity
     * of each release: keyed on the row alone, every release after the first
     * returned "already posted" and moved cash with no journal behind it.
     */
    releaseCount: v.optional(v.number()),
    canonicalPaymentId: v.optional(v.id("canonicalPayments")),
    idempotencyKey: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    resolvedBy: v.optional(v.id("users")),
    resolvedAt: v.optional(v.number()),
    // What was DECIDED about the money, as distinct from `status`, which
    // records what happened to it. Two treatments share the APPLIED status
    // while crediting entirely different accounts, so the status alone cannot
    // answer "applied to what?" — the question an auditor actually asks.
    //
    // OTHER carries a reason and leaves `status` alone: the liability stays on
    // the books awaiting a manual journal. See depositStatusForTreatment.
    //
    // Absent on every deposit resolved before explicit treatments existed, and
    // on the dealer-owned path where APPLIED has only ever meant
    // APPLY_TO_DEALER_AMOUNT.
    resolutionTreatment: v.optional(
      v.union(
        v.literal("APPLY_TO_DEALER_AMOUNT"),
        v.literal("APPLY_TO_TRANSACTION_SETTLEMENT"),
        v.literal("REFUND_TO_CUSTOMER"),
        v.literal("FORFEITED"),
        v.literal("OTHER")
      )
    ),
    resolutionReason: v.optional(v.string()),
    resolutionSaleId: v.optional(v.id("sales")),

    /**
     * SCRUM-208 — WHICH REPRESENTATION THIS DEPOSIT USES, FOR LIFE.
     *
     * false → DIRECT. The deposit holds its own vehicle through
     *         `holdActive`, and NO `depositVehicleHolds` row may ever exist
     *         for it. Its episode pointer is the scalar below.
     * true  → SLICED. `depositVehicleHolds` rows are the whole truth about
     *         which cars it holds, and the scalar below stays absent.
     *
     * ⚠️ A REPRESENTATION CLASS, NOT "does it currently have hold rows".
     * Deriving it from row existence would flip the deposit's representation
     * the moment its last slice closed, which is precisely when provenance is
     * most needed. Write-once at creation.
     *
     * ⚠️ `undefined` IS NOT `false`. It means the deposit predates canonical
     * activation and must FAIL CLOSED, not be read as DIRECT. This is the
     * single most expensive mistake available on this field: `undefined ===
     * false` evaluates to false in JavaScript and to "no matching row" in an
     * index equality component, so a default would answer "not held" for the
     * entire pre-existing dataset and free cars people have paid to hold.
     */
    usesVehicleHoldRows: v.optional(v.boolean()),
    /**
     * SCRUM-208 — the CURRENT episode for a DIRECT deposit.
     *
     * Named for what it is rather than a generic `sourceCommitmentClaimId`:
     * this is meaningful ONLY on the direct representation, and a sliced
     * deposit answers the same question per vehicle through its hold rows.
     *
     * ⚠️ A DEPOSIT OPERATION MAY NOT TERMINALIZE A RESERVATION EPISODE merely
     * because that episode also references this deposit. A reservation taken
     * with a deposit carries the deposit id for context; the DEFINING evidence
     * is still the reservation. This pointer names the episode a deposit
     * operation may act on, and nothing else.
     */
    singleVehicleCommitmentClaimId: v.optional(v.id("vehicleCommitmentClaims")),

    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_quote", ["quoteId"])
    .index("by_quote_status", ["quoteId", "status"])
    .index("by_reservation", ["reservationId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_vehicle_hold", ["vehicleId", "holdActive"])
    // SCRUM-208 — THE EXACT DIRECT-HOLD RANGE.
    //
    // Leads with the representation discriminator so that every row in the
    // range `(org, vehicle, usesVehicleHoldRows: false, holdActive: true)` is
    // BY CONSTRUCTION a live direct hold. Sliced deposits are excluded by the
    // range itself rather than by a post-filter, which is the whole point:
    // `by_vehicle_hold` returns them and the legacy reader has to notice and
    // discard them AFTER a capped read, so 50 stale rows can hide a live one.
    //
    // Legacy rows (`usesVehicleHoldRows: undefined`) fall OUTSIDE this range,
    // which is correct in both directions — before activation this path is not
    // consulted for authority, and after it a legacy row is corruption rather
    // than a row to be quietly included.
    .index("by_org_vehicle_direct_hold", ["orgId", "vehicleId", "usesVehicleHoldRows", "holdActive"]),

  // Tracks every vehicle a multi-vehicle deposit holds, not just the
  // deposit's primary `vehicleId`. Only written for deposits on quotes with
  // more than one vehicle — single-vehicle deposits (the vast majority) get
  // zero rows here and rely solely on `deposits.by_vehicle_hold` as before.
  /**
   * Which cars one reservation deposit is holding, and — on a multi-vehicle
   * quote — how much of it belongs to each.
   *
   * The deposit itself stays quote-scoped: the customer paid one عربون against
   * one receipt voucher for one deal, and `deposits` holds exactly one row for
   * it. What this table adds is the ALLOCATION, which is a separate decision
   * and has to be made by a person.
   *
   * Nothing derives an allocation. Not FIFO, not proportionally to price, not
   * `min(deposit, thisCarsBill)`, and above all not by reading the deposit
   * row's own `vehicleId` — that field is only ever the quote's first line
   * item, and treating it as an allocation silently assigns the whole deposit
   * to whichever car happened to be listed first. A suggestion may be offered
   * in the UI; only a confirmed, persisted allocation is accounting truth.
   */
  depositVehicleHolds: defineTable({
    orgId: v.id("organizations"),
    depositId: v.id("deposits"),
    vehicleId: v.id("vehicles"),
    active: v.boolean(),
    createdAt: v.number(),
    /**
     * How much of the deposit is allocated to THIS car. Absent means not yet
     * allocated — which is not zero: an unallocated multi-vehicle quote cannot
     * finalize any of its cars, whereas an explicit zero is a decision that
     * this car carries none of the deposit and may complete on that basis.
     *
     * The invariant is `sum(active allocations) <= held deposit`. The shortfall
     * is the quote-level unallocated balance, which stays a customer deposit
     * liability until somebody allocates or resolves it.
     */
    allocatedAmountMinor: v.optional(v.number()),
    allocatedAt: v.optional(v.number()),
    allocatedBy: v.optional(v.id("users")),
    /**
     * What became of this vehicle's slice.
     *
     *  - ALLOCATED — assigned and still held.
     *  - APPLIED — consumed by that vehicle's completed sale. An applied slice
     *    is real money already credited against a live invoice: it can be
     *    neither refunded nor re-allocated while that sale stands.
     *  - REVERSING — the sale was cancelled and this slice's own accounting
     *    entry is being backed out. Durable rather than momentary, because the
     *    reversal goes to the outbox when no period is open, and a slice whose
     *    journal has not actually been reversed must not yet be spendable.
     *  - RELEASED_AWAITING_DECISION — the slice is off its sale (or its vehicle
     *    left the deal) and the journal is reversed. It needs an explicit
     *    decision. It is deliberately NOT returned to the pool automatically:
     *    money silently moving from the car it was allocated against to
     *    another one is precisely what an allocation exists to prevent.
     *  - RESOLVED — that decision has been made and recorded on
     *    `resolutionTreatment`. Terminal.
     *
     * RESOLVED exists because the alternative — expressing a decision by
     * zeroing the amount and leaving the status at RELEASED_AWAITING_DECISION —
     * made refunded and forfeited money re-enter the quote's unallocated
     * balance, and left the slice eligible to be resolved a second time.
     *
     * A terminal row is never rewritten into a new life. RETURN_TO_UNALLOCATED
     * and REALLOCATE_TO_VEHICLE both INSERT a fresh hold and leave the old one
     * where it is, so both histories survive and the vehicle a slice was taken
     * off is immediately eligible to be allocated and sold again.
     */
    allocationStatus: v.optional(
      v.union(
        v.literal("ALLOCATED"),
        v.literal("APPLIED"),
        v.literal("REVERSING"),
        v.literal("RELEASED_AWAITING_DECISION"),
        v.literal("RESOLVED")
      )
    ),
    /** What was decided about a RELEASED slice. Set with the RESOLVED status. */
    resolutionTreatment: v.optional(
      v.union(
        v.literal("REALLOCATE_TO_VEHICLE"),
        v.literal("RETURN_TO_UNALLOCATED"),
        v.literal("REFUND_TO_CUSTOMER"),
        v.literal("FORFEITED"),
        v.literal("OTHER")
      )
    ),
    /** Which sale consumed it, when APPLIED. */
    appliedSaleId: v.optional(v.id("sales")),
    /**
     * The terminal slice this one was created out of — a released share
     * re-allocated to another car, or returned to the pool and re-opened
     * against the same one. Both rows are kept: the old one records what was
     * decided, this one records what happened next.
     */
    sourceHoldId: v.optional(v.id("depositVehicleHolds")),
    /** Why it was released, and what a human decided to do with it. */
    releaseReason: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    resolvedBy: v.optional(v.id("users")),
    /**
     * SCRUM-195 — THE EXACT COMMITMENT EPISODE THIS SLICE WAS CREATED
     * ALONGSIDE, and the only thing that says what its money is evidence OF.
     *
     * A deposit taken with a reservation is RESERVATION evidence that happens
     * to carry a deposit; the same deposit on the deal's other car is DEPOSIT
     * evidence. The row itself cannot tell them apart, and the answer used to
     * be rediscovered by reading every episode sharing this deposit and this
     * vehicle — correct, but a read that grows with the deal's history until it
     * meets Convex's transaction limit. A pointer answers it in one `get`.
     *
     * A POINTER, not copied evidence columns: duplicating `evidenceKind` and
     * the reference onto the hold would create a second, independently mutable
     * copy of the same truth, and two copies of a fact are two facts.
     *
     * ⚠️ OPTIONAL IN THE SCHEMA, MANDATORY AT THE AUTHORITY. Holds written
     * before the canonical model exist and have no episode to point at — that
     * is the class SCRUM-201 owns, and forcing the column required here would
     * make this a production migration rather than a bounded correction. Every
     * Phase-1 writer populates it, and `evidenceForDepositHold` REFUSES a hold
     * that lacks it rather than assuming a kind.
     */
    sourceCommitmentClaimId: v.optional(v.id("vehicleCommitmentClaims")),
  })
    .index("by_deposit", ["depositId"])
    .index("by_vehicle_active", ["vehicleId", "active"])
    .index("by_deposit_vehicle", ["depositId", "vehicleId"])
    // SCRUM-208 — THE EXACT SLICE-HOLD RANGE, tenant-scoped.
    //
    // `by_vehicle_active` is bare, so every caller has to remember to filter by
    // org after reading. Leading with orgId makes the tenant boundary part of
    // the access path, and every row in `(org, vehicle, active: true)` is by
    // construction a live slice.
    .index("by_org_vehicle_active", ["orgId", "vehicleId", "active"]),

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
    .index("by_org_consumed_sale", ["orgId", "consumedBySaleId"]),

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
    .index("by_reservation", ["reservationId"]),

  /**
   * One immutable row per application of deposit money to a sale.
   *
   * ## Why an identity, and not a lookup
   *
   * A reservation deposit is quote-scoped and a quote can carry several cars,
   * so one `deposits` row can be applied several times — once per car, each
   * against a different sale, each its own movement of money. Reversal used to
   * find its journal by `(orgId, sourceType: "deposits", sourceId: depositId)`
   * and take the FIRST match, which meant cancelling car B's sale reversed
   * whichever application posted first — car A's, against an invoice that is
   * still live. Nothing in the data could tell the two apart.
   *
   * So every application records the full identity of what it did, including
   * the exact accounting-event coordinates AS WRITTEN. Reversal reads them back
   * rather than re-deriving them: a derivation that drifts from what was posted
   * finds nothing, and `reverseEventIfPosted` answers "nothing to reverse" the
   * same way it answers "already reversed" — silently.
   *
   * Rows are append-only apart from their own status transition
   * APPLIED → REVERSING → REVERSED.
   */
  depositApplications: defineTable({
    orgId: v.id("organizations"),
    depositId: v.id("deposits"),
    quoteId: v.optional(v.id("quotes")),
    /** Position of the car on `quote.vehicleItems` — the quote line. */
    quoteLineIndex: v.optional(v.number()),
    vehicleId: v.id("vehicles"),
    saleId: v.id("sales"),
    customerId: v.id("customers"),
    /**
     * The allocation consumed. Absent on a single-vehicle quote, where
     * `deposits.create` writes no hold rows because there is one place the
     * money can go and no decision to make.
     */
    holdId: v.optional(v.id("depositVehicleHolds")),
    amountMinor: v.number(),
    currency: v.string(),
    /**
     * Which account the application credited. The two settle entirely
     * different things, so a reversal that targets the wrong one reverses
     * nothing at all.
     */
    treatment: v.union(
      v.literal("CUSTOMER_RECEIVABLE"),
      v.literal("SUPPLIER_SETTLEMENT"),
      // The deposit is consideration for a car invoiced to a financing
      // company. It releases the deposit liability like the others, but the
      // release is a line INSIDE the financed sale's own journal rather than a
      // second entry beside it — so this application posts no event of its own.
      v.literal("FINANCED_SALE_CONSIDERATION")
    ),
    // ── the accounting identity, exactly as posted ──────────────────────────
    eventType: v.string(),
    eventSourceType: v.string(),
    eventSourceId: v.string(),
    eventVersion: v.number(),
    eventIdempotencyKey: v.string(),
    status: v.union(
      v.literal("APPLIED"),
      v.literal("REVERSING"),
      v.literal("REVERSED")
    ),
    appliedAt: v.number(),
    appliedBy: v.id("users"),
    reversalStartedAt: v.optional(v.number()),
    reversedAt: v.optional(v.number()),
    reversedBy: v.optional(v.id("users")),
    reversalReason: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_sale", ["saleId"])
    .index("by_deposit", ["depositId"])
    .index("by_quote", ["quoteId"])
    .index("by_hold", ["holdId"])
    .index("by_org_event_key", ["orgId", "eventIdempotencyKey"])
    .index("by_org_customer", ["orgId", "customerId"]),

  // Receipt voucher (سند قبض) auto-generated as proof of payment whenever a
  // deposit is recorded — one per deposit.
  paymentVouchers: defineTable({
    orgId: v.id("organizations"),
    depositId: v.id("deposits"),
    voucherNumber: v.string(),
    customerId: v.id("customers"),
    customerNameSnapshot: v.string(),
    descriptionAr: v.string(),
    amount: v.number(),
    amountMinor: v.number(),
    currency: v.string(),
    issuedAt: v.number(),
    issuedBy: v.id("users"),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_deposit", ["depositId"])
    .index("by_customer", ["customerId"]),

  receivables: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    saleId: v.optional(v.id("sales")),
    quoteId: v.optional(v.id("quotes")),
    applicationId: v.optional(v.id("financeApplications")),
    customerId: v.id("customers"),
    vehicleId: v.optional(v.id("vehicles")),
    sourceType: v.union(
      v.literal("CUSTOMER_DEPOSIT"),
      v.literal("RESERVATION_PAYMENT"),
      v.literal("INTERNAL_INSTALLMENT"),
      v.literal("BANK_FINANCED_BALANCE"),
      v.literal("BANK_TRANSFER"),
      v.literal("PAYMENT_LINK"),
      v.literal("CHEQUE"),
      v.literal("OTHER")
    ),
    title: v.string(),
    originalAmount: v.number(),
    outstandingAmount: v.number(),
    dueDate: v.number(),
    status: v.union(
      v.literal("OPEN"),
      v.literal("PARTIALLY_PAID"),
      v.literal("PAID"),
      v.literal("OVERDUE"),
      v.literal("RESCHEDULED"),
      v.literal("CANCELLED"),
      v.literal("REFUNDED")
    ),
    installmentNumber: v.optional(v.number()),
    totalInstallments: v.optional(v.number()),
    paymentPlanLabel: v.optional(v.string()),
    assignedTo: v.optional(v.id("users")),
    canonicalReceivableDocumentId: v.optional(v.id("receivableDocuments")),
    lastReminderAt: v.optional(v.number()),
    lastPaymentAt: v.optional(v.number()),
    notes: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_status_and_dueDate", ["orgId", "status", "dueDate"])
    .index("by_org_dueDate", ["orgId", "dueDate"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_sale", ["saleId"])
    .index("by_quote", ["quoteId"])
    .index("by_application", ["applicationId"])
    .index("by_assignedTo", ["assignedTo"]),

  collectionPayments: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    receivableId: v.optional(v.id("receivables")),
    customerId: v.id("customers"),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    chequeId: v.optional(v.id("postDatedCheques")),
    canonicalPaymentId: v.optional(v.id("canonicalPayments")),
    paymentAllocationId: v.optional(v.id("paymentAllocations")),
    reconciliationId: v.optional(v.id("cashierReconciliations")),
    direction: v.union(v.literal("IN"), v.literal("OUT")),
    method: v.union(
      v.literal("CASH"),
      v.literal("BANK_TRANSFER"),
      v.literal("CHEQUE"),
      v.literal("PAYMENT_LINK"),
      v.literal("CARD"),
      v.literal("DEPOSIT_APPLIED"),
      v.literal("REFUND"),
      v.literal("OTHER")
    ),
    amount: v.number(),
    paymentDate: v.number(),
    status: v.union(
      v.literal("POSTED"),
      v.literal("PENDING_CLEARANCE"),
      v.literal("VOIDED")
    ),
    idempotencyKey: v.optional(v.string()),
    reference: v.optional(v.string()),
    cashierId: v.id("users"),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    voidedAt: v.optional(v.number()),
    voidedBy: v.optional(v.id("users")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_paymentDate", ["orgId", "paymentDate"])
    .index("by_receivable", ["receivableId"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_org_cashier", ["orgId", "cashierId"])
    .index("by_reconciliation", ["reconciliationId"])
    .index("by_cheque", ["chequeId"]),

  postDatedCheques: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    receivableId: v.optional(v.id("receivables")),
    customerId: v.id("customers"),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    // Set when this cheque is the registered expected-payment method for a
    // finance application, ahead of finalizeDeal — see registerExpectedPayment.
    applicationId: v.optional(v.id("financeApplications")),
    bank: v.string(),
    chequeNumber: v.string(),
    chequeDate: v.number(),
    amount: v.number(),
    depositedDate: v.optional(v.number()),
    status: v.union(
      v.literal("HELD"),
      v.literal("DEPOSITED"),
      v.literal("CLEARED"),
      v.literal("RETURNED"),
      v.literal("REPLACED"),
      v.literal("CANCELLED")
    ),
    replacementChequeId: v.optional(v.id("postDatedCheques")),
    returnedAt: v.optional(v.number()),
    returnReason: v.optional(v.string()),
    clearedAt: v.optional(v.number()),
    returnedAfterClearing: v.optional(v.boolean()),
    bankFeeMinor: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_status_and_chequeDate", ["orgId", "status", "chequeDate"])
    .index("by_org_chequeDate", ["orgId", "chequeDate"])
    .index("by_org_bank_and_chequeNumber", ["orgId", "bank", "chequeNumber"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_receivable", ["receivableId"])
    .index("by_replacementCheque", ["replacementChequeId"])
    .index("by_application", ["applicationId"]),

  cashierReconciliations: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    cashierId: v.id("users"),
    businessDate: v.number(),
    expectedCash: v.number(),
    countedCash: v.number(),
    difference: v.number(),
    status: v.union(
      v.literal("OPEN"),
      v.literal("SUBMITTED"),
      v.literal("APPROVED"),
      v.literal("REJECTED")
    ),
    idempotencyKey: v.optional(v.string()),
    notes: v.optional(v.string()),
    reviewedBy: v.optional(v.id("users")),
    reviewedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_businessDate", ["orgId", "businessDate"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_cashier", ["orgId", "cashierId"]),

  collectionApprovalRequests: defineTable({
    orgId: v.id("organizations"),
    receivableId: v.id("receivables"),
    customerId: v.id("customers"),
    requestedBy: v.id("users"),
    requestType: v.union(
      v.literal("REFUND"),
      v.literal("RESCHEDULE"),
      v.literal("CANCEL_RECEIVABLE")
    ),
    status: v.union(
      v.literal("PENDING"),
      v.literal("APPROVED"),
      v.literal("REJECTED")
    ),
    requestedAmount: v.optional(v.number()),
    requestedDueDate: v.optional(v.number()),
    disbursementMethod: v.optional(v.union(
      v.literal("CASH"),
      v.literal("BANK_TRANSFER"),
      v.literal("CHEQUE"),
      v.literal("CARD")
    )),
    reason: v.string(),
    decisionNotes: v.optional(v.string()),
    decidedBy: v.optional(v.id("users")),
    decidedAt: v.optional(v.number()),
    responseIdempotencyKey: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_receivable", ["receivableId"])
    .index("by_requestedBy", ["requestedBy"])
    .index("by_org_customer", ["orgId", "customerId"]),

  collectionReminders: defineTable({
    orgId: v.id("organizations"),
    receivableId: v.optional(v.id("receivables")),
    chequeId: v.optional(v.id("postDatedCheques")),
    customerId: v.id("customers"),
    channel: v.union(
      v.literal("WHATSAPP"),
      v.literal("SMS"),
      v.literal("EMAIL"),
      v.literal("MANUAL")
    ),
    messageType: v.union(
      v.literal("DUE_SOON"),
      v.literal("OVERDUE"),
      v.literal("CHEQUE_UPCOMING"),
      v.literal("CHEQUE_RETURNED")
    ),
    status: v.union(
      v.literal("PENDING"),
      v.literal("SENT"),
      v.literal("FAILED"),
      v.literal("SKIPPED")
    ),
    scheduledAt: v.number(),
    sentAt: v.optional(v.number()),
    error: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status_and_scheduledAt", ["orgId", "status", "scheduledAt"])
    .index("by_receivable", ["receivableId"])
    .index("by_cheque", ["chequeId"])
    .index("by_org_customer", ["orgId", "customerId"]),

  companyDocumentRules: defineTable({
    orgId: v.id("organizations"),
    companyId: v.optional(v.id("financeCompanies")), // Null means required for ALL deals (e.g., ID)
    documentName: v.string(), // e.g., "Salary Certificate"
    isRequired: v.boolean(),
    description: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_company", ["companyId"]),

  applicationDocuments: defineTable({
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    ruleId: v.id("companyDocumentRules"),
    fileId: v.optional(v.id("_storage")),
    status: v.union(
      v.literal("MISSING"),
      v.literal("UPLOADED"),
      v.literal("VERIFIED"),
      v.literal("REJECTED"),
      v.literal("WAIVED")
    ),
    rejectionReason: v.optional(v.string()),
    waiverReason: v.optional(v.string()),
    uploadedAt: v.optional(v.number()),
    verifiedBy: v.optional(v.id("users")),
    waivedBy: v.optional(v.id("users")),
    waivedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_application", ["applicationId"])
    .index("by_rule", ["ruleId"]),

  branches: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    address: v.optional(v.string()),
    phone: v.optional(v.string()),
    // Extra numbers for this branch (mobile lines, additional sales staff, etc.)
    // shown alongside `phone` on the public dealer website.
    additionalPhones: v.optional(v.array(v.string())),
    managerId: v.optional(v.id("users")),
    isActive: v.boolean(),
  })
    .index("by_org", ["orgId"]),

  transactions: defineTable({
    /**
     * Accounting turnover for this row, when it differs from `amount`.
     *
     * `amount` is the cash side of the row — the sale price less anything
     * already collected against the deal. On a consigned sale the deal is a car
     * the dealership never owned, so its value is NOT its revenue. All three
     * numbers are real and none substitutes for another: the dealership
     * genuinely handled a 12,500 transaction, genuinely earned 3,000 on it, and
     * genuinely banked 9,500 at completion after a 3,000 deposit.
     *
     * Absent means the two are the same, which is every owned sale and every
     * row written before consigned accounting existed — so a reader that falls
     * back to `amount` gets the right answer for all of them.
     */
    recognizedRevenueAmount: v.optional(v.number()),
    /**
     * Cash received that is NOT revenue — a عربون against a liability.
     *
     * Written only on rows created after revenue recognition was separated
     * from cash movement, and it is what makes that separation deployable
     * without rewriting the back-book. `getProfitAndLoss` counted DEPOSIT as
     * revenue and compensated by writing the sale net of what was already
     * collected, which only reconciles when deposit and sale fall in one
     * period: a عربون in January and its sale in February reported revenue in
     * January for a car that had not been sold, and understated February by
     * the same amount.
     *
     * Simply dropping DEPOSIT from the revenue set would have understated every
     * historical period instead, because those sale rows are still net. So the
     * P&L excludes only the rows carrying this flag; anything without it keeps
     * the arithmetic it was written under and reads exactly as it does today.
     * Correcting the back-book is a separate, reviewed migration — see
     * `depositRevenueImpact`.
     */
    excludedFromRevenue: v.optional(v.boolean()),
    /**
     * The full ticket the deal was transacted at, before anything already
     * collected was netted off `amount`.
     *
     * `amount` is net of deposits, so reading it as gross transaction value
     * made a deposit REDUCE the reported size of a deal. See
     * utils/grossTransactionValue for the one definition all three reports use.
     */
    grossTransactionValueAmount: v.optional(v.number()),
    orgId: v.id("organizations"),
    type: v.union(v.literal("IN"), v.literal("OUT")),
    amount: v.number(),
    date: v.number(), // Timestamp
    category: v.union(
      v.literal("VEHICLE_SALE"), v.literal("VEHICLE_PURCHASE"),
      v.literal("EXPENSE"), v.literal("DEPOSIT"),
      v.literal("COLLECTION_PAYMENT"), v.literal("REFUND"),
      v.literal("PARTNER_DRAW"), v.literal("CAPITAL_INJECTION"),
      v.literal("CLAIM_PAYMENT"), v.literal("OTHER")
    ),
    description: v.string(), // "البيان"
    idempotencyKey: v.optional(v.string()),
    // Optional links to operational entities
    vehicleId: v.optional(v.id("vehicles")),
    customerId: v.optional(v.id("customers")),
    /**
     * The sale this row was written for — exact provenance, SCRUM-212.
     *
     * `voidSaleCashflowTransaction` used to find a sale's cashflow row by
     * (orgId, vehicleId, category, customerId). That tuple does not identify a
     * sale: the same customer buying the same car twice produces two rows each
     * matching the other's criteria, so tearing down the first voided the
     * second's live revenue — dropping it out of the P&L while its journal,
     * receivable and sale row all stayed live.
     *
     * Written by `createSaleTransaction` only. A row without it is not
     * sale-owned and is never voided by a sale cancellation.
     */
    saleId: v.optional(v.id("sales")),
    depositId: v.optional(v.id("deposits")),
    userId: v.optional(v.id("users")), // For partner draws/salaries
    expenseId: v.optional(v.id("expenses")),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_date", ["orgId", "date"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_org_customer", ["orgId", "customerId"])
    // Cancellation finds a sale's own cashflow rows by the sale itself.
    // Searching the vehicle range and filtering on category meant an edit to
    // either field moved a row out of reach while it kept its `saleId`, so a
    // cancelled deal could leave live revenue behind — SCRUM-212-R2.
    .index("by_org_sale", ["orgId", "saleId"]),

  fixedAssets: defineTable({
    orgId: v.id("organizations"),
    name: v.string(), // e.g., "أثاث مكتب"
    // Legacy field, kept optional through the widen-migrate-narrow transition —
    // GL Phase 11 replaces it with costMinor/currency. New rows leave it unset.
    purchaseValue: v.optional(v.number()),
    purchaseDate: v.number(), // Timestamp
    notes: v.optional(v.string()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
    // ─── GL Phase 11: capitalization + depreciation lifecycle ────────────────
    costMinor: v.optional(v.number()),
    currency: v.optional(v.string()),
    salvageValueMinor: v.optional(v.number()),
    usefulLifeMonths: v.optional(v.number()),
    method: v.optional(v.literal("STRAIGHT_LINE")),
    depreciationStartDate: v.optional(v.number()),
    status: v.optional(v.union(
      v.literal("ACTIVE"),
      v.literal("IMPAIRED"),
      v.literal("DISPOSED"),
    )),
    // Derived cache, kept in sync by the lifecycle mutations below — always
    // recomputable from fixedAssetEvents, never the source of truth.
    accumulatedDepreciationMinor: v.optional(v.number()),
    lastDepreciatedYearMonth: v.optional(v.string()), // "YYYY-MM" of the last posted depreciation run
    // Contractual month count actually depreciated so far — same role as
    // dealerProductDeferrals.monthsRecognized: distinct from
    // lastDepreciatedYearMonth, which alone can't tell depreciateAssetForMonth
    // whether the *next* call is the final contractual month (the one that
    // must absorb the remainder so the schedule finishes in exactly
    // usefulLifeMonths, not usefulLifeMonths+1).
    monthsDepreciated: v.optional(v.number()),
    disposedAt: v.optional(v.number()),
    disposalProceedsMinor: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_status", ["status"]),

  // Immutable, append-only log of every capitalization/depreciation/impairment/
  // disposal event posted for a fixed asset — the audit trail behind the
  // derived accumulatedDepreciationMinor cache on fixedAssets.
  fixedAssetEvents: defineTable({
    orgId: v.id("organizations"),
    assetId: v.id("fixedAssets"),
    type: v.union(
      v.literal("CAPITALIZE"),
      v.literal("DEPRECIATE"),
      v.literal("IMPAIR"),
      v.literal("DISPOSE"),
    ),
    amountMinor: v.number(),
    currency: v.string(),
    occurredAt: v.number(),
    accountingEventId: v.optional(v.id("accountingEvents")),
    actorId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_asset", ["assetId"])
    .index("by_org_asset_time", ["orgId", "assetId", "occurredAt"]),

  partnerEquity: defineTable({
    orgId: v.id("organizations"),
    partnerName: v.string(), // e.g., "علاء جراد"
    userId: v.optional(v.id("users")),
    // Legacy major-unit fields, frozen as of GL Phase 12 — no mutation writes
    // them anymore. Superseded by openingBalanceMinor (GL Phase 17); kept
    // only until that backfill has run and been verified in production, per
    // the widen-migrate-narrow discipline this whole track follows.
    initialCapital: v.optional(v.number()),
    currentBalance: v.optional(v.number()),
    // GL Phase 17: minor-unit backfill of currentBalance. Once set, this is
    // what derivePartnerBalanceMinor reads as the opening base instead of
    // converting currentBalance live.
    openingBalanceMinor: v.optional(v.number()),
    notes: v.optional(v.string()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"]),

  // GL Phase 18: running per-(account, currency, period) totals, incremented
  // synchronously by postAccountingEvent/reverseAccountingEvent every time a
  // journal line posts. Lets trial balance / balance sheet sum O(periods)
  // snapshot rows for closed periods instead of collecting every journal
  // line ever posted; only the still-open containing period needs a bounded
  // scan of its own lines. Currency is part of the key (not in the phase
  // spec's original field list) because GL Phase 14 made a single account
  // able to carry lines in more than one currency — a snapshot without a
  // currency dimension would silently re-introduce that exact bug.
  accountBalanceSnapshots: defineTable({
    orgId: v.id("organizations"),
    accountId: v.id("chartOfAccounts"),
    currency: v.string(),
    periodId: v.id("accountingPeriods"),
    // Sharded counter: each account/currency/period is split across
    // SHARD_COUNT independent documents so concurrent postings to the same
    // hot account only ever OCC-conflict within a shard, not across the
    // whole account. The read path sums across shards, so this is
    // transparent to every caller of getCumulativeBalancesAsOf. Optional,
    // not required: rows written before sharding was added have no shard
    // field, and that's fine as-is — incrementAccountSnapshot's write
    // lookup always queries a concrete shard number, so it can never match
    // one of these old rows again; a fresh shard-tagged row just takes
    // over accumulating from here. The read path never filters on shard,
    // so the old row's already-accumulated total keeps counting correctly.
    shard: v.optional(v.number()),
    runningDebitMinor: v.number(),
    runningCreditMinor: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_account_currency_period_shard", ["orgId", "accountId", "currency", "periodId", "shard"])
    .index("by_org_period", ["orgId", "periodId"]),

  // GL Phase 15: full cash-drawer lifecycle. Distinct from the simpler,
  // pre-existing cashierReconciliations (open-float-free count-vs-expected
  // snapshot with no movement ledger) — this is the fuller open→count→
  // close→approve lifecycle with its own movement log, per the phase spec.
  cashDrawerSessions: defineTable({
    orgId: v.id("organizations"),
    branchId: v.optional(v.id("branches")),
    openingFloatMinor: v.number(),
    currency: v.string(),
    openedBy: v.id("users"),
    openedAt: v.number(),
    status: v.union(
      v.literal("OPEN"),
      v.literal("COUNTING"),
      v.literal("CLOSED"),
      v.literal("APPROVED"),
    ),
    closingCountMinor: v.optional(v.number()),
    varianceMinor: v.optional(v.number()),
    closedBy: v.optional(v.id("users")),
    closedAt: v.optional(v.number()),
    approvedBy: v.optional(v.id("users")),
    approvedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_branch_status", ["orgId", "branchId", "status"]),

  // Append-only activity log behind a session's expected-cash computation.
  cashMovements: defineTable({
    orgId: v.id("organizations"),
    sessionId: v.id("cashDrawerSessions"),
    type: v.union(
      v.literal("SALE"),
      v.literal("PAYOUT"),
      v.literal("HANDOVER"),
      v.literal("BANK_DEPOSIT"),
    ),
    amountMinor: v.number(),
    occurredAt: v.number(),
    notes: v.optional(v.string()),
    accountingEventId: v.optional(v.id("accountingEvents")),
    actorId: v.id("users"),
    createdAt: v.number(),
    idempotencyKey: v.string(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_session", ["orgId", "sessionId"])
    .index("by_org_idempotency", ["orgId", "idempotencyKey"]),

  // Phase 41: Accounting Depth — bank accounts are reference/reconciliation
  // records, not new GL control accounts (there is still exactly one
  // SYSTEM_KEYS.BANK_ACCOUNT control account). Opening balance is a reporting-
  // layer number (not a posted journal entry) added to a dated ledger scan of
  // that control account — see convex/bankAccounts.ts. Only one account per
  // org may have isReconciliationTarget = true.
  bankAccounts: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    bankName: v.optional(v.string()),
    iban: v.optional(v.string()),
    accountNumber: v.optional(v.string()),
    currency: v.string(),
    openingBalanceMinor: v.number(),
    openingBalanceDate: v.number(),
    isActive: v.boolean(),
    isReconciliationTarget: v.boolean(),
    notes: v.optional(v.string()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_active", ["orgId", "isActive"]),

  // Uploaded bank-statement rows for the reconciliation-target bank account,
  // matched against posted journalLines on SYSTEM_KEYS.BANK_ACCOUNT.
  bankStatementLines: defineTable({
    orgId: v.id("organizations"),
    bankAccountId: v.id("bankAccounts"),
    importBatchId: v.string(),
    statementDate: v.number(),
    description: v.string(),
    amountMinor: v.number(),
    status: v.union(v.literal("UNMATCHED"), v.literal("MATCHED"), v.literal("IGNORED")),
    matchedJournalLineId: v.optional(v.id("journalLines")),
    matchedAt: v.optional(v.number()),
    matchedBy: v.optional(v.id("users")),
    // Set when status flips to IGNORED — a discrepancy removed from the
    // close-blocking unmatched count must carry a documented reason and
    // who/when, not disappear from the control silently.
    ignoredAt: v.optional(v.number()),
    ignoredBy: v.optional(v.id("users")),
    ignoreReason: v.optional(v.string()),
    createdAt: v.number(),
    createdBy: v.id("users"),
  })
    .index("by_org_bankAccount", ["orgId", "bankAccountId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_matched_journal_line", ["matchedJournalLineId"]),

  // GL Phase 17: a one-time accountant attestation that the legacy-to-GL
  // cutover for this org has been reviewed and is correct, carrying a
  // point-in-time snapshot of the numbers that were reviewed (not a live
  // computation) so the sign-off remains meaningful even as later activity
  // changes current totals.
  accountingCutoverSignOffs: defineTable({
    orgId: v.id("organizations"),
    snapshot: v.object({
      legacyTransactionCount: v.number(),
      migratedTransactionCount: v.number(),
      unmigratedTransactionCount: v.number(),
      // Per-currency breakdown, not a single mixed-currency total: an org's
      // currency can change over time (GL Phase 14), leaving historical
      // journal lines in more than one currency.
      trialBalanceByCurrency: v.array(v.object({
        currency: v.string(),
        totalDebitsMinor: v.number(),
        totalCreditsMinor: v.number(),
        isBalanced: v.boolean(),
      })),
      isBalanced: v.boolean(),
    }),
    notes: v.optional(v.string()),
    signedOffBy: v.id("users"),
    signedOffAt: v.number(),
  })
    .index("by_org", ["orgId"]),

  // GL Phase 14: org-defined exchange rates for optional reporting-currency
  // translation. Books always stay per-currency; these rates only produce
  // display-level translated figures in reports, never postings.
  exchangeRates: defineTable({
    orgId: v.id("organizations"),
    fromCurrency: v.string(),
    toCurrency: v.string(),
    rate: v.number(),
    asOfDate: v.number(),
    createdBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_pair", ["orgId", "fromCurrency", "toCurrency", "asOfDate"]),

  // GL Phase 12: immutable equity movements — the source of truth behind each
  // partner's balance. Append-only; corrections are new offsetting entries,
  // never edits.
  partnerEquityTransactions: defineTable({
    orgId: v.id("organizations"),
    partnerId: v.id("partnerEquity"),
    type: v.union(
      v.literal("CONTRIBUTION"),
      v.literal("DRAW"),
      v.literal("PROFIT_DISTRIBUTION"),
    ),
    amountMinor: v.number(),
    currency: v.string(),
    occurredAt: v.number(),
    notes: v.optional(v.string()),
    accountingEventId: v.optional(v.id("accountingEvents")),
    actorId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_partner_time", ["orgId", "partnerId", "occurredAt"]),

  claims: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    financingEntity: v.string(), // "جهة التمويل"
    buyerName: v.string(), // "اسم المشتري"
    // Legacy major-unit amount, frozen as of GL Phase 13 — new claims store
    // claimAmountMinor/currency instead. Narrowed in GL Phase 17.
    claimAmount: v.optional(v.number()),
    status: v.union(v.literal("PENDING"), v.literal("PAID"), v.literal("REJECTED"), v.literal("CANCELLED")),
    claimDate: v.number(),
    notes: v.optional(v.string()),
    // ─── GL Phase 13: subledger-backed claim lifecycle ────────────────────
    claimAmountMinor: v.optional(v.number()),
    currency: v.optional(v.string()),
    receivableDocumentId: v.optional(v.id("receivableDocuments")),
    settledAt: v.optional(v.number()),
    settledBy: v.optional(v.id("users")),
    rejectedAt: v.optional(v.number()),
    rejectedBy: v.optional(v.id("users")),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_org_status", ["orgId", "status"]),

  // ─── Payroll ──────────────────────────────────────────────────────────────
  // Fixed monthly salary per team member. History is kept by superseding rows
  // (active:false on the old one) rather than editing in place.
  employeeCompensation: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    monthlySalaryMinor: v.number(),
    currency: v.string(),
    effectiveFrom: v.number(),
    active: v.boolean(),
    createdAt: v.number(),
    createdBy: v.optional(v.id("users")),
    updatedAt: v.number(),
    updatedBy: v.optional(v.id("users")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_user", ["orgId", "userId"])
    .index("by_org_user_active", ["orgId", "userId", "active"]),

  // Salary advances (سلفة) — a recoverable ASSET (Employee Advances), NOT an
  // expense, until offset against a payslip or repaid.
  employeeAdvances: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    amountMinor: v.number(),
    recoveredMinor: v.number(),
    currency: v.string(),
    date: v.number(),
    method: v.optional(
      v.union(
        v.literal("CASH"),
        v.literal("BANK_TRANSFER"),
        v.literal("CHEQUE"),
        v.literal("CARD"),
      ),
    ),
    status: v.union(
      v.literal("OUTSTANDING"),
      v.literal("RECOVERED"),
      v.literal("WRITTEN_OFF"),
    ),
    note: v.optional(v.string()),
    createdBy: v.optional(v.id("users")),
    createdAt: v.number(),
    updatedAt: v.number(),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_user", ["orgId", "userId"])
    .index("by_org_status", ["orgId", "status"]),

  // One immutable row per advance recovery event (direct repayment or payroll
  // deduction). Each carries its own GL identity so partial repayments post
  // distinct EMPLOYEE_ADVANCE_RECOVERED entries and the Employee Advances asset
  // is credited exactly once per repayment.
  employeeAdvanceRecoveries: defineTable({
    orgId: v.id("organizations"),
    advanceId: v.id("employeeAdvances"),
    userId: v.id("users"),
    amountMinor: v.number(),
    currency: v.string(),
    method: v.optional(
      v.union(
        v.literal("CASH"),
        v.literal("BANK_TRANSFER"),
        v.literal("CHEQUE"),
        v.literal("CARD"),
      ),
    ),
    // "DIRECT" = repaid outside payroll; "PAYROLL" = deducted on a payslip.
    source: v.union(v.literal("DIRECT"), v.literal("PAYROLL")),
    payrollItemId: v.optional(v.id("payrollItems")),
    recoveredAt: v.number(),
    recoveredBy: v.id("users"),
    // Fingerprint for direct-repayment idempotency (advance+amount+method); a
    // retried recoverAdvance with the same key must not book a second recovery.
    idempotencyKey: v.optional(v.string()),
  })
    .index("by_org", ["orgId"])
    .index("by_advance", ["advanceId"])
    // Lets the outbox find every advance a payslip recovered, so a queued
    // PAYROLL_PAID can be held until each advance issuance has posted.
    .index("by_payroll_item", ["payrollItemId"])
    .index("by_org_idempotency", ["orgId", "idempotencyKey"]),

  // A monthly payroll run and its per-employee payslip items.
  payrollRuns: defineTable({
    orgId: v.id("organizations"),
    periodYear: v.number(),
    periodMonth: v.number(), // 1-12
    currency: v.string(),
    status: v.union(
      v.literal("DRAFT"),
      v.literal("APPROVED"),
      // Was APPROVED, but a pay-time recompute found the payable now differs
      // materially from what was approved (a new advance, a directly-paid or
      // cancelled commission, a directly-repaid advance). Payment is blocked
      // until it is re-approved — the run re-derives and re-freezes its totals.
      v.literal("NEEDS_REAPPROVAL"),
      v.literal("PAID"),
      v.literal("CANCELLED"),
    ),
    totalGrossMinor: v.number(),
    totalNetMinor: v.number(),
    // Why the run fell back to NEEDS_REAPPROVAL (shown to the approver).
    reapprovalReason: v.optional(v.string()),
    // Accounting date the salary/commission accrual is recognized on: the last
    // moment of the payroll period (UTC), so a retroactive run books its expense
    // in the month worked, not the month it was approved.
    accountingDate: v.optional(v.number()),
    // Immutable snapshot of gross/net at approval, so a pay-time recompute (a
    // commission paid directly, an advance repaid, a sale cancelled since
    // approval) leaves an audit trail instead of silently overwriting.
    approvedGrossMinor: v.optional(v.number()),
    approvedNetMinor: v.optional(v.number()),
    // The method the whole run was paid with (per-employee split not supported).
    paidMethod: v.optional(v.string()),
    createdBy: v.optional(v.id("users")),
    createdAt: v.number(),
    approvedBy: v.optional(v.id("users")),
    approvedAt: v.optional(v.number()),
    paidBy: v.optional(v.id("users")),
    paidAt: v.optional(v.number()),
    cancelledBy: v.optional(v.id("users")),
    cancelledAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_period", ["orgId", "periodYear", "periodMonth"])
    .index("by_org_status", ["orgId", "status"]),

  payrollItems: defineTable({
    orgId: v.id("organizations"),
    runId: v.id("payrollRuns"),
    userId: v.id("users"),
    baseSalaryMinor: v.number(),
    commissionMinor: v.number(),
    otherEarningsMinor: v.number(),
    advanceDeductionMinor: v.number(),
    otherDeductionMinor: v.number(),
    grossMinor: v.number(),
    netMinor: v.number(),
    // Immutable snapshot of gross/net frozen at (re)approval. grossMinor/netMinor
    // above are overwritten with the actually-paid figures at payment; these are
    // what the approver authorized and are what a pay-time drift check compares
    // against to decide whether the run needs re-approval.
    approvedGrossMinor: v.optional(v.number()),
    approvedNetMinor: v.optional(v.number()),
    currency: v.string(),
    // Unpaid commission sales this payslip settles (Option A: commissions are
    // paid through payroll). Marked paid when the run is paid.
    commissionSaleIds: v.array(v.id("sales")),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_run", ["runId"])
    .index("by_org_user", ["orgId", "userId"]),

  wizardDrafts: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    paymentType: v.string(),
    currentStep: v.number(),
    wizardData: v.object({
      vehicleId: v.string(),
      vehiclePrice: v.number(),
      desiredProfit: v.number(),
      downPayment: v.number(),
      termMonths: v.number(),
      selectedCompanyId: v.optional(v.string()),
      manualProfitRate: v.optional(v.number()),
      manualInsuranceRate: v.optional(v.number()),
      manualExecutionCommission: v.optional(v.number()),
      manualExecutionFees: v.optional(v.number()),
      manualIncludesCommissionInDebt: v.optional(v.boolean()),
      recipientName: v.optional(v.string()),
    }),
    selectedCustomerId: v.optional(v.string()),
    savedAt: v.number(),
  })
    .index("by_org_user", ["orgId", "userId"]),

  orgSettings: defineTable({
    orgId: v.id("organizations"),
    currency: v.string(),
    currencySymbol: v.string(),
    vatRate: v.optional(v.number()),
    country: v.optional(v.string()),
    timezone: v.optional(v.string()),
    enabledPaymentTypes: v.array(v.string()),
    logoStorageId: v.optional(v.id("_storage")),
    primaryColor: v.optional(v.string()),
    dealershipName: v.optional(v.string()),
    // The officially registered legal entity name (e.g. "Al-Noor Trading Co. LLC"),
    // shown alongside dealershipName (the trade/showroom name) on every printed
    // legal document — bill of sale, quotes, receipt vouchers.
    legalCompanyName: v.optional(v.string()),
    dealershipAddress: v.optional(v.string()),
    dealershipPhone: v.optional(v.string()),
    // Extra org-wide numbers (sales line, support line, etc.) shown alongside
    // dealershipPhone on the public dealer website. dealershipPhone stays the
    // one used for WhatsApp deep links.
    dealershipPhones: v.optional(v.array(v.string())),
    whatsappPhoneNumberId: v.optional(v.string()),
    whatsappApiToken: v.optional(v.string()),
    whatsappWebhookSecret: v.optional(v.string()),
    approvalThresholdEnabled: v.optional(v.boolean()),
    approvalMinProfitPercent: v.optional(v.number()),
    commissionTiers: v.optional(
      v.array(v.object({ minProfitAmount: v.number(), commissionPct: v.number() }))
    ),
    commissionMode: v.optional(v.union(v.literal("AUTO_TIERS"), v.literal("AUTO_MEMBER"), v.literal("MANUAL"))),
    // Default number of days a vehicle reservation/deposit hold (عربون) lasts
    // before it auto-expires. Falls back to DEFAULT_RESERVATION_HOLD_DAYS
    // (convex/utils/depositHelpers.ts) when unset.
    reservationHoldDays: v.optional(v.number()),
    instagramBusinessAccountId: v.optional(v.string()),
    // The IG profile's "user_id" field — distinct from instagramBusinessAccountId
    // (the OAuth-returned "id"). Meta uses *this* ID in webhook entry[].id;
    // the other one is used for outbound Graph API path calls. Confirmed by
    // direct API probe 2026-06-22 — not documented anywhere obvious.
    instagramWebhookAccountId: v.optional(v.string()),
    instagramAccessToken: v.optional(v.string()),
    instagramTokenExpiresAt: v.optional(v.number()),
    instagramPageName: v.optional(v.string()),
    socialAutoPostEnabled: v.optional(v.boolean()),
    instagramAutoReplyEnabled: v.optional(v.boolean()),
    instagramAutoReplyMessages: v.optional(v.array(v.string())),
    instagramAutoReplyMobileReceivedMessage: v.optional(v.string()),
    instagramAutoReplyLastIndex: v.optional(v.number()),
    // Whether an inbound comment/DM creates a CRM lead. Undefined is treated
    // as true (preserves pre-toggle behavior for orgs that connected before
    // this setting existed) — the interaction is always captured in the
    // Social Inbox and still gets auto-replied to either way; this only
    // gates whether it also produces a Lead in the pipeline + notification.
    instagramLeadFromCommentsEnabled: v.optional(v.boolean()),
    instagramLeadFromDmsEnabled: v.optional(v.boolean()),
    instagramLeadFromDmsRequiresMobile: v.optional(v.boolean()),
    facebookPageId: v.optional(v.string()),
    facebookPageAccessToken: v.optional(v.string()),
    facebookPageName: v.optional(v.string()),
    // The Facebook user ID of whoever connected the Page (from GET /me
    // during token exchange) — distinct from facebookPageId. Needed because
    // Meta's deauthorize/data-deletion signed_request payloads only carry
    // the connecting user's ID, not the Page ID, so this is the only way to
    // resolve which org's connection to clear from those callbacks.
    facebookConnectedByUserId: v.optional(v.string()),
    // Page tokens derived from a long-lived user token typically don't
    // expire, but kept optional/nullable for parity with Instagram and in
    // case Meta changes that behavior.
    facebookTokenExpiresAt: v.optional(v.number()),
    facebookAutoReplyEnabled: v.optional(v.boolean()),
    facebookAutoReplyMessages: v.optional(v.array(v.string())),
    facebookAutoReplyMobileReceivedMessage: v.optional(v.string()),
    facebookAutoReplyLastIndex: v.optional(v.number()),
    facebookLeadFromCommentsEnabled: v.optional(v.boolean()),
    facebookLeadFromDmsEnabled: v.optional(v.boolean()),
    facebookLeadFromDmsRequiresMobile: v.optional(v.boolean()),
    generatedLeadAutoAssignmentEnabled: v.optional(v.boolean()),
    // Smart Reply: rule-based price/financing/availability/vehicleInfo/location
    // auto-answers, distinct from the canned round-robin auto-reply above --
    // requires a vehicleId match (except location/greeting) and only fires for
    // keyword-matched questions. Off by default for all orgs.
    instagramSmartReplyEnabled: v.optional(v.boolean()),
    facebookSmartReplyEnabled: v.optional(v.boolean()),
    // "calculated": compute a "starting from X/month" figure via
    // calculateUnifiedMurabaha using smartReplyDefaultFinanceCompanyId + that
    // company's own maxTermMonths + smartReplyDefaultDownPaymentPercent.
    // "generic": static financing copy, no computed number. Default when unset: generic.
    smartReplyFinancingMode: v.optional(v.union(v.literal("calculated"), v.literal("generic"))),
    smartReplyDefaultDownPaymentPercent: v.optional(v.number()), // e.g. 20 for 20%
    smartReplyDefaultFinanceCompanyId: v.optional(v.id("financeCompanies")),
    // "public": comment-triggered smart replies post publicly under the comment
    // (current canned-reply behavior). "dm": sent privately via DM instead.
    // Shared across both platforms. Default when unset: public.
    smartReplyVisibility: v.optional(v.union(v.literal("public"), v.literal("dm"))),
    // Fallback language for a reply when the inbound text has no detectable
    // script (emoji-only, numeric-only, etc). Default when unset: "en".
    smartReplyDefaultLocale: v.optional(v.union(v.literal("en"), v.literal("ar"))),
    // Granular canned-reply toggles. When set, these override the platform-level
    // facebookAutoReplyEnabled / instagramAutoReplyEnabled for the given kind.
    // Undefined = fall back to the platform-level flag (backward-compatible).
    facebookAutoReplyForDmsEnabled: v.optional(v.boolean()),
    facebookAutoReplyForCommentsEnabled: v.optional(v.boolean()),
    instagramAutoReplyForDmsEnabled: v.optional(v.boolean()),
    instagramAutoReplyForCommentsEnabled: v.optional(v.boolean()),
    // Per-kind smart-reply toggles (same backward-compat pattern).
    facebookSmartReplyForDmsEnabled: v.optional(v.boolean()),
    facebookSmartReplyForCommentsEnabled: v.optional(v.boolean()),
    instagramSmartReplyForDmsEnabled: v.optional(v.boolean()),
    instagramSmartReplyForCommentsEnabled: v.optional(v.boolean()),
    // Custom Smart Reply response templates as JSON strings keyed by intent.
    // Supported keys (same {placeholder} tokens as the built-in defaults):
    //   greeting, location, locationFallback, priceAvailable, financingGeneric,
    //   financingCalculated, availableYes, availableSold, availableUnclear, vehicleInfo
    // Undefined = use the built-in copy from socialSmartReplyEn / socialSmartReplyAr.
    smartReplyCustomTemplatesEn: v.optional(v.string()),
    smartReplyCustomTemplatesAr: v.optional(v.string()),
    // Client-safe picker list: id + name only (no tokens).
    // Populated by exchangeCodeForToken when the user manages >1 Facebook Page.
    // Cleared after selectFacebookPage completes.
    facebookAvailablePages: v.optional(
      v.array(v.object({ id: v.string(), name: v.string() }))
    ),
    // Server-only pending credentials — includes access tokens; never sent to clients.
    // Cleared after selectFacebookPage completes.
    facebookPendingCredentials: v.optional(
      v.array(v.object({ id: v.string(), name: v.string(), token: v.string() }))
    ),
  })
    .index("by_org", ["orgId"])
    .index("by_instagram_business_account_id", ["instagramBusinessAccountId"])
    .index("by_instagram_webhook_account_id", ["instagramWebhookAccountId"])
    .index("by_facebook_page_id", ["facebookPageId"])
    .index("by_facebook_connected_user_id", ["facebookConnectedByUserId"]),

  leadAssignmentCursors: defineTable({
    orgId: v.id("organizations"),
    lastAssignedUserId: v.optional(v.id("users")),
    updatedAt: v.number(),
  }).index("by_org", ["orgId"]),

  websiteSettings: defineTable({
    orgId: v.id("organizations"),
    enabled: v.boolean(),
    status: v.union(
      v.literal("disabled"),
      v.literal("draft"),
      v.literal("active"),
      v.literal("suspended")
    ),
    defaultSubdomain: v.optional(v.string()),
    activeDomainId: v.optional(v.id("websiteDomains")),
    templateId: v.string(),
    defaultLanguage: v.union(v.literal("en"), v.literal("ar")),
    supportedLanguages: v.array(v.union(v.literal("en"), v.literal("ar"))),
    primaryColor: v.optional(v.string()),
    secondaryColor: v.optional(v.string()),
    logoUrl: v.optional(v.string()),
    heroTitle: v.optional(v.string()),
    heroSubtitle: v.optional(v.string()),
    // Free-text badge shown as a small pill over the hero (e.g. Kinetic Sales'
    // hero). Replaces showing a raw "N+ cars available" count.
    heroBadgeText: v.optional(v.string()),
    slogan: v.optional(v.string()),
    // Which of the org's finance companies (see `financeCompanies`) the public
    // site's finance calculator uses for its rate/term. Unset falls back to a
    // generic illustrative rate.
    activeFinanceCompanyId: v.optional(v.id("financeCompanies")),
    themeConfig: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
    publishedAt: v.optional(v.number()),
    publishedSnapshotId: v.optional(v.id("websitePublishSnapshots")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"]),

  websiteDomains: defineTable({
    orgId: v.id("organizations"),
    websiteSettingsId: v.id("websiteSettings"),
    domain: v.string(),
    type: v.union(
      v.literal("platform_subdomain"),
      v.literal("purchased_custom_domain"),
      v.literal("external_custom_domain")
    ),
    status: v.union(
      v.literal("pending"),
      v.literal("active"),
      v.literal("failed"),
      v.literal("suspended")
    ),
    isPrimary: v.boolean(),
    registrarProvider: v.optional(v.string()),
    registrarDomainId: v.optional(v.string()),
    dnsStatus: v.union(v.literal("pending"), v.literal("configured"), v.literal("failed")),
    sslStatus: v.union(v.literal("pending"), v.literal("active"), v.literal("failed")),
    registrationExpiresAt: v.optional(v.number()),
    autoRenew: v.boolean(),
    publishedSnapshotId: v.optional(v.id("websitePublishSnapshots")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_domain", ["domain"])
    .index("by_org_primary", ["orgId", "isPrimary"]),

  websitePublishedSections: defineTable({
    orgId: v.id("organizations"),
    websiteSettingsId: v.id("websiteSettings"),
    sectionKey: v.string(),
    enabled: v.boolean(),
    configJson: v.optional(v.any()),
  })
    .index("by_org", ["orgId"])
    .index("by_settings", ["websiteSettingsId"])
    .index("by_org_settings_section", ["orgId", "websiteSettingsId", "sectionKey"]),

  websiteLeadRouting: defineTable({
    orgId: v.id("organizations"),
    websiteSettingsId: v.id("websiteSettings"),
    formType: v.string(),
    routeToUserId: v.optional(v.id("users")),
    routeToRole: v.optional(v.string()),
    routeToBranchId: v.optional(v.id("branches")),
    createTask: v.boolean(),
    notifyByEmail: v.boolean(),
    notifyByWhatsApp: v.boolean(),
    configJson: v.optional(v.any()),
  })
    .index("by_settings", ["websiteSettingsId"])
    .index("by_org_settings_form", ["orgId", "websiteSettingsId", "formType"]),

  websiteLeadAbuseEvents: defineTable({
    orgId: v.id("organizations"),
    host: v.string(),
    formType: v.string(),
    reason: v.union(
      v.literal("blocked"),
      v.literal("rate_limited"),
      v.literal("duplicate_suppressed"),
      v.literal("validation_failed")
    ),
    fingerprintHash: v.optional(v.string()),
    clientIpHash: v.optional(v.string()),
    contactKeyHash: v.optional(v.string()),
    detail: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_org_createdAt", ["orgId", "createdAt"])
    .index("by_host_createdAt", ["host", "createdAt"])
    .index("by_reason_createdAt", ["reason", "createdAt"]),

  // orgId is undefined for AutoFlow's own marketing/auth pages (landing, sign-in,
  // sign-up); it's set for dealer-site storefront traffic. Append-only event log,
  // no soft-delete triple (same convention as websiteLeadAbuseEvents above).
  siteVisitorEvents: defineTable({
    orgId: v.optional(v.id("organizations")),
    host: v.string(),
    visitorId: v.string(),
    sessionId: v.string(),
    type: v.union(v.literal("page_view"), v.literal("link_click")),
    path: v.string(),
    linkTarget: v.optional(v.string()),
    linkLabel: v.optional(v.string()),
    referrerHost: v.optional(v.string()),
    referrerUrl: v.optional(v.string()),
    utmSource: v.optional(v.string()),
    utmMedium: v.optional(v.string()),
    utmCampaign: v.optional(v.string()),
    utmTerm: v.optional(v.string()),
    utmContent: v.optional(v.string()),
    clickIdType: v.optional(v.string()),
    clickIdValue: v.optional(v.string()),
    trafficSource: v.string(),
    userAgent: v.optional(v.string()),
    language: v.optional(v.string()),
    timezone: v.optional(v.string()),
    screenWidth: v.optional(v.number()),
    screenHeight: v.optional(v.number()),
    viewportWidth: v.optional(v.number()),
    viewportHeight: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_org_createdAt", ["orgId", "createdAt"])
    .index("by_visitor_createdAt", ["visitorId", "createdAt"])
    .index("by_host_createdAt", ["host", "createdAt"])
    .index("by_createdAt", ["createdAt"]),

  // One upserted profile row per anonymous (orgId, visitorId) pair. orgId undefined
  // scopes to AutoFlow's own marketing/auth pages, same convention as above.
  siteVisitors: defineTable({
    orgId: v.optional(v.id("organizations")),
    host: v.string(),
    visitorId: v.string(),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    visitCount: v.number(),
    pageViewCount: v.number(),
    linkClickCount: v.number(),
    firstTrafficSource: v.string(),
    firstReferrerHost: v.optional(v.string()),
    firstUtmSource: v.optional(v.string()),
    firstUtmMedium: v.optional(v.string()),
    firstUtmCampaign: v.optional(v.string()),
    deviceType: v.string(),
    browserName: v.string(),
    osName: v.string(),
    country: v.optional(v.string()),
    region: v.optional(v.string()),
    city: v.optional(v.string()),
    geoLookupStatus: v.optional(
      v.union(v.literal("pending"), v.literal("done"), v.literal("failed"))
    ),
    // Used to detect a "new visit" (new browser session from a known visitor)
    // vs. another page_view/link_click within the same ongoing session.
    lastSessionId: v.optional(v.string()),
  })
    .index("by_org_visitor", ["orgId", "visitorId"])
    .index("by_org_firstSeenAt", ["orgId", "firstSeenAt"])
    .index("by_firstSeenAt", ["firstSeenAt"]),

  websiteLeadBlocklist: defineTable({
    orgId: v.id("organizations"),
    host: v.optional(v.string()),
    kind: v.union(
      v.literal("fingerprint"),
      v.literal("ipHash"),
      v.literal("email"),
      v.literal("emailDomain"),
      v.literal("phone")
    ),
    // The SHA-256 hex digest of the normalised value, never the value itself —
    // see `websiteLeadBlocklistValueHash` in convex/websites.ts, which is the
    // only thing allowed to produce this column so the read and write sides
    // cannot drift into comparing a raw value against a digest.
    valueHash: v.string(),
    reason: v.optional(v.string()),
    expiresAt: v.optional(v.number()),
    createdAt: v.number(),
    createdBy: v.optional(v.id("users")),
  })
    // orgId leads the key on purpose. The previous `["kind", "valueHash"]`
    // index was global, so the lookup had to over-read every org's rows for a
    // value and filter afterwards — with a bounded `.take()`, an org's own
    // block could be pushed out of the window by other orgs blocking the same
    // email and the submission would be allowed. Scoping the index to the org
    // makes the tenant boundary part of the read rather than a post-filter.
    .index("by_org_kind_valueHash", ["orgId", "kind", "valueHash"])
    .index("by_org", ["orgId"])
    .index("by_host", ["host"]),

  websitePublishSnapshots: defineTable({
    orgId: v.id("organizations"),
    websiteSettingsId: v.id("websiteSettings"),
    domain: v.optional(v.string()),
    version: v.optional(v.string()),
    snapshotJson: v.any(),
    createdAt: v.number(),
    publishedAt: v.optional(v.number()),
    publishedByUserId: v.id("users"),
  })
    .index("by_org", ["orgId"])
    .index("by_settings", ["websiteSettingsId"])
    .index("by_domain_version", ["domain", "version"]),

  domainSearchLogs: defineTable({
    orgId: v.id("organizations"),
    query: v.string(),
    available: v.boolean(),
    price: v.optional(v.number()),
    provider: v.string(),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_createdAt", ["orgId", "createdAt"]),

  oauthStates: defineTable({
    orgId: v.id("organizations"),
    state: v.string(),
    provider: v.union(v.literal("instagram"), v.literal("facebook")),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_state", ["state"])
    .index("by_org", ["orgId"]),

  instagramEvents: defineTable({
    orgId: v.id("organizations"),
    externalId: v.string(),
    kind: v.union(v.literal("comment"), v.literal("dm")),
    senderInstagramId: v.string(),
    senderUsername: v.optional(v.string()),
    customerId: v.optional(v.id("customers")),
    leadId: v.optional(v.id("leads")),
    vehicleId: v.optional(v.id("vehicles")),
    text: v.optional(v.string()),
    postId: v.optional(v.string()),
    vehicleMatchHintText: v.optional(v.string()),
    vehicleMatchHintSource: v.optional(v.union(v.literal("message"), v.literal("post"))),
    autoRepliedAt: v.optional(v.number()),
    autoReplyText: v.optional(v.string()),
    autoReplySource: v.optional(v.union(v.literal("smart"), v.literal("canned"))),
    pendingAutoReplyText: v.optional(v.string()),
    pendingAutoReplySource: v.optional(v.union(v.literal("smart"), v.literal("canned"))),
    pendingAutoReply: v.optional(v.boolean()),
    pendingAutoReplyChannel: v.optional(v.union(v.literal("comment"), v.literal("dm"))),
    autoReplyRetryCount: v.optional(v.number()),
    manualReplyText: v.optional(v.string()),
    manualRepliedAt: v.optional(v.number()),
    manualRepliedByUserId: v.optional(v.id("users")),
  })
    .index("by_org_external", ["orgId", "externalId"])
    .index("by_org_sender", ["orgId", "senderInstagramId"])
    .index("by_org", ["orgId"])
    .index("by_org_lead", ["orgId", "leadId"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_pending_reply", ["pendingAutoReply"]),

  facebookEvents: defineTable({
    orgId: v.id("organizations"),
    externalId: v.string(),
    kind: v.union(v.literal("comment"), v.literal("dm")),
    senderFacebookId: v.string(),
    senderName: v.optional(v.string()),
    customerId: v.optional(v.id("customers")),
    leadId: v.optional(v.id("leads")),
    vehicleId: v.optional(v.id("vehicles")),
    text: v.optional(v.string()),
    postId: v.optional(v.string()),
    sourceSurface: v.optional(v.union(v.literal("post"), v.literal("reel"), v.literal("story"), v.literal("ad"), v.literal("unknown"))),
    vehicleMatchHintText: v.optional(v.string()),
    vehicleMatchHintSource: v.optional(v.union(v.literal("message"), v.literal("post"))),
    autoRepliedAt: v.optional(v.number()),
    autoReplyText: v.optional(v.string()),
    autoReplySource: v.optional(v.union(v.literal("smart"), v.literal("canned"))),
    pendingAutoReplyText: v.optional(v.string()),
    pendingAutoReplySource: v.optional(v.union(v.literal("smart"), v.literal("canned"))),
    pendingAutoReply: v.optional(v.boolean()),
    pendingAutoReplyChannel: v.optional(v.union(v.literal("comment"), v.literal("dm"))),
    autoReplyRetryCount: v.optional(v.number()),
    manualReplyText: v.optional(v.string()),
    manualRepliedAt: v.optional(v.number()),
    manualRepliedByUserId: v.optional(v.id("users")),
  })
    .index("by_org_external", ["orgId", "externalId"])
    .index("by_org_sender", ["orgId", "senderFacebookId"])
    .index("by_org", ["orgId"])
    .index("by_org_lead", ["orgId", "leadId"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_pending_reply", ["pendingAutoReply"]),

  /**
   * One row per distinct social sender the org has ever heard from, per
   * platform. Exists solely so `socialInbox.platformStats` can report
   * "unique contacts" without reading every event row to build a Set.
   *
   * A distinct count is the one question a `TableAggregate` cannot answer: it
   * counts keys, not distinct values of a key. Materialising each distinct
   * sender as its own row turns that question back into a plain count, which
   * `socialContactsByOrg` then answers off the B-tree.
   *
   * Keyed on the raw platform id (`senderInstagramId` / `senderFacebookId`),
   * NOT on `customerId`. The two are 1:1 at ingest, but a customer merge
   * repoints several senders at one customer row — counting customers would
   * silently under-report exactly the orgs that have tidied their contacts,
   * and the Set this replaces counted senders.
   */
  socialContacts: defineTable({
    orgId: v.id("organizations"),
    platform: v.union(v.literal("instagram"), v.literal("facebook")),
    senderRawId: v.string(),
  })
    // Point lookup for the insert-if-absent path on every inbound event.
    .index("by_org_platform_sender", ["orgId", "platform", "senderRawId"])
    .index("by_org", ["orgId"]),

  /**
   * One row per Social Inbox conversation thread — the unit the inbox list
   * actually displays, materialised so it can be paginated.
   *
   * `socialInbox.listConversations` derived these by `.collect()`-ing every
   * Instagram and Facebook event the org had ever received and grouping them in
   * JavaScript: a live subscription over the tables ingestion writes to, so
   * every inbound message made it re-read the whole history. A conversation is
   * not a row, so there was nothing to paginate — the "cursor" was an offset
   * into an in-memory array and each page re-scanned everything.
   *
   * ## Grouping key
   *
   * `conversationKey` is the exact string the old grouping used, so the split
   * is unchanged: comments thread per (platform × customer × post), DMs per
   * (platform × customer). Stored rather than recomputed so the upsert is one
   * indexed point lookup.
   *
   * ⚠️ The key's inputs are MUTATED after insert — `socialInboxBackfill`
   * patches `postId`, and a customer merge repoints `customerId`. So the
   * maintenance path must handle RE-KEYING, not just insert and delete.
   *
   * ## Why the denormalised fields are here
   *
   * `lastEventAt` is the sort key — the list orders by most recent activity, so
   * it has to be indexed, not computed. The rest (`latestText`, the sender
   * fields, `eventCount`, `unansweredCount`, `vehicleIds`, `leadId`) are what a
   * row renders; keeping them here is what lets a page read 25 small rows
   * instead of every event in the org.
   *
   * `unansweredCount` is a count, not the `needsReply` boolean the UI wants,
   * because a boolean cannot be maintained: answering one event tells you
   * nothing about whether the others are still unanswered. `needsReply` is
   * `unansweredCount > 0`.
   *
   * `vehicleIds` is the distinct set in first-seen order, because the list
   * shows both a count of linked vehicles and a summary of the first one.
   */
  socialConversations: defineTable({
    orgId: v.id("organizations"),
    /**
     * The materialisation shape this row was written under.
     *
     * The readiness record is generation-scoped, but that only fences the
     * *claim*; without this field it could not fence the *data* the claim
     * authorises. `SOCIAL_CONVERSATION_GENERATION` must be bumped whenever
     * `conversationKey` changes meaning — and on that bump the old keys do not
     * collide with the new ones, so nothing overwrites them and no backfill
     * ever visits them again. They would simply sit in the table until the new
     * generation reached `completed` and then be served as real threads.
     *
     * Stamping the generation onto the row makes that impossible: the reader
     * selects one generation, and superseded rows become inert garbage that can
     * be swept whenever, by anything, with no correctness deadline.
     *
     * ⚠️ This fences generation-mismatched rows, NOT same-generation orphans.
     * A row whose thread still exists under the current scheme is only ever
     * corrected by a write to that thread, so a bulk writer that patches events
     * without collecting every thread it touched still leaves a stale row this
     * cannot see. That risk lived in the writer, and is now structural: the deferred
     * writer records every thread a write touches and `socialBulkMutation`
     * recomputes them automatically, so a bulk handler has no settlement step to
     * omit.
     */
    generation: v.number(),
    conversationKey: v.string(),
    platform: v.union(v.literal("instagram"), v.literal("facebook")),
    conversationKind: v.union(v.literal("comment"), v.literal("dm")),
    conversationPostId: v.optional(v.string()),
    customerId: v.id("customers"),
    lastEventAt: v.number(),
    eventCount: v.number(),
    unansweredCount: v.number(),
    vehicleIds: v.array(v.id("vehicles")),
    // `vehicleIds.length`, stored: Convex's filter expressions cannot measure an
    // array, and the "has a linked vehicle" filter has to run inside the
    // paginated read rather than after it.
    vehicleCount: v.number(),
    leadId: v.optional(v.id("leads")),
    latestText: v.optional(v.string()),
    latestSenderHandle: v.optional(v.string()),
    latestSenderRawId: v.string(),
  })
    // Upsert path: resolve a thread from an event in one lookup.
    .index("by_org_generation_key", ["orgId", "generation", "conversationKey"])
    // The list itself — descending gives most-recent-activity order directly.
    .index("by_org_generation_lastEventAt", ["orgId", "generation", "lastEventAt"])
    // The two filters the inbox offers as first-class controls; the rest
    // (hasVehicle, needsReply) are evaluated against the paginated stream,
    // which reads these small rows rather than the events behind them.
    .index("by_org_generation_platform_lastEventAt", [
      "orgId",
      "generation",
      "platform",
      "lastEventAt",
    ])
    .index("by_org_generation_kind_lastEventAt", [
      "orgId",
      "generation",
      "conversationKind",
      "lastEventAt",
    ])
    // Deliberately NOT generation-scoped, and the only index that must not be:
    // teardown has to reach every row an org owns, including rows left behind
    // by superseded generations. A purge that walked the current generation
    // alone would report a clean org while leaving its customer messages
    // behind — which is the failure this index exists to prevent, not an
    // optimisation.
    .index("by_org_lastEventAt", ["orgId", "lastEventAt"]),

  /**
   * Whether `socialConversations` may be trusted as the authoritative source
   * for one org and platform.
   *
   * This table exists because of a real production incident (SCRUM-20). The
   * materialised reader was deployed while the table behind it was still empty,
   * and the Social Inbox answered "no conversations" with total confidence for
   * an org holding a thousand events. Code and schema existing is not evidence
   * that the data behind them exists, so readiness has to be recorded durably
   * rather than inferred — and it cannot be inferred from row counts either,
   * because zero conversations is a legitimate completed result for a quiet org.
   *
   * One row per (org, generation, platform). Absence means NOT STARTED, which
   * is why the reader treats a missing row as "not ready" rather than as an
   * empty result: fail closed toward the slow-but-correct legacy path.
   *
   * `generation` is what stops an old completed backfill from vouching for a
   * newer materialisation shape. Bump `SOCIAL_CONVERSATION_GENERATION` whenever
   * the meaning of a `socialConversations` row changes, and every reader falls
   * back until the new generation is proven complete.
   */
  socialMaterializationState: defineTable({
    orgId: v.id("organizations"),
    platform: v.union(v.literal("instagram"), v.literal("facebook")),
    generation: v.number(),
    // No "notStarted": that is the absence of the row. No "interrupted"
    // either — an abandoned chain leaves `running` with a stale
    // `lastProgressAt`, and interruption is derived from that rather than
    // stored, because the process that would have written it is by definition
    // the one that died.
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
    // Fences concurrent chains: a scheduled continuation carries the runId it
    // was started under and aborts if the record has moved on to another.
    runId: v.string(),
    cursor: v.optional(v.string()),
    // Source rows read, and threads recomputed. Deliberately distinct: a batch
    // of 250 events belonging to 3 threads processes 250 and materialises 3,
    // and collapsing them would make "0 changed" indistinguishable from
    // "0 examined".
    processedCount: v.number(),
    materializedCount: v.number(),
    // The aggregate's event count at the last progress write. A progress
    // indicator only — never the completion criterion, which is pagination
    // exhaustion. Events arriving mid-run move this number.
    expectedCount: v.number(),
    startedAt: v.number(),
    lastProgressAt: v.number(),
    completedAt: v.optional(v.number()),
    failureMessage: v.optional(v.string()),
  })
    .index("by_org_generation_platform", ["orgId", "generation", "platform"])
    .index("by_org", ["orgId"]),

  // Full Messenger thread: one row per message (in or out), enabling complete
  // conversation history including messages sent before AutoFlow existed.
  facebookMessages: defineTable({
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    direction: v.union(v.literal("in"), v.literal("out")),
    text: v.optional(v.string()),
    timestamp: v.number(),
    fbMessageId: v.string(),
    fbConversationId: v.optional(v.string()),
    sentByUserId: v.optional(v.id("users")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_customer_ts", ["orgId", "customerId", "timestamp"])
    .index("by_org_fb_message", ["orgId", "fbMessageId"]),

  socialPosts: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    platform: v.union(v.literal("instagram"), v.literal("facebook")),
    status: v.union(v.literal("PENDING"), v.literal("PUBLISHED"), v.literal("FAILED")),
    caption: v.optional(v.string()),
    imageStorageIds: v.array(v.id("_storage")),
    externalPostId: v.optional(v.string()),
    externalPermalink: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    triggeredBy: v.union(v.literal("manual"), v.literal("auto")),
    requestedBy: v.id("users"),
    requestedAt: v.number(),
    publishedAt: v.optional(v.number()),
    likeCount: v.optional(v.number()),
    commentsCount: v.optional(v.number()),
    engagementSyncedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_vehicle", ["orgId", "vehicleId"])
    .index("by_external_post_id", ["externalPostId"]),

  orgCustomFields: defineTable({
    orgId: v.id("organizations"),
    entityType: v.union(v.literal("vehicle"), v.literal("customer"), v.literal("lead")),
    fieldName: v.string(),
    fieldKey: v.string(),
    fieldType: v.union(v.literal("text"), v.literal("number"), v.literal("select"), v.literal("date")),
    isRequired: v.boolean(),
    options: v.optional(v.array(v.string())),
    order: v.number(),
    isActive: v.boolean(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_entity", ["orgId", "entityType"]),

  orgCustomFieldValues: defineTable({
    orgId: v.id("organizations"),
    entityType: v.string(),
    entityId: v.string(),
    fieldId: v.id("orgCustomFields"),
    value: v.string(),
  })
    .index("by_org", ["orgId"])
    // The tenant-scoped lookup. `by_entity` below is NOT org-scoped, so reading
    // through it returns other dealerships' values for the same entity id —
    // always enter this table by org (see convex/orgCustomFields.ts).
    .index("by_org_entity", ["orgId", "entityType", "entityId"])
    .index("by_entity", ["entityType", "entityId"])
    .index("by_entity_field", ["entityId", "fieldId"]),

  orgLeadSources: defineTable({
    orgId: v.id("organizations"),
    label: v.string(),
    isActive: v.boolean(),
    order: v.number(),
  }).index("by_org", ["orgId"]),

  orgValuationCompanies: defineTable({
    orgId: v.id("organizations"),
    name: v.string(),
    isActive: v.boolean(),
    order: v.number(),
  }).index("by_org", ["orgId"]),

  orgPipelineStages: defineTable({
    orgId: v.id("organizations"),
    stageKey: v.string(), // "NEW" | "CONTACTED" | "INTERESTED" | "TEST_DRIVE" | "NEGOTIATION" | "RESERVED" | "WON" | "LOST"
    label: v.string(), // Custom display label, e.g. "طازج" instead of "New"
    color: v.optional(v.string()), // Hex color, e.g. "#3b82f6"
    order: v.number(),
    isActive: v.boolean(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_key", ["orgId", "stageKey"]),

  orgImportMappings: defineTable({
    orgId: v.id("organizations"),
    entityType: v.union(v.literal("vehicle"), v.literal("customer")),
    mapping: v.array(v.object({
      sourceHeader: v.string(), // normalized header text from the dealer's file
      targetField: v.string(), // schema field key, e.g. "make" / "vin"
    })),
    updatedAt: v.number(),
  }).index("by_org_entity", ["orgId", "entityType"]),

  orgCustomerStatuses: defineTable({
    orgId: v.id("organizations"),
    label: v.string(),
    isActive: v.boolean(),
    order: v.number(),
  }).index("by_org", ["orgId"]),

  profitApprovalRequests: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    requestedProfit: v.number(),
    minimumProfit: v.number(),
    salespersonId: v.id("users"),
    status: v.union(v.literal("PENDING"), v.literal("APPROVED"), v.literal("REJECTED")),
    approvedBy: v.optional(v.id("users")),
    notes: v.optional(v.string()),
    createdAt: v.number(),
    // Full wizard state snapshot so salesperson can resume after approval.
    // Must stay in step with `wizardSnapshotValidator` in convex/approvals.ts:
    // a field the args validator accepts but this object omits is an "extra
    // field" schema mismatch that throws inside the mutation and rolls the whole
    // request back. The same three execution-commission fields were already
    // missed once on `wizardDrafts.wizardData` above (fixed in c906211c).
    wizardSnapshot: v.optional(v.object({
      paymentType: v.string(),
      vehiclePrice: v.number(),
      desiredProfit: v.number(),
      downPayment: v.number(),
      termMonths: v.number(),
      selectedCompanyId: v.optional(v.string()),
      manualProfitRate: v.optional(v.number()),
      manualInsuranceRate: v.optional(v.number()),
      manualExecutionCommission: v.optional(v.number()),
      manualExecutionFees: v.optional(v.number()),
      manualIncludesCommissionInDebt: v.optional(v.boolean()),
    })),
  })
    .index("by_org", ["orgId"])
    .index("by_vehicle", ["vehicleId"])
    .index("by_salesperson", ["salespersonId"])
    .index("by_status", ["status"])
    // SCRUM-100. `by_org` + a post-read `.filter(status === "PENDING")` reads
    // every request the org ever created and discards most of them; these rows
    // are fat (`wizardSnapshot` carries the whole sale wizard). Bound in the
    // index instead.
    .index("by_org_status", ["orgId", "status"])
    // SCRUM-100. `orgId` FIRST is the tenant boundary, not an optimisation:
    // `by_salesperson` alone keys on a global user id, so a salesperson who
    // belongs to two dealerships read both. Putting orgId in the access path
    // means a later edit cannot drop the check by forgetting a filter.
    //
    // ⚠️ `status` deliberately absent. The predicate is `!== "REJECTED"` —
    // PENDING *or* APPROVED — because APPROVED rows are the resume-after-
    // approval flow. Pinning the range to PENDING would silently drop them,
    // and encoding the enum here breaks silently if a fourth status is added.
    .index("by_org_salesperson_createdAt", ["orgId", "salespersonId", "createdAt"])
    // `checkPendingApproval` asks "does this salesperson already have a request
    // for this car". It read `by_vehicle` — keyed on the GLOBAL vehicle id —
    // and narrowed by salesperson with a post-read filter, so nothing in the
    // read constrained the REQUEST's org. Verifying that the VEHICLE is in-org
    // proves nothing about a REQUEST that references it, which is the same
    // distinction that produced this ticket one function away.
    .index("by_org_vehicle_salesperson", ["orgId", "vehicleId", "salespersonId"]),

  feedback: defineTable({
    orgId: v.id("organizations"),
    userId: v.id("users"),
    type: v.union(v.literal("BUG"), v.literal("FEATURE")),
    title: v.string(),
    description: v.optional(v.string()),
    url: v.optional(v.string()),
    status: v.union(v.literal("OPEN"), v.literal("CLOSED")),
    createdAt: v.number(),
    adminReply: v.optional(v.string()),
    adminRepliedAt: v.optional(v.number()),
    resolvedAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_user", ["orgId", "userId"])
    .index("by_org_user_type", ["orgId", "userId", "type"])
    .index("by_org_user_status", ["orgId", "userId", "status"])
    .index("by_org_user_type_status", ["orgId", "userId", "type", "status"])
    .index("by_status", ["status"]),

  // ─── Subscription plans ────────────────────────────────────────────────────

  subscriptions: defineTable({
    orgId: v.id("organizations"),
    plan: v.union(
      v.literal("free"),
      v.literal("starter"),
      v.literal("professional"),
      v.literal("enterprise")
    ),
    status: v.union(
      v.literal("active"),     // on free plan or paying subscriber
      v.literal("past_due"),   // payment failed
      v.literal("cancelled"),  // cancelled; access until period end
      v.literal("expired"),    // paid plan lapsed, back to free
    ),
    billingInterval: v.optional(v.union(v.literal("monthly"), v.literal("annual"))),
    currentPeriodStart: v.optional(v.number()),
    currentPeriodEnd: v.optional(v.number()),
    renewalReminderSentAt: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_status_period_end", ["status", "currentPeriodEnd"])
    // `plan` sits BEFORE `currentPeriodEnd` so the expiry sweep can exclude free
    // rows through the index instead of `.filter()`. A filter still scans and
    // charges every discarded document, and a Convex transaction is capped at
    // 32,000 scanned documents — so enough free rows carrying a stale period end
    // would abort the query before `.take()` ever reached a lapsed paid row, and
    // abort it again on every subsequent run (SCRUM-145).
    .index("by_status_plan_period_end", ["status", "plan", "currentPeriodEnd"]),

  // ─── Super-admin dashboard (cross-tenant, /admin) ──────────────────────────

  adminAuditLog: defineTable({
    actorUserId: v.id("users"),
    actorEmail: v.string(),
    action: v.string(),
    targetTable: v.optional(v.string()),
    targetId: v.optional(v.string()),
    orgId: v.optional(v.id("organizations")),
    before: v.optional(v.any()),
    after: v.optional(v.any()),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_org", ["orgId"]),

  cronHeartbeats: defineTable({
    jobName: v.string(),
    ranAt: v.number(),
    success: v.boolean(),
    detail: v.optional(v.string()),
  })
    // ranAt is part of the key so "newest heartbeat for this job" is a single
    // indexed read rather than a scan-and-max over the whole table.
    .index("by_job_ranAt", ["jobName", "ranAt"])
    // Retention sweeps delete by age; without this they would scan the table
    // they exist to keep small.
    .index("by_ranAt", ["ranAt"]),

  webhookLogs: defineTable({
    source: v.union(
      v.literal("clerk"),
      v.literal("whatsapp"),
      v.literal("resend"),
      v.literal("instagram-oauth"),
      v.literal("instagram"),
      v.literal("facebook-oauth"),
      v.literal("facebook"),
      v.literal("notification-email"),
      v.literal("notification-whatsapp"),
      v.literal("notification-push"),
      v.literal("subscription-reminder"),
      v.literal("support-inbox-notification"),
      v.literal("upgrade-request"),
      v.literal("social-auto-reply-retry"),
      v.literal("fixed-asset-depreciation"),
      v.literal("fi-commission-recognition"),
      v.literal("prepaid-expense-amortization"),
      v.literal("marketplace-weekly-report"),
      v.literal("marketplace-whatsapp")
    ),
    status: v.union(v.literal("received"), v.literal("success"), v.literal("error"), v.literal("dead_letter")),
    summary: v.string(),
    eventId: v.optional(v.string()),
    payloadSha256: v.optional(v.string()),
    rawPayload: v.optional(v.string()),
    payloadPreview: v.optional(v.string()),
    payloadTruncated: v.optional(v.boolean()),
    receiveCount: v.optional(v.number()),
    lastReceivedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_source_and_eventId", ["source", "eventId"])
    .index("by_status_createdAt", ["status", "createdAt"]),

  // ─── Company-level support inboxes (support@ / info@ autoflowdealer.com) ───
  // Not org-scoped — this is the AutoFlow operator's own inbox for talking to
  // subscriber dealerships, separate entirely from any tenant's data.

  supportThreads: defineTable({
    participantEmail: v.string(),
    participantName: v.optional(v.string()),
    subject: v.string(),
    status: v.union(v.literal("OPEN"), v.literal("CLOSED")),
    // Which inbox this thread belongs to — support@ (help), info@ (sales/general),
    // subscriptions@ (billing/plan inquiries).
    inbox: v.union(v.literal("support"), v.literal("info"), v.literal("subscriptions")),
    lastMessageAt: v.number(),
    autoRepliedAt: v.optional(v.number()),
  })
    .index("by_participantEmail_and_inbox", ["participantEmail", "inbox"])
    .index("by_inbox_and_lastMessageAt", ["inbox", "lastMessageAt"])
    .index("by_inbox_and_status", ["inbox", "status"]),

  supportMessages: defineTable({
    threadId: v.id("supportThreads"),
    direction: v.union(v.literal("INBOUND"), v.literal("OUTBOUND")),
    fromEmail: v.string(),
    toEmail: v.string(),
    bodyText: v.optional(v.string()),
    bodyHtml: v.optional(v.string()),
    resendEmailId: v.optional(v.string()),
    sentByUserId: v.optional(v.id("users")),
    createdAt: v.number(),
  }).index("by_thread", ["threadId"]),

  // ─── Live chat support (in-app, real-time) ─────────────────────────────────
  // Separate from the email support inbox above. Dealers chat from inside the
  // dashboard; a small team of support agents (gated by requireSupportAgent,
  // narrower than requireSuperAdmin) claim threads from a queue and reply live.

  supportAgents: defineTable({
    userId: v.id("users"),
    email: v.string(),
    isActive: v.boolean(),
    isOnline: v.optional(v.boolean()),
    lastHeartbeatAt: v.optional(v.number()),
    lastOfferedAt: v.optional(v.number()), // round-robin fairness for chat routing
    // Richer presence than isOnline: ONLINE accepts new offers, BREAK and
    // OFFLINE don't (isOnline is kept in sync with status === "ONLINE" so
    // existing isOnline-based routing/eligibility checks stay correct).
    status: v.optional(v.union(v.literal("ONLINE"), v.literal("BREAK"), v.literal("OFFLINE"))),
    // Set when the agent asks to go on break/offline while still handling an
    // active chat — excluded from new offers immediately, but the status
    // change itself is deferred until their last active chat closes.
    pendingBreak: v.optional(v.boolean()),
  })
    .index("by_userId", ["userId"])
    .index("by_email", ["email"]),

  liveChatThreads: defineTable({
    // kind is omitted on every pre-existing row, which are all dealer chats —
    // undefined is treated as "DEALER" everywhere this is read.
    kind: v.optional(v.union(v.literal("DEALER"), v.literal("LEAD"))),
    orgId: v.optional(v.id("organizations")), // unset for anonymous LEAD threads
    dealerUserId: v.optional(v.id("users")), // unset for anonymous LEAD threads
    dealerName: v.optional(v.string()), // doubles as the lead's display name for LEAD threads
    // Capability token (random, client-generated, stored in the visitor's
    // localStorage) identifying an anonymous marketing-site lead — there's no
    // authenticated `users` row to key off for these. Only set for LEAD threads.
    leadId: v.optional(v.string()),
    leadEmail: v.optional(v.string()),
    status: v.union(v.literal("WAITING"), v.literal("OFFERED"), v.literal("ACTIVE"), v.literal("CLOSED")),
    // Offer/accept/reject routing — a thread is offered to one agent at a
    // time; rejecting or timing out re-offers to the next eligible agent.
    offeredToUserId: v.optional(v.id("users")),
    offeredAt: v.optional(v.number()),
    offerExpiresAt: v.optional(v.number()),
    rejectedByUserIds: v.optional(v.array(v.id("users"))),
    claimedByUserId: v.optional(v.id("users")),
    claimedAt: v.optional(v.number()),
    createdAt: v.number(),
    lastMessageAt: v.number(),
    closedAt: v.optional(v.number()),
    dealerLastReadAt: v.optional(v.number()),
    agentLastReadAt: v.optional(v.number()),
    // Typing indicators — last keystroke timestamp from each side; the
    // client treats this as "stopped typing" once it's a few seconds stale.
    dealerTypingAt: v.optional(v.number()),
    agentTypingAt: v.optional(v.number()),
    // Dealer presence within this thread's chat widget — self-reported by
    // the client (active = window open+focused, idle = open but unfocused)
    // and treated as "away" once dealerPresenceAt goes stale.
    dealerPresence: v.optional(v.union(v.literal("active"), v.literal("idle"))),
    dealerPresenceAt: v.optional(v.number()),
    dealerPresenceSince: v.optional(v.number()), // when dealerPresence last changed — drives the idle/away timer
    // Mirror of the above, but for the claiming agent's view of *this*
    // specific conversation (they may have several open elsewhere).
    agentPresence: v.optional(v.union(v.literal("active"), v.literal("idle"))),
    agentPresenceAt: v.optional(v.number()),
    agentPresenceSince: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_dealerUserId", ["dealerUserId"])
    .index("by_leadId", ["leadId"])
    .index("by_status", ["status", "createdAt"])
    .index("by_claimedByUserId", ["claimedByUserId"])
    .index("by_claimedByUserId_status", ["claimedByUserId", "status"]),

  // Typing/active-idle presence pings, split off liveChatThreads (one row per
  // thread+side) so a dealer's or agent's heartbeat never write-conflicts with
  // the other side, and so queries that don't display live presence (message
  // lists, thread lists) aren't invalidated by every ~10s heartbeat tick.
  // dealerLastReadAt/agentLastReadAt stay on liveChatThreads — they're low
  // frequency (only on actual reads, not heartbeats) and listMyActiveThreads
  // needs agentLastReadAt for its unread badges without an extra join.
  liveChatPresence: defineTable({
    threadId: v.id("liveChatThreads"),
    side: v.union(v.literal("DEALER"), v.literal("AGENT")),
    typingAt: v.optional(v.number()),
    presence: v.optional(v.union(v.literal("active"), v.literal("idle"))),
    presenceAt: v.optional(v.number()),
    presenceSince: v.optional(v.number()),
  }).index("by_thread_side", ["threadId", "side"]),

  liveChatMessages: defineTable({
    threadId: v.id("liveChatThreads"),
    senderType: v.union(v.literal("DEALER"), v.literal("AGENT")),
    senderUserId: v.optional(v.id("users")), // unset for messages sent by an anonymous LEAD-thread visitor
    senderName: v.optional(v.string()),
    bodyText: v.string(),
    createdAt: v.number(),
    // System notices (e.g. "agent ended the conversation") — rendered
    // centered/muted instead of as a chat bubble, but still an AGENT-typed
    // message so it flows through the existing unread/sound/notification path.
    isSystem: v.optional(v.boolean()),
  }).index("by_thread", ["threadId"]),

  // Temporary, audited "view/act as" access: while actively handling a
  // dealer's live chat, an agent can request a real (time-limited) OWNER-role
  // membership in that dealer's org to fix things directly. See
  // requestOrgAccess/revokeOrgAccess/expireOrgAccessGrant in convex/liveChat.ts.
  supportOrgAccessGrants: defineTable({
    agentUserId: v.id("users"),
    orgId: v.id("organizations"),
    threadId: v.id("liveChatThreads"),
    membershipId: v.id("memberships"),
    grantedAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_agentUserId_org", ["agentUserId", "orgId"])
    .index("by_orgId", ["orgId"])
    .index("by_threadId", ["threadId"]),

  // ─── Internal team messaging (DMs + group chats, org-scoped) ─────────────────

  dmConversations: defineTable({
    orgId: v.id("organizations"),
    type: v.union(v.literal("DM"), v.literal("GROUP")),
    name: v.optional(v.string()), // group display name
    memberIds: v.array(v.id("users")), // bounded — org team is small
    createdBy: v.id("users"),
    lastMessageAt: v.number(),
    lastMessageBody: v.optional(v.string()), // preview text
    lastMessageSenderId: v.optional(v.id("users")),
  })
    .index("by_org", ["orgId"])
    .index("by_org_lastMessageAt", ["orgId", "lastMessageAt"]),

  dmMessages: defineTable({
    conversationId: v.id("dmConversations"),
    senderId: v.id("users"),
    body: v.string(),
  }).index("by_conversation", ["conversationId"]),

  // Per-participant state: read receipts + typing + mute preference.
  // Kept separate from dmConversations to avoid write-contention on every
  // keystroke / read-receipt update invalidating the conversation list query.
  dmParticipantState: defineTable({
    conversationId: v.id("dmConversations"),
    userId: v.id("users"),
    lastDeliveredAt: v.optional(v.number()), // marks messages up to here as delivered to this user's active client
    lastReadAt: v.optional(v.number()), // marks messages up to here as "seen"
    typingAt: v.optional(v.number()),   // last keystroke timestamp
    isMuted: v.optional(v.boolean()),   // suppress sounds for this conversation
  })
    .index("by_conversation_user", ["conversationId", "userId"])
    .index("by_user", ["userId"]),

  // Temporary, audited "act as a specific real member" access for super
  // admins: same real-membership-grant pattern as supportOrgAccessGrants
  // above, but grants the target member's exact role rather than a fixed
  // OWNER role. See convex/adminImpersonation.ts.
  impersonationGrants: defineTable({
    actorUserId: v.id("users"), // the super admin
    targetUserId: v.id("users"), // the real member being impersonated
    orgId: v.id("organizations"),
    membershipId: v.id("memberships"), // the temp membership created for actorUserId
    reason: v.string(),
    grantedAt: v.number(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
  })
    .index("by_actorUserId", ["actorUserId"])
    .index("by_orgId", ["orgId"]),

  // ─── Global site configuration (super-admin controlled) ───────────────────
  // Key-value store for platform-level settings that apply across all orgs.
  // Examples: showPlanPricing (bool), supportNotifyEmails (string[]).
  siteConfig: defineTable({
    key: v.string(),
    value: v.any(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // Payment intents for payment-link / provider-initiated payments.
  // One intent per customer payment request. Fulfilled by provider webhook.
  paymentIntents: defineTable({
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    receivableId: v.optional(v.id("receivables")),
    receivableDocumentId: v.optional(v.id("receivableDocuments")),
    saleId: v.optional(v.id("sales")),
    amountMinor: v.number(),
    currency: v.string(),
    provider: v.string(),
    externalId: v.optional(v.string()),
    checkoutUrl: v.optional(v.string()),
    providerAccountId: v.optional(v.string()),
    collectionPaymentId: v.optional(v.id("collectionPayments")),
    canonicalPaymentId: v.optional(v.id("canonicalPayments")),
    paymentAllocationId: v.optional(v.id("paymentAllocations")),
    status: v.union(
      v.literal("PENDING"),
      v.literal("SETTLED"),
      v.literal("FAILED"),
      v.literal("EXPIRED"),
      v.literal("REFUNDED")
    ),
    idempotencyKey: v.string(),
    providerPayload: v.optional(v.any()),
    providerEventId: v.optional(v.string()),
    providerEventType: v.optional(v.string()),
    providerSignatureVerifiedAt: v.optional(v.number()),
    providerAmountMinor: v.optional(v.number()),
    providerCurrency: v.optional(v.string()),
    settledAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_external_id", ["provider", "externalId"])
    .index("by_org_idempotency", ["orgId", "idempotencyKey"])
    .index("by_org_customer", ["orgId", "customerId"])
    .index("by_receivable", ["receivableId"]),

  // ─── Dealer Network Marketplace (Phase 56+) ──────────────────────────────
  // Cross-org layer: a dealer's marketplace presence is an opt-in flag on top
  // of their existing dealer-site inventory (see docs/dealer_network_marketplace_master_plan.md
  // decision A2) — this table does not duplicate `vehicles` or `websiteSettings`.
  marketplaceDealerProfiles: defineTable({
    orgId: v.id("organizations"),
    isOptedIn: v.boolean(),
    areas: v.array(v.string()),
    brandsCarried: v.array(v.string()),
    whatsappNumber: v.optional(v.string()),
    badges: v.array(
      v.union(
        v.literal("VERIFIED_PHONE"),
        v.literal("VERIFIED_LOCATION"),
        v.literal("FAST_RESPONSE"),
        v.literal("FINANCE_AVAILABLE"),
        v.literal("FOUNDING_DEALER")
      )
    ),
    avgResponseMinutes: v.optional(v.number()),
    totalResponses: v.number(),
    totalAccepted: v.number(),
    // Phase 60: staff-confirmed WhatsApp reachability. There's no automated
    // OTP-over-WhatsApp send yet — same Business Verification blocker as the
    // rest of this epic's WhatsApp features (master plan A5b) — so this is
    // set manually by AutoFlow staff via the admin console after confirming
    // the number by phone/WhatsApp, mirroring the manual-first pattern
    // already used for dealer notifications (Phase 57) and proof reports
    // (Phase 58B).
    phoneVerifiedAt: v.optional(v.number()),
    phoneVerifiedBy: v.optional(v.id("users")),
    tier: v.union(
      v.literal("FREE_FOUNDING"),
      v.literal("LEAD_PACKAGE"),
      v.literal("FEATURED")
    ),
    leadQuota: v.optional(v.number()),
    leadsUsedThisPeriod: v.number(),
    // Phase 63: when the FREE_FOUNDING tier's free-leads window closes. Set at
    // profile creation; left undefined for rows created before Phase 63 —
    // `marketplaceDealers.ts`'s `effectiveFoundingWindowEndsAt` lazily derives
    // the same value from `createdAt` so no backfill migration is needed.
    foundingWindowEndsAt: v.optional(v.number()),
    // Phase 63: rolling-window start for `leadsUsedThisPeriod` (LEAD_PACKAGE
    // tier only) — reset lazily once a period elapses, same no-backfill
    // reasoning as `foundingWindowEndsAt`.
    leadPeriodStartedAt: v.optional(v.number()),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.id("users")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_opted_in", ["isOptedIn"]),

  // Buyer intent capture (Phase 57). Deliberately has no `orgId` — a request
  // isn't owned by any single tenant, it fans out to N matched dealers via
  // `marketplaceRequestMatches`. See master plan A1/A3.
  marketplaceRequests: defineTable({
    status: v.union(
      v.literal("OPEN"),
      v.literal("MATCHED"),
      // Legacy: any fulfilling dealer reply used to set this directly. New
      // rows use OFFERS_RECEIVED (dealer replied) → ACCEPTED/COMPLETED
      // (buyer action) instead; kept until prod rows are migrated.
      v.literal("FULFILLED"),
      v.literal("OFFERS_RECEIVED"),
      v.literal("ACCEPTED"),
      v.literal("COMPLETED"),
      v.literal("EXPIRED"),
      v.literal("SPAM")
    ),
    // Unguessable share token — the buyer's only key to their Request Room.
    // Optional because rows predating it exist in prod; backfilled by
    // migrateMarketplacePublicIds. Raw document ids stay accepted for the
    // legacy status lookup but must never gate buyer actions.
    publicId: v.optional(v.string()),
    buyerFirstName: v.string(),
    buyerPhone: v.string(),
    buyerWhatsApp: v.optional(v.string()),
    buyerCity: v.string(),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    yearMin: v.optional(v.number()),
    yearMax: v.optional(v.number()),
    priceMin: v.optional(v.number()),
    priceMax: v.optional(v.number()),
    paymentType: v.union(v.literal("CASH"), v.literal("FINANCE"), v.literal("EITHER")),
    monthlyBudget: v.optional(v.number()),
    // Buyer's own financing constraints — drives personalized installment
    // estimates and finance-aware matching, unlike the fixed 20%/60mo
    // illustrative defaults used when these are absent.
    financePreferences: v.optional(
      v.object({
        downPaymentAmount: v.optional(v.number()),
        preferredTermMonths: v.optional(v.number()),
        maximumMonthlyPayment: v.optional(v.number()),
        allowHigherDownPayment: v.optional(v.boolean()),
        maximumHigherDownPayment: v.optional(v.number()),
        allowLongerTerm: v.optional(v.boolean()),
        maximumTermMonths: v.optional(v.number()),
      })
    ),
    bodyType: v.optional(v.string()),
    // What the buyer allows dealers to flex on when proposing similar options.
    flexibility: v.optional(
      v.object({
        yearDelta: v.optional(v.number()),
        budgetDelta: v.optional(v.number()),
        allowSimilarModel: v.optional(v.boolean()),
        allowNearbyCity: v.optional(v.boolean()),
        allowDifferentColor: v.optional(v.boolean()),
      })
    ),
    buyerTimeframe: v.union(
      v.literal("ASAP"),
      v.literal("THIS_WEEK"),
      v.literal("THIS_MONTH"),
      v.literal("JUST_LOOKING")
    ),
    // Rule-based, computed at submission — see master plan Phase 57 A10/§4.
    buyerIntent: v.union(v.literal("COLD"), v.literal("WARM"), v.literal("HOT")),
    consentAcceptedAt: v.number(),
    clientFingerprint: v.string(),
    clientIpHash: v.optional(v.string()),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_city", ["buyerCity"])
    .index("by_publicId", ["publicId"]),

  // One row per matched dealer per request — not a flat array on
  // marketplaceRequests — so notify/respond timestamps are trackable per
  // dealer for Phase 60's response-time scoring. Capped at
  // MAX_MATCHED_DEALERS (5) per request per master plan A10.
  marketplaceRequestMatches: defineTable({
    requestId: v.id("marketplaceRequests"),
    orgId: v.id("organizations"),
    matchedAt: v.number(),
    notifiedAt: v.optional(v.number()),
    notifiedVia: v.optional(v.union(v.literal("WHATSAPP_MANUAL"), v.literal("WHATSAPP_AUTO"))),
    // INVENTORY = a concrete published vehicle scored against the request;
    // ELIGIBLE = city/brand backfill kept for sourcing capacity. Absent on
    // rows matched before finance-aware matching shipped.
    matchTier: v.optional(v.union(v.literal("INVENTORY"), v.literal("ELIGIBLE"))),
    matchedVehicleId: v.optional(v.id("vehicles")),
    estimatedMonthlyPayment: v.optional(v.number()),
    estimatedTotalContractValue: v.optional(v.number()),
    matchScore: v.optional(v.number()),
    matchReasons: v.optional(v.array(v.string())),
    financeCompanyId: v.optional(v.id("financeCompanies")),
    // Terms as of match time — finance-company rates drift, and the buyer
    // must keep seeing the numbers their estimate was actually built from.
    calculationSnapshot: v.optional(
      v.object({
        vehiclePrice: v.number(),
        downPayment: v.number(),
        termMonths: v.number(),
        annualProfitRate: v.number(),
        annualInsuranceRate: v.number(),
        commission: v.number(),
        processingFees: v.number(),
      })
    ),
    // Buyer consented to reveal their phone to this one dealer.
    contactUnlockedAt: v.optional(v.number()),
  })
    .index("by_request", ["requestId"])
    .index("by_org", ["orgId"]),

  // A matched dealer's reply to a buyer request (Phase 58). Reused across
  // both the dealer-facing inbox and the public buyer-status page.
  marketplaceResponses: defineTable({
    requestId: v.id("marketplaceRequests"),
    orgId: v.id("organizations"),
    respondingUserId: v.id("users"),
    kind: v.union(
      v.literal("HAVE_MATCH"),
      v.literal("HAVE_SIMILAR"),
      v.literal("CAN_SOURCE"),
      v.literal("NOT_AVAILABLE")
    ),
    vehicleId: v.optional(v.id("vehicles")),
    offerPriceJod: v.optional(v.number()),
    note: v.optional(v.string()),
    // Full computed offer, AutoFlow-calculated from the dealer's selected
    // finance company + down/term — the dealer never types the installment.
    // Snapshot semantics: what the buyer was quoted survives rate changes.
    financeOffer: v.optional(
      v.object({
        vehiclePrice: v.number(),
        downPayment: v.number(),
        termMonths: v.number(),
        monthlyInstallment: v.number(),
        totalContractValue: v.number(),
        totalProfit: v.number(),
        insuranceAmount: v.number(),
        commission: v.number(),
        processingFees: v.number(),
        financeCompanyId: v.optional(v.id("financeCompanies")),
        expiresAt: v.optional(v.number()),
      })
    ),
    // CAN_SOURCE replies carry an honest range + ETA instead of pretending a
    // concrete vehicle exists.
    sourcingRange: v.optional(
      v.object({
        minJod: v.number(),
        maxJod: v.number(),
        etaDays: v.number(),
      })
    ),
    buyerAction: v.optional(
      v.union(v.literal("SHORTLISTED"), v.literal("ACCEPTED"), v.literal("DECLINED"))
    ),
    buyerActionAt: v.optional(v.number()),
    // Buyer consented to reveal their phone to this response's dealer.
    contactUnlockedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_request", ["requestId"])
    .index("by_org", ["orgId"]),

  // Funnel telemetry (request submitted, offer sent/viewed/accepted, contact
  // unlocked, ...) — powers dealer response-SLA scoring and liquidity
  // metrics. Append-only; no PII beyond the ids.
  marketplaceEvents: defineTable({
    requestId: v.optional(v.id("marketplaceRequests")),
    orgId: v.optional(v.id("organizations")),
    event: v.string(),
    meta: v.optional(v.record(v.string(), v.union(v.string(), v.number(), v.boolean()))),
    createdAt: v.number(),
  })
    .index("by_request", ["requestId"])
    .index("by_org_event", ["orgId", "event"]),

  // Anonymous buyers have no Clerk account — push tokens key off the
  // request's publicId instead.
  marketplaceBuyerPushTokens: defineTable({
    publicId: v.string(),
    token: v.string(),
    platform: v.union(v.literal("IOS"), v.literal("ANDROID"), v.literal("WEB")),
    createdAt: v.number(),
  })
    .index("by_publicId", ["publicId"])
    .index("by_token", ["token"]),

  // Tracks manual WhatsApp sends of the weekly proof report (Phase 58B),
  // same wa.me deep-link pattern as marketplaceRequestMatches' notifiedAt —
  // one row per (orgId, weekStart) so the admin console can show "Sent" and
  // avoid staff double-sending. weekStart is the most recent Monday 00:00 UTC
  // at send time, not tied to the report's own trailing-7-day stat window.
  marketplaceWeeklyReportSends: defineTable({
    orgId: v.id("organizations"),
    weekStart: v.number(),
    sentAt: v.number(),
    sentBy: v.id("users"),
  }).index("by_org_week", ["orgId", "weekStart"]),

  // Phase 62 — buyer-submitted trade-in request, directed at a single dealer
  // (whichever listing the buyer was viewing), not fanned out like
  // marketplaceRequests. An accepted offer creates a lead in that dealer's
  // existing pipeline — Phase 34 (Purchase Orders) doesn't exist in this
  // codebase yet, so this deliberately does NOT create a purchase order;
  // see master plan Phase 62 notes for the reasoning.
  marketplaceTradeInRequests: defineTable({
    orgId: v.id("organizations"),
    buyerFirstName: v.string(),
    buyerPhone: v.string(),
    currentMake: v.string(),
    currentModel: v.string(),
    currentYear: v.number(),
    currentMileage: v.number(),
    condition: v.union(
      v.literal("EXCELLENT"),
      v.literal("GOOD"),
      v.literal("FAIR"),
      v.literal("POOR")
    ),
    notes: v.optional(v.string()),
    status: v.union(
      v.literal("PENDING"),
      v.literal("OFFERED"),
      v.literal("ACCEPTED"),
      v.literal("DECLINED")
    ),
    offerAmountJod: v.optional(v.number()),
    offeredAt: v.optional(v.number()),
    offeredBy: v.optional(v.id("users")),
    respondedAt: v.optional(v.number()),
    leadId: v.optional(v.id("leads")),
    consentAcceptedAt: v.number(),
    clientFingerprint: v.string(),
    clientIpHash: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"]),

  // Phase 64 — WhatsApp-native dealer intake (structured, no LLM, master
  // plan A8). One row per phone number's in-progress guided listing flow —
  // a dealer texts AutoFlow's platform WhatsApp number and answers one
  // sequential prompt per message (make/model/year/mileage/price/photos),
  // then confirms via a button reply. Confirming creates a PENDING
  // `vehicleEdits` CREATE request (see `marketplaceWhatsAppIntake.ts`) —
  // reuses the existing approval-workflow pattern rather than inserting a
  // vehicle directly, so nothing goes live from an inbound message without
  // a staff review step. Deliberately NOT keyed by orgId in the index below
  // (a phone number is resolved to an org via `marketplaceDealerProfiles`
  // at flow-start, then stamped) — the lookup path is always by phone.
  marketplaceWhatsAppFlows: defineTable({
    orgId: v.id("organizations"),
    phone: v.string(),
    step: v.union(
      v.literal("AWAITING_MAKE"),
      v.literal("AWAITING_MODEL"),
      v.literal("AWAITING_YEAR"),
      v.literal("AWAITING_MILEAGE"),
      v.literal("AWAITING_PRICE"),
      v.literal("AWAITING_PHOTOS"),
      v.literal("AWAITING_CONFIRM"),
      v.literal("COMPLETED"),
      v.literal("CANCELLED")
    ),
    make: v.optional(v.string()),
    model: v.optional(v.string()),
    year: v.optional(v.number()),
    mileage: v.optional(v.number()),
    sellingPrice: v.optional(v.number()),
    photoStorageIds: v.array(v.id("_storage")),
    vehicleEditId: v.optional(v.id("vehicleEdits")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_phone", ["phone"])
    .index("by_org", ["orgId"]),

  // Direct-listing marketplace (additive to the dealer-to-dealer reverse
  // marketplace above): lets an individual or a non-AutoFlow-subscriber
  // dealer list a car for sale directly. Deliberately has no `orgId` — the
  // seller is just a `users` row with zero `memberships` rows, same as any
  // orgless buyer/individual in this schema. Every listing starts
  // PENDING_VERIFICATION and only a super admin can move it to LIVE/REJECTED
  // (see marketplaceListings.ts's adminSetListingStatus — the admin queue
  // UI itself is a separate follow-up ticket).
  marketplaceListings: defineTable({
    sellerUserId: v.id("users"),
    sellerKind: v.union(v.literal("INDIVIDUAL"), v.literal("UNAFFILIATED_DEALER")),
    sellerDisplayName: v.string(),
    sellerPhone: v.string(),
    sellerWhatsapp: v.optional(v.string()),
    make: v.string(),
    model: v.string(),
    year: v.number(),
    mileage: v.number(),
    price: v.number(),
    currency: v.string(),
    transmission: v.string(),
    fuelType: v.string(),
    city: v.string(),
    description: v.string(),
    condition: v.union(
      v.literal("EXCELLENT"),
      v.literal("GOOD"),
      v.literal("FAIR"),
      v.literal("POOR")
    ),
    // Enforced non-empty in mutation code (createListing/updateListing) —
    // Convex validators can't express "min length 1" declaratively.
    imageIds: v.array(v.id("_storage")),
    status: v.union(
      v.literal("PENDING_VERIFICATION"),
      v.literal("LIVE"),
      v.literal("REJECTED"),
      v.literal("SOLD"),
      v.literal("REMOVED")
    ),
    verifiedBy: v.optional(v.id("users")),
    verifiedAt: v.optional(v.number()),
    rejectionReason: v.optional(v.string()),
    // Set only on an admin takedown of an already-LIVE listing (-> REMOVED).
    // Deliberately separate from verifiedBy/verifiedAt/rejectionReason so a
    // takedown doesn't overwrite the original approval's audit trail, and
    // separate from rejectionReason so intake rejection and post-live
    // removal aren't conflated into the same field.
    removedBy: v.optional(v.id("users")),
    removedAt: v.optional(v.number()),
    removalReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    isDeleted: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    deletedBy: v.optional(v.id("users")),
  })
    .index("by_sellerUserId", ["sellerUserId"])
    .index("by_sellerUserId_and_isDeleted", ["sellerUserId", "isDeleted"])
    .index("by_status", ["status"])
    .index("by_isDeleted_and_status", ["isDeleted", "status"]),

  // One row per orgless seller so repeat listings don't re-collect contact
  // info and a future admin queue can show "this seller was already
  // verified before" context. Minimal by design (see marketplaceListings
  // ticket) — just contact info + verification timestamp.
  marketplaceIndividualSellerProfiles: defineTable({
    sellerUserId: v.id("users"),
    sellerKind: v.union(v.literal("INDIVIDUAL"), v.literal("UNAFFILIATED_DEALER")),
    phone: v.string(),
    phoneVerifiedAt: v.optional(v.number()),
    city: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_sellerUserId", ["sellerUserId"]),

  // Ownership record for a storageId issued by
  // marketplaceListings.generateListingImageUploadUrl, written by
  // confirmListingImageUpload once the client's direct upload to that URL
  // succeeds. createListing/updateListing check this table (by storageId)
  // before accepting an id into imageIds, so an orgless caller can't claim or
  // reuse another user's already-uploaded storageId.
  marketplaceListingImageUploads: defineTable({
    storageId: v.id("_storage"),
    uploadedBy: v.id("users"),
    createdAt: v.number(),
  }).index("by_storageId", ["storageId"]),
});
