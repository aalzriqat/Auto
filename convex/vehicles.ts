import { isSystemAccountMapped } from "./chartOfAccounts";
import type { Id } from "./_generated/dataModel";
import { type MutationCtx, query } from "./_generated/server";
import { getOrgCurrency } from "./accounting/workflowHooks";
import { internalMutation, mutation } from "./functions";
import { listEligibleBanks } from "./utils/bankAccountGuards";
import { releaseReservationDepositHold } from "./utils/commitmentWriters";
import { depositMethodValidator } from "./utils/depositRecording";
import { AppErrorCode, throwAppError } from "./utils/errors";
import { runWithIdempotency } from "./utils/idempotency";
import { acquisitionPaymentMethodValidator, paymentMethodValidator } from "./utils/paymentMethods";
import { PERMISSIONS } from "./utils/permissions";
import { assertRt11DoorAllowed } from "./utils/rt11DoorContainment";
import { assertSupplierSettlementDoorAllowed } from "./utils/supplierSettlementContainment";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { validateInput } from "./utils/validation";
import { postOwnedVehicleAcquisition, recordVehicleCostCorrection } from "./utils/vehicleAcquisition";
import { readVehicleAgingBuckets } from "./utils/vehicleAgingRead";
import {
  inspectVehicleCostCorrection,
  loadOwnedLiveVehicle,
  prepareVehicleCostCorrection,
  readVehicleCostCorrectionContext,
  readVehiclePurchaseCostLock,
  validateVehicleCostCorrection,
} from "./utils/vehicleCostCorrection";
import { repairVehicleCostMirrors } from "./utils/vehicleCostMirror";
import { canReadVehicleCost } from "./utils/vehicleCostVisibility";
import {
  readVehicleByVin,
  readVehicleDetail,
  readVehicleExport,
  readVehicleLandedCosts,
} from "./utils/vehicleDetailsRead";
import {
  checkOpeningVehicleImport,
  prepareVehicleImport,
  readVehicleImportRequest,
  vehicleImportFields,
} from "./utils/vehicleImportPreflight";
import { checkPurchaseVehicleImport } from "./utils/vehicleImportPurchase";
import { importVehicleRows } from "./utils/vehicleImportWrite";
import {
  insertDirectVehicle,
  insertSourcedVehicle,
  vehicleCreateFields,
  vehicleCreateFingerprint,
  vehicleSourceType,
  vehicleSourcedCreateFields,
  vehicleStatus,
} from "./utils/vehicleIntake";
import {
  assertVehicleDeletionAllowed,
  createVehicleUploadUrl,
  notifyVehicleDeleted,
  prepareSourcedVehicleArrival,
  requireVehicleDeletionActor,
} from "./utils/vehicleInventoryMaintenance";
import {
  readVehicleInventoryList,
  readVehicleInventoryPage,
  readVehicleSelectorOptions,
} from "./utils/vehicleInventoryRead";
import {
  postVehicleLandedCosts,
  storeVehicleLandedCosts,
  vehicleLandedCostFields,
} from "./utils/vehicleLandedCostWrite";
import {
  readVehiclePricingHistory,
  readVehicleRelations,
  readVehicleReservationHistory,
} from "./utils/vehicleRelationsRead";
import {
  expireVehicleReservations,
  finishVehicleReservationRelease,
  insertVehicleReservation,
  vehicleReservationFingerprint,
} from "./utils/vehicleReservations";
import { throwVehicleSourceShape } from "./utils/vehicleSourceShape";
import { trustPassportFieldValidators } from "./utils/vehicleStatusGuards";
import {
  finishVehicleUpdate,
  planVehicleUpdate,
  recordVehicleUpdate,
  vehicleUpdateFields,
} from "./utils/vehicleUpdate";
import { UpdateVehicleSchema } from "./validations/vehicles";
import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";

export type VehicleSelectorOption = {
  _id: Id<"vehicles">;
  year: number;
  make: string;
  model: string;
  vin?: string;
  status: string;
};

/**
 * Bounded vehicle options for workflow selectors. Recent-vehicle window keeps
 * newly-added vehicles selectable immediately, while search indexes cover
 * arbitrary tenant inventories once a user types.
 */
export const selectorOptions = query({
  args: {
    orgId: v.id("organizations"),
    search: v.string(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    return readVehicleSelectorOptions(ctx, args.orgId, args.search);
  },
});

/**
 * Lists all vehicles for an organization.
 * Optionally filters by status.
 * This is paginated.
 */
export const list = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(vehicleStatus),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    return readVehicleInventoryPage(ctx, args, role);
  },
});

