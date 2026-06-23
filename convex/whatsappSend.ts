"use node";

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { rateLimiter } from "./rateLimit";
import { renderNotification } from "../lib/notifications/render";

const WHATSAPP_GRAPH_VERSION = "v22.0";

/**
 * WhatsApp delivery for the typed in-app notification system. Reuses the
 * per-org Meta Cloud API credentials already stored in orgSettings
 * (whatsappPhoneNumberId/whatsappApiToken) — previously unused dead fields.
 * Quietly no-ops (logged, not thrown) when the org hasn't configured
 * WhatsApp, since this runs from a scheduled action with no caller to
 * surface an error to; the in-app notification is the source of truth.
 */
export const sendNotificationWhatsapp = internalAction({
  args: {
    orgId: v.id("organizations"),
    toPhone: v.string(),
    locale: v.union(v.literal("en"), v.literal("ar")),
    type: v.string(),
    data: v.any(),
  },
  handler: async (ctx, args) => {
    const status = await rateLimiter.limit(ctx, "notificationWhatsapp");
    if (!status.ok) {
      return { success: false, error: "rate_limited" };
    }

    const orgSettings = await ctx.runQuery(internal.whatsapp.getSettingsByOrg, {
      orgId: args.orgId,
    });
    const phoneNumberId = orgSettings?.whatsappPhoneNumberId;
    const apiToken = orgSettings?.whatsappApiToken;

    let result: { success: boolean; error?: string };

    if (!phoneNumberId || !apiToken) {
      result = { success: false, error: "whatsapp_not_configured" };
    } else {
      const { title, message } = renderNotification(args.locale, args.type, args.data);
      const text = message ? `*${title}*\n${message}` : title;

      try {
        const res = await fetch(
          `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${phoneNumberId}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to: args.toPhone,
              type: "text",
              text: { body: text },
            }),
          }
        );

        if (res.ok) {
          result = { success: true };
        } else {
          const errBody = await res.text();
          result = { success: false, error: `HTTP ${res.status}: ${errBody.slice(0, 300)}` };
        }
      } catch (error) {
        result = { success: false, error: String(error) };
      }
    }

    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "notification-whatsapp",
      status: result.success ? "success" : "error",
      summary: `${args.type} -> ${args.toPhone}`,
      error: result.error,
    });

    return result;
  },
});
