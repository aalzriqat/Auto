import { v, ConvexError } from "convex/values";
import { MutationCtx, QueryCtx, internalMutation, mutation, query } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { checkTenantWriteLimit } from "./rateLimit";
import { validateInput } from "./utils/validation";
import { CreateVehicleSchema, UpdateVehicleSchema } from "./validations/vehicles";
import { maybeAutoPostToInstagram, maybeAutoPostToFacebook } from "./utils/socialAutoPost";
import { internal } from "./_generated/api";
import { getOrgCurrency, hookVehicleAcquired, hookVehicleLandedCostCapitalized, hookVehicleAcquisitionCostCorrected } from "./accounting/workflowHooks";
import { toMinorUnits } from "./utils/money";
import { paymentMethodValidator, acquisitionPaymentMethodValidator, normalizePaymentMethod, type AcquisitionPaymentMethod, type PaymentMethod } from "./utils/paymentMethods";
import { syncVehicleHoldStatus, getDefaultReservationExpiry } from "./utils/depositHelpers";
import {
  amountToMinorOrThrow,
  depositMethodValidator,
  methodOrDefault,
  normalizeCurrency,
  recordHeldDeposit,
} from "./utils/depositRecording";
import {
  assertVehicleImagesAllowed,
  VEHICLE_IMAGE_CONTENT_TYPES,
} from "./utils/storageValidation";
import {
  assertDirectVehicleCreateStatus,
  assertDirectVehicleStatusTransition,
  normalizeVehicleStatus,
  trustPassportFieldValidators,
  type VehicleLifecycleStatus,
} from "./utils/vehicleStatusGuards";

// ─── Validators ──────────────────────────────────────────────────────────────

const vehicleStatus = v.union(
  v.literal("AVAILABLE"),
  v.literal("RESERVED"),
  v.literal("SOLD"),
  v.literal("IN_INSPECTION"),
  v.literal("IN_REPAIR"),
  v.literal("ARCHIVED"),
  v.literal("SOURCING")
);

const vehicleSourceType = v.optional(v.union(v.literal("STOCK"), v.literal("SOURCED")));

// ─── Queries ─────────────────────────────────────────────────────────────────

import { paginationOptsValidator } from "convex/server";

const DAY_MS = 24 * 60 * 60 * 1000;

function getAgeBucket(days: number): "0-30" | "31-60" | "61-90" | "90+" {
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

function randomHex(bytesLength: number): string {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function generateImportVinPlaceholder(): string {
  return `IMPORT-${Date.now()}-${randomHex(3)}`;
}

// Dealers routinely drop a filler string into the VIN column for stock that has
// no VIN yet — a run of x's, dashes or zeros, or "N/A". Those are NOT real
// identifiers, so treating them as such makes every such row after the first
// collide as a "duplicate VIN" and get silently skipped (this is why owned
// stock, which most often lacks a VIN, failed to import). Normalizing them to
// blank lets each row get its own generated placeholder instead of deduping.
function isPlaceholderVin(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  if (/^(.)\1+$/.test(trimmed)) return true; // xxxxxxxx, --------, 00000000, ...
  const lower = trimmed.toLowerCase();
  return lower === "n/a" || lower === "na" || lower === "tbd" || lower === "none" || lower === "-";
}

/**
 * Posts the VEHICLE_ACQUIRED GL entry (+ legacy VEHICLE_PURCHASE transaction
 * row) for owned stock with a purchase price — shared by the direct
 * vehicles.create mutation, vehicles.update (a SOURCED→STOCK flip or a price
 * set for the first time), and vehicleEdits.resolve's CREATE-approval branch,
 * so a vehicle acquired via any of those paths gets the exact same accounting
 * treatment. Sourced/drop-ship vehicles never sit in physical inventory, so
 * this is a no-op for those.
 *
 * ON_ACCOUNT means no cash moved: instead of the legacy cash-transaction row,
 * this creates a vehicleSupplierPayables row (no saleId — settled independently
 * of any future sale, via the same sourcingPayables.markPaid a sourced
 * vehicle's payable uses) and credits AP-Suppliers in the GL instead of a
 * cash/bank account.
 */
export async function postVehicleAcquisitionIfOwned(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    isSourced: boolean;
    purchasePrice: number | undefined;
    purchasePaymentMethod?: AcquisitionPaymentMethod;
    /** Required when purchasePaymentMethod is "ON_ACCOUNT" — who the payable is owed to. */
    supplierName?: string;
    vehicleLabel: string;
    vin: string;
    actorId: Id<"users">;
  }
): Promise<void> {
  if (args.isSourced || args.purchasePrice == null || args.purchasePrice <= 0) return;

  const isOnAccount = args.purchasePaymentMethod === "ON_ACCOUNT";
  if (isOnAccount && !args.supplierName?.trim()) {
    throw new ConvexError("A supplier name is required for a vehicle purchased on account.");
  }

  const now = Date.now();
  const currency = await getOrgCurrency(ctx, args.orgId);

  if (isOnAccount) {
    // No cash actually moved — the legacy transactions table only records
    // real cash movements (a SOURCED vehicle's supplier payable, which never
    // touches this table either, is the existing precedent).
    await hookVehicleAcquired(ctx, {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      costMinor: toMinorUnits(args.purchasePrice, currency),
      currency,
      paymentMethod: "ON_ACCOUNT",
      actorId: args.actorId,
      occurredAt: now,
    });
    await ctx.db.insert("vehicleSupplierPayables", {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      sourcedFromName: args.supplierName!.trim(),
      amountDue: args.purchasePrice,
      currency,
      status: "PENDING",
      createdBy: args.actorId,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }

  await ctx.db.insert("transactions", {
    orgId: args.orgId,
    type: "OUT",
    amount: args.purchasePrice,
    date: now,
    category: "VEHICLE_PURCHASE",
    description: `Purchase of vehicle ${args.vehicleLabel} (VIN: ${args.vin})`,
    vehicleId: args.vehicleId,
  });

  await hookVehicleAcquired(ctx, {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    costMinor: toMinorUnits(args.purchasePrice, currency),
    currency,
    // Excludes "ON_ACCOUNT" — handled in the early-return branch above.
    paymentMethod: normalizePaymentMethod(args.purchasePaymentMethod as Exclude<AcquisitionPaymentMethod, "ON_ACCOUNT"> | undefined),
    actorId: args.actorId,
    occurredAt: now,
  });
}

async function insertPriceHistory(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">,
  oldPrice: number,
  newPrice: number,
  changedBy: Id<"users">,
) {
  if (oldPrice === newPrice) return;
  await ctx.db.insert("vehiclePriceHistory", {
    orgId,
    vehicleId,
    oldPrice,
    newPrice,
    changedBy,
    changedAt: Date.now(),
  });
}

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
    const canViewCostPrice = role.permissions.includes(PERMISSIONS.VIEW_COST_PRICE);

    let q;

    if (args.status) {
      q = ctx.db.query("vehicles").withIndex("by_org_status", (q) =>
        q.eq("orgId", args.orgId).eq("status", args.status!)
      ).filter(q => q.neq(q.field("isDeleted"), true));
    } else {
      q = ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .filter(q => q.neq(q.field("isDeleted"), true));
    }

    const pageResult = await q.order("desc").paginate(args.paginationOpts);

    const pendingRequests = await ctx.db
      .query("vehicleStatusRequests")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING"))
      .collect();

    const pendingMap = new Map<string, string>();
    for (const req of pendingRequests) {
      pendingMap.set(req.vehicleId, req.requestedStatus);
    }

    const page = await Promise.all(
      pageResult.page.map(async (vehicle) => {
        const imageUrls = await Promise.all(
          (vehicle.imageIds ?? []).map((id) => ctx.storage.getUrl(id))
        );
        const addedByUser = vehicle.addedBy ? await ctx.db.get(vehicle.addedBy) : null;
        const { purchasePrice, ...rest } = vehicle;
        return {
          ...rest,
          ...(canViewCostPrice ? { purchasePrice } : {}),
          imageUrls,
          addedByName: addedByUser?.name ?? addedByUser?.email ?? null,
          pendingStatusRequest: pendingMap.get(vehicle._id) ?? null
        };
      })
    );

    return { ...pageResult, page };
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
    const canViewCostPrice = role.permissions.includes(PERMISSIONS.VIEW_COST_PRICE);

    let vehicles;

    if (args.status === "AVAILABLE" && args.includeReserved) {
      const [availableVehicles, reservedVehicles] = await Promise.all([
        ctx.db.query("vehicles").withIndex("by_org_status", (q) =>
          q.eq("orgId", args.orgId).eq("status", "AVAILABLE")
        ).filter(q => q.neq(q.field("isDeleted"), true)).order("desc").take(200),
        ctx.db.query("vehicles").withIndex("by_org_status", (q) =>
          q.eq("orgId", args.orgId).eq("status", "RESERVED")
        ).filter(q => q.neq(q.field("isDeleted"), true)).order("desc").take(200),
      ]);
      vehicles = [...availableVehicles, ...reservedVehicles];
    } else if (args.status) {
      vehicles = await ctx.db.query("vehicles").withIndex("by_org_status", (q) =>
        q.eq("orgId", args.orgId).eq("status", args.status!)
      ).filter(q => q.neq(q.field("isDeleted"), true)).order("desc").take(200);
    } else {
      vehicles = await ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", args.orgId))
        .filter(q => q.neq(q.field("isDeleted"), true)).order("desc").take(200);
    }

    const pendingRequests = await ctx.db
      .query("vehicleStatusRequests")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING"))
      .collect();

    const pendingMap = new Map<string, string>();
    for (const req of pendingRequests) {
      pendingMap.set(req.vehicleId, req.requestedStatus);
    }

    if (args.sourceType) {
      // Treat null/undefined sourceType as "STOCK" (all pre-existing vehicles
      // have no sourceType field; they are dealer-owned stock by definition).
      vehicles = vehicles.filter((v) => (v.sourceType ?? "STOCK") === args.sourceType);
    }

    return await Promise.all(
      vehicles.map(async (vehicle) => {
        const docUrls = await Promise.all(
          (vehicle.imageIds || []).map((id) => ctx.storage.getUrl(id))
        );

        let purchasePrice = vehicle.purchasePrice;
        let sourceCost = vehicle.sourceCost;
        if (!canViewCostPrice) {
          purchasePrice = undefined;
          sourceCost = undefined;
        }

        return {
          ...vehicle,
          purchasePrice,
          sourceCost,
          pendingStatusRequest: pendingMap.get(vehicle._id) || null,
          imageUrls: docUrls,
        };
      })
    );
  },
});

