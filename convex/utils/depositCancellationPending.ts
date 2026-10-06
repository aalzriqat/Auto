/**
 * SCRUM-712 — the per-share PENDING disposition a cancelled completed sale leaves
 * behind. See `depositCancellationPendings` in the schema.
 *
 * ⚠️ Three rules this module owns, because every door depends on them:
 *  - the row is created ONCE per application (natural key), by the shared sale
 *    teardown, never by a door;
 *  - a zero-amount share creates nothing (no money, nothing to decide);
 *  - the vehicle predicate is a bounded, tenant-scoped existence read that does
 *    not depend on the organization's authority version.
 */
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/** Statuses that keep the car locked. QUARANTINED blocks exactly like PENDING. */
const BLOCKING = ["PENDING", "QUARANTINED"] as const;

/** Is any cancelled-sale deposit share on this vehicle still undecided? */
export async function hasPendingDisposition(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  for (const status of BLOCKING) {
    const row = await ctx.db
      .query("depositCancellationPendings")
      .withIndex("by_org_vehicle_status", (q) =>
        q.eq("orgId", orgId).eq("vehicleId", vehicleId).eq("status", status)
      )
      .first();
    if (row) return true;
  }
  return false;
}

export const PENDING_AVAILABILITY_MESSAGE =
  "A deposit from a cancelled sale on this vehicle still needs a refund or forfeiture decision. Complete it before the vehicle can be made available again.";

/**
 * Refuses a direct move TO `AVAILABLE` while a share is undecided. The pure
 * status guard cannot read the database, so every status door calls this beside
 * it (vehicles.update, vehicleEdits request + approval, vehicleRequests request
 * + approval). Staying on the current status is never refused.
 */
export async function assertNoPendingBeforeAvailable(
  ctx: QueryCtx | MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    currentStatus: string;
    nextStatus: string | undefined;
  }
): Promise<void> {
  const next = args.nextStatus?.trim().toUpperCase();
  if (next !== "AVAILABLE" || next === args.currentStatus.trim().toUpperCase()) return;
  if (await hasPendingDisposition(ctx, args.orgId, args.vehicleId)) {
    throw new ConvexError(PENDING_AVAILABILITY_MESSAGE);
  }
}

/**
 * Does any undecided share on this vehicle belong to a DIFFERENT deposit?
 *
 * For the cancellation's own authority restoration only: it re-establishes the
 * hold of the very deposit whose share just went pending, so that deposit's own
 * rows must not refuse it. Anything else on the car still does. Bounded read.
 */
export async function hasPendingDispositionExceptDeposit(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">,
  depositId: Id<"deposits">
): Promise<boolean> {
  for (const status of BLOCKING) {
    const rows = await ctx.db
      .query("depositCancellationPendings")
      .withIndex("by_org_vehicle_status", (q) =>
        q.eq("orgId", orgId).eq("vehicleId", vehicleId).eq("status", status)
      )
      .take(50);
    if (rows.some((row) => row.depositId !== depositId)) return true;
    // A full page of one deposit's rows could hide a different one beyond it.
    if (rows.length === 50) return true;
  }
  return false;
}

/**
 * Records the share an application consumed. Idempotent on the application: a
 * retry, a replay or a second teardown pass returns the existing row untouched.
 */
export async function recordPendingDisposition(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"depositApplications">;
    actorId: Id<"users">;
    now: number;
  }
): Promise<Id<"depositCancellationPendings"> | null> {
  const application: Doc<"depositApplications"> | null = await ctx.db.get(args.applicationId);
  // Tenant: the caller's org must own the application it names.
  if (!application || application.orgId !== args.orgId) return null;
  if (!(application.amountMinor > 0)) return null;
  const existing = await ctx.db
    .query("depositCancellationPendings")
    .withIndex("by_org_application", (q) =>
      q.eq("orgId", application.orgId).eq("applicationId", application._id)
    )
    .first();
  if (existing) return existing._id;
  return await ctx.db.insert("depositCancellationPendings", {
    orgId: application.orgId,
    depositId: application.depositId,
    vehicleId: application.vehicleId,
    saleId: application.saleId,
    applicationId: application._id,
    ...(application.holdId ? { holdId: application.holdId } : {}),
    amountMinor: application.amountMinor,
    currency: application.currency,
    status: "PENDING",
    createdAt: args.now,
    createdBy: args.actorId,
  });
}
