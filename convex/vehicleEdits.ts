import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { ConvexError } from "convex/values";
import { maybeAutoPostToInstagram, maybeAutoPostToFacebook } from "./utils/socialAutoPost";
import { Id } from "./_generated/dataModel";
import {
  assertDirectVehicleCreateStatus,
  assertDirectVehicleStatusTransition,
  normalizeVehicleStatus,
  trustPassportFieldValidators,
  type VehicleLifecycleStatus,
} from "./utils/vehicleStatusGuards";
import { assertVehicleImagesAllowed } from "./utils/storageValidation";
import { acquisitionPaymentMethodValidator, type AcquisitionPaymentMethod } from "./utils/paymentMethods";
import { postVehicleAcquisitionIfOwned, hasVehicleAcquisitionAccountingExposure } from "./vehicles";

type VehicleEditPayload = {
  vin?: string;
  make?: string;
  model?: string;
  year?: number;
  trim?: string;
  mileage?: number;
  color?: string;
  fuelType?: string;
  transmission?: string;
  purchasePrice?: number;
  purchasePaymentMethod?: AcquisitionPaymentMethod;
  minimumProfit?: number;
  sellingPrice?: number;
  status?: string;
  sourceType?: "STOCK" | "SOURCED";
  sourcedFromName?: string;
  sourceCost?: number;
  notes?: string;
  imageIds?: Id<"_storage">[];
  inspectionStatus?: "NONE" | "SELF_REPORTED";
  accidentDisclosed?: boolean;
  ownerCount?: number;
  dealerGuarantee?: boolean;
};

type NormalizedVehicleEditPayload = Omit<VehicleEditPayload, "status"> & {
  status?: VehicleLifecycleStatus;
};

function normalizeVehicleEditPayload(payload: VehicleEditPayload): NormalizedVehicleEditPayload {
  const normalizedStatus = normalizeVehicleStatus(payload.status);
  const { status: _status, ...rest } = payload;
  if (!normalizedStatus) return rest;
  return { ...rest, status: normalizedStatus };
}

// The direct vehicles.create/update mutations reject a non-integer or
// negative ownerCount via CreateVehicleSchema/UpdateVehicleSchema's zod
// validation; this request/approval path bypasses that schema entirely, so
// an approved request could otherwise persist invalid data straight onto
// the vehicle.
function assertValidOwnerCount(ownerCount: number | undefined) {
  if (ownerCount === undefined) return;
  if (!Number.isInteger(ownerCount) || ownerCount < 0) {
    throw new ConvexError("Owner count must be a non-negative integer.");
  }
}

export const requestCreate = mutation({
  args: {
    orgId: v.id("organizations"),
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
    }), // The vehicle creation payload
  },
  handler: async (ctx, args) => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    const payload = normalizeVehicleEditPayload(args.payload);
    if (
      !isSystemOwnerRole(role) &&
      !role.permissions.includes(PERMISSIONS.CREATE_VEHICLES) &&
      !role.permissions.includes(PERMISSIONS.CREATE_VEHICLES_REQUEST)
    ) {
      throw new ConvexError(
        `Forbidden: Missing required permissions: ${PERMISSIONS.CREATE_VEHICLES_REQUEST}`
      );
    }
    assertDirectVehicleCreateStatus(payload.status);
    await assertVehicleImagesAllowed(ctx, payload.imageIds);
    assertValidOwnerCount(payload.ownerCount);

    if (payload.sourceType === "SOURCED") {
      if (!payload.sourcedFromName?.trim()) {
        throw new ConvexError("Sourced vehicles require a supplier dealer name.");
      }
      if (payload.sourceCost === undefined || payload.sourceCost === null) {
        throw new ConvexError("Sourced vehicles require a supplier cost.");
      }
    }

    if (
      payload.sourceType !== "SOURCED" &&
      payload.purchasePrice != null &&
      payload.purchasePrice > 0 &&
      !payload.purchasePaymentMethod
    ) {
      throw new ConvexError("Payment method is required when a purchase price is entered.");
    }
    if (
      payload.sourceType !== "SOURCED" &&
      payload.purchasePaymentMethod === "ON_ACCOUNT" &&
      !payload.sourcedFromName?.trim()
    ) {
      throw new ConvexError("A supplier name (sourcedFromName) is required for a vehicle purchased on account.");
    }

    const requestId = await ctx.db.insert("vehicleEdits", {
      orgId: args.orgId,
      requestedBy: user._id,
      type: "CREATE",
      payload,
      status: "PENDING",
      createdAt: Date.now(),
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "vehicle.create_requested",
      { actorName, vehicleLabel: `${payload.year} ${payload.make} ${payload.model}` },
      { link: `/${args.orgId}/vehicles?approvals=true` }
    );

    return requestId;
  },
});