/**
 * Returns every non-deleted vehicle in the org together with its per-company
 * financing valuations, shaped for the "Export all vehicles" button. The client
 * writes these into the dealership's canonical import template so the file can
 * be re-imported into the same — or a brand-new — dealer account with no manual
 * column remapping. Cost is stripped for roles that can't see dealer cost.
 *
 * This deliberately collects the whole inventory (export is a rare, explicit
 * action); it stays well within Convex read limits for realistic dealership
 * inventory sizes.
 */
export const exportData = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    const canViewCostPrice = role.permissions.includes(PERMISSIONS.VIEW_COST_PRICE);

    const vehicles = await ctx.db
      .query("vehicles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .collect();

    const companies = await ctx.db
      .query("financeCompanies")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const companyNameById = new Map(companies.map((c) => [c._id, c.name]));

    const valuations = await ctx.db
      .query("vehicleValuations")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const valuationsByVehicle = new Map<string, Array<{ companyName: string; amount: number }>>();
    const valuationCompanyNames = new Set<string>();
    for (const valuation of valuations) {
      const companyName = companyNameById.get(valuation.companyId);
      if (!companyName) continue; // company deleted out from under the valuation
      valuationCompanyNames.add(companyName);
      const list = valuationsByVehicle.get(valuation.vehicleId) ?? [];
      list.push({ companyName, amount: valuation.valuationAmount });
      valuationsByVehicle.set(valuation.vehicleId, list);
    }

    return {
      vehicles: vehicles.map((vehicle) => {
        const sourceType = (vehicle.sourceType ?? "STOCK") as "STOCK" | "SOURCED";
        // "Cost" carries purchasePrice for stock and sourceCost for sourced.
        const cost = canViewCostPrice ? vehicle.purchasePrice ?? vehicle.sourceCost ?? null : null;
        return {
          make: vehicle.make,
          model: vehicle.model,
          year: vehicle.year,
          vin: vehicle.vin ?? "",
          color: vehicle.color ?? "",
          mileage: vehicle.mileage ?? null,
          cost,
          sellingPrice: vehicle.sellingPrice,
          sourceType,
          sourcedFrom: vehicle.sourcedFromName ?? "",
          valuations: valuationsByVehicle.get(vehicle._id) ?? [],
        };
      }),
      valuationCompanyNames: Array.from(valuationCompanyNames),
    };
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
    const canViewCostPrice = role.permissions.includes(PERMISSIONS.VIEW_COST_PRICE);

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

    const imageUrls = await Promise.all(
      (vehicle.imageIds ?? []).map((id) => ctx.storage.getUrl(id))
    );
    const addedByUser = vehicle.addedBy ? await ctx.db.get(vehicle.addedBy) : null;
    const pendingRequest = await ctx.db
      .query("vehicleStatusRequests")
      .withIndex("by_vehicle", (q) => q.eq("vehicleId", args.vehicleId))
      .filter((q) => q.eq(q.field("status"), "PENDING"))
      .first();

    const { purchasePrice, ...rest } = vehicle;
    return {
      ...rest,
      ...(canViewCostPrice ? { purchasePrice } : {}),
      imageUrls,
      addedByName: addedByUser?.name ?? addedByUser?.email ?? null,
      pendingStatusRequest: pendingRequest?.requestedStatus ?? null,
    };
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
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    return await ctx.db
      .query("vehicles")
      .withIndex("by_org_vin", (q) =>
        q.eq("orgId", args.orgId).eq("vin", args.vin.trim().toUpperCase())
      )
      .unique();
  },
});

