import { v } from "convex/values";
import { internalMutation } from "./functions";
import { vehiclesByOrg } from "./aggregates";
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
 * The trigger in `convex/functions.ts` only sees writes that happen after it is
 * deployed, so without this every vehicle already in the table is invisible to
 * the B-tree and `getAgingBuckets` reports zeroes. Run this once per deployment
 * after the component ships; a fresh deployment (preview/E2E) starts empty and
 * needs nothing.
 *
 * Paginated because a full-table mutation would blow the write budget on any
 * real org, and idempotent via `insertIfDoesNotExist` so a redrive or a partial
 * run that overlaps a live insert cannot double-count.
 */
export const backfillVehicleAggregate = internalMutation({
  args: {
    cursor: v.optional(v.union(v.string(), v.null())),
    batchSize: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
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

    return {
      migrated: page.page.length,
      isDone: page.isDone,
      // Hand back the cursor so the caller can drive the next batch. Returning
      // it rather than self-scheduling keeps this a plain mutation: a throw
      // rolls the batch back cleanly with nothing half-scheduled behind it.
      continueCursor: page.isDone ? null : page.continueCursor,
    };
  },
});