/**
 * Lists all vehicles for an organization without pagination (for dropdowns).
 * Optionally filters by status.
 */
export const listAll = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(vehicleStatus),
    /** When status is "AVAILABLE", also include RESERVED vehicles (soft-warning hold, not a hard block on deal-entry pickers). */
    includeReserved: v.optional(v.boolean()),
    /** Filter to a specific sourceType. Useful for the sourcing dashboard (SOURCED) or excluding sourced from owned-stock lists. */
    sourceType: vehicleSourceType,
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    return readVehicleInventoryList(ctx, args, role);
  },
});

/** Exports inventory and financing valuations, with role-based cost redaction. */
export const exportData = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    return readVehicleExport(ctx, args, role);
  },
});

/**
 * Gets a single vehicle by ID. Verifies it belongs to the caller's org.
 */
export const get = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    return readVehicleDetail(ctx, args, role);
  },
});

/**
 * Searches for a vehicle by VIN within the organization.
 */
export const getByVin = query({
  args: {
    orgId: v.id("organizations"),
    vin: v.string(),
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    return readVehicleByVin(ctx, args, role);
  },
});

export const getAgingBuckets = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    return readVehicleAgingBuckets(ctx, args);
  },
});

export const getLandedCosts = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    return readVehicleLandedCosts(ctx, args, role);
  },
});

export const getPricingHistory = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    return readVehiclePricingHistory(ctx, args);
  },
});

export const getReservationHistory = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    return readVehicleReservationHistory(ctx, args);
  },
});

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * Creates a new vehicle in the organization's inventory.
 */
export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    ...vehicleCreateFields,
    bankAccountId: v.optional(v.id("bankAccounts")),
    purchaseSupplierName: v.optional(v.string()),
    sourcedSupplierId: v.optional(v.id("suppliers")),
    purchaseSupplierId: v.optional(v.id("suppliers")),
    ...trustPassportFieldValidators,
    idempotencyKey: v.string(),
  },
  handler: async (ctx, submitted) => {
    const { user } = await requireTenantAuth(ctx, submitted.orgId, [PERMISSIONS.CREATE_VEHICLES]);
    return await runWithIdempotency(
      ctx,
      {
        orgId: submitted.orgId,
        operation: "vehicles.create",
        economic: true,
        idempotencyKey: submitted.idempotencyKey,
        actorId: user._id,
        // Identity of the physical car plus everything that decides the
        // acquisition economics. A same-key call differing in any of these is a
        // different intent and is refused, not deduped. The suppliers are keyed by
        // their master ids, never by typed text (SCRUM-868 N12): the text is not the
        // authority, so a retry after a rename must not look like a different intent.
        ...vehicleCreateFingerprint(submitted),
      },
      async () => {
        return insertDirectVehicle(ctx, submitted, user);
      }
    );
  },
});

export const backfillSourcedCostMirror = internalMutation({
  args: {
    numItems: v.optional(v.number()),
    cursor: v.optional(v.union(v.string(), v.null())),
  },
  returns: v.object({
    scanned: v.number(), updated: v.number(), skippedLocked: v.number(), skippedInvalid: v.number(),
    isDone: v.boolean(), continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    return repairVehicleCostMirrors(ctx, args);
  },
});

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    ...vehicleUpdateFields,
    bankAccountId: v.optional(v.id("bankAccounts")),
    purchaseSupplierName: v.optional(v.string()),
    sourcedSupplierId: v.optional(v.id("suppliers")),
    purchaseSupplierId: v.optional(v.id("suppliers")),
    ...trustPassportFieldValidators,
  },
  handler: async (ctx, args) => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    validateInput(UpdateVehicleSchema, args);

    const vehicle = await requireOwnedRow(ctx, args.orgId, "vehicles", args.vehicleId, "Vehicle not found in this organization.");
    if (vehicle.isDeleted) {
      throw new ConvexError("Vehicle not found in this organization.");
    }
    const plan = await planVehicleUpdate(ctx, args, vehicle, {
      role,
      user,
      assertOwnershipChangeAllowed: () => assertRt11DoorAllowed("VEHICLE_OWNERSHIP_CHANGE_PILOT_DISABLED"),
      authorizeBuyout: () => requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES, PERMISSIONS.MANAGE_FINANCE]),
    });
    const { patch } = plan;

    if (Object.keys(patch).length > 0) {
      await recordVehicleUpdate(ctx, args, vehicle, user._id, patch);
      await ctx.db.patch(args.vehicleId, patch);

      await finishVehicleUpdate(ctx, args, vehicle, user._id, plan);
    }
  },
});

