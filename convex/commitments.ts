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
import { hasActiveDepositHold } from "./utils/depositHelpers";
import {
  assertPrincipalMatches,
  AuthorityDecisionContext,
  EvidenceEpisode,
  PrincipalBoundEvidence,
  requireCanonicalAuthority,
  requireCurrentEpisode,
  resolveLineageTip,
} from "./utils/commitmentKernel";
import { resolveCanonicalBinding, SourceRef, stampAcquisitionPointer } from "./utils/commitmentSources";
import { IN_FLIGHT_FINANCE_STATUSES as FINANCE_IN_FLIGHT } from "./utils/financeStatuses";
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
  /**
   * A supplied lineage field that does not stand up: a quote, reservation or
   * deposit that is not real, not this dealership's, not this customer's, or
   * simply not about this car. Naming one is an affirmative claim, so a false
   * one refuses rather than being ignored.
   */
  unprovableLineage:
    "The quote, reservation or deposit given for this vehicle does not apply to it, so the vehicle cannot be committed to that deal.",
  /**
   * A deposit's vehicle hold that cannot say which episode it came from. Under
   * the canonical model every hold is written alongside the acquisition that
   * created it and carries that episode's id; one that does not is either state
   * from before the model existed (SCRUM-201) or a row written incompletely.
   * Neither may be guessed at.
   */
  unprovenProvenance:
    "This vehicle's share of the deposit is missing its commitment record and cannot be re-applied until it is restored. Please contact support.",
  /**
   * M3. A sale offered as the provenance for closing a deal that is not this
   * dealership's, or is not about this car. The root's `consumedBySaleId` is the
   * entry point Phase 3 uses to get from a cancelled sale back to its deal, so a
   * stamp naming the wrong sale is worse than no stamp at all — it would send a
   * later reversal at somebody else's deal with full confidence.
   */
  saleProvenanceMismatch:
    "This sale does not belong to this vehicle's dealership record and cannot be recorded as the sale that closed its deal. Please contact support.",
  /**
   * M3. An operation whose meaning is "take this car out of the deal" —
   * removing a vehicle's allocation, or deleting it from inventory — while
   * another independent basis still legitimately holds it. Ending that other
   * workflow is a decision for an operator, not a side effect of this one.
   */
  vehicleStillHeldByAnotherBasis:
    "This vehicle is still held by another part of this deal. End that first — release the reservation, or reject or cancel the finance application — then remove the vehicle.",
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
 * is deliberately four-valued: the previous design returned a nullable root
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
 *      correct — but ONLY once every proof it was handed has been proved.
 *   4. A car this deal already holds is JOINED, proven by lineage.
 *   5. Anything else REFUSES, including the SAME CUSTOMER opening a second
 *      independent deal on the same car (I2, c14865: same customer never
 *      implies same deal).
 *
 * ⚠️ WHERE PROOF VALIDATION SITS, AND WHY IT IS NOT EVERYWHERE. It guards the
 * two decisions that WRITE root metadata — OPEN_NEW, which persists the quote
 * and the reservation it was handed, and ADOPT_RESERVATION, which re-heads a
 * root onto the presented quote. A JOIN persists nothing and already binds
 * every proof to the root it names, so gating it as well would refuse
 * legitimate work: a car that has since left its quote must still be able to
 * resolve the money sitting on it, and a false refusal there is as much a
 * defect as a false admission.
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
  // ⚠️ ONE CLOCK READING FOR THE WHOLE DECISION, taken before anything is
  // consulted. Adoption and generic lineage can both weigh the same
  // reservation, and reading the clock separately in each would let one branch
  // call a proof live and the next call it expired a millisecond later — a
  // decision that contradicts itself inside a single call.
  //
  // It is a `Date.now()` in a function typed for `QueryCtx` too, which would
  // bound a Convex query's cache lifetime. Every production caller is a
  // mutation (`deposits.create`, `applications.createFromQuote`,
  // `vehicles.createReservation`), where there is no cache to bound; the query
  // context exists for tests and read-only callers.
  const decisionNow = Date.now();
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
    // ⚠️ THE QUOTE IS ABOUT TO BECOME THE ROOT'S HEAD REVISION, so it is proved
    // BEFORE the adoption can grant that. `acquireVehicle` patches
    // `headQuoteId` on every ADOPT_RESERVATION, and a quote that is foreign,
    // dangling or simply not about this car has proven nothing that entitles it
    // to be written there.
    if (args.lineage.quoteId && !quoteProofIsValid(actingQuote, args.orgId, args.vehicleId)) {
      return { decision: "REFUSE", message: COMMITMENT_MESSAGES.unprovableLineage };
    }
    const adoption = await resolveAdoption(ctx, {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      adoptReservationId: args.lineage.adoptReservationId,
      held,
      actingQuote,
      actingPrincipal,
      decisionNow,
      refuse,
    });
    // `null` means the claim is about a DIFFERENT car of the same deal, the one
    // case where it does not decide this car. Every other outcome is a decision.
    if (adoption) return adoption;
  }

  // ── 2. a FREE car opens a root — the only place that is ever correct ─────
  //
  // ⚠️ AND ONLY ON PROOF THAT HOLDS UP. Everything the caller handed in is
  // about to be written onto a brand-new root, so this is the last point at
  // which a false claim can still be refused instead of persisted.
  if (!held) {
    const unprovable = await validateLineageProofs(ctx, {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      lineage: args.lineage,
      actingQuote,
      actingPrincipal,
      decisionNow,
    });
    if (unprovable) return unprovable;
    return { decision: "OPEN_NEW" };
  }

  // ── 3. AN UNATTRIBUTED OPERATION MAY NOT ACT ON A HELD CAR ───────────────
  //
  // ⚠️ ABSENCE IS NOT "NO CONTRADICTION". ABSENCE IS A REFUSAL.
  //
  // The participant check below can only compare two things it has. Written as
  // `if (actingPrincipal && …)` it therefore passed silently whenever nobody
  // had been established at all, and the lineage branches under it went on to
  // JOIN a held root for an operation with no attributable deal behind it.
  // Genuine evidence, no one accountable for presenting it.
  //
  // No shipped caller could reach that — all five supply a principal — but this
  // is the exported authority contract, and Phase 2 and Phase 3 add callers.
  // A guard that is safe only because of who happens to call it today is not a
  // guard.
  //
  // A FREE car is deliberately NOT affected: it is decided above, and opening a
  // root remains the one place that is correct without lineage.
  if (!actingPrincipal) return refuse;

  // ── 4. PARTICIPANT CONSISTENCY, CHECKED ONCE FOR EVERY PROOF BELOW ───────
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
  if (String(actingPrincipal) !== String(held.customerId)) {
    return refuse;
  }

  // ── 5. Lineage proof: does the presented evidence belong to THIS root? ────
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

