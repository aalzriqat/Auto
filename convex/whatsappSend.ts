"use node";

import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { rateLimiter } from "./rateLimit";
import { renderNotification } from "../lib/notifications/render";

const WHATSAPP_GRAPH_VERSION = "v22.0";

// Pre-approved WhatsApp message templates used to deliver notifications
// outside the 24h customer-service window — free-form `text` messages (the
// previous approach) are rejected by Meta unless the recipient messaged the
// business number in the last 24h, which defeats the point of a proactive
// notification system. One generic template per locale (title + message as
// two body variables) covers all ~60 notification types in
// lib/i18n/domains/notifications — a template per type isn't practical.
//
// EN and AR are two *separate* template names, not one name with two
// language variants: Meta requires every language under the same template
// name to share one category, and its per-language content classifier
// auto-assigned AR to MARKETING (despite neutral, non-promotional wording —
// tried three rewordings) while EN got UTILITY. Splitting the names let each
// be reviewed independently instead of EN's UTILITY blocking AR's submission
// outright. Cost/behavior differs accordingly: AR sends bill at MARKETING
// rates (~6-15x UTILITY) and are subject to Meta's opt-out/quality-rating
// rules for marketing messages — worth periodically retrying AR as UTILITY
// if message wording changes enough to shift the classifier.
const WHATSAPP_TEMPLATE_NAME: Record<"en" | "ar", string> = {
  en: "autoflow_notification",
  ar: "autoflow_notification_ar",
};

// WhatsApp template language codes, distinct from AutoFlow's own locale
// strings.
const WHATSAPP_TEMPLATE_LANGUAGE: Record<"en" | "ar", string> = {
  en: "en_US",
  ar: "ar",
};

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
      // WhatsApp template parameters can't contain newlines (HTTP 400: "Param
      // text cannot have new-line/tab characters") — the line break between
      // title and message has to live in the approved template's static body
      // text instead ("*{{1}}*\n{{2}}"), so this sends two separate
      // parameters rather than one pre-joined string. The body parameter
      // also can't be empty, so types with no message body (just a title)
      // get a generic per-locale fallback line.
      const fallbackMessage = args.locale === "ar" ? "افتح AutoFlow للتفاصيل" : "Open AutoFlow for details.";

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
              type: "template",
              template: {
                name: WHATSAPP_TEMPLATE_NAME[args.locale],
                language: { code: WHATSAPP_TEMPLATE_LANGUAGE[args.locale] },
                components: [
                  {
                    type: "body",
                    parameters: [
                      { type: "text", text: title },
                      { type: "text", text: message || fallbackMessage },
                    ],
                  },
                ],
              },
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
