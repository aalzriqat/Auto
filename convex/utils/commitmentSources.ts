/**
 * SCRUM-208 — SOURCE LIVENESS AND THE MAINTAINED EPISODE POINTER.
 *
 * ## Why claim status can never answer "is this live"
 *
 * `commitments.ts` already states the rule that this module exists to enforce:
 * under B+, claims stay ACTIVE forever — including on a CONSUMED root — so
 * `claim.status === "ACTIVE"` is **not** evidence that anything still holds
 * the car. Liveness is read from the SOURCE record that actually confers the
 * hold: the deposit, the reservation, the finance application.
 *
 * That rule was violated the moment restoration grew an idempotency path. A
 * first version returned "already live" from claim status alone, and its test
 * set a successor ROOT to RELEASED while leaving the successor CLAIM ACTIVE
 * and then asserted success — certifying an ACTIVE claim on a terminal root as
 * live, which is precisely the manufactured liveness the header forbids.
 *
 * ## The two questions, kept apart
 *
 * **Is the source still live?** — read from the source row, never the claim.
 * **Which episode does the source currently point at?** — the maintained
 * pointer, which is what makes provenance a `get` instead of a history walk.
 *
 * A source that is live but points at a DIFFERENT episode is not idempotent
 * success; it is a car held under some other episode, and the caller must be
 * told so rather than handed the claim it happened to ask about.
 *
 * ## Repointing
 *
 * When a restoration opens a new episode, the source pointer must move to it
 * in the same transaction. Otherwise the pointer names a terminal claim while
 * an ACTIVE one exists, and the next restoration reads the stale one as its
 * "current" episode — the exact drift the pointer was introduced to remove.
 */

import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { AuthorityDecisionContext, requireCanonicalAuthority } from "./commitmentKernel";

/** The defining reference of an episode, tagged so it is never re-derived. */
export type SourceRef =
  | { kind: "DEPOSIT"; depositId: Id<"deposits"> }
  | { kind: "FINANCE"; applicationId: Id<"financeApplications"> }
  | { kind: "RESERVATION"; reservationId: Id<"vehicleReservations"> };

/** Which episode the source row currently names, if any. */
export type SourcePointer =
  | { kind: "NAMES"; claimId: Id<"vehicleCommitmentClaims"> }
  /**
   * No pointer maintained. Either a row that predates the canonical model —
   * SCRUM-201's cutover owns those — or one written incompletely. Either way
   * it FAILS CLOSED and is never treated as "points at whatever you asked
   * about".
   */
  | { kind: "ABSENT" };

export type SourceState = {
  /** Read from the source row itself. Never from a claim. */
  readonly live: boolean;
  readonly pointer: SourcePointer;
  /** Why it is not live, for diagnosis. Nothing may decide on this text. */
  readonly reason?: string;
};

const NOT_LIVE = (reason: string): SourceState => ({
  live: false,
  pointer: { kind: "ABSENT" },
  reason,
});

/**
 * Statuses in which a finance application can still progress toward
 * finalization, and therefore still holds its cars.
 *
 * Kept here rather than imported from `commitments.ts` to avoid a cycle; the
 * two lists are pinned equal by a contract in `commitmentSources.test.ts`.
 */
export const LIVE_FINANCE_STATUSES: readonly string[] = [
  "DRAFT",
  "PENDING_DOCS",
  "UNDER_REVIEW",
  "APPROVED",
];

/**
 * Is this exact source still a live basis for holding this exact car, and
 * which episode does it currently name?
 *
 * ⚠️ PER-VEHICLE, NOT PER-SOURCE. A multi-vehicle deposit is live for one car
 * and finished for another at the same time, and a finance application holds
 * one claim per vehicle. Asking "is the deposit live" without naming the car
 * is the question that produced the original defect.
 */
