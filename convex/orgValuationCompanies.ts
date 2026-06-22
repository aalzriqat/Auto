import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";

// ─── Seed data ────────────────────────────────────────────────────────────────

const DEFAULT_VALUATION_COMPANIES = ["بندار", "تمكين", "السماحة"];

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * Returns all valuation companies for the org, ordered by .order ascending.
 */
export const list = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SETTINGS]);
    const companies = await ctx.db
      .query("orgValuationCompanies")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    return companies.sort((a, b) => a.order - b.order);
  },
});

// ─── Mutations ────────────────────────────────────────────────────────────────

/**
 * Seeds default valuation companies if none exist. Idempotent. Owner-only.
 */
export const seed = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const existing = await ctx.db
      .query("orgValuationCompanies")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .first();

    if (existing) {
      // Already seeded — do nothing
      return;
    }

    for (let i = 0; i < DEFAULT_VALUATION_COMPANIES.length; i++) {
      await ctx.db.insert("orgValuationCompanies", {
        orgId: args.orgId,
        name: DEFAULT_VALUATION_COMPANIES[i],
        isActive: true,
        order: i,
      });
    }
  },
});

/**
 * Creates a new valuation company. Owner-only.
 */
export const create = mutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const all = await ctx.db
      .query("orgValuationCompanies")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    const maxOrder = all.reduce((max, c) => Math.max(max, c.order), -1);

    return await ctx.db.insert("orgValuationCompanies", {
      orgId: args.orgId,
      name: args.name,
      isActive: true,
      order: maxOrder + 1,
    });
  },
});

/**
 * Updates a valuation company's name, active state, or order. Owner-only.
 */
export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    companyId: v.id("orgValuationCompanies"),
    name: v.optional(v.string()),
    isActive: v.optional(v.boolean()),
    order: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const company = await ctx.db.get(args.companyId);
    if (!company || company.orgId !== args.orgId) {
      throw new ConvexError("Valuation company not found.");
    }

    const patch: Record<string, unknown> = {};
    if (args.name !== undefined) patch.name = args.name;
    if (args.isActive !== undefined) patch.isActive = args.isActive;
    if (args.order !== undefined) patch.order = args.order;

    await ctx.db.patch(args.companyId, patch);
  },
});

/**
 * Hard-deletes a valuation company. Owner-only.
 */
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    companyId: v.id("orgValuationCompanies"),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    const company = await ctx.db.get(args.companyId);
    if (!company || company.orgId !== args.orgId) {
      throw new ConvexError("Valuation company not found.");
    }

    await ctx.db.delete(args.companyId);
  },
});