export const getAgingBuckets = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    const buckets: Record<"0-30" | "31-60" | "61-90" | "90+", { count: number; totalDays: number }> = {
      "0-30": { count: 0, totalDays: 0 },
      "31-60": { count: 0, totalDays: 0 },
      "61-90": { count: 0, totalDays: 0 },
      "90+": { count: 0, totalDays: 0 },
    };

    const now = Date.now();
    const vehicles = ctx.db
      .query("vehicles")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "AVAILABLE"));

    for await (const vehicle of vehicles) {
      if (vehicle.isDeleted) continue;
      const ageDays = Math.max(0, Math.floor((now - (vehicle.createdAt ?? vehicle._creationTime)) / DAY_MS));
      const bucket = getAgeBucket(ageDays);
      buckets[bucket].count += 1;
      buckets[bucket].totalDays += ageDays;
    }

    return (["0-30", "31-60", "61-90", "90+"] as const).map((bucket) => ({
      bucket,
      count: buckets[bucket].count,
      avgDays: buckets[bucket].count > 0 ? Math.round(buckets[bucket].totalDays / buckets[bucket].count) : 0,
    }));
  },
});

export const getLandedCosts = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

    return await ctx.db
      .query("vehicleLandedCosts")
      .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
      .unique();
  },
});

export const getPricingHistory = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

    return await ctx.db
      .query("vehiclePriceHistory")
      .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
      .order("desc")
      .take(100);
  },
});

export const getReservationHistory = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

    const reservations = await ctx.db
      .query("vehicleReservations")
      .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
      .order("desc")
      .take(100);

    return await Promise.all(
      reservations.map(async (reservation) => {
        const customer = await ctx.db.get(reservation.customerId);
        const reservedBy = await ctx.db.get(reservation.reservedBy);
        const releasedBy = reservation.releasedBy ? await ctx.db.get(reservation.releasedBy) : null;
        return {
          ...reservation,
          customerName: customer ? `${customer.firstName} ${customer.lastName}` : null,
          reservedByName: reservedBy?.name ?? reservedBy?.email ?? null,
          releasedByName: releasedBy?.name ?? releasedBy?.email ?? null,
        };
      })
    );
  },
});

// ─── Mutations ───────────────────────────────────────────────────────────────

/**
 * Creates a new vehicle in the organization's inventory.
 */
export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    vin: v.optional(v.string()),
    make: v.string(),
    model: v.string(),
    year: v.number(),
    trim: v.optional(v.string()),
    mileage: v.number(),
    color: v.string(),
    fuelType: v.string(),
    transmission: v.string(),
    purchasePrice: v.optional(v.number()),
    minimumProfit: v.optional(v.number()),
    sellingPrice: v.number(),
    status: v.optional(vehicleStatus),
    sourceType: vehicleSourceType,
    sourcedFromName: v.optional(v.string()),
    sourceCost: v.optional(v.number()),
    notes: v.optional(v.string()),
    imageIds: v.optional(v.array(v.id("_storage"))),
    /** How the dealer paid for the vehicle — drives the GL credit side (Cash/Bank/Cheque/Card/AP-Suppliers for ON_ACCOUNT). Ignored for SOURCED vehicles, which never capitalize into inventory. */
    purchasePaymentMethod: v.optional(acquisitionPaymentMethodValidator),
    ...trustPassportFieldValidators,
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_VEHICLES]);

    const vehicleGate = await ctx.runQuery(internal.subscriptions.canAddVehicle, { orgId: args.orgId });
    if (!vehicleGate.allowed) {
      throw new ConvexError(
        `You've reached the ${vehicleGate.limit}-vehicle limit on your current plan. Upgrade to add more vehicles.`
      );
    }

    const statusLimit = await checkTenantWriteLimit(ctx, "create", args.orgId);
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    validateInput(CreateVehicleSchema, args);
    assertDirectVehicleCreateStatus(args.status);
    await assertVehicleImagesAllowed(ctx, args.imageIds);

    const isSourced = args.sourceType === "SOURCED";

    // Sourced vehicles must identify the supplier and cost so that downstream
    // GL posting (AP-Suppliers credit) and supplier payable creation work correctly.
    if (isSourced) {
      if (!args.sourcedFromName?.trim()) {
        throw new ConvexError("Sourced vehicles require a supplier dealer name (sourcedFromName).");
      }
      if (args.sourceCost === undefined || args.sourceCost === null) {
        throw new ConvexError("Sourced vehicles require a supplier cost (sourceCost).");
      }
    }

    // A purchase price with no declared payment method would silently post as
    // CASH (normalizePaymentMethod's default) even when the dealer actually
    // paid by bank transfer, cheque, or card — require an explicit choice.
    if (!isSourced && args.purchasePrice != null && args.purchasePrice > 0 && !args.purchasePaymentMethod) {
      throw new ConvexError("Payment method is required when a purchase price is entered.");
    }
    // Reuses sourcedFromName as the generic "who is this owed to" field —
    // same requirement SOURCED vehicles already have for the same reason
    // (downstream AP-Suppliers/supplier-payable creation needs a name).
    if (!isSourced && args.purchasePaymentMethod === "ON_ACCOUNT" && !args.sourcedFromName?.trim()) {
      throw new ConvexError("A supplier name (sourcedFromName) is required for a vehicle purchased on account.");
    }

    // VIN is optional for sourced vehicles (car doesn't exist yet); generate a
    // stable placeholder so schema uniqueness stays valid. Users update it when
    // the car physically arrives.
    const rawVin = args.vin?.trim().toUpperCase() || (isSourced ? `SOURCING-${Date.now()}` : "");
    if (!rawVin) {
      throw new ConvexError("VIN is required for non-sourced vehicles.");
    }
    const normalizedVin = rawVin;

    // Check for duplicate VIN within the org (auto-placeholders are unique by timestamp)
    const existing = await ctx.db
      .query("vehicles")
      .withIndex("by_org_vin", (q) =>
        q.eq("orgId", args.orgId).eq("vin", normalizedVin)
      )
      .unique();

    if (existing) {
      throw new ConvexError(`A vehicle with VIN "${normalizedVin}" already exists.`);
    }

    // For sourced vehicles, purchasePrice mirrors sourceCost so all downstream
    // grossProfit / commission / report logic stays correct without changes.
    const effectivePurchasePrice = isSourced
      ? (args.sourceCost ?? args.purchasePrice)
      : args.purchasePrice;

    const id = await ctx.db.insert("vehicles", {
      orgId: args.orgId,
      vin: normalizedVin,
      make: args.make.trim(),
      model: args.model.trim(),
      year: args.year,
      trim: args.trim?.trim(),
      mileage: args.mileage,
      color: args.color.trim(),
      fuelType: args.fuelType,
      transmission: args.transmission,
      purchasePrice: effectivePurchasePrice,
      minimumProfit: args.minimumProfit,
      sellingPrice: args.sellingPrice,
      status: args.status ?? (isSourced ? "SOURCING" : "AVAILABLE"),
      sourceType: args.sourceType,
      sourcedFromName: isSourced ? args.sourcedFromName : undefined,
      sourceCost: isSourced ? args.sourceCost : undefined,
      notes: args.notes,
      imageIds: args.imageIds,
      inspectionStatus: args.inspectionStatus,
      accidentDisclosed: args.accidentDisclosed,
      ownerCount: args.ownerCount,
      dealerGuarantee: args.dealerGuarantee,
      createdAt: Date.now(),
      addedBy: user._id,
      updatedBy: user._id,
      updatedAt: Date.now(),
    });

    await postVehicleAcquisitionIfOwned(ctx, {
      orgId: args.orgId,
      vehicleId: id,
      isSourced,
      purchasePrice: effectivePurchasePrice,
      purchasePaymentMethod: args.purchasePaymentMethod,
      supplierName: args.sourcedFromName,
      vehicleLabel: `${args.year} ${args.make.trim()} ${args.model.trim()}`,
      vin: normalizedVin,
      actorId: user._id,
    });

    const { orgId: _, ...payloadArgs } = args;
    await ctx.db.insert("vehicleEdits", {
      orgId: args.orgId,
      requestedBy: user._id,
      type: "CREATE",
      payload: payloadArgs,
      status: "APPROVED",
      resolvedBy: user._id,
      resolvedAt: Date.now(),
      createdAt: Date.now(),
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "vehicle.created",
      { actorName, vehicleLabel: `${args.year} ${args.make.trim()} ${args.model.trim()}` },
      { link: `/${args.orgId}/vehicles?highlightId=${id}` }
    );

    return id;
  },
});

