import { v } from "convex/values";
import { internalMutation } from "./functions";
import {
  customersByOrg,
  leadsByOrg,
  membershipsByOrg,
  vehicleQualityByOrg,
  vehiclesByOrg,
} from "./aggregates";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { ALL_PERMISSIONS, isSystemOwnerRole, normalizeRoleName, SYSTEM_OWNER_ROLE_NAME } from "./utils/permissions";
import {
  hasActiveDepositHold,
  hasActiveReservationHold,
  syncVehicleHoldStatus,
} from "./utils/depositHelpers";

export const backfillPermissions = internalMutation({
  args: {},
  handler: async (ctx) => {
    // Get all roles
    const roles = await ctx.db.query("roles").collect();

    for (const role of roles) {
      if (isSystemOwnerRole(role) || normalizeRoleName(role.name) === SYSTEM_OWNER_ROLE_NAME) {
        // Owner gets all permissions
        await ctx.db.patch(role._id, {
          permissions: ALL_PERMISSIONS,
          isSystemOwnerRole: true,
        });
      } else if (role.name === "MANAGER") {
        // Add new settings/approval permissions to MANAGER if not present.
        // manage:settings is intentionally NOT granted — settings administration
        // is restricted to OWNER only; approvals use the dedicated approve:requests permission.
        const permissions = new Set(role.permissions);
        permissions.add("view:settings");
        permissions.add("approve:requests");
        permissions.delete("manage:settings");

        await ctx.db.patch(role._id, {
          permissions: Array.from(permissions),
        });
      } else {
        // Other roles might need view:settings if we want them to see finance companies
        // but we'll fix listCompanies to use a less restrictive permission instead.
      }
    }

    return "Permissions backfilled successfully";
  },
});

/**
 * Seeds the `vehiclesByOrg` aggregate from the existing `vehicles` rows.
 *
 * The trigger in `convex/aggregates.ts` only sees writes that happen after it
 * is deployed, so without this every vehicle already in the table is invisible
 * to the B-tree. Worse than showing zero: the idempotent trigger inserts rows
 * as they happen to be edited, so an un-backfilled deployment shows a
 * believable *partial* count rather than an obviously broken one. Run once per
 * deployment after the component ships; a fresh deployment (preview/E2E) starts
 * empty and converges on its own.
 *
 * Paginated because a full-table mutation would blow the write budget on any
 * real org, and idempotent via `insertIfDoesNotExist` so a redrive or a partial
 * run that overlaps a live insert cannot double-count. Pagination is by
 * `_creationTime`, which no pre-existing row can change, so no row is skipped
 * by concurrent writes.
 *
 * Self-scheduling: the alternative was returning the cursor for a human to feed
 * back in, which in practice means one hand-driven dashboard call per 200
 * vehicles and a half-migrated tree whenever someone stops early. A throw rolls
 * back the scheduled continuation along with the batch's writes, so a failure
 * halts the chain cleanly rather than leaving an orphan.
 */
/** Argument shape shared by every aggregate backfill below. */
const BACKFILL_ARGS = {
  cursor: v.optional(v.union(v.string(), v.null())),
  batchSize: v.optional(v.number()),
  /** Set false to run exactly one batch — used by tests to drive it by hand. */
  continueAutomatically: v.optional(v.boolean()),
} as const;

type BackfillArgs = {
  cursor?: string | null;
  batchSize?: number;
  continueAutomatically?: boolean;
};

type BackfillResult = { migrated: number; isDone: boolean; continueCursor: string | null };

/** Tables that have an aggregate to seed. */
type BackfilledTable = "vehicles" | "customers" | "leads" | "memberships";

/**
 * One page of a backfill: read a bounded slice of `table` and hand each row to
 * `seed`.
 *
 * Deliberately does *not* schedule the continuation. Each caller owns that,
 * because the scheduler needs the concrete `internal.migrations.<name>`
 * reference for its own function, and threading a `FunctionReference` through
 * here costs more in type noise than the four lines it would save.
 */
