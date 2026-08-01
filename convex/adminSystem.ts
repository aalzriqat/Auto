import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { paginationOptsValidator } from "convex/server";
import { query, internalQuery, internalAction, ActionCtx, QueryCtx } from "./_generated/server";
import { mutation, internalMutation } from "./functions";
import { requireSuperAdmin } from "./utils/tenancy";
import { internal } from "./_generated/api";
import { CRON_HEARTBEAT_JOBS } from "./constants";

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

/**
 * Ceiling on the rows any one KPI tile will read. This is a *live* query on an
 * always-open admin page, so it re-runs on every write to any of the eight
 * tables — an uncapped `.collect()` per table meant one dashboard write
 * re-read the whole database. Past the cap the tile reads "10,000+", which is
 * all a system-wide KPI tile was ever conveying.
 */
const OVERVIEW_COUNT_CAP = 10_000;

export const getOverview = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);
    const counts: Record<string, { count: number; truncated: boolean }> = {};
    for (const table of OVERVIEW_TABLES) {
      // Read one past the cap so `truncated` distinguishes "exactly at the cap"
      // from "more than the cap".
      const rows = await ctx.db.query(table).take(OVERVIEW_COUNT_CAP + 1);
      counts[table] = {
        count: Math.min(rows.length, OVERVIEW_COUNT_CAP),
        truncated: rows.length > OVERVIEW_COUNT_CAP,
      };
    }
    return counts;
  },
});

/** Newest heartbeat for one job — a single indexed read, ordered by `ranAt`. */
async function newestHeartbeatForJob(ctx: QueryCtx, jobName: string) {
  return await ctx.db
    .query("cronHeartbeats")
    .withIndex("by_job_ranAt", (q) => q.eq("jobName", jobName))
    .order("desc")
    .first();
}

export const getCronStatus = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);
    // One indexed row per known job, rather than scanning a table that grows
    // ~288 rows/day forever. The heartbeat insert invalidates this query every
    // 5 minutes, so its read set has to stay O(jobs), not O(table).
    const latest = await Promise.all(
      CRON_HEARTBEAT_JOBS.map((jobName) => newestHeartbeatForJob(ctx, jobName))
    );
    return latest.filter((row): row is NonNullable<typeof row> => row !== null);
  },
});

// ─── Operational-log retention ───────────────────────────────────────────────
//
// `cronHeartbeats` and `webhookLogs` are append-only diagnostics that nothing
// ever deleted: heartbeats grew ~288 rows/day and webhook logs ~100/day, on
// every deployment, forever. Both are only ever read as "what happened
// recently", so anything past the window is pure carrying cost.

const CRON_HEARTBEAT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const WEBHOOK_LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * `notifications` is the third table nothing ever deleted from, and the only
 * one of the three holding user-facing data rather than diagnostics — so it
 * gets a much longer window and a different justification.
 *
 * It grows with activity: one row per manager per notifiable event, plus one
 * per inbound social message. The shared dev deployment reached 4,201 unread on
 * a single account; production is younger but has the same unbounded shape.
 * Capping the badge read (`notifications.unreadCount`) removed the
 * *performance* consequence, which is why this is retention rather than a
 * rescue — nobody is waiting on it.
 *
 * ## Why age alone, and not "only if read"
 *
 * Deleting only read rows sounds safer and is actually a starvation bug: the
 * sweep walks oldest-first, and a user who never reads anything leaves the
 * oldest rows permanently ineligible, so every hourly run rescans the same
 * block and deletes nothing forever. Staying bounded *and* selective would need
 * a new composite index on (isRead, _creationTime).
 *
 * Age alone is also the more honest rule. A ninety-day-old notification is not
 * actionable whether or not anyone opened it — the lead, sale or task it points
 * at is long since resolved or abandoned, and the row is a pointer to a record
 * that still exists in its own table. Nothing is lost that the underlying data
 * does not already hold.
 *
 * Ninety days rather than thirty because this is the one window a user could
 * notice: the notifications page is a history view, and a quarter of history is
 * a defensible thing to keep.
 */
const NOTIFICATION_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Per-table, per-run delete ceiling — keeps one sweep well inside a mutation's
 *  write budget. Hourly runs clear a backlog of tens of thousands within a day. */
const RETENTION_DELETE_BATCH = 1000;

