import { v } from "convex/values";
import { query, mutation, internalQuery, internalMutation } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";

/**
 * Registers (or refreshes) a browser/device's Web Push subscription for the
 * caller in this org. Keyed by (endpoint, orgId, userId) rather than
 * endpoint alone: a push endpoint is scoped to the browser origin, not to an
 * org, so a user in several orgs on the same device reuses the same
 * endpoint in each — endpoint-only keying would let subscribing in org B
 * silently steal (rewrite) the row created for org A instead of adding a
 * second one.
 */
export const subscribe = mutation({
  args: {
    orgId: v.id("organizations"),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    userAgent: v.optional(v.string()),
    deviceName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint_org_user", (q) =>
        q.eq("endpoint", args.endpoint).eq("orgId", args.orgId).eq("userId", user._id)
      )
      .unique();

    const now = Date.now();

    if (existing) {
      await ctx.db.patch(existing._id, {
        p256dh: args.p256dh,
        auth: args.auth,
        userAgent: args.userAgent,
        deviceName: args.deviceName,
        enabled: true,
        lastSeenAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("pushSubscriptions", {
      orgId: args.orgId,
      userId: user._id,
      endpoint: args.endpoint,
      p256dh: args.p256dh,
      auth: args.auth,
      userAgent: args.userAgent,
      deviceName: args.deviceName,
      enabled: true,
      createdAt: now,
      lastSeenAt: now,
    });
  },
});

/** Removes this org's registration of a device's subscription (called on the client's unsubscribe path). */
export const unsubscribe = mutation({
  args: {
    orgId: v.id("organizations"),
    endpoint: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const existing = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint_org_user", (q) =>
        q.eq("endpoint", args.endpoint).eq("orgId", args.orgId).eq("userId", user._id)
      )
      .unique();

    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});

/** Lists the caller's registered devices for the "manage devices" UI. */
export const listMyDevices = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const rows = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", user._id))
      .collect();

    return rows.map((row) => ({
      _id: row._id,
      deviceName: row.deviceName,
      userAgent: row.userAgent,
      enabled: row.enabled,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
    }));
  },
});

/** Disables a single device without deleting its row (re-enabled on next successful subscribe). */
export const disableDevice = mutation({
  args: {
    orgId: v.id("organizations"),
    subscriptionId: v.id("pushSubscriptions"),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId);

    const existing = await ctx.db.get(args.subscriptionId);
    if (!existing || existing.userId !== user._id || existing.orgId !== args.orgId) return;

    await ctx.db.patch(existing._id, { enabled: false });
  },
});

/** Internal-only: the full rows (incl. keys) a scheduled push send needs — not exposed to clients. */
export const listEnabledForUser = internalQuery({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_org_user", (q) => q.eq("orgId", args.orgId).eq("userId", args.userId))
      .collect();
    return rows.filter((row) => row.enabled);
  },
});

/**
 * Internal-only: drops every row for an endpoint the push service reports as
 * gone (HTTP 404/410) — a dead endpoint means the browser's actual
 * subscription no longer exists at all, so every org/user row referencing it
 * (see subscribe() above for why there can be more than one) is equally dead.
 */
export const removeByEndpoint = internalMutation({
  args: { endpoint: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("pushSubscriptions")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", args.endpoint))
      .collect();
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
  },
});