/**
 * True once this vehicle's acquisition cost has been capitalized into Vehicle
 * Inventory (posted or still sitting in the pending-post outbox) — mirrors
 * expenses.ts's hasExpenseAccountingExposure. Once true, purchasePrice/
 * sourceCost are locked: correcting a mis-entered cost after the GL already
 * captured it needs a deliberate adjustment, not a silent field edit that
 * would leave the journal permanently out of sync with the vehicle record.
 */
async function hasPostedVehicleAcquisition(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  const postedEvent = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", orgId).eq("sourceType", "vehicles").eq("sourceId", vehicleId.toString())
    )
    .filter((q) => q.eq(q.field("eventType"), "VEHICLE_ACQUIRED"))
    .first();
  return postedEvent !== null;
}

/**
 * True once a vehicle's acquisition is either posted to the GL or durably
 * queued in the accounting outbox — reused by the legacy transaction
 * migration tool (accountingMigration.ts) so it can recognize a
 * VEHICLE_PURCHASE transaction row as already accounted for via its
 * companion VEHICLE_ACQUIRED event (sourced from "vehicles", not
 * "transactions") instead of posting a second, duplicate event.
 */
export async function hasVehicleAcquisitionAccountingExposure(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  if (await hasPostedVehicleAcquisition(ctx, orgId, vehicleId)) return true;

  const pendingPost = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", `vehicle_acquired_${vehicleId}`))
    .first();
  return pendingPost !== null;
}

/**
 * Updates an existing vehicle's details.
 */
export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
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
    minimumProfit: v.optional(v.number()),
    sellingPrice: v.optional(v.number()),
    status: v.optional(vehicleStatus),
    sourceType: vehicleSourceType,
    sourcedFromName: v.optional(v.string()),
    sourceCost: v.optional(v.number()),
    notes: v.optional(v.string()),
    imageIds: v.optional(v.array(v.id("_storage"))),
    /** How the dealer paid — required if this update capitalizes an acquisition that hasn't posted yet (e.g. a SOURCED→STOCK flip, or a purchase price set for the first time). Ignored otherwise. */
    purchasePaymentMethod: v.optional(acquisitionPaymentMethodValidator),
    ...trustPassportFieldValidators,
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    const statusLimit = await checkTenantWriteLimit(ctx, "standardApi", args.orgId);
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    validateInput(UpdateVehicleSchema, args);

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }
    assertDirectVehicleStatusTransition(vehicle.status, args.status);
    await assertVehicleImagesAllowed(ctx, args.imageIds);

    // When switching to or retaining SOURCED, mirror the create-time invariant:
    // sourcedFromName and sourceCost are both required.
    const effectiveSourceType = args.sourceType ?? vehicle.sourceType;
    if (effectiveSourceType === "SOURCED") {
      const effectiveName = args.sourcedFromName ?? vehicle.sourcedFromName;
      const effectiveCost = args.sourceCost ?? vehicle.sourceCost;
      if (!effectiveName?.trim()) {
        throw new ConvexError("Sourced vehicles require a supplier dealer name (sourcedFromName).");
      }
      if (effectiveCost === undefined || effectiveCost === null) {
        throw new ConvexError("Sourced vehicles require a supplier cost (sourceCost).");
      }
    }

    // If VIN is being changed, check for duplicates
    if (args.vin) {
      const normalizedVin = args.vin.trim().toUpperCase();
      if (normalizedVin !== vehicle.vin) {
        const existing = await ctx.db
          .query("vehicles")
          .withIndex("by_org_vin", (q) =>
            q.eq("orgId", args.orgId).eq("vin", normalizedVin)
          )
          .unique();

        if (existing) {
          throw new ConvexError(`A vehicle with VIN "${normalizedVin}" already exists.`);
        }
      }
    }

    // purchasePaymentMethod is a transient input for the acquisition posting
    // below, not a persisted vehicle field — exclude it from the patch.
    const { orgId: _, vehicleId: __, purchasePaymentMethod: ___, ...updates } = args;
    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        const newValue = key === "vin" ? (value as string).trim().toUpperCase()
          : key === "make" || key === "model" || key === "color"
            ? (value as string).trim()
            : value;

        if (key === "imageIds") {
          const oldImages = JSON.stringify(vehicle.imageIds || []);
          const newImages = JSON.stringify(newValue || []);
          if (oldImages !== newImages) patch[key] = newValue;
        } else {
          const oldValue = vehicle[key as keyof typeof vehicle];
          const normNew = newValue === "" ? undefined : newValue;
          const normOld = oldValue === "" ? undefined : oldValue;
          if (normNew !== normOld) {
            patch[key] = newValue;
          }
        }
      }
    }

    // A SOURCED vehicle flipping to owned stock (or a STOCK vehicle whose
    // purchase price is set for the first time here) needs the exact same
    // capitalization create() does for a directly-created owned vehicle —
    // otherwise a later sale relieves Vehicle Inventory for a cost that was
    // never debited into it. Computed once up front since both this guard
    // and the edit-lock guard below need to know whether it's already posted.
    const mayAffectAcquisition =
      "purchasePrice" in patch || "sourceCost" in patch ||
      ("sourceType" in patch && patch.sourceType !== "SOURCED");
    const acquisitionAlreadyExposed = mayAffectAcquisition
      ? await hasVehicleAcquisitionAccountingExposure(ctx, args.orgId, args.vehicleId)
      : false;

    if (("purchasePrice" in patch || "sourceCost" in patch) && acquisitionAlreadyExposed) {
      throw new ConvexError(
        "This vehicle's acquisition cost has already been posted to accounting. Use a correction journal entry instead of editing purchasePrice/sourceCost directly."
      );
    }

    const acquisitionSourceType = (patch.sourceType as "STOCK" | "SOURCED" | undefined) ?? vehicle.sourceType;
    const acquisitionPurchasePrice: number | undefined =
      "purchasePrice" in patch ? (patch.purchasePrice as number) : vehicle.purchasePrice;
    const needsAcquisitionPosting =
      mayAffectAcquisition &&
      acquisitionSourceType !== "SOURCED" &&
      acquisitionPurchasePrice != null && acquisitionPurchasePrice > 0 &&
      !acquisitionAlreadyExposed;
    if (needsAcquisitionPosting && !args.purchasePaymentMethod) {
      throw new ConvexError("Payment method is required to post this vehicle's acquisition cost to accounting.");
    }
    if (needsAcquisitionPosting && args.purchasePaymentMethod === "ON_ACCOUNT" && !(args.sourcedFromName ?? vehicle.sourcedFromName)?.trim()) {
      throw new ConvexError("A supplier name (sourcedFromName) is required for a vehicle purchased on account.");
    }

    if (Object.keys(patch).length > 0) {
      if (typeof patch.sellingPrice === "number") {
        await insertPriceHistory(ctx, args.orgId, args.vehicleId, vehicle.sellingPrice, patch.sellingPrice, user._id);
      }

      await ctx.db.insert("vehicleEdits", {
        orgId: args.orgId,
        vehicleId: args.vehicleId,
        requestedBy: user._id,
        type: "UPDATE",
        payload: patch,
        status: "APPROVED",
        resolvedBy: user._id,
        resolvedAt: Date.now(),
        createdAt: Date.now(),
      });

      patch.updatedBy = user._id;
      patch.updatedAt = Date.now();
      await ctx.db.patch(args.vehicleId, patch);

      if (needsAcquisitionPosting) {
        await postVehicleAcquisitionIfOwned(ctx, {
          orgId: args.orgId,
          vehicleId: args.vehicleId,
          isSourced: false,
          purchasePrice: acquisitionPurchasePrice,
          purchasePaymentMethod: args.purchasePaymentMethod,
          supplierName: args.sourcedFromName ?? vehicle.sourcedFromName,
          vehicleLabel: `${(patch.year as number | undefined) ?? vehicle.year} ${(patch.make as string | undefined) ?? vehicle.make} ${(patch.model as string | undefined) ?? vehicle.model}`,
          vin: ((patch.vin as string | undefined) ?? vehicle.vin) || "",
          actorId: user._id,
        });
      }

      const actorName = await getActorName(ctx);
      await notifyManagers(
        ctx,
        args.orgId,
        "vehicle.updated",
        { actorName, vehicleLabel: `${vehicle.year} ${vehicle.make} ${vehicle.model}` },
        { link: `/${args.orgId}/vehicles?highlightId=${args.vehicleId}` }
      );

      if (patch.status === "AVAILABLE" && vehicle.status !== "AVAILABLE") {
        const updatedVehicle = { ...vehicle, ...patch } as typeof vehicle;
        await maybeAutoPostToInstagram(ctx, {
          orgId: args.orgId,
          vehicle: updatedVehicle,
          triggeredByUserId: user._id,
        });
        await maybeAutoPostToFacebook(ctx, {
          orgId: args.orgId,
          vehicle: updatedVehicle,
          triggeredByUserId: user._id,
        });
      }
    }
  },
});

