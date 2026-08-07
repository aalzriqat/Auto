import { ConvexError } from "convex/values";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { Doc, Id } from "../_generated/dataModel";
import { throwAppError, AppErrorCode } from "./errors";
import { requireActorPermission } from "./tenancy";
import { PERMISSIONS } from "./permissions";
import { assertDifferentActors } from "./financialGuards";
import { normalizeCurrency, amountToMinorOrThrow, type DepositMethod } from "./depositRecording";
import { createCanonicalPayment } from "../subledger";
import {
  getOrgCurrency,
  hookDepositRefunded,
  hookDepositForfeited,
} from "../accounting/workflowHooks";

/** Used when an org hasn't configured a reservationHoldDays setting. */
export const DEFAULT_RESERVATION_HOLD_DAYS = 3;

/**
 * Resolves how long (in ms from `now`) a new reservation/deposit hold should
 * last when the caller doesn't pass an explicit expiresAt — the org's
 * configured reservationHoldDays (Settings > General), or
 * DEFAULT_RESERVATION_HOLD_DAYS if unset.
 */
export async function getDefaultReservationExpiry(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  now: number
): Promise<number> {
  const settings = await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  const holdDays = settings?.reservationHoldDays ?? DEFAULT_RESERVATION_HOLD_DAYS;
  return now + holdDays * 24 * 60 * 60 * 1000;
}

type ResolvedDepositsForQuoteResult = {
  total: number;
  appliedDeposits: Array<{
    depositId: Id<"deposits">;
    customerId: Id<"customers">;
    amount: number;
  }>;
};

/**
 * The statuses a deposit or reservation hold is allowed to promote a vehicle
 * out of, into RESERVED.
 *
 * SOURCING belongs here: a special-order car is sourced *because* a customer
 * asked for it, so a deposit against one is the most committed a hold ever
 * gets. Excluding it meant the deposit was recorded, the money posted to the
 * GL and `holdActive: true` was written, while the car stayed SOURCING — a
 * hold that existed in the database and nowhere on the vehicle. The manual
 * escape hatch was closed too (RESERVED is workflow-controlled), so the car
 * could not be reserved by any path.
 *
 * IN_INSPECTION / IN_REPAIR stay out on purpose: those describe where the car
 * physically is, and overwriting them would lose the only record of it.
 */
const HOLDABLE_STATUSES = ["AVAILABLE", "SOURCING"] as const;

type HoldableStatus = (typeof HOLDABLE_STATUSES)[number];

