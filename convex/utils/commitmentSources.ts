/**
 * SCRUM-208 — THE CANONICAL SOURCE BINDING.
 *
 * ## One object, resolved from the database, or nothing
 *
 * A first version of restoration took TWO independently composable identities —
 * the principal-bound evidence and the commitment evidence — attached using one
 * and repointed using the other. Nothing structurally prevented terminal claim
 * A being restored while source reference B was repointed at A's successor.
 *
 * So there is now one resolver, and it walks a single chain:
 *
 *   source row -> maintained pointer -> exact claim -> exact root
 *              -> lineage and principal
 *
 * The evidence a restoration attaches under is DERIVED from the validated
 * claim, never supplied beside it. Two identities cannot disagree when there is
 * only one.
 *
 * ## Liveness is read from the source, never from a claim
 *
 * `commitments.ts` states the rule: claims stay ACTIVE forever, including on a
 * terminal root, so `claim.status === "ACTIVE"` is not evidence that anything
 * still holds the car. Liveness comes from the deposit, the reservation or the
 * finance application — per VEHICLE, because a multi-vehicle deposit is live
 * for one car and finished for another at the same instant.
 *
 * ## Provenance is carried, never rediscovered
 *
 * A sliced deposit names its EXACT `depositVehicleHolds` row. An earlier
 * version selected `by_deposit_vehicle(...).order("desc").first()` — the newest
 * hold row for that car — which is a latest-history heuristic and exactly the
 * inference this model exists to remove: RETURN_TO_UNALLOCATED and
 * REALLOCATE_TO_VEHICLE both INSERT fresh holds, so "newest" is a guess about
 * which slice the operation meant.
 */

import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { AuthorityDecisionContext, requireCanonicalAuthority } from "./commitmentKernel";
import { IN_FLIGHT_FINANCE_STATUSES } from "./financeStatuses";

/**
 * The exact source a business operation is acting on.
 *
 * ⚠️ A SLICED DEPOSIT MUST NAME ITS HOLD ROW. The operation knows which slice
 * it is reversing; the resolver must not guess.
 */
export type SourceRef =
  | { kind: "DEPOSIT"; depositId: Id<"deposits">; holdId?: Id<"depositVehicleHolds"> }
  | { kind: "FINANCE"; applicationId: Id<"financeApplications"> }
  | { kind: "RESERVATION"; reservationId: Id<"vehicleReservations"> };

/** The defining evidence of an episode, derived from the claim it belongs to. */
export type DerivedEvidence =
  | { kind: "DEPOSIT"; depositId: Id<"deposits"> }
  | { kind: "FINANCE"; applicationId: Id<"financeApplications"> }
  | { kind: "RESERVATION"; reservationId: Id<"vehicleReservations"> };

export type CanonicalSourceBinding = {
  readonly source: SourceRef;
  readonly orgId: Id<"organizations">;
  readonly vehicleId: Id<"vehicles">;
  /** Principal proven from the SOURCE row, then matched against the root. */
  readonly customerId: Id<"customers">;
  /** Read from the source row. Never from the claim. */
  readonly live: boolean;
  /** The episode the maintained pointer names. */
  readonly claim: Doc<"vehicleCommitmentClaims">;
  readonly root: Doc<"commitmentRoots">;
  /** Derived from `claim`, never supplied alongside it. */
  readonly evidence: DerivedEvidence;
};

export type BindingResult =
  | { ok: true; binding: CanonicalSourceBinding }
  | { ok: false; reason: string };

const refuse = (reason: string): BindingResult => ({ ok: false, reason });

/** The defining reference of a claim, by its own tag. */
export function derivedEvidenceOf(claim: Doc<"vehicleCommitmentClaims">): DerivedEvidence | null {
  if (claim.evidenceKind === "DEPOSIT") {
    return claim.depositId ? { kind: "DEPOSIT", depositId: claim.depositId } : null;
  }
  if (claim.evidenceKind === "FINANCE") {
    return claim.applicationId ? { kind: "FINANCE", applicationId: claim.applicationId } : null;
  }
  return claim.reservationId ? { kind: "RESERVATION", reservationId: claim.reservationId } : null;
}

/** Does this derived evidence name the same row the operation named? */
function evidenceMatchesSource(evidence: DerivedEvidence, source: SourceRef): boolean {
  if (evidence.kind !== source.kind) return false;
  if (evidence.kind === "DEPOSIT" && source.kind === "DEPOSIT") {
    return String(evidence.depositId) === String(source.depositId);
  }
  if (evidence.kind === "FINANCE" && source.kind === "FINANCE") {
    return String(evidence.applicationId) === String(source.applicationId);
  }
  if (evidence.kind === "RESERVATION" && source.kind === "RESERVATION") {
    return String(evidence.reservationId) === String(source.reservationId);
  }
  return false;
}