export const upsertLandedCosts = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    ...vehicleLandedCostFields,
  },
  handler: async (ctx, args) => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);
    // SCRUM-886 (OWASP API3:2023): the landed-cost breakdown is cost by definition (`getLandedCosts`
    // returns null to a caller who cannot read cost, for every source type), so a caller who cannot
    // read it may not write it. Every later check compares the submitted items with the stored ones
    // (the paid-item door, the bank identity check), so their outcomes would confirm a guessed
    // amount. Refused before any read of the vehicle or the stored items, and by role alone, so the
    // answer carries no signal about the stored row. No exemption: every item carries an amount.
    if (!canReadVehicleCost(role)) {
      throwVehicleSourceShape("VEHICLE_COST_EDIT_NEEDS_COST_ACCESS");
    }

    const vehicle = await requireOwnedRow(ctx, args.orgId, "vehicles", args.vehicleId, "Vehicle not found in this organization.");
    if (vehicle.isDeleted) {
      throw new ConvexError("Vehicle not found in this organization.");
    }
    const plan = await storeVehicleLandedCosts(ctx, args, vehicle, user._id, () =>
      assertRt11DoorAllowed("PAID_LANDED_COST_CHANGE_PILOT_DISABLED"),
    );
    const { total, now } = plan;
    await ctx.db.patch(args.vehicleId, {
      landedCostTotal: total,
      updatedAt: now,
      updatedBy: user._id,
    });

    await postVehicleLandedCosts(ctx, args, vehicle, user._id, plan);
    return { total };
  },
});

// ─── Acquisition cost correction (SCRUM-650) ─────────────────────────────────
//
// Invariant: once a vehicle's acquisition has posted, its recorded cost
// (`vehicles.purchasePrice`), its Vehicle Inventory GL balance and the account
// the acquisition credited change only together, atomically, through ONE
// audited correction. The credited account is cash/bank, or AP-Suppliers
// together with its `vehicleSupplierPayables` row. The correction posts now; it
// is never queued.

/** Both permissions apply to reading or correcting a posted purchase cost. */
const COST_CORRECTION_PERMISSIONS = [PERMISSIONS.MANAGE_FINANCE, PERMISSIONS.VIEW_COST_PRICE];

export const listAcquisitionBankOptions = query({
  args: { orgId: v.id("organizations"), purpose: v.union(v.literal("CREATE"), v.literal("EDIT")) },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [args.purpose === "CREATE" ? PERMISSIONS.CREATE_VEHICLES : PERMISSIONS.EDIT_VEHICLES]);
    return await listEligibleBanks(ctx, args.orgId, await getOrgCurrency(ctx, args.orgId));
  },
});

export const listAcquisitionCorrectionBankOptions = query({
  args: { orgId: v.id("organizations"), vehicleId: v.id("vehicles") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, COST_CORRECTION_PERMISSIONS);
    await loadOwnedLiveVehicle(ctx, args.orgId, args.vehicleId);
    return await listEligibleBanks(ctx, args.orgId, await getOrgCurrency(ctx, args.orgId));
  },
});

/**
 * Corrects a vehicle's acquisition cost after VEHICLE_ACQUIRED has already
 * posted and purchasePrice/sourceCost is locked (see the lock in update()
 * above). Unlike a plain manual journal entry, this keeps the vehicle's own
 * cost record (which computeVehicleCapitalizedCost, commission, and both
 * profit reports read) in sync with the GL, and preserves the original value
 * in vehicleCostCorrections for audit history. Gated on MANAGE_FINANCE (not
 * EDIT_VEHICLES) since it's a financial correction, not an inventory edit.
 *
 * SCRUM-650: the allowed correction type depends on how the car was paid (the
 * matrix in `allowedAcquisitionCorrectionTypes`), an ON_ACCOUNT AP correction
 * rewrites the supplier payable in the same transaction, and the correction
 * must post NOW — a queued correction would leave the vehicle cost and the GL
 * disagreeing until a period opens, so it is refused instead.
 */