export function isHoldableStatus(status: string): status is HoldableStatus {
  return (HOLDABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * The status `syncVehicleHoldStatus` would move this vehicle to, or null if it
 * would leave it alone. Exported so `migrations.reconcileVehicleHolds` can
 * report a dry run that cannot disagree with what the real run writes.
 */
export function resolveHoldTargetStatus(
  vehicle: Pick<Doc<"vehicles">, "status" | "preHoldStatus" | "sourceType">,
  hasHold: boolean
): HoldableStatus | "RESERVED" | null {
  if (hasHold && isHoldableStatus(vehicle.status)) return "RESERVED";
  if (!hasHold && vehicle.status === "RESERVED") {
    // A snapshot of SOURCING only still means something while the vehicle is
    // actually sourced. `vehicles.update` can flip sourceType to STOCK without
    // requesting a status change, which the workflow guard permits — restoring
    // the stale snapshot then parked owned stock in the sourcing lifecycle,
    // where it is excluded from available inventory and from the lot.
    if (vehicle.preHoldStatus === "SOURCING" && vehicle.sourceType !== "SOURCED") {
      return "AVAILABLE";
    }
    return vehicle.preHoldStatus ?? "AVAILABLE";
  }
  return null;
}

/**
 * Puts a soft hold on a vehicle when a deposit is recorded. Reserving an
 * already-RESERVED vehicle is a no-op — multiple parallel deposits/quotes on
 * the same vehicle record are allowed (the same car can be sourced again from
 * the free zone or another dealer), this is a warning, not a lock.
 */
export async function holdVehicleForDeposit(
  ctx: MutationCtx,
  vehicleId: Id<"vehicles">
): Promise<void> {
  const vehicle = await ctx.db.get(vehicleId);
  if (!vehicle) return;
  if (vehicle.status === "SOLD") {
    throwAppError(AppErrorCode.VEHICLE_ALREADY_SOLD, "This vehicle has already been sold.");
  }
  if (vehicle.status === "ARCHIVED") {
    throwAppError(AppErrorCode.VEHICLE_ARCHIVED, "Cannot place a deposit on an archived vehicle.");
  }
  if (isHoldableStatus(vehicle.status)) {
    await ctx.db.patch(vehicleId, {
      status: "RESERVED" as const,
      preHoldStatus: vehicle.status,
    });
  }
}

/**
 * Every deposit actively holding a vehicle — the ones naming it directly, plus
 * the ones holding it as a *secondary* line on a multi-vehicle quote.
 *
 * That second set is easy to miss and has caused real bugs: a deposit row only
 * ever snapshots the quote's primary `vehicleId`, so cars 2 and 3 of a
 * three-car deal are recorded solely in `depositVehicleHolds`. Any check that
 * queries `deposits.by_vehicle_hold` alone concludes those vehicles are unheld
 * while they are genuinely reserved.
 *
 * Readable from a query as well as a mutation, so the sourcing pipeline and the
 * reservation guard can share one definition of "who is holding this car".
 */
export async function getActiveDepositHolds(
  ctx: QueryCtx | MutationCtx,
  vehicleId: Id<"vehicles">
): Promise<Doc<"deposits">[]> {
  const direct = await ctx.db
    .query("deposits")
    .withIndex("by_vehicle_hold", (q) => q.eq("vehicleId", vehicleId).eq("holdActive", true))
    .take(50);

  const secondaryHolds = await ctx.db
    .query("depositVehicleHolds")
    .withIndex("by_vehicle_active", (q) => q.eq("vehicleId", vehicleId).eq("active", true))
    .take(50);
  const secondary = await Promise.all(secondaryHolds.map((hold) => ctx.db.get(hold.depositId)));

  const byId = new Map<string, Doc<"deposits">>();
  for (const deposit of [...direct, ...secondary]) {
    if (!deposit || deposit.isDeleted === true) continue;
    if (deposit.status !== "HELD" || deposit.holdActive !== true) continue;
    byId.set(deposit._id, deposit);
  }
  return Array.from(byId.values());
}

/** Exported for saleCancellation.ts's trade-in-reversal safety guard, in addition to internal use by syncVehicleHoldStatus below. */
export async function hasActiveDepositHold(
  ctx: MutationCtx,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  const deposits = await ctx.db
    .query("deposits")
    .withIndex("by_vehicle_hold", (q) => q.eq("vehicleId", vehicleId).eq("holdActive", true))
    .take(50);

  if (deposits.some((deposit) => deposit.isDeleted !== true)) return true;

  // Covers secondary vehicles on a multi-vehicle deposit, which only ever
  // snapshot their primary vehicleId on the `deposits` row itself.
  const secondaryHolds = await ctx.db
    .query("depositVehicleHolds")
    .withIndex("by_vehicle_active", (q) => q.eq("vehicleId", vehicleId).eq("active", true))
    .take(50);
  return secondaryHolds.length > 0;
}

/** Exported for saleCancellation.ts's trade-in-reversal safety guard, in addition to internal use by syncVehicleHoldStatus below. */
export async function hasActiveReservationHold(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; vehicleId: Id<"vehicles"> }
): Promise<boolean> {
  const now = Date.now();
  // Filter to ACTIVE in the index and stream rather than taking a fixed page.
  //
  // `by_org_vehicle` returned oldest-first across every status, so a vehicle
  // with 50+ historical released/expired reservations pushed a genuinely active
  // one out of the window — and this function answering "no hold" is what
  // releases a vehicle back to the lot, so a car could be handed back while a
  // live reservation still pointed at it.
  //
  // Narrowing to ACTIVE is not enough on its own: a reservation keeps
  // `status: "ACTIVE"` until a sweep patches it to EXPIRED, and this index is
  // still oldest-first, so a page of stale-but-unswept rows can sit in front of
  // the live one. Iterating stops at the first row that is genuinely unexpired,
  // which is the answer being asked for.
  for await (const reservation of ctx.db
    .query("vehicleReservations")
    .withIndex("by_org_vehicle_status", (q) =>
      q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId).eq("status", "ACTIVE")
    )) {
    if (reservation.expiresAt === undefined || reservation.expiresAt > now) return true;
  }
  return false;
}