/**
 * The normalized vehicle set of a finance application, validated.
 *
 * ⚠️ `vehicleItems` IS ABSENT ON SINGLE-VEHICLE APPLICATIONS — the commonest
 * shape — so reading it directly sees zero vehicles for a perfectly ordinary
 * application. The authority is `vehicleItems ?? [{ vehicleId }]`, and the
 * primary vehicle must appear in it.
 */
function normalizedFinanceVehicles(
  application: Doc<"financeApplications">
): { ok: true; vehicles: string[] } | { ok: false; reason: string } {
  const items = application.vehicleItems ?? [{ vehicleId: application.vehicleId }];
  if (items.length === 0) {
    return { ok: false, reason: "that finance application covers no vehicles" };
  }
  const vehicles = items.map((item) => String(item.vehicleId));
  if (new Set(vehicles).size !== vehicles.length) {
    return { ok: false, reason: "that finance application lists the same vehicle twice" };
  }
  if (!vehicles.includes(String(application.vehicleId))) {
    return {
      ok: false,
      reason: "that finance application's primary vehicle is missing from its own vehicle list",
    };
  }
  return { ok: true, vehicles };
}

/**
 * Resolve the one canonical binding for this source and vehicle, or refuse.
 *
 * Every structural violation refuses rather than being repaired here: this is
 * a resolver, and inventing the missing half of a broken record is how a
 * corrupt row becomes an authorized one.
 */
