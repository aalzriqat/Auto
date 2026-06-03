import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";

/**
 * Retrieves aggregate statistics for the dashboard.
 * Requires the user to be a member of the organization.
 */
export const stats = query({
  args: {
    orgId: v.id("organizations"),
  },
  handler: async (ctx, args) => {
    // 1. Authenticate and verify membership
    await requireTenantAuth(ctx, args.orgId);

    // 2. Total Vehicles & Available Vehicles
    const vehicles = await ctx.db
      .query("vehicles")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
    
    const availableVehicles = vehicles.filter(v => v.status === "AVAILABLE").length;
    const totalVehicles = vehicles.length;

    // 3. Active Leads (not WON/LOST)
    const leads = await ctx.db
      .query("leads")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
      
    const activeLeads = leads.filter(l => l.stage !== "WON" && l.stage !== "LOST").length;

    // 4. Sales this month
    const sales = await ctx.db
      .query("sales")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();
      
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recentSales = sales.filter(s => s.saleDate >= thirtyDaysAgo && s.status !== "CANCELLED");
    const salesVolume = recentSales.reduce((acc, sale) => acc + sale.salePrice, 0);

    // 5. Team Members
    const members = await ctx.db
      .query("memberships")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .collect();

    return {
      totalVehicles,
      availableVehicles,
      activeLeads,
      salesThisMonth: recentSales.length,
      salesVolumeThisMonth: salesVolume,
      teamMembers: members.length,
    };
  },
});
