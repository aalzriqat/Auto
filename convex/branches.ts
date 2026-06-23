import { v, ConvexError } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireTenantAuth, requireOwner } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";

export const list = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SETTINGS]);
    
    const branches = await ctx.db
      .query("branches")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    // Enrich with manager info
    return await Promise.all(
      branches.map(async (branch) => {
        const manager = branch.managerId ? await ctx.db.get(branch.managerId) : null;
        return {
          ...branch,
          managerName: manager ? manager.name || manager.email : "Unassigned",
        };
      })
    );
  },
});

export const add = mutation({
  args: {
    orgId: v.id("organizations"),
    name: v.string(),
    address: v.optional(v.string()),
    phone: v.optional(v.string()),
    managerId: v.optional(v.id("users")),
    isActive: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    
    await ctx.db.insert("branches", {
      orgId: args.orgId,
      name: args.name.trim(),
      address: args.address?.trim(),
      phone: args.phone?.trim(),
      managerId: args.managerId,
      isActive: args.isActive,
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(ctx, args.orgId, "branch.changed", { actorName, branchName: args.name.trim() });
  },
});

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    id: v.id("branches"),
    name: v.string(),
    address: v.optional(v.string()),
    phone: v.optional(v.string()),
    managerId: v.optional(v.id("users")),
    isActive: v.boolean(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    
    const branch = await ctx.db.get(args.id);
    if (!branch || branch.orgId !== args.orgId) throw new ConvexError("Branch not found.");

    await ctx.db.patch(args.id, {
      name: args.name.trim(),
      address: args.address?.trim(),
      phone: args.phone?.trim(),
      managerId: args.managerId,
      isActive: args.isActive,
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(ctx, args.orgId, "branch.changed", { actorName, branchName: args.name.trim() });
  },
});

// A system task to create a default branch and migrate existing records
export const migrateToDefaultBranch = mutation({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx, args.orgId);
    
    // Check if any branch exists
    const existing = await ctx.db.query("branches").withIndex("by_org", q => q.eq("orgId", args.orgId)).first();
    let defaultBranchId = existing?._id;

    if (!defaultBranchId) {
      defaultBranchId = await ctx.db.insert("branches", {
        orgId: args.orgId,
        name: "Main Showroom",
        address: "HQ",
        isActive: true,
      });
    }

    // Migrate Vehicles
    const vehicles = await ctx.db.query("vehicles").withIndex("by_org", q => q.eq("orgId", args.orgId)).collect();
    for (const v of vehicles) {
      if (!v.branchId) await ctx.db.patch(v._id, { branchId: defaultBranchId });
    }

    // Migrate Memberships
    const memberships = await ctx.db.query("memberships").withIndex("by_org", q => q.eq("orgId", args.orgId)).collect();
    for (const m of memberships) {
      if (!m.branchId) await ctx.db.patch(m._id, { branchId: defaultBranchId });
    }

    // Migrate Leads
    const leads = await ctx.db.query("leads").withIndex("by_org", q => q.eq("orgId", args.orgId)).collect();
    for (const l of leads) {
      if (!l.branchId) await ctx.db.patch(l._id, { branchId: defaultBranchId });
    }

    // Migrate Sales
    const sales = await ctx.db.query("sales").withIndex("by_org", q => q.eq("orgId", args.orgId)).collect();
    for (const s of sales) {
      if (!s.branchId) await ctx.db.patch(s._id, { branchId: defaultBranchId });
    }

    // Migrate Expenses
    const expenses = await ctx.db.query("expenses").withIndex("by_org", q => q.eq("orgId", args.orgId)).collect();
    for (const e of expenses) {
      if (!e.branchId) await ctx.db.patch(e._id, { branchId: defaultBranchId });
    }

    return defaultBranchId;
  }
});
