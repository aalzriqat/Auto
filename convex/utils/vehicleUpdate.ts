import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { getOrgCurrency } from "../accounting/workflowHooks";
import { checkTenantWriteLimit } from "../rateLimit";
import { writeAuditLog } from "./auditLog";
import { supplierCostRecoveryConversionRefusal } from "./costBearer";
import { assertNoPendingBeforeAvailable } from "./depositCancellationPending";
import { syncVehicleHoldStatus } from "./depositHelpers";
import { getActorName, notifyManagers } from "./notifications";
import { assertOpeningVehicleBasis } from "./openingVehicleBasis";
import { acquisitionPaymentMethodValidator } from "./paymentMethods";
import { PERMISSIONS } from "./permissions";
import { maybeAutoPostToFacebook, maybeAutoPostToInstagram } from "./socialAutoPost";
import { assertVehicleImagesAllowed } from "./storageValidation";
import { assertNoHeldSupplierConcession } from "./supplierConcession";
import { assertVehicleCostPrecision } from "./supplierPaymentAmounts";
import { type SupplierSnapshot, ownedStoredSupplierId } from "./supplierRegistry";
import {
  hasNonZeroLandedCostItems,
  hasVehicleAcquisitionAccountingExposure,
  hasVehicleLandedCostAccountingExposure,
  postOwnedVehicleAcquisition,
  throwVehicleCostPosted,
} from "./vehicleAcquisition";
import { canReadVehicleCost, editPayloadCarriesCost } from "./vehicleCostVisibility";
import { vehicleSourceType, vehicleStatus } from "./vehicleIntake";
import { retroactiveOwnershipChangeRefusal } from "./vehicleOwnership";
import {
  assertOnAccountHasCreditor,
  assertVehicleSourceShapeOnUpdate,
  ownedPurchaseTermsComplete,
  requestedVehicleSourceTypeChange,
  sourcedCostMirrorPatch,
  throwVehicleSourceShape,
} from "./vehicleSourceShape";
import { assertDirectVehicleStatusTransition, trustPassportFieldValidators } from "./vehicleStatusGuards";
import {
  assertSupplierLinkChangeAllowed,
  refuseUnusedCreditorId,
  resolveCreditorForPosting,
  resolveUpdateSourcedSupplier,
} from "./vehicleSupplierIdentity";
import { ConvexError, type ObjectType, v } from "convex/values";

export const vehicleUpdateFields = {
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
};

type UpdateVehicleInput = ObjectType<typeof vehicleUpdateFields & typeof trustPassportFieldValidators> & {
  orgId: Id<"organizations">;
  vehicleId: Id<"vehicles">;
  bankAccountId?: Id<"bankAccounts">;
  sourcedSupplierId?: Id<"suppliers">;
  purchaseSupplierId?: Id<"suppliers">;
  purchaseSupplierName?: string;
};

