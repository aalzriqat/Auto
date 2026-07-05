"use node";

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import webpush from "web-push";
import { rateLimiter } from "./rateLimit";
import { getValidatedEnv } from "./utils/env";
import { renderNotification } from "../lib/notifications/render";

// Push/lock-screen text is visible without unlocking the device. Most
// notification types already render generic-enough copy (e.g. "Lead
// Assigned"), but a few carry content a user typed themselves that isn't
// safe to surface there — currently just chat messages. Overridden here
// rather than in renderNotification() since in-app/email are authenticated
// surfaces where the full preview is fine (and already shown there).
const PUSH_BODY_OVERRIDE: Partial<Record<string, Record<"en" | "ar", string>>> = {
  "message.received": {
    en: "Open AutoFlow to read it.",
    ar: "افتح AutoFlow للاطلاع عليها.",
  },
};

/**
 * Web Push delivery for the typed in-app notification system. Fans out to
 * every device the user has enabled (desktop, phone, installed PWA can all
 * be registered at once — see convex/pushSubscriptions.ts). Reuses the same
 * bilingual copy as email/WhatsApp (lib/notifications/render.ts) so wording
 * never drifts between channels.
 */
export const sendNotificationPush = internalAction({
  args: {
    orgId: v.id("organizations"),
    userId: v.id("users"),
    locale: v.union(v.literal("en"), v.literal("ar")),
    type: v.string(),
    data: v.any(),
    link: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const status = await rateLimiter.limit(ctx, "notificationPush");
    if (!status.ok) {
      // Silently drop, same rationale as sendNotificationEmail: this runs
      // from a scheduled action with no caller to surface the error to, and
      // the in-app notification (already inserted by dispatch()) remains
      // the source of truth regardless.
      return { success: false, error: "rate_limited" };
    }

    const env = getValidatedEnv();
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
      return { success: false, error: "vapid_not_configured" };
    }

    const subscriptions = await ctx.runQuery(internal.pushSubscriptions.listEnabledForUser, {
      orgId: args.orgId,
      userId: args.userId,
    });
    if (subscriptions.length === 0) return { success: true, sent: 0 };

    webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);

    const { title, message } = renderNotification(args.locale, args.type, args.data);
    const body = PUSH_BODY_OVERRIDE[args.type]?.[args.locale] ?? (message || title);
    const payload = JSON.stringify({
      title,
      body,
      link: args.link ?? "/",
      tag: args.type,
    });

    let sent = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
        sent++;
      } catch (error) {
        failed++;
        const statusCode = (error as { statusCode?: number }).statusCode;
        errors.push(statusCode ? `HTTP ${statusCode}` : String(error));
        if (statusCode === 404 || statusCode === 410) {
          await ctx.runMutation(internal.pushSubscriptions.removeByEndpoint, { endpoint: sub.endpoint });
        }
      }
    }

    const result = { success: failed === 0, sent, failed };
    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "notification-push",
      status: result.success ? "success" : "error",
      summary: `${args.type} -> user ${args.userId} (${sent} sent, ${failed} failed)`,
      error: errors.length > 0 ? errors.join(", ") : undefined,
    });

    return result;
  },
});
