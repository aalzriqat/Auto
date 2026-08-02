"use node";

import { internalAction, type ActionCtx } from "./_generated/server";
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

type PushSubscription = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

/**
 * Pushes one payload to every subscription the user has enabled, tallying the
 * outcome instead of throwing on the first failure — one dead browser
 * subscription must not stop delivery to the user's other devices.
 *
 * A 404/410 from a push service means the subscription is permanently gone
 * (browser uninstalled, permission revoked), so it is pruned. Any other status
 * is transient or a server-side fault and the subscription is kept.
 *
 * Returned statuses are HTTP codes, never endpoints — an endpoint is a
 * per-device credential.
 */
async function deliverToSubscriptions(
  ctx: { runMutation: ActionCtx["runMutation"] },
  subscriptions: PushSubscription[],
  payload: string
): Promise<{ sent: number; failed: number; errors: string[] }> {
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

  return { sent, failed, errors };
}

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
    const status = await rateLimiter.limit(ctx, "notificationWebPush", { key: args.userId });
    if (!status.ok) {
      // Dropped, not failed: this runs from a scheduled action with no caller
      // to surface the error to, and the in-app notification (already inserted
      // by dispatch()) remains the source of truth. Logged all the same — an
      // unkeyed version of this bucket once throttled the whole deployment to
      // 20 pushes a minute and nothing said so.
      console.warn(
        `[pushSend] web push dropped by rate limit: user=${args.userId} type=${args.type} retryAfterMs=${status.retryAfter}`
      );
      return { success: false, error: "rate_limited" };
    }

    const env = getValidatedEnv();
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
      // A deployment-wide misconfiguration: every web push silently no-ops
      // until the VAPID keypair is set.
      console.error(
        `[pushSend] VAPID keypair not configured — web push disabled: user=${args.userId} type=${args.type}`
      );
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

    const { sent, failed, errors } = await deliverToSubscriptions(ctx, subscriptions, payload);
    const result = { success: failed === 0, sent, failed };

    if (failed > 0) {
      // The webhook log below is an admin-UI surface; this is the one that
      // reaches the Convex function logs, where an outage is actually
      // diagnosed. An all-failed send is greppable separately from a partial
      // one — it means this user received nothing at all. Endpoints are not
      // logged (they are per-device credentials), only counts and statuses.
      const kind = sent === 0 ? "every subscription failed" : "some subscriptions failed";
      console.error(
        `[pushSend] ${kind}: user=${args.userId} type=${args.type} ` +
          `subscriptions=${subscriptions.length} sent=${sent} failed=${failed} statuses=${errors.join(", ")}`
      );
    }

    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "notification-push",
      status: result.success ? "success" : "error",
      summary: `${args.type} -> user ${args.userId} (${sent} sent, ${failed} failed)`,
      error: errors.length > 0 ? errors.join(", ") : undefined,
    });

    return result;
  },
});
