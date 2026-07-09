import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { requireSuperAdmin } from "./utils/tenancy";

export const getOverview = query({
  args: {},
  handler: async (
    ctx
  ): Promise<{
    newVisitorsToday: number;
    newVisitors7d: number;
    pageViews7d: number;
    topTrafficSources: { label: string; count: number }[];
    topPages: { path: string; count: number }[];
  }> => {
    await requireSuperAdmin(ctx);
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

    const newVisitorsToday = (
      await ctx.db
        .query("siteVisitors")
        .withIndex("by_firstSeenAt", (q) => q.gte("firstSeenAt", dayAgo))
        .take(5000)
    ).length;
    const newVisitors7d = (
      await ctx.db
        .query("siteVisitors")
        .withIndex("by_firstSeenAt", (q) => q.gte("firstSeenAt", weekAgo))
        .take(5000)
    ).length;

    const recentEvents = await ctx.db
      .query("siteVisitorEvents")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", weekAgo))
      .take(3000);

    const sourceCounts = new Map<string, number>();
    const pageCounts = new Map<string, number>();
    let pageViews7d = 0;
    for (const event of recentEvents) {
      sourceCounts.set(event.trafficSource, (sourceCounts.get(event.trafficSource) ?? 0) + 1);
      if (event.type === "page_view") {
        pageViews7d += 1;
        pageCounts.set(event.path, (pageCounts.get(event.path) ?? 0) + 1);
      }
    }

    const topTrafficSources = Array.from(sourceCounts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    const topPages = Array.from(pageCounts.entries())
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    return { newVisitorsToday, newVisitors7d, pageViews7d, topTrafficSources, topPages };
  },
});

export const listVisitors = query({
  args: {
    paginationOpts: paginationOptsValidator,
    // "all" (default): every visitor across every org and the marketing site.
    // "platform": only AutoFlow's own marketing/auth pages (orgId undefined).
    // An Id<"organizations"> string: only that org's dealer-site visitors.
    scope: v.optional(v.union(v.literal("all"), v.literal("platform"), v.id("organizations"))),
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const scope = args.scope ?? "all";
    if (scope === "platform") {
      return await ctx.db
        .query("siteVisitors")
        .withIndex("by_org_firstSeenAt", (q) => q.eq("orgId", undefined))
        .order("desc")
        .paginate(args.paginationOpts);
    }
    if (scope !== "all") {
      const orgId = scope;
      return await ctx.db
        .query("siteVisitors")
        .withIndex("by_org_firstSeenAt", (q) => q.eq("orgId", orgId))
        .order("desc")
        .paginate(args.paginationOpts);
    }
    return await ctx.db
      .query("siteVisitors")
      .withIndex("by_firstSeenAt")
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const getVisitorJourney = query({
  args: { siteVisitorId: v.id("siteVisitors") },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const visitor = await ctx.db.get(args.siteVisitorId);
    if (!visitor) return null;
    const events = await ctx.db
      .query("siteVisitorEvents")
      .withIndex("by_visitor_createdAt", (q) => q.eq("visitorId", visitor.visitorId))
      .order("asc")
      .take(500);
    return { visitor, events };
  },
});