export const correctAcquisitionCost = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    newCost: v.number(),
    reason: v.string(),
    /** Drives the GL counter-account — see ruleVehicleAcquisitionCostCorrected. */
    correctionType: v.union(
      v.literal("PRIOR_PERIOD_RESTATEMENT"),
      v.literal("SUPPLIER_INVOICE_ERROR"),
      v.literal("CASH_REFUND"),
      v.literal("VENDOR_CREDIT"),
    ),
    /** Required when correctionType is CASH_REFUND — which cash/bank account actually moved. Ignored otherwise. */
    paymentMethod: v.optional(paymentMethodValidator),
    bankAccountId: v.optional(v.id("bankAccounts")),
  },
  handler: async (ctx, args) => {
    // Both: the correction rewrites a figure that VIEW_COST_PRICE exists to withhold, and the
    // dialog it serves shows that figure back. MANAGE_FINANCE alone (the default ACCOUNTANT
    // template) must not be a way around the cost-visibility gate.
    const { user } = await requireTenantAuth(ctx, args.orgId, COST_CORRECTION_PERMISSIONS);

    const reason = validateVehicleCostCorrection(args);

    const vehicle = await loadOwnedLiveVehicle(ctx, args.orgId, args.vehicleId);
    // loadOwnedLiveVehicle already proved this through requireOwnedRow; it is
    // restated inline so the static tenant-write guard can see the proof
    // before the patch below (scripts/tenantWriteGuard.ts reads the handler only).
    if (vehicle.orgId !== args.orgId) {
      throwAppError(AppErrorCode.VEHICLE_NOT_FOUND, "Vehicle not found in this organization.");
    }
    const evidence = await inspectVehicleCostCorrection(ctx, args, vehicle);
    const { rewritesPayable, newMinor, payableAdjustable } = evidence;
    if (rewritesPayable) {
      // SCRUM-869#c23881: rewriting a supplier obligation is a correction door the pilot refuses, before any write.
      assertSupplierSettlementDoorAllowed("SUPPLIER_PAYABLE_CORRECTION_PILOT_DISABLED");
      if (newMinor === 0) {
        throwAppError(
          AppErrorCode.COST_CORRECTION_INVALID_AMOUNT,
          "The new purchase cost must be a valid amount, zero or more."
        );
      }
      if (!payableAdjustable) {
        throwAppError(
          AppErrorCode.COST_CORRECTION_PAYABLE_NOT_ADJUSTABLE,
          "The supplier balance for this vehicle has been partly paid, disputed or settled, so the invoice can't be corrected automatically. Contact finance to record a supplier credit or adjustment."
        );
      }
    }
    const posting = await prepareVehicleCostCorrection(ctx, args, evidence, (key) =>
      isSystemAccountMapped(ctx, args.orgId, key),
    );
    const { now, payableToAdjust } = posting;

    await ctx.db.patch(args.vehicleId, {
      purchasePrice: args.newCost,
      updatedAt: now,
      updatedBy: user._id,
    });
    if (payableToAdjust) {
      await ctx.db.patch(payableToAdjust._id, { amountDue: args.newCost, updatedAt: now });
    }

    return recordVehicleCostCorrection(ctx, args, { vehicle, actorId: user._id, reason, evidence, posting });
  },
});

/**
 * Whether this vehicle's purchase price is locked (SCRUM-650). Uses the exact
 * semantics of the `vehicles.update` / `vehicleEdits.resolve` lock, so the edit
 * dialog can show the price read-only precisely when the backend would refuse a
 * change. Returns a boolean only, never the cost, so VIEW_VEHICLES is enough.
 */
export const getPurchaseCostLockState = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    return readVehiclePurchaseCostLock(ctx, args);
  },
});

/**
 * Read-only context for the "Correct purchase cost" dialog (SCRUM-650): whether
 * a correction is possible at all, how the car was paid, what its supplier
 * payable looks like, which correction types the matrix allows, and the last
 * few corrections. It cannot ask `isPostableNow` (that needs a MutationCtx), so
 * "the period is closed" is left to the mutation to refuse.
 */
export const getAcquisitionCostCorrectionContext = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, COST_CORRECTION_PERMISSIONS);
    return readVehicleCostCorrectionContext(ctx, args);
  },
});

