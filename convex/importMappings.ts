import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

const entityTypeValidator = v.union(v.literal("vehicle"), v.literal("customer"));

const VIEW_PERMISSION = {
  vehicle: PERMISSIONS.VIEW_VEHICLES,
  customer: PERMISSIONS.VIEW_CUSTOMERS,
} as const;

const CREATE_PERMISSION = {
  vehicle: PERMISSIONS.CREATE_VEHICLES,
  customer: PERMISSIONS.CREATE_CUSTOMERS,
} as const;

/**
 * Returns the dealer's last-confirmed column mapping for this entity type,
 * or null if they've never imported this entity type before.
 */
export const get = query({
  args: {
    orgId: v.id("organizations"),
    entityType: entityTypeValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [VIEW_PERMISSION[args.entityType]]);

    const existing = await ctx.db
      .query("orgImportMappings")
      .withIndex("by_org_entity", (q) => q.eq("orgId", args.orgId).eq("entityType", args.entityType))
      .unique();

    return existing?.mapping ?? null;
  },
});

/**
 * Saves (or updates) the dealer's column mapping for this entity type, so the
 * next import of the same spreadsheet shape is pre-filled automatically.
 */
export const save = mutation({
  args: {
    orgId: v.id("organizations"),
    entityType: entityTypeValidator,
    mapping: v.array(v.object({
      sourceHeader: v.string(),
      targetField: v.string(),
    })),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [CREATE_PERMISSION[args.entityType]]);

    const existing = await ctx.db
      .query("orgImportMappings")
      .withIndex("by_org_entity", (q) => q.eq("orgId", args.orgId).eq("entityType", args.entityType))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, { mapping: args.mapping, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("orgImportMappings", {
        orgId: args.orgId,
        entityType: args.entityType,
        mapping: args.mapping,
        updatedAt: Date.now(),
      });
    }
  },
});
