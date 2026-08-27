/**
 * SCRUM-195 — THE VEHICLE COMMITMENT AUTHORITY.
 *
 * Who holds a physical car, on the strength of what evidence, and under which
 * deal. This module is the ONLY place those questions are answered.
 *
 * ## Why this exists at all
 *
 * Before it, a cancelled sale restored the customer's MONEY and nothing held
 * the car: no claim, no root, no acquirability check. A rival could take a
 * vehicle the original customer had already paid on, and every control agreed
 * the books were fine — because they were. The money simply never moved.
 *
 * ## The two rules that shape this file (owner rulings c15584 / c15586)
 *
 * **M1 — ACQUISITION TAKES A ROOT, NEVER A HINT.** The previous attempt spread
 * the question "which root does this belong to?" across six independent
 * writers, three of which could arrive with no lineage at all and silently
 * degraded that into "open a new root". One physical car ended up with two
 * roots. So the decision lives in exactly one function, `resolveActingRoot`,
 * and it returns an EXPLICIT decision — JOIN, OPEN_NEW or REFUSE. There is no
 * null that quietly means "create one".
 *
 * **M2 — EVIDENCE IS TAGGED, CARRIED, AND NEVER RE-DERIVED.** The same attempt
 * hardcoded `kind: "DEPOSIT"` in three writers, so a reservation's own deposit
 * came back as a DEPOSIT-kind claim on RESERVATION evidence. Evidence is now a
 * tagged union that travels with the operation; a restoration carries its
 * predecessor's tag rather than assuming a default.
 *
 * ## Invariants (c15584 §1). Each is enforced HERE, not assumed by callers.
 *
 *   I1  one physical vehicle → at most one OPEN root
 *   I2  root identity is server-owned, never (customerId, vehicleId)
 *   I3  `quoteId` is lineage PROOF, not identity
 *   I5  a claim row is ONE acquisition episode
 *   I6  CONSUMED / RELEASED are terminal FOREVER
 *   I7  a reacquisition is a NEW row on the same root + vehicle + evidence,
 *       carrying a typed predecessor link
 *   I10 a claim pointing at a non-OPEN root is stale bookkeeping, not ownership
 */

import { ConvexError } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";

// ─────────────────────────────────────────────────────────────────────────────
// Refusal messages. Deliberately in the dealership's language: whoever hits one
// is standing in front of a customer, not reading a stack trace.
// ─────────────────────────────────────────────────────────────────────────────

