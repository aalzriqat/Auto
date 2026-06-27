import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query, mutation, internalMutation, internalQuery } from "./_generated/server";
import { requireSuperAdmin } from "./utils/tenancy";

const OVERVIEW_TABLES = [
  "organizations",
  "users",
  "vehicles",
  "customers",
  "leads",
  "sales",
  "expenses",
  "tasks",
] as const;

export const getOverview = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);
    const counts: Record<string, number> = {};
    for (const table of OVERVIEW_TABLES) {
      counts[table] = (await ctx.db.query(table).collect()).length;
    }
    return counts;
  },
});

export const getCronStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);
    const all = await ctx.db.query("cronHeartbeats").collect();
    const latestByJob = new Map<string, (typeof all)[number]>();
    for (const row of all) {
      const existing = latestByJob.get(row.jobName);
      if (!existing || row.ranAt > existing.ranAt) {
        latestByJob.set(row.jobName, row);
      }
    }
    return Array.from(latestByJob.values());
  },
});

export const listWebhookLogs = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    return await ctx.db.query("webhookLogs").withIndex("by_createdAt").order("desc").paginate(args.paginationOpts);
  },
});

// Called from convex/http.ts and convex/whatsapp.ts httpActions to record
// webhook delivery outcomes for the admin Overview page.
// ─── Site-wide configuration ──────────────────────────────────────────────────

export const getSiteConfig = query({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("siteConfig")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    return row?.value ?? null;
  },
});

export const getSiteConfigInternal = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("siteConfig")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    return row?.value ?? null;
  },
});

export const setSiteConfig = mutation({
  args: { key: v.string(), value: v.any() },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const existing = await ctx.db
      .query("siteConfig")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, { value: args.value, updatedAt: Date.now() });
    } else {
      await ctx.db.insert("siteConfig", { key: args.key, value: args.value, updatedAt: Date.now() });
    }
  },
});

export const logWebhookEvent = internalMutation({
  args: {
    source: v.union(
      v.literal("clerk"),
      v.literal("whatsapp"),
      v.literal("resend"),
      v.literal("instagram-oauth"),
      v.literal("instagram"),
      v.literal("facebook-oauth"),
      v.literal("facebook"),
      v.literal("notification-email"),
      v.literal("notification-whatsapp"),
      v.literal("subscription-reminder"),
      v.literal("support-inbox-notification"),
      v.literal("upgrade-request")
    ),
    status: v.union(v.literal("success"), v.literal("error")),
    summary: v.string(),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("webhookLogs", { ...args, createdAt: Date.now() });
  },
});