export const upsertLandedCosts = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    items: v.array(v.object({
      label: v.string(),
      amount: v.number(),
      /** How this specific item was paid — drives which account it capitalizes against and which account a later reduction/removal reverses against. Required for a non-zero item on a non-SOURCED vehicle. */
      paymentMethod: v.optional(paymentMethodValidator),
    })),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }
    if (vehicle.status === "SOLD") {
      throw new ConvexError("Cannot edit landed costs on a sold vehicle — its inventory has already been relieved.");
    }

    const items = args.items
      .map((item) => ({ label: item.label.trim(), amount: item.amount, paymentMethod: item.paymentMethod }))
      .filter((item) => item.label.length > 0);
    // Sourced/drop-ship vehicles never sit in physical inventory — their cost
    // basis is sourceCost only, so landed costs entered against one (kept for
    // informational tracking) never capitalize into the GL, and there's no
    // account to silently default for them.
    if (vehicle.sourceType !== "SOURCED") {
      const missingMethod = items.find((item) => item.amount !== 0 && !item.paymentMethod);
      if (missingMethod) {
        throw new ConvexError(`Payment method is required for landed cost item "${missingMethod.label}".`);
      }
    }
    const total = items.reduce((sum, item) => sum + item.amount, 0);
    const now = Date.now();

    const existing = await ctx.db
      .query("vehicleLandedCosts")
      .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
      .unique();
    const previousItems = existing?.items ?? [];

    if (existing) {
      await ctx.db.patch(existing._id, { items, total, updatedAt: now, updatedBy: user._id });
    } else {
      await ctx.db.insert("vehicleLandedCosts", {
        orgId: args.orgId,
        vehicleId: args.vehicleId,
        items,
        total,
        updatedAt: now,
        updatedBy: user._id,
      });
    }

    await ctx.db.patch(args.vehicleId, {
      landedCostTotal: total,
      updatedAt: now,
      updatedBy: user._id,
    });

    if (vehicle.sourceType !== "SOURCED") {
      const currency = await getOrgCurrency(ctx, args.orgId);
      // Group old vs. new items by settlement account and diff per account —
      // not just old-total vs. new-total — so moving an item between accounts
      // (or removing one paid from a different account than the others) posts
      // against the accounts actually affected, even when the net total is
      // unchanged.
      const sumsByMethod = (list: ReadonlyArray<{ amount: number; paymentMethod?: PaymentMethod }>) => {
        const sums = new Map<string, number>();
        for (const item of list) {
          const key = item.paymentMethod ?? normalizePaymentMethod(undefined);
          sums.set(key, (sums.get(key) ?? 0) + item.amount);
        }
        return sums;
      };
      const oldSums = sumsByMethod(previousItems);
      const newSums = sumsByMethod(items);
      const allMethods = new Set([...oldSums.keys(), ...newSums.keys()]);
      const accountDeltas = Array.from(allMethods)
        .map((paymentMethod) => ({
          paymentMethod,
          deltaMinor: toMinorUnits((newSums.get(paymentMethod) ?? 0) - (oldSums.get(paymentMethod) ?? 0), currency),
        }))
        .filter((d) => d.deltaMinor !== 0);

      if (accountDeltas.length > 0) {
        await hookVehicleLandedCostCapitalized(ctx, {
          orgId: args.orgId,
          vehicleId: args.vehicleId,
          // A durable unique token, not a timestamp — two edits to the same
          // vehicle's landed costs landing in the same millisecond must not
          // collide on idempotencyKey and suppress a legitimate GL posting.
          editToken: crypto.randomUUID(),
          accountDeltas,
          currency,
          actorId: user._id,
          occurredAt: now,
        });
      }
    }

    return { total };
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
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    const reason = args.reason.trim();
    if (!reason) throw new ConvexError("A reason is required to correct a vehicle's acquisition cost.");
    if (!Number.isFinite(args.newCost) || args.newCost < 0) {
      throw new ConvexError("New cost must be a non-negative number.");
    }
    if (args.correctionType === "CASH_REFUND" && !args.paymentMethod) {
      throw new ConvexError("A payment method is required for a cash-refund correction.");
    }

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }
    if (vehicle.sourceType === "SOURCED") {
      throw new ConvexError(
        "Sourced vehicles never capitalize into inventory — correct sourceCost via a supplier-payable adjustment instead."
      );
    }
    if (vehicle.status === "SOLD") {
      throw new ConvexError(
        "This vehicle has already sold — its inventory cost has been relieved to COGS. A prior-period cost correction needs a manual journal entry, not this endpoint."
      );
    }
    // Requires a *posted* acquisition, not merely pending: a correction posts
    // a delta on top of the ledger's existing balance, so the base entry
    // must already be settled — correcting against a still-pending base
    // could post before it, or interleave unpredictably with it.
    if (!(await hasPostedVehicleAcquisition(ctx, args.orgId, args.vehicleId))) {
      throw new ConvexError(
        "This vehicle's acquisition cost hasn't posted to accounting yet — edit purchasePrice directly instead."
      );
    }

    const previousCost = vehicle.purchasePrice ?? 0;
    const delta = args.newCost - previousCost;
    if (delta === 0) {
      throw new ConvexError("New cost matches the current cost — nothing to correct.");
    }

    const currency = await getOrgCurrency(ctx, args.orgId);
    const now = Date.now();

    await ctx.db.patch(args.vehicleId, {
      purchasePrice: args.newCost,
      updatedAt: now,
      updatedBy: user._id,
    });

    const correctionId = await ctx.db.insert("vehicleCostCorrections", {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      previousCost,
      newCost: args.newCost,
      reason,
      correctionType: args.correctionType,
      correctedBy: user._id,
      createdAt: now,
    });

    await hookVehicleAcquisitionCostCorrected(ctx, {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      // The correction record's own _id, not a timestamp — two corrections
      // landing in the same millisecond must not collide on idempotencyKey.
      correctionToken: correctionId.toString(),
      deltaMinor: toMinorUnits(delta, currency),
      currency,
      correctionType: args.correctionType,
      paymentMethod: args.paymentMethod,
      actorId: user._id,
      occurredAt: now,
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "vehicle.cost_corrected",
      { actorName, vehicleLabel: `${vehicle.year} ${vehicle.make} ${vehicle.model}` },
      { link: `/${args.orgId}/vehicles?highlightId=${args.vehicleId}` }
    );

    return { previousCost, newCost: args.newCost };
  },
});