/**
 * ⚠️ A RESERVATION'S STORED STATUS IS A CACHE OF ITS LIFETIME, NOT THE LIFETIME.
 *
 * `expiresAt` is when the reservation actually stops holding the car.
 * `status` only catches up when the 15-minute `expire-vehicle-reservations`
 * cron next runs, so an expired reservation reads `ACTIVE` for a window — and
 * longer than the interval suggests, because that sweep takes at most 100 rows
 * per pass and a backlog carries over.
 *
 * The authority used to test the enum alone, which made it the ONE place that
 * believed a stale cache. Its neighbours never did: the duplicate-reservation
 * guard in `vehicles.createReservation` admits only
 * `expiresAt === undefined || expiresAt > now`, and the sweep's own query is
 * `status === "ACTIVE" AND expiresAt <= now` — a written admission that ACTIVE
 * rows can be expired. So an expired reservation was adoptable, and re-headed a
 * live commitment root onto a new quote.
 *
 * ⚠️ THE BOUNDARY IS DELIBERATE AND IS `>`, NOT `>=`. A reservation whose
 * expiry is exactly the decision instant has expired: at that moment the sweep
 * would already select it. Ties go to refusal, like every other rule here.
 *
 * A row with NO `expiresAt` stays live while ACTIVE, matching the neighbouring
 * guard exactly. That is deliberate compatibility with rows written before
 * expiry was mandatory, not an invented migration.
 *
 * ⚠️ IT ANSWERS, IT DOES NOT CLEAN UP. Nothing here patches `status` or
 * releases anything: the authority decides whether a proof is live, and the
 * existing sweeper owns materialising that into the row. Mutating lifecycle
 * inside a decision a query context may also call would race the cron that
 * owns it.
 */
export function reservationIsLive(
  reservation: Doc<"vehicleReservations">,
  decisionNow: number
): boolean {
  if (reservation.status !== "ACTIVE") return false;
  return reservation.expiresAt === undefined || reservation.expiresAt > decisionNow;
}

/** Does this quote actually cover that car? Single- and multi-vehicle alike. */
function quoteCoversVehicle(quote: Doc<"quotes"> | null, vehicleId: Id<"vehicles">): boolean {
  if (!quote) return false;
  const items = quote.vehicleItems ?? [{ vehicleId: quote.vehicleId }];
  return items.some((item) => String(item.vehicleId) === String(vehicleId));
}

/** A presented quote is proof for a car only if it is real, ours, and about it. */
function quoteProofIsValid(
  quote: Doc<"quotes"> | null,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): boolean {
  return !!quote && quote.orgId === orgId && quoteCoversVehicle(quote, vehicleId);
}

/**
 * ⚠️ A SUPPLIED LINEAGE FIELD IS AN AFFIRMATIVE CLAIM, AND A FREE VEHICLE DOES
 * NOT TURN BAD EVIDENCE INTO GOOD EVIDENCE.
 *
 * The first version proved a lineage field only where it was USED to join, so
 * a car nobody held took the OPEN_NEW branch before any of it ran, and
 * `openRoot` persisted whatever it was handed. A quote from another
 * dealership, a dangling id, a quote that does not include this car at all —
 * each became the new root's `headQuoteId`.
 *
 * The reservation half is worse than untidy metadata. Adoption rule (c) admits
 * whoever OWNS the reservation a root claims to have come from, so a root
 * opened with a stranger's `originReservationId` hands that stranger a door
 * into it: they present their own quote and their own reservation, both real,
 * and the root is re-headed onto their deal.
 *
 * ⚠️ THIS NARROWS. IT NEVER IDENTIFIES. No branch here selects, admits or
 * invents a root — every outcome is "carry on" or REFUSE. Root identity stays
 * server-owned (I2).
 *
 * Participant consistency is enforced wherever a principal is known. Where one
 * is NOT known nothing can be persisted either, and that is structural rather
 * than circumstantial: `openRoot` is reachable only through `acquireVehicle`,
 * whose `customerId` is a required argument passed straight through as the
 * acting principal. A caller with no principal can obtain a decision; it cannot
 * obtain a root.
 */
