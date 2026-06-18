import { ConvexError } from "convex/values";
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { Webhook } from "svix";
import { Id } from "./_generated/dataModel";
import { getValidatedEnv } from "./utils/env";
import { rateLimiter } from "./rateLimit";

const http = httpRouter();

function clientIp(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
}

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const limitStatus = await rateLimiter.limit(ctx, "webhook", { key: clientIp(request) });
    if (!limitStatus.ok) {
      return new Response("Too many requests", { status: 429 });
    }

    let webhookSecret: string;
    try {
      const env = getValidatedEnv();
      if (!env.CLERK_WEBHOOK_SECRET) throw new ConvexError("CLERK_WEBHOOK_SECRET not set");
      webhookSecret = env.CLERK_WEBHOOK_SECRET;
    } catch {
      return new Response("Webhook secret not set or invalid env", { status: 500 });
    }

    const svixId = request.headers.get("svix-id");
    const svixTimestamp = request.headers.get("svix-timestamp");
    const svixSignature = request.headers.get("svix-signature");

    if (!svixId || !svixTimestamp || !svixSignature) {
      return new Response("Missing svix headers", { status: 400 });
    }

    const payload = await request.text();
    const wh = new Webhook(webhookSecret);

    type ClerkWebhookEvent = { type: string; data: Record<string, unknown> };
    let event: ClerkWebhookEvent;
    try {
      event = wh.verify(payload, {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      }) as ClerkWebhookEvent;
    } catch {
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "clerk",
        status: "error",
        summary: "Signature verification failed",
      });
      return new Response("Invalid signature", { status: 400 });
    }

    const { type, data } = event;

    try {
      switch (type) {
        case "user.created":
        case "user.updated": {
          type ClerkUserData = {
            id: string;
            email_addresses?: Array<{ email_address: string }>;
            first_name?: string;
            last_name?: string;
            image_url?: string;
          };
          const d = data as ClerkUserData;
          const email = d.email_addresses?.[0]?.email_address ?? "";
          const name = [d.first_name, d.last_name].filter(Boolean).join(" ");
          const imageUrl = d.image_url ?? "";

          await ctx.runMutation(internal.users.updateOrCreateUser, {
            clerkId: d.id,
            email,
            name: name || undefined,
            imageUrl: imageUrl || undefined,
          });
          break;
        }
        case "user.deleted": {
          const d = data as { id?: string };
          if (d.id) {
            await ctx.runMutation(internal.users.deleteUser, {
              clerkId: d.id,
            });
          }
          break;
        }
        default:
          break;
      }
    } catch (err) {
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "clerk",
        status: "error",
        summary: type,
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response(null, { status: 200 });
    }

    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "clerk",
      status: "success",
      summary: type,
    });

    return new Response(null, { status: 200 });
  }),
});

// ─── Resend inbound email webhook (support@autoflowdealer.com) ────────────────
// Configured in the Resend dashboard: Webhooks → email.received →
//   https://<convex-site>/resend-inbound

