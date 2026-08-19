import { v, ConvexError } from "convex/values";
import { MutationCtx, QueryCtx, query } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { vehiclesByOrg, LIVE, OWN_STOCK, SOURCED, SUM_EPOCH } from "./aggregates";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth, requireOwnedRow } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { checkTenantWriteLimit } from "./rateLimit";
import { validateInput } from "./utils/validation";
import { CreateVehicleSchema, UpdateVehicleSchema } from "./validations/vehicles";
import { maybeAutoPostToInstagram, maybeAutoPostToFacebook } from "./utils/socialAutoPost";
import { internal } from "./_generated/api";
import { getOrgCurrency, hookVehicleAcquired, hookVehicleLandedCostCapitalized, hookVehicleAcquisitionCostCorrected } from "./accounting/workflowHooks";
import { toMinorUnits, fromMinorUnits, assertFiniteNumber } from "./utils/money";
import { paymentMethodValidator, acquisitionPaymentMethodValidator, normalizePaymentMethod, type AcquisitionPaymentMethod, type PaymentMethod } from "./utils/paymentMethods";
import { PURCHASE_IMPORT_MAX_ROWS } from "./utils/importLimits";
import { findCommandUnit, recordCommandUnit } from "./utils/idempotency";
import { simplePayloadHash } from "./accounting/postingRules";
import { hasNonCanonicalVinCharacters, isPlaceholderVin } from "./utils/vin";

/** The stock kinds `getAgingBuckets` sums over, in key order. */
const STOCK_KINDS = [OWN_STOCK, SOURCED];

