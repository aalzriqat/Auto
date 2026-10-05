import { v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { resolveOwnership } from "./commitments";
import { IN_FLIGHT_FINANCE_STATUSES } from "./utils/financeStatuses";
import { isVehicleDeleted } from "./utils/vehicleLiveness";

/**
 * SCRUM-636 — the picker's advisory hold badge (ruling c22077, Sol 6).
 *
 * INVARIANT: a car's badge is FREE only when no OPEN commitment root, no
 * RESERVED projection, no live or unreadable finance claim and no deposit or
 * reservation hold row exists for it;
 * HELD when exactly one OPEN root holds it; UNCERTAIN for every other or
 * unknown state. It never says WHICH deal, customer or quote holds the car,
 * and it never blocks selection — quoting stays allowed (F.39) and the real
 * barriers stay at deposit, application, reservation and completion.
 *
 * ⚠️ FAIL TOWARD UNCERTAIN, NEVER TOWARD FREE. A wrong FREE tells a salesperson
 * a car is open when a deal holds it; a wrong UNCERTAIN only asks them to
 * check. Every bound, read failure, foreign id and legacy disagreement lands on
 * UNCERTAIN for that reason.
 *
 * ⚠️ NO EXISTENCE ORACLE. A foreign-org id and a missing id return the same
 * UNCERTAIN, so the query cannot be used to learn that another tenant's car
 * exists. Lineage is never accepted from the caller, so nor can it be used to
 * learn which deal a car belongs to (design attack DA-1).
 */

/**
 * ⚠️ READ BUDGET BY CONSTRUCTION. One query is one transaction, and Convex
 * caps a transaction's index reads (4,096 db calls), documents and bytes. A
 * per-car try/catch cannot reserve that budget for the other cars, so the
 * bound is structural instead (SCRUM-636-R1):
 *
 *   per car  = 1 vehicle get + 1 OPEN-root scan + 1 claim range + 1 application range
 *              + 3 hold probes (deposit, slice, reservation; one row each, SCRUM-688)
 *            = PICKER_DB_CALLS_PER_CAR index reads, at most
 *              1 + 2 + (FINANCE_READ_LIMIT + 1) × 2 + 3 documents
 *   per call = PICKER_AVAILABILITY_MAX_IDS cars
 *
 * Claimed applications are never fetched one by one: a claim is matched
 * against the car's own application range, which also proves the claim
 * belongs to this car (SCRUM-636-R2). The client sends chunks of at most
 * PICKER_AVAILABILITY_MAX_IDS (ruling c22077: ≤ 200).
 */
export const PICKER_AVAILABILITY_MAX_IDS = 50;
export const PICKER_DB_CALLS_PER_CAR = 7;

/**
 * Per-car finance read bound. A car with more finance history than this is
 * rare enough that "check availability" is the honest answer for it.
 */
export const FINANCE_READ_LIMIT = 8;

export type PickerAvailability = "FREE" | "HELD" | "UNCERTAIN";

const availabilityValidator = v.union(v.literal("FREE"), v.literal("HELD"), v.literal("UNCERTAIN"));

/** Completion refuses these outright, so they are never FREE. */
function isTerminalForSale(vehicle: Doc<"vehicles">): boolean {
  return vehicle.status === "SOLD" || vehicle.status === "ARCHIVED" || isVehicleDeleted(vehicle);
}

/**
 * True when a finance claim or application on the car is live, unprovable or
 * beyond the bound — the evidence `assertFinanceHeldVehicleCompletesThroughDeal`
 * (utils/saleCompletion.ts) refuses on, plus in-flight applications that carry
 * no claim (pre-claim legacy finance, design attack DA-3).
 *
 * A claim is shown dead only by a terminal application found in THIS car's own
 * application range. A claim whose application is missing, in another org, or
 * filed against another car cannot be proven dead here (SCRUM-636-R2), and a
 * legacy multi-car application's second car lands here too — UNCERTAIN, never
 * FREE.
 */
async function hasLiveOrUnreadableFinance(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  const [claims, applications] = await Promise.all([
    ctx.db
      .query("vehicleCommitmentClaims")
      .withIndex("by_org_vehicle_kind_status", (q) =>
        q.eq("orgId", orgId).eq("vehicleId", vehicleId).eq("evidenceKind", "FINANCE").eq("status", "ACTIVE")
      )
      .take(FINANCE_READ_LIMIT + 1),
    ctx.db
      .query("financeApplications")
      .withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicleId))
      .take(FINANCE_READ_LIMIT + 1),
  ]);
  if (claims.length > FINANCE_READ_LIMIT || applications.length > FINANCE_READ_LIMIT) return true;
  if (applications.some((application) => IN_FLIGHT_FINANCE_STATUSES.includes(application.status))) return true;

  // Every application left in range is terminal, so a claim is dead exactly
  // when it names one of them.
  const ownTerminal = new Set<Id<"financeApplications">>(applications.map((application) => application._id));
  return claims.some((claim) => !claim.applicationId || !ownTerminal.has(claim.applicationId));
}