export const createReservation = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    customerId: v.id("customers"),
    depositAmount: v.optional(v.number()),
    depositMethod: v.optional(depositMethodValidator),
    depositBankAccountId: v.optional(v.id("bankAccounts")),
    expiresAt: v.optional(v.number()),
    // Explicit lineage is required to join a deal that already holds the car.
    dealQuoteId: v.optional(v.id("quotes")),
    dealDepositId: v.optional(v.id("deposits")),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    // SCRUM-444 DA-01: a reservation that carries a deposit posts
    // DEPOSIT_RECEIVED (via recordHeldDeposit) exactly as `deposits.create`
    // does, so it needs the same authority — checked HERE, before any write,
    // rather than the old VIEW_SALES check buried mid-handler. A reservation
    // with no deposit moves no money and keeps the EDIT_VEHICLES bar.
    const hasDepositAtEntry = args.depositAmount !== undefined;
    const { user } = await requireTenantAuth(
      ctx,
      args.orgId,
      hasDepositAtEntry
        ? [PERMISSIONS.EDIT_VEHICLES, PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT]
        : [PERMISSIONS.EDIT_VEHICLES]
    );
    // SCRUM-444 F1: a deposit taken on a reservation that is linked to a quote
    // posts DEPOSIT_RECEIVED with no quote, so the quote's cap and its pending-
    // request guard cannot see it and the same customer could pay twice. The
    // quote's own deposit flow sees every receipt, so that is where it goes.
    // A reservation with no deposit, or a standalone one, is unchanged.
    // SCRUM-444 R-A: ANY deal lineage counts. `dealDepositId` joins the quote's
    // deal exactly as `dealQuoteId` does (through the deposit's root), and the
    // reservation's own deposit would carry no quote either way.
    if (hasDepositAtEntry && (args.dealQuoteId !== undefined || args.dealDepositId !== undefined)) {
      throw new ConvexError(
        "A deposit cannot be taken on a reservation that is linked to a quote or one of its deposits. Reserve without a deposit, then record the deposit (or ask a manager or accountant to) from the quote's deposit screen."
      );
    }
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "vehicles.createReservation",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        ...vehicleReservationFingerprint(ctx, args, user._id),
      },
      async () => {
        return insertVehicleReservation(ctx, args, user);
      }
    );
  },
});

/**
 * Records that a special-order car physically reached the dealership.
 *
 * Arrival is stored as its own timestamp rather than a status change because a
 * car can be arrived *and* still held: if a customer deposit promoted it to
 * RESERVED, `assertDirectVehicleStatusTransition` refuses to move it out of
 * RESERVED at all, so "it's here now" had nowhere to live for precisely the
 * cars in the special-order pipeline. An unheld car still on SOURCING is moved
 * to AVAILABLE at the same time, since that is what SOURCING→arrived means for
 * stock nobody has claimed.
 */
export const markSourcedVehicleArrived = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);
    const vehicle = await requireOwnedRow(ctx, args.orgId, "vehicles", args.vehicleId);

    const arrival = await prepareSourcedVehicleArrival(ctx, args, vehicle, user._id);
    if (!arrival) return args.vehicleId;
    const { now, current } = arrival;

    await ctx.db.patch(args.vehicleId, {
      arrivedAt: now,
      updatedAt: now,
      updatedBy: user._id,
      // A held car stays RESERVED — the deposit still owns it. Only unclaimed
      // stock moves onto the lot.
      ...(current.status === "SOURCING" ? { status: "AVAILABLE" as const } : {}),
    });

    return args.vehicleId;
  },
});

