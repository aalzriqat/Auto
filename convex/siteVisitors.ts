import { ConvexError, v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { internalMutation, internalAction, mutation, query, MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { requireTenantAuth, requireSuperAdmin } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { classifyTrafficSource } from "./utils/trafficSource";
import { parseUserAgent } from "./utils/userAgent";
import { lookupGeoForIp } from "./utils/geoProvider";
import { logAdminAction } from "./adminAudit";

const SITE_EVENT_MAX_PATH_CHARS = 512;
const SITE_EVENT_MAX_LABEL_CHARS = 200;
const SITE_EVENT_MAX_SHORT_CHARS = 200;
const SITE_EVENT_MAX_UA_CHARS = 512;
const PURGE_BATCH_SIZE = 200;

function clamp(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function clampPath(value: string): string {
  const text = value.trim();
  return (text || "/").slice(0, SITE_EVENT_MAX_PATH_CHARS);
}

export const recordEvent = internalMutation({
  args: {
    orgId: v.optional(v.id("organizations")),
    host: v.string(),
    visitorId: v.string(),
    sessionId: v.string(),
    type: v.union(v.literal("page_view"), v.literal("link_click")),
    path: v.string(),
    linkTarget: v.optional(v.string()),
    linkLabel: v.optional(v.string()),
    referrerHost: v.optional(v.string()),
    referrerUrl: v.optional(v.string()),
    utmSource: v.optional(v.string()),
    utmMedium: v.optional(v.string()),
    utmCampaign: v.optional(v.string()),
    utmTerm: v.optional(v.string()),
    utmContent: v.optional(v.string()),
    clickIdType: v.optional(v.string()),
    clickIdValue: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    language: v.optional(v.string()),
    timezone: v.optional(v.string()),
    screenWidth: v.optional(v.number()),
    screenHeight: v.optional(v.number()),
    viewportWidth: v.optional(v.number()),
    viewportHeight: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ isNewVisitor: boolean; siteVisitorId: Id<"siteVisitors"> }> => {
    const now = Date.now();
    const path = clampPath(args.path);
    const referrerHost = clamp(args.referrerHost, SITE_EVENT_MAX_SHORT_CHARS);
    const utmSource = clamp(args.utmSource, SITE_EVENT_MAX_SHORT_CHARS);
    const utmMedium = clamp(args.utmMedium, SITE_EVENT_MAX_SHORT_CHARS);
    const utmCampaign = clamp(args.utmCampaign, SITE_EVENT_MAX_SHORT_CHARS);
    const clickIdType = clamp(args.clickIdType, 32);
    const userAgent = clamp(args.userAgent, SITE_EVENT_MAX_UA_CHARS);

    const traffic = classifyTrafficSource({
      referrerHost,
      ownHosts: [args.host],
      utmSource,
      utmMedium,
      clickIdType,
    });

    const existing = await ctx.db
      .query("siteVisitors")
      .withIndex("by_org_visitor", (q) => q.eq("orgId", args.orgId).eq("visitorId", args.visitorId))
      .unique();

    let siteVisitorId: Id<"siteVisitors">;
    let isNewVisitor: boolean;

    if (!existing) {
      isNewVisitor = true;
      const parsed = parseUserAgent(userAgent);
      siteVisitorId = await ctx.db.insert("siteVisitors", {
        orgId: args.orgId,
        host: args.host,
        visitorId: args.visitorId,
        firstSeenAt: now,
        lastSeenAt: now,
        visitCount: 1,
        pageViewCount: args.type === "page_view" ? 1 : 0,
        linkClickCount: args.type === "link_click" ? 1 : 0,
        firstTrafficSource: traffic.label,
        firstReferrerHost: referrerHost,
        firstUtmSource: utmSource,
        firstUtmMedium: utmMedium,
        firstUtmCampaign: utmCampaign,
        deviceType: parsed.deviceType,
        browserName: parsed.browserName,
        osName: parsed.osName,
        geoLookupStatus: "pending",
        lastSessionId: args.sessionId,
      });
    } else {
      isNewVisitor = false;
      siteVisitorId = existing._id;
      const isNewSession = existing.lastSessionId !== args.sessionId;
      await ctx.db.patch(existing._id, {
        lastSeenAt: now,
        visitCount: isNewSession ? existing.visitCount + 1 : existing.visitCount,
        pageViewCount: existing.pageViewCount + (args.type === "page_view" ? 1 : 0),
        linkClickCount: existing.linkClickCount + (args.type === "link_click" ? 1 : 0),
        lastSessionId: args.sessionId,
      });
    }

    await ctx.db.insert("siteVisitorEvents", {
      orgId: args.orgId,
      host: args.host,
      visitorId: args.visitorId,
      sessionId: args.sessionId,
      type: args.type,
      path,
      linkTarget: clamp(args.linkTarget, SITE_EVENT_MAX_PATH_CHARS),
      linkLabel: clamp(args.linkLabel, SITE_EVENT_MAX_LABEL_CHARS),
      referrerHost,
      referrerUrl: clamp(args.referrerUrl, SITE_EVENT_MAX_PATH_CHARS),
      utmSource,
      utmMedium,
      utmCampaign,
      utmTerm: clamp(args.utmTerm, SITE_EVENT_MAX_SHORT_CHARS),
      utmContent: clamp(args.utmContent, SITE_EVENT_MAX_SHORT_CHARS),
      clickIdType,
      clickIdValue: clamp(args.clickIdValue, SITE_EVENT_MAX_SHORT_CHARS),
      trafficSource: traffic.label,
      userAgent,
      language: clamp(args.language, 32),
      timezone: clamp(args.timezone, 64),
      screenWidth: args.screenWidth,
      screenHeight: args.screenHeight,
      viewportWidth: args.viewportWidth,
      viewportHeight: args.viewportHeight,
      createdAt: now,
    });

    return { isNewVisitor, siteVisitorId };
  },
});

export const applyGeoResult = internalMutation({
  args: {
    siteVisitorId: v.id("siteVisitors"),
    country: v.optional(v.string()),
    region: v.optional(v.string()),
    city: v.optional(v.string()),
    status: v.union(v.literal("done"), v.literal("failed")),
  },
  handler: async (ctx, args): Promise<void> => {
    const visitor = await ctx.db.get(args.siteVisitorId);
    if (!visitor) return; // deleted (org hard-delete or manual purge) before the lookup finished
    await ctx.db.patch(args.siteVisitorId, {
      country: args.country,
      region: args.region,
      city: args.city,
      geoLookupStatus: args.status,
    });
  },
});

export const enrichVisitorGeo = internalAction({
  args: { siteVisitorId: v.id("siteVisitors"), ip: v.string() },
  handler: async (ctx, args): Promise<void> => {
    const result = await lookupGeoForIp(args.ip);
    await ctx.runMutation(internal.siteVisitors.applyGeoResult, {
      siteVisitorId: args.siteVisitorId,
      country: result?.country,
      region: result?.region,
      city: result?.city,
      status: result ? "done" : "failed",
    });
  },
});

export const getOrgVisitorOverview = query({
  args: { orgId: v.id("organizations") },
  handler: async (
    ctx,
    args
  ): Promise<{
    newVisitors7d: number;
    pageViews7d: number;
    topTrafficSources: { label: string; count: number }[];
    topPages: { path: string; count: number }[];
  }> => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.WEBSITE_ANALYTICS_VIEW]);
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const recentVisitors = await ctx.db
      .query("siteVisitors")
      .withIndex("by_org_firstSeenAt", (q) => q.eq("orgId", args.orgId).gte("firstSeenAt", since))
      .take(5000);

    const recentEvents = await ctx.db
      .query("siteVisitorEvents")
      .withIndex("by_org_createdAt", (q) => q.eq("orgId", args.orgId).gte("createdAt", since))
      .take(2000);

    const sourceCounts = new Map<string, number>();
    const pageCounts = new Map<string, number>();
    let pageViews7d = 0;
    for (const event of recentEvents) {
      if (event.type === "page_view") {
        pageViews7d += 1;
        pageCounts.set(event.path, (pageCounts.get(event.path) ?? 0) + 1);
      }
      sourceCounts.set(event.trafficSource, (sourceCounts.get(event.trafficSource) ?? 0) + 1);
    }

    const topTrafficSources = Array.from(sourceCounts.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    const topPages = Array.from(pageCounts.entries())
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);

    return { newVisitors7d: recentVisitors.length, pageViews7d, topTrafficSources, topPages };
  },
});

