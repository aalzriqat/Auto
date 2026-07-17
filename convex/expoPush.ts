import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { rateLimiter } from "./rateLimit";
import { renderNotification } from "../lib/notifications/render";

const EXPO_PUSH_ENDPOINT = "https://exp.host/--/api/v2/push/send";

// Same rationale as pushSend.ts: a couple of notification types carry
// user-typed content that shouldn't appear on a lock screen. Kept in step with
// PUSH_BODY_OVERRIDE there.
const PUSH_BODY_OVERRIDE: Partial<Record<string, Record<"en" | "ar", string>>> = {
  "message.received": {
    en: "Open AutoFlow to read it.",
    ar: "افتح AutoFlow للاطلاع عليها.",
  },
};

type ExpoTicket = { status?: string; details?: { error?: string } };

/**
 * Expo push delivery for the native app. Fans out to every device the user has
 * registered (mobilePushTokens) and prunes any token Expo reports as
 * DeviceNotRegistered so the table self-heals. Reuses the same bilingual copy
 * as email/web-push (lib/notifications/render.ts). Reaches Android only through
 * FCM, so it silently no-ops on devices without Google Play Services.
 */
export const sendMobilePush = internalAction({
  args: {
    userId: v.id("users"),
    locale: v.union(v.literal("en"), v.literal("ar")),
    type: v.string(),
    data: v.any(),
    link: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const status = await rateLimiter.limit(ctx, "notificationPush");
    if (!status.ok) return { success: false, error: "rate_limited" };

    const tokens = await ctx.runQuery(internal.mobilePushTokens.listForUser, { userId: args.userId });
    if (tokens.length === 0) return { success: true, sent: 0 };

    const { title, message } = renderNotification(args.locale, args.type, args.data);
    const body = PUSH_BODY_OVERRIDE[args.type]?.[args.locale] ?? (message || title);

    const messages = tokens.map((t) => ({
      to: t.token,
      title,
      body,
      sound: "default" as const,
      data: { link: args.link ?? "/", type: args.type },
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

    if (!response.ok) {
      return { success: false, error: `expo_http_${response.status}` };
    }

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
      // Expo hands back a per-message ticket; a dead token is pruned so it
      // stops costing a send every time.
      if (ticket.details?.error === "DeviceNotRegistered" && tokens[i]) {
        await ctx.runMutation(internal.mobilePushTokens.removeByToken, { token: tokens[i].token });
      }
    }

    return { success: failed === 0, sent, failed };
  },
});
