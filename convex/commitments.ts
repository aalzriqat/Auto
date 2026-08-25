import { ConvexError, v } from "convex/values";
import { query, type QueryCtx, type MutationCtx } from "./_generated/server";
import { Doc, type Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

/**
 * SCRUM-195 — THE CANONICAL VEHICLE COMMITMENT AUTHORITY.
 *
 * ## Why this module exists
 *
 * A physical car is one physical unit. Three separate subsystems could each
 * decide it was theirs — deposits, finance applications and manual reservations
 * — and historically none of them asked the others. `grep -c financeApplications`
 * over `deposits.ts`, `vehicles.ts` and `utils/depositHelpers.ts` returned
 * 0, 0, 0, which is how a car held by a live finance application stayed
 * acquirable through every other door, and how a deposit-held car could be sold
 * to a rival customer outright.
 *
 * Everything that can take a car now asks one question here, and gets one
 * answer.
 *
 * ## Identity is server-owned
 *
 * A commitment ROOT is the owner. It is not `(customerId, vehicleId)`, not a
 * row count, and not "the newest quote". Those all fail in both directions:
 * one customer may hold two genuinely unrelated deals on the same car, and one
 * deal may involve more than one person. A quote is EVIDENCE that belongs to a
 * root; it is never the identity itself.
 *
 * ## Status is a projection, never the lock
 *
 * `vehicle.status = RESERVED` is advisory — it exists for the UI and for
 * legacy readers. Authority lives in the root and its claims. Any guard that
 * consults status instead of this module is reintroducing the original defect,
 * because status can be stale, can be patched directly, and cannot distinguish
 * WHOSE hold it represents.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Refusal messages. Deliberately in the dealership's language: whoever hits one
// of these is a salesperson mid-deal, not an engineer reading a stack trace.
// ─────────────────────────────────────────────────────────────────────────────

export const COMMITMENT_MESSAGES = {
  heldByAnotherDeal:
    "This vehicle is already committed to another deal. Release that commitment before starting a new one.",
  heldByAnotherDealSale:
    "This vehicle is already committed to another deal and cannot be sold on this one. Release the existing commitment first, or complete the sale on the deal that holds it.",
  heldByAnotherDealTradeIn:
    "That trade-in vehicle is already committed to another deal and cannot be taken in on this one.",
  heldByAnotherDealRemoval:
    "This vehicle is committed to a live deal and cannot be removed from inventory. Release the commitment first.",
  staleRevision:
    "This deal has moved on since that quote was written. Use the deal's current revision.",
  notTheHead:
    "That quote is no longer the deal's current head, so it cannot be superseded. Reload the deal and try again.",
  proofWrongCustomer: "That reservation does not belong to this customer, so it cannot be adopted.",
  proofWrongVehicle: "That reservation does not belong to this vehicle, so it cannot be adopted.",
  proofExpired: "That reservation has expired, so it can no longer be adopted.",
  proofReleased: "That reservation was already released, so it can no longer be adopted.",
  proofConsumed: "That reservation has already been taken up by another deal.",
} as const;

export type RootView =
  | {
      kind: "OWNED";
      rootId: Id<"commitmentRoots">;
      customerId: Id<"customers">;
      headQuoteId: Id<"quotes"> | null;
      revision: number;
    }
  | { kind: "FREE"; rootId: null; customerId: null; headQuoteId: null; revision: null };

const FREE: RootView = { kind: "FREE", rootId: null, customerId: null, headQuoteId: null, revision: null };

// ─────────────────────────────────────────────────────────────────────────────
// Reading the authority
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The OPEN root holding this car, if any.
 *
 * A root is only holding while at least one of its claims is ACTIVE. A root
 * whose claims have all been released is still a row — the deal may remain
 * financially open — but it no longer owns the car, which is the whole point of
 * keeping the ownership axis and the money axis apart.
 */
export async function findOwningRoot(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<Doc<"commitmentRoots"> | null> {
  const active = await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_org_vehicle_status", (q) =>
      q.eq("orgId", orgId).eq("vehicleId", vehicleId).eq("status", "ACTIVE")
    )
    .take(50);
  if (active.length === 0) return null;

  for (const claim of active) {
    const root = await ctx.db.get(claim.rootId);
    // A claim pointing at a non-OPEN root is stale bookkeeping, not ownership.
    // Skipping rather than trusting it keeps a half-finished release from
    // locking a car nobody is actually buying.
    if (root && root.status === "OPEN" && root.orgId === orgId) return root;
  }
  return null;
}

export async function resolveRootView(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<RootView> {
  const root = await findOwningRoot(ctx, orgId, vehicleId);
  if (!root) return FREE;
  return {
    kind: "OWNED",
    rootId: root._id,
    customerId: root.customerId,
    headQuoteId: root.headQuoteId ?? null,
    revision: root.revision,
  };
}

/**
 * Who owns this car — the canonical answer, for the UI and for tests.
 *
 * Read-only and org-scoped. Callers that need to ENFORCE ownership must use
 * `assertAcquirable` inside their own mutation rather than querying this and
 * deciding for themselves, so the check and the write share one transaction.
 */
export const resolveVehicleRoot = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
  },
  handler: async (ctx, args): Promise<RootView> => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_CUSTOMERS]);
    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }
    return await resolveRootView(ctx, args.orgId, args.vehicleId);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Enforcing the authority
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The single gate every acquisition path goes through.
 *
 * `actingRootId` is the caller's LINEAGE PROOF — the root the incoming evidence
 * belongs to. Passing `null` means "this evidence is on independent lineage",
 * and independent lineage can never take a car another root is holding.
 *
 * ⚠️ Omitted proof must stay refusable. An earlier design let an unproven
 * caller through whenever the customer happened to match, which collapses the
 * distinction between "the deal that holds this car" and "a person who also
 * has a deal". Those are different things and the second one is how a car gets
 * sold twice.
 */
