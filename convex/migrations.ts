import { v } from "convex/values";
import { internalMutation } from "./functions";
import { vehiclesByOrg } from "./aggregates";
import { internal } from "./_generated/api";
import { ALL_PERMISSIONS, isSystemOwnerRole, normalizeRoleName, SYSTEM_OWNER_ROLE_NAME } from "./utils/permissions";

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
export const backfillVehicleAggregate = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
    /** Set false to run exactly one batch — used by tests to drive it by hand. */
    continueAutomatically: v.optional(v.boolean()),
  },
  // Explicit: a self-scheduling function that infers its own return type makes
  // the inference cyclic, and the resulting errors surface in unrelated files.
  handler: async (
    ctx,
    args
  ): Promise<{ migrated: number; isDone: boolean; continueCursor: string | null }> => {
    const numItems = Math.min(Math.max(args.batchSize ?? 200, 1), 500);

    const page = await ctx.db.query("vehicles").paginate({
      cursor: args.cursor ?? null,
      numItems,
    });

    for (const vehicle of page.page) {
      // Soft-deleted rows are deliberately included: they live in the tree
      // under the deletedFlag=1 prefix so a later restore is a key move rather
      // than an insert the trigger would have to reason about.
      await vehiclesByOrg.insertIfDoesNotExist(ctx, vehicle);
    }

    if (!page.isDone && args.continueAutomatically !== false) {
      await ctx.scheduler.runAfter(0, internal.migrations.backfillVehicleAggregate, {
        cursor: page.continueCursor,
        batchSize: args.batchSize,
      });
    }

    return {
      migrated: page.page.length,
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
    };
  },
});