export async function syncVehicleHoldStatus(
  ctx: MutationCtx,
  vehicleId: Id<"vehicles">,
  actorId?: Id<"users">,
): Promise<void> {
  const vehicle = await ctx.db.get(vehicleId);
  if (!vehicle || vehicle.isDeleted) return;
  if (vehicle.status === "SOLD" || vehicle.status === "ARCHIVED") return;

  const hasHold =
    (await hasActiveDepositHold(ctx, vehicleId)) ||
    (await hasActiveReservationHold(ctx, { orgId: vehicle.orgId, vehicleId }));

  // One resolver decides the target for both this function and the
  // reconcileVehicleHolds migration, so a dry-run preview cannot disagree with
  // what actually gets written.
  const target = resolveHoldTargetStatus(vehicle, hasHold);
  if (target === null || target === vehicle.status) return;

  if (target === "RESERVED") {
    const patch: {
      status: "RESERVED";
      preHoldStatus: HoldableStatus;
      updatedAt: number;
      updatedBy?: Id<"users">;
    } = {
      status: "RESERVED" as const,
      // Safe: resolveHoldTargetStatus only returns RESERVED when the current
      // status is holdable.
      preHoldStatus: vehicle.status as HoldableStatus,
      updatedAt: Date.now(),
    };
    if (actorId) patch.updatedBy = actorId;
    await ctx.db.patch(vehicleId, patch);
  } else {
    // Restore where the hold found it. Rows written before preHoldStatus
    // existed have none — AVAILABLE is the right fallback for those, since
    // that was the only status a hold could previously promote from.
    const patch: {
      status: HoldableStatus;
      preHoldStatus: undefined;
      updatedAt: number;
      updatedBy?: Id<"users">;
    } = {
      status: target,
      preHoldStatus: undefined,
      updatedAt: Date.now(),
    };
    if (actorId) patch.updatedBy = actorId;
    await ctx.db.patch(vehicleId, patch);
  }
}

/**
 * Releases a vehicle's RESERVED hold back to AVAILABLE once no deposit is
 * or reservation is still actively holding it.
 */
export async function maybeReleaseVehicleHold(
  ctx: MutationCtx,
  vehicleId: Id<"vehicles">
): Promise<void> {
  await syncVehicleHoldStatus(ctx, vehicleId);
}

/**
 * Releases every vehicle a deposit holds — the primary `deposit.vehicleId`
 * plus any secondary vehicles recorded in `depositVehicleHolds` for
 * multi-vehicle quotes. Use this instead of a bare `maybeReleaseVehicleHold`
 * whenever a deposit is being resolved (released/voided/applied).
 */
export async function releaseAllVehiclesForDeposit(
  ctx: MutationCtx,
  deposit: Doc<"deposits">
): Promise<void> {
  await maybeReleaseVehicleHold(ctx, deposit.vehicleId);

  const secondaryHolds = await ctx.db
    .query("depositVehicleHolds")
    .withIndex("by_deposit", (q) => q.eq("depositId", deposit._id))
    .collect();

  for (const hold of secondaryHolds) {
    if (!hold.active) continue;
    await ctx.db.patch(hold._id, { active: false });
    await maybeReleaseVehicleHold(ctx, hold.vehicleId);
  }
}

