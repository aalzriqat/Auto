import { ConvexError, v } from "convex/values";
import { query, type QueryCtx, type MutationCtx } from "./_generated/server";
import { Doc, type Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { fromMinorUnits } from "./utils/money";
import { normalizeCurrency } from "./utils/depositRecording";
import { getOrgCurrency } from "./accounting/workflowHooks";

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
  /**
   * Names the remedy rather than just the refusal, because there are three
   * legitimate answers and only a person can pick one.
   */
  residualMoneyUndecided:
    "This deal is still holding money that came off another vehicle and has not been decided yet. Refund it, forfeit it or move it to another car before completing this sale.",
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
  /**
   * Reopening after a rejection is a real acquisition. Between the two, the car
   * was genuinely free, so somebody else may legitimately have taken it — and
   * saying so is kinder than a generic refusal, because the salesperson needs
   * to know the car is gone rather than that "something went wrong".
   */
  reopenLostTheCar:
    "This vehicle was committed to another deal while this application was rejected, so it cannot be reopened on the same car. Choose another vehicle or release the other commitment.",
  staleRevision:
    "This deal has moved on since that quote was written. Use the deal's current revision.",
  notTheHead:
    "That quote is no longer the deal's current head, so it cannot be superseded. Reload the deal and try again.",
  proofWrongCustomer: "That reservation does not belong to this customer, so it cannot be adopted.",
  proofWrongVehicle: "That reservation does not belong to this vehicle, so it cannot be adopted.",
  proofExpired: "That reservation has expired, so it can no longer be adopted.",
  proofReleased: "That reservation was already released, so it can no longer be adopted.",
  proofConsumed: "That reservation has already been taken up by another deal.",
  /**
   * Names the REMEDY, because the caller is not doing anything unreasonable —
   * they are continuing a deal that already exists and should revise its quote
   * rather than start a second one beside it.
   */
  proofAlreadyAdopted:
    "That reservation has already been adopted by a quote on this deal. Revise that quote instead of adopting the reservation again.",
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

/**
 * What quoting THIS customer for THIS car actually is: a new deal, a revision
 * of the one they already have, or a reservation they are about to convert.
 *
 * ⚠️ THE REASON THIS EXISTS. The two backend capabilities that carry a deal
 * forward — `intent: "REVISE"` with `supersedesQuoteId`, and
 * `adoptReservationId` — shipped with no client able to reach them: every one
 * of the four `saveQuote` call sites writes `intent: "NEW" as const` after
 * spreading its payload, so the literal wins by construction. The backend
 * enforced lineage the product never exposed, and the person on the shop floor
 * met the enforcement as an unexplained refusal on the customer's deposit.
 *
 * Rather than adding two fields nobody can be expected to reason about, this
 * answers the question in the salesperson's own terms and lets the screen say
 * what it is about to do. Lineage is a property of the SITUATION, not a
 * checkbox: the customer either already has this car spoken for or they do not.
 *
 * Read-only, and never a substitute for the mutation's own gate — `saveQuote`
 * re-derives all of this inside its transaction. What this buys is a screen
 * that explains itself before the refusal instead of after it.
 */
export type DealContinuation =
  /** Nothing holds this car for anyone. An ordinary new deal. */
  | { kind: "NEW" }
  /** Someone else's live deal has it. Saving would be refused. */
  | { kind: "HELD_BY_ANOTHER_DEAL" }
  /** Conflicting records — never proceed quietly past this. */
  | { kind: "AMBIGUOUS" }
  /** They reserved it. The quote should adopt that reservation. */
  | {
      kind: "ADOPT_RESERVATION";
      reservationId: Id<"vehicleReservations">;
      reservedAt: number;
      expiresAt: number | null;
      depositAmount: number | null;
    }
  /** They already have a quote on it. The new one should supersede it. */
  | {
      kind: "REVISE_QUOTE";
      quoteId: Id<"quotes">;
      vehiclePrice: number;
      createdAt: number;
      revision: number;
      /** Their money already on this deal — the floor the new price may not go under. */
      unresolvedMoneyMinor: number;
      /**
       * The same figure in major units, converted HERE because this is where
       * the org's currency is known. A client dividing by 100 gets JOD — three
       * decimal places — wrong by a factor of ten.
       */
      unresolvedMoney: number;
      currency: string;
    };

export const dealContinuation = query({
  args: {
    orgId: v.id("organizations"),
    vehicleId: v.id("vehicles"),
    customerId: v.id("customers"),
  },
  handler: async (ctx, args): Promise<DealContinuation> => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);

    const vehicle = await ctx.db.get(args.vehicleId);
    if (!vehicle || vehicle.orgId !== args.orgId) {
      throw new ConvexError("Vehicle not found in this organization.");
    }
    // The CUSTOMER is caller-supplied too, and it was never checked. Answering
    // for another organization's customer id leaks whether that person has a
    // deal on this car — small, but it is still their information, and a query
    // that authenticates the org and then trusts an id from outside it is the
    // shape this codebase already has two Criticals from.
    const customer = await ctx.db.get(args.customerId);
    if (!customer || customer.orgId !== args.orgId) {
      throw new ConvexError("Customer not found in this organization.");
    }

    const ownership = await resolveOwnership(ctx, args.orgId, args.vehicleId);
    if (ownership.kind === "AMBIGUOUS") return { kind: "AMBIGUOUS" };
    if (ownership.kind === "FREE") return { kind: "NEW" };
    if (ownership.root.customerId !== args.customerId) {
      return { kind: "HELD_BY_ANOTHER_DEAL" };
    }

    // A reservation-origin root has no head quote until a quote adopts it, so
    // this is checked first: it is the only state where adoption is the move.
    const reservationId = ownership.root.originReservationId;
    if (reservationId && !ownership.root.headQuoteId) {
      const reservation = await ctx.db.get(reservationId);
      const stillAdoptable =
        reservation !== null &&
        reservation.orgId === args.orgId &&
        reservation.status === "ACTIVE" &&
        (reservation.expiresAt === undefined || reservation.expiresAt > Date.now());
      if (reservation && stillAdoptable) {
        return {
          kind: "ADOPT_RESERVATION",
          reservationId,
          reservedAt: reservation.reservedAt,
          expiresAt: reservation.expiresAt ?? null,
          depositAmount: reservation.depositAmount ?? null,
        };
      }
    }

    const headQuoteId = ownership.root.headQuoteId;
    if (headQuoteId) {
      const head = await ctx.db.get(headQuoteId);
      if (head && head.orgId === args.orgId && !head.supersededByQuoteId) {
        const currency = normalizeCurrency(await getOrgCurrency(ctx, args.orgId));
        const unresolvedMinor = await unresolvedRootMoneyMinor(ctx, ownership.root._id);
        return {
          kind: "REVISE_QUOTE",
          quoteId: headQuoteId,
          vehiclePrice: head.vehiclePrice,
          createdAt: head._creationTime,
          revision: ownership.root.revision,
          unresolvedMoneyMinor: unresolvedMinor,
          unresolvedMoney: fromMinorUnits(unresolvedMinor, currency),
          currency,
        };
      }
    }

    // Their own deal, but nothing to point a successor at. `saveQuote` will
    // open an independent lineage, which is the honest answer here.
    return { kind: "NEW" };
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
    // A deal is not its primary car. On a multi-vehicle deal every vehicle has
    // its own root, and the claims on the SECOND car name the revision that
    // took them — so after a requote the successor proved lineage to the
    // primary root and to nothing else, and the deal was refused its own second
    // vehicle. Heading a root is lineage: `saveQuote` advances every root on
    // the deal to the successor precisely so this can be relied on.
    const root = await ctx.db.get(claim.rootId);
    if (root && root.status === "OPEN" && root.headQuoteId === quoteId) return claim.rootId;
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
 * Is this customer still owed an answer about a car OR about money?
 *
 * Asked before a customer can be REMOVED. `customers.remove` refused on live
 * leads and live sales and nothing else, so a customer with an unfinished deal
 * could simply be deleted out from under it.
 *
 * ⚠️ TWO AXES, and asking only the first one let a real customer be deleted.
 * The OWNERSHIP axis is an OPEN root — someone still holds a car. The MONEY
 * axis is unresolved funds, which outlive the ownership question: releasing a
 * reservation frees the car and closes its root while the deposit taken with it
 * stays HELD, refunded by nobody. c14909 drew that distinction for completion;
 * the same distinction governs deletion, and a version of this that tested only
 * for OPEN roots let a customer walk out of the system with 5,000 of their own
 * money unaccounted for.
 *
 * ⚠️ A closed root with no money left is HISTORY and must not refuse — that
 * would make a customer permanently undeletable because of a deal that ended
 * months ago.
 *
 * ⚠️ Asked HERE rather than in `customers.ts`. Three tables can hold a car, and
 * a caller that consults deposits, reservations and applications separately is
 * the exact shape of defect this module exists to end — it would go stale the
 * moment a fourth kind of evidence appears. One indexed question, one answer.
 *
 * Streams rather than taking a page: a customer with more roots than an
 * arbitrary limit must not read as having none.
 */
export async function unresolvedCommitmentForCustomer(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  customerId: Id<"customers">
): Promise<Doc<"commitmentRoots"> | null> {
  for await (const root of ctx.db
    .query("commitmentRoots")
    .withIndex("by_org_customer", (q) =>
      q.eq("orgId", orgId).eq("customerId", customerId)
    )) {
    if (root.status === "OPEN") return root;
    if ((await unresolvedRootMoneyMinor(ctx, root._id)) > 0) return root;
  }
  return null;
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
 * Give a reversal back the root it is undoing, instead of minting a new one.
 *
 * ⚠️ Completion CONSUMES the root, so by the time a cancellation restores the
 * deposit there is no OPEN root to join and `acquireVehicleForQuote` opened a
 * second one. That left TWO roots on one physical vehicle — the founding
 * invariant of this authority — with the quote still pointing at the dead first
 * one, so the money question and the acquisition question read different roots
 * for the same car.
 *
 * Refuses to reopen into a rival: if anything else legitimately holds the car
 * now, this returns null and the ordinary acquisition path decides what
 * happens, exactly as it did before. Reopening regardless is how one physical
 * unit ends up with two live claimants.
 */
export async function reopenRootForReversal(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    quoteId: Id<"quotes"> | null;
  }
): Promise<Id<"commitmentRoots"> | null> {
  if (!args.quoteId) return null;
  const quote = await ctx.db.get(args.quoteId);
  if (!quote?.rootId) return null;

  const root = await ctx.db.get(quote.rootId);
  if (!root || root.orgId !== args.orgId || root.vehicleId !== args.vehicleId) return null;
  if (root.status === "OPEN") return root._id;
  if (root.status !== "CONSUMED") return null;

  const ownership = await resolveOwnership(ctx, args.orgId, args.vehicleId);
  if (ownership.kind !== "FREE") return null;

  await ctx.db.patch(root._id, { status: "OPEN" });
  return root._id;
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
  // ⚠️ c14909: no claim is holding the car, but a deal is not finished while it
  // still owes somebody an answer about their money. A released share awaiting
  // a refund-or-forfeit decision is exactly that, and closing the root around
  // it strands the decision — nothing holds it open and nothing asks again.
  //
  // Staying OPEN does NOT re-hold the car: ownership is resolved from ACTIVE
  // CLAIMS, and there are none. This is the ownership axis and the money axis
  // coming apart in the direction they are supposed to — the car has left
  // inventory, the deal has not ended.
  const residualMinor = await residualUnsettledRootMoneyMinor(ctx, rootId);
  if (residualMinor > 0) {
    if (root.status !== "OPEN") {
      await ctx.db.patch(rootId, { status: "OPEN", closedAt: undefined, closedReason: undefined });
    }
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

// ─────────────────────────────────────────────────────────────────────────────
// ⚠️ NO FIXED PAGE ON THIS SIDE EITHER (c14908).
//
// Every read below is unbounded, and that is a correctness property rather than
// a tuning choice. The ownership resolver was fixed first and these were left
// capped at fifty rows, so helpers documented as releasing *every* claim
// released a page of them.
//
// It is the row-51 defect moved to the write side, and it fails worse. A
// false-free READ hands one car to a rival. A partial RELEASE leaves live
// claims behind an operation that reported success, and a partial CONSUME
// leaves ACTIVE claims on a car that has already been SOLD — a root still
// holding inventory that no longer exists to hold. Contracts 13.1–13.3
// reproduced exactly six survivors out of fifty-six, which is the cap and
// nothing else.
//
// Where the index is keyed by the evidence id (`by_deposit`, `by_reservation`,
// `by_application`) a status patch does not move the row, so collect-then-patch
// is safe. `activeClaimsForVehicle` is keyed by status, so its rows DO leave
// the range as they are resolved — it collects first and mutates afterwards,
// never while iterating.
// ─────────────────────────────────────────────────────────────────────────────

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
/**
 * Resolve the ACTIVE claims in a set, then ask EVERY root they touched again.
 *
 * ⚠️ THE SECOND LOOP IS NOT DECORATION, AND IT WAS MISSING.
 *
 * `resolveClaim` returns early unless a claim is ACTIVE, and it is the only
 * caller of `recomputeRootStatus`, which is the only thing that ever CLOSES a
 * root. So once a claim had already been released, the moment its MONEY was
 * finally resolved nothing recomputed the root — and nothing else ever would.
 * `deposits.resolveReleasedAllocation` already worked around this at its own
 * call site; its two siblings did not.
 *
 * `recomputeRootStatus` is idempotent and consults the MONEY as well as the
 * claims, so calling it when nothing changed is safe and a root whose money is
 * still undecided correctly stays OPEN (c14909, pinned by 28.1c).
 *
 * `kinds` narrows WHICH claims this evidence is entitled to release — see
 * `releaseClaimsForDeposit`.
 */
async function resolveClaimsAndRecomputeRoots(
  ctx: MutationCtx,
  claims: Doc<"vehicleCommitmentClaims">[],
  reason: string,
  kinds?: ReadonlyArray<"DEPOSIT" | "FINANCE" | "RESERVATION">
): Promise<void> {
  const touchedRootIds = new Set<string>();
  for (const claim of claims) {
    touchedRootIds.add(claim.rootId as unknown as string);
    if (claim.status !== "ACTIVE") continue;
    if (kinds && !kinds.includes(claim.kind)) continue;
    await resolveClaim(ctx, claim._id, "RELEASED", reason);
  }
  for (const rootId of touchedRootIds) {
    await recomputeRootStatus(ctx, rootId as unknown as Id<"commitmentRoots">);
  }
}

/**
 * Release the claims THIS DEPOSIT is the holding evidence for.
 *
 * ⚠️ SCOPED TO `kind: "DEPOSIT"`, and the scope is the whole point.
 *
 * A reservation's claim carries `depositId` too — it has to, or the
 * reservation's money could never reach its root. But that claim's evidence is
 * the RESERVATION, not the money: the customer reserved the car, and refunding
 * their deposit does not un-reserve it. Releasing by deposit alone took the car
 * away from a live, ACTIVE reservation and handed it to a rival — the exact
 * failure this module exists to prevent, reached through the fix that attached
 * `depositId` in the first place.
 *
 * A fix moves which lines are load-bearing. This is one of them.
 */
export async function releaseClaimsForDeposit(
  ctx: MutationCtx,
  depositId: Id<"deposits">,
  reason: string
): Promise<void> {
  const claims = await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_deposit", (q) => q.eq("depositId", depositId))
    .collect();
  await resolveClaimsAndRecomputeRoots(ctx, claims, reason, ["DEPOSIT"]);
}

/** Release every ACTIVE claim carried by one reservation. */
export async function releaseClaimsForReservation(
  ctx: MutationCtx,
  reservationId: Id<"vehicleReservations">,
  reason: string
): Promise<void> {
  const claims = await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_reservation", (q) => q.eq("reservationId", reservationId))
    .collect();
  for (const claim of claims) {
    if (claim.status !== "ACTIVE") continue;
    await resolveClaim(ctx, claim._id, "RELEASED", reason);
  }
}

/** Release every ACTIVE FINANCE claim carried by one application. */
export async function releaseClaimsForApplication(
  ctx: MutationCtx,
  applicationId: Id<"financeApplications">,
  reason: string
): Promise<void> {
  const claims = await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
    .collect();
  for (const claim of claims) {
    if (claim.status !== "ACTIVE") continue;
    await resolveClaim(ctx, claim._id, "RELEASED", reason);
  }
}

/**
 * Reopen a released application back onto THE ROOT IT RELEASED, or refuse.
 *
 * ⚠️ Reacquisition is a real acquisition, not a bookkeeping undo. Between the
 * rejection and the reopen the car was genuinely free, and somebody else may
 * have taken it — so this goes through `assertAcquirable` like any other
 * writer, and refuses if a rival root now owns it or if ownership is ambiguous.
 *
 * ⚠️ And it must land on the SAME concrete root. Minting a fresh one would
 * fragment the deal's lineage: its earlier money, revisions and audit trail all
 * hang off the original, and a reopened application pointing at a new root
 * quietly orphans them. A previous design "proved" this with
 * `String(rootId)` — where `String(undefined)` is `"undefined"`, truthy, and
 * equal to itself — so a resolver that never minted a root satisfied it. The
 * root id is carried on the released claim and compared as a real value.
 */
export async function reacquireForApplication(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    vehicleId: Id<"vehicles">;
    customerId: Id<"customers">;
    quoteId?: Id<"quotes">;
    createdBy: Id<"users">;
  }
): Promise<Id<"commitmentRoots"> | null> {
  const priorClaims = await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_application", (q) => q.eq("applicationId", args.applicationId))
    .collect();
  const forVehicle = priorClaims.filter((c) => c.vehicleId === args.vehicleId);
  if (forVehicle.some((c) => c.status === "ACTIVE")) return forVehicle[0].rootId;

  // Applications predating SCRUM-195 carry no claim at all; those acquire
  // fresh rather than being refused for a lineage they never had.
  const previous = forVehicle.sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!previous) {
    return await acquireVehicleForQuote(ctx, {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      quoteId: args.quoteId,
      customerId: args.customerId,
      createdBy: args.createdBy,
      kind: "FINANCE",
      applicationId: args.applicationId,
    });
  }

  const root = await ctx.db.get(previous.rootId);
  if (!root || root.orgId !== args.orgId) return null;

  await assertAcquirable(ctx, {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    actingRootId: root._id,
    message: COMMITMENT_MESSAGES.reopenLostTheCar,
  });

  await attachClaim(ctx, {
    orgId: args.orgId,
    rootId: root._id,
    vehicleId: args.vehicleId,
    kind: "FINANCE",
    createdBy: args.createdBy,
    applicationId: args.applicationId,
    quoteId: args.quoteId,
  });
  return root._id;
}

/**
 * Recompute every root that has a claim on this vehicle, of any status.
 *
 * ⚠️ Ordering, and it is not cosmetic. Sale completion consumes the claims
 * BEFORE it resolves the deposits, so at consume time the money still reads
 * HELD and the root correctly refuses to close. Nothing then asked again, and
 * an ordinary finished deal stayed open forever — the mirror of the c14909
 * defect, produced by fixing it.
 *
 * So the money settles, and then the root is asked one more time.
 */
export async function recomputeRootsForVehicle(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<void> {
  const rootIds = new Set<Id<"commitmentRoots">>();
  for await (const claim of ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_org_vehicle_status", (q) =>
      q.eq("orgId", orgId).eq("vehicleId", vehicleId).eq("status", "CONSUMED")
    )) {
    rootIds.add(claim.rootId);
  }
  for await (const claim of ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_org_vehicle_status", (q) =>
      q.eq("orgId", orgId).eq("vehicleId", vehicleId).eq("status", "RELEASED")
    )) {
    rootIds.add(claim.rootId);
  }
  for (const rootId of rootIds) {
    await recomputeRootStatus(ctx, rootId);
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
    .collect();
}

/** The ACTIVE claim carrying a given piece of evidence, if there is one. */
export async function activeClaimForApplication(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<"financeApplications">
): Promise<Doc<"vehicleCommitmentClaims"> | null> {
  const claims = await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
    .collect();
  return claims.find((c) => c.status === "ACTIVE") ?? null;
}

export async function claimsForApplication(
  ctx: QueryCtx | MutationCtx,
  applicationId: Id<"financeApplications">
): Promise<Doc<"vehicleCommitmentClaims">[]> {
  return await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
    .collect();
}

export async function activeClaimForReservation(
  ctx: QueryCtx | MutationCtx,
  reservationId: Id<"vehicleReservations">
): Promise<Doc<"vehicleCommitmentClaims"> | null> {
  const claims = await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_reservation", (q) => q.eq("reservationId", reservationId))
    .collect();
  return claims.find((c) => c.status === "ACTIVE") ?? null;
}

export async function activeClaimForDeposit(
  ctx: QueryCtx | MutationCtx,
  depositId: Id<"deposits">
): Promise<Doc<"vehicleCommitmentClaims"> | null> {
  const claims = await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_deposit", (q) => q.eq("depositId", depositId))
    .collect();
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
// Root-wide money
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every deposit that belongs to a root, across every revision of the deal.
 *
 * Gathered from the quotes in the lineage AND from the root's own claims,
 * because those two sets are not the same: a claim can outlive the quote that
 * created it, and a superseded quote still carries the money paid against it.
 */
async function depositsForRoot(
  ctx: QueryCtx | MutationCtx,
  rootId: Id<"commitmentRoots">
): Promise<Doc<"deposits">[]> {
  const byId = new Map<string, Doc<"deposits">>();

  for await (const quote of ctx.db
    .query("quotes")
    .withIndex("by_root", (q) => q.eq("rootId", rootId))) {
    for await (const deposit of ctx.db
      .query("deposits")
      .withIndex("by_quote", (q) => q.eq("quoteId", quote._id))) {
      byId.set(deposit._id, deposit);
    }
  }

  for await (const claim of ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_root", (q) => q.eq("rootId", rootId))) {
    if (!claim.depositId) continue;
    if (byId.has(claim.depositId as unknown as string)) continue;
    const deposit = await ctx.db.get(claim.depositId);
    if (deposit) byId.set(deposit._id, deposit);
  }

  return Array.from(byId.values());
}

/**
 * How much of the customer's money this deal is still economically holding, in
 * minor units.
 *
 * ⚠️ NOT `amountMinor - releasedAmountMinor`, and not the deposits filed under
 * one quote id. The first counts a partially refunded row as though the
 * remainder had never been paid; the second loses everything the customer paid
 * before the last renegotiation, which is precisely the money a requote must
 * not be allowed to strand.
 *
 * Counted (non-terminal): ALLOCATED · APPLIED while still economically live ·
 * REVERSING · RELEASED_AWAITING_DECISION · and money carrying no allocation
 * rows at all — the ordinary single-vehicle deposit, and the easiest to miss
 * precisely because there is nothing in `depositVehicleHolds` to find.
 *
 * Excluded (terminal): refunded and forfeited slices, and VOIDED or deleted
 * rows, which are not money the dealership still owes an answer for.
 */
/**
 * The part of a deposit row that has TERMINALLY left the deal, in minor units.
 *
 * ⚠️ Read the row DOWNWARD, never the holds upward. Summing allocation slices
 * looks equivalent and is not: a multi-vehicle deposit writes a
 * `depositVehicleHolds` row per car carrying `active: true` and NO
 * `allocatedAmountMinor` and NO `allocationStatus` — nothing is allocated yet —
 * so every slice contributed `?? 0` and a whole 20,000 deposit read as ZERO
 * money on the deal. The ceiling then let a second 20,000 through against a
 * 30,000 quote. The single-vehicle path was correct the whole time, because it
 * has no holds to sum and fell back to the row.
 *
 * Only two things genuinely take money off a deal: paying it out at the row
 * level, and a slice resolved to a terminal treatment. Everything else —
 * allocated, applied, reversing, awaiting a decision, returned to the pool, or
 * never allocated at all — is still the customer's money on this deal.
 *
 * The terminal-treatment filter mirrors the canonical one in
 * `utils/depositHelpers.releaseHeldDeposit`; RETURN_TO_UNALLOCATED is
 * deliberately absent from it, because that money came back onto the deal.
 */
function terminallyLeftTheDealMinor(
  deposit: Doc<"deposits">,
  holds: Doc<"depositVehicleHolds">[]
): number {
  // ⚠️ `OTHER` IS DELIBERATELY ABSENT, and this filter is NOT the one in
  // `releaseHeldDeposit` even though it once was a copy of it. That one answers
  // "may this amount be disposed of again"; this one claims "did this money
  // financially LEAVE the deal". They are different questions, and `OTHER` is
  // exactly where they diverge: it posts no journal, moves no money and leaves
  // the row HELD, awaiting a manual correction. Counting it as gone let 3,000
  // of a customer's money vanish from the ceiling while the dealership still
  // held it.
  //
  // FAIL CLOSED. `OTHER` means a person did something this system does not
  // model, so we cannot know the money left — and the only safe assumption is
  // that it did not. It keeps counting against the deal, which can only ever
  // refuse more, never allow more.
  const finalizedSlicesMinor = holds
    .filter(
      (h) =>
        h.allocationStatus === "RESOLVED" &&
        (h.resolutionTreatment === "REFUND_TO_CUSTOMER" ||
          h.resolutionTreatment === "FORFEITED")
    )
    .reduce((sum, h) => sum + (h.allocatedAmountMinor ?? 0), 0);
  return (deposit.releasedAmountMinor ?? 0) + finalizedSlicesMinor;
}

export async function unresolvedRootMoneyMinor(
  ctx: QueryCtx | MutationCtx,
  rootId: Id<"commitmentRoots">
): Promise<number> {
  const deposits = await depositsForRoot(ctx, rootId);
  let total = 0;

  for (const deposit of deposits) {
    if (deposit.isDeleted === true) continue;
    if (deposit.status === "VOIDED") continue;
    if (deposit.status === "REFUNDED" || deposit.status === "FORFEITED") continue;

    const holds: Doc<"depositVehicleHolds">[] = [];
    for await (const hold of ctx.db
      .query("depositVehicleHolds")
      .withIndex("by_deposit", (q) => q.eq("depositId", deposit._id))) {
      holds.push(hold);
    }

    // The row is the bucket, whether or not it has been carved into slices.
    total += Math.max(0, (deposit.amountMinor ?? 0) - terminallyLeftTheDealMinor(deposit, holds));
  }

  return total;
}

/**
 * Every deposit on the DEAL this quote belongs to, across all its revisions.
 *
 * Completion has to resolve the customer's money, and money paid against an
 * earlier revision is still theirs: a deal that took 5,000 on Q1 and completed
 * on a linked Q2 would otherwise finish with that 5,000 stranded on a
 * superseded quote — not refunded, not applied, just orphaned. Falls back to
 * the single quote for rows that predate SCRUM-195 and carry no root.
 */
export async function depositsForQuoteLineage(
  ctx: QueryCtx | MutationCtx,
  quoteId: Id<"quotes">
): Promise<Doc<"deposits">[]> {
  const quote = await ctx.db.get(quoteId);
  if (!quote?.rootId) {
    const own: Doc<"deposits">[] = [];
    for await (const deposit of ctx.db
      .query("deposits")
      .withIndex("by_quote", (q) => q.eq("quoteId", quoteId))) {
      own.push(deposit);
    }
    return own;
  }
  return await depositsForRoot(ctx, quote.rootId);
}

/**
 * How much of the customer's money still needs a DECISION from somebody.
 *
 * ⚠️ A different question from `unresolvedRootMoneyMinor`, and the difference is
 * exactly APPLIED. That one asks "how much of their money is on this deal",
 * which is the ceiling a further deposit is measured against, and applied money
 * counts because it cannot be spent twice. This one asks "is this deal
 * finished", and applied money is finished — it went to the sale it was for.
 *
 * What remains is money nobody has decided about: a released share awaiting a
 * refund-or-forfeit ruling, an allocation never consumed, a reversal mid-flight,
 * or a deposit sitting unallocated. A deal carrying any of it is not over,
 * however sold the car is.
 */
export async function residualUnsettledRootMoneyMinor(
  ctx: QueryCtx | MutationCtx,
  rootId: Id<"commitmentRoots">
): Promise<number> {
  const deposits = await depositsForRoot(ctx, rootId);
  let total = 0;

  for (const deposit of deposits) {
    if (deposit.isDeleted === true) continue;
    if (deposit.status === "VOIDED") continue;
    if (deposit.status === "REFUNDED" || deposit.status === "FORFEITED") continue;

    const holds: Doc<"depositVehicleHolds">[] = [];
    for await (const hold of ctx.db
      .query("depositVehicleHolds")
      .withIndex("by_deposit", (q) => q.eq("depositId", deposit._id))) {
      holds.push(hold);
    }

    if (holds.length === 0) {
      // No allocation rows: only money still HELD is undecided. APPLIED single
      // vehicle deposits went to their sale and are done.
      if (deposit.status !== "HELD") continue;
      total += Math.max(0, (deposit.amountMinor ?? 0) - (deposit.releasedAmountMinor ?? 0));
      continue;
    }

    // Same row-down arithmetic as `unresolvedRootMoneyMinor` — an unallocated
    // multi-vehicle deposit read as zero here too, so a deal still holding the
    // customer's whole 20,000 answered "finished" — with APPLIED subtracted as
    // well, because applied money went to the sale it was for and is decided.
    const appliedMinor = holds
      .filter((h) => h.allocationStatus === "APPLIED")
      .reduce((sum, h) => sum + (h.allocatedAmountMinor ?? 0), 0);
    total += Math.max(
      0,
      (deposit.amountMinor ?? 0) - terminallyLeftTheDealMinor(deposit, holds) - appliedMinor
    );
  }

  return total;
}

/**
 * Money on this deal that is waiting for a PERSON to decide what happens to it.
 *
 * ⚠️ The name and the signature were both wrong before, and the owner caught it.
 * This was called `residualAfterCompletionMinor`, took a `completingVehicleId`
 * it never used, and claimed to "subtract what this completion settles". It
 * does no subtraction at all — it counts two buckets.
 *
 * The subtraction was real in the first version and was removed for a good
 * reason: it also counted another car's still-ALLOCATED slice, which refused
 * every ordinary multi-vehicle completion. Allocated money is not undecided; it
 * is assigned to a car and waiting for that car's own sale. Once the buckets
 * narrowed to the genuinely undecided ones, the completing vehicle stopped
 * mattering — but the name, the parameter and the comment all stayed behind
 * describing a design that no longer existed.
 *
 * Counted: RELEASED_AWAITING_DECISION — money taken off a vehicle and waiting
 * for refund, forfeit or reallocation — and REVERSING, which is the same
 * question caught mid-unwind.
 *
 * c14909: that decision has to happen BEFORE a sale completes, not after.
 * Completing around it finalises the sale, posts the accounting and hands over
 * the car while part of the customer's money is unattributed, and nothing
 * afterwards is obliged to come back and ask.
 */
export async function awaitingDecisionMoneyMinor(
  ctx: QueryCtx | MutationCtx,
  rootId: Id<"commitmentRoots">
): Promise<number> {
  const deposits = await depositsForRoot(ctx, rootId);
  let total = 0;

  for (const deposit of deposits) {
    if (deposit.isDeleted === true) continue;
    if (deposit.status === "VOIDED") continue;
    if (deposit.status === "REFUNDED" || deposit.status === "FORFEITED") continue;

    const holds: Doc<"depositVehicleHolds">[] = [];
    for await (const hold of ctx.db
      .query("depositVehicleHolds")
      .withIndex("by_deposit", (q) => q.eq("depositId", deposit._id))) {
      holds.push(hold);
    }

    // A single-vehicle deposit has nothing detached from a car, so there is
    // nothing here that could be awaiting a decision.
    if (holds.length === 0) continue;

    for (const hold of holds) {
      // ⚠️ ONLY the genuinely UNDECIDED buckets, and the narrowness is the
      // point. An earlier version also counted another car's ALLOCATED slice,
      // which refused every ordinary multi-vehicle completion — two shipped
      // tests caught it. Allocated money is not undecided: it is assigned to a
      // car and waiting for that car's own sale.
      //
      // What blocks a completion is money that has come OFF a vehicle and is
      // waiting for a person to say refund, forfeit or move it — plus a
      // reversal still in flight, which is the same thing mid-unwind.
      if (
        hold.allocationStatus === "RELEASED_AWAITING_DECISION" ||
        hold.allocationStatus === "REVERSING"
      ) {
        total += hold.allocatedAmountMinor ?? 0;
      }
    }
  }

  return total;
}

/** The same figure for whichever root a quote belongs to; zero when it has none. */
export async function unresolvedMoneyForQuoteMinor(
  ctx: QueryCtx | MutationCtx,
  quoteId: Id<"quotes">
): Promise<number> {
  const quote = await ctx.db.get(quoteId);
  if (!quote?.rootId) return 0;
  return await unresolvedRootMoneyMinor(ctx, quote.rootId);
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
  // ⚠️ ONCE. Adoption stamps the quote's `rootId` but nothing marked the
  // reservation as taken up, so the same live reservation could be adopted
  // twice — leaving two quotes on one root, neither superseding the other, both
  // passing `assertCurrentRevision` because the root had no head, and both able
  // to attach money at different prices. A deal with two live heads is not a
  // deal. The head is what makes the second attempt refusable.
  const adoptedRootId = await rootIdForReservation(ctx, args.reservationId);
  if (adoptedRootId) {
    const adoptedRoot = await ctx.db.get(adoptedRootId);
    if (adoptedRoot?.headQuoteId) {
      throw new ConvexError(COMMITMENT_MESSAGES.proofAlreadyAdopted);
    }
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
  // Streamed with an early exit on the first match. The index is keyed by
  // status rather than kind, so a fixed page could miss a FINANCE claim sitting
  // behind other kinds — the same row-51 shape, and this one decides whether a
  // held car looks available on the lot.
  for await (const claim of ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_org_vehicle_status", (q) =>
      q.eq("orgId", orgId).eq("vehicleId", vehicleId).eq("status", "ACTIVE")
    )) {
    if (claim.kind === "FINANCE") return true;
  }
  return false;
}