function randomHex(bytesLength: number): string {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function generateImportVinPlaceholder(): string {
  return `IMPORT-${Date.now()}-${randomHex(3)}`;
}
import { syncVehicleHoldStatus, getDefaultReservationExpiry, getActiveDepositHolds } from "./utils/depositHelpers";
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
import { retroactiveOwnershipChangeRefusal } from "./utils/vehicleOwnership";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The vehicle aging histogram's four buckets, as inclusive age ranges in days
 * so they can be turned into createdAt bounds on the aggregate.
 * `maxAgeDays: null` is the open-ended oldest bucket.
 *
 * These boundaries are the ones the original row scan applied as
 * `days <= 30 | 60 | 90`; `vehicleAggregate.test.ts` pins both edges of every
 * bucket against that formula.
 */
const AGE_BUCKETS = [
  { bucket: "0-30" as const, minAgeDays: 0, maxAgeDays: 30 },
  { bucket: "31-60" as const, minAgeDays: 31, maxAgeDays: 60 },
  { bucket: "61-90" as const, minAgeDays: 61, maxAgeDays: 90 },
  { bucket: "90+" as const, minAgeDays: 91, maxAgeDays: null },
];

/**
 * Aggregate sort key for a live AVAILABLE vehicle of a given stock kind,
 * created at `createdAt`.
 *
 * The histogram counts own stock *and* sourced vehicles — that is what the row
 * scan it replaced did, since it never looked at `sourceType`. `sourcedFlag`
 * sits above `status` in the key, so "both kinds" is not one contiguous range;
 * each bucket therefore contributes one query per kind, and the pairs are
 * summed back together below. Both still land in a single batched round-trip.
 */
function agingKey(sourcedFlag: number, createdAt: number): [number, number, string, number] {
  return [LIVE, sourcedFlag, "AVAILABLE", createdAt];
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

    const now = Date.now();

    // Each bucket is a contiguous createdAt range *per stock kind*, so it is a
    // bounded count and a bounded sum against the B-tree — four buckets × two
    // kinds × (count + sum) = sixteen O(log n) reads in total, no vehicle
    // documents touched. Iterating every AVAILABLE vehicle to build this
    // histogram was 1.19 GB of database I/O.
    //
    // The kinds double the range count but not the round-trips: `countBatch`
    // and `sumBatch` each walk the tree once no matter how many bound pairs
    // they are handed, which is why they are used instead of per-bucket calls.
    //
    // Boundaries are derived from the row-scan's `ageDays <= 30 | 60 | 90`,
    // where ageDays = floor((now - createdAt) / DAY_MS):
    //   ageDays <= N  <=>  createdAt > now - (N + 1) * DAY_MS
    const queries = AGE_BUCKETS.flatMap(({ maxAgeDays, minAgeDays }) =>
      STOCK_KINDS.map((sourcedFlag) => ({
        namespace: args.orgId,
        bounds: {
          // An older vehicle has a *smaller* createdAt, so maxAgeDays gives the
          // lower bound of the range and minAgeDays the upper one.
          lower:
            maxAgeDays === null
              ? { key: agingKey(sourcedFlag, Number.MIN_SAFE_INTEGER), inclusive: true as const }
              : {
                key: agingKey(sourcedFlag, now - (maxAgeDays + 1) * DAY_MS),
                inclusive: false as const,
              },
          upper:
            minAgeDays === 0
              ? { key: agingKey(sourcedFlag, Number.MAX_SAFE_INTEGER), inclusive: true as const }
              : {
                key: agingKey(sourcedFlag, now - minAgeDays * DAY_MS),
                inclusive: true as const,
              },
        },
      })),
    );

    // Batched: `count` and `sum` each issue their own component round-trip, so
    // asking per bucket would be eight traversals of the same tree — enough to
    // read more than the row scan this replaces on a mid-sized org. Two batched
    // calls walk it twice regardless of how many buckets there are.
    const [counts, sums] = await Promise.all([
      vehiclesByOrg.countBatch(ctx, queries),
      vehiclesByOrg.sumBatch(ctx, queries),
    ]);

    return AGE_BUCKETS.map(({ bucket }, i) => {
      // Each bucket produced one query per stock kind, laid out contiguously by
      // the flatMap above, so bucket i owns [i * STOCK_KINDS.length, +len).
      const from = i * STOCK_KINDS.length;
      const slice = STOCK_KINDS.map((_, k) => from + k);
      const count = slice.reduce((acc, j) => acc + counts[j], 0);
      const sum = slice.reduce((acc, j) => acc + sums[j], 0);
      // Mean age from the mean createdAt (sums are stored offset by SUM_EPOCH,
      // so add it back). The row scan averaged already-floored ages and this
      // floors once at the end, so on a mixed bucket the two can differ by at
      // most a day — within what an "average days in stock" tile conveys, and
      // the only way to get an average without reading the rows.
      //
      // The scan also clamped each row's age at 0 before averaging, which this
      // cannot reproduce from a sum. Only a future-dated `createdAt` can tell
      // the difference, and no mutation produces one — every write path stamps
      // Date.now(). The admin raw-JSON editor can, so the clamp stays on the
      // result to keep a negative average from ever reaching the UI.
      const avgDays =
        count > 0
          ? Math.max(0, Math.round((now - (sum / count + SUM_EPOCH)) / DAY_MS))
          : 0;

      return { bucket, count, avgDays };
    });
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

    const reservationRows = await Promise.all(
      reservations.map(async (reservation) => {
        const customer = await ctx.db.get(reservation.customerId);
        const reservedBy = await ctx.db.get(reservation.reservedBy);
        const releasedBy = reservation.releasedBy ? await ctx.db.get(reservation.releasedBy) : null;
        return {
          ...reservation,
          origin: "RESERVATION" as const,
          customerName: customer ? `${customer.firstName} ${customer.lastName}` : null,
          reservedByName: reservedBy?.name ?? reservedBy?.email ?? null,
          releasedByName: releasedBy?.name ?? releasedBy?.email ?? null,
        };
      })
    );

    // A deposit taken in the sales wizard holds the vehicle just as hard as a
    // reservation does, but writes only a `deposits` row — so this tab used to
    // read "No reservations recorded" while a live hold was keeping the car off
    // the market. Deposits that were created *by* a reservation are skipped:
    // the reservation row above already represents them.
    const heldDeposits = await ctx.db
      .query("deposits")
      .withIndex("by_vehicle_hold", (q) => q.eq("vehicleId", args.vehicleId))
      .order("desc")
      .take(100);

    // A vehicle can also be a *secondary* line on a multi-vehicle quote, whose
    // deposit row only ever snapshots the primary vehicleId — the join table is
    // the sole record. Without this, the second and third cars on a three-car
    // deal showed "No reservations recorded" while genuinely being held.
    const secondaryHolds = await ctx.db
      .query("depositVehicleHolds")
      .withIndex("by_vehicle_active", (q) => q.eq("vehicleId", args.vehicleId))
      .take(100);
    const secondaryDeposits = await Promise.all(
      secondaryHolds.map(async (hold) => {
        const deposit = await ctx.db.get(hold.depositId);
        return deposit ? { deposit, joinActive: hold.active } : null;
      })
    );

    const candidateDeposits = [
      ...heldDeposits.map((deposit) => ({ deposit, joinActive: null as boolean | null })),
      ...secondaryDeposits.filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    ];

    const seenDepositIds = new Set<string>();
    const depositRows = await Promise.all(
      candidateDeposits
        .filter(({ deposit }) => {
          if (
            deposit.orgId !== args.orgId ||
            deposit.reservationId !== undefined ||
            deposit.isDeleted === true
          ) {
            return false;
          }
          if (seenDepositIds.has(deposit._id)) return false;
          seenDepositIds.add(deposit._id);
          return true;
        })
        .map(async ({ deposit, joinActive }) => {
          const [customer, reservedBy, releasedBy] = await Promise.all([
            ctx.db.get(deposit.customerId),
            ctx.db.get(deposit.createdBy),
            deposit.resolvedBy ? ctx.db.get(deposit.resolvedBy) : Promise.resolve(null),
          ]);
          // ACTIVE is driven by `holdActive`, not by `status`. The two are
          // deliberately decoupled (see the deposits table in schema.ts): a
          // rejected finance application, a released reservation and an expired
          // reservation all clear holdActive while leaving the deposit HELD so a
          // manager still decides refund vs forfeit. Reading `status` alone
          // rendered those as ACTIVE holds forever, with a live Release button,
          // long after they stopped holding anything.
          const stillHolding =
            deposit.status === "HELD" && deposit.holdActive === true && joinActive !== false;
          const status = stillHolding
            ? ("ACTIVE" as const)
            : deposit.status === "APPLIED"
              ? ("CONVERTED" as const)
              : ("RELEASED" as const);
          return {
            _id: deposit._id,
            _creationTime: deposit._creationTime,
            origin: "DEPOSIT" as const,
            // A forfeited deposit means the dealership kept the money — a
            // materially different outcome from a refund, and the tab used to
            // render both identically.
            depositResolution: deposit.status,
            orgId: deposit.orgId,
            vehicleId: deposit.vehicleId,
            customerId: deposit.customerId,
            status,
            depositAmount: deposit.amount,
            expiresAt: undefined as number | undefined,
            reservedAt: deposit.createdAt ?? deposit._creationTime,
            releasedAt: deposit.resolvedAt,
            customerName: customer ? `${customer.firstName} ${customer.lastName}` : null,
            reservedByName: reservedBy?.name ?? reservedBy?.email ?? null,
            releasedByName: releasedBy?.name ?? releasedBy?.email ?? null,
          };
        })
    );

    return [...reservationRows, ...depositRows]
      .sort((a, b) => b.reservedAt - a.reservedAt)
      .slice(0, 100);
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
      assertFiniteNumber(args.sourceCost, "supplier cost");
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
 * STRICTER than `hasVehicleAcquisitionAccountingExposure`, and deliberately local.
 *
 * The shared helper answers "was an attempt ever made". That is the right
 * question for `accountingMigration`, which uses it to avoid posting a second
 * event. It is the wrong question here, because this guard uses the answer to
 * take its PERMISSIVE branch — to conclude a car is already capitalized and may
 * be skipped — so it has to prove capitalization is CURRENTLY TRUE, not that
 * something was once attempted.
 *
 * `accountingEvents.status` is PENDING | POSTED | FAILED | REVERSED and the
 * shared helper inspects none of them. A REVERSED acquisition, whose journal has
 * been netted back to zero, and a dead-lettered FAILED outbox row would both
 * read as "capitalized", and the car would be silently skipped forever while a
 * later sale credits Vehicle Inventory against a debit that no longer exists.
 *
 * The shared helper is deliberately NOT changed: it has five other callers in
 * `accountingMigration.ts` and `vehicleEdits.ts` whose looser semantics are
 * correct for what they ask, and widening this change to alter their behaviour
 * is the scope creep that produced the defects this round exists to close.
 * SCRUM-94 owns the durable identity work; SCRUM-166 owns the shared helper.
 *
 * It returns the EVIDENCE rather than a boolean because "an acquisition was
 * posted for this vehicleId" is not enough to conclude that a row in a new
 * import is a retry OF THAT PURCHASE. A vehicle document is editable — make,
 * model and year can all be corrected after the fact — so vehicle facts alone
 * are a contradiction check, not proof of economic identity. The posted event
 * carries the part that cannot be edited from the vehicle screen: what was
 * capitalized, in which currency, and how it was paid. See
 * `acquisitionFingerprintMismatch`.
 */
interface ProvenAcquisitionEvidence {
  /** From the event payload. `undefined` means the record cannot prove it. */
  costMinor: number | undefined;
  currency: string | undefined;
  paymentMethod: string | undefined;
}

async function provenAcquisitionEvidence(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<ProvenAcquisitionEvidence | null> {
  const events = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", orgId).eq("sourceType", "vehicles").eq("sourceId", vehicleId.toString())
    )
    .filter((q) => q.eq(q.field("eventType"), "VEHICLE_ACQUIRED"))
    .collect();
  const posted = events.find((event) => event.status === "POSTED");
  if (posted) return readAcquisitionEvidence(posted.payload, posted.currency);

  // An outbox row still queued to POST is durable and will post, so it is real
  // exposure. A FAILED row has been dead-lettered and is not — accepting one
  // would skip a car that never capitalized, which is SCRUM-59 itself arriving
  // by another route (covered: "a DEAD-LETTERED outbox row is not proof").
  // A row already resolved to POSTED is represented by the event checked above.
  //
  // ⚠️ The `kind === "POST"` half has NO test, deliberately. Mutation testing
  // found it survives deletion, and the reason is that the state it excludes is
  // unreachable: `enqueuePendingReversal` is the only writer of a REVERSE row,
  // and every caller supplies a prefixed key (`reversed_*`, `trade_in_reversed_*`,
  // `sale_cancelled_*`, `prepaid_reversed_*`, `cheque_return_after_clear_*`, ...),
  // so no REVERSE row can carry `vehicle_acquired_<id>` and this lookup can
  // never return one. It is kept as a fail-closed assertion of that invariant,
  // not removed — but a test for it would assert a shape the system does not
  // produce, which is worse than none.
  const queued = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", orgId).eq("idempotencyKey", `vehicle_acquired_${vehicleId}`)
    )
    .collect();
  const pending = queued.find((row) => row.kind === "POST" && row.status === "PENDING");
  if (pending) return readAcquisitionEvidence(pending.payload, pending.currency);
  return null;
}

/**
 * `payload` is `v.any()`, so every field here is read defensively and a value of
 * the wrong shape becomes `undefined` rather than being trusted. `undefined` is
 * never treated as agreement — the caller refuses on it.
 */
function readAcquisitionEvidence(
  payload: unknown,
  rowCurrency: string | undefined
): ProvenAcquisitionEvidence {
  const p = (payload ?? {}) as Record<string, unknown>;
  const costMinor = typeof p.costMinor === "number" && Number.isFinite(p.costMinor) ? p.costMinor : undefined;
  const payloadCurrency = typeof p.currency === "string" && p.currency.trim() ? p.currency : undefined;
  const paymentMethod = typeof p.paymentMethod === "string" && p.paymentMethod.trim() ? p.paymentMethod : undefined;
  return { costMinor, currency: payloadCurrency ?? rowCurrency, paymentMethod };
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

    // Changing what a vehicle IS, after it has been sold, rewrites history in
    // whichever direction it runs. Both are refused.
    //
    // SOURCED→STOCK: the sale posted on agent basis — commission on the margin,
    // no COGS, no inventory — and converting now capitalizes Vehicle Inventory
    // for a car that has already left the lot. Nothing will ever relieve that
    // asset, because the sale that would have is in the past, so it sits on the
    // balance sheet permanently while the completed sale's basis is silently
    // contradicted underneath it.
    //
    // STOCK→SOURCED: the sale posted as principal — gross revenue, COGS,
    // inventory relieved. Declaring the car consigned afterwards says the
    // dealership never owned what it has already recognised revenue and cost of
    // sales on, and asserts a supplier entitlement out of a completed deal that
    // nobody will ever settle.
    //
    // This direction was previously left open on the belief that the
    // acquisition-exposure lock below caught it. It does not: that lock keys on
    // `"sourceType" in patch && patch.sourceType !== "SOURCED"`, so a patch
    // setting sourceType TO "SOURCED" never reaches it.
    //
    // A genuine historical correction goes through the audited migration path
    // (`consignedSaleCorrections`), which posts a correcting journal and leaves
    // a record, rather than editing the basis out from under a posted sale.
    const ownershipRefusal = retroactiveOwnershipChangeRefusal({
      currentSourceType: vehicle.sourceType,
      requestedSourceType: args.sourceType,
      status: vehicle.status,
    });
    if (ownershipRefusal) throw new ConvexError(ownershipRefusal);

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

      // Ownership is derived from sourceType, so the flag flipping erases the
      // past: a car sold as the supplier's agent and bought in afterwards would
      // read forever as stock the dealership always owned, making the
      // agent-basis sale behind it look like a mistake. Record the transition
      // before the flag moves, while the old values are still readable.
      const previousSourceType = vehicle.sourceType ?? "STOCK";
      const nextSourceType = (patch.sourceType as "STOCK" | "SOURCED" | undefined) ?? previousSourceType;
      if (nextSourceType !== previousSourceType) {
        await ctx.db.insert("vehicleOwnershipConversions", {
          orgId: args.orgId,
          vehicleId: args.vehicleId,
          fromSourceType: previousSourceType,
          toSourceType: nextSourceType,
          supplierName: vehicle.sourcedFromName,
          supplierEntitlementAtConversion: vehicle.sourceCost,
          purchaseAmount:
            "purchasePrice" in patch ? (patch.purchasePrice as number) : vehicle.purchasePrice,
          purchaseDate: Date.now(),
          paymentMethod: args.purchasePaymentMethod,
          convertedBy: user._id,
          convertedAt: Date.now(),
        });
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

    // For a non-SOURCED vehicle a NaN total blows up later in toMinorUnits and
    // rolls the mutation back, but that GL block is skipped entirely for SOURCED
    // vehicles — so NaN would land in vehicleLandedCosts.total and
    // vehicles.landedCostTotal with no error at all.
    for (const item of args.items) {
      assertFiniteNumber(item.amount, "landed cost amount");
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

    // ACTIVE-only and streamed, not a fixed page. `by_org_vehicle` returned
    // oldest-first over every status, so on a vehicle with 100+ historical
    // released/expired reservations a live one fell outside the window — the
    // expiry sweep below missed it and the duplicate check further down let a
    // second active reservation be written on top of it. Narrowing to ACTIVE
    // alone does not close that: a reservation stays ACTIVE until this very
    // sweep expires it, so unswept rows can still fill a page ahead of the live
    // one. Collecting the whole ACTIVE range is bounded in practice — a vehicle
    // holds at most one live reservation, and the rest are rows this loop is
    // about to retire.
    const existingReservations = await ctx.db
      .query("vehicleReservations")
      .withIndex("by_org_vehicle_status", (q) =>
        q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId).eq("status", "ACTIVE")
      )
      .collect();
    for (const reservation of existingReservations) {
      if (reservation.expiresAt !== undefined && reservation.expiresAt <= now) {
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
    // SOURCING is reservable: a special-order car is located for a specific
    // customer, so reserving one is the whole point of the flow.
    //
    // RESERVED has to be accepted too, and the ordering above is why. The
    // `syncVehicleHoldStatus` call on the line before this promotes any vehicle
    // that already carries a deposit hold to RESERVED — so by the time the
    // status is re-read, a car being reserved *because* a deposit was taken on
    // it always reads RESERVED. Rejecting that threw and rolled the promotion
    // back with it, leaving the vehicle exactly as it started: the sourced car
    // this flow exists to reserve could never get past this line. Reserving on
    // top of someone else's deposit is still refused, just below.
    const reservableStatuses = ["AVAILABLE", "SOURCING", "RESERVED"];
    if (!reservableStatuses.includes(currentVehicle.status)) {
      throw new ConvexError("Vehicle must be available or on order before it can be reserved.");
    }
    // Every row here was ACTIVE when read; the loop above may since have
    // patched some to EXPIRED, and those are exactly the ones whose expiry has
    // passed — so the expiry comparison, not the now-stale in-memory `status`,
    // is what distinguishes a reservation that still stands.
    if (existingReservations.some(
      (reservation) => reservation.expiresAt === undefined || reservation.expiresAt > now
    )) {
      throw new ConvexError("Vehicle already has an active reservation.");
    }
    // A hold belonging to a different customer still blocks the reservation —
    // accepting RESERVED above must not let customer B reserve a car that
    // customer A's deposit is holding.
    //
    // Resolved through getActiveDepositHolds so a *secondary* vehicle on a
    // multi-vehicle quote is covered too: those are recorded only in
    // depositVehicleHolds, so querying deposits.by_vehicle_hold alone reported
    // car 2 of a three-car deal as unheld and would have let a second customer
    // reserve it out from under the first.
    const holdingDeposits = await getActiveDepositHolds(ctx, args.vehicleId);
    if (
      holdingDeposits.some(
        (deposit) => deposit.orgId === args.orgId && deposit.customerId !== args.customerId
      )
    ) {
      throw new ConvexError("Another customer's deposit is currently holding this vehicle.");
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

    if (vehicle.isDeleted) {
      throw new ConvexError("Vehicle not found in this organization.");
    }
    if (vehicle.sourceType !== "SOURCED") {
      throw new ConvexError("Only sourced vehicles can be marked as arrived.");
    }
    if (vehicle.status === "SOLD" || vehicle.status === "ARCHIVED") {
      throw new ConvexError("This vehicle is no longer in the sourcing pipeline.");
    }
    if (vehicle.arrivedAt != null) {
      return args.vehicleId;
    }

    const now = Date.now();

    // Resolve the hold state before deciding where the car goes. A row written
    // before this fix can be SOURCING *with* a live deposit hold — that is the
    // exact state this PR exists to repair, and it survives until
    // reconcileVehicleHolds runs. Reading the pre-sync status would put such a
    // car back on the lot while a customer's deposit still points at it, free
    // to be sold or reserved to somebody else.
    //
    // Note this promotes rather than clearing `holdActive`: the deposit is real
    // money and only a manager's refund/forfeit decision may release it.
    await syncVehicleHoldStatus(ctx, args.vehicleId, user._id);
    const current = await ctx.db.get(args.vehicleId);
    if (!current || current.orgId !== args.orgId || current.isDeleted) {
      throw new ConvexError("Vehicle not found in this organization.");
    }

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
            { link: `/${reservation.orgId}/vehicles?highlightId=${reservation.vehicleId}` }
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
    // NaN fails `<= 0`, so it would flow into cost, COGS and profit unchecked.
    // Unlike create/update this path runs no Zod schema at all, so every numeric
    // field here needs an explicit guard — not just the one with a range check.
    assertFiniteNumber(args.sourceCost, "supplier cost");
    assertFiniteNumber(args.sellingPrice, "selling price");
    assertFiniteNumber(args.year, "year");
    assertFiniteNumber(args.mileage, "mileage");
    if (args.sourceCost <= 0) {
      throw new ConvexError("Supplier cost must be greater than zero.");
    }
    // The ranges are lifted from CreateVehicleSchema, the schema the `create`
    // path does run, so the two entry points accept the same numbers. They are
    // deliberately not stricter than it: `sellingPrice: 0` is legal there and
    // means "not priced yet".
    if (args.sellingPrice < 0) {
      throw new ConvexError("Selling price cannot be negative.");
    }
    if (args.mileage < 0) {
      throw new ConvexError("Mileage cannot be negative.");
    }
    if (args.year < 1900 || args.year > 2100) {
      throw new ConvexError("Year must be valid.");
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
    // The guard itself is the point of this call; the row it returns is unused
    // because `deletedBy` below records the Clerk subject, not the users row.
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.DELETE_VEHICLES]);
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
    // Soft-deleted rows are excluded from all three lists below: this is the
    // vehicle's live relations panel, and a deleted sale, lead or expense
    // reappearing there is the same leak `isDeleted` exists to prevent.
    const sales = await ctx.db
      .query("sales")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.and(
        q.eq(q.field("vehicleId"), args.vehicleId),
        q.neq(q.field("isDeleted"), true)
      ))
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
      .filter((q) => q.and(
        q.eq(q.field("vehicleId"), args.vehicleId),
        q.neq(q.field("isDeleted"), true)
      ))
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
      .filter((q) => q.neq(q.field("isDeleted"), true))
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

/**
 * Ceiling on rows per `importBulk` call.
 *
 * Each vehicle insert now also walks and patches the aggregate B-tree, so a row
 * costs several index reads and node writes on top of its own document write.
 * An uncapped array put the whole spreadsheet in one transaction, which puts a
 * large import within reach of Convex's per-transaction limits — and a
 * transaction that trips them rolls the entire import back with an opaque
 * error. The client chunks to this size; the cap is enforced here because the
 * client is never the control.
 */
export const IMPORT_BULK_MAX_ROWS = 200;

/**
 * A much lower ceiling once the batch also POSTS.
 *
 * 200 was sized for a transaction whose per-row cost was an insert plus the
 * aggregate B-tree walk. A PURCHASE row additionally writes an
 * `accountingEvents` row, a `journalEntries` row and its lines, an
 * `incrementAccountSnapshot` read+patch per line, an audit entry, and either a
 * legacy `transactions` row or a `vehicleSupplierPayables` row — roughly an
 * order of magnitude more documents touched, all inside the one transaction.
 *
 * This number is deliberately conservative rather than measured: `convex-test`
 * does not enforce Convex's real per-transaction limits, so a green suite is no
 * evidence at all here (the same trap that let a backfill clear 2,115 tests and
 * fail on its first production call). The cost of being too low is more chunks;
 * the cost of being too high is an opaque rollback of a dealer's whole import.
 * Measuring the real ceiling against a live deployment is follow-up work.
 */
export const IMPORT_BULK_MAX_POSTING_ROWS = PURCHASE_IMPORT_MAX_ROWS;

/**
 * FOR A PURCHASE IMPORT, WHOLE-FILE MUST EQUAL WHOLE-TRANSACTION.
 *
 * This cap is therefore the limit on the FILE, not the size of a chunk. A
 * PURCHASE import is never split: it is one mutation, and a mutation is atomic,
 * so it either records every car and every journal entry or records nothing.
 *
 * That is an architectural rule, not a conservative number. Chunking a
 * money-posting import puts whole-FILE invariants inside per-CHUNK
 * transactions, and two entire classes of defect follow from the mismatch —
 * both measured on this branch before the rule was adopted:
 *
 *  - a duplicate spread ACROSS chunks escapes a per-chunk duplicate check
 *    entirely; the second chunk reads the first chunk's committed VIN as a
 *    legitimate retry and silently skips a car that was genuinely bought;
 *  - a bound evaluated per chunk can be crossed MID-FILE, so an import commits
 *    part of itself into a state where its own retry is refused.
 *
 * Neither is fixable by adding another guard around the protocol, because the
 * guard would still be reasoning about one chunk. Making the file the
 * transaction removes the category. A read-limit failure likewise becomes a
 * clean pre-write refusal instead of "chunk 1 posted money and chunk 2 failed".
 *
 * OPENING_STOCK is unaffected and still chunks at IMPORT_BULK_MAX_ROWS: it
 * posts nothing, so it has no money-shaped invariant to preserve across a
 * boundary.
 *
 * The recovery story is correspondingly simpler and is what the operator is
 * told: if a PURCHASE import fails, nothing was written — fix the rows and
 * import again. Re-importing a file that SUCCEEDED remains idempotent, because
 * identity is the VIN and an already-capitalized car is skipped without
 * reposting.
 */

/**
 * What an import means in accounting terms — the operator states it, the server
 * never guesses.
 *
 * A CSV of owned stock is two completely different economic facts wearing the
 * same shape, and only the person importing knows which one it is:
 *
 * - OPENING_STOCK — cars the dealership already owns, being carried over from a
 *   spreadsheet at cutover. No cash moves today, and the GL entry for them is
 *   the opening balance: either the org's opening-balance journal (which carries
 *   its own Vehicle Inventory line) or the per-vehicle
 *   `accountingMigration.backfillVehicleInventoryOpeningBalances`. So this posts
 *   nothing — byte-identical to what importBulk did before this argument
 *   existed. Posting here as well would double-capitalize every migrated car.
 *
 * - PURCHASE — cars the dealership just bought. These are ordinary acquisitions
 *   and go through the same `postVehicleAcquisitionIfOwned` the single-vehicle
 *   create path uses, so a car bought in a batch is capitalized exactly like a
 *   car added one at a time.
 *
 * There is deliberately no default. Guessing OPENING_STOCK silently recreates
 * SCRUM-59 — imported stock with a purchasePrice but no Dr Vehicle Inventory,
 * which `ruleSaleCompleted` then credits at sale time, driving the asset
 * negative and leaving the balance sheet wrong while the P&L still looks right.
 * Guessing PURCHASE would double-count every cutover migration against the
 * opening balance and invent cash payments that never happened. Both silent
 * choices corrupt the books, so the caller must say which one it is.
 */
export const IMPORT_ACQUISITION_POSTING = ["OPENING_STOCK", "PURCHASE"] as const;
export type ImportAcquisitionPosting = (typeof IMPORT_ACQUISITION_POSTING)[number];

/**
 * The unit of idempotency for a bulk purchase import: ONE SPREADSHEET ROW.
 *
 * Keyed `<importId>:<rowId>` under this operation name, where `importId`
 * identifies the logical import (stable across every call it takes) and `rowId`
 * identifies the row within the operator's original file (stable across
 * retries, and NOT the position within the valid subset — otherwise correcting
 * an earlier row would renumber every row after it and void their evidence).
 */
const IMPORT_ROW_OPERATION = "vehicles.importBulk.row";

/**
 * What must be identical for a re-sent row to be the SAME requested operation.
 *
 * EVERY input that changes what is written, posted, or created — not a summary,
 * and not only the financial fields. A re-sent row whose selling price, status,
 * mileage or valuations differ is a different request wearing a used identifier,
 * and because a proven retry does no work at all, accepting it would discard
 * the operator's change in silence: no write, no error, and a response
 * indistinguishable from an ordinary no-op retry.
 *
 * ⚠️ An earlier revision covered only the money fields, and its own comment
 * claimed it covered everything. `color`, `mileage`, `fuelType`, `transmission`,
 * `sellingPrice`, `status`, `notes` and `valuations` were all persisted and all
 * omitted. If a field is added to the row validator, it belongs here too.
 *
 * Valuations are canonicalized by sort key first, so re-ordering the same
 * columns is not a conflict while changing, adding or removing one is.
 */
async function importRowFingerprint(
  row: {
    vin: string; make: string; model: string; year: number;
    color: string; mileage?: number; fuelType: string; transmission: string;
    sellingPrice: number; status?: string; notes?: string;
    purchasePrice?: number; sourceType?: string; sourcedFromName?: string; sourceCost?: number;
    valuations?: Array<{ companyId?: string; companyName?: string; valuationAmount: number }>;
  },
  paymentMethod: AcquisitionPaymentMethod
): Promise<string> {
  const text = (value: string | undefined) => (value ?? "").trim().toLowerCase();
  const valuations = (row.valuations ?? [])
    .map((v) => ({
      companyId: v.companyId ?? null,
      companyName: text(v.companyName),
      valuationAmount: v.valuationAmount,
    }))
    .sort((a, b) =>
      `${a.companyId}|${a.companyName}|${a.valuationAmount}`.localeCompare(
        `${b.companyId}|${b.companyName}|${b.valuationAmount}`
      )
    );
  return simplePayloadHash({
    vin: row.vin.trim().toUpperCase(),
    make: text(row.make),
    model: text(row.model),
    year: row.year,
    color: text(row.color),
    mileage: row.mileage ?? null,
    fuelType: text(row.fuelType),
    transmission: text(row.transmission),
    sellingPrice: row.sellingPrice,
    status: text(row.status),
    notes: text(row.notes),
    purchasePrice: row.purchasePrice ?? null,
    sourceType: ownershipOf(row),
    sourcedFromName: text(row.sourcedFromName),
    sourceCost: row.sourceCost ?? null,
    paymentMethod,
    valuations,
  });
}

const sameText = (a: string | undefined, b: string | undefined) =>
  (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/**
 * Does this row contradict the vehicle already stored under the same VIN?
 *
 * A CONTRADICTION GUARD, not proof of identity. Make, model and year are all
 * editable on an existing vehicle, so their agreement cannot establish that two
 * rows are the same car — but their DISAGREEMENT does establish that something
 * is wrong, and that is the half worth acting on. A Honda arriving under a VIN
 * stored against a Toyota is not a retry under any reading.
 *
 * Returns a human-readable reason, or null when nothing contradicts.
 */
function vehicleFactsMismatch(
  existing: { make: string; model: string; year: number },
  row: { make: string; model: string; year: number }
): string | null {
  if (!sameText(existing.make, row.make) || !sameText(existing.model, row.model)) {
    return `recorded as ${existing.make} ${existing.model}, this file says ${row.make.trim()} ${row.model.trim()}`;
  }
  if (existing.year !== row.year) {
    return `recorded as a ${existing.year}, this file says ${row.year}`;
  }
  return null;
}

/** SOURCED (drop-ship, the supplier's car) or STOCK (owned). Never undefined. */
const ownershipOf = (row: { sourceType?: string }) =>
  (row.sourceType ?? "").trim().toUpperCase() === "SOURCED" ? "SOURCED" : "STOCK";

/**
 * Does this row contradict how the existing vehicle is OWNED, or on what terms?
 *
 * Separate from `vehicleFactsMismatch` because it is not about which car this
 * is — it is about whose car it is. STOCK and SOURCED are different ownership,
 * a different counterparty and a different sale-accounting basis downstream
 * (principal versus agent), so re-presenting one as the other is never a retry.
 *
 * This runs for rows that post NOTHING as well, which is the point. Such a row
 * changes no journal either way, so an earlier version skipped it — but it is
 * still reported to the operator as "already recorded with matching purchase
 * evidence", and that sentence must not be said about terms nobody compared.
 *
 * Returns a human-readable reason, or null when nothing contradicts.
 */
function ownershipTermsMismatch(
  existing: { sourceType?: string; sourcedFromName?: string; sourceCost?: number },
  row: { sourceType?: string; sourcedFromName?: string; sourceCost?: number; purchasePrice?: number }
): string | null {
  const was = ownershipOf(existing);
  const now = ownershipOf(row);
  if (was !== now) {
    return was === "SOURCED"
      ? "recorded as sourced from a supplier, this file says owned stock"
      : "recorded as owned stock, this file says sourced from a supplier";
  }
  if (now === "STOCK") return null;

  // Both sourced: the supplier and the agreed cost ARE the terms.
  if (!sameText(existing.sourcedFromName, row.sourcedFromName)) {
    return `recorded as sourced from ${existing.sourcedFromName ?? "no one"}, this file says ${row.sourcedFromName?.trim() || "no one"}`;
  }
  const incomingCost = row.sourceCost ?? row.purchasePrice;
  if (existing.sourceCost !== incomingCost) {
    return `recorded at a supplier cost of ${existing.sourceCost}, this file says ${incomingCost}`;
  }
  return null;
}

/**
 * Does the money in this row contradict the acquisition already posted?
 *
 * This is the part of "the same purchase" that a vehicle document cannot answer.
 * Two rows can agree on make, model and year and still be different economic
 * commands — a different price, a different currency, cash instead of supplier
 * credit. Re-presenting any of those under an existing VIN is a CHANGE to
 * recorded financial terms, and silently skipping it records the old terms
 * forever while the operator believes the new ones landed.
 *
 * FAILS CLOSED on missing evidence. A posted acquisition whose payload cannot
 * produce a cost, a currency or a payment method proves exposure but not
 * agreement, and "cannot tell" must never take the permissive branch here.
 *
 * Returns a human-readable reason, or null when everything agrees.
 */
function acquisitionFingerprintMismatch(
  evidence: ProvenAcquisitionEvidence,
  incomingCostMinor: number,
  incomingCurrency: string,
  incomingPaymentMethod: AcquisitionPaymentMethod
): string | null {
  if (evidence.currency === undefined) return "the recorded purchase does not state a currency";
  if (evidence.currency !== incomingCurrency) {
    return `recorded in ${evidence.currency}, this import is in ${incomingCurrency}`;
  }
  if (evidence.costMinor === undefined) return "the recorded purchase does not state a cost";
  if (evidence.costMinor !== incomingCostMinor) {
    return `recorded at ${fromMinorUnits(evidence.costMinor, evidence.currency)}, this file says ${fromMinorUnits(incomingCostMinor, incomingCurrency)}`;
  }
  if (evidence.paymentMethod === undefined) return "the recorded purchase does not state a payment method";
  if (evidence.paymentMethod !== incomingPaymentMethod) {
    return `recorded as paid by ${evidence.paymentMethod}, this import says ${incomingPaymentMethod}`;
  }
  return null;
}

export const importBulk = mutation({
  args: {
    orgId: v.id("organizations"),
    /** See IMPORT_ACQUISITION_POSTING — required, never defaulted. */
    acquisitionPosting: v.union(v.literal("OPENING_STOCK"), v.literal("PURCHASE")),
    /**
     * How the batch was paid for. Required for PURCHASE and ignored for
     * OPENING_STOCK (nothing posts, so nothing is paid). One method for the
     * whole file rather than per row: the spreadsheets dealers actually import
     * have no payment-method column, and inferring one per row from a blank
     * cell is exactly the silent guess this argument exists to prevent.
     */
    purchasePaymentMethod: v.optional(acquisitionPaymentMethodValidator),
    /**
     * Identifies the logical import. REQUIRED for PURCHASE, ignored otherwise.
     *
     * Together with each row's `rowId` this is the ONLY thing that can prove a
     * re-sent row is a retry rather than a second car. Matching facts cannot:
     * two genuinely different vehicles are routinely identical in every recorded
     * field — same model, same price, same filler text in the VIN column — and
     * treating that as proof silently drops the second car and its acquisition.
     */
    importId: v.optional(v.string()),
    vehicles: v.array(v.object({
      /**
       * This row's position in the operator's ORIGINAL file. REQUIRED for
       * PURCHASE, ignored otherwise. Must survive a retry unchanged, so it is
       * the source row number rather than an index into the valid subset.
       */
      rowId: v.optional(v.number()),
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
    const postsAcquisitions = args.acquisitionPosting === "PURCHASE";
    const importId = args.importId?.trim();
    /**
     * Row ids for which DURABLE EVIDENCE says this exact import operation
     * already ran, and the row's facts are unchanged since it did.
     *
     * PURCHASE only. Keyed by `rowId`, not by VIN — the whole point of the
     * redesign is that a VIN, and indeed every other recorded fact, cannot
     * distinguish "this operation ran before" from "a second identical car was
     * bought". Only the (importId, rowId) evidence can.
     */
    const provenRetries = new Set<number>();
    const maxRows = postsAcquisitions ? IMPORT_BULK_MAX_POSTING_ROWS : IMPORT_BULK_MAX_ROWS;
    if (args.vehicles.length > maxRows) {
      throw new ConvexError(
        `Import too large: ${args.vehicles.length} rows in one request (max ${maxRows}). Split the file and import again.`
      );
    }

    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CREATE_VEHICLES]);

    // Bulk import runs no Zod schema, and its two range filters (`sourceCost <= 0`
    // at the SOURCED check, `valuationAmount <= 0` on valuations) are both false
    // for NaN — so NaN passed straight into vehicles and vehicleValuations. Every
    // numeric field is validated up front, before any row is written, so a bad
    // cell fails the whole import rather than half-applying it.
    for (const row of args.vehicles) {
      assertFiniteNumber(row.year, "year");
      assertFiniteNumber(row.sellingPrice, "selling price");
      if (row.mileage !== undefined) assertFiniteNumber(row.mileage, "mileage");
      if (row.purchasePrice !== undefined) assertFiniteNumber(row.purchasePrice, "purchase price");
      if (row.sourceCost !== undefined) assertFiniteNumber(row.sourceCost, "supplier cost");
      for (const val of row.valuations ?? []) {
        assertFiniteNumber(val.valuationAmount, "valuation amount");
      }
    }

    // The same rules vehicles.create enforces for a single acquisition, applied
    // to this batch up front (like the numeric validation above) so a request
    // that can't be posted correctly is rejected before any of it is written
    // rather than half-importing and half-posting.
    //
    // "This batch", not "the whole file": a file larger than the cap arrives as
    // several calls, and each one is its own transaction. The client re-checks
    // these same rules across every row before sending the first chunk, so a
    // bad row late in a large file stops the import instead of being discovered
    // after earlier chunks have already posted.
    if (postsAcquisitions) {
      // A purchase price with no declared payment method would post as CASH —
      // normalizePaymentMethod's default — even when the dealer paid by bank
      // transfer, cheque or card.
      if (!args.purchasePaymentMethod) {
        throw new ConvexError("Payment method is required when importing purchased vehicles.");
      }

      // ── The import must be able to identify ITSELF, and each row within it.
      //
      // Without this the mutation has no way to tell a re-sent file from a
      // second purchase of identical cars, and the only alternative — comparing
      // recorded facts — provably cannot: two different vehicles are routinely
      // identical in every field a spreadsheet carries. Rather than guess, a
      // purchase import states which operation it is.
      if (!importId) {
        throw new ConvexError(
          "This purchase import did not identify itself, so it cannot be safely retried. Nothing was imported. Reload the page and import the file again."
        );
      }
      const missingRowIds = args.vehicles.filter(
        (row) => row.rowId === undefined || !Number.isInteger(row.rowId)
      );
      if (missingRowIds.length > 0) {
        throw new ConvexError(
          `${missingRowIds.length} row(s) in this purchase import carry no row number, so they cannot be safely retried. Nothing was imported. Reload the page and import the file again.`
        );
      }
      // Two rows claiming the same identity would share one evidence record, so
      // the second would read as a retry of the first — the same silent loss,
      // arriving through the key instead of through the VIN.
      const rowIdsSeen = new Set<number>();
      const repeatedRowIds = args.vehicles.filter((row) => {
        if (rowIdsSeen.has(row.rowId!)) return true;
        rowIdsSeen.add(row.rowId!);
        return false;
      });
      if (repeatedRowIds.length > 0) {
        throw new ConvexError(
          `${repeatedRowIds.length} row(s) repeat a row number within this import. Nothing was imported. Reload the page and import the file again.`
        );
      }
      // ── A PURCHASE ACQUISITION MUST CARRY DURABLE PHYSICAL-VEHICLE IDENTITY.
      //
      // TWO DIFFERENT IDENTITIES ARE IN PLAY HERE, and conflating them is what
      // this guard now exists to prevent:
      //
      //   (importId, rowId)  — COMMAND identity. Proves that this exact row of
      //                        this exact import already executed. It owns
      //                        replay safety completely, and needs no VIN.
      //   a real VIN         — VEHICLE identity. The only thing that can
      //                        correlate one physical car ACROSS independent
      //                        acquisition commands.
      //
      // ⚠️ An earlier revision justified this guard by saying "a purchase
      // import's retry safety IS the VIN dedup". That reason is DEAD: row
      // evidence owns same-import retry safety now. The guard survives on a
      // different and stronger invariant.
      //
      // A blank or filler VIN is replaced by generateImportVinPlaceholder(),
      // which is unique to the INSERTION. So the same physical car uploaded
      // tomorrow under a new importId has nothing to correlate against — and
      // that second import is legitimately a different command, so row evidence
      // cannot and should not stop it. The result would be:
      //
      //     first import   → vehicle A + acquisition A
      //     second import  → vehicle B + acquisition B, same physical car
      //
      // one car, capitalized twice, silently. That is precisely the class
      // SCRUM-59 exists to fail closed on.
      //
      // Identity is NOT inferred from make, model, year or price. Those are
      // contradiction and fingerprint evidence; they are not durable identity,
      // and two genuinely different cars agree on all of them routinely.
      //
      // This also keeps bulk import from becoming a WEAKER accounting entry
      // point than the single-vehicle path: `vehicles.create` already refuses a
      // non-sourced vehicle with no VIN, and arriving by CSV should not lower
      // the bar. Applied to EVERY row, not only the ones that post today —
      // a SOURCED or cost-less row converted to owned stock with a price later
      // posts its own VEHICLE_ACQUIRED, and by then the identity is long gone.
      //
      // If AutoFlow ever needs to acquire an owned vehicle before a real VIN
      // exists, that needs an explicit alternative durable-identity design.
      // It is deliberately NOT invented here.
      const missingVin = args.vehicles.filter((row) => isPlaceholderVin(row.vin));
      if (missingVin.length > 0) {
        throw new ConvexError(
          // The alternative is deliberately qualified rather than offered as an
          // equal option: OPENING_STOCK posts nothing, so an operator who takes
          // it for a car they genuinely just bought silently loses the
          // acquisition entry — the very thing SCRUM-59 exists to stop.
          `A VIN is required for every vehicle in a purchase import — ${missingVin.length} row(s) have none. Add the VINs. Import them as stock you already own only if you did not just buy them, because that records no purchase.`
        );
      }

      // ...and it must be plain letters and numbers, so that the durable
      // identity above is a CANONICAL match and not merely an exact one — the
      // same car written with and without punctuation must not read as two
      // vehicles. See hasNonCanonicalVinCharacters for why the remaining
      // equivalence problem belongs to SCRUM-94 rather than to a
      // canonicalization applied only here.
      const malformedVin = args.vehicles.filter((row) => hasNonCanonicalVinCharacters(row.vin));
      if (malformedVin.length > 0) {
        throw new ConvexError(
          `A VIN can only contain letters and numbers — ${malformedVin.length} row(s) have dashes, spaces or punctuation. Remove them. Import these as stock you already own only if you did not just buy them, because that records no purchase.`
        );
      }
      // ── SCRUM-59: what a PURCHASE import refuses, before a single row is
      // written. Each of these is decidable from the file plus an EXACT VIN
      // lookup — the identity rule every writer already uses.
      //
      // ⚠️ Deciding whether a historically stored, differently-WRITTEN VIN is the
      // same physical car is NOT attempted here and must not be added. Three
      // attempts each introduced a new identity defect; SCRUM-94 owns that
      // problem in full, including the residual that an existing punctuated or
      // otherwise differently-encoded VIN will not be matched by this import.
      // That residual is knowingly accepted, not overlooked.

      // Only rows that would actually reach Vehicle Inventory carry the basis
      // ambiguity below. A SOURCED row and a cost-less row post nothing, so an
      // existing VIN there is an ordinary duplicate and is skipped as it always
      // was. Refusing those would break the retry contract, because a retried
      // file legitimately re-presents rows that never posted.
      const wouldCapitalize = (row: { sourceType?: string; purchasePrice?: number }) =>
        (row.sourceType ?? "").trim().toUpperCase() !== "SOURCED" && (row.purchasePrice ?? 0) > 0;

      // (0) A NEGATIVE COST IS NOT A PURCHASE. `assertFiniteNumber` above rejects
      // NaN and Infinity but not sign, and `wouldCapitalize` tests `> 0`, so a
      // negative price slips past BOTH: the row is inserted, nothing posts, and
      // the import reports success having created exactly the uncapitalized
      // inventory row SCRUM-59 exists to prevent.
      const negativeCost = args.vehicles.filter(
        (row) => (row.purchasePrice ?? 0) < 0 || (row.sourceCost ?? 0) < 0
      );
      if (negativeCost.length > 0) {
        throw new ConvexError(
          `${negativeCost.length} row(s) have a negative cost. A purchase cannot cost less than nothing — correct the amounts and import again.`
        );
      }

      // (1) TWO ROWS IN THIS FILE THAT ARE THE SAME CAR. The per-row dedup below
      // reads this mutation's own writes, so the second row silently resolves to
      // the vehicle the first row just inserted and is counted as "skipped" —
      // two purchased cars become one vehicle and ONE acquisition, understating
      // inventory.
      //
      // Reachable with ordinary filler, not just identical VINs: `UNK` and
      // `UNKNOWN` are alphanumeric and are not in `isPlaceholderVin`'s list, so
      // they pass every other guard.
      //
      // Identity here is the EXACT rule every writer already uses —
      // `trim().toUpperCase()` — and deliberately nothing wider. The guards above
      // have already refused any VIN that is not plain `[A-Z0-9]`, so among
      // accepted rows this IS the rule the `by_org_vin` dedup applies. Deciding
      // that two differently-WRITTEN VINs are one car is a different problem and
      // belongs to SCRUM-94; see the note in convex/utils/vin.ts for the three
      // attempts that proved it cannot be done correctly here.
      const firstSeenAt = new Map<string, number>();
      const batchDuplicates: string[] = [];
      args.vehicles.forEach((row, index) => {
        const identity = row.vin.trim().toUpperCase();
        if (!identity) return;
        if (!firstSeenAt.has(identity)) {
          firstSeenAt.set(identity, index);
          return;
        }
        batchDuplicates.push(identity);
      });
      if (batchDuplicates.length > 0) {
        throw new ConvexError(
          `${batchDuplicates.length} row(s) repeat a VIN already used earlier in this file (${batchDuplicates.slice(0, 3).join(", ")}). Each vehicle needs its own VIN — otherwise only the first is recorded and the rest are bought without ever being added. Give every row its real VIN and import again.`
        );
      }

      // (2) THE EXISTING VEHICLE'S BASIS CANNOT BE PROVEN. An exact VIN match is
      // skipped by the loop below, and that is right for a genuine retry: the car
      // is already capitalized and must not post twice.
      //
      // It is NOT right when the existing row arrived as OPENING_STOCK. That row
      // carries no acquisition event, so a later PURCHASE of the same VIN would
      // silently do nothing, and a subsequent sale would credit Vehicle Inventory
      // with no matching debit.
      //
      // The inverse is equally wrong: absence of an event does NOT mean "needs
      // posting". Legitimate opening stock is represented by the org's
      // opening-balance position, and posting here would capitalize it a second
      // time. The two cases are indistinguishable from the row alone, so this
      // FAILS CLOSED and asks a human instead of guessing in either direction.
      if (args.purchasePaymentMethod === "ON_ACCOUNT") {
        // sourcedFromName doubles as the generic "who is this owed to" field
        // here exactly as it does on vehicles.create — the AP-Suppliers credit
        // and the vehicleSupplierPayables row both need a name.
        const missingSupplier = args.vehicles.filter(
          (row) =>
            (row.sourceType ?? "").trim().toUpperCase() !== "SOURCED" &&
            (row.purchasePrice ?? 0) > 0 &&
            !row.sourcedFromName?.trim()
        );
        if (missingSupplier.length > 0) {
          throw new ConvexError(
            `A supplier name is required for every vehicle purchased on account — ${missingSupplier.length} row(s) are missing one.`
          );
        }
      }

      // ── (3) EVERY ROW IS CLASSIFIED BEFORE ANYTHING IS WRITTEN.
      //
      // A PURCHASE import ends in one of two outcomes per row: the car is
      // recorded, or it was ALREADY recorded by a provably identical purchase.
      // Everything this pass cannot place in one of those two throws here,
      // before the first write, and the whole file rolls back.
      //
      // ⚠️ ONE PRE-EXISTING EXCEPTION, stated rather than glossed: an owned
      // STOCK row with no purchase price is still INSERTED and posts nothing,
      // because `postVehicleAcquisitionIfOwned` no-ops without a cost. That is
      // `vehicles.create`'s long-standing behaviour and is not introduced here
      // — `vehicleHasCostBasis` (utils/vehicleCost.ts) stops it corrupting
      // commission and profit downstream. It is a third outcome all the same,
      // and this comment previously claimed there were only ever two. SCRUM-168.
      //
      // ⚠️ The row loop must NOT re-derive this. Every VIN proven here is added
      // to `provenRetries`, and the loop counts `alreadyRecorded` only for a
      // member of that set — an existing VIN that is somehow not in it is an
      // internal error, not a duplicate. An earlier revision asserted that
      // invariant in a comment instead of enforcing it, and the gap was real:
      // a row that took an early `continue` here was still certified below.
      //
      // Why a proof at all, rather than "the VIN matches, so skip it": this mode
      // posts money. `skipped` used to mean both "already bought this car,
      // nothing to do" and "could not record your car", and those are opposite
      // economic outcomes. The second loses a physical vehicle's acquisition
      // entirely and reports it to the operator as a duplicate.
      const orgCurrency = await getOrgCurrency(ctx, args.orgId);
      const unprovenBasis: string[] = [];
      const contradictions: string[] = [];
      const uncreatable: string[] = [];
      const collisions: string[] = [];

      for (const row of args.vehicles) {
        const normalized = row.vin.trim().toUpperCase();

        // ── (a) HAS THIS EXACT ROW OF THIS EXACT IMPORT ALREADY RUN?
        //
        // This is the only question whose answer is proof. It is asked FIRST,
        // and nothing about the database's contents is consulted to answer it.
        // A conflicting fingerprint throws from inside findCommandUnit: the same
        // key with different details is a new request wearing a used identifier,
        // and resolving that in either direction loses something.
        const evidence = await findCommandUnit(ctx, {
          orgId: args.orgId,
          operation: IMPORT_ROW_OPERATION,
          idempotencyKey: `${importId}:${row.rowId}`,
          fingerprint: await importRowFingerprint(row, args.purchasePaymentMethod),
          label: `Row ${row.rowId} (${normalized})`,
        });
        if (evidence) {
          provenRetries.add(row.rowId!);
          continue;
        }

        // ── (b) NO EVIDENCE, so this is a NEW requested operation.
        //
        // From here an existing VIN is a COLLISION, never a retry. It may well
        // be the same physical car — but "may well be" is what this redesign
        // exists to stop being treated as proof on a path that posts money.
        const existing = await ctx.db
          .query("vehicles")
          .withIndex("by_org_vin", (q) => q.eq("orgId", args.orgId).eq("vin", normalized))
          .unique();

        // ── A row with no existing vehicle will be INSERTED. If it cannot be,
        // the FILE is refused rather than the row dropped. The row loop below
        // skips a SOURCED row with no supplier or no cost — correct when an
        // import posts nothing, and a silent loss of a purchased car when it
        // does, reported to the operator as a "duplicate".
        if (!existing) {
          const isSourcedRow = (row.sourceType ?? "").trim().toUpperCase() === "SOURCED";
          const rowCost = row.sourceCost ?? row.purchasePrice;
          if (isSourcedRow && (!row.sourcedFromName?.trim() || rowCost === undefined || rowCost <= 0)) {
            uncreatable.push(normalized);
          }
          continue;
        }

        // ── An exact VIN already here, on an operation that has never run.
        //
        // Whatever this is, it is NOT a proven retry, so it is refused. The
        // checks below only decide HOW TO SAY SO: naming the field that
        // disagrees is far more useful than "this VIN exists", and where
        // everything agrees the message has to be honest that agreement is
        // exactly what cannot settle the question.
        const factsMismatch = vehicleFactsMismatch(existing, row) ?? ownershipTermsMismatch(existing, row);
        if (factsMismatch) {
          contradictions.push(`${normalized}: ${factsMismatch}`);
          continue;
        }

        if (wouldCapitalize(row)) {
          // Proven POSTED evidence only — a REVERSED or dead-lettered FAILED
          // record does not prove this car is capitalized today.
          const acquisition = await provenAcquisitionEvidence(ctx, args.orgId, existing._id);
          if (!acquisition) {
            unprovenBasis.push(normalized);
            continue;
          }
          const moneyMismatch = acquisitionFingerprintMismatch(
            acquisition,
            toMinorUnits(row.purchasePrice!, orgCurrency),
            orgCurrency,
            args.purchasePaymentMethod
          );
          if (moneyMismatch) {
            contradictions.push(`${normalized}: ${moneyMismatch}`);
            continue;
          }
          if (args.purchasePaymentMethod === "ON_ACCOUNT") {
            const payables = await ctx.db
              .query("vehicleSupplierPayables")
              .withIndex("by_vehicle", (q) => q.eq("vehicleId", existing._id))
              .collect();
            const supplier = row.sourcedFromName ?? "";
            if (!payables.some((payable) => sameText(payable.sourcedFromName, supplier))) {
              contradictions.push(
                payables.length === 0
                  ? `${normalized}: recorded on account, but no supplier payable exists to compare against`
                  : `${normalized}: owed to ${payables[0].sourcedFromName}, this file says ${supplier.trim()}`
              );
              continue;
            }
          }
        }

        // Everything recorded agrees — and that is precisely why this cannot be
        // waved through. A second identical car produces the same agreement, so
        // accepting it would silently drop a vehicle that was genuinely bought.
        collisions.push(normalized);
      }

      if (uncreatable.length > 0) {
        throw new ConvexError(
          `${uncreatable.length} sourced row(s) cannot be recorded because they are missing a supplier or a cost (${uncreatable.slice(0, 3).join(", ")}). Nothing was imported. Complete those rows and import again — a purchase import records every row or none of them, so they are never quietly left out.`
        );
      }
      if (contradictions.length > 0) {
        throw new ConvexError(
          `${contradictions.length} row(s) use a VIN that is already here but do not match what was recorded (${contradictions.slice(0, 3).join("; ")}). Nothing was imported. If these are different cars, give them their real VINs. If you are changing what was already recorded, use the vehicle's own edit and correction workflow — an import cannot rewrite a purchase that has already posted.`
        );
      }
      if (collisions.length > 0) {
        throw new ConvexError(
          `${collisions.length} vehicle(s) in this file are already recorded under the same VIN (${collisions.slice(0, 3).join(", ")}), and this import has not been sent before. Nothing was imported. If these are cars you already added, remove those rows. If they are different cars that happen to share a VIN in the sheet, give each its own real VIN — matching details cannot tell the two apart, and guessing would drop a car you actually bought.`
        );
      }
      if (unprovenBasis.length > 0) {
        throw new ConvexError(
          `${unprovenBasis.length} vehicle(s) already exist here with no recorded purchase (${unprovenBasis.slice(0, 3).join(", ")}). They may already be covered by this dealership's opening balance, so importing them as a purchase could count them twice — and skipping them could leave them with no cost at all. Reconcile those vehicles' basis first, then import the rest.`
        );
      }
    }

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
    // ⚠️ `skipped` is OPENING_STOCK's counter and means "an exact VIN was already
    // here". In PURCHASE mode it stays 0 for the whole run: a proven retry is
    // counted as `alreadyRecorded`, and every other reason a row might not be
    // written has already thrown above. One counter carrying both meanings is
    // what let a lost car be announced as a duplicate.
    let skipped = 0;
    let alreadyRecorded = 0;

    for (const row of args.vehicles) {
      // ── A PROVEN RETRY IS FINISHED. Nothing below runs for it.
      //
      // ⚠️ This MUST come before the VIN lookup, and an earlier revision had it
      // nested inside that lookup instead — which meant a proven row whose
      // vehicle had since been renamed was not recognised at all. Reproduced:
      // import a car, correct its VIN through the ordinary edit screen, then let
      // the original call retry. The lookup for the OLD vin found nothing, so
      // the row fell through and inserted a SECOND vehicle, posted a SECOND
      // acquisition, and wrote a SECOND evidence row under the same key — double
      // inventory and cash, plus an evidence table that then throws on every
      // `.unique()` read of that key.
      //
      // Proof of execution is a property of the ROW, not of anything currently
      // in the database. Consulting it through a database lookup made it
      // conditional on state the proof was supposed to make irrelevant.
      if (postsAcquisitions && provenRetries.has(row.rowId!)) {
        alreadyRecorded++;
        continue;
      }

      // Placeholder VINs (xxxxx, N/A, blank, ...) are treated as "no VIN": they
      // must NOT dedupe against each other, or all-but-one stock row is skipped.
      const normalizedVin = isPlaceholderVin(row.vin) ? "" : row.vin.trim().toUpperCase();

      // OPENING_STOCK only: an existing VIN is skipped, and that vehicle's
      // valuations are still refreshed from this import. PURCHASE cannot reach
      // this — a proven retry already left the loop, and any other existing VIN
      // was refused during classification.
      let vehicleId: Id<"vehicles"> | null = null;
      if (normalizedVin) {
        const existing = await ctx.db
          .query("vehicles")
          .withIndex("by_org_vin", (q) => q.eq("orgId", args.orgId).eq("vin", normalizedVin))
          .unique();
        if (existing) {
          // PURCHASE never reaches here: a proven retry left the loop at the
          // top, and every other existing-VIN row was refused before any write.
          // This is OPENING_STOCK's long-standing duplicate handling.
          if (postsAcquisitions) {
            throw new ConvexError(
              `Internal check failed: row ${row.rowId} (${normalizedVin}) reached the writer without proof. Nothing was imported.`
            );
          }
          skipped++;
          vehicleId = existing._id;
        }
      }

      if (!vehicleId) {
        const isSourced = (row.sourceType ?? "").trim().toUpperCase() === "SOURCED";

        // A sourced row without its supplier name + cost can't be created (the
        // same constraint createSourced enforces). For OPENING_STOCK it is
        // skipped rather than thrown — one bad row must not roll back the whole
        // batch's inserts, and nothing of accounting significance is lost.
        //
        // PURCHASE never reaches here: the classification pass refuses the whole
        // file for exactly this row shape, because dropping it means a car that
        // was genuinely bought is never recorded, its acquisition never posts,
        // and the operator is told it was a "duplicate". The assertion is not
        // defensive decoration — it states the invariant that makes the
        // `alreadyRecorded` accounting above sound.
        const sourceCost = row.sourceCost ?? row.purchasePrice;
        if (isSourced && (!row.sourcedFromName?.trim() || sourceCost === undefined || sourceCost <= 0)) {
          if (postsAcquisitions) {
            throw new ConvexError(
              `Internal check failed: a purchase import reached row ${row.vin} without a supplier or cost. Nothing was imported.`
            );
          }
          skipped++;
          continue;
        }

        // Sourced vehicles begin life as SOURCING; owned stock as AVAILABLE.
        const status = normalizeVehicleStatus(row.status) ?? (isSourced ? "SOURCING" : "AVAILABLE");
        assertDirectVehicleCreateStatus(status);

        const insertedVin = normalizedVin || generateImportVinPlaceholder();
        vehicleId = await ctx.db.insert("vehicles", {
          orgId: args.orgId,
          vin: insertedVin,
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

        // Only newly inserted rows post. A duplicate-VIN row resolved to an
        // existing vehicle above must not re-post an acquisition for stock that
        // was already capitalized (postVehicleAcquisitionIfOwned's underlying
        // event is idempotent per vehicle, but re-running it would also insert a
        // second legacy VEHICLE_PURCHASE cash transaction, which is not).
        if (postsAcquisitions) {
          await postVehicleAcquisitionIfOwned(ctx, {
            orgId: args.orgId,
            vehicleId,
            isSourced,
            purchasePrice: isSourced ? sourceCost : row.purchasePrice,
            purchasePaymentMethod: args.purchasePaymentMethod,
            supplierName: row.sourcedFromName?.trim(),
            vehicleLabel: `${row.year} ${row.make.trim()} ${row.model.trim()}`,
            vin: insertedVin,
            actorId: user._id,
          });

          // ⚠️ THE SAME TRANSACTION AS THE WORK IT ATTESTS TO — deliberately,
          // and this ordering is the whole safety argument.
          //
          // A Convex mutation is atomic: if the acquisition above throws, or any
          // later row throws, this insert rolls back with it and the retry
          // correctly sees no evidence. Writing it from a separate mutation, an
          // action or the scheduler would invert the defect this fixes —
          // evidence surviving a posting that failed, so every retry is refused
          // as "already recorded" and the money never reaches the ledger.
          await recordCommandUnit(ctx, {
            orgId: args.orgId,
            operation: IMPORT_ROW_OPERATION,
            idempotencyKey: `${importId}:${row.rowId}`,
            fingerprint: await importRowFingerprint(row, args.purchasePaymentMethod!),
            result: { vehicleId },
            actorId: user._id,
          });
        }
      }

      for (const val of row.valuations ?? []) {
        // Surveyed with the rest of the lenient-skip class and deliberately left
        // alone. This is a sub-record, not a whole row: dropping it loses a
        // finance company's valuation, never a vehicle and never an acquisition,
        // so no money goes unrecorded either way. A blank or zero valuation
        // column is also completely ordinary — most companies have no figure for
        // most cars — so refusing on it would reject nearly every real
        // spreadsheet. An UNREADABLE valuation cell is a different matter and is
        // caught client-side by parseMoneyCell, which marks the row invalid.
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

    return { inserted, skipped, alreadyRecorded, companiesCreated };
  },
});