/**
 * Reactivates every vehicle a deposit holds — the inverse of
 * releaseAllVehiclesForDeposit. Use when a completed sale is cancelled and
 * its APPLIED deposit is reinstated to HELD, so every vehicle on a
 * multi-vehicle quote goes back on hold, not just the primary one.
 */
export async function reactivateAllVehiclesForDeposit(
  ctx: MutationCtx,
  deposit: Doc<"deposits">
): Promise<void> {
  await syncVehicleHoldStatus(ctx, deposit.vehicleId);

  const secondaryHolds = await ctx.db
    .query("depositVehicleHolds")
    .withIndex("by_deposit", (q) => q.eq("depositId", deposit._id))
    .collect();

  for (const hold of secondaryHolds) {
    if (!hold.active) {
      await ctx.db.patch(hold._id, { active: true });
    }
    await syncVehicleHoldStatus(ctx, hold.vehicleId);
  }
}

/**
 * What was decided about a reservation deposit (عربون) when the deal it holds
 * finished.
 *
 * The reservation deposit is the customer's money paid to the DEALERSHIP
 * against its own receipt voucher. It is not the financing down payment, which
 * the customer pays to the finance company and which never passes through
 * these books. Conflating the two is the mistake this taxonomy exists to make
 * impossible: nothing here can move a reservation deposit to a finance
 * company, and nothing recognizes it as income merely because a deal closed.
 *
 *   APPLY_TO_DEALER_AMOUNT          against something the customer genuinely
 *                                   owes the dealership on this deal.
 *   APPLY_TO_TRANSACTION_SETTLEMENT against the dealership-side settlement with
 *                                   the supplier.
 *   REFUND_TO_CUSTOMER              returned.
 *   FORFEITED                       retained under the cancellation policy.
 *   OTHER                           an approved treatment none of the above
 *                                   describes. Requires a reason, and posts
 *                                   nothing — see below.
 */
export type DepositTreatment =
  | "APPLY_TO_DEALER_AMOUNT"
  | "APPLY_TO_TRANSACTION_SETTLEMENT"
  | "REFUND_TO_CUSTOMER"
  | "FORFEITED"
  | "OTHER";

/**
 * The deposit row status each treatment leaves behind.
 *
 * OTHER maps to null deliberately. It means a human has approved a treatment
 * the system has no rule for, so there is no account to credit and no honest
 * status to claim — the liability stays exactly where it is, awaiting a manual
 * journal. Only the vehicle hold is released. Picking any status here would be
 * inventing an accounting outcome from a field whose entire purpose is to say
 * that no automatic outcome applies.
 */
export function depositStatusForTreatment(
  treatment: DepositTreatment
): "APPLIED" | "REFUNDED" | "FORFEITED" | null {
  switch (treatment) {
    case "APPLY_TO_DEALER_AMOUNT":
    case "APPLY_TO_TRANSACTION_SETTLEMENT":
      return "APPLIED";
    case "REFUND_TO_CUSTOMER":
      return "REFUNDED";
    case "FORFEITED":
      return "FORFEITED";
    case "OTHER":
      return null;
  }
}

/**
 * Resolves every actively-held deposit on a quote (e.g. when its sale
 * completes) and releases the vehicle hold if nothing else is holding it.
 *
 * `appliedDeposits` lists only deposits applied to what the CUSTOMER owes the
 * dealership — those and only those become a canonical payment allocated to the
 * sale's receivable. A deposit applied to the supplier settlement, refunded, or
 * left for a manual journal never touches the customer's receivable, so
 * including it would over-settle an invoice the customer still owes.
 */
