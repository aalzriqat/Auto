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
  /**
   * Legacy multi-root state. Deliberately says the ownership CANNOT BE
   * DETERMINED rather than that the car is taken — because "taken by whom" is
   * precisely what is unknown, and a manager needs to know this is a records
   * problem to be fixed, not a rival deal to be negotiated around.
   */
  ambiguousOwnership:
    "This vehicle's ownership cannot be determined: it carries conflicting commitment records. Resolve the conflicting deals before it can be committed or sold.",
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
      conflictingRootIds: Id<"commitmentRoots">[];
    }
  | {
      kind: "FREE";
      rootId: null;
      customerId: null;
      headQuoteId: null;
      revision: null;
      conflictingRootIds: Id<"commitmentRoots">[];
    }
  | {
      kind: "AMBIGUOUS";
      rootId: null;
      customerId: null;
      headQuoteId: null;
      revision: null;
      conflictingRootIds: Id<"commitmentRoots">[];
    };

const FREE_VIEW: RootView = {
  kind: "FREE",
  rootId: null,
  customerId: null,
  headQuoteId: null,
  revision: null,
  conflictingRootIds: [],
};

/** The internal answer, before it is flattened for the wire. */
export type Ownership =
  | { kind: "FREE" }
  | { kind: "OWNED"; root: Doc<"commitmentRoots"> }
  | { kind: "AMBIGUOUS"; conflictingRootIds: Id<"commitmentRoots">[] };

// ─────────────────────────────────────────────────────────────────────────────
// Reading the authority
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Who holds this car: nobody, exactly one root, or — in legacy data — more than
 * one, which is its own answer rather than a tie to be broken.
 *
 * ⚠️ NO FIXED PAGE. This streams the ACTIVE-claim index instead of taking a
 * page, because the decisive owner can sit at any position. An earlier version
 * of this function took 50 rows and answered from them, so a car whose owner
 * was at row 51 reported FREE — and FREE is the answer that hands a sold car to
 * a rival. A cap is not a performance detail when the thing being capped is the
 * evidence that a car is already spoken for. (c14867, "row-51".)
 *
 * ⚠️ AND NO TIE-BREAK. Two OPEN roots on one physical car is corrupt historical
 * state that no public writer may create. Meeting it, the honest answers are
 * "I cannot tell" and a refusal. Picking the oldest, the newest, the first
 * encountered, or the one whose customer matches the caller all invent an owner
 * out of broken data and then let somebody sell a car on the strength of it.
 *
 * Cost is one index scan plus one read per DISTINCT root — the fifty stale rows
 * of a single released deal cost one root read between them, not fifty.
 */
export async function resolveOwnership(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<Ownership> {
  const inspected = new Map<string, Doc<"commitmentRoots"> | null>();
  const openRoots: Doc<"commitmentRoots">[] = [];

  for await (const claim of ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_org_vehicle_status", (q) =>
      q.eq("orgId", orgId).eq("vehicleId", vehicleId).eq("status", "ACTIVE")
    )) {
    const key = claim.rootId as unknown as string;
    if (inspected.has(key)) continue;
    const root = await ctx.db.get(claim.rootId);
    // A claim pointing at a non-OPEN root is stale bookkeeping, not ownership.
    // Skipping it rather than trusting it keeps a half-finished release from
    // locking a car nobody is actually buying — which is what contract 11.2
    // exists to hold on to.
    const decisive = root && root.orgId === orgId && root.status === "OPEN" ? root : null;
    inspected.set(key, decisive);
    if (decisive) openRoots.push(decisive);
  }

  if (openRoots.length === 0) return { kind: "FREE" };
  if (openRoots.length === 1) return { kind: "OWNED", root: openRoots[0] };
  return { kind: "AMBIGUOUS", conflictingRootIds: openRoots.map((r) => r._id) };
}