export const createReservation = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    customerId: v.id("customers"),
    depositAmount: v.optional(v.number()),
    depositMethod: v.optional(depositMethodValidator),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.isDeleted || customer.orgId !== args.orgId) {
      throw new ConvexError("Customer not found in this organization.");
    }

    const now = Date.now();
    if (args.expiresAt !== undefined && args.expiresAt <= now) {
      throw new ConvexError("Reservation expiry must be in the future.");
    }
    const resolvedExpiresAt = args.expiresAt ?? (await getDefaultReservationExpiry(ctx, args.orgId, now));

    const hasDeposit = args.depositAmount !== undefined;
    if (
      hasDeposit &&
      !isSystemOwnerRole(role) &&
      !role.permissions.includes(PERMISSIONS.VIEW_SALES)
    ) {
      throw new ConvexError(`Forbidden: Missing required permissions: ${PERMISSIONS.VIEW_SALES}`);
    }
    const currency = hasDeposit ? normalizeCurrency(await getOrgCurrency(ctx, args.orgId)) : undefined;
    const method = methodOrDefault(args.depositMethod);
    const amountMinor = hasDeposit
      ? amountToMinorOrThrow(args.depositAmount!, currency!, "Reservation deposit amount")
      : undefined;

    const existingReservations = await ctx.db
      .query("vehicleReservations")
      .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
      .take(100);
    for (const reservation of existingReservations) {
      if (reservation.status === "ACTIVE" && reservation.expiresAt !== undefined && reservation.expiresAt <= now) {
        if (reservation.depositId) {
          const deposit = await ctx.db.get(reservation.depositId);
          if (deposit && deposit.orgId === args.orgId && deposit.status === "HELD" && deposit.holdActive) {
            await ctx.db.patch(reservation.depositId, { holdActive: false });
          }
        }
        await ctx.db.patch(reservation._id, {
          status: "EXPIRED",
          expiredAt: now,
        });
      }
    }
    await syncVehicleHoldStatus(ctx, args.vehicleId, user._id);
    const currentVehicle = await ctx.db.get(args.vehicleId);
    if (!currentVehicle || currentVehicle.isDeleted || currentVehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }
    if (currentVehicle.status !== "AVAILABLE") {
      throw new ConvexError("Vehicle must be available before it can be reserved.");
    }
    if (existingReservations.some((reservation) =>
      reservation.status === "ACTIVE" &&
      (reservation.expiresAt === undefined || reservation.expiresAt > now)
    )) {
      throw new ConvexError("Vehicle already has an active reservation.");
    }

    const reservationId = await ctx.db.insert("vehicleReservations", {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      customerId: args.customerId,
      depositAmount: args.depositAmount,
      depositAmountMinor: amountMinor,
      depositCurrency: currency,
      depositMethod: hasDeposit ? method : undefined,
      expiresAt: resolvedExpiresAt,
      status: "ACTIVE",
      reservedBy: user._id,
      reservedAt: now,
    });

    if (hasDeposit && amountMinor !== undefined && currency !== undefined) {
      const depositId = await recordHeldDeposit(ctx, {
        orgId: args.orgId,
        vehicleId: args.vehicleId,
        customerId: args.customerId,
        reservationId,
        amount: args.depositAmount!,
        amountMinor,
        currency,
        method,
        actorId: user._id,
        now,
        sourceLabel: `reservation ${reservationId}`,
      });
      await ctx.db.patch(reservationId, { depositId });
    }

    await syncVehicleHoldStatus(ctx, args.vehicleId, user._id);

    return reservationId;
  },
});