async function validateLineageProofs(
  ctx: QueryCtx | MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    lineage: CommitmentLineage;
    actingQuote: Doc<"quotes"> | null;
    actingPrincipal: Id<"customers"> | null;
    /** The single clock reading for this decision. See `resolveActingRoot`. */
    decisionNow: number;
  }
): Promise<ActingRoot | null> {
  const refuse: ActingRoot = {
    decision: "REFUSE",
    message: COMMITMENT_MESSAGES.unprovableLineage,
  };

  // ── the quote ───────────────────────────────────────────────────────────
  //
  // WHOSE quote it is has already been settled: a quote naming a different
  // customer than the operation is contradictory evidence and refused above.
  // What is left is whether the row is real, ours, and about THIS car.
  if (args.lineage.quoteId && !quoteProofIsValid(args.actingQuote, args.orgId, args.vehicleId)) {
    return refuse;
  }

  // ── the reservation ─────────────────────────────────────────────────────
  //
  // Real, ours, still live, FOR this car, and this deal's. A released or
  // converted reservation is no longer a deal anyone can act for — a converted
  // one continues through the quote it was adopted onto, which is what
  // re-heading exists for, never through the spent reservation.
  //
  // ⚠️ AND "LIVE" IS TIME-BASED, NOT STATUS-ONLY. `reservationIsLive` is the
  // one place that rule is written; testing `status` here alone is what let an
  // expired reservation open a root during the sweep's window.
  if (args.lineage.reservationId) {
    const reservation = await ctx.db.get(args.lineage.reservationId);
    if (!reservation || reservation.orgId !== args.orgId) return refuse;
    if (!reservationIsLive(reservation, args.decisionNow)) return refuse;
    if (String(reservation.vehicleId) !== String(args.vehicleId)) return refuse;
    if (args.actingPrincipal && String(reservation.customerId) !== String(args.actingPrincipal)) {
      return refuse;
    }
  }

  // ── the deposit ─────────────────────────────────────────────────────────
  //
  // ⚠️ `deposit.vehicleId` IS NOT THE WHOLE ANSWER. A multi-vehicle deposit
  // names one car in that column and holds several; the per-vehicle
  // relationship is the join row. Reading the column alone would refuse a deal
  // its own second car — so the row is consulted, by one indexed lookup rather
  // than a walk of the deposit's history.
  if (args.lineage.depositId) {
    const depositId = args.lineage.depositId;
    const deposit = await ctx.db.get(depositId);
    if (!deposit || deposit.orgId !== args.orgId) return refuse;
    if (deposit.isDeleted === true) return refuse;
    if (args.actingPrincipal && String(deposit.customerId) !== String(args.actingPrincipal)) {
      return refuse;
    }
    if (String(deposit.vehicleId) !== String(args.vehicleId)) {
      const onThisCar = await ctx.db
        .query("depositVehicleHolds")
        .withIndex("by_deposit_vehicle", (q) =>
          q.eq("depositId", depositId).eq("vehicleId", args.vehicleId)
        )
        .first();
      if (!onThisCar) return refuse;
    }
  }

  return null;
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
 *   a. the reference must be REAL, in this org, and still LIVE — which is
 *      ACTIVE *and* not past its `expiresAt`, because the sweep that
 *      materialises expiry runs on a cron and lags the truth;
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
    /** The same clock reading the rest of this decision used. */
    decisionNow: number;
    refuse: ActingRoot;
  }
): Promise<ActingRoot | null> {
  const reservation = await ctx.db.get(args.adoptReservationId);

  // (a) the reference itself — real, ours, and STILL LIVE
  //
  // ⚠️ The same `reservationIsLive` rule as the generic proof, deliberately
  // not a second copy of it. Two subtly different expiry tests in one authority
  // is how the adoption door and the lineage door would drift apart.
  if (!reservation || reservation.orgId !== args.orgId) return args.refuse;
  if (!reservationIsLive(reservation, args.decisionNow)) return args.refuse;

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

/**
 * Why a restoration believes it is entitled to continue a finished deal.
 *
 * ⚠️ EXACT, NOT CATEGORICAL. "A sale was cancelled" is not a reason to restore
 * THIS deal — "the exact sale that consumed THIS root was cancelled" is. The
 * same holds for a released root and the exact episode whose end released it.
 * Without the exact reference, any cancellation anywhere in the dealership
 * would satisfy a restoration of any root.
 */
export type RestorationIntent =
  /** The exact sale that consumed the root has been cancelled. */
  | { kind: "SALE_CANCELLED"; saleId: Id<"sales"> }
  /** The exact source episode whose release ended the root is reinstated. */
  | { kind: "SOURCE_EPISODE_REINSTATED" };

/**
 * What the authority decided about a restoration. **Writes nothing.**
 *
 * ⚠️ TYPED, BECAUSE THE CALLER MUST BE ABLE TO TELL THESE APART. Once the
 * reversal journal has posted, a vehicle-authority outcome is no longer an
 * accounting failure, and reporting it as one is how a legitimate business
 * result ends up in an outbox `lastError` looking like a transient fault.
 */
export type RestorationDecision =
  /**
   * The source episode is still ACTIVE — there is nothing to restore.
   *
   * Returned rather than throwing so a reversal that runs twice is idempotent,
   * and rather than attaching so a retry cannot mint a duplicate ACTIVE claim
   * for the same evidence on the same car.
   */
  | {
      decision: "ALREADY_LIVE";
      rootId: Id<"commitmentRoots">;
      claimId: Id<"vehicleCommitmentClaims">;
    }
  /** The lineage tip is still OPEN — rejoin it rather than succeeding it. */
  | { decision: "JOIN_LINEAGE"; rootId: Id<"commitmentRoots"> }
  /** The tip is terminal and the car is free: open the next generation. */
  | { decision: "OPEN_SUCCESSOR"; predecessor: Doc<"commitmentRoots"> }
  /** Another deal legitimately holds the car. */
  | { decision: "RIVAL"; rivalRootId: Id<"commitmentRoots"> }
  /** Two OPEN roots on one car — corrupt state, not a tie to be broken. */
  | { decision: "AMBIGUOUS" }
  /** Legacy or inconsistent lineage, or an intent that does not match. */
  | { decision: "REFUSE"; reason: string };

/** The result of actually executing a restoration. */
export type RestorationOutcome =
  | {
      decision: "RESTORED";
      rootId: Id<"commitmentRoots">;
      claimId: Id<"vehicleCommitmentClaims">;
      /** Whether a successor generation was opened, or the tip was rejoined. */
      opened: "SUCCESSOR" | "JOINED";
    }
  | Exclude<RestorationDecision, { decision: "JOIN_LINEAGE" } | { decision: "OPEN_SUCCESSOR" }>;

/**
 * How a root is being opened. **Server-derived, never caller-supplied.**
 *
 * ⚠️ THIS IS A PARAMETER OF THE ONE INSERT SITE, NOT A SECOND WRITER. The
 * first version of this work added `openSuccessorRoot` with its own
 * `ctx.db.insert("commitmentRoots", …)`, which re-created exactly the defect
 * M1 exists to prevent: the question "may a root be created here" answered in
 * two places instead of one. A successor is a different SHAPE of opening, not
 * a different opener.
 */
type RootOpening =
  | { kind: "ORIGIN" }
  | { kind: "SUCCESSOR"; predecessor: Doc<"commitmentRoots"> };

async function openRoot(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    customerId: Id<"customers">;
    createdBy: Id<"users">;
    lineage: CommitmentLineage;
    /** ORIGIN unless a restoration decision said otherwise. */
    opening?: RootOpening;
  }
): Promise<Id<"commitmentRoots">> {
  const opening: RootOpening = args.opening ?? { kind: "ORIGIN" };

  if (opening.kind === "SUCCESSOR") {
    const { predecessor } = opening;
    // Belt and braces on a decision `resolveRestorationDecision` already made.
    // These are `Error`, not `ConvexError`: reaching them means a caller
    // bypassed the resolver, which is a programming fault and not something to
    // explain to a salesperson.
    if (predecessor.lineageRootId === undefined || predecessor.lineageGeneration === undefined) {
      throw new Error(`root ${predecessor._id} has no lineage identity to succeed`);
    }
    if (predecessor.status === "OPEN") {
      throw new Error(
        `root ${predecessor._id} is still OPEN — a live root is not succeeded, it is resolved`
      );
    }
    // ⚠️ THE PRINCIPAL IS CARRIED, NEVER RE-DERIVED. A restoration that adopts
    // whoever is presenting the evidence is how one customer's money becomes
    // another customer's deal.
    if (String(predecessor.customerId) !== String(args.customerId)) {
      throw new Error(
        `successor principal does not match predecessor ${predecessor._id}`
      );
    }
    if (String(predecessor.vehicleId) !== String(args.vehicleId)) {
      throw new Error(`successor vehicle does not match predecessor ${predecessor._id}`);
    }
  }

  // ⚠️ SCRUM-208 — A SUCCESSOR'S ROOT IDENTITY IS COPIED FROM THE TIP, NOT
  // FROM THE CALLER'S LINEAGE PROOF.
  //
  // `args.lineage` is what the OPERATION presented to prove which deal it
  // belongs to. Letting it fill `headQuoteId` / `originReservationId` on a
  // successor would let dormant evidence — a months-old deposit being
  // reinstated — silently re-head the deal onto whatever quote it happened to
  // carry. Root identity survives succession unchanged; only the separately
  // validated adoption path may ever move the quote head.
  //
  // The new EPISODE still carries its own evidence and its own quote, which is
  // claim-level and is exactly where operation-specific facts belong.
  const identity =
    opening.kind === "SUCCESSOR"
      ? {
          customerId: opening.predecessor.customerId,
          ...(opening.predecessor.headQuoteId
            ? { headQuoteId: opening.predecessor.headQuoteId }
            : {}),
          ...(opening.predecessor.originReservationId
            ? { originReservationId: opening.predecessor.originReservationId }
            : {}),
          lineageRootId: opening.predecessor.lineageRootId,
          lineageGeneration: opening.predecessor.lineageGeneration! + 1,
          restoredFromRootId: opening.predecessor._id,
        }
      : {
          customerId: args.customerId,
          ...(args.lineage.quoteId ? { headQuoteId: args.lineage.quoteId } : {}),
          ...(args.lineage.reservationId
            ? { originReservationId: args.lineage.reservationId }
            : {}),
          lineageGeneration: 0,
        };

  const rootId = await ctx.db.insert("commitmentRoots", {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    status: "OPEN",
    openedAt: Date.now(),
    openedBy: args.createdBy,
    ...identity,
  });

  // A successor already carries its lineage from the predecessor; only an
  // origin has to point at itself, and only an origin gets the self-patch.
  if (opening.kind === "SUCCESSOR") return rootId;

  // ⚠️ SCRUM-208 — ONE CANONICAL ORIGIN REPRESENTATION, WRITTEN BEFORE COMMIT.
  //
  // A lineage origin points at ITSELF, which cannot be expressed in the insert
  // because the id does not exist until the insert returns. The self-patch is
  // safe precisely because a Convex mutation is ONE transaction: no reader ever
  // observes the row between the two writes, and if anything later in this
  // mutation throws, neither write lands.
  //
  // ⚠️ IT IS NOT LEFT ABSENT FOR A READER TO NORMALIZE TO "SELF". A missing
  // `lineageRootId` is the LEGACY signal and must keep failing closed; if new
  // roots also shipped without it, that signal would be worthless and every
  // reader would need to guess which kind of missing it was looking at.
  //
  // Written for legacy and canonical organizations alike. It costs nothing on
  // the legacy path — `resolveOwnership` provably never reads these fields —
  // and it means the SCRUM-201 backfill only ever has to reach rows that
  // predate this code, rather than chasing a moving target.
  await ctx.db.patch(rootId, { lineageRootId: rootId });
  return rootId;
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
    // ⚠️ SAME ROOT, OR THE SAME LINEAGE — PROVEN, NOT ASSUMED.
    //
    // Phase 2 had one rule: a reacquired episode opens a new claim on the SAME
    // root. Phase 3 adds root succession, and a first attempt at reconciling
    // them permitted "the same root, or the root this one directly succeeds".
    // That direct-parent rule is wrong, and it strands dormant evidence
    // permanently: a deposit episode can belong to R0 while finance has since
    // advanced the lineage through R1 to R2. Restoring that deposit onto R2 —
    // or onto an R3 opened from R2 — is legitimate, and the parent-only rule
    // refuses it forever because R0 is two generations back.
    //
    // The real invariant is that both roots are the SAME DEAL: same tenant,
    // same car, same principal, same lineage. Generation distance is not part
    // of it.
    //
    // ⚠️ AND A LEGACY ROOT CANNOT SATISFY IT. Two roots that both lack a
    // lineage id are not thereby in the same lineage — `undefined === undefined`
    // would silently marry two unrelated deals.
    if (String(predecessor.rootId) !== String(args.rootId)) {
      const [target, source] = await Promise.all([
        ctx.db.get(args.rootId),
        ctx.db.get(predecessor.rootId),
      ]);
      if (!target || !source) {
        throw new Error(`cannot prove predecessor ${predecessor._id} shares this deal's lineage`);
      }
      const sameLineage =
        target.lineageRootId !== undefined &&
        source.lineageRootId !== undefined &&
        String(target.lineageRootId) === String(source.lineageRootId) &&
        String(target.orgId) === String(source.orgId) &&
        String(target.vehicleId) === String(source.vehicleId) &&
        String(target.customerId) === String(source.customerId);
      if (!sameLineage) {
        throw new Error(
          `successor root ${args.rootId} is not in the same lineage as predecessor ${predecessor._id} root ${predecessor.rootId}`
        );
      }
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
 *
 * ⚠️ IT RETURNS THE EPISODE IT CREATED, AND THAT IS LOAD-BEARING. A writer that
 * also records a `depositVehicleHolds` row must stamp that row with the claim
 * this acquisition opened, so the hold's provenance is a POINTER rather than
 * something later rediscovered by walking history. Throwing the claim id away
 * here is what forced the old `evidenceForDepositHold` to read every episode
 * sharing a deposit and a car in order to answer a question this call already
 * knew the answer to.
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
): Promise<{ rootId: Id<"commitmentRoots">; claimId: Id<"vehicleCommitmentClaims"> }> {
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

  return await executeAcquisition(ctx, {
    ...args,
    target:
      acting.decision === "JOIN" || acting.decision === "ADOPT_RESERVATION"
        ? { kind: "JOIN", rootId: acting.rootId }
        : { kind: "ORIGIN" },
    adoptReservation: acting.decision === "ADOPT_RESERVATION",
  });
}

/**
 * SCRUM-208 — THE ONE EXECUTOR. **Unexported, deliberately.**
 *
 * Open-or-join, then attach, in one transaction. Both doors converge here:
 * `acquireVehicle` after `resolveActingRoot`, `restoreCommitment` after
 * `resolveRestorationDecision`.
 *
 * ⚠️ THE SUCCESSOR SHAPE IS NOT REACHABLE FROM THE EXPORTED API. A first
 * attempt put an optional `successorOf` on `acquireVehicle` itself, with a
 * comment saying only `restoreCommitment` would supply it. A comment is not an
 * enforcement boundary: any backend caller could have passed a terminal root
 * with unrelated evidence and reached successor creation without ever going
 * through the restoration resolver. Module privacy is the boundary; the
 * comment was only ever a wish.
 *
 * ⚠️ AND THE CLAIM IS NOT OPTIONAL. Because attachment happens here, in the
 * same transaction as the opening, a root cannot commit without its episode.
 */
async function executeAcquisition(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    customerId: Id<"customers">;
    createdBy: Id<"users">;
    evidence: CommitmentEvidence;
    lineage: CommitmentLineage;
    predecessor?: Doc<"vehicleCommitmentClaims">;
    target:
      | { kind: "JOIN"; rootId: Id<"commitmentRoots"> }
      | { kind: "ORIGIN" }
      | { kind: "SUCCESSOR"; predecessorRoot: Doc<"commitmentRoots"> };
    adoptReservation?: boolean;
    /** The exact source, when the caller knows it (a named deposit slice). */
    source?: SourceRef;
  }
): Promise<{ rootId: Id<"commitmentRoots">; claimId: Id<"vehicleCommitmentClaims"> }> {
  const rootId =
    args.target.kind === "JOIN"
      ? args.target.rootId
      : await openRoot(ctx, {
          orgId: args.orgId,
          vehicleId: args.vehicleId,
          customerId: args.customerId,
          createdBy: args.createdBy,
          lineage: args.lineage,
          ...(args.target.kind === "SUCCESSOR"
            ? {
                opening: {
                  kind: "SUCCESSOR" as const,
                  predecessor: args.target.predecessorRoot,
                },
              }
            : {}),
        });

  // ⚠️ ADOPTION RE-HEADS THE DEAL, IN ONE PLACE. Once a reservation's deal is
  // continued under a quote, that quote becomes the revision the root is known
  // by — so every later door (a further deposit, a finance application) proves
  // lineage by quote in the ordinary way instead of re-adopting. The
  // conversion happens exactly once, here, and is auditable.
  //
  // ⚠️ RESTORATION NEVER REACHES THIS. `adoptReservation` is set only by
  // `acquireVehicle` from its own ADOPT_RESERVATION decision: dormant evidence
  // may not re-head a deal as a side effect of being reinstated.
  if (args.adoptReservation && args.lineage.quoteId) {
    await ctx.db.patch(rootId, { headQuoteId: args.lineage.quoteId });
  }

  const claimId = await attachEpisode(ctx, {
    orgId: args.orgId,
    rootId,
    vehicleId: args.vehicleId,
    evidence: args.evidence,
    createdBy: args.createdBy,
    quoteId: args.lineage.quoteId ?? null,
    predecessor: args.predecessor,
  });

  // ⚠️ THE POINTER IS STAMPED IN THE SAME TRANSACTION AS THE CLAIM, ON EVERY
  // PATH — not only on restoration. A pointer that appears only after a
  // restoration is absent for every ordinary deal, so the first reader to
  // consult it fails closed on healthy data.
  await stampAcquisitionPointer(ctx, {
    orgId: args.orgId,
    source: args.source ?? sourceRefOfEvidence(args.evidence),
    vehicleId: args.vehicleId,
    claimId,
  });

  return { rootId, claimId };
}