export const requestUpdate = mutation({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
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
    }), // The vehicle update payload (patch)
  },
  handler: async (ctx, args) => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    if (
      !isSystemOwnerRole(role) &&
      !role.permissions.includes(PERMISSIONS.EDIT_VEHICLES) &&
      !role.permissions.includes(PERMISSIONS.EDIT_VEHICLES_REQUEST)
    ) {
      throw new ConvexError(
        `Forbidden: Missing required permissions: ${PERMISSIONS.EDIT_VEHICLES_REQUEST}`
      );
    }

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found.");
    }
    const payload = normalizeVehicleEditPayload(args.payload);
    assertDirectVehicleStatusTransition(vehicle.status, payload.status);
    await assertVehicleImagesAllowed(ctx, payload.imageIds);
    assertValidOwnerCount(payload.ownerCount);

    // Mirrors vehicles.update's acquisition-posting guard: a SOURCED→STOCK
    // flip (or a purchase price set for the first time) requested here must
    // carry a payment method too, or the manager who approves it has no way
    // to say how it was paid.
    const effectiveSourceTypeForRequest = payload.sourceType ?? vehicle.sourceType;
    const effectivePurchasePriceForRequest = "purchasePrice" in payload ? payload.purchasePrice : vehicle.purchasePrice;
    const mayRequestAffectAcquisition =
      "purchasePrice" in payload || "sourceCost" in payload ||
      (payload.sourceType !== undefined && payload.sourceType !== "SOURCED");
    if (
      mayRequestAffectAcquisition &&
      effectiveSourceTypeForRequest !== "SOURCED" &&
      effectivePurchasePriceForRequest != null && effectivePurchasePriceForRequest > 0 &&
      !(await hasVehicleAcquisitionAccountingExposure(ctx, args.orgId, args.vehicleId)) &&
      !payload.purchasePaymentMethod
    ) {
      throw new ConvexError("Payment method is required to post this vehicle's acquisition cost to accounting.");
    }
    if (
      payload.purchasePaymentMethod === "ON_ACCOUNT" &&
      !(payload.sourcedFromName ?? vehicle.sourcedFromName)?.trim()
    ) {
      throw new ConvexError("A supplier name (sourcedFromName) is required for a vehicle purchased on account.");
    }

    const filteredPayload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (key === "imageIds") {
        const oldImages = JSON.stringify(vehicle.imageIds || []);
        const newImages = JSON.stringify(value || []);
        if (oldImages !== newImages) filteredPayload[key] = value;
      } else {
        const newValue = typeof value === "string" ? value.trim() : value;
        const oldValue = vehicle[key as keyof typeof vehicle];
        
        const normNew = newValue === "" ? undefined : newValue;
        const normOld = oldValue === "" ? undefined : oldValue;
        
        if (normNew !== normOld) {
          filteredPayload[key] = value;
        }
      }
    }

    if (Object.keys(filteredPayload).length === 0) {
      throw new ConvexError("No changes detected.");
    }

    const requestId = await ctx.db.insert("vehicleEdits", {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      requestedBy: user._id,
      type: "UPDATE",
      payload: filteredPayload,
      status: "PENDING",
      createdAt: Date.now(),
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "vehicle.update_requested",
      { actorName, vehicleLabel: `${vehicle.year} ${vehicle.make} ${vehicle.model}` },
      { link: `/${args.orgId}/vehicles?approvals=true` }
    );

    return requestId;
  },
});