/**
 * ⚠️ THERE IS DELIBERATELY NO `findOwningRoot(...) => Root | null` HERE.
 *
 * One existed, returning `null` for both FREE and AMBIGUOUS with a comment
 * saying "never enforce with this". A convenience that collapses *permit* and
 * *must refuse* into one value, kept next to the guards that must tell them
 * apart, is a trap with a label on it — and the label is only load-bearing
 * until somebody reaches for the obvious-looking helper. It had no callers, so
 * it is gone rather than documented.
 *
 * Enforcement goes through `assertAcquirable`. Display goes through
 * `resolveRootView`, which keeps all three states distinct on the wire.
 */

export async function resolveRootView(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<RootView> {
  const ownership = await resolveOwnership(ctx, orgId, vehicleId);
  if (ownership.kind === "FREE") return FREE_VIEW;
  if (ownership.kind === "AMBIGUOUS") {
    return {
      kind: "AMBIGUOUS",
      rootId: null,
      customerId: null,
      headQuoteId: null,
      revision: null,
      conflictingRootIds: ownership.conflictingRootIds,
    };
  }
  return {
    kind: "OWNED",
    rootId: ownership.root._id,
    customerId: ownership.root.customerId,
    headQuoteId: ownership.root.headQuoteId ?? null,
    revision: ownership.root.revision,
    conflictingRootIds: [],
  };
}

/**
 * Whether this vehicle is safe for the canonical authority to act on.
 *
 * False while ambiguous. Cutover readiness is a property of the DATA, not of
 * the deployment, so it is asked per vehicle rather than assumed once.
 */
export async function isCutoverReady(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  const ownership = await resolveOwnership(ctx, orgId, vehicleId);
  return ownership.kind !== "AMBIGUOUS";
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
  const ownership = await resolveOwnership(ctx, args.orgId, args.vehicleId);

  // ⚠️ Ambiguity refuses BEFORE the lineage check, and refuses the insider too.
  // A caller who genuinely belongs to one of two conflicting roots still cannot
  // be granted the car: being one of two claimants says nothing about which one
  // owns it, and letting that through is exactly how corrupt legacy data turns
  // into a real sale. (c14867.)
  if (ownership.kind === "AMBIGUOUS") {
    throw new ConvexError(COMMITMENT_MESSAGES.ambiguousOwnership);
  }
  if (ownership.kind === "FREE") return;
  if (args.actingRootId && ownership.root._id === args.actingRootId) return;
  throw new ConvexError(args.message ?? COMMITMENT_MESSAGES.heldByAnotherDeal);
}

/**
 * The root this QUOTE already holds THIS VEHICLE under, if any — the caller's
 * lineage proof.
 *
 * Two ways a quote can prove lineage, and both are needed:
 *
 *   - `quote.rootId`, inherited when the quote superseded another revision or
 *     adopted a reservation. Checked against the root's own `vehicleId`,
 *     because a multi-vehicle quote spans several roots and the stamped one
 *     only ever refers to the first;
 *   - an ACTIVE claim this same quote already created on this same vehicle,
 *     which is what carries lineage for every vehicle after the first.
 *
 * No quote means no proof. That is not an oversight — evidence written with no
 * lineage is independent lineage, and independent lineage cannot take a car
 * somebody else is holding.
 */
export async function actingRootForQuoteOnVehicle(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  quoteId: Id<"quotes"> | undefined | null,
  vehicleId: Id<"vehicles">
): Promise<Id<"commitmentRoots"> | null> {
  if (!quoteId) return null;

  const quote = await ctx.db.get(quoteId);
  if (quote?.rootId) {
    const root = await ctx.db.get(quote.rootId);
    if (root && root.orgId === orgId && root.vehicleId === vehicleId && root.status === "OPEN") {
      return root._id;
    }
  }

  for await (const claim of ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_org_vehicle_status", (q) =>
      q.eq("orgId", orgId).eq("vehicleId", vehicleId).eq("status", "ACTIVE")
    )) {
    if (claim.quoteId === quoteId) return claim.rootId;
  }
  return null;
}

