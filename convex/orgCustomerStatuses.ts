import { v } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { requireTenantAuth, requireOwner, requireOwnedRow } from "./utils/tenancy";
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

    await requireOwnedRow(ctx, args.orgId, "orgCustomerStatuses", args.statusId, "Customer status not found.");

    const patch: Record<string, unknown> = {};
    if (args.label !== undefined) patch.label = args.label;
    if (args.isActive !== undefined) patch.isActive = args.isActive;
    if (args.order !== undefined) patch.order = args.order;

    await ctx.db.patch(args.statusId, patch);
  },
});

/**
 * Hard-deletes a customer status. Owner-only.
 *
 * Finance companies opt into the statuses they accept by storing an array of
 * these ids (`financeCompanies.acceptedStatuses`). Deleting the row without
 * clearing those references left every company that accepted this status
 * holding an id pointing at nothing, which had two consequences: the company
 * could no longer be saved at all (its edit dialog re-sent the dangling id,
 * which the finance mutation rejected), and it silently matched no customer in
 * the sales wizard's finance comparison, disappearing from the list of options.
 */
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    statusId: v.id("orgCustomerStatuses"),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);

    await requireOwnedRow(ctx, args.orgId, "orgCustomerStatuses", args.statusId, "Customer status not found.");

    // Drop the reference everywhere before the row goes, so no company is left
    // pointing at it. A company whose whole list was this one status becomes an
    // empty list, which the comparison reads as "accepts every customer" — the
    // same meaning it has for a company that never restricted its statuses.
    const companies = await ctx.db
      .query("financeCompanies")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    for (const company of companies) {
      if (!company.acceptedStatuses?.includes(args.statusId)) continue;
      await ctx.db.patch(company._id, {
        acceptedStatuses: company.acceptedStatuses.filter((id) => id !== args.statusId),
      });
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
      await requireOwnedRow(ctx, args.orgId, "orgCustomerStatuses", args.orderedIds[i], "Customer status not found or does not belong to this org.");
      await ctx.db.patch(args.orderedIds[i], { order: i });
    }
  },
});
