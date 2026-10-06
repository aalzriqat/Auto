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

/**
 * Statuses that keep the car locked: QUARANTINED blocks exactly like PENDING.
 *
 * ⚠️ ONE index range, on purpose. Of the four statuses only PENDING and
 * QUARANTINED sort between "PENDING" and "QUARANTINED" (FORFEITED < PENDING,
 * RELEASED > QUARANTINED), so a closed range reads exactly the blocking rows.
 * This predicate runs once per car on multi-car quotes, and two ranges per car
 * blew Convex's 4096-ranges-per-function limit on a 100-car quote.
 */
const BLOCKING_FROM = "PENDING";
const BLOCKING_TO = "QUARANTINED";

/**
 * Per-execution memo of "does this org have ANY blocking share". A 100-car
 * deposit asks the per-car question a hundred times; the org-level answer is one
 * range read, and for an org with nothing pending (almost always) it answers
 * every car. Keyed by the db handle so it lives exactly one function execution,
 * and dropped by every writer in this module so the same transaction never reads
 * a stale "none".
 */
const orgHasBlocking = new WeakMap<object, Map<string, boolean>>();

async function orgHasAnyBlocking(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">
): Promise<boolean> {
  const memo = orgHasBlocking.get(ctx.db) ?? new Map<string, boolean>();
  orgHasBlocking.set(ctx.db, memo);
  const cached = memo.get(orgId);
  if (cached !== undefined) return cached;
  const row = await ctx.db
    .query("depositCancellationPendings")
    .withIndex("by_org_status", (q) =>
      q.eq("orgId", orgId).gte("status", BLOCKING_FROM).lte("status", BLOCKING_TO)
    )
    .first();
  memo.set(orgId, row !== null);
  return row !== null;
}

function forgetOrgMemo(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">): void {
  orgHasBlocking.get(ctx.db)?.delete(orgId);
}

/** Is any cancelled-sale deposit share on this vehicle still undecided? */
export async function hasPendingDisposition(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  if (!(await orgHasAnyBlocking(ctx, orgId))) return false;
  const row = await ctx.db
    .query("depositCancellationPendings")
    .withIndex("by_org_vehicle_status", (q) =>
      q
        .eq("orgId", orgId)
        .eq("vehicleId", vehicleId)
        .gte("status", BLOCKING_FROM)
        .lte("status", BLOCKING_TO)
    )
    .first();
  return row !== null;
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
  const rows = await ctx.db
    .query("depositCancellationPendings")
    .withIndex("by_org_vehicle_status", (q) =>
      q
        .eq("orgId", orgId)
        .eq("vehicleId", vehicleId)
        .gte("status", BLOCKING_FROM)
        .lte("status", BLOCKING_TO)
    )
    .take(50);
  if (rows.some((row) => row.depositId !== depositId)) return true;
  // A full page of one deposit's rows could hide a different one beyond it.
  return rows.length === 50;
}

/** Does this deposit still have an undecided share (PENDING or QUARANTINED)? */
export async function hasPendingDispositionForDeposit(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  depositId: Id<"deposits">
): Promise<boolean> {
  const rows = await ctx.db
    .query("depositCancellationPendings")
    .withIndex("by_deposit", (q) => q.eq("depositId", depositId))
    .take(50);
  // A full page cannot prove the remainder is decided, so it blocks too.
  return (
    rows.length === 50 ||
    rows.some((row) => row.orgId === orgId && (row.status === "PENDING" || row.status === "QUARANTINED"))
  );
}

export const PENDING_EXIT_MESSAGE =
  "This deposit still has a share from a cancelled sale awaiting a refund or forfeiture decision. Decide that share first; it cannot be voided, reallocated, returned to the pool or recorded as another treatment.";

/** The one undecided share a hold carries, if any. */
async function pendingShareOfHold(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  depositId: Id<"deposits">,
  holdId: Id<"depositVehicleHolds"> | undefined
): Promise<Doc<"depositCancellationPendings"> | null> {
  const rows = await ctx.db
    .query("depositCancellationPendings")
    .withIndex("by_deposit", (q) => q.eq("depositId", depositId))
    .take(50);
  return (
    rows.find(
      (row) =>
        row.orgId === orgId &&
        (row.status === "PENDING" || row.status === "QUARANTINED") &&
        row.holdId === holdId
    ) ?? null
  );
}

/** Refuses a treatment that would leave a pending share undecided while moving its money. */
export async function assertNoPendingShareOnHold(
  ctx: QueryCtx | MutationCtx,
  args: { orgId: Id<"organizations">; depositId: Id<"deposits">; holdId: Id<"depositVehicleHolds"> }
): Promise<void> {
  if (await pendingShareOfHold(ctx, args.orgId, args.depositId, args.holdId)) {
    throw new ConvexError(PENDING_EXIT_MESSAGE);
  }
}

/**
 * A refund or forfeiture of a share decides exactly that share: clears the ONE
 * PENDING row it names (by hold, or the whole-row share when `holdId` is absent)
 * and nothing else. QUARANTINED rows are never cleared here — they need a human
 * reconciliation. `paidMinor` must cover the share, or it stays pending.
 */
export async function clearPendingDisposition(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    depositId: Id<"deposits">;
    holdId?: Id<"depositVehicleHolds">;
    resolution: "REFUNDED" | "FORFEITED";
    paidMinor: number;
    actorId: Id<"users">;
    now: number;
    reference: string;
  }
): Promise<boolean> {
  const row = await pendingShareOfHold(ctx, args.orgId, args.depositId, args.holdId);
  if (!row || row.status !== "PENDING" || args.paidMinor < row.amountMinor) return false;
  // S4: the share's own journal reversal must be PROVED posted. A closed period
  // leaves the application REVERSING until the outbox posts the reversal, and
  // `paidMinor` can be satisfied by unrelated free money on the same row — so
  // the payout alone proves nothing about this share. Only REVERSED (set when
  // the reversal posted, immediately or via commitDeferredReversal) clears it.
  const application = await ctx.db.get(row.applicationId);
  if (!application || application.orgId !== args.orgId || application.status !== "REVERSED") {
    return false;
  }
  await ctx.db.patch(row._id, {
    status: args.resolution === "FORFEITED" ? "FORFEITED" : "RELEASED",
    resolvedAt: args.now,
    resolvedBy: args.actorId,
    resolutionReference: args.reference,
  });
  forgetOrgMemo(ctx, args.orgId);
  return true;
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
  forgetOrgMemo(ctx, application.orgId);
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
