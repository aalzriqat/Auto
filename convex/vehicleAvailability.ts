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
 * RESERVED projection and no live or unreadable finance claim exists for it;
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

export const PICKER_AVAILABILITY_MAX_IDS = 200;

/**
 * Per-car read bounds. Small on purpose: the query answers up to 200 cars in
 * one transaction, and a car with more finance history than this is rare
 * enough that "check availability" is the honest answer for it.
 */
const FINANCE_CLAIM_READ_LIMIT = 16;
const FINANCE_APPLICATION_READ_LIMIT = 16;

export type PickerAvailability = "FREE" | "HELD" | "UNCERTAIN";

const availabilityValidator = v.union(v.literal("FREE"), v.literal("HELD"), v.literal("UNCERTAIN"));

/** Completion refuses these outright, so they are never FREE. */
function isTerminalForSale(vehicle: Doc<"vehicles">): boolean {
  return vehicle.status === "SOLD" || vehicle.status === "ARCHIVED" || isVehicleDeleted(vehicle);
}

/**
 * True when a finance claim or application on the car is live, unreadable or
 * beyond the bound — the same evidence `assertFinanceHeldVehicleCompletesThroughDeal`
 * (utils/saleCompletion.ts) refuses on, plus in-flight applications that carry
 * no claim (pre-claim legacy finance, design attack DA-3).
 */
async function hasLiveOrUnreadableFinance(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  const claims = await ctx.db
    .query("vehicleCommitmentClaims")
    .withIndex("by_org_vehicle_kind_status", (q) =>
      q.eq("orgId", orgId).eq("vehicleId", vehicleId).eq("evidenceKind", "FINANCE").eq("status", "ACTIVE")
    )
    .take(FINANCE_CLAIM_READ_LIMIT + 1);
  if (claims.length > FINANCE_CLAIM_READ_LIMIT) return true;
  if (claims.some((claim) => !claim.applicationId)) return true;
  const claimed = await Promise.all(
    [...new Set(claims.map((claim) => claim.applicationId!))].map((id) => ctx.db.get(id))
  );
  for (const application of claimed) {
    if (!application || application.orgId !== orgId) return true;
    if (IN_FLIGHT_FINANCE_STATUSES.includes(application.status)) return true;
  }

  const applications = await ctx.db
    .query("financeApplications")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicleId))
    .take(FINANCE_APPLICATION_READ_LIMIT + 1);
  if (applications.length > FINANCE_APPLICATION_READ_LIMIT) return true;
  return applications.some((application) => IN_FLIGHT_FINANCE_STATUSES.includes(application.status));
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
  return "FREE";
}

/**
 * The picker's badge for each requested car. Ids are deduplicated; ids beyond
 * the first 200 distinct ones come back UNCERTAIN rather than being dropped, so
 * a caller can never mistake "not answered" for FREE (DA-5). The client sends
 * chunks of at most 200.
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
          // other car down with it, and must never read as FREE.
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