export async function resolveSourceState(
  ctx: QueryCtx | MutationCtx,
  decision: AuthorityDecisionContext,
  args: { source: SourceRef; vehicleId: Id<"vehicles"> }
): Promise<SourceState> {
  requireCanonicalAuthority(decision);
  const { source, vehicleId } = args;

  if (source.kind === "RESERVATION") {
    const reservation = await ctx.db.get(source.reservationId);
    if (!reservation || reservation.orgId !== decision.orgId) {
      return NOT_LIVE("that reservation could not be found in this dealership");
    }
    if (String(reservation.vehicleId) !== String(vehicleId)) {
      return NOT_LIVE("that reservation is for a different vehicle");
    }
    const live =
      reservation.status === "ACTIVE" &&
      (reservation.expiresAt === undefined || reservation.expiresAt > decision.now);
    return {
      live,
      pointer: reservation.currentCommitmentClaimId
        ? { kind: "NAMES", claimId: reservation.currentCommitmentClaimId }
        : { kind: "ABSENT" },
      ...(live ? {} : { reason: "that reservation is no longer active" }),
    };
  }

  if (source.kind === "FINANCE") {
    const application = await ctx.db.get(source.applicationId);
    if (!application || application.orgId !== decision.orgId) {
      return NOT_LIVE("that finance application could not be found in this dealership");
    }
    // ⚠️ THE NORMALIZED SET IS THE AUTHORITY. `vehicleItems` is ABSENT on
    // single-vehicle applications — the commonest shape — so reading it
    // directly sees zero vehicles for a perfectly ordinary application.
    const items = application.vehicleItems ?? [{ vehicleId: application.vehicleId }];
    if (!items.some((item) => String(item.vehicleId) === String(vehicleId))) {
      return NOT_LIVE("that finance application does not cover this vehicle");
    }
    const live = LIVE_FINANCE_STATUSES.includes(application.status);
    const entry = (application.currentCommitmentClaims ?? []).find(
      (row) => String(row.vehicleId) === String(vehicleId)
    );
    return {
      live,
      pointer: entry ? { kind: "NAMES", claimId: entry.claimId } : { kind: "ABSENT" },
      ...(live ? {} : { reason: "that finance application is no longer in progress" }),
    };
  }

  const deposit = await ctx.db.get(source.depositId);
  if (!deposit || deposit.orgId !== decision.orgId) {
    return NOT_LIVE("that deposit could not be found in this dealership");
  }
  // ⚠️ `undefined` IS NOT `false`. A deposit with no representation class
  // predates canonical activation and fails closed; reading it as DIRECT would
  // answer for the entire pre-existing dataset.
  if (deposit.usesVehicleHoldRows === undefined) {
    return NOT_LIVE("that deposit predates the canonical commitment authority");
  }
  const depositUsable = deposit.status === "HELD" && deposit.isDeleted !== true;

  if (deposit.usesVehicleHoldRows === false) {
    if (String(deposit.vehicleId) !== String(vehicleId)) {
      return NOT_LIVE("that deposit is held against a different vehicle");
    }
    const live = depositUsable && deposit.holdActive === true;
    return {
      live,
      pointer: deposit.singleVehicleCommitmentClaimId
        ? { kind: "NAMES", claimId: deposit.singleVehicleCommitmentClaimId }
        : { kind: "ABSENT" },
      ...(live ? {} : { reason: "that deposit no longer holds this vehicle" }),
    };
  }

  // SLICED — the hold rows are the whole truth about which cars it holds.
  const hold = await ctx.db
    .query("depositVehicleHolds")
    .withIndex("by_deposit_vehicle", (q) =>
      q.eq("depositId", deposit._id).eq("vehicleId", vehicleId)
    )
    .order("desc")
    .first();
  if (!hold || hold.orgId !== decision.orgId) {
    return NOT_LIVE("that deposit holds no share of this vehicle");
  }
  const live = depositUsable && hold.active === true;
  return {
    live,
    pointer: hold.sourceCommitmentClaimId
      ? { kind: "NAMES", claimId: hold.sourceCommitmentClaimId }
      : { kind: "ABSENT" },
    ...(live ? {} : { reason: "that deposit no longer holds this vehicle" }),
  };
}

/**
 * Move the source's maintained pointer onto the episode just opened.
 *
 * ⚠️ IN THE SAME TRANSACTION AS THE ATTACHMENT. If the pointer is left naming
 * the terminal predecessor while an ACTIVE successor exists, the next
 * restoration resolves the stale episode as "current" — which is the drift the
 * pointer exists to remove, reintroduced one step later.
 *
 * ⚠️ AND IT REFUSES RATHER THAN CREATING STATE. A sliced deposit with no hold
 * row for this car, or a finance application that does not cover it, is not a
 * row to be invented here: the acquisition path owns creating those, and
 * writing one from a restoration would put a hold on a car whose money never
 * had one.
 */
export async function repointSourceToClaim(
  ctx: MutationCtx,
  decision: AuthorityDecisionContext,
  args: {
    source: SourceRef;
    vehicleId: Id<"vehicles">;
    claimId: Id<"vehicleCommitmentClaims">;
  }
): Promise<void> {
  requireCanonicalAuthority(decision);
  const { source, vehicleId, claimId } = args;

  if (source.kind === "RESERVATION") {
    const reservation = await ctx.db.get(source.reservationId);
    if (!reservation || reservation.orgId !== decision.orgId) {
      throw new ConvexError("That reservation could not be found in this dealership.");
    }
    await ctx.db.patch(reservation._id, { currentCommitmentClaimId: claimId });
    return;
  }

  if (source.kind === "FINANCE") {
    const application = await ctx.db.get(source.applicationId);
    if (!application || application.orgId !== decision.orgId) {
      throw new ConvexError("That finance application could not be found in this dealership.");
    }
    const items = application.vehicleItems ?? [{ vehicleId: application.vehicleId }];
    if (!items.some((item) => String(item.vehicleId) === String(vehicleId))) {
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
    if (String(deposit.vehicleId) !== String(vehicleId)) {
      throw new ConvexError("That deposit is held against a different vehicle.");
    }
    await ctx.db.patch(deposit._id, { singleVehicleCommitmentClaimId: claimId });
    return;
  }

  const hold = await ctx.db
    .query("depositVehicleHolds")
    .withIndex("by_deposit_vehicle", (q) =>
      q.eq("depositId", deposit._id).eq("vehicleId", vehicleId)
    )
    .order("desc")
    .first();
  if (!hold || hold.orgId !== decision.orgId) {
    throw new ConvexError("That deposit holds no share of this vehicle.");
  }
  await ctx.db.patch(hold._id, { sourceCommitmentClaimId: claimId });
}
