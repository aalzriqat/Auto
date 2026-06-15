import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

// ─── Seed data ────────────────────────────────────────────────────────────────

const DEFAULT_LEAD_SOURCES = [
  "Walk-in",
  "Website",
  "Facebook",
  "Instagram",
  "Referral",
  "Phone",
  "Haraj",
  "Other",
];

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * Returns all lead sources for the org, ordered by .order ascending.
 */
export const list = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SETTINGS]);
    const sources = await ctx.db
      .query("orgLeadSources")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    return sources.sort((a, b) => a.order - b.order);
  },
});

// ─── Mutations ────────────────────────────────────────────────────────────────

/**
 * Seeds default lead sources if none exist. Idempotent. Owner-only.
 */
export const seed = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const existing = await ctx.db
      .query("orgLeadSources")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();

    if (existing) {
      // Already seeded — do nothing
      return;
    }

    for (let i = 0; i < DEFAULT_LEAD_SOURCES.length; i++) {
      await ctx.db.insert("orgLeadSources", {
        orgId: args.orgId,
        label: DEFAULT_LEAD_SOURCES[i],
        isActive: true,
        order: i,
      });
    }
  },
});

/**
 * Creates a new lead source. Owner-only.
 */
export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    label: v.string(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const allSources = await ctx.db
      .query("orgLeadSources")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const maxOrder = allSources.reduce((max, s) => Math.max(max, s.order), -1);

    return await ctx.db.insert("orgLeadSources", {
      orgId: args.orgId,
      label: args.label,
      isActive: true,
      order: maxOrder + 1,
    });
  },
});

/**
 * Updates a lead source's label, active state, or order. Owner-only.
 */
export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    sourceId: v.id("orgLeadSources"),
    label: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
    order: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const source = await ctx.db.get(args.sourceId);
    if (!source || source.orgId !== args.orgId) {
      throw new Error("Lead source not found.");
    }

    const patch: Record<string, unknown> = {};
    if (args.label !== undefined) patch.label = args.label;
    if (args.isActive !== undefined) patch.isActive = args.isActive;
    if (args.order !== undefined) patch.order = args.order;

    await ctx.db.patch(args.sourceId, patch);
  },
});

/**
 * Hard-deletes a lead source. Owner-only.
 */
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    sourceId: v.id("orgLeadSources"),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const source = await ctx.db.get(args.sourceId);
    if (!source || source.orgId !== args.orgId) {
      throw new Error("Lead source not found.");
    }

    await ctx.db.delete(args.sourceId);
  },
});

/**
 * Reorders lead sources by assigning each source its index in the orderedIds array. Owner-only.
 */
export const reorder = mutation({
  args: {
    orgId: v.id("organizations"),
    orderedIds: v.array(v.id("orgLeadSources")),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    for (let i = 0; i < args.orderedIds.length; i++) {
      const source = await ctx.db.get(args.orderedIds[i]);
      if (!source || source.orgId !== args.orgId) {
        throw new Error("Lead source not found or does not belong to this org.");
      }
      await ctx.db.patch(args.orderedIds[i], { order: i });
    }
  },
});
