import { defineTable } from "convex/server";
import { v } from "convex/values";

export const depositCommitmentTables = {
  /**
   * SCRUM-444 — a salesperson's REQUEST that the dealership take a deposit.
   *
   * ⚠️ THIS ROW IS NOT MONEY. It has no deposit, transaction, payment, journal,
   * outbox event or vehicle commitment behind it, and nothing may read it as
   * "paid". Money reaches the ledger only when an actor holding
   * CONFIRM_FINANCE_DISBURSEMENT confirms receipt (`depositRequests.confirm`),
   * which writes the `deposits` row and flips this one to CONFIRMED in the same
   * transaction. A PENDING request does not hold the car either.
   */
  depositRequests: defineTable({
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
    customerId: v.id("customers"),
    vehicleId: v.id("vehicles"),
    /** Major units, in `currency`. Confirmation must equal this exactly. */
    amount: v.number(),
    amountMinor: v.number(),
    currency: v.string(),
    note: v.optional(v.string()),
    status: v.union(
      v.literal("PENDING"),
      v.literal("CONFIRMED"),
      v.literal("REJECTED"),
      v.literal("WITHDRAWN")
    ),
    requestedBy: v.id("users"),
    requestedAt: v.number(),
    idempotencyKey: v.string(),
    resolvedBy: v.optional(v.id("users")),
    resolvedAt: v.optional(v.number()),
    resolutionReason: v.optional(v.string()),
    confirmedDepositId: v.optional(v.id("deposits")),
  })
    .index("by_org_status", ["orgId", "status"])
    .index("by_quote_status", ["quoteId", "status"])
    .index("by_quote", ["quoteId"]),

  deposits: defineTable({
    orgId: v.id("organizations"),
    vehicleId: v.optional(v.id("vehicles")),
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

    /**
     * SCRUM-858 S1 (owner ruling c23884) — A DEPOSIT THAT WAS ALREADY HELD ON THE
     * OPENING DATE, named per customer.
     *
     * Absent on every ordinary deposit. When "OPENING" the row was created by the
     * approved opening-balance poster and by nothing else: the cash is already
     * inside the opening cash/bank lines, so this row has no quote, no payment,
     * no voucher and no receipt journal of its own. The liability is the opening
     * journal's credit to Customer Deposits.
     *
     * The row is consumed by the ordinary sale-application route and may NOT be
     * refunded, forfeited or voided while the pilot containment holds; see
     * convex/utils/openingDepositContainment.ts. `vehicleId` is absent for a
     * security deposit and for a reservation that names no VIN (customer credit
     * that can only be applied).
     */
    origin: v.optional(v.literal("OPENING")),
    openingBalanceDraftId: v.optional(v.id("openingBalanceDrafts")),
    openingRowKey: v.optional(v.string()),
    openingDepositKind: v.optional(v.union(v.literal("SECURITY"), v.literal("RESERVATION"))),
    openingRefundReservation: v.optional(v.object({
      key: v.string(),
      reservedBy: v.id("users"),
      reservedAt: v.number(),
      periodId: v.id("accountingPeriods"),
      method: v.union(v.literal("CASH"), v.literal("BANK_TRANSFER")),
      bankAccountId: v.optional(v.id("bankAccounts")),
    })),

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
    .index("by_org_vehicle_direct_hold", ["orgId", "vehicleId", "usesVehicleHoldRows", "holdActive"])
    .index("by_org_refund_reserved_at", ["orgId", "openingRefundReservation.reservedAt"])
    .index("by_org_refund_bank", ["orgId", "openingRefundReservation.bankAccountId"])
    .index("by_org_customer_opening_status", ["orgId", "customerId", "origin", "status", "isDeleted"])
    .index("by_org_customer_vehicle_origin_status", [
      "orgId", "customerId", "vehicleId", "origin", "status", "isDeleted", "usesVehicleHoldRows",
    ]),

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
};