export const releaseReservation = mutation({
  args: {
    orgId: v.id("organizations"),
    reservationId: v.id("vehicleReservations"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    const reservation = await ctx.db.get(args.reservationId);
    if (!reservation || reservation.orgId !== args.orgId) {
      throw new ConvexError("Reservation not found in this organization.");
    }
    if (reservation.status !== "ACTIVE") {
      throw new ConvexError("Reservation is not active.");
    }

    const vehicle = await ctx.db.get(reservation.vehicleId);
    if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

    const now = Date.now();
    if (reservation.depositId) {
      const deposit = await ctx.db.get(reservation.depositId);
      if (deposit && deposit.orgId === args.orgId && deposit.status === "HELD" && deposit.holdActive) {
        await ctx.db.patch(reservation.depositId, { holdActive: false });
      }
    }
    await ctx.db.patch(args.reservationId, {
      status: "RELEASED",
      releasedAt: now,
      releasedBy: user._id,
    });
    await syncVehicleHoldStatus(ctx, reservation.vehicleId, user._id);
  },
});

export const expireReservations = internalMutation({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
    const reservations = await ctx.db
      .query("vehicleReservations")
      .withIndex("by_status_expiresAt", (q) =>
        q.eq("status", "ACTIVE").lte("expiresAt", now)
      )
      .take(limit);

    for (const reservation of reservations) {
      if (reservation.expiresAt === undefined || reservation.expiresAt > now) continue;
      if (reservation.depositId) {
        const deposit = await ctx.db.get(reservation.depositId);
        if (deposit && deposit.orgId === reservation.orgId && deposit.status === "HELD" && deposit.holdActive) {
          await ctx.db.patch(reservation.depositId, { holdActive: false });
          // Money already changed hands (عربون) — expiry only lifts the vehicle
          // hold. A manager still has to decide REFUNDED vs. FORFEITED via
          // deposits.release, same human-in-the-loop as every other deposit
          // resolution (see deposits.ts release/void).
          const [vehicle, customer] = await Promise.all([
            ctx.db.get(reservation.vehicleId),
            ctx.db.get(reservation.customerId),
          ]);
          const vehicleLabel = vehicle
            ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim()
            : "Vehicle";
          const customerLabel = customer
            ? `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Customer"
            : "Customer";
          await notifyManagers(
            ctx,
            reservation.orgId,
            "deposit.expired",
            { vehicleLabel, customerLabel, amount: String(deposit.amount) },
            { link: `/${reservation.orgId}/sales?highlightId=${reservation.vehicleId}` }
          );
        }
      }
      await ctx.db.patch(reservation._id, {
        status: "EXPIRED",
        expiredAt: now,
      });
      await syncVehicleHoldStatus(ctx, reservation.vehicleId);
    }

    return { expired: reservations.length };
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
    make: v.string(),
    model: v.string(),
    year: v.number(),
    trim: v.optional(v.string()),
    color: v.string(),
    mileage: v.number(),
    fuelType: v.string(),
    transmission: v.string(),
    sourcedFromName: v.string(),
    sourceCost: v.number(),
    sellingPrice: v.number(),
    vin: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Sourcing a vehicle mid-sale needs to write immediately (the salesperson
    // is actively closing a deal), so this accepts CREATE_VEHICLES_REQUEST —
    // the same permission sales already holds for creating/editing normal
    // stock with approval — not just the manager-only direct CREATE_VEHICLES.
    // Every sourced vehicle still gets an APPROVED-status vehicleEdits audit
    // row and a manager notification below, so oversight isn't lost.
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    if (
      !isSystemOwnerRole(role) &&
      !role.permissions.includes(PERMISSIONS.CREATE_VEHICLES) &&
      !role.permissions.includes(PERMISSIONS.CREATE_VEHICLES_REQUEST)
    ) {
      throw new ConvexError(
        `Forbidden: Missing required permissions: ${PERMISSIONS.CREATE_VEHICLES_REQUEST}`
      );
    }

    const vehicleGate = await ctx.runQuery(internal.subscriptions.canAddVehicle, { orgId: args.orgId });
    if (!vehicleGate.allowed) {
      throw new ConvexError(
        `You've reached the ${vehicleGate.limit}-vehicle limit on your current plan. Upgrade to add more vehicles.`
      );
    }

    if (!args.sourcedFromName.trim()) {
      throw new ConvexError("Sourced vehicles require a supplier dealer name (sourcedFromName).");
    }
    if (args.sourceCost <= 0) {
      throw new ConvexError("Supplier cost must be greater than zero.");
    }
    if (!args.make.trim() || !args.model.trim() || !args.color.trim()) {
      throw new ConvexError("Make, model, and color are required.");
    }

    const normalizedVin = args.vin?.trim().toUpperCase() || `SOURCING-${Date.now()}`;

    const existing = await ctx.db
      .query("vehicles")
      .withIndex("by_org_vin", (q) => q.eq("orgId", args.orgId).eq("vin", normalizedVin))
      .unique();
    if (existing) {
      throw new ConvexError(`A vehicle with VIN "${normalizedVin}" already exists.`);
    }

    const now = Date.now();
    const id = await ctx.db.insert("vehicles", {
      orgId: args.orgId,
      vin: normalizedVin,
      make: args.make.trim(),
      model: args.model.trim(),
      year: args.year,
      trim: args.trim?.trim(),
      color: args.color.trim(),
      mileage: args.mileage,
      fuelType: args.fuelType,
      transmission: args.transmission,
      purchasePrice: args.sourceCost,
      sourceCost: args.sourceCost,
      sourcedFromName: args.sourcedFromName.trim(),
      sourceType: "SOURCED",
      sellingPrice: args.sellingPrice,
      status: "SOURCING",
      notes: args.notes,
      createdAt: now,
      addedBy: user._id,
      updatedBy: user._id,
      updatedAt: now,
    });

    // Audit trail — mirror what create records so sourced vehicles appear in
    // vehicle history reports and manager audit views.
    await ctx.db.insert("vehicleEdits", {
      orgId: args.orgId,
      requestedBy: user._id,
      type: "CREATE",
      payload: {
        vin: normalizedVin,
        make: args.make,
        model: args.model,
        year: args.year,
        trim: args.trim,
        color: args.color,
        mileage: args.mileage,
        fuelType: args.fuelType,
        transmission: args.transmission,
        sourceCost: args.sourceCost,
        sourcedFromName: args.sourcedFromName,
        sourceType: "SOURCED" as const,
        sellingPrice: args.sellingPrice,
        status: "SOURCING" as const,
      },
      status: "APPROVED",
      resolvedBy: user._id,
      resolvedAt: now,
      createdAt: now,
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "vehicle.created",
      { actorName, vehicleLabel: `${args.year} ${args.make.trim()} ${args.model.trim()} (Sourced)` },
      { link: `/${args.orgId}/vehicles?highlightId=${id}` }
    );

    return id;
  },
});

/**
 * Soft deletes a vehicle. Only vehicles with status AVAILABLE or ARCHIVED can be deleted.
 */
// TODO: Add admin recovery endpoint if needed
export const softDelete = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.DELETE_VEHICLES]);
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");

    const statusLimit = await checkTenantWriteLimit(ctx, "standardApi", args.orgId);
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

    if (vehicle.status === "SOLD" || vehicle.status === "RESERVED") {
      throw new ConvexError(
        `Cannot delete a vehicle with status "${vehicle.status}". Archive it first.`
      );
    }

    // We no longer delete associated images, we just soft-delete the record
    await ctx.db.patch(args.vehicleId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "vehicle.deleted",
      { actorName, vehicleLabel: `${vehicle.year} ${vehicle.make} ${vehicle.model}`, vin: vehicle.vin ?? "" }
    );
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

    const statusLimit = await checkTenantWriteLimit(ctx, "upload", args.orgId);
    if (!statusLimit.ok) {
      throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
    }

    // 5MB limit
    if (args.sizeInBytes > 5 * 1024 * 1024) {
      throw new ConvexError("File size exceeds 5MB limit.");
    }

    if (!VEHICLE_IMAGE_CONTENT_TYPES.includes(args.mimeType.toLowerCase() as typeof VEHICLE_IMAGE_CONTENT_TYPES[number])) {
      throw new ConvexError("Only JPEG, PNG, or WebP images are allowed for vehicles.");
    }

    return await ctx.storage.generateUploadUrl();
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

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.isDeleted || vehicle.orgId !== args.orgId) {
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
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    // 1. Fetch Sales (a vehicle has at most a handful of sales)
    const sales = await ctx.db
      .query("sales")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("vehicleId"), args.vehicleId))
      .take(20);

    const enrichedSales = await Promise.all(
      sales.map(async (sale) => {
        const customer = await ctx.db.get(sale.customerId);
        const salesperson = await ctx.db.get(sale.salespersonId);
        return {
          ...sale,
          customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
          salespersonName: salesperson && "name" in salesperson ? salesperson.name : "Unknown",
        };
      })
    );

    // 2. Fetch Leads
    const leads = await ctx.db
      .query("leads")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("vehicleId"), args.vehicleId))
      .take(50);

    const enrichedLeads = await Promise.all(
      leads.map(async (lead) => {
        const customer = await ctx.db.get(lead.customerId);
        const assignedUser = lead.assignedUserId ? await ctx.db.get(lead.assignedUserId) : null;
        return {
          ...lead,
          customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
          assignedUserName: assignedUser && "name" in assignedUser ? assignedUser.name : "Unassigned",
        };
      })
    );

    // 3. Fetch Expenses
    const expenses = await ctx.db
      .query("expenses")
      .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
      .take(200);

    const enrichedExpenses = await Promise.all(
      expenses.map(async (exp) => {
        const payer = exp.payerId ? await ctx.db.get(exp.payerId) : null;
        return {
          ...exp,
          payerName: payer && "name" in payer ? payer.name : null,
          status: exp.status || "PAID",
        };
      })
    );

    // 4. Fetch Tasks
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
      .take(200);

    const enrichedTasks = await Promise.all(
      tasks.map(async (task) => {
        const assignedUser = await ctx.db.get(task.assignedTo);
        return {
          ...task,
          assignedUserName: assignedUser && "name" in assignedUser ? assignedUser.name : "Unknown",
        };
      })
    );

    // 5. Fetch Test Drives
    const testDrives = await ctx.db
      .query("test_drives")
      .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
      .collect();

    const enrichedTestDrives = await Promise.all(
      testDrives.map(async (td) => {
        const customer = await ctx.db.get(td.customerId);
        const salesperson = await ctx.db.get(td.salespersonId);
        return {
          ...td,
          customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
          salespersonName: salesperson && "name" in salesperson ? salesperson.name : "Unknown",
        };
      })
    );

    // 6. Fetch Work Orders
    const workOrders = await ctx.db
      .query("workOrders")
      .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
      .collect();

    return {
      sales: enrichedSales.sort((a, b) => b.saleDate - a.saleDate),
      leads: enrichedLeads.sort((a, b) => b._creationTime - a._creationTime),
      expenses: enrichedExpenses.sort((a, b) => b.date - a.date),
      tasks: enrichedTasks.sort((a, b) => a.dueDate - b.dueDate),
      testDrives: enrichedTestDrives.sort((a, b) => b.startTime - a.startTime),
      workOrders: workOrders.sort((a, b) => b._creationTime - a._creationTime),
    };
  },
});

