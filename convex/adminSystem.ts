import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query, mutation, internalMutation, internalQuery, internalAction, ActionCtx } from "./_generated/server";
import { requireSuperAdmin } from "./utils/tenancy";
import { internal } from "./_generated/api";

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
    await requireSuperAdmin(ctx);
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
    status: v.union(v.literal("received"), v.literal("success"), v.literal("error"), v.literal("dead_letter")),
    summary: v.string(),
    eventId: v.optional(v.string()),
    payloadSha256: v.optional(v.string()),
    rawPayload: v.optional(v.string()),
    payloadPreview: v.optional(v.string()),
    payloadTruncated: v.optional(v.boolean()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    if (args.status === "received" && args.eventId) {
      const existing = await ctx.db
        .query("webhookLogs")
        .withIndex("by_source_and_eventId", (q) =>
          q.eq("source", args.source).eq("eventId", args.eventId),
        )
        .first();
      if (existing?.status === "received") {
        const deliveryPatch: {
          summary: string;
          payloadSha256?: string;
          rawPayload?: string;
          payloadPreview?: string;
          payloadTruncated?: boolean;
          receiveCount: number;
          lastReceivedAt: number;
        } = {
          summary: args.summary,
          receiveCount: (existing.receiveCount ?? 1) + 1,
          lastReceivedAt: now,
        };
        if (args.payloadSha256 !== undefined) deliveryPatch.payloadSha256 = args.payloadSha256;
        if (args.rawPayload !== undefined) deliveryPatch.rawPayload = args.rawPayload;
        if (args.payloadPreview !== undefined) deliveryPatch.payloadPreview = args.payloadPreview;
        if (args.payloadTruncated !== undefined) deliveryPatch.payloadTruncated = args.payloadTruncated;

        await ctx.db.patch(existing._id, deliveryPatch);
        return existing._id;
      }
    }

    const logRecord = { ...args, createdAt: now };
    if (args.status === "received") {
      return await ctx.db.insert("webhookLogs", {
        ...logRecord,
        receiveCount: 1,
        lastReceivedAt: now,
      });
    }
    return await ctx.db.insert("webhookLogs", logRecord);
  },
});

/**
 * Resets a dead-letter or error webhook event back to "received" so it can be
 * re-delivered externally (e.g. Meta's "Resend" button in the Webhooks panel)
 * without the deduplication guard rejecting it as a duplicate.
 * Super-admin only.
 */
export const retryWebhookEvent = mutation({
  args: { webhookLogId: v.id("webhookLogs") },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const log = await ctx.db.get(args.webhookLogId);
    if (!log) throw new Error("Webhook log not found.");
    if (log.status === "success") throw new Error("Cannot retry a successfully-processed event.");
    await ctx.db.patch(args.webhookLogId, {
      status: "received",
      error: undefined,
      lastReceivedAt: Date.now(),
    });
    await ctx.db.insert("adminAuditLog", {
      actorUserId: admin._id,
      actorEmail: admin.email,
      action: "webhook.retry",
      targetTable: "webhookLogs",
      targetId: args.webhookLogId,
      createdAt: Date.now(),
    });
  },
});

/** Finds webhook events stuck in "received" status for >2 h and promotes them
 *  to "dead_letter" so the admin panel can surface them clearly.
 *
 *  The "received" status is only set by retryWebhookEvent (admin manually
 *  requeues a failed event). Normal intake logs directly to "success"/"error"
 *  in the HTTP handlers, so this scan is a safety net for retried events that
 *  somehow still haven't processed — not for initial-delivery failures. */
export const scanDeadLetterWebhooks = internalAction({
  args: {},
  handler: async (ctx: ActionCtx) => {
    const stuckIds = await ctx.runQuery(internal.adminSystem.getStuckWebhookIds, {});
    for (const id of stuckIds) {
      await ctx.runMutation(internal.adminSystem.markWebhookDeadLetter, { webhookLogId: id });
    }
    return `Marked ${stuckIds.length} stuck webhook(s) as dead_letter.`;
  },
});

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export const getStuckWebhookIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - TWO_HOURS_MS;
    // Use the index to pre-filter by createdAt; then verify lastReceivedAt
    // (if set) so events that received a late retry don't get re-flagged.
    const rows = await ctx.db
      .query("webhookLogs")
      .withIndex("by_status_createdAt", (q) =>
        q.eq("status", "received").lte("createdAt", cutoff)
      )
      .filter((q) =>
        q.or(
          q.eq(q.field("lastReceivedAt"), undefined),
          q.lte(q.field("lastReceivedAt"), cutoff)
        )
      )
      .take(200);
    return rows.map((r) => r._id);
  },
});

export const markWebhookDeadLetter = internalMutation({
  args: { webhookLogId: v.id("webhookLogs") },
  handler: async (ctx, args) => {
    const log = await ctx.db.get(args.webhookLogId);
    if (!log || log.status !== "received") return; // already processed or retried — skip
    const cutoff = Date.now() - TWO_HOURS_MS;
    const lastActivity = log.lastReceivedAt ?? log.createdAt;
    if (lastActivity > cutoff) return; // received a late retry between scan and mark — skip
    await ctx.db.patch(args.webhookLogId, {
      status: "dead_letter",
      error: "Processing timed out — event stuck in received state for >2 hours.",
    });
  },
});