export const listOrgVisitors = query({
  args: { orgId: v.id("organizations"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.WEBSITE_ANALYTICS_VIEW]);
    return await ctx.db
      .query("siteVisitors")
      .withIndex("by_org_firstSeenAt", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

async function deleteEventBatch(ctx: MutationCtx, cutoff: number): Promise<number> {
  const rows = await ctx.db
    .query("siteVisitorEvents")
    .withIndex("by_createdAt", (q) => q.lt("createdAt", cutoff))
    .take(PURGE_BATCH_SIZE);
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
  return rows.length;
}

export const purgeEventsOlderThan = mutation({
  args: { olderThanDays: v.number() },
  handler: async (ctx, args): Promise<{ started: boolean }> => {
    const admin = await requireSuperAdmin(ctx);
    if (!Number.isFinite(args.olderThanDays) || args.olderThanDays < 1) {
      throw new ConvexError("olderThanDays must be a positive number.");
    }
    const cutoff = Date.now() - args.olderThanDays * 24 * 60 * 60 * 1000;
    await logAdminAction(ctx, admin, {
      action: "site-analytics-purge",
      targetTable: "siteVisitorEvents",
      after: { olderThanDays: args.olderThanDays, cutoff },
    });
    const deleted = await deleteEventBatch(ctx, cutoff);
    if (deleted === PURGE_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.siteVisitors.continuePurge, { cutoff });
    }
    return { started: true };
  },
});

export const continuePurge = internalMutation({
  args: { cutoff: v.number() },
  handler: async (ctx, args): Promise<void> => {
    const deleted = await deleteEventBatch(ctx, args.cutoff);
    if (deleted === PURGE_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.siteVisitors.continuePurge, { cutoff: args.cutoff });
    }
  },
});