export async function assertAcquirable(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    actingRootId: Id<"commitmentRoots"> | null;
    message?: string;
  }
): Promise<void> {
  const owner = await findOwningRoot(ctx, args.orgId, args.vehicleId);
  if (!owner) return;
  if (args.actingRootId && owner._id === args.actingRootId) return;
  throw new ConvexError(args.message ?? COMMITMENT_MESSAGES.heldByAnotherDeal);
}

/** The root a quote belongs to, or null when the quote predates SCRUM-195. */
export async function rootIdForQuote(
  ctx: QueryCtx | MutationCtx,
  quoteId: Id<"quotes"> | undefined | null
): Promise<Id<"commitmentRoots"> | null> {
  if (!quoteId) return null;
  const quote = await ctx.db.get(quoteId);
  return quote?.rootId ?? null;
}

/**
 * Refuse evidence written against a revision the deal has already moved past.
 *
 * This is a REDIRECT, not a block: the head must still accept the money, or a
 * renegotiation would strand the customer with nowhere to pay.
 */
export async function assertCurrentRevision(
  ctx: QueryCtx | MutationCtx,
  quoteId: Id<"quotes">
): Promise<void> {
  const quote = await ctx.db.get(quoteId);
  if (!quote) return;
  if (quote.supersededByQuoteId) {
    throw new ConvexError(COMMITMENT_MESSAGES.staleRevision);
  }
  if (!quote.rootId) return;
  const root = await ctx.db.get(quote.rootId);
  if (root?.headQuoteId && root.headQuoteId !== quoteId) {
    throw new ConvexError(COMMITMENT_MESSAGES.staleRevision);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing the authority
// ─────────────────────────────────────────────────────────────────────────────

export async function openRoot(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    customerId: Id<"customers">;
    createdBy: Id<"users">;
    headQuoteId?: Id<"quotes">;
    originReservationId?: Id<"vehicleReservations">;
  }
): Promise<Id<"commitmentRoots">> {
  return await ctx.db.insert("commitmentRoots", {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    customerId: args.customerId,
    status: "OPEN",
    headQuoteId: args.headQuoteId,
    revision: 1,
    originReservationId: args.originReservationId,
    createdAt: Date.now(),
    createdBy: args.createdBy,
  });
}

export async function attachClaim(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    rootId: Id<"commitmentRoots">;
    vehicleId: Id<"vehicles">;
    kind: "DEPOSIT" | "FINANCE" | "RESERVATION";
    createdBy: Id<"users">;
    depositId?: Id<"deposits">;
    applicationId?: Id<"financeApplications">;
    reservationId?: Id<"vehicleReservations">;
    quoteId?: Id<"quotes">;
  }
): Promise<Id<"vehicleCommitmentClaims">> {
  const claimId = await ctx.db.insert("vehicleCommitmentClaims", {
    orgId: args.orgId,
    rootId: args.rootId,
    vehicleId: args.vehicleId,
    kind: args.kind,
    status: "ACTIVE",
    depositId: args.depositId,
    applicationId: args.applicationId,
    reservationId: args.reservationId,
    quoteId: args.quoteId,
    createdAt: Date.now(),
    createdBy: args.createdBy,
  });
  // A root that had been released is live again the moment it holds something.
  const root = await ctx.db.get(args.rootId);
  if (root && root.status !== "OPEN") {
    await ctx.db.patch(args.rootId, { status: "OPEN", closedAt: undefined, closedReason: undefined });
  }
  return claimId;
}

