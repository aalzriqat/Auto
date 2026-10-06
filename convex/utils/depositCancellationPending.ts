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