async function seedAggregatePage<T extends BackfilledTable>(
  ctx: MutationCtx,
  table: T,
  args: BackfillArgs,
  seed: (doc: Doc<T>) => Promise<void>,
): Promise<BackfillResult> {
  // Each row costs several aggregate index reads and node patches on top of
  // its own read, so the ceiling is well below what a plain paginate could
  // take. 250 keeps a batch inside the per-transaction budget; exceeding it
  // would throw and kill the self-scheduled chain.
  const numItems = Math.min(Math.max(args.batchSize ?? 100, 1), 250);

  const page = await ctx.db.query(table).paginate({
    cursor: args.cursor ?? null,
    numItems,
  });

  for (const doc of page.page) {
    // Soft-deleted rows are deliberately included: they live in the tree under
    // the deletedFlag=1 prefix so a later restore is a key move rather than an
    // insert the trigger would have to reason about.
    await seed(doc as Doc<T>);
  }

  return {
    migrated: page.page.length,
    isDone: page.isDone,
    continueCursor: page.isDone ? null : page.continueCursor,
  };
}

/**
 * Seeds the two `vehicles` aggregates from the existing rows.
 *
 * The triggers in `convex/aggregates.ts` only see writes that happen after they
 * are deployed, so without this every vehicle already in the table is invisible
 * to the B-trees. Worse than showing zero: the idempotent trigger inserts rows
 * as they happen to be edited, so an un-backfilled deployment shows a
 * believable *partial* count rather than an obviously broken one. Run once per
 * deployment after the components ship; a fresh deployment (preview/E2E) starts
 * empty and converges on its own.
 *
 * Paginated because a full-table mutation would blow the write budget on any
 * real org, and idempotent via `insertIfDoesNotExist` so a redrive or a partial
 * run that overlaps a live insert cannot double-count. Pagination is by
 * `_creationTime`, which no pre-existing row can change, so no row is skipped
 * by concurrent writes.
 *
 * Self-scheduling: the alternative was returning the cursor for a human to feed
 * back in, which in practice means one hand-driven dashboard call per 200
 * vehicles and a half-migrated tree whenever someone stops early. A throw rolls
 * back the scheduled continuation along with the batch's writes, so a failure
 * halts the chain cleanly rather than leaving an orphan.
 *
 * NOTE: on a deployment that already ran this against the *old* three-element
 * vehicle key, `insertIfDoesNotExist` is a no-op for every row — the position
 * is already occupied, under a key that is now wrong. Such a deployment needs
 * `rebuildVehicleAggregates`, not this.
 */
export const backfillVehicleAggregate = internalMutation({
  args: BACKFILL_ARGS,
  // Explicit: a self-scheduling function that infers its own return type makes
  // the inference cyclic, and the resulting errors surface in unrelated files.
  handler: async (ctx, args): Promise<BackfillResult> => {
    const result = await seedAggregatePage(ctx, "vehicles", args, async (vehicle) => {
      await vehiclesByOrg.insertIfDoesNotExist(ctx, vehicle);
      await vehicleQualityByOrg.insertIfDoesNotExist(ctx, vehicle);
    });

    if (!result.isDone && args.continueAutomatically !== false) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillVehicleAggregate, {
        cursor: result.continueCursor,
        batchSize: args.batchSize,
      });
    }

    return result;
  },
});

/**
 * Drops and re-seeds both vehicle trees.
 *
 * Required exactly once on any deployment that ran `backfillVehicleAggregate`
 * before `sourcedFlag` was added to `vehiclesByOrg`'s sort key. Those rows are
 * stored under a three-element key; the running code reads four-element bounds,
 * so every count would be answered from positions that no longer mean what the
 * reader thinks. `insertIfDoesNotExist` cannot repair that — the row is already
 * in the tree — which is why this clears first.
 *
 * Safe to run on a deployment that never had the old key; it just costs one
 * rebuild. Counts read zero between the clear and the backfill catching up,
 * which for a dashboard tile is the right way round: obviously empty beats
 * confidently wrong.
 */