/**
 * Resolve one claim, then recompute whether its root still holds the car.
 *
 * ⚠️ The recompute is the point. Releasing a finance application must NOT free
 * a car whose same-root deposit is still held — the customer's money is still
 * against it, and handing it to a rival at that moment is precisely the
 * double-book this module exists to prevent.
 */
export async function resolveClaim(
  ctx: MutationCtx,
  claimId: Id<"vehicleCommitmentClaims">,
  status: "RELEASED" | "CONSUMED",
  reason?: string
): Promise<void> {
  const claim = await ctx.db.get(claimId);
  if (!claim || claim.status !== "ACTIVE") return;
  await ctx.db.patch(claimId, { status, resolvedAt: Date.now(), resolvedReason: reason });
  await recomputeRootStatus(ctx, claim.rootId);
}

export async function recomputeRootStatus(
  ctx: MutationCtx,
  rootId: Id<"commitmentRoots">
): Promise<void> {
  const root = await ctx.db.get(rootId);
  if (!root) return;
  const stillActive = await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_root_status", (q) => q.eq("rootId", rootId).eq("status", "ACTIVE"))
    .first();
  if (stillActive) {
    if (root.status !== "OPEN") await ctx.db.patch(rootId, { status: "OPEN" });
    return;
  }
  const consumed = await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_root_status", (q) => q.eq("rootId", rootId).eq("status", "CONSUMED"))
    .first();
  // CONSUMED outranks RELEASED: a deal that completed into a sale is finished,
  // not merely let go, and the two must not be reported the same way.
  const next = consumed ? "CONSUMED" : "RELEASED";
  if (root.status !== next) {
    await ctx.db.patch(rootId, { status: next, closedAt: Date.now() });
  }
}

/** Every ACTIVE claim on a vehicle, whatever root or kind it belongs to. */
export async function activeClaimsForVehicle(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<Doc<"vehicleCommitmentClaims">[]> {
  return await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_org_vehicle_status", (q) =>
      q.eq("orgId", orgId).eq("vehicleId", vehicleId).eq("status", "ACTIVE")
    )
    .take(50);
}

/** The ACTIVE claim carrying a given piece of evidence, if there is one. */
export async function activeClaimForApplication(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<"financeApplications">
): Promise<Doc<"vehicleCommitmentClaims"> | null> {
  const claims = await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
    .take(50);
  return claims.find((c) => c.status === "ACTIVE") ?? null;
}

export async function claimsForApplication(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<"financeApplications">
): Promise<Doc<"vehicleCommitmentClaims">[]> {
  return await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
    .take(50);
}

