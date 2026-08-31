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

/**
 * Put a DIRECT deposit's vehicle hold back, once its reversing journal posted.
 *
 * ⚠️ THIS IS THE OTHER HALF OF A DEFERRED CANCELLATION. The cancellation
 * deliberately left `holdActive` false while the reversal sat in the outbox,
 * because on a single-vehicle deposit that flag IS the car hold and setting it
 * early holds a car against an entry the ledger still shows posted. This is
 * where it comes back — and only from the outbox, only once the entry exists.
 *
 * ⚠️ ONLY FOR THE DIRECT REPRESENTATION. A sliced deposit's cars are held by
 * its `depositVehicleHolds` rows, and a slice does not go back on hold at all:
 * it waits for a manager to choose between refund and re-allocation.
 *
 * @returns the deposit whose hold was reinstated, or null if nothing was written.
 */
export async function reinstateDirectDepositHold(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; depositId: Id<"deposits"> }
): Promise<Doc<"deposits"> | null> {
  const deposit = await ctx.db.get(args.depositId);
  if (!deposit) return null;
  if (deposit.orgId !== args.orgId) return null;
  // Money that has left the business is never re-held; a row already holding
  // its car needs nothing.
  if (deposit.status !== "HELD") return null;
  // ⚠️ AND A DELETED ROW IS NOT A USABLE SOURCE — SAY IT HERE, BECAUSE THE
  // READER ALREADY DOES.
  //
  // `resolveCanonicalBinding` computes `depositUsable` as
  // `status === "HELD" && isDeleted !== true`. Without this line the writer and
  // its own paired reader disagree about what a usable source is: the write
  // would set `holdActive: true` on a row the binding then reports as not live,
  // committing a successor root, claim and pointer for a source that cannot
  // hold anything — and `canonicalShadowDepositHold` refuses outright on
  // "a deposit still holds a car after being voided or deleted", so the very
  // next canonical read throws.
  //
  // No production door writes `HELD + isDeleted` today: `deposits.voidDeposit`
  // sets VOIDED and `holdActive: false` in the SAME patch, and `deposits` is
  // not in `adminData`'s ADMIN_TABLES, so the raw editor cannot reach it. That
  // is why this is a guard and not a bug fix — but a writer whose admissibility
  // rule is narrower than its reader's is a trap left for whoever adds the next
  // door, and this branch has already been blocked twice by exactly that shape.
  if (deposit.isDeleted === true) return null;
  if (deposit.holdActive === true) return deposit;
  // ⚠️ NEVER FOR A SLICED DEPOSIT, AND NEVER FOR A LEGACY ROW. `undefined` is
  // not `false`: a deposit with no representation class predates the canonical
  // model and its cutover owns it.
  if (deposit.usesVehicleHoldRows !== false) return null;

  await ctx.db.patch(deposit._id, { holdActive: true });
  return await ctx.db.get(deposit._id);
}