http.route({
  path: "/resend-inbound",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const limitStatus = await rateLimiter.limit(ctx, "webhook", { key: clientIp(request) });
    if (!limitStatus.ok) {
      return new Response("Too many requests", { status: 429 });
    }

    let webhookSecret: string;
    let resendApiKey: string | undefined;
    try {
      const env = getValidatedEnv();
      if (!env.RESEND_WEBHOOK_SECRET) throw new ConvexError("RESEND_WEBHOOK_SECRET not set");
      webhookSecret = env.RESEND_WEBHOOK_SECRET;
      resendApiKey = env.RESEND_API_KEY;
    } catch {
      return new Response("Webhook secret not set or invalid env", { status: 500 });
    }

    const svixId = request.headers.get("svix-id");
    const svixTimestamp = request.headers.get("svix-timestamp");
    const svixSignature = request.headers.get("svix-signature");

    if (!svixId || !svixTimestamp || !svixSignature) {
      return new Response("Missing svix headers", { status: 400 });
    }

    const payload = await request.text();
    const wh = new Webhook(webhookSecret);

    type ResendWebhookEvent = {
      type: string;
      data: { email_id: string; from: string; to: string[]; subject: string };
    };
    let event: ResendWebhookEvent;
    try {
      event = wh.verify(payload, {
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": svixSignature,
      }) as ResendWebhookEvent;
    } catch {
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "resend",
        status: "error",
        summary: "Signature verification failed",
      });
      return new Response("Invalid signature", { status: 400 });
    }

    if (event.type !== "email.received") {
      return new Response(null, { status: 200 });
    }

    try {
      const { email_id, from, to, subject } = event.data;

      let bodyText: string | undefined;
      let bodyHtml: string | undefined;
      if (resendApiKey) {
        const contentRes = await fetch(`https://api.resend.com/emails/receiving/${email_id}`, {
          headers: { Authorization: `Bearer ${resendApiKey}` },
        });
        if (contentRes.ok) {
          const content = await contentRes.json();
          bodyText = content.text;
          bodyHtml = content.html;
        }
      }

      await ctx.runMutation(internal.support.recordInboundMessage, {
        fromEmail: from,
        toEmail: to?.[0] ?? "support@autoflowdealer.com",
        subject: subject || "(no subject)",
        bodyText,
        bodyHtml,
        resendEmailId: email_id,
      });
    } catch (err) {
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "resend",
        status: "error",
        summary: event.type,
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response(null, { status: 200 });
    }

    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "resend",
      status: "success",
      summary: event.type,
    });

    return new Response(null, { status: 200 });
  }),
});

// ─── WhatsApp Cloud API webhook ───────────────────────────────────────────────
// Register this URL in Meta Developer Portal:
//   GET  https://<convex-site>/whatsapp-webhook?orgId=<orgId>  (verification)
//   POST https://<convex-site>/whatsapp-webhook?orgId=<orgId>  (incoming messages)

http.route({
  path: "/whatsapp-webhook",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const orgId = url.searchParams.get("orgId") as Id<"organizations"> | null;
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (!orgId || mode !== "subscribe" || !token || !challenge) {
      return new Response("Bad request", { status: 400 });
    }

    const limitStatus = await rateLimiter.limit(ctx, "webhook", { key: orgId });
    if (!limitStatus.ok) {
      return new Response("Too many requests", { status: 429 });
    }

    const settings = await ctx.runQuery(internal.whatsapp.getSettingsByOrg, { orgId });
    if (!settings?.whatsappWebhookSecret || settings.whatsappWebhookSecret !== token) {
      return new Response("Forbidden", { status: 403 });
    }

    return new Response(challenge, { status: 200 });
  }),
});

http.route({
  path: "/whatsapp-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const orgId = url.searchParams.get("orgId") as Id<"organizations"> | null;
    if (!orgId) return new Response("Bad request", { status: 400 });

    const limitStatus = await rateLimiter.limit(ctx, "webhook", { key: orgId });
    if (!limitStatus.ok) {
      return new Response("Too many requests", { status: 429 });
    }

    let body: any;
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // Walk the WhatsApp Cloud API payload structure
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const message = change?.messages?.[0];

    if (!message) {
      // Delivery receipts and status updates — acknowledge silently
      return new Response(null, { status: 200 });
    }

    const senderPhone = message.from as string;
    const senderName: string | undefined =
      change?.contacts?.[0]?.profile?.name;
    const messageText: string | undefined =
      message.type === "text" ? message.text?.body : undefined;

    try {
      await ctx.runMutation(internal.whatsapp.handleIncomingMessage, {
        orgId,
        senderPhone,
        senderName,
        messageText,
      });
    } catch (err) {
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "whatsapp",
        status: "error",
        summary: `Message from ${senderPhone}`,
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response(null, { status: 200 });
    }

    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "whatsapp",
      status: "success",
      summary: `Message from ${senderPhone}`,
    });

    return new Response(null, { status: 200 });
  }),
});

export default http;