export async function activeClaimForReservation(
  ctx: QueryCtx | MutationCtx,
  reservationId: Id<"vehicleReservations">
): Promise<Doc<"vehicleCommitmentClaims"> | null> {
  const claims = await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_reservation", (q) => q.eq("reservationId", reservationId))
    .take(50);
  return claims.find((c) => c.status === "ACTIVE") ?? null;
}

export async function activeClaimForDeposit(
  ctx: QueryCtx | MutationCtx,
  depositId: Id<"deposits">
): Promise<Doc<"vehicleCommitmentClaims"> | null> {
  const claims = await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_deposit", (q) => q.eq("depositId", depositId))
    .take(50);
  return claims.find((c) => c.status === "ACTIVE") ?? null;
}

/**
 * Mark every ACTIVE claim on a vehicle as CONSUMED, because the car has been
 * sold. Called from sale completion so a sold car stops reading as OWNED.
 */
export async function consumeClaimsForVehicle(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">,
  reason: string
): Promise<void> {
  const claims = await activeClaimsForVehicle(ctx, orgId, vehicleId);
  for (const claim of claims) {
    await ctx.db.patch(claim._id, {
      status: "CONSUMED",
      resolvedAt: Date.now(),
      resolvedReason: reason,
    });
  }
  const roots = new Set(claims.map((c) => c.rootId));
  for (const rootId of roots) {
    await recomputeRootStatus(ctx, rootId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reservation adoption (c14659 / c14833, restated by c14865)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate explicit proof that a quote may adopt a reservation's root.
 *
 * ⚠️ Every one of these refusals matters, and the reason they are separate
 * messages rather than one generic "invalid proof" is that they are separate
 * mistakes with separate remedies. A salesperson who picked the wrong customer
 * needs to hear that; a salesperson whose reservation lapsed needs to renew it.
 *
 * Adoption is never inferred. The customer matching is a NECESSARY condition,
 * not a sufficient one — that inference is exactly what c14865 ruled out.
 */
export async function validateReservationAdoption(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    reservationId: Id<"vehicleReservations">;
    customerId: Id<"customers">;
    vehicleId: Id<"vehicles">;
  }
): Promise<Doc<"vehicleReservations">> {
  const reservation = await ctx.db.get(args.reservationId);
  if (!reservation || reservation.orgId !== args.orgId) {
    throw new ConvexError(COMMITMENT_MESSAGES.proofWrongVehicle);
  }
  if (reservation.vehicleId !== args.vehicleId) {
    throw new ConvexError(COMMITMENT_MESSAGES.proofWrongVehicle);
  }
  if (reservation.customerId !== args.customerId) {
    throw new ConvexError(COMMITMENT_MESSAGES.proofWrongCustomer);
  }
  if (reservation.status === "RELEASED" || reservation.status === "EXPIRED") {
    throw new ConvexError(COMMITMENT_MESSAGES.proofReleased);
  }
  if (reservation.status === "CONVERTED") {
    throw new ConvexError(COMMITMENT_MESSAGES.proofConsumed);
  }
  if (reservation.expiresAt !== undefined && reservation.expiresAt <= Date.now()) {
    throw new ConvexError(COMMITMENT_MESSAGES.proofExpired);
  }
  return reservation;
}

/** The root a live reservation is holding the car under, if it has one. */
export async function rootIdForReservation(
  ctx: QueryCtx | MutationCtx,
  reservationId: Id<"vehicleReservations">
): Promise<Id<"commitmentRoots"> | null> {
  const claim = await activeClaimForReservation(ctx, reservationId);
  return claim?.rootId ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The advisory projection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether a FINANCE claim currently holds this car.
 *
 * c14865: an ACTIVE finance commitment participates in the advisory
 * `vehicle.status = RESERVED`, alongside deposits and reservations. It is still
 * only a projection — `syncVehicleHoldStatus` consumes this, and no guard may.
 */
export async function hasActiveFinanceClaim(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  const claims = await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_org_vehicle_status", (q) =>
      q.eq("orgId", orgId).eq("vehicleId", vehicleId).eq("status", "ACTIVE")
    )
    .take(50);
  return claims.some((c) => c.kind === "FINANCE");
}