/** The source a piece of evidence names, without a slice it cannot know yet. */
function sourceRefOfEvidence(evidence: CommitmentEvidence): SourceRef {
  if (evidence.kind === "DEPOSIT") return { kind: "DEPOSIT", depositId: evidence.depositId };
  if (evidence.kind === "FINANCE") return { kind: "FINANCE", applicationId: evidence.applicationId };
  return { kind: "RESERVATION", reservationId: evidence.reservationId };
}

/**
 * SCRUM-208 — MAY THIS EVIDENCE CONTINUE THIS FINISHED DEAL? **Writes nothing.**
 *
 * The restoration counterpart to `resolveActingRoot`: one place that decides,
 * returning an explicit decision rather than a nullable value a caller reads
 * as "then open one". It is a pure resolver so it can be tested directly —
 * a root-WRITING helper cannot be, because testing one proves a path exists
 * that bypasses the door.
 *
 * The rules, in order:
 *
 * 1. **The evidence must already hold a CURRENT episode.** `NEW` is first
 *    acquisition and can never be restoration: accepting it would let a
 *    restoration open a root with no provenance back to what was reversed,
 *    and every later check would find that root perfectly well-formed.
 * 2. **The principal is proven against the lineage**, not against whoever is
 *    presenting the evidence.
 * 3. **The tip is resolved MAX-GENERATION-FIRST.** An OPEN root below a later
 *    terminal generation is corruption, not a tip.
 * 4. **The intent must name the exact reason this root ended** — the exact
 *    sale that consumed it, or the exact episode whose release ended it.
 *    "Some sale was cancelled" would let any cancellation in the dealership
 *    restore any root.
 * 5. **A rival never has its vehicle taken.** If another deal holds the car,
 *    the money still goes back but the vehicle does not move.
 */
