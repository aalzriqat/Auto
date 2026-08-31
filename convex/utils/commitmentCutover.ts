/**
 * SCRUM-208 — CUTOVER: THE ORACLE, THE SHADOW AND THE COMPARATOR.
 *
 * ## Why the legacy reader is not the oracle
 *
 * The obvious cutover is "backfill, then require the new reader to agree with
 * the old one." That proves nothing, twice over.
 *
 * **The legacy reader contains the defect.** `getActiveDepositHolds` takes 50
 * rows from `by_vehicle_hold` keyed on `holdActive === true` ALONE, then
 * post-filters `status !== "HELD" || isDeleted`. Fifty stale rows on voided or
 * deleted deposits crowd out a genuinely live one — a false negative by
 * construction. Demanding agreement would force the canonical reader to
 * reproduce that bug.
 *
 * **The reconcile tooling calls the very predicate being migrated.**
 * `migrations.ts` `reconcileVehicleHolds` calls `hasActiveDepositHold` AND
 * `hasActiveReservationHold`. A backfill that reads the new access path to
 * decide what to write into the new access path is circular.
 *
 * So there are three readers, not two:
 *
 * ```
 *        independent exhaustive raw-source oracle
 *                          |
 *              +-----------+-----------+
 *              v                       v
 *        legacy reader          canonical shadow reader
 *        drift comparator       MUST match the oracle
 * ```
 *
 * * **canonical ≠ oracle → BLOCKS activation.**
 * * **legacy ≠ oracle → recorded and individually explained.** It does not
 *   block: a disagreement is often a correctly repaired legacy defect.
 *
 * ## ⚠️ The drift is asymmetric, and that asymmetry is itself a signal
 *
 * Only the DEPOSIT predicate carries the capped-read defect.
 * `hasActiveReservationHold` filters to ACTIVE in the index and STREAMS rather
 * than taking a fixed page. So deposit-side drift is expected and each
 * instance must be explained as a known legacy defect; **unexplained
 * reservation-side drift indicts the canonical reader instead.**
 *
 * ## What makes the oracle an oracle
 *
 * It reads raw rows, applies NO cap, never filters after a cap, is never
 * reachable at runtime, and runs per organization. It is deliberately the
 * slowest of the three.
 */

import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { AuthorityVersion } from "./commitmentKernel";

type Ctx = QueryCtx | MutationCtx;

/** Is this deposit row itself usable — money still held, row not deleted? */
function depositUsable(deposit: Doc<"deposits">): boolean {
  return deposit.status === "HELD" && deposit.isDeleted !== true;
}

// ─────────────────────────────────────────────────────────────────────────────
// The oracle. Exhaustive, uncapped, offline.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does anything hold this car through a deposit? **Raw truth.**
 *
 * ⚠️ STREAMED, NEVER TAKEN. `for await` walks the whole range; a `.take(n)`
 * anywhere in here would reintroduce the exact truncation this exists to
 * measure. It is slow on purpose and must never be called at runtime.
 *
 * The definition mirrors the shipped semantics minus the caps: hold rows are
 * the whole truth about which cars a deposit holds WHEN IT HAS ANY, and the
 * deposit's own `vehicleId` counts only when it has none.
 */
export async function oracleDepositHold(
  ctx: Ctx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  for await (const hold of ctx.db
    .query("depositVehicleHolds")
    .withIndex("by_vehicle_active", (q) => q.eq("vehicleId", vehicleId))) {
    if (hold.orgId !== orgId || hold.active !== true) continue;
    const parent = await ctx.db.get(hold.depositId);
    if (parent && parent.orgId === orgId && depositUsable(parent)) return true;
  }

  for await (const deposit of ctx.db
    .query("deposits")
    .withIndex("by_vehicle_hold", (q) => q.eq("vehicleId", vehicleId))) {
    if (deposit.orgId !== orgId || deposit.holdActive !== true) continue;
    if (!depositUsable(deposit)) continue;
    // Where a deposit carries hold rows, those rows are the whole truth about
    // which cars it holds — including the one named on the deposit itself.
    let hasAnyHoldRow = false;
    for await (const _ of ctx.db
      .query("depositVehicleHolds")
      .withIndex("by_deposit", (q) => q.eq("depositId", deposit._id))) {
      hasAnyHoldRow = true;
      break;
    }
    if (!hasAnyHoldRow) return true;
  }

  return false;
}

/**
 * Is there a live reservation on this car? **Raw truth.**
 *
 * An absent `expiresAt` is a legitimate "never expires"; an ACTIVE row past
 * its expiry is not live, merely unswept.
 */