/**
 * True when ANY deposit or reservation hold row names the car — a deposit
 * with `holdActive`, an active multi-car slice, or an ACTIVE reservation —
 * without deciding whether it is still live (SCRUM-688, Sol ruling c22095).
 *
 * A hold can outlive its root: a hold on an IN_INSPECTION / IN_REPAIR car
 * leaves the status alone, and legacy restoration can return a car without
 * one. Such a car is not HELD (no OPEN root), but it is not provably FREE
 * either. The rows are read raw and one each: a stale-but-unswept row reads
 * UNCERTAIN, which only asks the salesperson to check, whereas resolving
 * liveness here (expiry, slice ownership) would need unbounded reads.
 *
 * The deposit and slice probes are deliberately NOT org-scoped. Every writer
 * checks the car belongs to the depositing org, so a foreign-org row naming
 * this car is corruption — and corruption reads UNCERTAIN here, like every
 * other disagreement. Scoping would ignore it instead. Nothing leaks: the
 * caller already owns the car and learns only "check availability".
 */
async function hasAnyHoldRow(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  const [deposit, slice, reservation] = await Promise.all([
    ctx.db
      .query("deposits")
      .withIndex("by_vehicle_hold", (q) => q.eq("vehicleId", vehicleId).eq("holdActive", true))
      .first(),
    ctx.db
      .query("depositVehicleHolds")
      .withIndex("by_vehicle_active", (q) => q.eq("vehicleId", vehicleId).eq("active", true))
      .first(),
    ctx.db
      .query("vehicleReservations")
      .withIndex("by_org_vehicle_status", (q) =>
        q.eq("orgId", orgId).eq("vehicleId", vehicleId).eq("status", "ACTIVE")
      )
      .first(),
  ]);
  return deposit !== null || slice !== null || reservation !== null;
}

/** The verdict for one car the caller's org has asked about. */
export async function pickerAvailabilityFor(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<PickerAvailability> {
  const vehicle = await ctx.db.get(vehicleId);
  if (vehicle?.orgId !== orgId) return "UNCERTAIN";
  if (isTerminalForSale(vehicle)) return "UNCERTAIN";

  const ownership = await resolveOwnership(ctx, orgId, vehicleId);
  if (ownership.kind === "OWNED") return "HELD";
  if (ownership.kind === "AMBIGUOUS") return "UNCERTAIN";

  // No OPEN root. A RESERVED projection without one is legacy or drift: the
  // badge cannot say whether the car is held, so it does not guess (DA-3).
  if (vehicle.status === "RESERVED") return "UNCERTAIN";
  if (await hasLiveOrUnreadableFinance(ctx, orgId, vehicleId)) return "UNCERTAIN";
  if (await hasAnyHoldRow(ctx, orgId, vehicleId)) return "UNCERTAIN";
  return "FREE";
}

/**
 * The picker's badge for each requested car. Ids are deduplicated; ids beyond
 * the first PICKER_AVAILABILITY_MAX_IDS distinct ones come back UNCERTAIN
 * rather than being dropped, so a caller can never mistake "not answered" for
 * FREE (DA-5). The client sends chunks of at most PICKER_AVAILABILITY_MAX_IDS.
 */
export const pickerAvailability = query({
  args: {
    orgId: v.id("organizations"),
    vehicleIds: v.array(v.id("vehicles")),
  },
  returns: v.array(v.object({ vehicleId: v.id("vehicles"), availability: availabilityValidator })),
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_VEHICLES]);

    const unique = [...new Set(args.vehicleIds)];
    const answered = unique.slice(0, PICKER_AVAILABILITY_MAX_IDS);
    const uncovered = unique.slice(PICKER_AVAILABILITY_MAX_IDS);

    const verdicts = await Promise.all(
      answered.map(async (vehicleId) => {
        try {
          return { vehicleId, availability: await pickerAvailabilityFor(ctx, args.orgId, vehicleId) };
        } catch (error) {
          // A read that fails for one car must not take the badge for every
          // other car down with it, and must never read as FREE. This is not
          // the budget mechanism — the bounds above are (SCRUM-636-R1).
          console.error("pickerAvailability: verdict failed", vehicleId, error);
          return { vehicleId, availability: "UNCERTAIN" as const };
        }
      })
    );
    return [
      ...verdicts,
      ...uncovered.map((vehicleId) => ({ vehicleId, availability: "UNCERTAIN" as const })),
    ];
  },
});