export async function resolveRestorationDecision(
  ctx: MutationCtx,
  args: {
    decision: AuthorityDecisionContext;
    /** The exact source row — a sliced deposit names its hold row. */
    source: SourceRef;
    vehicleId: Id<"vehicles">;
    intent: RestorationIntent;
  }
): Promise<RestorationDecision> {
  const { decision, source, vehicleId, intent } = args;
  requireCanonicalAuthority(decision);

  // ⚠️ ONE BINDING, WALKED FROM THE SOURCE ROW. The caller names a source and
  // a car; everything else — the episode, the root, the lineage, the principal
  // and the defining evidence — is read from the database. There is no second
  // identity to disagree with the first.
  const bound = await resolveCanonicalBinding(ctx, decision, { source, vehicleId });
  if (!bound.ok) return { decision: "REFUSE", reason: bound.reason };
  const { binding } = bound;

  const tip = await resolveLineageTip(ctx, decision, binding.root.lineageRootId!);
  if (tip.kind === "CORRUPT") {
    return { decision: "REFUSE", reason: `the deal's history is inconsistent (${tip.reason})` };
  }
  if (String(tip.root.vehicleId) !== String(vehicleId)) {
    return { decision: "REFUSE", reason: "that evidence belongs to a different vehicle's deal" };
  }
  if (String(tip.root.customerId) !== String(binding.customerId)) {
    return {
      decision: "REFUSE",
      reason: "that record belongs to a different customer than the deal it names",
    };
  }

  /** Did this episode end for the exact reason the caller gave? */
  const endedForThisReason = (claim: Doc<"vehicleCommitmentClaims">): boolean =>
    intent.kind === "SALE_CANCELLED"
      ? claim.status === "CONSUMED" &&
        String(claim.consumedBySaleId ?? "") === String(intent.saleId)
      : claim.status === "RELEASED";

  // ⚠️ THE POINTER NAMES A LIVE EPISODE — this is a replay, not a restoration.
  //
  // Claim status alone proves nothing, so the replay answer requires the whole
  // chain: the named episode is ACTIVE, its root is OPEN and is the validated
  // tip, the SOURCE is still live, and the predecessor it succeeded is the
  // episode the caller's intent actually names. A caller naming the wrong sale
  // is refused here rather than handed "already done".
  /**
   * How many successors this episode already has, tenant-scoped and exact.
   *
   * ⚠️ RUN ON BOTH BRANCHES. A first version probed only when the pointer
   * named a TERMINAL episode, so once the pointer had moved to a live
   * successor a SECOND successor branching from the same predecessor was
   * invisible and the replay path reported success over corrupt state.
   */
  const successorsOf = async (claimId: Id<"vehicleCommitmentClaims">) =>
    await ctx.db
      .query("vehicleCommitmentClaims")
      .withIndex("by_org_restored_from", (q) =>
        q.eq("orgId", decision.orgId).eq("restoredFromClaimId", claimId)
      )
      .take(2);

  const branched = {
    decision: "REFUSE" as const,
    reason: "this evidence has been reinstated more than once, which is inconsistent state",
  };

  if (binding.claim.status === "ACTIVE") {
    const predecessorId = binding.claim.restoredFromClaimId;
    if (!predecessorId) {
      return { decision: "REFUSE", reason: "that evidence is still live and has nothing to restore" };
    }
    if ((await successorsOf(predecessorId)).length > 1) return branched;

    const predecessor = await ctx.db.get(predecessorId);
    if (!predecessor || String(predecessor.orgId) !== String(decision.orgId)) {
      return { decision: "REFUSE", reason: "the episode this one succeeded no longer exists" };
    }
    // ⚠️ INTENT FIRST, AND ITS OWN REASON. Naming the wrong sale is a
    // different failure from a stale episode, and reporting it as the latter
    // would send whoever hit it looking for corruption that is not there.
    if (!endedForThisReason(predecessor)) {
      return {
        decision: "REFUSE",
        reason:
          intent.kind === "SALE_CANCELLED"
            ? predecessor.status === "CONSUMED"
              ? "that sale is not the one this deal was completed into"
              : "that evidence was not completed into a sale"
            : "that evidence was not released",
      };
    }
    const proven =
      binding.live &&
      binding.root.status === "OPEN" &&
      String(binding.root._id) === String(tip.root._id);
    if (proven) {
      return { decision: "ALREADY_LIVE", rootId: binding.root._id, claimId: binding.claim._id };
    }
    return {
      decision: "REFUSE",
      reason:
        "this evidence has already been reinstated, and its current episode no longer holds this vehicle",
    };
  }

  // The exact reason THIS episode ended. Claim-level, because with dormant
  // siblings the tip's own ending is a different event from this episode's.
  if (!endedForThisReason(binding.claim)) {
    return {
      decision: "REFUSE",
      reason:
        intent.kind === "SALE_CANCELLED"
          ? binding.claim.status === "CONSUMED"
            ? "that sale is not the one this deal was completed into"
            : "that evidence was not completed into a sale"
          : "that evidence was not released",
    };
  }

  // ⚠️ AN EPISODE IS SUCCEEDED ONCE — EXACT, TENANT-SCOPED UNIQUENESS PROBE.
  //
  // `.first()` on the bare `by_restored_from` could not do this job twice
  // over: a corrupt foreign-tenant row ordered first HIDES a valid same-tenant
  // successor, and one row cannot reveal that TWO successors branch from the
  // same predecessor.
  const successors = await successorsOf(binding.claim._id);
  if (successors.length > 1) return branched;
  if (successors.length === 1) {
    // The pointer still names the terminal predecessor while a successor
    // exists: the two disagree, and the honest answer is neither of them.
    return {
      decision: "REFUSE",
      reason:
        "this evidence has already been reinstated, and its current episode no longer holds this vehicle",
    };
  }

  // I1 — one physical vehicle, at most one OPEN root. Checked against the
  // VEHICLE, not the lineage: a rival deal is a different lineage entirely.
  //
  // ⚠️ BEFORE THE JOIN DECISION. One valid open lineage plus a second OPEN
  // root on the same car is corruption, and joining the first while the second
  // exists would quietly bless it.
  const ownership = await resolveOwnership(ctx, decision.orgId, tip.root.vehicleId);
  if (ownership.kind === "AMBIGUOUS") return { decision: "AMBIGUOUS" };

  if (tip.isOpen) {
    if (ownership.kind !== "OWNED" || String(ownership.root._id) !== String(tip.root._id)) {
      return {
        decision: "REFUSE",
        reason: "the deal's records disagree about which root holds this vehicle",
      };
    }
    return { decision: "JOIN_LINEAGE", rootId: tip.root._id };
  }

  if (ownership.kind === "OWNED") return { decision: "RIVAL", rivalRootId: ownership.root._id };

  return { decision: "OPEN_SUCCESSOR", predecessor: tip.root };
}