export const pruneOperationalLogs = internalMutation({
  args: {
    /**
     * Overrides `NOTIFICATION_RETENTION_MS` for one run.
     *
     * Exists because notifications are aged by `_creationTime`, and
     * `convex-test` stamps that from the real clock — `vi.setSystemTime` does
     * not reach it, so a test cannot seed a row that is already old. The other
     * two tables carry their own `ranAt`/`createdAt`, which a test sets freely;
     * this is the seam that gives notifications equivalent coverage.
     *
     * The cron passes nothing. Deliberately narrow rather than a general
     * "prune everything older than X" knob: a caller passing 0 deletes every
     * notification on the deployment, so it stays internal and documented as a
     * test seam rather than an operator tool.
     */
    notificationRetentionMsOverride: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const staleHeartbeats = await ctx.db
      .query("cronHeartbeats")
      .withIndex("by_ranAt", (q) => q.lt("ranAt", now - CRON_HEARTBEAT_RETENTION_MS))
      .take(RETENTION_DELETE_BATCH);

    // The newest heartbeat per job survives regardless of age, so the admin
    // Cron Status panel never goes blank for a job whose interval is longer
    // than the retention window (the depreciation cron runs monthly). Names are
    // taken from the batch rather than from CRON_HEARTBEAT_JOBS so a job that
    // was never registered there still keeps its last row instead of being
    // erased — deleting the only evidence a cron ever ran is unrecoverable.
    const jobNames = Array.from(new Set(staleHeartbeats.map((row) => row.jobName)));
    const newestPerJob = await Promise.all(
      jobNames.map((jobName) => newestHeartbeatForJob(ctx, jobName))
    );
    const keep = new Set(
      newestPerJob.filter((row) => row !== null).map((row) => row!._id)
    );

    let heartbeatsDeleted = 0;
    for (const row of staleHeartbeats) {
      if (keep.has(row._id)) continue;
      await ctx.db.delete(row._id);
      heartbeatsDeleted++;
    }

    const staleWebhookLogs = await ctx.db
      .query("webhookLogs")
      .withIndex("by_createdAt", (q) => q.lt("createdAt", now - WEBHOOK_LOG_RETENTION_MS))
      .take(RETENTION_DELETE_BATCH);

    let webhookLogsDeleted = 0;
    for (const row of staleWebhookLogs) {
      await ctx.db.delete(row._id);
      webhookLogsDeleted++;
    }

    // `notifications` carries no `createdAt` of its own, so this uses the
    // built-in `by_creation_time` index. That is exactly the ordering the sweep
    // wants — oldest first — and keeps the read a bounded indexed range rather
    // than a filtered table scan.
    const notificationRetentionMs =
      args.notificationRetentionMsOverride ?? NOTIFICATION_RETENTION_MS;
    const staleNotifications = await ctx.db
      .query("notifications")
      .withIndex("by_creation_time", (q) =>
        q.lt("_creationTime", now - notificationRetentionMs)
      )
      .take(RETENTION_DELETE_BATCH);

    let notificationsDeleted = 0;
    for (const row of staleNotifications) {
      await ctx.db.delete(row._id);
      notificationsDeleted++;
    }

    return { heartbeatsDeleted, webhookLogsDeleted, notificationsDeleted };
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

const webhookSourceValidator = v.union(
  v.literal("clerk"),
  v.literal("whatsapp"),
  v.literal("resend"),
  v.literal("instagram-oauth"),
  v.literal("instagram"),
  v.literal("facebook-oauth"),
  v.literal("facebook"),
  v.literal("notification-email"),
  v.literal("notification-whatsapp"),
  v.literal("notification-push"),
  v.literal("subscription-reminder"),
  v.literal("support-inbox-notification"),
  v.literal("upgrade-request"),
  v.literal("social-auto-reply-retry"),
  v.literal("fixed-asset-depreciation"),
  v.literal("fi-commission-recognition"),
  v.literal("prepaid-expense-amortization"),
  v.literal("marketplace-weekly-report"),
  v.literal("marketplace-whatsapp")
);

/**
 * One-shot outcome log for internal jobs (crons, outbound emails, OAuth
 * callbacks, auto-reply failures). These are point-in-time records, not
 * deliveries with a lifecycle — verified provider webhooks must go through
 * webhookInboxIntake/webhookInboxComplete instead.
 */
export const logWebhookEvent = internalMutation({
  args: {
    source: webhookSourceValidator,
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
    return await ctx.db.insert("webhookLogs", { ...args, createdAt: Date.now() });
  },
});

/** How long a claimed ("received") delivery is considered in-flight before a
 *  redelivery may reclaim it. Convex mutations are transactional, so the claim
 *  itself is atomic; the lease covers the action-side processing window. */
const WEBHOOK_IN_FLIGHT_LEASE_MS = 5 * 60 * 1000;

/**
 * Durable webhook inbox intake: exactly one row per (source, eventId).
 * Atomically claims the event for processing and tells the HTTP handler what
 * to do with this delivery:
 *
 *  - "process":        new event, or a retryable prior failure — handler must
 *                      process it and then call webhookInboxComplete.
 *  - "skip_processed": this event already completed successfully — respond 200
 *                      without reprocessing (idempotent dedup).
 *  - "skip_in_flight": another delivery of this event is currently being
 *                      processed — respond non-2xx so the provider redelivers
 *                      later (never double-process concurrently).
 */
export const webhookInboxIntake = internalMutation({
  args: {
    source: webhookSourceValidator,
    summary: v.string(),
    eventId: v.string(),
    payloadSha256: v.optional(v.string()),
    rawPayload: v.optional(v.string()),
    payloadPreview: v.optional(v.string()),
    payloadTruncated: v.optional(v.boolean()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    logId: Id<"webhookLogs">;
    claimedAt?: number;
    disposition: "process" | "skip_processed" | "skip_in_flight";
  }> => {
    const now = Date.now();
    const existing = await ctx.db
      .query("webhookLogs")
      .withIndex("by_source_and_eventId", (q) =>
        q.eq("source", args.source).eq("eventId", args.eventId)
      )
      .first();

    if (!existing) {
      const logId = await ctx.db.insert("webhookLogs", {
        source: args.source,
        status: "received",
        summary: args.summary,
        eventId: args.eventId,
        payloadSha256: args.payloadSha256,
        rawPayload: args.rawPayload,
        payloadPreview: args.payloadPreview,
        payloadTruncated: args.payloadTruncated,
        receiveCount: 1,
        lastReceivedAt: now,
        createdAt: now,
      });
      return { logId, claimedAt: now, disposition: "process" };
    }

    if (existing.status === "success") {
      await ctx.db.patch(existing._id, {
        receiveCount: (existing.receiveCount ?? 1) + 1,
        lastReceivedAt: now,
      });
      return { logId: existing._id, disposition: "skip_processed" };
    }

    const lastActivity = existing.lastReceivedAt ?? existing.createdAt;
    if (existing.status === "received" && now - lastActivity < WEBHOOK_IN_FLIGHT_LEASE_MS) {
      // Deliberately do NOT bump lastReceivedAt: a redelivery storm must not
      // extend the lease forever and starve the reclaim path.
      await ctx.db.patch(existing._id, {
        receiveCount: (existing.receiveCount ?? 1) + 1,
      });
      return { logId: existing._id, disposition: "skip_in_flight" };
    }

    // Prior error/dead-letter, or a stale claim from a crashed run — reclaim.
    await ctx.db.patch(existing._id, {
      status: "received",
      summary: args.summary,
      error: undefined,
      receiveCount: (existing.receiveCount ?? 1) + 1,
      lastReceivedAt: now,
      ...(args.payloadSha256 !== undefined ? { payloadSha256: args.payloadSha256 } : {}),
      ...(args.rawPayload !== undefined ? { rawPayload: args.rawPayload } : {}),
      ...(args.payloadPreview !== undefined ? { payloadPreview: args.payloadPreview } : {}),
      ...(args.payloadTruncated !== undefined ? { payloadTruncated: args.payloadTruncated } : {}),
    });
    return { logId: existing._id, claimedAt: now, disposition: "process" };
  },
});

/** Completes a claimed inbox delivery — the same row moves received → success/error. */
export const webhookInboxComplete = internalMutation({
  args: {
    logId: v.id("webhookLogs"),
    claimedAt: v.number(),
    outcome: v.union(v.literal("success"), v.literal("error")),
    error: v.optional(v.string()),
    summary: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const log = await ctx.db.get(args.logId);
    if (!log || log.status !== "received") return;
    if (log.lastReceivedAt !== args.claimedAt) return;
    await ctx.db.patch(args.logId, {
      status: args.outcome,
      error: args.outcome === "error" ? args.error : undefined,
      ...(args.summary !== undefined ? { summary: args.summary } : {}),
    });
  },
});

/**
 * Marks a dead-letter or error webhook event retryable so the next provider
 * redelivery can reclaim it immediately. The admin action itself does not
 * re-dispatch stored payloads; it only clears the terminal state safely.
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
      status: "error",
      error: "Manual retry requested. Awaiting provider redelivery.",
      lastReceivedAt: undefined,
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
 *  "received" marks a claimed inbox delivery (webhookInboxIntake). Handlers complete the same row to
 *  "success"/"error" via webhookInboxComplete, so a row still "received" after
 *  2 h means the processing action crashed mid-flight (or a retried event was
 *  never redelivered) — a genuine dead letter. */
export const scanDeadLetterWebhooks = internalAction({
  args: {},
  handler: async (ctx: ActionCtx) => {
    const stuckIds: Id<"webhookLogs">[] = await ctx.runQuery(internal.adminSystem.getStuckWebhookIds, {});
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
