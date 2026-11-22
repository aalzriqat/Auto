import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { getOrgCurrency } from "../accounting/workflowHooks";
import { checkTenantWriteLimit } from "../rateLimit";
import { CreateVehicleSchema } from "../validations/vehicles";
import { assertFiniteNumber } from "./money";
import { getActorName, notifyManagers } from "./notifications";
import { acquisitionPaymentMethodValidator } from "./paymentMethods";
import { PERMISSIONS, isSystemOwnerRole } from "./permissions";
import { assertVehicleImagesAllowed } from "./storageValidation";
import { assertVehicleCostPrecision } from "./supplierPaymentAmounts";
import { snapshotSupplier } from "./supplierRegistry";
import { validateInput } from "./validation";
import { postOwnedVehicleAcquisition } from "./vehicleAcquisition";
import { assertSourcedShape, assertVehicleIntake } from "./vehicleSourceShape";
import { assertDirectVehicleCreateStatus, trustPassportFieldValidators } from "./vehicleStatusGuards";
import { resolveIntakeSuppliers, withServerSupplierNames } from "./vehicleSupplierIdentity";
import { ConvexError, type ObjectType, v } from "convex/values";

export const vehicleStatus = v.union(
  v.literal("AVAILABLE"),
  v.literal("RESERVED"),
  v.literal("SOLD"),
  v.literal("IN_INSPECTION"),
  v.literal("IN_REPAIR"),
  v.literal("ARCHIVED"),
  v.literal("SOURCING")
);

export const vehicleSourceType = v.optional(v.union(v.literal("STOCK"), v.literal("SOURCED")));

export const vehicleCreateFields = {
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
};

type CreateVehicleInput = ObjectType<typeof vehicleCreateFields & typeof trustPassportFieldValidators> & {
  orgId: Id<"organizations">;
  bankAccountId?: Id<"bankAccounts">;
  sourcedSupplierId?: Id<"suppliers">;
  purchaseSupplierId?: Id<"suppliers">;
  purchaseSupplierName?: string;
  idempotencyKey: string;
};

export async function insertDirectVehicle(
  ctx: MutationCtx,
  submitted: CreateVehicleInput,
  user: Doc<"users">,
) {
  // SCRUM-868 P2 resolve-then-normalise: the supplier ids are resolved in the caller's proven org
  // FIRST, and the name fields of `args` become the names the server read from the master. From
  // here on `args` is exactly the shape the guards and the posting code always saw.
  const resolvedSuppliers = await resolveIntakeSuppliers(ctx, submitted.orgId, submitted);
  const args = withServerSupplierNames(submitted, resolvedSuppliers);

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

  // SCRUM-717 (D-45): the ownership decision is explicit and coherent. No
  // default to STOCK; a consignment car carries its supplier and a positive
  // cost; an owned car carries NEITHER (its on-account creditor travels in
  // `purchaseSupplierName`). A contradicting submission is refused, never
  // stripped — and before the first write.
  //
  // For an owned car, `assertVehicleIntake` also requires its purchase terms: a
  // price with no declared payment method would silently post as CASH
  // (normalizePaymentMethod's default) even when the dealer paid otherwise, and
  // an on-account purchase must name its creditor (AP-Suppliers credit and the
  // supplier payable need a name).
  const isSourced = assertVehicleIntake(args) === "SOURCED";
  assertVehicleCostPrecision(args, await getOrgCurrency(ctx, args.orgId));

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
    sourcedSupplierId: isSourced ? resolvedSuppliers.sourced?.supplierId : undefined,
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

  await postOwnedVehicleAcquisition(ctx, {
    orgId: args.orgId,
    vehicleId: id,
    isSourced,
    purchasePrice: effectivePurchasePrice,
    purchasePaymentMethod: args.purchasePaymentMethod,
    bankAccountId: args.bankAccountId,
    creditor: resolvedSuppliers.creditor,
    vehicleLabel: `${args.year} ${args.make.trim()} ${args.model.trim()}`,
    vin: normalizedVin,
    actorId: user._id,
  });

  // `idempotencyKey` is a TRANSPORT concern, not part of the vehicle payload:
  // this spread is persisted into a vehicleEdits row whose schema rejects
  // unknown fields, so leaving it in made every approval-path create fail.
  const { orgId: _, idempotencyKey: __, bankAccountId: ___, ...payloadArgs } = args;
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
}