/**
 * SCRUM-208 — THE RESTORATION DOOR. Decide, then execute through `acquireVehicle`.
 *
 * ⚠️ IT DOES NOT OPEN A ROOT ITSELF. Execution goes through `acquireVehicle`,
 * which owns the one call to the one private `openRoot` and which attaches the
 * episode in the same transaction. That is what makes "an OPEN successor with
 * no claim" unreachable rather than merely discouraged — and it is the
 * correction to a first attempt that gave succession its own insert.
 */
export async function restoreCommitment(
  ctx: MutationCtx,
  args: {
    decision: AuthorityDecisionContext;
    /** The exact source row — a sliced deposit names its hold row. */
    source: SourceRef;
    vehicleId: Id<"vehicles">;
    intent: RestorationIntent;
    /** Lineage PROOF for the new episode. It never reaches root identity. */
    lineage: CommitmentLineage;
    createdBy: Id<"users">;
  }
): Promise<RestorationOutcome> {
  const resolved = await resolveRestorationDecision(ctx, {
    decision: args.decision,
    source: args.source,
    vehicleId: args.vehicleId,
    intent: args.intent,
  });
  if (
    resolved.decision === "REFUSE" ||
    resolved.decision === "RIVAL" ||
    resolved.decision === "AMBIGUOUS" ||
    resolved.decision === "ALREADY_LIVE"
  ) {
    return resolved;
  }

  // Re-resolved rather than carried out of the decision, so the episode and
  // the evidence come from the SAME walk of the same chain.
  const bound = await resolveCanonicalBinding(ctx, args.decision, {
    source: args.source,
    vehicleId: args.vehicleId,
  });
  if (!bound.ok) return { decision: "REFUSE", reason: bound.reason };

  const target =
    resolved.decision === "JOIN_LINEAGE"
      ? ({ kind: "JOIN", rootId: resolved.rootId } as const)
      : ({ kind: "SUCCESSOR", predecessorRoot: resolved.predecessor } as const);

  const { rootId, claimId } = await executeAcquisition(ctx, {
    orgId: args.decision.orgId,
    vehicleId: args.vehicleId,
    // Carried from the lineage the resolver validated, never from the caller.
    customerId: bound.binding.customerId,
    createdBy: args.createdBy,
    // ⚠️ DERIVED FROM THE VALIDATED PREDECESSOR CLAIM, never supplied beside
    // it. Two independently composable identities could name different rows;
    // one identity cannot disagree with itself.
    evidence: bound.binding.evidence,
    lineage: args.lineage,
    predecessor: bound.binding.claim,
    target,
    source: args.source,
  });

  // ⚠️ ONE ATOMIC POSTCONDITION — ALL FOUR, OR NONE.
  //
  //   the source is live for THIS vehicle
  //   the successor claim is attached
  //   the source pointer names that claim
  //   the root authority is OPEN
  //
  // Re-READ rather than assumed from the writes above: the point of a
  // postcondition is that it observes the committed state, not the intent that
  // produced it. Throwing here rolls the whole mutation back, because a
  // Convex mutation is one transaction — which is exactly what makes "all four
  // or none" expressible at all.
  const after = await resolveCanonicalBinding(ctx, args.decision, {
    source: args.source,
    vehicleId: args.vehicleId,
  });
  if (!after.ok) {
    throw new ConvexError(
      "This vehicle's records did not settle consistently, so the restoration was not applied."
    );
  }
  if (
    !after.binding.live ||
    String(after.binding.claim._id) !== String(claimId) ||
    String(after.binding.root._id) !== String(rootId) ||
    after.binding.root.status !== "OPEN"
  ) {
    throw new ConvexError(
      "This vehicle's records did not settle consistently, so the restoration was not applied."
    );
  }

  return {
    decision: "RESTORED",
    rootId,
    claimId,
    opened: resolved.decision === "JOIN_LINEAGE" ? "JOINED" : "SUCCESSOR",
  };
}

/**
 * The evidence a released deposit slice should be re-acquired under.
 *
 * CARRIED FROM THE SOURCE EPISODE, NOT ASSUMED FROM THE ROW AND NOT REDISCOVERED
 * FROM HISTORY. A deposit taken with a reservation is RESERVATION evidence that
 * happens to have a deposit attached. Re-acquiring it as `{ kind: "DEPOSIT" }`
 * because the surrounding row is a `depositVehicleHolds` is precisely the
 * inference this replacement removes: it is what turned a consumed reservation
 * episode into a live DEPOSIT-kind claim on a second root.
 *
 * ## Why a pointer, and not a search
 *
 * The first correction of this function asked the right question — which
 * episode does THIS car's slice of THIS money come from — but answered it by
 * reading every episode sharing that deposit and that vehicle and checking they
 * agreed. Agreement is the NORMAL case, so the read grew with the deal's
 * history: a reproduction of ordinary reacquisition read 61 rows to return one
 * answer, and an authority that eventually meets Convex's transaction limit is
 * not a complete authority. Bounding it with a page size would have been worse
 * still, reintroducing the truncated-read correctness boundary SCRUM-195 exists
 * to remove.
 *
 * So the hold carries the exact claim it was created alongside (M2's own rule:
 * evidence is tagged and carried, never rediscovered), and this is one `get`.
 * A pointer rather than copied evidence columns, so there is no second,
 * independently mutable copy of the truth to drift.
 *
 * ⚠️ AND IT FAILS CLOSED. Every Phase-1 writer stamps the pointer, so a hold
 * without one is either state from before the canonical model (SCRUM-201 owns
 * the cutover) or a row written incompletely — never an ordinary deposit-only
 * hold to be waved through. The permissive "no claim anywhere, therefore
 * DEPOSIT" default this function used to end on is gone: it existed to cover a
 * shape the model no longer produces, and certifying it with a test would have
 * pinned an assumption instead of removing it.
 */
export async function evidenceForDepositHold(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  hold: Doc<"depositVehicleHolds">
): Promise<CommitmentEvidence> {
  if (!hold.sourceCommitmentClaimId) {
    throw new ConvexError(COMMITMENT_MESSAGES.unprovenProvenance);
  }
  const claim = await ctx.db.get(hold.sourceCommitmentClaimId);
  // The pointer is checked against the row it is stored on rather than trusted.
  // A dangling id, another dealership's episode, or one belonging to a
  // different car or a different deposit all mean the same thing: this hold
  // cannot prove where it came from.
  if (!claim || claim.orgId !== orgId) {
    throw new ConvexError(COMMITMENT_MESSAGES.unprovenProvenance);
  }
  if (String(claim.vehicleId) !== String(hold.vehicleId)) {
    throw new ConvexError(COMMITMENT_MESSAGES.unprovenProvenance);
  }
  if (!claim.depositId || String(claim.depositId) !== String(hold.depositId)) {
    throw new ConvexError(COMMITMENT_MESSAGES.unprovenProvenance);
  }
  return evidenceOf(claim);
}