export const listPending = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    const requests = await ctx.db
      .query("vehicleEdits")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING"))
      .order("desc")
      .collect();

    // Enrich with user and vehicle info
    return Promise.all(
      requests.map(async (req) => {
        const user = await ctx.db.get(req.requestedBy);
        const vehicle = req.vehicleId ? await ctx.db.get(req.vehicleId) : null;
        return {
          ...req,
          user: user ? { name: user.name || "Unknown", email: user.email } : null,
          vehicle,
        };
      })
    );
  },
});

export const resolve = mutation({
  args: {
    orgId: v.id("organizations"),
    requestId: v.id("vehicleEdits"),
    status: v.union(v.literal("APPROVED"), v.literal("REJECTED")),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.EDIT_VEHICLES]);

    const request = await ctx.db.get(args.requestId);
    if (!request || request.orgId !== args.orgId) {
      throw new ConvexError("Request not found.");
    }

    if (request.status !== "PENDING") {
      throw new ConvexError("Request is already resolved.");
    }

    await ctx.db.patch(request._id, {
      status: args.status,
      resolvedBy: user._id,
      resolvedAt: Date.now(),
    });

    if (args.status === "APPROVED") {
      if (request.type === "CREATE") {
        const payload = normalizeVehicleEditPayload(request.payload);
        assertDirectVehicleCreateStatus(payload.status);
        await assertVehicleImagesAllowed(ctx, payload.imageIds);

        const isSourced = payload.sourceType === "SOURCED";
        // Mirrors vehicles.create: sourced vehicles carry their cost in
        // sourceCost, not purchasePrice, but the vehicle record still stores
        // purchasePrice so downstream reads stay consistent either way.
        const effectivePurchasePrice = isSourced
          ? (payload.sourceCost ?? payload.purchasePrice)
          : payload.purchasePrice;
        const { purchasePaymentMethod, ...vehicleFields } = payload;

        const vehicleId = await ctx.db.insert("vehicles", {
          ...(vehicleFields as any),
          purchasePrice: effectivePurchasePrice,
          orgId: args.orgId,
          addedBy: request.requestedBy,
          updatedBy: user._id, // Manager who approved it
          updatedAt: Date.now(),
        });

        await postVehicleAcquisitionIfOwned(ctx, {
          orgId: args.orgId,
          vehicleId,
          isSourced,
          purchasePrice: effectivePurchasePrice,
          purchasePaymentMethod,
          supplierName: payload.sourcedFromName,
          vehicleLabel: `${payload.year ?? ""} ${payload.make ?? ""} ${payload.model ?? ""}`.trim(),
          vin: payload.vin ?? vehicleId.toString(),
          actorId: user._id,
        });
      } else if (request.type === "UPDATE" && request.vehicleId) {
        const previousVehicle = await ctx.db.get(request.vehicleId);
        if (!previousVehicle || previousVehicle.isDeleted || previousVehicle.orgId !== args.orgId) {
          throw new ConvexError("Vehicle not found.");
        }

        const payload = normalizeVehicleEditPayload(request.payload);
        assertDirectVehicleStatusTransition(previousVehicle.status, payload.status);
        await assertVehicleImagesAllowed(ctx, payload.imageIds);
        if (
          typeof payload.sellingPrice === "number" &&
          payload.sellingPrice !== previousVehicle.sellingPrice
        ) {
          await ctx.db.insert("vehiclePriceHistory", {
            orgId: args.orgId,
            vehicleId: request.vehicleId,
            oldPrice: previousVehicle.sellingPrice,
            newPrice: payload.sellingPrice,
            changedBy: user._id,
            changedAt: Date.now(),
          });
        }

        // Mirrors vehicles.update's two acquisition-accounting guards, missing
        // here entirely before: (1) purchasePrice/sourceCost can't be silently
        // edited once the acquisition has already posted, (2) a SOURCED→STOCK
        // flip (or a purchase price set here for the first time) must actually
        // post VEHICLE_ACQUIRED, not just patch the vehicle row.
        const mayResolveAffectAcquisition =
          "purchasePrice" in payload || "sourceCost" in payload ||
          (payload.sourceType !== undefined && payload.sourceType !== "SOURCED");
        const resolveAcquisitionAlreadyExposed = mayResolveAffectAcquisition
          ? await hasVehicleAcquisitionAccountingExposure(ctx, args.orgId, request.vehicleId)
          : false;
        if (("purchasePrice" in payload || "sourceCost" in payload) && resolveAcquisitionAlreadyExposed) {
          throw new ConvexError(
            "This vehicle's acquisition cost has already been posted to accounting. Use a correction journal entry instead of editing purchasePrice/sourceCost directly."
          );
        }
        const resolveAcquisitionSourceType = payload.sourceType ?? previousVehicle.sourceType;
        const resolveAcquisitionPurchasePrice = "purchasePrice" in payload ? payload.purchasePrice : previousVehicle.purchasePrice;
        const resolveNeedsAcquisitionPosting =
          mayResolveAffectAcquisition &&
          resolveAcquisitionSourceType !== "SOURCED" &&
          resolveAcquisitionPurchasePrice != null && resolveAcquisitionPurchasePrice > 0 &&
          !resolveAcquisitionAlreadyExposed;

        const { purchasePaymentMethod: resolvePurchasePaymentMethod, ...vehiclePatchFields } = payload;

        await ctx.db.patch(request.vehicleId, {
          ...(vehiclePatchFields as any),
          updatedBy: user._id, // Manager who approved it
          updatedAt: Date.now(),
        });

        if (resolveNeedsAcquisitionPosting) {
          await postVehicleAcquisitionIfOwned(ctx, {
            orgId: args.orgId,
            vehicleId: request.vehicleId,
            isSourced: false,
            purchasePrice: resolveAcquisitionPurchasePrice,
            purchasePaymentMethod: resolvePurchasePaymentMethod,
            supplierName: payload.sourcedFromName ?? previousVehicle.sourcedFromName,
            vehicleLabel: `${payload.year ?? previousVehicle.year} ${payload.make ?? previousVehicle.make} ${payload.model ?? previousVehicle.model}`,
            vin: payload.vin ?? previousVehicle.vin ?? "",
            actorId: user._id,
          });
        }

        if (payload.status === "AVAILABLE" && previousVehicle && previousVehicle.status !== "AVAILABLE") {
          const updatedVehicle = await ctx.db.get(request.vehicleId);
          if (updatedVehicle) {
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
      }
    }
  },
});

export const getHistory = query({
  args: { 
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles") 
  },
  handler: async (ctx, args) => {
    // We allow anyone in the org to view history
    await requireTenantAuth(ctx, args.orgId);

    const edits = await ctx.db
      .query("vehicleEdits")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .filter((q) => q.eq(q.field("vehicleId"), args.vehicleId))
      .order("desc")
      .collect();

    // Enrich with user names
    return Promise.all(
      edits.map(async (edit) => {
        const requestedBy = await ctx.db.get(edit.requestedBy);
        const resolvedBy = edit.resolvedBy ? await ctx.db.get(edit.resolvedBy) : null;
        
        return {
          ...edit,
          requestedByName: requestedBy?.name || "Unknown",
          resolvedByName: resolvedBy?.name,
        };
      })
    );
  },
});
