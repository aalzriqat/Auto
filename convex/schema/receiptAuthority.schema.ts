import { defineTable } from "convex/server";
import { v } from "convex/values";

export const receiptAuthorityTables = {
  /* ─────────────────────────────────────────────────────────────────────────
   * SCRUM-218-C — the direct-collection receipt movement model.
   *
   * Three tables, one job each, deliberately domain-local rather than another
   * shared authority kernel (owner-proxy c17412 / c17653):
   *
   *   receiptMovements          what a receipt WAS, sealed once, never patched
   *   receiptRetainedPositions  what is still owed back, server-owned, contended
   *   receiptApplications       each later discharge, append-only
   *
   * The split exists because receipt disposition is an economic fact created by
   * a movement. Reconstructing it later from `payment.amountMinor − Σ ACTIVE
   * allocations` is what every earlier round was rejected for: a refund reverses
   * allocations, so refunded money reappears as "available", and a customer
   * DEPOSIT is also a settled payment with no allocation. "Unallocated" does not
   * identify "unapplied receipt".
   * ──────────────────────────────────────────────────────────────────────── */

  /**
   * One immutable row per direct-collection receipt occurrence.
   *
   * Every amount here is derived by the server inside the same transaction that
   * created the payment and its allocations, from rows it re-read itself. No
   * caller supplies `receivedMinor`, `initialAppliedMinor` or
   * `initialUnappliedMinor`, and no field is a residual over mutable tables.
   *
   * ⚠️ `customerId` IS PART OF WHAT IS SEALED. It records whose money this
   * receipt represents, so a customer merge does NOT repoint it —
   * `CUSTOMER_NON_REASSIGNABLE_TABLES` holds this table out of the generic
   * rewriting registry, and no merge loop can raw-reassign settled money to a
   * different customer.
   *
   * The rest of the lineage is NOT sealed: a merge DOES repoint
   * `canonicalPayments` (this row's own `canonicalPaymentId` target),
   * `journalLines` and `receivableDocuments`. After a merge the movement
   * therefore names the loser while its canonical payment names the survivor.
   *
   * Removing that write path is not by itself a fence. A merge still SUCCEEDS,
   * and because `applyRetainedCredit` requires
   * `receivable.customerId === movement.customerId` while a merge repoints
   * `receivables`, the merged-away customer's retained credit becomes
   * permanently UNAPPLIABLE. It fails closed — no money reaches the wrong party
   * and this liability stays on the books — but it is a freeze. Deciding what a
   * merge must do instead (refuse before writing, or perform a specified
   * authority transfer) is SCRUM-250, with its own evidence floor.
   */
  receiptMovements: defineTable({
    orgId: v.id("organizations"),
    collectionPaymentId: v.id("collectionPayments"),
    canonicalPaymentId: v.id("canonicalPayments"),
    customerId: v.id("customers"),
    currency: v.string(),
    receivedMinor: v.number(),
    initialAppliedMinor: v.number(),
    initialUnappliedMinor: v.number(),
    /**
     * The EXACT allocation rows this movement created — recorded from what
     * `allocatePaymentToReceivable` returned, not recovered by set-difference.
     * `_creationTime` cannot separate a movement's own writes from pre-existing
     * rows, because every write in one Convex transaction shares an instant.
     * An empty array is legitimate: it is the no-receivable receipt.
     */
    initialAllocationIds: v.array(v.id("paymentAllocations")),
    /**
     * The persisted SCRUM-237 occurrence snapshot. Stored as plain data with no
     * brand and no trust registry entry; `rehydrateReceiptOccurrence` is the
     * only door back to runtime authority. `orgId` is deliberately NOT inside
     * this object — the tenant comes from the authenticated context at
     * rehydration, so a snapshot copied between rows cannot carry a foreign
     * tenant in with it.
     */
    occurrence: v.object({
      eventType: v.string(),
      sourceType: v.string(),
      sourceId: v.string(),
      eventVersion: v.number(),
    }),
    /** `RECEIPT_PAYLOAD_VERSION` as of sealing. NOT the economic eventVersion. */
    receiptPayloadVersion: v.number(),
    /**
     * Which liability the residue belongs to, stated rather than inferred.
     * NONE when the receipt fully discharged a receivable; a reader must never
     * conclude "no allocation, therefore unapplied credit" — that is exactly the
     * inference that mistakes a customer deposit for a retained receipt.
     */
    liabilityTreatment: v.union(
      v.literal("NONE"),
      v.literal("UNAPPLIED_CUSTOMER_RECEIPTS")
    ),
    actorId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_payment", ["orgId", "collectionPaymentId"])
    // NO READER TODAY, and that is stated rather than left to be discovered.
    // `customerId` here is sealed provenance, not a pointer the merge rewrites,
    // so nothing resolves a movement this way yet. Declared for SCRUM-250's
    // "does this customer hold live receipt authority?" lookup, which needs it
    // under either of that ticket's shapes (refuse, or transfer).
    .index("by_org_customer", ["orgId", "customerId"]),

  /**
   * The authoritative remaining retained credit for one movement.
   *
   *   0 <= remainingUnappliedMinor <= initialUnappliedMinor
   *
   * Changes ONLY in the same transaction as a persisted application child. A
   * naked patch is forbidden. Concurrent consumers contend on this single row,
   * so Convex's OCC is what prevents two applications from overdrawing one
   * retained credit — the exclusivity is the row, not a lock we invented.
   */
  receiptRetainedPositions: defineTable({
    orgId: v.id("organizations"),
    receiptMovementId: v.id("receiptMovements"),
    customerId: v.id("customers"),
    currency: v.string(),
    initialUnappliedMinor: v.number(),
    remainingUnappliedMinor: v.number(),
    /** Legacy receiptApplications sequence counter; invoice claims use their own row id. */
    applicationCount: v.number(),
    /**
     * SCRUM-724 lineage, written ONCE at insert and never patched. Present only
     * on a position created by clearing a customer cheque that was registered
     * against a sale invoice. "Cancelled" is NOT stored: it is derived from the
     * sale's status at read time. Rows created before SCRUM-724 carry neither.
     */
    sourceChequeId: v.optional(v.id("postDatedCheques")),
    originatingSaleId: v.optional(v.id("sales")),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_movement", ["orgId", "receiptMovementId"])
    .index("by_org_customer", ["orgId", "customerId"]),

  /**
   * SCRUM-724: a request to pay retained 2110 customer credit back to the
   * customer. Keyed to the retained position / movement, NEVER to a receivable
   * (no receivable exists for credit left by a cancelled sale). One approved
   * request authorizes exactly one payout: `status` moves
   * PENDING -> APPROVED -> EXECUTED, and EXECUTED is terminal.
   */
  retainedCreditRefundRequests: defineTable({
    orgId: v.id("organizations"),
    receiptMovementId: v.id("receiptMovements"),
    positionId: v.id("receiptRetainedPositions"),
    customerId: v.id("customers"),
    currency: v.string(),
    amountMinor: v.number(),
    method: v.union(v.literal("BANK_TRANSFER"), v.literal("CASH")),
    reason: v.string(),
    status: v.union(
      v.literal("PENDING"),
      v.literal("APPROVED"),
      v.literal("REJECTED"),
      v.literal("EXECUTED"),
      // SCRUM-724 Sol 6 Q3: withdrawn (from PENDING) or cancelled (from
      // APPROVED) by a MANAGE_FINANCE user, or invalidated by a source-cheque
      // return. Terminal; never reached from EXECUTED.
      v.literal("CANCELLED")
    ),
    requestedBy: v.id("users"),
    decidedBy: v.optional(v.id("users")),
    decidedAt: v.optional(v.number()),
    decisionNotes: v.optional(v.string()),
    responseIdempotencyKey: v.optional(v.string()),
    cancelledBy: v.optional(v.id("users")),
    cancelledAt: v.optional(v.number()),
    cancelReason: v.optional(v.string()),
    cancelledFromStatus: v.optional(v.union(v.literal("PENDING"), v.literal("APPROVED"))),
    executedBy: v.optional(v.id("users")),
    executedAt: v.optional(v.number()),
    canonicalPaymentId: v.optional(v.id("canonicalPayments")),
    accountingEventId: v.optional(v.id("accountingEvents")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_movement", ["orgId", "receiptMovementId"])
    .index("by_org_movement_status", ["orgId", "receiptMovementId", "status"]),

  /**
   * SCRUM-722: a pending claim on retained 2110 credit for a completed sale's
   * canonical invoice. PENDING reserves money without calling it applied.
   * The receipt and invoice journals still have to be POSTED before a future
   * activation can create an allocation or move 2110 to AR.
   */
  invoiceReceiptApplications: defineTable({
    orgId: v.id("organizations"),
    receiptMovementId: v.id("receiptMovements"),
    saleId: v.id("sales"),
    receivableDocumentId: v.id("receivableDocuments"),
    customerId: v.id("customers"),
    currency: v.string(),
    amountMinor: v.number(),
    status: v.union(v.literal("PENDING"), v.literal("ACTIVE"), v.literal("REVERSED"), v.literal("CANCELLED")),
    allocationId: v.optional(v.id("paymentAllocations")),
    activationEventId: v.optional(v.id("accountingEvents")),
    activatedAt: v.optional(v.number()),
    splitFromApplicationId: v.optional(v.id("invoiceReceiptApplications")),
    splitRemainderId: v.optional(v.id("invoiceReceiptApplications")),
    createdBy: v.id("users"),
    createdAt: v.number(),
    cancelledAt: v.optional(v.number()),
  })
    .index("by_org", ["orgId"])
    .index("by_org_movement_status", ["orgId", "receiptMovementId", "status"])
    .index("by_org_sale_status", ["orgId", "saleId", "status"]),

  /**
   * One append-only row per later application of retained credit.
   *
   * `sequence` is part of the ACCOUNTING identity, not decoration: applications
   * #1 and #2 against one receipt are two legitimate economic occurrences, and a
   * dedup tuple that ignored the sequence would swallow the second one — the
   * subledger showing two discharges and the ledger one.
   */
  receiptApplications: defineTable({
    orgId: v.id("organizations"),
    receiptMovementId: v.id("receiptMovements"),
    sequence: v.number(),
    customerId: v.id("customers"),
    receivableId: v.id("receivables"),
    receivableDocumentId: v.id("receivableDocuments"),
    allocationId: v.id("paymentAllocations"),
    amountMinor: v.number(),
    currency: v.string(),
    /** The application event's own occurrence identity, exactly as posted. */
    occurrence: v.object({
      eventType: v.string(),
      sourceType: v.string(),
      sourceId: v.string(),
      eventVersion: v.number(),
    }),
    eventIdempotencyKey: v.string(),
    /**
     * `REVERSED` IS NOW WRITTEN — SCRUM-130 is the writer this member was
     * reserved for, and SCRUM-218-C predicted it by name.
     *
     * ⚠️ THE PREVIOUS TEXT HERE IS RETRACTED, NOT MERELY OUTGROWN. It said
     * "NOTHING WRITES `REVERSED` YET ... no production writer sets it and no
     * reader branches on it, so it cannot silently mean something." That was
     * true when 218-C shipped the shape and is FALSE now, and a comment
     * asserting inertness is exactly the kind a later change trusts without
     * re-reading the code.
     *
     * The writer is `retireReceiptRevocationState` in
     * `accounting/receiptMovement.ts`, reached only from `returnClearedCheque`:
     * a returned cleared cheque unwinds every live application of the retained
     * credit it created. The reader is `planReceiptRevocation`, which SKIPS an
     * already-REVERSED child so an exact replay of a return produces one effect
     * rather than a second reversal.
     *
     * `applicationCount` on the position is deliberately NOT wound back when a
     * child is reversed: it is the source of the next `sequence`, and a sequence
     * is part of an application's accounting identity.
     */
    status: v.union(v.literal("APPLIED"), v.literal("REVERSED")),
    actorId: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_org", ["orgId"])
    .index("by_org_movement", ["orgId", "receiptMovementId"])
    .index("by_org_movement_sequence", ["orgId", "receiptMovementId", "sequence"])
    .index("by_org_event_key", ["orgId", "eventIdempotencyKey"])
    // NO READER TODAY — same status as the `by_org_customer` on
    // `receiptMovements`, and for the same reason: a merge does not rewrite this
    // `customerId`, so nothing looks an application up by customer. Declared for
    // SCRUM-250, in the same spirit as the inert `REVERSED` above.
    .index("by_org_customer", ["orgId", "customerId"]),
};