export async function resolveDepositsForQuote(
  ctx: MutationCtx,
  args: {
    quoteId: Id<"quotes">;
    resolution: "APPLIED" | "REFUNDED" | "FORFEITED";
    actorId: Id<"users">;
    /**
     * Recorded alongside the status when the caller made an explicit choice.
     * Absent for the implicit dealer-owned path, where "applied to what the
     * customer owes" is the only thing APPLIED has ever meant.
     */
    treatment?: DepositTreatment;
    treatmentReason?: string;
    saleId?: Id<"sales">;
  }
): Promise<ResolvedDepositsForQuoteResult> {
  const deposits = await ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", args.quoteId))
    .collect();

  let resolvedTotal = 0;
  const appliedDeposits: ResolvedDepositsForQuoteResult["appliedDeposits"] = [];
  const now = Date.now();
  const appliesToCustomerAr =
    args.treatment === undefined || args.treatment === "APPLY_TO_DEALER_AMOUNT";
  for (const deposit of deposits) {
    if (!deposit.holdActive) continue;
    await ctx.db.patch(deposit._id, {
      status: args.resolution,
      holdActive: false,
      resolvedBy: args.actorId,
      resolvedAt: now,
      ...(args.treatment ? { resolutionTreatment: args.treatment } : {}),
      ...(args.treatmentReason ? { resolutionReason: args.treatmentReason } : {}),
      ...(args.saleId ? { resolutionSaleId: args.saleId } : {}),
    });
    resolvedTotal += deposit.amount;
    if (args.resolution === "APPLIED" && appliesToCustomerAr) {
      appliedDeposits.push({
        depositId: deposit._id,
        customerId: deposit.customerId,
        amount: deposit.amount,
      });
    }
    await releaseAllVehiclesForDeposit(ctx, deposit);
  }
  return { total: resolvedTotal, appliedDeposits };
}

/**
 * Releases the vehicle hold without deciding anything about the money — the
 * OTHER treatment. The deposit stays HELD and its liability stays on the books;
 * what is recorded is that somebody chose a treatment the system does not post,
 * and why.
 */
export async function recordUnpostedDepositTreatment(
  ctx: MutationCtx,
  args: {
    quoteId: Id<"quotes">;
    actorId: Id<"users">;
    reason: string;
    saleId?: Id<"sales">;
  }
): Promise<{ total: number; depositIds: Id<"deposits">[] }> {
  const deposits = await ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", args.quoteId))
    .collect();

  let total = 0;
  const depositIds: Id<"deposits">[] = [];
  const now = Date.now();
  for (const deposit of deposits) {
    if (!deposit.holdActive) continue;
    await ctx.db.patch(deposit._id, {
      // status deliberately untouched — the money is still held.
      holdActive: false,
      resolvedBy: args.actorId,
      resolvedAt: now,
      resolutionTreatment: "OTHER" as const,
      resolutionReason: args.reason,
      ...(args.saleId ? { resolutionSaleId: args.saleId } : {}),
    });
    total += deposit.amount;
    depositIds.push(deposit._id);
    await releaseAllVehiclesForDeposit(ctx, deposit);
  }
  return { total, depositIds };
}

async function releaseQuoteDepositHolds(
  ctx: MutationCtx,
  quoteId: Id<"quotes">
): Promise<void> {
  for await (const deposit of ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", quoteId))) {
    if (deposit.isDeleted === true || !deposit.holdActive) continue;
    await ctx.db.patch(deposit._id, { holdActive: false });
    await releaseAllVehiclesForDeposit(ctx, deposit);
  }
}

async function releaseReservationDepositHold(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; reservation: Doc<"vehicleReservations"> }
): Promise<void> {
  if (!args.reservation.depositId) return;

  const deposit = await ctx.db.get(args.reservation.depositId);
  if (
    deposit &&
    deposit.isDeleted !== true &&
    deposit.orgId === args.orgId &&
    deposit.status === "HELD" &&
    deposit.holdActive
  ) {
    await ctx.db.patch(args.reservation.depositId, { holdActive: false });
  }
}

