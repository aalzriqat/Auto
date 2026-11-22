import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { COMMITMENT_MESSAGES, assertVehicleNotCommitted } from "../commitments";
import { checkTenantWriteLimit } from "../rateLimit";
import { assertNoPendingBeforeAvailable } from "./depositCancellationPending";
import { syncVehicleHoldStatus } from "./depositHelpers";
import { getActorName, notifyManagers } from "./notifications";
import { VEHICLE_IMAGE_CONTENT_TYPES } from "./storageValidation";
import { ConvexError } from "convex/values";

export async function createVehicleUploadUrl(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; mimeType: string; sizeInBytes: number },
) {

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
}

export async function assertVehicleDeletionAllowed(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; vehicleId: Id<"vehicles"> },
  vehicle: Doc<"vehicles">,
) {
  if (vehicle.status === "SOLD" || vehicle.status === "RESERVED") {
    throw new ConvexError(
      `Cannot delete a vehicle with status "${vehicle.status}". Archive it first.`
    );
  }

  // SCRUM-195 M3. THE STATUS CHECK ABOVE IS NOT ENOUGH.
  //
  // A finance-only commitment leaves the vehicle AVAILABLE — `hasHold` counts
  // deposits and reservations, not applications — so a car with a live
  // in-flight application sails past that guard. Deleting it strands the root
  // where no door can reach it: the car is gone from every listing, so nobody
  // can navigate to the deal to end it properly.
  await assertVehicleNotCommitted(ctx, {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    message: COMMITMENT_MESSAGES.vehicleStillHeldByAnotherBasis,
  });
}

export async function notifyVehicleDeleted(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  vehicle: Doc<"vehicles">,
) {
  const actorName = await getActorName(ctx);
  await notifyManagers(
    ctx,
    orgId,
    "vehicle.deleted",
    { actorName, vehicleLabel: `${vehicle.year} ${vehicle.make} ${vehicle.model}`, vin: vehicle.vin ?? "" }
  );
}

export async function prepareSourcedVehicleArrival(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; vehicleId: Id<"vehicles"> },
  vehicle: Doc<"vehicles">,
  actorId: Id<"users">,
) {
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
    return null;
  }
  await assertNoPendingBeforeAvailable(ctx, {
    orgId: args.orgId,
    vehicleId: vehicle._id,
    currentStatus: vehicle.status,
    nextStatus: vehicle.status === "SOURCING" ? "AVAILABLE" : undefined,
  });

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
  await syncVehicleHoldStatus(ctx, args.vehicleId, actorId);
  const current = await ctx.db.get(args.vehicleId);
  if (!current || current.orgId !== args.orgId || current.isDeleted) {
    throw new ConvexError("Vehicle not found in this organization.");
  }

  return { now, current };
}

export async function requireVehicleDeletionActor(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ConvexError("Unauthenticated");

  const statusLimit = await checkTenantWriteLimit(ctx, "standardApi", orgId);
  if (!statusLimit.ok) {
    throw new ConvexError(`Rate limit exceeded. Try again in ${Math.ceil(statusLimit.retryAfter / 1000)}s`);
  }

  return identity.subject;
}
