import { ConvexError, v } from "convex/values";
import { mutation, internalQuery, internalMutation } from "./_generated/server";
import { requireAuth } from "./utils/tenancy";

const platformValidator = v.union(v.literal("IOS"), v.literal("ANDROID"));

// Expo tokens always look like ExponentPushToken[...] or ExpoPushToken[...].
// Reject anything else early so a misconfigured client can't fill the table
// with junk the Expo push API would only bounce anyway.
function isExpoPushToken(token: string): boolean {
  return /^Expo(nent)?PushToken\[.+\]$/.test(token.trim());
}

/**
 * Registers (or refreshes) the calling user's Expo push token for this device.
 * Keyed by the token: if the same device token is already on file it's moved to
 * the current user and its lastSeenAt bumped, so a shared/re-signed-in device
 * never pushes to the wrong account.
 */
export const register = mutation({
  args: { token: v.string(), platform: platformValidator, deviceName: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx);
    const token = args.token.trim();
    if (!isExpoPushToken(token)) {
      throw new ConvexError("That doesn't look like an Expo push token.");
    }

    const now = Date.now();
    const existing = await ctx.db
      .query("mobilePushTokens")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();

    if (existing) {
      await ctx.db.patch(existing._id, {
        userId: user._id,
        platform: args.platform,
        deviceName: args.deviceName,
        lastSeenAt: now,
      });
      return existing._id;
    }

    return await ctx.db.insert("mobilePushTokens", {
      userId: user._id,
      token,
      platform: args.platform,
      deviceName: args.deviceName,
      createdAt: now,
      lastSeenAt: now,
    });
  },
});

/** Unregisters a device token — called on sign-out or when the OS reports the permission was revoked. */
export const remove = mutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const user = await requireAuth(ctx);
    const existing = await ctx.db
      .query("mobilePushTokens")
      .withIndex("by_token", (q) => q.eq("token", args.token.trim()))
      .unique();
    // Only the owner can remove their own token; silently succeed otherwise so
    // sign-out never surfaces an error over a stale/foreign token.
    if (existing && existing.userId === user._id) {
      await ctx.db.delete(existing._id);
    }
  },
});

export const listForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("mobilePushTokens")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .collect();
  },
});

/** Prunes a token the Expo push service reported as DeviceNotRegistered. */
export const removeByToken = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("mobilePushTokens")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});
