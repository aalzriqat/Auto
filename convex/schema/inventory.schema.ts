import { defineTable } from "convex/server";
import { v } from "convex/values";
import { acquisitionPaymentMethodValidator } from "../utils/paymentMethods";
import { trustPassportFieldValidators } from "../utils/vehicleStatusGuards";

export const inventoryTables = {
  vehicles: defineTable({
    orgId: v.id("organizations"),
    // Informational projection only. Immutable command and posted-journal proof
    // determine whether an opening vehicle is usable in financial operations.
    openingStockImportId: v.optional(v.string()),
    openingStockRowId: v.optional(v.number()),
    openingBalanceDraftId: v.optional(v.id("openingBalanceDrafts")),
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
    /** SCRUM-868 P1 (widen-only, unread): the consignment supplier's master row. Name above stays the snapshot. */
    sourcedSupplierId: v.optional(v.id("suppliers")),
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
    .index("by_org_sourceType_status_isDeleted", ["orgId", "sourceType", "status", "isDeleted"])
    .index("by_org_openingBalanceDraftId", ["orgId", "openingBalanceDraftId"])
    .index("by_org_vin", ["orgId", "vin"])
    // SCRUM-868 P1: a supplier's consignment cars. Unread until the identity slices land.
    .index("by_org_and_sourcedSupplierId", ["orgId", "sourcedSupplierId"])
    .searchIndex("search_make", { searchField: "make", filterFields: ["orgId", "isDeleted"] })
    .searchIndex("search_model", { searchField: "model", filterFields: ["orgId", "isDeleted"] })
    .searchIndex("search_vin", { searchField: "vin", filterFields: ["orgId", "isDeleted"] }),

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
    /** SCRUM-868 P1 (widen-only, unread): the supplier master row. `supplierName` stays the snapshot. */
    supplierId: v.optional(v.id("suppliers")),
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
      bankAccountId: v.optional(v.id("bankAccounts")),
      purchaseSupplierName: v.optional(v.string()),
      // SCRUM-868 P1 (widen-only, unread): master ids for the two names in this approval payload.
      purchaseSupplierId: v.optional(v.id("suppliers")),
      minimumProfit: v.optional(v.number()),
      sellingPrice: v.optional(v.number()),
      status: v.optional(v.string()),
      sourceType: v.optional(v.union(v.literal("STOCK"), v.literal("SOURCED"))),
      sourcedFromName: v.optional(v.string()),
      sourcedSupplierId: v.optional(v.id("suppliers")),
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
    .index("by_org_status", ["orgId", "status"])
    .index("by_org_vehicle", ["orgId", "vehicleId"]),

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
};
