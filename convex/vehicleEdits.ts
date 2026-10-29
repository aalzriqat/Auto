import { query } from "./_generated/server";
import { mutation } from "./functions";
import type { MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import { requireTenantAuth } from "./utils/tenancy";
import { assertNoHeldSupplierConcession } from "./utils/supplierConcession";
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
import { assertNoPendingBeforeAvailable } from "./utils/depositCancellationPending";
import { assertVehicleImagesAllowed } from "./utils/storageValidation";
import { acquisitionPaymentMethodValidator, type AcquisitionPaymentMethod } from "./utils/paymentMethods";
import { postVehicleAcquisitionIfOwned, hasVehicleAcquisitionAccountingExposure, throwVehicleCostPosted } from "./vehicles";
import { assertOpeningVehicleBasis } from "./utils/openingVehicleBasis";
import { getOrgCurrency } from "./accounting/workflowHooks";
import { requireActiveBankInCurrency } from "./utils/bankAccountGuards";
import { retroactiveOwnershipChangeRefusal } from "./utils/vehicleOwnership";
import { syncVehicleHoldStatus } from "./utils/depositHelpers";
import { supplierCostRecoveryConversionRefusal } from "./utils/costBearer";
import {
  VEHICLE_OWNERSHIP_FIELD_KEYS,
  assertOnAccountHasCreditor,
  assertVehicleIntake,
  assertVehicleSourceShapeOnUpdate,
  parseVehicleSourceType,
  requestedVehicleSourceTypeChange,
  throwVehicleSourceShape,
} from "./utils/vehicleSourceShape";
import type { SupplierSnapshot } from "./utils/supplierRegistry";
import {
  assertSupplierLinkChangeAllowed,
  refuseUnusedCreditorId,
  resolveCreditorForPosting,
  resolveIntakeSuppliers,
  resolveUpdateSourcedSupplier,
  withServerSupplierNames,
} from "./utils/vehicleSupplierIdentity";

/**
 * SCRUM-717 (D-45): the ownership decision an approver makes when approving a
 * CREATE request that was submitted without one (a WhatsApp intake request has no
 * sourceType). It REPLACES the request's six ownership fields wholesale, so an
 * approver can never be left holding a half-stripped shape.
 */
const ownershipDecisionValidator = v.object({
  sourceType: v.union(v.literal("STOCK"), v.literal("SOURCED")),
  sourcedFromName: v.optional(v.string()),
  sourceCost: v.optional(v.number()),
  purchasePrice: v.optional(v.number()),
  purchasePaymentMethod: v.optional(acquisitionPaymentMethodValidator),
  bankAccountId: v.optional(v.id("bankAccounts")),
  purchaseSupplierName: v.optional(v.string()),
  /** SCRUM-868 P2: the supplier master ids; a name without its id is refused. */
  sourcedSupplierId: v.optional(v.id("suppliers")),
  purchaseSupplierId: v.optional(v.id("suppliers")),
});

function stripOwnershipFields(payload: VehicleEditPayload): VehicleEditPayload {
  const copy: Record<string, unknown> = { ...payload };
  for (const key of VEHICLE_OWNERSHIP_FIELD_KEYS) delete copy[key];
  return copy as VehicleEditPayload;
}

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
  bankAccountId?: Id<"bankAccounts">;
  /** SCRUM-717: the creditor of an owned car bought ON_ACCOUNT; never `sourcedFromName`. */
  purchaseSupplierName?: string;
  /** SCRUM-868 P2: the creditor's supplier master id (the name above is the server snapshot). */
  purchaseSupplierId?: Id<"suppliers">;
  minimumProfit?: number;
  sellingPrice?: number;
  status?: string;
  sourceType?: "STOCK" | "SOURCED";
  sourcedFromName?: string;
  /** SCRUM-868 P2: the consignment supplier's master id (the name above is the server snapshot). */
  sourcedSupplierId?: Id<"suppliers">;
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

async function validateRequestedAcquisitionBank(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  payload: Pick<VehicleEditPayload, "purchasePaymentMethod" | "bankAccountId">
) {
  const bankMethod = payload.purchasePaymentMethod === "BANK_TRANSFER" ||
    payload.purchasePaymentMethod === "CARD" || payload.purchasePaymentMethod === "CHEQUE";
  if (bankMethod) {
    await requireActiveBankInCurrency(ctx, {
      orgId, bankAccountId: payload.bankAccountId,
      currency: await getOrgCurrency(ctx, orgId),
      missingMessage: "Choose the bank account used to purchase this vehicle.",
      currencySubject: "vehicle purchase",
    });
  } else if (payload.bankAccountId) {
    throw new ConvexError("A bank account is only valid for a bank-funded vehicle purchase.");
  }
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
      bankAccountId: v.optional(v.id("bankAccounts")),
      purchaseSupplierName: v.optional(v.string()),
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
    }), // The vehicle creation payload
  },
  handler: async (ctx, args) => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);
    const submittedPayload = normalizeVehicleEditPayload(args.payload);
    if (
      !isSystemOwnerRole(role) &&
      !role.permissions.includes(PERMISSIONS.CREATE_VEHICLES) &&
      !role.permissions.includes(PERMISSIONS.CREATE_VEHICLES_REQUEST)
    ) {
      throw new ConvexError(
        `Forbidden: Missing required permissions: ${PERMISSIONS.CREATE_VEHICLES_REQUEST}`
      );
    }
    // SCRUM-868 P2: the request stores the supplier master ids and the names the SERVER read from the
    // master, so the manager approves what will be recorded, not text the requester typed.
    const payload = withServerSupplierNames(
      submittedPayload,
      await resolveIntakeSuppliers(ctx, args.orgId, submittedPayload),
    );
    assertDirectVehicleCreateStatus(payload.status);
    await assertVehicleImagesAllowed(ctx, payload.imageIds);
    assertValidOwnerCount(payload.ownerCount);

    // SCRUM-717 (D-45): the same explicit, coherent ownership decision
    // `vehicles.create` requires — refused here so it never becomes a request a
    // manager is asked to approve.
    assertVehicleIntake(payload);
    if (payload.sourceType === "STOCK" && (payload.purchasePrice ?? 0) > 0) {
      await validateRequestedAcquisitionBank(ctx, args.orgId, payload);
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
      bankAccountId: v.optional(v.id("bankAccounts")),
      purchaseSupplierName: v.optional(v.string()),
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
    await assertNoPendingBeforeAvailable(ctx, {
      orgId: args.orgId,
      vehicleId: vehicle._id,
      currentStatus: vehicle.status,
      nextStatus: payload.status,
    });
    await assertVehicleImagesAllowed(ctx, payload.imageIds);
    assertValidOwnerCount(payload.ownerCount);

    // Refused at request time as well as at approval, so it never becomes a
    // request a manager can be asked to approve. `resolve` re-checks it too —
    // the car can be sold in between.
    const ownershipRefusal = retroactiveOwnershipChangeRefusal({
      currentSourceType: vehicle.sourceType,
      requestedSourceType: payload.sourceType,
      status: vehicle.status,
    });
    if (ownershipRefusal) throw new ConvexError(ownershipRefusal);
    // SCRUM-389: a SOURCED car with an open supplier-cost recovery cannot become
    // owned stock — the supplier would owe the showroom for costs on a car the
    // showroom now owns, and nothing would ever settle it.
    const recoveryRefusal = await supplierCostRecoveryConversionRefusal(ctx, {
      orgId: vehicle.orgId,
      vehicleId: vehicle._id,
      currentSourceType: vehicle.sourceType,
      requestedSourceType: payload.sourceType,
    });
    if (recoveryRefusal) throw new ConvexError(recoveryRefusal);

    // SCRUM-717 (D-45): an ownership CHANGE (consignment <-> owned) moves money
    // and is never an approval request. It is made directly, by a finance user,
    // from the vehicle's edit screen, where the buy-out terms are required.
    if (requestedVehicleSourceTypeChange(vehicle, payload)) {
      throwVehicleSourceShape("VEHICLE_OWNERSHIP_CHANGE_NOT_REQUESTABLE");
    }
    // SCRUM-868 P2: the consignment supplier this request sets, resolved from the master; the link cannot
    // be swapped once money exists (N11). Both are refused here so they never become an approval request.
    const sourcedSnapshot = await resolveUpdateSourcedSupplier(ctx, args.orgId, vehicle, payload);
    await assertSupplierLinkChangeAllowed(ctx, args.orgId, vehicle, sourcedSnapshot);
    // A supplier/cost edit must still leave the stored type coherent.
    assertVehicleSourceShapeOnUpdate(
      vehicle,
      sourcedSnapshot ? { ...payload, sourcedFromName: sourcedSnapshot.name } : payload,
    );

    // Mirrors vehicles.update's acquisition-posting guard: a SOURCED→STOCK
    // flip (or a purchase price set for the first time) requested here must
    // carry a payment method too, or the manager who approves it has no way
    // to say how it was paid.
    const effectiveSourceTypeForRequest = payload.sourceType ?? vehicle.sourceType;
    const effectivePurchasePriceForRequest = "purchasePrice" in payload ? payload.purchasePrice : vehicle.purchasePrice;
    const mayRequestAffectAcquisition =
      "purchasePrice" in payload || "sourceCost" in payload ||
      (payload.sourceType !== undefined && payload.sourceType !== "SOURCED");
    if (mayRequestAffectAcquisition || payload.sourceType === "SOURCED") {
      const openingBasis = await assertOpeningVehicleBasis(ctx, args.orgId, args.vehicleId);
      if (openingBasis === "POSTED") throw new ConvexError("Opening stock cost and ownership need a separately reviewed correction.");
    }
    const requestPostsAcquisition =
      mayRequestAffectAcquisition &&
      effectiveSourceTypeForRequest !== "SOURCED" &&
      effectivePurchasePriceForRequest != null && effectivePurchasePriceForRequest > 0 &&
      !(await hasVehicleAcquisitionAccountingExposure(ctx, args.orgId, args.vehicleId));
    if (requestPostsAcquisition && !payload.purchasePaymentMethod) {
      throw new ConvexError("Payment method is required to post this vehicle's acquisition cost to accounting.");
    }
    // SCRUM-868 P2: an on-account creditor is the master row's snapshot; an id sent where no acquisition
    // would post is refused rather than dropped.
    let requestCreditor: SupplierSnapshot | undefined;
    if (requestPostsAcquisition) {
      requestCreditor = await resolveCreditorForPosting(ctx, args.orgId, payload);
    } else {
      refuseUnusedCreditorId(payload);
    }
    assertOnAccountHasCreditor(payload.purchasePaymentMethod, requestCreditor?.name ?? payload.purchaseSupplierName);
    if (requestPostsAcquisition) {
      await validateRequestedAcquisitionBank(ctx, args.orgId, payload);
    }

    const filteredPayload: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      // A typed consignment name or id is never copied: the link is written below from the snapshot only.
      if (key === "sourcedFromName" || key === "sourcedSupplierId") continue;
      if (key === "imageIds") {
        const oldImages = JSON.stringify(vehicle.imageIds || []);
        const newImages = JSON.stringify(value || []);
        if (oldImages !== newImages) filteredPayload[key] = value;
      } else {
        const newValue = typeof value === "string" ? value.trim() : value;
        const oldValue = vehicle[key as keyof typeof vehicle];
        
        const normNew = newValue === "" ? undefined : newValue;
        const normOld = oldValue === "" ? undefined : oldValue;
        
        if (normNew !== normOld) filteredPayload[key] = value;
      }
    }

    if (sourcedSnapshot) {
      filteredPayload.sourcedSupplierId = sourcedSnapshot.supplierId;
      filteredPayload.sourcedFromName = sourcedSnapshot.name;
    }
    if (requestCreditor) filteredPayload.purchaseSupplierName = requestCreditor.name;

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
    /** SCRUM-717: the approver's ownership decision for a CREATE request. Refused for UPDATE. */
    ownership: v.optional(ownershipDecisionValidator),
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
    if (args.ownership && request.type !== "CREATE") {
      throwVehicleSourceShape("VEHICLE_OWNERSHIP_CHANGE_NOT_REQUESTABLE");
    }

    // SCRUM-717: the approver's decision only FILLS a missing classification. A
    // request that already names a recognised sourceType carries the requester's
    // explicit, validated ownership; replacing it would be an unrecorded override.
    // Refused before the status patch so nothing is written.
    if (args.ownership && parseVehicleSourceType(request.payload.sourceType) !== null) {
      throwVehicleSourceShape("VEHICLE_OWNERSHIP_ALREADY_CLASSIFIED");
    }
    const appliedOwnership = args.ownership && args.status === "APPROVED" ? args.ownership : null;

    await ctx.db.patch(request._id, {
      status: args.status,
      resolvedBy: user._id,
      resolvedAt: Date.now(),
      // The approval record states the ownership that was actually applied.
      ...(appliedOwnership
        ? { payload: { ...stripOwnershipFields(request.payload as VehicleEditPayload), ...appliedOwnership } }
        : {}),
    });

    if (args.status === "APPROVED") {
      if (request.type === "CREATE") {
        // SCRUM-717 (D-45): the approver's explicit ownership decision, when the
        // request was submitted without one (WhatsApp intake), replaces the
        // request's six ownership fields wholesale. Whatever the request carried
        // is judged by the same intake guard `vehicles.create` applies — a CREATE
        // that names no coherent ownership is refused, never defaulted to STOCK.
        const baseCreatePayload = normalizeVehicleEditPayload(request.payload);
        const submittedPayload: VehicleEditPayload = args.ownership
          ? { ...stripOwnershipFields(baseCreatePayload), ...args.ownership }
          : baseCreatePayload;
        // SCRUM-868 P2: re-resolved AT APPROVAL, in the approver's org. The supplier may have been
        // deactivated or renamed since the request was written, and a request written before this rule
        // (or forged through the table) carries a name with no id: that cannot be approved.
        const resolvedSuppliers = await resolveIntakeSuppliers(ctx, args.orgId, submittedPayload);
        const payload: VehicleEditPayload = withServerSupplierNames(submittedPayload, resolvedSuppliers);
        if (args.ownership) {
          // The approval record states the ownership that was applied, with the server names.
          const applied: Record<string, unknown> = {};
          for (const key of VEHICLE_OWNERSHIP_FIELD_KEYS) {
            if (payload[key] !== undefined) applied[key] = payload[key];
          }
          await ctx.db.patch(request._id, {
            payload: { ...stripOwnershipFields(request.payload as VehicleEditPayload), ...applied },
          });
        }
        assertDirectVehicleCreateStatus(payload.status);
        await assertVehicleImagesAllowed(ctx, payload.imageIds);

        const isSourced = assertVehicleIntake(payload) === "SOURCED";
        // Mirrors vehicles.create: sourced vehicles carry their cost in
        // sourceCost, not purchasePrice, but the vehicle record still stores
        // purchasePrice so downstream reads stay consistent either way.
        const effectivePurchasePrice = isSourced
          ? (payload.sourceCost ?? payload.purchasePrice)
          : payload.purchasePrice;
        const {
          purchasePaymentMethod,
          bankAccountId,
          purchaseSupplierName: _createPurchaseSupplierName,
          purchaseSupplierId: _createPurchaseSupplierId,
          sourcedSupplierId: _createSourcedSupplierId,
          sourcedFromName,
          sourceCost,
          ...vehicleFields
        } = payload;

        const vehicleId = await ctx.db.insert("vehicles", {
          ...(vehicleFields as any),
          // Mirrors vehicles.create: an owned car never carries consignment fields
          // (a whitespace-only name passes the shape guard, so drop them here).
          ...(isSourced
            ? { sourcedFromName, sourceCost, sourcedSupplierId: resolvedSuppliers.sourced?.supplierId }
            : {}),
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
          bankAccountId,
          creditor: resolvedSuppliers.creditor,
          vehicleLabel: `${payload.year ?? ""} ${payload.make ?? ""} ${payload.model ?? ""}`.trim(),
          vin: payload.vin ?? vehicleId.toString(),
          actorId: user._id,
        });
      } else if (request.type === "UPDATE" && request.vehicleId) {
        const previousVehicle = await ctx.db.get(request.vehicleId);
        if (!previousVehicle || previousVehicle.isDeleted || previousVehicle.orgId !== args.orgId) {
          throw new ConvexError("Vehicle not found.");
        }

        const requestedPayload = normalizeVehicleEditPayload(request.payload);
        // SCRUM-868 P2: the consignment link is re-resolved at approval, and re-checked against money that
        // can have appeared since the request was written (N11). A name with no id cannot be approved.
        const resolvedSourced = await resolveUpdateSourcedSupplier(ctx, args.orgId, previousVehicle, requestedPayload);
        await assertSupplierLinkChangeAllowed(ctx, args.orgId, previousVehicle, resolvedSourced);
        const payload: NormalizedVehicleEditPayload = resolvedSourced
          ? { ...requestedPayload, sourcedFromName: resolvedSourced.name, sourcedSupplierId: resolvedSourced.supplierId }
          : requestedPayload;
        assertDirectVehicleStatusTransition(previousVehicle.status, payload.status);
        await assertNoPendingBeforeAvailable(ctx, {
          orgId: args.orgId,
          vehicleId: previousVehicle._id,
          currentStatus: previousVehicle.status,
          nextStatus: payload.status,
        });
        await assertVehicleImagesAllowed(ctx, payload.imageIds);
        // SCRUM-766 PR-C: the same refusal `vehicles.update` makes. A request is approved later,
        // so a supplier concession can have been recorded since it was written; the approval is
        // not a second door around the guard. Only a payload that CHANGES a supplier term counts.
        if (
          (payload.sourceCost !== undefined && payload.sourceCost !== previousVehicle.sourceCost) ||
          // The link moving is the supplier-term change; a master rename seen through an unchanged id is not.
          (resolvedSourced
            ? resolvedSourced.supplierId !== previousVehicle.sourcedSupplierId
            : payload.sourcedFromName !== undefined &&
              payload.sourcedFromName.trim() !== (previousVehicle.sourcedFromName ?? "").trim()) ||
          (payload.sourceType !== undefined && payload.sourceType !== previousVehicle.sourceType)
        ) {
          await assertNoHeldSupplierConcession(ctx, args.orgId, request.vehicleId);
        }
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
        if (mayResolveAffectAcquisition || payload.sourceType === "SOURCED") {
          const openingBasis = await assertOpeningVehicleBasis(ctx, args.orgId, request.vehicleId);
          if (openingBasis === "POSTED") throw new ConvexError("Opening stock cost and ownership need a separately reviewed correction.");
        }
        const resolveAcquisitionAlreadyExposed = mayResolveAffectAcquisition
          ? await hasVehicleAcquisitionAccountingExposure(ctx, args.orgId, request.vehicleId)
          : false;
        if (("purchasePrice" in payload || "sourceCost" in payload) && resolveAcquisitionAlreadyExposed) {
          throwVehicleCostPosted();
        }
        const resolveAcquisitionSourceType = payload.sourceType ?? previousVehicle.sourceType;
        const resolveAcquisitionPurchasePrice = "purchasePrice" in payload ? payload.purchasePrice : previousVehicle.purchasePrice;
        const resolveNeedsAcquisitionPosting =
          mayResolveAffectAcquisition &&
          resolveAcquisitionSourceType !== "SOURCED" &&
          resolveAcquisitionPurchasePrice != null && resolveAcquisitionPurchasePrice > 0 &&
          !resolveAcquisitionAlreadyExposed;

        // The same refusal `vehicles.update` makes. Re-checked HERE rather than
        // only at request time, because the vehicle can be sold in between the
        // request and its approval — and because an approval workflow that can
        // apply a patch the direct mutation refuses is not a workflow, it is a
        // second door.
        const resolveOwnershipRefusal = retroactiveOwnershipChangeRefusal({
          currentSourceType: previousVehicle.sourceType,
          requestedSourceType: payload.sourceType as "STOCK" | "SOURCED" | undefined,
          status: previousVehicle.status,
        });
        if (resolveOwnershipRefusal) throw new ConvexError(resolveOwnershipRefusal);
        // SCRUM-389: re-checked at approval — a recovery can open in between.
        const resolveRecoveryRefusal = await supplierCostRecoveryConversionRefusal(ctx, {
          orgId: previousVehicle.orgId,
          vehicleId: previousVehicle._id,
          currentSourceType: previousVehicle.sourceType,
          requestedSourceType: payload.sourceType as "STOCK" | "SOURCED" | undefined,
        });
        if (resolveRecoveryRefusal) throw new ConvexError(resolveRecoveryRefusal);

        // SCRUM-717 (D-45): re-checked at approval. A request can carry no
        // ownership change at all (a request written before this rule existed, or
        // one forged through the table), and a patch that contradicts the stored
        // shape is refused here exactly as `vehicles.update` refuses it.
        if (requestedVehicleSourceTypeChange(previousVehicle, payload)) {
          throwVehicleSourceShape("VEHICLE_OWNERSHIP_CHANGE_NOT_REQUESTABLE");
        }
        assertVehicleSourceShapeOnUpdate(previousVehicle, payload);
        let resolveCreditor: SupplierSnapshot | undefined;
        if (resolveNeedsAcquisitionPosting) {
          resolveCreditor = await resolveCreditorForPosting(ctx, args.orgId, payload);
          assertOnAccountHasCreditor(payload.purchasePaymentMethod, resolveCreditor?.name);
        } else {
          refuseUnusedCreditorId(payload);
        }

        const {
          purchasePaymentMethod: resolvePurchasePaymentMethod,
          bankAccountId: resolveBankAccountId,
          purchaseSupplierName: _resolvePurchaseSupplierName,
          purchaseSupplierId: _resolvePurchaseSupplierId,
          // The consignment link is written from the re-resolved snapshot only, never from stored text.
          sourcedFromName: _resolveTypedName,
          sourcedSupplierId: _resolveTypedSupplierId,
          ...vehiclePatchFields
        } = payload;
        // Written only when the link moves, so an echo of the stored supplier never rewrites its snapshot.
        if (resolvedSourced && resolvedSourced.supplierId !== previousVehicle.sourcedSupplierId) {
          (vehiclePatchFields as Record<string, unknown>).sourcedFromName = resolvedSourced.name;
          (vehiclePatchFields as Record<string, unknown>).sourcedSupplierId = resolvedSourced.supplierId;
        }

        await ctx.db.patch(request.vehicleId, {
          ...(vehiclePatchFields as any),
          updatedBy: user._id, // Manager who approved it
          updatedAt: Date.now(),
        });

        // SCRUM-700 N1: same hold rule as vehicles.update.
        if (payload.status !== undefined) {
          await syncVehicleHoldStatus(ctx, request.vehicleId, user._id);
        }

        if (resolveNeedsAcquisitionPosting) {
          await postVehicleAcquisitionIfOwned(ctx, {
            orgId: args.orgId,
            vehicleId: request.vehicleId,
            isSourced: false,
            purchasePrice: resolveAcquisitionPurchasePrice,
            purchasePaymentMethod: resolvePurchasePaymentMethod,
            bankAccountId: resolveBankAccountId,
            creditor: resolveCreditor,
            vehicleLabel: `${payload.year ?? previousVehicle.year} ${payload.make ?? previousVehicle.make} ${payload.model ?? previousVehicle.model}`,
            vin: payload.vin ?? previousVehicle.vin ?? "",
            actorId: user._id,
          });
        }

        if (payload.status === "AVAILABLE" && previousVehicle && previousVehicle.status !== "AVAILABLE") {
          const updatedVehicle = await ctx.db.get(request.vehicleId);
          if (updatedVehicle?.status === "AVAILABLE") {
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
      .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
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