/**
 * Refuse to take a car out from under a live deal.
 *
 * The decision-only form of `resolveActingRoot`, for a door that must know it
 * MAY act on the car before it starts writing, but is not yet opening the
 * episode itself. Every non-REFUSE decision passes, adoption included.
 *
 * ⚠️ WHAT ACTUALLY ROUTES THROUGH HERE. Acquisition: `deposits.create`,
 * `applications.createFromQuote` and `vehicles.createReservation` — each
 * checking every car on the deal before any side effect, and each following up
 * with `acquireVehicle` once its own row exists. SALE COMPLETION also routes
 * here as of M3, through `assertSaleMayCompleteForVehicle`, which all four
 * completion doors reach via the shared boundary in `utils/saleCompletion.ts`.
 *
 * Still NOT here: trade-ins, and inventory removal — `vehicles.softDelete` uses
 * the stricter `assertVehicleNotCommitted` instead. This comment describes the
 * code rather than the plan, so it is corrected whenever the code moves; it
 * said sale completion was unwired for one commit after M3 wired it.
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


// ─────────────────────────────────────────────────────────────────────────────
// M3 — FINALIZATION. The two terminal transitions, and the one predicate that
// decides whether a car is still held.
//
// Phase 2 writes EXACTLY these root fields and NOTHING on the claims:
//
//     a sale completes for a committed car  ->  OPEN -> CONSUMED
//                                               consumedBySaleId, closedAt, closedReason
//     the last live basis lets the car go   ->  OPEN -> RELEASED
//                                               closedAt, closedReason
//
// Claim lifecycle is Phase 3's entirely. A claim on a CONSUMED root stays
// ACTIVE, which is exactly why claim status is NOT a liveness signal below.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE finance statuses that hold a vehicle. ONE LIST.
 *
 * Hoisted out of `applications.createFromQuote`'s handler, where it was a local
 * `const` that only the acquisition guard could see. The release side needs the
 * same answer, and two independently-maintained copies of "which finance
 * statuses hold a car" is precisely the distributed inference SCRUM-195 exists
 * to remove — the same shape as the six acquisition writers that each decided
 * evidence kind for themselves.
 *
 * It lives here rather than in `applications.ts` because `applications.ts`
 * already imports this module; the reverse would be an import cycle, and a
 * cycle around a `const` array is a real hazard rather than a style point.
 *
 * DRAFT is unreachable through any product door (`createFromQuote` writes
 * PENDING_DOCS) and is retained because the existing guard retained it: a DRAFT
 * row from before this model is conservatively treated as holding the car.
 */
/**
 * Re-exported so existing importers keep working, but DEFINED ONCE in
 * `utils/financeStatuses.ts` — the source module needs the same list and a
 * second copy of it is the distributed-inference defect, not a convenience.
 */
export { IN_FLIGHT_FINANCE_STATUSES } from "./utils/financeStatuses";

/**
 * IS ANY INDEPENDENT BASIS STILL HOLDING THIS CAR?
 *
 * The owner's rule (c15683): releasing one piece of evidence removes THAT
 * evidence and nothing else. The root stays OPEN while another independent live
 * basis legitimately holds the vehicle, so the money operation can succeed
 * without pretending the deal ended.
 *
 * ⚠️ DO NOT REPLACE THIS WITH `syncVehicleHoldStatus`'s `hasHold`. That
 * function answers a DIFFERENT question — "should the vehicle row read
 * RESERVED" — and FINANCE IS NOT IN IT. Reusing it would release a root while
 * an APPROVED application still held the car.
 *
 * ⚠️ AND IT IS NOT READ OFF THE CLAIMS. Under B+ claims stay ACTIVE forever,
 * including on a CONSUMED root, so `claim.status === "ACTIVE"` is not evidence
 * that anything still holds the car. Every basis below is read from the source
 * record that actually confers the hold.
 */
export async function hasLiveCommitmentBasis(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    /** The ONE clock reading for this decision. See `resolveActingRoot`. */
    decisionNow: number;
    /**
     * Kinds to treat as already gone.
     *
     * For an operation that is ITSELF about to end a basis and needs to know
     * whether anything ELSE holds the car — `deposits.releaseVehicleAllocation`
     * asking "may I take this car out of the deal?" while its own deposit
     * obviously still holds it. Without this the answer is always yes and the
     * guard never fires.
     */
    excludeKinds?: ReadonlyArray<"DEPOSIT" | "RESERVATION" | "FINANCE">;
  }
): Promise<boolean> {
  const skip = (kind: "DEPOSIT" | "RESERVATION" | "FINANCE") =>
    args.excludeKinds !== undefined && args.excludeKinds.includes(kind);

  // DEPOSIT — the product's own definition of a deposit hold, not a second
  // opinion about it. On a multi-vehicle quote a row holds a car only while
  // that car's own share is live, which `getActiveDepositHolds` already knows.
  if (!skip("DEPOSIT") && (await hasActiveDepositHold(ctx, args.vehicleId))) return true;

  // RESERVATION — the certified predicate, with the decision's own clock. An
  // ACTIVE row past its expiry is NOT live, merely unswept: the sweep's own
  // query is the spec, and `.take(100)` means a backlog can stretch that window
  // well past the cron.
  if (!skip("RESERVATION")) {
    for await (const reservation of ctx.db
      .query("vehicleReservations")
      .withIndex("by_org_vehicle_status", (q) =>
        q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId).eq("status", "ACTIVE")
      )) {
      if (reservationIsLive(reservation, args.decisionNow)) return true;
    }
  }

  // FINANCE — an application still able to progress toward finalization.
  if (!skip("FINANCE")) {
    for await (const application of ctx.db
      .query("financeApplications")
      .withIndex("by_vehicle", (q) => q.eq("vehicleId", args.vehicleId))) {
      if (application.orgId !== args.orgId) continue;
      if (FINANCE_IN_FLIGHT.includes(application.status)) return true;
    }
  }

  return false;
}

/**
 * The one OPEN root this org holds on this car, with the tenant boundary IN THE
 * ACCESS PATH rather than checked afterwards.
 *
 * Returns null when the car is free — Phase 2 must never invent a root merely
 * to have something to close. Refuses when two OPEN roots exist, because that
 * is one car promised to two deals and picking one would launder the corruption
 * into a terminal state.
 */
async function openRootForFinalization(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<Doc<"commitmentRoots"> | null> {
  const ownership = await resolveOwnership(ctx, orgId, vehicleId);
  if (ownership.kind === "FREE") return null;
  if (ownership.kind === "AMBIGUOUS") {
    throw new ConvexError(COMMITMENT_MESSAGES.ambiguousOwnership);
  }
  const root = ownership.root;
  // Belt and braces. `resolveOwnership` already scopes by orgId through the
  // index, so this can only fire if that ever stops being true — which is
  // exactly when a silent cross-tenant write would otherwise happen.
  if (root.orgId !== orgId || String(root.vehicleId) !== String(vehicleId)) {
    throw new ConvexError(COMMITMENT_MESSAGES.ambiguousOwnership);
  }
  return root;
}

/**
 * OPEN -> CONSUMED. The deal completed into a sale.
 *
 * Write-once and monotonic: only an OPEN root is ever transitioned, and a
 * terminal root is invisible to `resolveOwnership`, so a replay is a no-op
 * rather than a rewrite. Nothing here may overwrite an existing `closedAt`,
 * `closedReason` or `consumedBySaleId` — a deal becomes a sale once.
 *
 * FREE VEHICLE: nothing happens, deliberately. A genuine walk-in sale must not
 * cause a root to be invented so finalization has something to close.
 */
export async function consumeRootForSale(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    saleId: Id<"sales">;
    reason: string;
    decisionNow: number;
  }
): Promise<void> {
  const root = await openRootForFinalization(ctx, args.orgId, args.vehicleId);
  if (!root) return;

  // THE SALE MUST BE THIS ORG'S, AND ABOUT THIS CAR. Root provenance is the
  // entry point Phase 3 will use to go from a cancelled sale back to its deal,
  // so a stamp naming another tenant's sale would be worse than no stamp.
  const sale = await ctx.db.get(args.saleId);
  if (!sale || sale.orgId !== args.orgId || String(sale.vehicleId) !== String(args.vehicleId)) {
    throw new ConvexError(COMMITMENT_MESSAGES.saleProvenanceMismatch);
  }

  await ctx.db.patch(root._id, {
    status: "CONSUMED" as const,
    consumedBySaleId: args.saleId,
    closedAt: args.decisionNow,
    closedReason: args.reason,
  });
}