export async function resolveCanonicalBinding(
  ctx: QueryCtx | MutationCtx,
  decision: AuthorityDecisionContext,
  args: { source: SourceRef; vehicleId: Id<"vehicles"> }
): Promise<BindingResult> {
  requireCanonicalAuthority(decision);
  const { source, vehicleId } = args;

  let customerId: Id<"customers">;
  let live: boolean;
  let pointerClaimId: Id<"vehicleCommitmentClaims"> | undefined;

  if (source.kind === "RESERVATION") {
    const reservation = await ctx.db.get(source.reservationId);
    if (!reservation || reservation.orgId !== decision.orgId) {
      return refuse("that reservation could not be found in this dealership");
    }
    if (String(reservation.vehicleId) !== String(vehicleId)) {
      return refuse("that reservation is for a different vehicle");
    }
    customerId = reservation.customerId;
    live =
      reservation.status === "ACTIVE" &&
      (reservation.expiresAt === undefined || reservation.expiresAt > decision.now);
    pointerClaimId = reservation.currentCommitmentClaimId;
  } else if (source.kind === "FINANCE") {
    const application = await ctx.db.get(source.applicationId);
    if (!application || application.orgId !== decision.orgId) {
      return refuse("that finance application could not be found in this dealership");
    }
    const normalized = normalizedFinanceVehicles(application);
    if (!normalized.ok) return refuse(normalized.reason);
    if (!normalized.vehicles.includes(String(vehicleId))) {
      return refuse("that finance application does not cover this vehicle");
    }

    // ⚠️ THE POINTER SET MUST MATCH THE CANONICAL SET EXACTLY — one entry per
    // vehicle, no duplicate, no missing, no extra. A `.find()` over a set that
    // was never proven complete answers confidently from a broken record.
    const pointers = application.currentCommitmentClaims ?? [];
    const pointerVehicles = pointers.map((row) => String(row.vehicleId));
    if (new Set(pointerVehicles).size !== pointerVehicles.length) {
      return refuse("that finance application names two episodes for the same vehicle");
    }
    if (pointerVehicles.length !== normalized.vehicles.length) {
      return refuse("that finance application's episode pointers are incomplete");
    }
    const canonical = new Set(normalized.vehicles);
    if (!pointerVehicles.every((id) => canonical.has(id))) {
      return refuse("that finance application names an episode for a vehicle it does not cover");
    }
    customerId = application.customerId;
    live = IN_FLIGHT_FINANCE_STATUSES.includes(application.status);
    pointerClaimId = pointers.find((row) => String(row.vehicleId) === String(vehicleId))?.claimId;
  } else {
    const deposit = await ctx.db.get(source.depositId);
    if (!deposit || deposit.orgId !== decision.orgId) {
      return refuse("that deposit could not be found in this dealership");
    }
    // ⚠️ `undefined` IS NOT `false`. A deposit with no representation class
    // predates canonical activation and fails closed; reading it as DIRECT
    // would answer for the entire pre-existing dataset.
    if (deposit.usesVehicleHoldRows === undefined) {
      return refuse("that deposit predates the canonical commitment authority");
    }
    const depositUsable = deposit.status === "HELD" && deposit.isDeleted !== true;
    customerId = deposit.customerId;

    if (deposit.usesVehicleHoldRows === false) {
      if (source.holdId !== undefined) {
        return refuse("that deposit does not use per-vehicle hold rows");
      }
      if (String(deposit.vehicleId) !== String(vehicleId)) {
        return refuse("that deposit is held against a different vehicle");
      }
      // ⚠️ THE CORRUPT DUAL FORM REFUSES EVEN WHEN BOTH AGREE. A direct
      // deposit that also carries a hold row has two representations of one
      // fact, and two copies of a fact are two facts — the next writer updates
      // one of them.
      const strayHold = await ctx.db
        .query("depositVehicleHolds")
        .withIndex("by_deposit_vehicle", (q) =>
          q.eq("depositId", deposit._id).eq("vehicleId", vehicleId)
        )
        .first();
      if (strayHold) {
        return refuse("that deposit carries both representations of its hold on this vehicle");
      }
      live = depositUsable && deposit.holdActive === true;
      pointerClaimId = deposit.singleVehicleCommitmentClaimId;
    } else {
      if (source.holdId === undefined) {
        return refuse("that deposit holds this vehicle through a slice that was not named");
      }
      if (deposit.singleVehicleCommitmentClaimId !== undefined) {
        return refuse("that deposit carries both representations of its hold on this vehicle");
      }
      const hold = await ctx.db.get(source.holdId);
      if (!hold || hold.orgId !== decision.orgId) {
        return refuse("that deposit slice could not be found in this dealership");
      }
      if (String(hold.depositId) !== String(deposit._id)) {
        return refuse("that slice belongs to a different deposit");
      }
      if (String(hold.vehicleId) !== String(vehicleId)) {
        return refuse("that slice is for a different vehicle");
      }
      live = depositUsable && hold.active === true;
      pointerClaimId = hold.sourceCommitmentClaimId;
    }
  }

  if (pointerClaimId === undefined) {
    // Either a row written before the canonical model — SCRUM-201's cutover
    // owns those — or one written incompletely. Never "points at whatever you
    // asked about".
    return refuse("that record does not name a current commitment episode");
  }

  const claim = await ctx.db.get(pointerClaimId);
  if (!claim || claim.orgId !== decision.orgId) {
    return refuse("the episode this record names could not be found in this dealership");
  }
  if (String(claim.vehicleId) !== String(vehicleId)) {
    return refuse("the episode this record names is for a different vehicle");
  }
  const evidence = derivedEvidenceOf(claim);
  if (!evidence) {
    return refuse("the episode this record names has no defining evidence");
  }
  if (!evidenceMatchesSource(evidence, source)) {
    return refuse("the episode this record names was opened on different evidence");
  }

  const root = await ctx.db.get(claim.rootId);
  if (!root || root.orgId !== decision.orgId) {
    return refuse("the deal this episode belongs to could not be found in this dealership");
  }
  if (String(root.vehicleId) !== String(vehicleId)) {
    return refuse("the deal this episode belongs to is for a different vehicle");
  }
  if (String(root.customerId) !== String(customerId)) {
    return refuse("that record belongs to a different customer than the deal it names");
  }
  if (root.lineageRootId === undefined || root.lineageGeneration === undefined) {
    return refuse("that deal predates the canonical commitment authority");
  }

  return {
    ok: true,
    binding: { source, orgId: decision.orgId, vehicleId, customerId, live, claim, root, evidence },
  };
}

/**
 * Move the source's maintained pointer onto the episode just opened.
 *
 * ⚠️ IN THE SAME TRANSACTION AS THE ATTACHMENT. A pointer left naming the
 * terminal predecessor while an ACTIVE successor exists makes the next
 * restoration resolve the stale episode as "current" — the drift the pointer
 * exists to remove, reintroduced one step later.
 *
 * ⚠️ IT REFUSES RATHER THAN CREATING STATE. A sliced deposit whose hold row was
 * not named, or a finance application that does not cover the car, is not a row
 * to invent here.
 */
