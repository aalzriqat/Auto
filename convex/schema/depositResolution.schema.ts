import { defineTable } from "convex/server";
import { v } from "convex/values";

export const depositResolutionTables = {
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

  /**
   * SCRUM-712 — one row per deposit share a CANCELLED completed sale consumed.
   *
   * The share is the customer's money, still owed a decision (refund or
   * forfeit), and until that decision is recorded the car it was paid against
   * is not available to anybody. Written by the shared sale-teardown writer in
   * the cancellation transaction; the natural key is the application row, so a
   * retry or replay can never open a second claim.
   *
   * This is a DISPOSITION record, not a cash ledger: the money's own state stays
   * on `deposits` / `depositVehicleHolds`. QUARANTINED is for legacy rows whose
   * provenance cannot be proved; it blocks exactly like PENDING.
   */
  depositCancellationPendings: defineTable({
    orgId: v.id("organizations"),
    depositId: v.id("deposits"),
    vehicleId: v.id("vehicles"),
    saleId: v.id("sales"),
    /** Natural key: one share per application row. */
    applicationId: v.id("depositApplications"),
    /** Present for a shared (sliced) deposit; absent when the whole row is the share. */
    holdId: v.optional(v.id("depositVehicleHolds")),
    amountMinor: v.number(),
    currency: v.string(),
    status: v.union(
      v.literal("PENDING"),
      v.literal("RELEASED"),
      v.literal("FORFEITED"),
      v.literal("QUARANTINED")
    ),
    createdAt: v.number(),
    createdBy: v.id("users"),
    resolvedAt: v.optional(v.number()),
    resolvedBy: v.optional(v.id("users")),
    resolutionReference: v.optional(v.string()),
  })
    .index("by_org_vehicle_status", ["orgId", "vehicleId", "status"])
    // The org-level "is anything blocking at all" probe, read once per function.
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_application", ["orgId", "applicationId"])
    .index("by_deposit", ["depositId"])
    // Exact lookups for a deposit's undecided shares. `by_deposit` plus a take(N)
    // loses a pending row behind N already-decided ones (SCRUM-712 B1). `holdId` is
    // absent for a whole-row (direct) share and the index matches that as undefined.
    .index("by_deposit_status", ["depositId", "status"])
    .index("by_deposit_hold_status", ["depositId", "holdId", "status"])
    // Exact "any blocking share of a DIFFERENT sale on this car" — two statuses x
    // (saleId < s, saleId > s) existence ranges, no page that a sale's own shares
    // can fill (SCRUM-712 round 3).
    .index("by_org_vehicle_status_sale", ["orgId", "vehicleId", "status", "saleId"]),
};