export async function planVehicleUpdate(
  ctx: MutationCtx,
  args: UpdateVehicleInput,
  vehicle: Doc<"vehicles">,
  authority: {
    role: Doc<"roles">;
    user: Doc<"users">;
    assertOwnershipChangeAllowed: () => void;
    authorizeBuyout: () => Promise<unknown>;
  },
) {
  const { role, user, assertOwnershipChangeAllowed, authorizeBuyout } = authority;

  // SCRUM-886: a caller who cannot read cost must not submit one. Every later check compares the
  // submitted cost with the stored one (precision, no-change, posted acquisition), so the outcome
  // would confirm a guess. Decided by key presence alone (`editPayloadCarriesCost`; an
  // unclassified key counts as cost), before any comparison. The one exemption is an ownership
  // change by a `manage:finance` holder: a consignment buy-out must carry its purchase terms. The
  // change is detected from the stored and submitted `sourceType` only (both OPEN), never from a
  // client flag, so it reveals nothing about the stored cost.
  if (!canReadVehicleCost(role)) {
    const ownershipChange = requestedVehicleSourceTypeChange(vehicle, args) !== null;
    const financeAuthority = role.permissions.includes(PERMISSIONS.MANAGE_FINANCE);
    const { orgId: _orgId, vehicleId: _vehicleId, ...submitted } = args;
    if (!(ownershipChange && financeAuthority) && editPayloadCarriesCost(submitted)) {
      throwVehicleSourceShape("VEHICLE_COST_EDIT_NEEDS_COST_ACCESS");
    }
  }
  // The limiter writes component state, so refuse ownership changes before it.
  if (requestedVehicleSourceTypeChange(vehicle, args)) {
    assertOwnershipChangeAllowed();
  }
  // SCRUM-868 P2: the consignment supplier this patch sets, resolved from the master in the caller's
  // org (undefined when it sets none). A name without an id is refused here, before any write.
  const sourcedSnapshot = await resolveUpdateSourcedSupplier(ctx, args.orgId, vehicle, args);
  const statusLimit = await checkTenantWriteLimit(ctx, "standardApi", args.orgId);
  if (!statusLimit.ok) {
    throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
  }
  assertDirectVehicleStatusTransition(vehicle.status, args.status);
  await assertNoPendingBeforeAvailable(ctx, {
    orgId: args.orgId,
    vehicleId: vehicle._id,
    currentStatus: vehicle.status,
    nextStatus: args.status,
  });
  await assertVehicleImagesAllowed(ctx, args.imageIds);

  assertVehicleCostPrecision(args, await getOrgCurrency(ctx, args.orgId), vehicle);

  // SCRUM-717 (D-45): the same coherence rule `create` enforces, applied only
  // when this patch CHANGES the type, the supplier or the cost — an existing
  // inconsistent row stays editable for unrelated fields, and a refusal here
  // happens before any write.
  assertVehicleSourceShapeOnUpdate(
    vehicle,
    sourcedSnapshot ? { ...args, sourcedFromName: sourcedSnapshot.name } : args,
  );

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
  // SCRUM-389: a SOURCED car with an open supplier-cost recovery cannot become
  // owned stock — the supplier would owe the showroom for costs on a car the
  // showroom now owns, and nothing would ever settle it.
  const recoveryRefusal = await supplierCostRecoveryConversionRefusal(ctx, {
    orgId: vehicle.orgId,
    vehicleId: vehicle._id,
    currentSourceType: vehicle.sourceType,
    requestedSourceType: args.sourceType,
  });
  if (recoveryRefusal) throw new ConvexError(recoveryRefusal);

  // SCRUM-717 (D-45) ownership flips. They are the two ways a car's ownership
  // changes after intake, and each is decided before any write.
  const changedSourceType = requestedVehicleSourceTypeChange(vehicle, args);
  // Computed at most once: a STOCK -> SOURCED flip and the acquisition guard
  // below both need it.
  let acquisitionExposure: boolean | undefined;
  const getAcquisitionExposure = async () =>
    (acquisitionExposure ??= await hasVehicleAcquisitionAccountingExposure(ctx, args.orgId, args.vehicleId));
  // STOCK -> SOURCED: once the purchase is posted OR queued, declaring the car
  // consigned would orphan the VEHICLE_ACQUIRED entry (inventory and cash/AP for
  // a car the dealership then claims it never bought). A genuine mistake is an
  // audited reversal or cost correction, not a flip.
  if (changedSourceType === "SOURCED" && (await getAcquisitionExposure())) {
    throwVehicleSourceShape("VEHICLE_OWNERSHIP_FLIP_POSTED");
  }
  // The same orphaning applies to a posted or queued landed-cost capitalization,
  // which debits Vehicle Inventory with or without any acquisition.
  if (changedSourceType === "SOURCED" && (await hasVehicleLandedCostAccountingExposure(ctx, args.orgId, args.vehicleId))) {
    throwVehicleSourceShape("VEHICLE_OWNERSHIP_FLIP_LANDED_COSTS");
  }
  // SOURCED -> STOCK is a buy-out: it capitalizes inventory and moves money or
  // opens a payable, so it needs finance authority and the NEGOTIATED amount and
  // settlement stated in this very patch — never the mirrored consignment cost.
  if (changedSourceType === "STOCK") {
    await authorizeBuyout();
    if (!ownedPurchaseTermsComplete(args)) throwVehicleSourceShape("VEHICLE_BUYOUT_TERMS_REQUIRED");
    // Landed costs entered against a consignment car are informational and never
    // capitalized; bought out afterwards they would be unbooked inventory cost
    // (and offsetting items hide behind a zero total). Refused before any write.
    if (await hasNonZeroLandedCostItems(ctx, args.orgId, args.vehicleId)) {
      throwVehicleSourceShape("VEHICLE_BUYOUT_SOURCED_LANDED_COSTS");
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

  // purchasePaymentMethod and purchaseSupplierName are transient inputs for the
  // acquisition posting below, not persisted vehicle fields — exclude them from
  // the patch.
  //
  // SCRUM-868 P2: the supplier ids and the typed consignment name are excluded as well. A typed name
  // is never persisted: the consignment link (id + the master's name) is written below from the
  // server-resolved snapshot only, and the creditor id is as transient as the creditor name.
  const {
    orgId: _, vehicleId: __, purchasePaymentMethod: ___, purchaseSupplierName: ____, bankAccountId: _____,
    purchaseSupplierId: ______, sourcedSupplierId: _______, sourcedFromName: ________, ...updates
  } = args;
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      const newValue = key === "vin" ? (value as string).trim().toUpperCase()
        : key === "make" || key === "model" || key === "color" || key === "sourcedFromName"
          ? (value as string).trim()
          : value;
      // A blank supplier name is no claim at all: never persist it (on an owned
      // car it would be residue; on a consignment car the shape guard already
      // refused it above).
      if (key === "sourcedFromName" && newValue === "") continue;

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

  // SCRUM-868 P2: the consignment supplier link (N3: the name is the server's snapshot; N11: it cannot
  // be swapped once money exists against the vehicle). Refused before any write.
  if (sourcedSnapshot) {
    // This is the one door that can give a consignment car with money its FIRST supplier link: it passes
    // the caller's role (manage:finance is checked inside, next to the proof of the picked supplier).
    // The edit-request doors in vehicleEdits.ts pass no role and can never take that exception.
    const firstLinkProof = await assertSupplierLinkChangeAllowed(ctx, args.orgId, vehicle, sourcedSnapshot, { role });
    if (firstLinkProof) {
      await writeAuditLog(ctx, user, {
        action: "vehicle.supplierFirstLink",
        targetTable: "vehicles",
        targetId: vehicle._id,
        orgId: args.orgId,
        before: { sourcedSupplierId: null, sourcedFromName: vehicle.sourcedFromName ?? null },
        after: {
          sourcedSupplierId: sourcedSnapshot.supplierId,
          sourcedFromName: sourcedSnapshot.name,
          nameMatchedOn: firstLinkProof.nameMatchedOn,
          rowsChecked: firstLinkProof.rowsChecked,
        },
      });
    }
    // Written only when the link actually moves. Re-sending the supplier the vehicle already has changes
    // nothing: the stored name stays the snapshot taken when the link was made (N3), and the "supplier
    // terms changed" guard below does not fire on an echo.
    if (vehicle.sourcedSupplierId !== sourcedSnapshot.supplierId) {
      patch.sourcedSupplierId = sourcedSnapshot.supplierId;
      patch.sourcedFromName = sourcedSnapshot.name;
    }
  }

  // SCRUM-907: derive the mirror before the existing locks and edit audit.
  Object.assign(patch, sourcedCostMirrorPatch(vehicle, args));

  // SCRUM-766 PR-C: the supplier terms (cost, supplier, type) are what an open deal's supplier
  // concession was agreed against. `patch` holds only the keys whose value actually changes, so
  // this fires on a real change. Refused up front with the reason; completion revalidates
  // regardless, so a direct write that bypasses this still cannot close the deal on stale terms.
  if ("sourceCost" in patch || "sourcedFromName" in patch || "sourceType" in patch) {
    await assertNoHeldSupplierConcession(ctx, args.orgId, args.vehicleId);
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
  if (mayAffectAcquisition || changedSourceType === "SOURCED") {
    const openingBasis = await assertOpeningVehicleBasis(ctx, args.orgId, args.vehicleId);
    if (openingBasis === "POSTED") {
      throw new ConvexError("Opening stock cost and ownership need a separately reviewed correction.");
    }
  }
  const acquisitionAlreadyExposed = mayAffectAcquisition ? await getAcquisitionExposure() : false;

  if (("purchasePrice" in patch || "sourceCost" in patch) && acquisitionAlreadyExposed) {
    throwVehicleCostPosted();
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
  // SCRUM-868 P2: the creditor of an on-account acquisition is the master row's snapshot. A creditor id
  // sent on a write that posts no acquisition would be silently dropped, so it is refused instead.
  let creditor: SupplierSnapshot | undefined;
  if (needsAcquisitionPosting) {
    creditor = await resolveCreditorForPosting(ctx, args.orgId, args);
    assertOnAccountHasCreditor(args.purchasePaymentMethod, creditor?.name);
  } else {
    refuseUnusedCreditorId(args);
  }
  return { patch, needsAcquisitionPosting, acquisitionPurchasePrice, creditor };
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

export async function recordVehicleUpdate(
  ctx: MutationCtx,
  args: UpdateVehicleInput,
  vehicle: Doc<"vehicles">,
  actorId: Id<"users">,
  patch: Record<string, unknown>,
) {
  if (typeof patch.sellingPrice === "number") {
    await insertPriceHistory(ctx, args.orgId, args.vehicleId, vehicle.sellingPrice, patch.sellingPrice, actorId);
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
      supplierId: await ownedStoredSupplierId(ctx, args.orgId, vehicle.sourcedSupplierId),
      supplierEntitlementAtConversion: vehicle.sourceCost,
      purchaseAmount:
        "purchasePrice" in patch ? (patch.purchasePrice as number) : vehicle.purchasePrice,
      purchaseDate: Date.now(),
      paymentMethod: args.purchasePaymentMethod,
      convertedBy: actorId,
      convertedAt: Date.now(),
    });
  }

  await ctx.db.insert("vehicleEdits", {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    requestedBy: actorId,
    type: "UPDATE",
    payload: patch,
    status: "APPROVED",
    resolvedBy: actorId,
    resolvedAt: Date.now(),
    createdAt: Date.now(),
  });

  patch.updatedBy = actorId;
  patch.updatedAt = Date.now();
  // A buy-out ends the consignment: its supplier and entitlement now live only
  // in the conversion snapshot written above. Setting them to undefined removes
  // the fields, so an owned car never keeps consignment residue.
  if (previousSourceType === "SOURCED" && nextSourceType === "STOCK") {
    patch.sourcedFromName = undefined;
    patch.sourcedSupplierId = undefined;
    patch.sourceCost = undefined;
  }
}

export async function finishVehicleUpdate(
  ctx: MutationCtx,
  args: UpdateVehicleInput,
  vehicle: Doc<"vehicles">,
  actorId: Id<"users">,
  plan: Awaited<ReturnType<typeof planVehicleUpdate>>,
) {
  const { patch, needsAcquisitionPosting, acquisitionPurchasePrice, creditor } = plan;

  // SCRUM-700 N1: a status written here must still honour a live
  // reservation or deposit hold, or a held car is advertised AVAILABLE.
  if (patch.status !== undefined) {
    await syncVehicleHoldStatus(ctx, args.vehicleId, actorId);
  }

  if (needsAcquisitionPosting) {
    await postOwnedVehicleAcquisition(ctx, {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      isSourced: false,
      purchasePrice: acquisitionPurchasePrice,
      purchasePaymentMethod: args.purchasePaymentMethod,
      bankAccountId: args.bankAccountId,
      creditor,
      vehicleLabel: `${(patch.year as number | undefined) ?? vehicle.year} ${(patch.make as string | undefined) ?? vehicle.make} ${(patch.model as string | undefined) ?? vehicle.model}`,
      vin: ((patch.vin as string | undefined) ?? vehicle.vin) || "",
      actorId: actorId,
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

  const finalVehicle = patch.status === "AVAILABLE" ? await ctx.db.get(args.vehicleId) : null;
  if (finalVehicle?.status === "AVAILABLE" && vehicle.status !== "AVAILABLE") {
    const updatedVehicle = finalVehicle;
    await maybeAutoPostToInstagram(ctx, {
      orgId: args.orgId,
      vehicle: updatedVehicle,
      triggeredByUserId: actorId,
    });
    await maybeAutoPostToFacebook(ctx, {
      orgId: args.orgId,
      vehicle: updatedVehicle,
      triggeredByUserId: actorId,
    });
  }
}
