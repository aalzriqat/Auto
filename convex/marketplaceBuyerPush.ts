import { ConvexError, v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Push notifications for anonymous marketplace buyers. Unlike mobilePushTokens
 * (keyed by a logged-in userId), a buyer has no account — their device token is
 * keyed by the Request Room's unguessable publicId, so a new dealer offer can
 * ping the exact person watching that room. Mirrors expoPush.ts's send +
 * dead-token pruning, with fixed bilingual copy (we don't know the buyer's
 * locale server-side, and the notification is short).
 */

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

// Expo tokens always look like ExponentPushToken[...] or ExpoPushToken[...].
function isExpoPushToken(token: string): boolean {
  return /^Expo(nent)?PushToken\[[^\]]+\]$/.test(token.trim());
}

/**
 * Public: a buyer's device registers to be notified about their room. Deduped
 * by token — re-registering the same device (or a device that moved to another
 * room) replaces the old row instead of piling up. Silently accepts only real
 * Expo tokens so a bad client can't fill the table with junk.
 */
export const registerBuyerPushToken = mutation({
  args: {
    publicId: v.string(),
    token: v.string(),
    platform: v.union(v.literal("IOS"), v.literal("ANDROID"), v.literal("WEB")),
  },
  handler: async (ctx, args) => {
    const publicId = args.publicId.trim();
    const token = args.token.trim();
    if (!publicId) throw new ConvexError("Missing request id.");
    if (!isExpoPushToken(token)) throw new ConvexError("Invalid push token.");

    // One row per token: drop any prior registration of this device first.
    const existing = await ctx.db
      .query("marketplaceBuyerPushTokens")
      .withIndex("by_token", (q) => q.eq("token", token))
      .collect();
    for (const row of existing) await ctx.db.delete(row._id);

    await ctx.db.insert("marketplaceBuyerPushTokens", {
      publicId,
      token,
      platform: args.platform,
      createdAt: Date.now(),
    });
  },
});

export const listBuyerTokens = internalQuery({
  args: { publicId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("marketplaceBuyerPushTokens")
      .withIndex("by_publicId", (q) => q.eq("publicId", args.publicId.trim()))
      .collect();
  },
});

export const removeBuyerTokenByToken = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("marketplaceBuyerPushTokens")
      .withIndex("by_token", (q) => q.eq("token", args.token))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
  },
});

type ExpoTicket = { status?: string; details?: { error?: string } };

// Bilingual because the buyer's locale isn't stored server-side; kept short so
// both fit a lock screen.
const NEW_OFFER_TITLE = "عرض جديد · New offer";
const NEW_OFFER_BODY = "وصلك عرض جديد على طلبك — افتح أوتوفلو لتشوفه. · A dealer sent you an offer — open AutoFlow to see it.";

/**
 * Fires an Expo push to every device watching `publicId`, pruning any token
 * Expo reports as DeviceNotRegistered so the table self-heals. No-ops cleanly
 * when the buyer never enabled notifications (no tokens). Scheduled from
 * `respond` on a new offer.
 */
export const sendBuyerOfferPush = internalAction({
  args: { publicId: v.string() },
  handler: async (ctx, args): Promise<{ success: boolean; sent?: number; failed?: number; error?: string }> => {
    const tokens = await ctx.runQuery(internal.marketplaceBuyerPush.listBuyerTokens, { publicId: args.publicId });
    if (tokens.length === 0) return { success: true, sent: 0 };

    const messages = tokens.map((t) => ({
      to: t.token,
      title: NEW_OFFER_TITLE,
      body: NEW_OFFER_BODY,
      sound: "default" as const,
      data: { type: "marketplace.offer_received", publicId: args.publicId },
    }));

    let response: Response;
    try {
      response = await fetch(EXPO_PUSH_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(messages),
      });
    } catch (error) {
      return { success: false, error: String(error) };
    }
    if (!response.ok) return { success: false, error: `expo_http_${response.status}` };

    const payload = (await response.json()) as { data?: ExpoTicket[] };
    const tickets = payload.data ?? [];
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < tickets.length; i += 1) {
      const ticket = tickets[i];
      if (ticket.status === "ok") {
        sent += 1;
        continue;
      }
      failed += 1;
      if (ticket.details?.error === "DeviceNotRegistered" && tokens[i]) {
        await ctx.runMutation(internal.marketplaceBuyerPush.removeBuyerTokenByToken, { token: tokens[i].token });
      }
    }
    return { success: failed === 0, sent, failed };
  },
});