export const vehicleSourcedCreateFields = {
  make: v.string(),
  model: v.string(),
  year: v.number(),
  trim: v.optional(v.string()),
  color: v.string(),
  mileage: v.number(),
  fuelType: v.string(),
  transmission: v.string(),
  /** SCRUM-868 P2: optional and never trusted. The stored name is the one read from the master row. */
  sourcedFromName: v.optional(v.string()),
};

type CreateSourcedVehicleInput = ObjectType<typeof vehicleSourcedCreateFields> & {
  orgId: Id<"organizations">;
  sourcedSupplierId?: Id<"suppliers">;
  sourceCost: number;
  sellingPrice: number;
  vin?: string;
  notes?: string;
};

export async function insertSourcedVehicle(
  ctx: MutationCtx,
  submitted: CreateSourcedVehicleInput,
  authority: { user: Doc<"users">; role: Doc<"roles"> },
) {
  // Sourcing a vehicle mid-sale needs to write immediately (the salesperson
  // is actively closing a deal), so this accepts CREATE_VEHICLES_REQUEST —
  // the same permission sales already holds for creating/editing normal
  // stock with approval — not just the manager-only direct CREATE_VEHICLES.
  // Every sourced vehicle still gets an APPROVED-status vehicleEdits audit
  // row and a manager notification below, so oversight isn't lost.
  const { user, role } = authority;
  if (
    !isSystemOwnerRole(role) &&
    !role.permissions.includes(PERMISSIONS.CREATE_VEHICLES) &&
    !role.permissions.includes(PERMISSIONS.CREATE_VEHICLES_REQUEST)
  ) {
    throw new ConvexError(
      `Forbidden: Missing required permissions: ${PERMISSIONS.CREATE_VEHICLES_REQUEST}`
    );
  }

  // SCRUM-868 P2: the supplier is the master row's id, resolved in the caller's proven org. Its
  // name here is the server's snapshot, so a client-typed name can never reach the vehicle.
  const supplier = await snapshotSupplier(ctx, submitted.orgId, submitted.sourcedSupplierId);
  const args = { ...submitted, sourcedFromName: supplier.name };

  const vehicleGate = await ctx.runQuery(internal.subscriptions.canAddVehicle, { orgId: args.orgId });
  if (!vehicleGate.allowed) {
    throw new ConvexError(
      `You've reached the ${vehicleGate.limit}-vehicle limit on your current plan. Upgrade to add more vehicles.`
    );
  }

  // NaN fails `<= 0`, so it would flow into cost, COGS and profit unchecked.
  // Unlike create/update this path runs no Zod schema at all, so every numeric
  // field here needs an explicit guard — not just the one with a range check.
  assertFiniteNumber(args.sourceCost, "supplier cost");
  assertFiniteNumber(args.sellingPrice, "selling price");
  assertFiniteNumber(args.year, "year");
  assertFiniteNumber(args.mileage, "mileage");
  // SCRUM-717 (D-45): the shared shape rule — supplier named, cost positive.
  assertSourcedShape(args.sourcedFromName, args.sourceCost);
  assertVehicleCostPrecision(args, await getOrgCurrency(ctx, args.orgId));
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
    sourcedFromName: supplier.name,
    sourcedSupplierId: supplier.supplierId,
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
      sourcedFromName: supplier.name,
      sourcedSupplierId: supplier.supplierId,
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
}

export function vehicleCreateFingerprint(submitted: CreateVehicleInput) {
  return JSON.stringify({
    vin: submitted.vin?.trim() || null,
    make: submitted.make.trim(),
    model: submitted.model.trim(),
    year: submitted.year,
    sourceType: submitted.sourceType,
    purchasePrice: submitted.purchasePrice ?? null,
    sourceCost: submitted.sourceCost ?? null,
    sellingPrice: submitted.sellingPrice,
    purchasePaymentMethod: submitted.purchasePaymentMethod ?? null,
    bankAccountId: submitted.bankAccountId ?? null,
    sourcedSupplierId: submitted.sourcedSupplierId ?? null,
    purchaseSupplierId: submitted.purchaseSupplierId ?? null,
  });
}