export const releaseReservation = mutation({
  args: {
    orgId: v.id("organizations"),
    reservationId: v.id("vehicleReservations"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    const reservation = await requireOwnedRow(ctx, args.orgId, "vehicleReservations", args.reservationId, "Reservation not found in this organization.");
    if (reservation.status !== "ACTIVE") {
      throw new ConvexError("Reservation is not active.");
    }

    const vehicle = await ctx.db.get(reservation.vehicleId);
    if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

    const now = Date.now();
    await releaseReservationDepositHold(ctx, {
      orgId: args.orgId,
      reservation,
      reason: "reservation released",
    });
    await ctx.db.patch(args.reservationId, {
      status: "RELEASED",
      releasedAt: now,
      releasedBy: user._id,
    });
    await finishVehicleReservationRelease(ctx, {
      orgId: args.orgId, vehicleId: reservation.vehicleId, actorId: user._id, now,
    });
  },
});

export const expireReservations = internalMutation({
  args: {
    limit: v.optional(v.number()),
    work: v.optional(v.union(
      v.object({ mode: v.literal("page"), cursor: v.string(), now: v.number() }),
      v.object({ mode: v.literal("row"), reservationId: v.id("vehicleReservations"), now: v.number() }),
    )),
  },
  handler: async (ctx, args): Promise<{ expired: number }> => {
    return expireVehicleReservations(ctx, args);
  },
});

/**
 * Lightweight mutation used by the Sales Wizard to create a sourced vehicle
 * inline without leaving the quote flow. Sets sourceType=SOURCED, status=SOURCING,
 * and auto-generates a VIN placeholder if none is provided.
 */
export const createSourced = mutation({
  args: {
    orgId: v.id("organizations"),
    ...vehicleSourcedCreateFields,
    // The optional validator preserves the API shape. Intake refuses a name without its supplier ID.
    sourcedSupplierId: v.optional(v.id("suppliers")),
    sourceCost: v.number(),
    sellingPrice: v.number(),
    vin: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, submitted) => {
    const authority = await requireTenantAuth(ctx, submitted.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    return insertSourcedVehicle(ctx, submitted, authority);
  },
});

/**
 * Soft deletes a vehicle unless it is sold, reserved, or has an open commitment.
 */
export const softDelete = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.DELETE_VEHICLES]);
    const actor = await requireVehicleDeletionActor(ctx, args.orgId);

    const vehicle = await requireOwnedRow(ctx, args.orgId, "vehicles", args.vehicleId, "Vehicle not found in this organization.");
    if (vehicle.isDeleted) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

    await assertVehicleDeletionAllowed(ctx, args, vehicle);

    // We no longer delete associated images, we just soft-delete the record
    await ctx.db.patch(args.vehicleId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: actor
    });

    await notifyVehicleDeleted(ctx, args.orgId, vehicle);
  },
});

/**
 * Generates an upload URL for uploading vehicle images.
 */
export const generateUploadUrl = mutation({
  args: {
    orgId: v.id("organizations"),
    mimeType: v.string(),
    sizeInBytes: v.number(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);
    return createVehicleUploadUrl(ctx, args);
  },
});

/**
 * Deletes an image from a vehicle and storage.
 */
export const deleteImage = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    const vehicle = await requireOwnedRow(ctx, args.orgId, "vehicles", args.vehicleId, "Vehicle not found in this organization.");
    if (vehicle.isDeleted) {
      throw new ConvexError("Vehicle not found in this organization.");
    }
    if (!(vehicle.imageIds ?? []).includes(args.storageId)) {
      throw new ConvexError("Image not found on this vehicle.");
    }

    // Delete from storage
    await ctx.storage.delete(args.storageId);

    // Remove from vehicle array
    const newImageIds = (vehicle.imageIds ?? []).filter((id) => id !== args.storageId);
    await ctx.db.patch(args.vehicleId, { imageIds: newImageIds });
  },
});

export const getRelations = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    return readVehicleRelations(ctx, args, role);
  },
});

export const importBulk = mutation({
  args: {
    orgId: v.id("organizations"),
    acquisitionPosting: v.union(v.literal("OPENING_STOCK"), v.literal("PURCHASE")),
    purchasePaymentMethod: v.optional(acquisitionPaymentMethodValidator),
    bankAccountId: v.optional(v.id("bankAccounts")),
    ...vehicleImportFields,
  },
  handler: async (ctx, submitted) => {
    const request = readVehicleImportRequest(submitted);
    const authority = await requireTenantAuth(ctx, submitted.orgId, [PERMISSIONS.CREATE_VEHICLES]);
    const batch = await prepareVehicleImport(ctx, submitted, request, authority);
    const provenOpeningRetries = await checkOpeningVehicleImport(ctx, batch);
    const provenRetries = await checkPurchaseVehicleImport(ctx, batch);
    return importVehicleRows(ctx, batch, provenOpeningRetries, provenRetries);
  },
});

export async function postVehicleAcquisitionIfOwned(
  ctx: MutationCtx,
  args: Parameters<typeof postOwnedVehicleAcquisition>[1],
) {
  return postOwnedVehicleAcquisition(ctx, args);
}

export {
  hasVehicleAcquisitionAccountingExposure,
  hasVehicleLandedCostAccountingExposure,
  throwVehicleCostPosted,
} from "./utils/vehicleAcquisition";

export { costCorrectionCounterKey } from "./utils/vehicleCostCorrection";

export {
  IMPORT_ACQUISITION_POSTING,
  IMPORT_BULK_MAX_POSTING_ROWS,
  IMPORT_BULK_MAX_ROWS,
  type ImportAcquisitionPosting,
} from "./utils/vehicleImportEvidence";