async function releaseMatchingReservationHoldsForQuote(
  ctx: MutationCtx,
  args: { quote: Doc<"quotes">; actorId: Id<"users"> }
): Promise<void> {
  const { quote } = args;
  const quoteVehicleItems = quote.vehicleItems ?? [{ vehicleId: quote.vehicleId }];
  const now = Date.now();

  for (const item of quoteVehicleItems) {
    const reservations = await ctx.db
      .query("vehicleReservations")
      .withIndex("by_org_vehicle_status", (q) =>
        q.eq("orgId", quote.orgId).eq("vehicleId", item.vehicleId).eq("status", "ACTIVE")
      )
      .take(50);

    const matchingReservations = reservations.filter((reservation) => reservation.customerId === quote.customerId);

    for (const reservation of matchingReservations) {
      await releaseReservationDepositHold(ctx, { orgId: quote.orgId, reservation });
      await ctx.db.patch(reservation._id, {
        status: "RELEASED",
        releasedAt: now,
        releasedBy: args.actorId,
      });
      await syncVehicleHoldStatus(ctx, reservation.vehicleId, args.actorId);
    }
  }
}

/**
 * Releases vehicle holds for a quote whose application was rejected or
 * cancelled. Deposit rows stay HELD so a manager still manually refunds or
 * forfeits real money, but those deposits and same-customer reservations stop
 * contributing to RESERVED inventory.
 */
export async function releaseHoldForApplicationQuote(
  ctx: MutationCtx,
  args: { quoteId: Id<"quotes">; actorId: Id<"users"> }
): Promise<void> {
  const quote = await ctx.db.get(args.quoteId);
  if (!quote) return;

  await releaseQuoteDepositHolds(ctx, args.quoteId);
  await releaseMatchingReservationHoldsForQuote(ctx, { quote, actorId: args.actorId });
}

/**
 * Releases one HELD deposit as a refund or a forfeiture, with every control
 * that decision carries.
 *
 * This exists because there are now two places a deposit can be released — the
 * deposits screen and the completion of the sale it was taken against — and the
 * controls belong to the DECISION, not to the screen it happens to be made on.
 * Reimplementing the posting in the second place produced a path that moved a
 * customer's money with none of them: no approval permission, no separation
 * between the person who took the deposit and the person who kept it, no check
 * that the refund method could actually be paid out, and no record in the
 * cashflow ledger or the payments subledger to reconcile the journal against.
 *
 * The GL entry alone is not a release. Cash leaving the business has to appear
 * in the places people look for cash leaving the business.
 */