export const rebuildVehicleAggregates = internalMutation({
  args: { batchSize: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ cleared: true }> => {
    await vehiclesByOrg.clearAll(ctx);
    await vehicleQualityByOrg.clearAll(ctx);

    await ctx.scheduler.runAfter(0, internal.migrations.backfillVehicleAggregate, {
      batchSize: args.batchSize,
    });

    return { cleared: true };
  },
});

/**
 * Drops and re-seeds `customersByOrg`.
 *
 * Required once on any deployment seeded before `socialFlag` entered the key.
 * Same reasoning as `rebuildVehicleAggregates`: the stored positions encode a
 * three-element key while the reader supplies four-element bounds, and
 * `insertIfDoesNotExist` will not touch a row the tree already holds.
 */
export const rebuildCustomerAggregate = internalMutation({
  args: { batchSize: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{ cleared: true }> => {
    await customersByOrg.clearAll(ctx);

    await ctx.scheduler.runAfter(0, internal.migrations.backfillCustomerAggregate, {
      batchSize: args.batchSize,
    });

    return { cleared: true };
  },
});

/** Seeds `customersByOrg`. See `backfillVehicleAggregate` for the mechanics. */
export const backfillCustomerAggregate = internalMutation({
  args: BACKFILL_ARGS,
  handler: async (ctx, args): Promise<BackfillResult> => {
    const result = await seedAggregatePage(ctx, "customers", args, async (customer) => {
      await customersByOrg.insertIfDoesNotExist(ctx, customer);
    });

    if (!result.isDone && args.continueAutomatically !== false) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillCustomerAggregate, {
        cursor: result.continueCursor,
        batchSize: args.batchSize,
      });
    }

    return result;
  },
});

/** Seeds `leadsByOrg`. See `backfillVehicleAggregate` for the mechanics. */
export const backfillLeadAggregate = internalMutation({
  args: BACKFILL_ARGS,
  handler: async (ctx, args): Promise<BackfillResult> => {
    const result = await seedAggregatePage(ctx, "leads", args, async (lead) => {
      await leadsByOrg.insertIfDoesNotExist(ctx, lead);
    });

    if (!result.isDone && args.continueAutomatically !== false) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillLeadAggregate, {
        cursor: result.continueCursor,
        batchSize: args.batchSize,
      });
    }

    return result;
  },
});

/** Seeds `membershipsByOrg`. See `backfillVehicleAggregate` for the mechanics. */
export const backfillMembershipAggregate = internalMutation({
  args: BACKFILL_ARGS,
  handler: async (ctx, args): Promise<BackfillResult> => {
    const result = await seedAggregatePage(ctx, "memberships", args, async (membership) => {
      await membershipsByOrg.insertIfDoesNotExist(ctx, membership);
    });

    if (!result.isDone && args.continueAutomatically !== false) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillMembershipAggregate, {
        cursor: result.continueCursor,
        batchSize: args.batchSize,
      });
    }

    return result;
  },
});

/**
 * Re-derives every vehicle's hold status for one org from the holds that
 * actually exist.
 *
 * A vehicle sits at RESERVED because something holds it — an active deposit or
 * an active `vehicleReservations` row. Delete those without touching the
 * vehicle and the status becomes a claim nothing backs: the car reads as
 * unavailable, cannot be sold again, and no release path exists, because
 * `releaseReservation` needs the reservation row that is already gone. That is
 * exactly the state the Bloom Cars financial reset left behind, by design — the
 * decision then was to leave inventory untouched.
 *
 * This calls the application's own `syncVehicleHoldStatus` rather than writing
 * "AVAILABLE" over anything that looks stuck. That helper is what every deposit
 * and reservation path already uses, so a vehicle ends up in the state the app
 * would have put it in, and the two cannot drift. It also means the reconcile
 * is safe in both directions: a vehicle wrongly left AVAILABLE while a hold is
 * live gets moved back to RESERVED.
 *
 * SOLD and ARCHIVED vehicles are skipped by that helper and stay as they are —
 * a sold car is not "unheld", and re-listing one because its sale row was
 * deleted would be worse than the inconsistency it fixes.
 *
 * `dryRun` defaults to **true**: the safe call is the one you get by forgetting
 * the flag.
 */