export const COMMITMENT_MESSAGES = {
  heldByAnotherDeal:
    "This vehicle is already committed to another deal. Release that commitment before starting a new one.",
  heldByAnotherDealSale:
    "This vehicle is already committed to another deal and cannot be sold on this one. Release the existing commitment first, or complete the sale on the deal that holds it.",
  heldByAnotherDealTradeIn:
    "That trade-in vehicle is already committed to another deal and cannot be taken in on this one.",
  /**
   * Two OPEN roots on one physical car is corrupt state, not a tie to be
   * broken. Refusing loudly is the only safe answer: picking one would hand the
   * car to whichever deal happened to sort first.
   */
  ambiguousOwnership:
    "This vehicle has conflicting commitment records and cannot be acted on until they are resolved. Please contact support.",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// M2 — evidence is a tagged union.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ⚠️ The tag is the DEFINING reference, not "whichever id happens to be set".
 *
 * A reservation legitimately carries the deposit taken alongside it, so a row
 * can hold two references. Reading the evidence as
 * `depositId ?? applicationId ?? reservationId` reported that deposit as a
 * reservation's evidence and let the reservation reference drift unnoticed.
 */
export type CommitmentEvidence =
  | { kind: "DEPOSIT"; depositId: Id<"deposits"> }
  | { kind: "FINANCE"; applicationId: Id<"financeApplications"> }
  | {
      kind: "RESERVATION";
      reservationId: Id<"vehicleReservations">;
      /** Context, never the defining reference. */
      depositId?: Id<"deposits">;
    };

/** The evidence a stored episode was opened on, reconstructed from its tag. */
export function evidenceOf(claim: Doc<"vehicleCommitmentClaims">): CommitmentEvidence {
  switch (claim.evidenceKind) {
    case "DEPOSIT":
      if (!claim.depositId) throw new Error(`claim ${claim._id} is DEPOSIT with no depositId`);
      return { kind: "DEPOSIT", depositId: claim.depositId };
    case "FINANCE":
      if (!claim.applicationId)
        throw new Error(`claim ${claim._id} is FINANCE with no applicationId`);
      return { kind: "FINANCE", applicationId: claim.applicationId };
    case "RESERVATION":
      if (!claim.reservationId)
        throw new Error(`claim ${claim._id} is RESERVATION with no reservationId`);
      return {
        kind: "RESERVATION",
        reservationId: claim.reservationId,
        ...(claim.depositId ? { depositId: claim.depositId } : {}),
      };
  }
}

/** The reference that DEFINES an evidence value, for identity comparisons. */
export function evidenceRef(evidence: CommitmentEvidence): string {
  switch (evidence.kind) {
    case "DEPOSIT":
      return String(evidence.depositId);
    case "FINANCE":
      return String(evidence.applicationId);
    case "RESERVATION":
      return String(evidence.reservationId);
  }
}

/** The stored columns for a piece of evidence. */
function evidenceColumns(evidence: CommitmentEvidence) {
  switch (evidence.kind) {
    case "DEPOSIT":
      return { evidenceKind: "DEPOSIT" as const, depositId: evidence.depositId };
    case "FINANCE":
      return { evidenceKind: "FINANCE" as const, applicationId: evidence.applicationId };
    case "RESERVATION":
      return {
        evidenceKind: "RESERVATION" as const,
        reservationId: evidence.reservationId,
        ...(evidence.depositId ? { depositId: evidence.depositId } : {}),
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ownership — reading the authority.
// ─────────────────────────────────────────────────────────────────────────────

export type Ownership =
  | { kind: "FREE" }
  | { kind: "OWNED"; root: Doc<"commitmentRoots"> }
  | { kind: "AMBIGUOUS"; roots: Doc<"commitmentRoots">[] };

/**
 * Who holds this car right now.
 *
 * ⚠️ I10 — a claim pointing at a non-OPEN root is stale bookkeeping, not
 * ownership, so ownership is read from the ROOT and not from claim rows. A
 * fixed page must never decide freeness either: a car with more historical
 * roots than a page limit would read as free.
 */
export async function resolveOwnership(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<Ownership> {
  const open: Doc<"commitmentRoots">[] = [];
  for await (const root of ctx.db
    .query("commitmentRoots")
    .withIndex("by_org_vehicle_status", (q) =>
      q.eq("orgId", orgId).eq("vehicleId", vehicleId).eq("status", "OPEN")
    )) {
    open.push(root);
    // Two is already corrupt; a third tells us nothing more and streaming the
    // rest of a corrupt set buys nothing.
    if (open.length > 1) break;
  }
  if (open.length === 0) return { kind: "FREE" };
  if (open.length === 1) return { kind: "OWNED", root: open[0] };
  return { kind: "AMBIGUOUS", roots: open };
}

// ─────────────────────────────────────────────────────────────────────────────
// M1 — the single root decision.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How an operation proves which deal it belongs to.
 *
 * `quoteId` is PROOF, not identity (I3): presenting a quote says "I am acting
 * for the deal this quote belongs to". `reservationId` does the same for a deal
 * that began life as a reservation, before any quote exists.
 */
export type CommitmentLineage = {
  /** "I am acting for the deal this quote belongs to." */
  quoteId?: Id<"quotes"> | null;
  /** "I am acting for the deal this reservation IS." */
  reservationId?: Id<"vehicleReservations"> | null;
  /**
   * "I am acting for the deal this deposit belongs to."
   *
   * The proof a door presents when it has money on the deal but no quote to
   * show — reserving a car the same deal's deposit already holds, for one.
   */
  depositId?: Id<"deposits"> | null;
  /**
   * "This operation converts that reservation's deal into mine."
   *
   * ⚠️ EXPLICIT, AND THE ONLY WAY A RESERVATION-ORIGIN DEAL CONTINUES. The
   * caller names the exact reservation; the authority checks it is the one the
   * holding root actually came from. Matching on customer + vehicle instead
   * would be the inference I2 forbids by name — the same customer opening a
   * second deal on the same car is a DIFFERENT deal, and no amount of
   * coincidence makes it a continuation.
   */
  adoptReservationId?: Id<"vehicleReservations"> | null;
};

export type ActingRoot =
  | { decision: "JOIN"; rootId: Id<"commitmentRoots"> }
  /** A reservation's deal, formally continued under a quote. */
  | {
      decision: "ADOPT_RESERVATION";
      rootId: Id<"commitmentRoots">;
      reservationId: Id<"vehicleReservations">;
    }
  | { decision: "OPEN_NEW" }
  | { decision: "REFUSE"; message: string };

/**
 * ⚠️ THE ONLY PLACE THAT DECIDES WHICH ROOT AN OPERATION ACTS UNDER.
 *
 * Every acquisition writer in the system routes through here. The return type
 * is deliberately three-valued: the previous design returned a nullable root
 * id, and every caller independently read `null` as "then open a new one" —
 * which is how a car acquired a second root while its first was still alive.
 * OPEN_NEW is now a decision this function makes, never a fallback a caller
 * invents.
 *
 * The rules, in order:
 *
 *   1. Ambiguous ownership REFUSES. Two OPEN roots is corrupt state.
 *   2. A NAMED ADOPTION IS VALIDATED BEFORE ANY OTHER PROOF, and an invalid one
 *      REFUSES outright — never laundered by a different field that would have
 *      joined on its own.
 *   3. A FREE car OPENS a new root — the only circumstance in which that is
 *      correct.
 *   4. A car this deal already holds is JOINED, proven by lineage.
 *   5. Anything else REFUSES, including the SAME CUSTOMER opening a second
 *      independent deal on the same car (I2, c14865: same customer never
 *      implies same deal).
 */
export async function resolveActingRoot(
  ctx: QueryCtx | MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    lineage: CommitmentLineage;
    /**
     * The customer this operation is being carried out for, where the door
     * knows it independently of a quote.
     *
     * ⚠️ NOT PROOF, AND NEVER TREATED AS PROOF. It never selects a root and it
     * can never widen what an operation may do — it can only narrow it. Where a
     * quote is also presented, the QUOTE ROW wins and a disagreement between
     * the two refuses outright.
     */
    actingCustomerId?: Id<"customers"> | null;
    /** Overrides the generic refusal wording at doors that need their own. */
    refusalMessage?: string;
  }
): Promise<ActingRoot> {
  const ownership = await resolveOwnership(ctx, args.orgId, args.vehicleId);

  if (ownership.kind === "AMBIGUOUS") {
    return { decision: "REFUSE", message: COMMITMENT_MESSAGES.ambiguousOwnership };
  }

  const held = ownership.kind === "OWNED" ? ownership.root : null;
  const refuse: ActingRoot = {
    decision: "REFUSE",
    message: args.refusalMessage ?? COMMITMENT_MESSAGES.heldByAnotherDeal,
  };

  // ── THE ACTING PRINCIPAL — WHOSE DEAL IS ASKING ───────────────────────────
  //
  // Read from the QUOTE ROW, never from an argument. A caller-supplied customer
  // id proves nothing, because supplying one is exactly what a rival would do.
  //
  // ⚠️ This is NOT the (customerId, vehicleId) inference I2 forbids, and the
  // difference is the whole point. Identity is still established ONLY by
  // explicitly named evidence; the principal is consulted afterwards, to decide
  // whether this operation is ALLOWED to act on the deal that evidence points
  // at. A matching customer never grants a join by itself — contract 1.2, the
  // same customer's second independent deal on the same car, still refuses.
  const actingQuote = args.lineage.quoteId ? await ctx.db.get(args.lineage.quoteId) : null;
  const quotePrincipal =
    actingQuote && actingQuote.orgId === args.orgId ? actingQuote.customerId : null;
  // Two statements of who is acting that disagree are contradictory evidence,
  // not a choice to be made. Refuse rather than pick the convenient one.
  if (
    quotePrincipal &&
    args.actingCustomerId &&
    String(quotePrincipal) !== String(args.actingCustomerId)
  ) {
    return refuse;
  }
  const actingPrincipal = quotePrincipal ?? args.actingCustomerId ?? null;

  // ── 1. A NAMED ADOPTION IS AN AFFIRMATIVE CLAIM, SO IT IS ALWAYS CHECKED ──
  //
  // Before ownership is even consulted for a FREE car, and before any other
  // proof gets a chance to join. Supplying an adoption argument asserts
  // something about the world; if the assertion is false the operation is
  // wrong, whatever else it could have proven.
  if (args.lineage.adoptReservationId) {
    const adoption = await resolveAdoption(ctx, {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      adoptReservationId: args.lineage.adoptReservationId,
      held,
      actingQuote,
      actingPrincipal,
      refuse,
    });
    // `null` means the claim is about a DIFFERENT car of the same deal, the one
    // case where it does not decide this car. Every other outcome is a decision.
    if (adoption) return adoption;
  }

  // ── 2. a FREE car opens a root — the only place that is ever correct ─────
  if (!held) return { decision: "OPEN_NEW" };

  // ── 3. PARTICIPANT CONSISTENCY, CHECKED ONCE FOR EVERY PROOF BELOW ───────
  //
  // ⚠️ Explicit evidence SELECTS a root. It does not entitle whoever presents
  // it to act on that root. Those are different questions, and answering only
  // the first is what let one deal reuse another's proof: a quote, a deposit
  // or a reservation belonging to somebody else is still a real row, and every
  // check that asked "is this evidence genuine?" said yes.
  //
  // Checked HERE rather than inside each branch so a proof added later cannot
  // quietly arrive without it.
  //
  // ⚠️ This does not weaken I2. It can only REFUSE — never select a root, never
  // admit one. A second independent deal for the SAME customer on the same car
  // passes this check and is still refused below, for want of lineage
  // (contract 1.2). Same customer remains no evidence at all of the same deal.
  if (actingPrincipal && String(actingPrincipal) !== String(held.customerId)) {
    return refuse;
  }

  // ── 4. Lineage proof: does the presented evidence belong to THIS root? ────
  //
  // ⚠️ Checked against the ROOT, never against the customer. Two deals for one
  // customer on one car are two deals, and the second must wait for the first.
  if (args.lineage.reservationId && held.originReservationId === args.lineage.reservationId) {
    return { decision: "JOIN", rootId: held._id };
  }
  // ── deposit proof: an episode of THIS root rests on that very deposit ────
  //
  // Presenting a deposit id says "the deal that holds this car is the one this
  // money is on". Verified against the root's own live episodes, never against
  // the customer.
  //
  // Whose deposit it is has already been settled above, for this and every
  // other proof alike.
  if (args.lineage.depositId) {
    for await (const claim of ctx.db
      .query("vehicleCommitmentClaims")
      .withIndex("by_root_status", (q) => q.eq("rootId", held._id).eq("status", "ACTIVE"))) {
      if (claim.depositId && String(claim.depositId) === String(args.lineage.depositId)) {
        return { decision: "JOIN", rootId: held._id };
      }
    }
  }

  if (args.lineage.quoteId) {
    if (!actingQuote || actingQuote.orgId !== args.orgId) return refuse;
    // ⚠️ THE ROOT NAMES ITS QUOTE, NOT THE OTHER WAY ROUND, AND THE FIRST
    // VERSION OF THIS HAD IT BACKWARDS.
    //
    // A quote can only name ONE root, but a MULTI-VEHICLE deal is one quote
    // across SEVERAL roots — one per physical car. Reading the association
    // from the quote therefore recognised only the first car of the deal and
    // refused the deal its own second car. The bounded suite caught it at the
    // first real door it touched.
    //
    // Each root records the revision it is known by, so the same quote proves
    // lineage against every root of its deal.
    if (held.headQuoteId && String(held.headQuoteId) === String(args.lineage.quoteId)) {
      return { decision: "JOIN", rootId: held._id };
    }
  }
  return refuse;
}

/** Does this quote actually cover that car? Single- and multi-vehicle alike. */
function quoteCoversVehicle(quote: Doc<"quotes"> | null, vehicleId: Id<"vehicles">): boolean {
  if (!quote) return false;
  const items = quote.vehicleItems ?? [{ vehicleId: quote.vehicleId }];
  return items.some((item) => String(item.vehicleId) === String(vehicleId));
}

/**
 * ⚠️ EXPLICIT EVIDENCE IDENTIFIES A DEAL. IT DOES NOT AUTHORIZE ONE DEAL TO
 * TAKE ANOTHER.
 *
 * The first version of adoption checked that the named reservation was real,
 * live, on this car and this root's origin — and then handed over the root.
 * Every one of those is a check on the RESERVATION; none asked who was doing
 * the adopting. So customer B could present B's own quote together with
 * customer A's reservation and have A's root re-headed onto B's quote. One car,
 * one root, `customerId` still reading A: every count a test might take stayed
 * correct while the deal quietly changed hands.
 *
 * The rules, and each is fail-closed:
 *
 *   a. the reference must be REAL, in this org, and still ACTIVE;
 *   b. the adopter's principal must be the reservation's own customer, read
 *      from rows on the server;
 *   c. on the car the reservation is FOR, it must be the reservation this car's
 *      open root actually came from;
 *   d. on any OTHER car, the claim is only coherent if the acting quote covers
 *      the reservation's car too — one multi-vehicle deal continuing one
 *      reservation. Then it does not decide this car, and ordinary lineage does.
 *
 * ⚠️ (d) IS THE ONE PATH THAT RETURNS `null`, and it is a deliberate narrowing
 * of "an invalid adoption always refuses". A multi-vehicle deal that reserved
 * one of its cars presents the same single `adoptReservationId` for every car on
 * the quote; refusing on the others would break that deal outright. The claim is
 * not ignored — (a) and (b) have already been enforced against it — it is
 * applied to the car it names.
 */
async function resolveAdoption(
  ctx: QueryCtx | MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    adoptReservationId: Id<"vehicleReservations">;
    held: Doc<"commitmentRoots"> | null;
    actingQuote: Doc<"quotes"> | null;
    actingPrincipal: Id<"customers"> | null;
    refuse: ActingRoot;
  }
): Promise<ActingRoot | null> {
  const reservation = await ctx.db.get(args.adoptReservationId);

  // (a) the reference itself
  if (!reservation || reservation.orgId !== args.orgId) return args.refuse;
  if (reservation.status !== "ACTIVE") return args.refuse;

  // (b) the principal — the rival check
  //
  // ⚠️ The first line is deliberately redundant: the comparison below would
  // also refuse, since `String(null)` never equals an id. That is an accident
  // of coercion, not a guarantee, and "no principal REFUSES" is too important
  // to leave resting on one. No shipped door can reach it — both doors that
  // accept an adoption take a REQUIRED `quoteId` — so it is the fail-closed
  // default for the next door, not live behaviour. Contract A.13 pins it.
  if (!args.actingPrincipal) return args.refuse;
  if (String(args.actingPrincipal) !== String(reservation.customerId)) return args.refuse;

  // (c) the car the reservation is for
  if (String(reservation.vehicleId) === String(args.vehicleId)) {
    if (
      args.held &&
      args.held.originReservationId &&
      String(args.held.originReservationId) === String(args.adoptReservationId)
    ) {
      return {
        decision: "ADOPT_RESERVATION",
        rootId: args.held._id,
        reservationId: args.adoptReservationId,
      };
    }
    return args.refuse;
  }

  // (d) another car — coherent only as part of the same multi-vehicle deal
  return quoteCoversVehicle(args.actingQuote, reservation.vehicleId) ? null : args.refuse;
}

/**
 * The refusal, thrown. Doors that cannot proceed without the car call this.
 */
export function throwRefusal(acting: Extract<ActingRoot, { decision: "REFUSE" }>): never {
  throw new ConvexError(acting.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing the authority.
// ─────────────────────────────────────────────────────────────────────────────

async function openRoot(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    customerId: Id<"customers">;
    createdBy: Id<"users">;
    lineage: CommitmentLineage;
  }
): Promise<Id<"commitmentRoots">> {
  return await ctx.db.insert("commitmentRoots", {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    customerId: args.customerId,
    status: "OPEN",
    ...(args.lineage.quoteId ? { headQuoteId: args.lineage.quoteId } : {}),
    ...(args.lineage.reservationId ? { originReservationId: args.lineage.reservationId } : {}),
    openedAt: Date.now(),
    openedBy: args.createdBy,
  });
}

/**
 * Open ONE acquisition episode on an ALREADY-DECIDED root.
 *
 * ⚠️ Takes a `rootId`, never a hint. Every caller has been through
 * `resolveActingRoot` before reaching here, which is what makes I1 enforceable
 * in one place instead of assumed in six.
 *
 * A `predecessor` may only be supplied when this episode succeeds one that is
 * already terminal, on the same root, vehicle and defining evidence. Those are
 * checked rather than trusted: a successor that silently changed root or
 * evidence is how history stops meaning anything.
 */
export async function attachEpisode(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    rootId: Id<"commitmentRoots">;
    vehicleId: Id<"vehicles">;
    evidence: CommitmentEvidence;
    createdBy: Id<"users">;
    quoteId?: Id<"quotes"> | null;
    predecessor?: Doc<"vehicleCommitmentClaims">;
  }
): Promise<Id<"vehicleCommitmentClaims">> {
  const { predecessor } = args;
  if (predecessor) {
    if (predecessor.status === "ACTIVE") {
      throw new Error(
        `claim ${predecessor._id} is still ACTIVE — a live episode is not succeeded, it is resolved`
      );
    }
    if (String(predecessor.rootId) !== String(args.rootId)) {
      throw new Error(
        `successor root ${args.rootId} does not match predecessor ${predecessor._id} root ${predecessor.rootId}`
      );
    }
    if (String(predecessor.vehicleId) !== String(args.vehicleId)) {
      throw new Error(`successor vehicle does not match predecessor ${predecessor._id}`);
    }
    // ⚠️ KIND FIRST, THEN THE REFERENCE. The tag is the primary fact — a
    // successor that changed kind is a different KIND of claim on the car, and
    // saying so is more useful than reporting the reference mismatch that
    // necessarily follows from it.
    if (predecessor.evidenceKind !== args.evidence.kind) {
      throw new Error(
        `successor kind ${args.evidence.kind} does not match predecessor ${predecessor._id} kind ${predecessor.evidenceKind}`
      );
    }
    if (evidenceRef(evidenceOf(predecessor)) !== evidenceRef(args.evidence)) {
      throw new Error(`successor evidence does not match predecessor ${predecessor._id}`);
    }
  }

  return await ctx.db.insert("vehicleCommitmentClaims", {
    orgId: args.orgId,
    rootId: args.rootId,
    vehicleId: args.vehicleId,
    status: "ACTIVE",
    ...evidenceColumns(args.evidence),
    ...(args.quoteId ? { quoteId: args.quoteId } : {}),
    ...(predecessor ? { restoredFromClaimId: predecessor._id } : {}),
    createdAt: Date.now(),
    createdBy: args.createdBy,
  });
}

/**
 * THE DOOR. Decide the root, then open the episode — or refuse.
 *
 * This is what the six acquisition writers call. None of them decides a root,
 * and none of them invents an evidence kind.
 */
export async function acquireVehicle(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    customerId: Id<"customers">;
    createdBy: Id<"users">;
    evidence: CommitmentEvidence;
    lineage: CommitmentLineage;
    refusalMessage?: string;
    predecessor?: Doc<"vehicleCommitmentClaims">;
  }
): Promise<Id<"commitmentRoots">> {
  const acting = await resolveActingRoot(ctx, {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    lineage: args.lineage,
    // The customer this acquisition is FOR is already known here, and is the
    // same value the new root would be opened under.
    actingCustomerId: args.customerId,
    refusalMessage: args.refusalMessage,
  });
  if (acting.decision === "REFUSE") throwRefusal(acting);

  const rootId =
    acting.decision === "JOIN" || acting.decision === "ADOPT_RESERVATION"
      ? acting.rootId
      : await openRoot(ctx, {
          orgId: args.orgId,
          vehicleId: args.vehicleId,
          customerId: args.customerId,
          createdBy: args.createdBy,
          lineage: args.lineage,
        });

  // ⚠️ ADOPTION RE-HEADS THE DEAL, IN ONE PLACE. Once a reservation's deal is
  // continued under a quote, that quote becomes the revision the root is known
  // by — so every later door (a further deposit, a finance application) proves
  // lineage by quote in the ordinary way instead of re-adopting. The
  // conversion happens exactly once, here, and is auditable.
  if (acting.decision === "ADOPT_RESERVATION" && args.lineage.quoteId) {
    await ctx.db.patch(acting.rootId, { headQuoteId: args.lineage.quoteId });
  }

  await attachEpisode(ctx, {
    orgId: args.orgId,
    rootId,
    vehicleId: args.vehicleId,
    evidence: args.evidence,
    createdBy: args.createdBy,
    quoteId: args.lineage.quoteId ?? null,
    predecessor: args.predecessor,
  });

  return rootId;
}

/**
 * The evidence a released deposit slice should be re-acquired under.
 *
 * CARRIED FROM THE SOURCE EPISODE, NOT ASSUMED FROM THE ROW. A deposit taken
 * with a reservation is RESERVATION evidence that happens to have a deposit
 * attached. Re-acquiring it as `{ kind: "DEPOSIT" }` because the surrounding
 * row is a `depositVehicleHolds` is precisely the inference this replacement
 * removes: it is what turned a consumed reservation episode into a live
 * DEPOSIT-kind claim on a second root.
 *
 * Falls back to DEPOSIT only when no episode rests on this deposit at all,
 * which is the genuinely deposit-only case.
 */
export async function evidenceForDepositHold(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  hold: Doc<"depositVehicleHolds">
): Promise<CommitmentEvidence> {
  for await (const claim of ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_deposit", (q) => q.eq("depositId", hold.depositId))) {
    if (claim.orgId !== orgId) continue;
    return evidenceOf(claim);
  }
  return { kind: "DEPOSIT", depositId: hold.depositId };
}

/**
 * Refuse to take a car out from under a live deal.
 *
 * The door version of `resolveActingRoot` for operations that are not
 * acquiring — a sale, a trade-in, an inventory removal — where the only
 * question is whether this deal is allowed to act on the car at all. Every
 * non-REFUSE decision passes, adoption included.
 */
export async function assertAcquirable(
  ctx: QueryCtx | MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    lineage: CommitmentLineage;
    actingCustomerId?: Id<"customers"> | null;
    message?: string;
  }
): Promise<void> {
  const acting = await resolveActingRoot(ctx, {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    lineage: args.lineage,
    actingCustomerId: args.actingCustomerId,
    refusalMessage: args.message,
  });
  if (acting.decision === "REFUSE") throwRefusal(acting);
}