export async function releaseHeldDeposit(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    depositId: Id<"deposits">;
    resolution: "REFUNDED" | "FORFEITED";
    actorId: Id<"users">;
    refundMethod?: DepositMethod;
    notes?: string;
    idempotencyKey?: string;
    occurredAt?: number;
    /** Recorded on the deposit when the release was decided by closing a sale. */
    saleId?: Id<"sales">;
    treatment?: DepositTreatment;
  }
): Promise<{ amountMinor: number; currency: string }> {
  if (args.resolution === "REFUNDED" && !args.refundMethod) {
    throw new ConvexError("A refund payment method is required to refund a deposit.");
  }
  if (args.refundMethod === "OTHER") {
    throw new ConvexError("Select a specific refund method — OTHER is not accepted for a deposit refund.");
  }

  // Releasing a deposit is an approval, not a sale action. Checked against the
  // actor rather than the entry point, because completing a sale authorizes
  // `create:sales` and would otherwise carry this along for free.
  await requireActorPermission(
    ctx,
    args.orgId,
    args.actorId,
    PERMISSIONS.APPROVE_REQUESTS,
    "Refunding or forfeiting a reservation deposit requires approval permission."
  );

  const deposit = await ctx.db.get(args.depositId);
  if (!deposit || deposit.orgId !== args.orgId) {
    throwAppError(AppErrorCode.DEPOSIT_NOT_FOUND, "Deposit not found in this organization.");
  }
  if (deposit.status !== "HELD") {
    throwAppError(AppErrorCode.DEPOSIT_ALREADY_RESOLVED, "This deposit has already been resolved.");
  }
  assertDifferentActors(
    args.actorId,
    deposit.createdBy,
    "Deposit creator cannot resolve their own deposit refund or forfeiture."
  );

  const now = args.occurredAt ?? Date.now();
  const currency = normalizeCurrency(deposit.currency ?? (await getOrgCurrency(ctx, args.orgId)));
  const amountMinor = deposit.amountMinor ?? amountToMinorOrThrow(deposit.amount, currency);

  await ctx.db.patch(args.depositId, {
    status: args.resolution,
    holdActive: false,
    resolvedBy: args.actorId,
    resolvedAt: now,
    notes: args.notes ?? deposit.notes,
    ...(args.treatment ? { resolutionTreatment: args.treatment } : {}),
    ...(args.saleId ? { resolutionSaleId: args.saleId } : {}),
  });
  await releaseAllVehiclesForDeposit(ctx, deposit);

  if (args.resolution === "REFUNDED") {
    const [vehicle, customer] = await Promise.all([
      ctx.db.get(deposit.vehicleId),
      ctx.db.get(deposit.customerId),
    ]);
    const vehicleLabel = vehicle
      ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim()
      : "Vehicle";
    const customerLabel = customer
      ? `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Customer"
      : "Customer";
    const sourceLabel = deposit.quoteId
      ? `quote ${deposit.quoteId}`
      : deposit.reservationId
        ? `reservation ${deposit.reservationId}`
        : "vehicle hold";

    await ctx.db.insert("transactions", {
      orgId: args.orgId,
      type: "OUT",
      amount: deposit.amount,
      date: now,
      category: "DEPOSIT",
      description: `Deposit refund for ${sourceLabel} - ${vehicleLabel} - ${customerLabel}`,
      vehicleId: deposit.vehicleId,
      depositId: args.depositId,
      idempotencyKey: args.idempotencyKey,
    });

    const collectionPaymentId = await ctx.db.insert("collectionPayments", {
      orgId: args.orgId,
      customerId: deposit.customerId,
      vehicleId: deposit.vehicleId,
      direction: "OUT",
      method: "REFUND",
      amount: deposit.amount,
      paymentDate: now,
      status: "POSTED",
      idempotencyKey: args.idempotencyKey,
      reference: `Deposit refund ${args.depositId}`,
      cashierId: args.actorId,
      notes: args.notes,
      createdAt: now,
    });

    const canonicalPaymentId = await createCanonicalPayment(ctx, {
      orgId: args.orgId,
      direction: "OUT",
      payerType: "CUSTOMER",
      customerId: deposit.customerId,
      method: args.refundMethod!,
      amountMinor,
      currency,
      idempotencyKey: `deposit_refund_${args.depositId}`,
      actorId: args.actorId,
      status: "SETTLED",
      externalReference: `Deposit refund ${args.depositId}`,
      receivedAt: now,
    });
    await ctx.db.patch(collectionPaymentId, { canonicalPaymentId });

    await hookDepositRefunded(ctx, {
      orgId: args.orgId,
      depositId: args.depositId,
      customerId: deposit.customerId,
      amountMinor,
      currency,
      actorId: args.actorId,
      occurredAt: now,
      paymentMethod: args.refundMethod,
    });
  } else {
    await hookDepositForfeited(ctx, {
      orgId: args.orgId,
      depositId: args.depositId,
      customerId: deposit.customerId,
      amountMinor,
      currency,
      actorId: args.actorId,
      occurredAt: now,
    });
  }

  return { amountMinor, currency };
}
