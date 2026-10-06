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
const ORG_BLOCKING_CAP = 200;
type OrgBlocking = { complete: boolean; vehicles: Set<string> };
const orgHasBlocking = new WeakMap<object, Map<string, OrgBlocking>>();

async function orgBlockingVehicles(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">
): Promise<OrgBlocking> {
  const memo = orgHasBlocking.get(ctx.db) ?? new Map<string, OrgBlocking>();
  orgHasBlocking.set(ctx.db, memo);
  const cached = memo.get(orgId);
  if (cached !== undefined) return cached;
  const rows = await ctx.db
    .query("depositCancellationPendings")
    .withIndex("by_org_status", (q) =>
      q.eq("orgId", orgId).gte("status", BLOCKING_FROM).lte("status", BLOCKING_TO)
    )
    .take(ORG_BLOCKING_CAP + 1);
  // Within the cap the answer is a complete vehicle set, so a per-car question is a
  // Set lookup and costs NO index range (SCRUM-712 F2: a 100-car quote asked this
  // once per car and hit Convex's 4096-ranges limit as soon as ANY car in the org
  // held a share). Over the cap the set is incomplete, so it is not used: the
  // per-car range read stays the (correct, slower) fallback — never fail open.
  const answer: OrgBlocking =
    rows.length > ORG_BLOCKING_CAP
      ? { complete: false, vehicles: new Set() }
      : { complete: true, vehicles: new Set(rows.map((row) => row.vehicleId as string)) };
  memo.set(orgId, answer);
  return answer;
}

export function forgetOrgMemo(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">): void {
  orgHasBlocking.get(ctx.db)?.delete(orgId);
}

/** Is any cancelled-sale deposit share on this vehicle still undecided? */
export async function hasPendingDisposition(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  const known = await orgBlockingVehicles(ctx, orgId);
  if (known.complete) return known.vehicles.has(vehicleId);
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
 * Does any undecided share on this vehicle belong to a DIFFERENT sale?
 *
 * For the cancellation's own authority restoration only: it re-establishes the
 * holds of the deposits the cancelled sale consumed — one share per instalment —
 * so that sale's own rows must not refuse it, deposit by deposit. Anything else
 * on the car still does.
 */
export async function hasPendingDispositionExceptSale(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">,
  saleId: Id<"sales">
): Promise<boolean> {
  // Exact, not a page: the sale's own shares (one per instalment, any number) can
  // never fill a window and hide or fake a foreign one. Four existence ranges —
  // each blocking status x {saleId below, saleId above} — and only on the
  // restoration path, never per car.
  for (const status of ["PENDING", "QUARANTINED"] as const) {
    const below = await ctx.db
      .query("depositCancellationPendings")
      .withIndex("by_org_vehicle_status_sale", (q) =>
        q.eq("orgId", orgId).eq("vehicleId", vehicleId).eq("status", status).lt("saleId", saleId)
      )
      .first();
    if (below !== null) return true;
    const above = await ctx.db
      .query("depositCancellationPendings")
      .withIndex("by_org_vehicle_status_sale", (q) =>
        q.eq("orgId", orgId).eq("vehicleId", vehicleId).eq("status", status).gt("saleId", saleId)
      )
      .first();
    if (above !== null) return true;
  }
  return false;
}

/** Does this deposit still have an undecided share (PENDING or QUARANTINED)? */
export async function hasPendingDispositionForDeposit(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  depositId: Id<"deposits">
): Promise<boolean> {
  // Exact: one range over the blocking statuses, so decided history can never hide it.
  const row = await ctx.db
    .query("depositCancellationPendings")
    .withIndex("by_deposit_status", (q) =>
      q.eq("depositId", depositId).gte("status", BLOCKING_FROM).lte("status", BLOCKING_TO)
    )
    .first();
  return row !== null && row.orgId === orgId;
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
  // Exact (deposit, hold) range over the blocking statuses — never a paged scan of
  // the deposit's history (SCRUM-712 B1). `holdId` undefined is the whole-row share.
  const row = await ctx.db
    .query("depositCancellationPendings")
    .withIndex("by_deposit_hold_status", (q) =>
      q.eq("depositId", depositId).eq("holdId", holdId).gte("status", BLOCKING_FROM).lte("status", BLOCKING_TO)
    )
    .first();
  return row !== null && row.orgId === orgId ? row : null;
}

export const PENDING_CLEAR_REFUSED_MESSAGE =
  "This vehicle share is awaiting a refund or forfeiture decision that cannot be recorded yet — its sale's journal reversal has not posted, or the share is under review. Nothing was paid out.";

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
    /**
     * A slice payout names its own share. If that share exists but cannot be
     * cleared, the whole mutation must abort — otherwise the money moves while the
     * share stays pending forever (SCRUM-712 B1/F5). A whole-row payout of free
     * money may legitimately leave the share alone, so it does not set this.
     */
    required?: boolean;
  }
): Promise<boolean> {
  const row = await pendingShareOfHold(ctx, args.orgId, args.depositId, args.holdId);
  if (!row) return false;
  const refuse = (): false => {
    if (args.required) throw new ConvexError(PENDING_CLEAR_REFUSED_MESSAGE);
    return false;
  };
  if (row.status !== "PENDING" || args.paidMinor < row.amountMinor) return refuse();
  // S4: the share's own journal reversal must be PROVED posted. A closed period
  // leaves the application REVERSING until the outbox posts the reversal, and
  // `paidMinor` can be satisfied by unrelated free money on the same row — so
  // the payout alone proves nothing about this share. Only REVERSED (set when
  // the reversal posted, immediately or via commitDeferredReversal) clears it.
  const application = await ctx.db.get(row.applicationId);
  if (!application || application.orgId !== args.orgId || application.status !== "REVERSED") {
    return refuse();
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
    /** Legacy backfill only: an ambiguous share is written QUARANTINED, never guessed. */
    status?: "PENDING" | "QUARANTINED";
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
    status: args.status ?? "PENDING",
    createdAt: args.now,
    createdBy: args.actorId,
  });
}