export const reconcileVehicleHolds = internalMutation({
  args: {
    orgId: v.id("organizations"),
    dryRun: v.optional(v.boolean()),
    batchSize: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    dryRun: boolean;
    scanned: number;
    released: Array<{ vehicleId: string; from: string; to: string }>;
  }> => {
    const dryRun = args.dryRun ?? true;
    const limit = Math.min(Math.max(args.batchSize ?? 500, 1), 1000);

    const vehicles = await ctx.db
      .query("vehicles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(limit);

    const released: Array<{ vehicleId: string; from: string; to: string }> = [];

    for (const vehicle of vehicles) {
      if (vehicle.isDeleted) continue;

      const hasHold =
        (await hasActiveDepositHold(ctx, vehicle._id)) ||
        (await hasActiveReservationHold(ctx, { orgId: args.orgId, vehicleId: vehicle._id }));

      const target = hasHold ? "RESERVED" : "AVAILABLE";
      if (vehicle.status === target) continue;
      // Only the two states syncVehicleHoldStatus itself moves between. This
      // is what keeps SOLD and ARCHIVED out — a sold car is not "unheld", and
      // re-listing one because its sale row was deleted would be worse than
      // the inconsistency being fixed — and equally keeps SOURCING and
      // IN_INSPECTION out, which are mid-workflow rather than mis-held.
      if (vehicle.status !== "RESERVED" && vehicle.status !== "AVAILABLE") continue;

      released.push({ vehicleId: vehicle._id.toString(), from: vehicle.status, to: target });
      if (!dryRun) {
        await syncVehicleHoldStatus(ctx, vehicle._id);
      }
    }

    return { dryRun, scanned: vehicles.length, released };
  },
});

/**
 * Strips finance-company accepted-status references that point at customer
 * status rows which no longer exist.
 *
 * `orgCustomerStatuses.remove` used to hard-delete a status without clearing it
 * from `financeCompanies.acceptedStatuses`. Every company that accepted that
 * status was left holding an id naming no row, with two consequences: the
 * company could not be saved at all, because its edit dialog re-sent the
 * dangling id and the finance mutation rejected it; and the sales wizard's
 * finance comparison matched the company against no customer status at all, so
 * it quietly stopped being offered.
 *
 * The delete now cascades and a save repairs the row it touches, so this exists
 * for companies nobody has re-saved since — the silent half of the bug, which
 * shows no error to anyone.
 *
 * A company whose entire list was dangling ends up with an empty array, which
 * the comparison reads as "accepts every customer" — the same meaning it
 * carries for a company that never restricted its statuses.
 *
 * `dryRun` defaults to **true**: the safe call is the one you get by forgetting
 * the flag.
 */
export const cleanupDanglingAcceptedStatuses = internalMutation({
  args: {
    orgId: v.id("organizations"),
    dryRun: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    dryRun: boolean;
    scanned: number;
    repaired: Array<{ companyId: string; name: string; removed: number; remaining: number }>;
  }> => {
    const dryRun = args.dryRun ?? true;

    const companies = await ctx.db
      .query("financeCompanies")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const repaired: Array<{ companyId: string; name: string; removed: number; remaining: number }> = [];

    for (const company of companies) {
      const accepted = company.acceptedStatuses;
      if (!accepted || accepted.length === 0) continue;

      const live: typeof accepted = [];
      for (const statusId of accepted) {
        const status = await ctx.db.get(statusId);
        // Another org's status is left alone deliberately: that is a data
        // problem to look at, not one to silently erase.
        if (status) live.push(statusId);
      }

      if (live.length === accepted.length) continue;

      repaired.push({
        companyId: company._id.toString(),
        name: company.name,
        removed: accepted.length - live.length,
        remaining: live.length,
      });

      if (!dryRun) {
        await ctx.db.patch(company._id, { acceptedStatuses: live });
      }
    }

    return { dryRun, scanned: companies.length, repaired };
  },
});