/**
 * OPEN -> RELEASED, but ONLY when nothing else still holds the car.
 *
 * Call this at the END of a door's handler, after that door's own writes have
 * ended its own basis. Evaluated any earlier it would read a basis the same
 * mutation is about to retire and leave the root open forever — which is the
 * compound case `releaseHoldForApplicationQuote` produces, ending a FINANCE and
 * a RESERVATION basis in one call.
 *
 * A release is not a sale: `consumedBySaleId` is never written here.
 */
/**
 * SCRUM-208 — WHAT THE VEHICLE AUTHORITY DID AFTER A REVERSAL POSTED.
 *
 * ⚠️ ONCE THE JOURNAL EXISTS, AN AUTHORITY OUTCOME IS NOT AN ACCOUNTING
 * FAILURE. The money has already moved back. A fail-closed throw at this point
 * lands in the outbox drain's generic `catch` and becomes `markEntryFailed`
 * with a bare `lastError` — indistinguishable from a transient posting error,
 * even though it is expected business behaviour that a human must act on.
 *
 * So this never throws. It returns which of the three things happened, and the
 * caller records it durably.
 */
export type DeferredAuthorityOutcome =
  /** Authority is consistent: the car was freed, or was already free. */
  | { outcome: "RESTORED" }
  /**
   * Another basis legitimately still holds the car — a finance application
   * mid-flight, a live reservation. The reversal stands and the vehicle does
   * not move. **A rival never has its vehicle taken.**
   */
  | { outcome: "ACCOUNTING_REVERSED_NO_AUTHORITY_RIVAL"; rootId: Id<"commitmentRoots"> }
  /**
   * Two OPEN roots on one car. Refusing to choose stays correct, but it must
   * be a DURABLE, findable repair condition — not a retry that will fail
   * identically forever with a message nobody can distinguish.
   */
  | { outcome: "ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_AMBIGUOUS"; detail: string };

/**
 * Settle the vehicle authority after a reversal has posted. **Never throws.**
 *
 * Uses the certified release machinery rather than a second opinion about
 * liveness: `releaseRootIfNoLiveBasis` already knows that a deposit, a
 * reservation and an in-flight finance application each hold a car, and that
 * releasing one basis does not release the others.
 */
export async function settleAuthorityAfterReversal(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    /** ONE clock reading for the whole decision. */
    decisionNow: number;
    reason: string;
  }
): Promise<DeferredAuthorityOutcome> {
  const before = await resolveOwnership(ctx, args.orgId, args.vehicleId);
  if (before.kind === "AMBIGUOUS") {
    // ⚠️ LEFT BYTE-IDENTICAL FOR A HUMAN TO REPAIR. Choosing between two OPEN
    // roots is the failure this authority exists to prevent, so it declines —
    // loudly and durably, rather than as a retryable error.
    return {
      outcome: "ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_AMBIGUOUS",
      detail: `${before.roots.length} open commitment roots on this vehicle`,
    };
  }
  if (before.kind === "FREE") return { outcome: "RESTORED" };

  await releaseRootIfNoLiveBasis(ctx, {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    reason: args.reason,
    decisionNow: args.decisionNow,
  });

  const after = await resolveOwnership(ctx, args.orgId, args.vehicleId);
  if (after.kind === "FREE") return { outcome: "RESTORED" };
  if (after.kind === "AMBIGUOUS") {
    return {
      outcome: "ACCOUNTING_REVERSED_AUTHORITY_BLOCKED_AMBIGUOUS",
      detail: `${after.roots.length} open commitment roots on this vehicle`,
    };
  }
  // Still held, and legitimately so: something else on this car is still live.
  return { outcome: "ACCOUNTING_REVERSED_NO_AUTHORITY_RIVAL", rootId: after.root._id };
}

export async function releaseRootIfNoLiveBasis(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    reason: string;
    decisionNow: number;
  }
): Promise<void> {
  const root = await openRootForFinalization(ctx, args.orgId, args.vehicleId);
  if (!root) return;

  if (
    await hasLiveCommitmentBasis(ctx, {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      decisionNow: args.decisionNow,
    })
  ) {
    return;
  }

  await ctx.db.patch(root._id, {
    status: "RELEASED" as const,
    closedAt: args.decisionNow,
    closedReason: args.reason,
  });
}

/**
 * REFUSE TO TAKE A CAR OUT FROM UNDER A LIVE DEAL, at an operation whose actual
 * meaning is "remove this car" rather than "end this evidence".
 *
 * `deposits.releaseVehicleAllocation` and `vehicles.softDelete` do not get to
 * end a finance application or a reservation because somebody clicked a button
 * about the car. The operator ends that workflow explicitly first.
 */
export async function assertNoLiveBasisHolds(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    decisionNow: number;
    message: string;
    /**
     * The basis this operation is itself ending. Excluded so the question is
     * "does anything ELSE hold this car", which is the one being asked.
     */
    excludeKinds?: ReadonlyArray<"DEPOSIT" | "RESERVATION" | "FINANCE">;
  }
): Promise<void> {
  const root = await openRootForFinalization(ctx, args.orgId, args.vehicleId);
  if (!root) return;
  if (
    await hasLiveCommitmentBasis(ctx, {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      decisionNow: args.decisionNow,
      excludeKinds: args.excludeKinds,
    })
  ) {
    throw new ConvexError(args.message);
  }
}

/**
 * REFUSE TO REMOVE A CAR THAT IS STILL COMMITTED, at all.
 *
 * Deliberately stronger than `assertNoLiveBasisHolds`: this asks the canonical
 * authority whether ANY open commitment exists, not whether a basis is live.
 * Taking a car out of inventory while a deal holds it strands that root where
 * no door can reach it — the car is gone from every listing, so the operator
 * cannot navigate to the deal to end it properly.
 */
export async function assertVehicleNotCommitted(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    message: string;
  }
): Promise<void> {
  const root = await openRootForFinalization(ctx, args.orgId, args.vehicleId);
  if (root) throw new ConvexError(args.message);
}

/**
 * MAY THIS SALE COMPLETE ON THIS CAR? The completion-time authority.
 *
 * ⚠️ ACQUISITION-TIME AUTHORITY IS NOT SUFFICIENT, and this is not
 * belt-and-braces. A deal can be approved, closed through a different door, and
 * cancelled — leaving the root CONSUMED and the application still APPROVED,
 * because sale cancellation never touches `financeApplications`. Another
 * customer then legitimately acquires the car, and the stale application still
 * satisfies every `finalizeDeal` precondition. Only a check HERE stops it
 * selling that customer's car out from under them.
 *
 * It is also what makes CONSUME well defined at all: if a rival may complete a
 * sale on a car whose root belongs to somebody else, then "the sale consumes
 * the root" would stamp the HELD customer's root with the RIVAL's sale.
 *
 * A FREE vehicle passes — a walk-in sale is ordinary business.
 */
export async function assertSaleMayCompleteForVehicle(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    lineage: CommitmentLineage;
    actingCustomerId?: Id<"customers"> | null;
  }
): Promise<void> {
  await assertAcquirable(ctx, {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    lineage: args.lineage,
    actingCustomerId: args.actingCustomerId,
    message: COMMITMENT_MESSAGES.heldByAnotherDealSale,
  });
}