/**
 * Take a car for a deal, or refuse — the one call every acquisition path makes.
 *
 * Creates the root when this is the deal's first claim on this car, joins the
 * existing root when the quote proves lineage to it, and refuses otherwise.
 * Because the check and the write happen here, in the caller's own mutation,
 * they share a transaction: a refusal leaves no claim, no root, and no half-
 * acquired car behind.
 */
export async function acquireVehicleForQuote(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    quoteId?: Id<"quotes"> | null;
    customerId: Id<"customers">;
    createdBy: Id<"users">;
    kind: "DEPOSIT" | "FINANCE" | "RESERVATION";
    depositId?: Id<"deposits">;
    applicationId?: Id<"financeApplications">;
    reservationId?: Id<"vehicleReservations">;
    message?: string;
  }
): Promise<Id<"commitmentRoots">> {
  const actingRootId = await actingRootForQuoteOnVehicle(
    ctx,
    args.orgId,
    args.quoteId,
    args.vehicleId
  );

  await assertAcquirable(ctx, {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    actingRootId,
    message: args.message,
  });

  let rootId = actingRootId;
  if (!rootId) {
    rootId = await openRoot(ctx, {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      customerId: args.customerId,
      createdBy: args.createdBy,
      headQuoteId: args.quoteId ?? undefined,
      originReservationId: args.kind === "RESERVATION" ? args.reservationId : undefined,
    });
    // Stamp the quote only if it has no root yet: on a multi-vehicle deal the
    // first vehicle claims the field and the rest carry lineage through their
    // own claims.
    if (args.quoteId) {
      const quote = await ctx.db.get(args.quoteId);
      if (quote && !quote.rootId) await ctx.db.patch(args.quoteId, { rootId });
    }
  }

  await attachClaim(ctx, {
    orgId: args.orgId,
    rootId,
    vehicleId: args.vehicleId,
    kind: args.kind,
    createdBy: args.createdBy,
    depositId: args.depositId,
    applicationId: args.applicationId,
    reservationId: args.reservationId,
    quoteId: args.quoteId ?? undefined,
  });

  return rootId;
}

/**
 * Refuse to take a car OUT of inventory while a live deal holds it.
 *
 * Removal has no lineage to offer — nobody soft-deletes a car "on behalf of"
 * the deal holding it — so there is no acting root and any live commitment
 * refuses. Ambiguity refuses too: a car with conflicting records is exactly the
 * one that must not quietly vanish from the lot.
 */
export async function assertRemovableFromInventory(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">,
  message?: string
): Promise<void> {
  await assertAcquirable(ctx, {
    orgId,
    vehicleId,
    actingRootId: null,
    message: message ?? COMMITMENT_MESSAGES.heldByAnotherDealRemoval,
  });
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

/**
 * Release every ACTIVE DEPOSIT claim on this car.
 *
 * Called when a deal lets a CAR go while the deal itself continues — a released
 * allocation on a multi-vehicle quote is the ordinary case. The root stays open
 * if any other claim still stands, because `resolveClaim` recomputes rather
 * than assuming; only when nothing holds the car does it become acquirable
 * again.
 */
export async function releaseDepositClaimsForVehicle(
  ctx: MutationCtx,
  vehicleId: Id<"vehicles">,
  reason: string
): Promise<void> {
  const vehicle = await ctx.db.get(vehicleId);
  if (!vehicle) return;
  const claims = await activeClaimsForVehicle(ctx, vehicle.orgId, vehicleId);
  for (const claim of claims) {
    if (claim.kind !== "DEPOSIT") continue;
    await resolveClaim(ctx, claim._id, "RELEASED", reason);
  }
}

/** Release every ACTIVE claim carried by one deposit, across every car it holds. */
export async function releaseClaimsForDeposit(
  ctx: MutationCtx,
  depositId: Id<"deposits">,
  reason: string
): Promise<void> {
  const claims = await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_deposit", (q) => q.eq("depositId", depositId))
    .take(50);
  for (const claim of claims) {
    if (claim.status !== "ACTIVE") continue;
    await resolveClaim(ctx, claim._id, "RELEASED", reason);
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