export async function oracleReservationHold(
  ctx: Ctx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">,
  decisionNow: number
): Promise<boolean> {
  for await (const reservation of ctx.db
    .query("vehicleReservations")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicleId))) {
    if (reservation.status !== "ACTIVE") continue;
    if (reservation.expiresAt === undefined || reservation.expiresAt > decisionNow) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// The comparison.
// ─────────────────────────────────────────────────────────────────────────────

export type PredicateName = "DEPOSIT_HOLD" | "RESERVATION_HOLD";

export type DriftRow = {
  readonly predicate: PredicateName;
  readonly vehicleId: Id<"vehicles">;
  readonly oracle: boolean;
  readonly legacy: boolean;
  readonly canonical: boolean;
  /** canonical ≠ oracle. **Blocks activation.** */
  readonly canonicalDisagrees: boolean;
  /**
   * legacy ≠ oracle. Recorded and individually explained; does NOT block.
   *
   * ⚠️ EXPECTED ON THE DEPOSIT PREDICATE, NOT ON THE RESERVATION ONE. Only the
   * deposit reader carries the capped-read defect, so an unexplained
   * reservation mismatch indicts the canonical reader rather than the legacy
   * one — and that asymmetry is a usable prior, not trivia.
   */
  readonly legacyDisagrees: boolean;
};

export type CutoverReport = {
  readonly orgId: Id<"organizations">;
  readonly vehiclesCompared: number;
  readonly drift: DriftRow[];
  /** True only when NOTHING disagrees with the oracle on the canonical side. */
  readonly canonicalMatchesOracle: boolean;
  /** Vehicles the comparison could not reach. Never treated as agreement. */
  readonly skipped: Array<{ vehicleId: Id<"vehicles">; reason: string }>;
};

/**
 * Compare all three readers for one vehicle.
 *
 * The three readers are passed in rather than imported, so this file cannot
 * accidentally become the runtime dispatcher — the cutover tooling wires the
 * explicit `legacy*` / `canonicalShadow*` / `oracle*` entry points, never the
 * generic one that changes behaviour with the org's version.
 */
export async function comparePredicateForVehicle(
  ctx: Ctx,
  args: {
    predicate: PredicateName;
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    oracle: () => Promise<boolean>;
    legacy: () => Promise<boolean>;
    canonicalShadow: () => Promise<boolean>;
  }
): Promise<DriftRow> {
  const oracle = await args.oracle();
  const legacy = await args.legacy();
  const canonical = await args.canonicalShadow();
  return {
    predicate: args.predicate,
    vehicleId: args.vehicleId,
    oracle,
    legacy,
    canonical,
    canonicalDisagrees: canonical !== oracle,
    legacyDisagrees: legacy !== oracle,
  };
}

/**
 * May this organization be flipped to the canonical authority?
 *
 * ⚠️ ONLY THE CANONICAL SIDE BLOCKS. Legacy disagreement is reported for a
 * human to explain — usually as a repaired capped-read false negative — and is
 * never a reason to hold the cutover, because requiring it would be requiring
 * the new reader to reproduce the old bug.
 *
 * ⚠️ AND A SKIPPED VEHICLE IS NOT AN AGREEING ONE. A comparison that could not
 * reach a car proves nothing about it, so any skip blocks too.
 */
export function activationBlocked(report: CutoverReport): boolean {
  return !report.canonicalMatchesOracle || report.skipped.length > 0;
}

export function summarizeDrift(
  orgId: Id<"organizations">,
  rows: DriftRow[],
  skipped: CutoverReport["skipped"] = []
): CutoverReport {
  const vehicles = new Set(rows.map((row) => String(row.vehicleId)));
  return {
    orgId,
    vehiclesCompared: vehicles.size,
    drift: rows.filter((row) => row.canonicalDisagrees || row.legacyDisagrees),
    canonicalMatchesOracle: rows.every((row) => !row.canonicalDisagrees),
    skipped,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The runtime dispatcher.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Which reader a live authority decision must use for this organization.
 *
 * ⚠️ THE DISPATCHER IS FOR RUNTIME ONLY, AND THE CUTOVER TOOLING MUST NEVER
 * CALL IT. A comparison that asked the dispatcher would ask the same question
 * twice and get the same answer twice — the circularity this whole file
 * exists to break.
 */
export function readerForVersion(version: AuthorityVersion): "LEGACY" | "CANONICAL" {
  return version === "V1" ? "CANONICAL" : "LEGACY";
}