export const importBulk = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicles: v.array(v.object({
      make: v.string(),
      model: v.string(),
      year: v.number(),
      vin: v.string(),
      color: v.string(),
      mileage: v.optional(v.number()),
      fuelType: v.string(),
      transmission: v.string(),
      sellingPrice: v.number(),
      purchasePrice: v.optional(v.number()),
      status: v.optional(v.string()),
      notes: v.optional(v.string()),
      // Owned stock vs sourced (drop-ship from another dealer). SOURCED rows
      // carry the supplier name + cost and land as SOURCING status; anything
      // else is treated as owned STOCK.
      sourceType: v.optional(v.string()),
      sourcedFromName: v.optional(v.string()),
      sourceCost: v.optional(v.number()),
      // Per-company financing valuations carried over from the spreadsheet's
      // valuation columns. `companyId` targets an existing finance company;
      // `companyName` (no companyId) means the column's header didn't match
      // any existing company and a placeholder one should be auto-created.
      valuations: v.optional(v.array(v.object({
        companyId: v.optional(v.id("financeCompanies")),
        companyName: v.optional(v.string()),
        valuationAmount: v.number(),
      }))),
    })),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_VEHICLES]);

    // Resolve (and lazily create) finance companies referenced by name only.
    // Created inert (isActive: false, zero rates) — an Owner must configure
    // and activate them from Settings → Finance before they affect quotes.
    const existingCompanies = await ctx.db
      .query("financeCompanies")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    const companyIdByName = new Map<string, Id<"financeCompanies">>();
    existingCompanies.forEach((c) => companyIdByName.set(c.name.trim(), c._id));

    let companiesCreated = 0;
    for (const row of args.vehicles) {
      for (const val of row.valuations ?? []) {
        if (val.companyId || !val.companyName) continue;
        const name = val.companyName.trim();
        if (!name || companyIdByName.has(name)) continue;
        const newId = await ctx.db.insert("financeCompanies", {
          orgId: args.orgId,
          name,
          profitRate: 0,
          maxTermMonths: 84,
          gracePeriodMonths: 0,
          isActive: false,
        });
        companyIdByName.set(name, newId);
        companiesCreated++;
      }
    }

    let inserted = 0;
    let skipped = 0;

    for (const row of args.vehicles) {
      // Placeholder VINs (xxxxx, N/A, blank, ...) are treated as "no VIN": they
      // must NOT dedupe against each other, or all-but-one stock row is skipped.
      const normalizedVin = isPlaceholderVin(row.vin) ? "" : row.vin.trim().toUpperCase();

      // Skip duplicate VINs within the org (or blank VINs treated as unique),
      // but still refresh that vehicle's valuations from this import.
      let vehicleId: Id<"vehicles"> | null = null;
      if (normalizedVin) {
        const existing = await ctx.db
          .query("vehicles")
          .withIndex("by_org_vin", (q) => q.eq("orgId", args.orgId).eq("vin", normalizedVin))
          .unique();
        if (existing) {
          skipped++;
          vehicleId = existing._id;
        }
      }

      if (!vehicleId) {
        const isSourced = (row.sourceType ?? "").trim().toUpperCase() === "SOURCED";

        // A sourced row without its supplier name + cost can't be created (the
        // same constraint createSourced enforces). Skip it rather than throw —
        // one bad row must not roll back the whole batch's inserts.
        const sourceCost = row.sourceCost ?? row.purchasePrice;
        if (isSourced && (!row.sourcedFromName?.trim() || sourceCost === undefined || sourceCost <= 0)) {
          skipped++;
          continue;
        }

        // Sourced vehicles begin life as SOURCING; owned stock as AVAILABLE.
        const status = normalizeVehicleStatus(row.status) ?? (isSourced ? "SOURCING" : "AVAILABLE");
        assertDirectVehicleCreateStatus(status);

        vehicleId = await ctx.db.insert("vehicles", {
          orgId: args.orgId,
          vin: normalizedVin || generateImportVinPlaceholder(),
          make: row.make.trim(),
          model: row.model.trim(),
          year: row.year,
          mileage: row.mileage ?? 0,
          color: row.color.trim(),
          fuelType: row.fuelType,
          transmission: row.transmission,
          sellingPrice: row.sellingPrice,
          // For a sourced vehicle purchasePrice mirrors the supplier cost, matching createSourced.
          purchasePrice: isSourced ? sourceCost : row.purchasePrice,
          ...(isSourced
            ? { sourceType: "SOURCED" as const, sourcedFromName: row.sourcedFromName!.trim(), sourceCost }
            : {}),
          status: status as VehicleLifecycleStatus,
          notes: row.notes,
          addedBy: user._id,
          updatedBy: user._id,
          updatedAt: Date.now(),
        });
        inserted++;
      }

      for (const val of row.valuations ?? []) {
        const companyId = val.companyId ?? (val.companyName ? companyIdByName.get(val.companyName.trim()) : undefined);
        if (!companyId || val.valuationAmount <= 0) continue;

        const existingValuation = await ctx.db
          .query("vehicleValuations")
          .withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicleId!))
          .filter((q) => q.eq(q.field("companyId"), companyId))
          .first();

        if (existingValuation) {
          await ctx.db.patch(existingValuation._id, { valuationAmount: val.valuationAmount });
        } else {
          await ctx.db.insert("vehicleValuations", {
            orgId: args.orgId,
            vehicleId: vehicleId!,
            companyId,
            valuationAmount: val.valuationAmount,
          });
        }
      }
    }

    return { inserted, skipped, companiesCreated };
  },
});
