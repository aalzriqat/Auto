import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

// ─── Seed data ────────────────────────────────────────────────────────────────

const DEFAULT_CUSTOMER_STATUSES = [
  "Social Security",
  "Salary Slip",
  "ID Only",
  "Commercial Register",
  "Delivery Apps",
];

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * Returns all customer statuses for the org, ordered by .order ascending.
 */
export const list = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SETTINGS]);
    const statuses = await ctx.db
      .query("orgCustomerStatuses")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    return statuses.sort((a, b) => a.order - b.order);
  },
});

// ─── Mutations ────────────────────────────────────────────────────────────────

/**
 * Seeds default customer statuses if none exist. Idempotent. Owner-only.
 */
export const seed = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const existing = await ctx.db
      .query("orgCustomerStatuses")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();

    if (existing) {
      // Already seeded — do nothing
      return;
    }

    for (let i = 0; i < DEFAULT_CUSTOMER_STATUSES.length; i++) {
      await ctx.db.insert("orgCustomerStatuses", {
        orgId: args.orgId,
        label: DEFAULT_CUSTOMER_STATUSES[i],
        isActive: true,
        order: i,
      });
    }
  },
});

/**
 * Creates a new customer status. Owner-only.
 */
export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    label: v.string(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const allStatuses = await ctx.db
      .query("orgCustomerStatuses")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const maxOrder = allStatuses.reduce((max, s) => Math.max(max, s.order), -1);

    return await ctx.db.insert("orgCustomerStatuses", {
      orgId: args.orgId,
      label: args.label,
      isActive: true,
      order: maxOrder + 1,
    });
  },
});

/**
 * Updates a customer status's label, active state, or order. Owner-only.
 */
export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    statusId: v.id("orgCustomerStatuses"),
    label: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
    order: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const status = await ctx.db.get(args.statusId);
    if (!status || status.orgId !== args.orgId) {
      throw new ConvexError("Customer status not found.");
    }

    const patch: Record<string, unknown> = {};
    if (args.label !== undefined) patch.label = args.label;
    if (args.isActive !== undefined) patch.isActive = args.isActive;
    if (args.order !== undefined) patch.order = args.order;

    await ctx.db.patch(args.statusId, patch);
  },
});

/**
 * Hard-deletes a customer status. Owner-only.
 */
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    statusId: v.id("orgCustomerStatuses"),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const status = await ctx.db.get(args.statusId);
    if (!status || status.orgId !== args.orgId) {
      throw new ConvexError("Customer status not found.");
    }

    await ctx.db.delete(args.statusId);
  },
});

/**
 * Reorders customer statuses by assigning each status its index in the orderedIds array. Owner-only.
 */
export const reorder = mutation({
  args: {
    orgId: v.id("organizations"),
    orderedIds: v.array(v.id("orgCustomerStatuses")),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    for (let i = 0; i < args.orderedIds.length; i++) {
      const status = await ctx.db.get(args.orderedIds[i]);
      if (!status || status.orgId !== args.orgId) {
        throw new ConvexError("Customer status not found or does not belong to this org.");
      }
      await ctx.db.patch(args.orderedIds[i], { order: i });
    }
  },
});
