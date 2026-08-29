/**
 * SCRUM-208 — THE WRITER CHOKE for deposit and reservation liveness.
 *
 * ## Why a choke rather than a convention
 *
 * The Phase-3 writer matrix, enumerated from source rather than assumed, is
 * lopsided in a way that explains four rounds of review findings:
 *
 *   commitmentRoots.status        3 writers, ALL in commitments.ts
 *   vehicleCommitmentClaims       1 writer  (insert-only)
 *   financeApplications.status    1 writer
 *   ---------------------------------------------------------------
 *   deposits.holdActive          12 writers across 5 files
 *   depositVehicleHolds.active   10 writers across 4 files
 *   deposits.status               8 writers across 5 files
 *   vehicleReservations.status    6 writers across 2 files
 *
 * The authority fields have one owner each and have never drifted. The
 * liveness fields have a dozen owners each, three of them raw
 * `ctx.db.patch(reservation.depositId, { holdActive: false })` calls reaching
 * in from `vehicles.ts` — outside the deposit module, sharing no helper with
 * it, and invisible to anyone reading `deposits.ts` to learn how a hold ends.
 *
 * "Remember to cascade everywhere" was never going to hold across that
 * surface. So the write goes through one function, and
 * `scripts/commitmentWriteGuard.ts` fails CI when a new one appears outside
 * it.
 *
 * ## What a stale flag actually costs
 *
 * A `holdActive: true` left behind on a released reservation is not cosmetic.
 * `hasLiveCommitmentBasis` reads it, `releaseRootIfNoLiveBasis` refuses to
 * close the root while it is set, and the vehicle is then STUCK OPEN with
 * nobody holding it — unreachable by any operator door, because the doors that
 * could release it all require the reservation to still be ACTIVE.
 */

import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";

/**
 * Lift the vehicle hold carried by a reservation's own deposit.
 *
 * The one shape shared by every door that ends a reservation — manual release,
 * the inline sweep in `createReservation`, and the cron sweep. Each of those
 * previously carried its own copy of this four-part precondition, which is
 * three chances for the next edit to change one and miss two.
 *
 * ⚠️ THE HOLD IS LIFTED; THE MONEY IS NOT RESOLVED. Expiry and release end the
 * VEHICLE hold only. Whether the عربون is refunded or forfeited stays a
 * manager's decision through `deposits.release`, exactly as it is for every
 * other deposit resolution. Nothing here may decide it.
 *
 * ⚠️ NOT REACHED FOR A DEPOSIT IN ANOTHER TENANT, and not for one already
 * resolved. Returning null rather than throwing is deliberate: a reservation
 * whose deposit was already voided is ordinary history, not an error, and the
 * cron sweep must not take other dealerships down over it.
 *
 * @returns the deposit whose hold was lifted, or null if nothing was written.
 */
export async function releaseReservationDepositHold(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    reservation: Doc<"vehicleReservations">;
    /** Diagnosis only. Nothing may make a decision on this text. */
    reason: string;
  }
): Promise<Doc<"deposits"> | null> {
  if (!args.reservation.depositId) return null;

  const deposit = await ctx.db.get(args.reservation.depositId);
  if (!deposit) return null;
  if (deposit.orgId !== args.orgId) return null;
  if (deposit.status !== "HELD" || !deposit.holdActive) return null;

  await ctx.db.patch(deposit._id, { holdActive: false });
  return deposit;
}