export async function repointSourceToClaim(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    source: SourceRef;
    vehicleId: Id<"vehicles">;
    claimId: Id<"vehicleCommitmentClaims">;
  }
): Promise<void> {
  const { source, vehicleId, claimId } = args;
  const decision = { orgId: args.orgId };

  if (source.kind === "RESERVATION") {
    const reservation = await ctx.db.get(source.reservationId);
    if (!reservation || reservation.orgId !== decision.orgId) {
      throw new ConvexError("That reservation could not be found in this dealership.");
    }
    if (String(reservation.vehicleId) !== String(vehicleId)) {
      throw new ConvexError("That reservation is for a different vehicle.");
    }
    await ctx.db.patch(reservation._id, { currentCommitmentClaimId: claimId });
    return;
  }

  if (source.kind === "FINANCE") {
    const application = await ctx.db.get(source.applicationId);
    if (!application || application.orgId !== decision.orgId) {
      throw new ConvexError("That finance application could not be found in this dealership.");
    }
    const normalized = normalizedFinanceVehicles(application);
    if (!normalized.ok) throw new ConvexError(capitalize(normalized.reason));
    if (!normalized.vehicles.includes(String(vehicleId))) {
      throw new ConvexError("That finance application does not cover this vehicle.");
    }
    const next = (application.currentCommitmentClaims ?? []).filter(
      (row) => String(row.vehicleId) !== String(vehicleId)
    );
    next.push({ vehicleId, claimId });
    // Canonical persisted order, so two equal sets never compare unequal on
    // order alone.
    next.sort((a, b) => String(a.vehicleId).localeCompare(String(b.vehicleId)));
    await ctx.db.patch(application._id, { currentCommitmentClaims: next });
    return;
  }

  const deposit = await ctx.db.get(source.depositId);
  if (!deposit || deposit.orgId !== decision.orgId) {
    throw new ConvexError("That deposit could not be found in this dealership.");
  }
  if (deposit.usesVehicleHoldRows === undefined) {
    throw new ConvexError("That deposit predates the canonical commitment authority.");
  }

  if (deposit.usesVehicleHoldRows === false) {
    if (source.holdId !== undefined) {
      throw new ConvexError("That deposit does not use per-vehicle hold rows.");
    }
    if (String(deposit.vehicleId) !== String(vehicleId)) {
      throw new ConvexError("That deposit is held against a different vehicle.");
    }
    await ctx.db.patch(deposit._id, { singleVehicleCommitmentClaimId: claimId });
    return;
  }

  if (source.holdId === undefined) {
    throw new ConvexError("That deposit holds this vehicle through a slice that was not named.");
  }
  const hold = await ctx.db.get(source.holdId);
  if (!hold || hold.orgId !== decision.orgId) {
    throw new ConvexError("That deposit slice could not be found in this dealership.");
  }
  if (String(hold.depositId) !== String(deposit._id)) {
    throw new ConvexError("That slice belongs to a different deposit.");
  }
  if (String(hold.vehicleId) !== String(vehicleId)) {
    throw new ConvexError("That slice is for a different vehicle.");
  }
  await ctx.db.patch(hold._id, { sourceCommitmentClaimId: claimId });
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1) + ".";
}

/**
 * Stamp the maintained pointer at INITIAL acquisition, atomically with the
 * claim that was just created.
 *
 * ⚠️ RESTORATION MUST NOT BE THE ONLY PATH THAT WRITES THESE FIELDS. A pointer
 * that only ever appears after a restoration is absent for every ordinary
 * deal, so the first thing to consult it fails closed on healthy data and the
 * cutover inherits a field nobody populates.
 *
 * ⚠️ A SLICED DEPOSIT IS DELIBERATELY SKIPPED, NOT FORGOTTEN. Its hold row
 * does not exist yet at this moment — the deposit writer inserts it moments
 * later carrying this very claim id, which is already atomic within the same
 * mutation. Inventing a hold row here would put a hold on a car whose money
 * never had one.
 *
 * @returns whether a pointer was written, so callers can assert on it.
 */
export async function stampAcquisitionPointer(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    source: SourceRef;
    vehicleId: Id<"vehicles">;
    claimId: Id<"vehicleCommitmentClaims">;
  }
): Promise<boolean> {
  if (args.source.kind === "DEPOSIT") {
    const deposit = await ctx.db.get(args.source.depositId);
    if (!deposit || deposit.orgId !== args.orgId) return false;
    // Legacy rows have no representation class and SCRUM-201 owns them; a
    // sliced deposit is stamped by the writer that creates the slice.
    if (deposit.usesVehicleHoldRows !== false) return false;
    if (String(deposit.vehicleId) !== String(args.vehicleId)) return false;
  }
  await repointSourceToClaim(ctx, args);
  return true;
}
