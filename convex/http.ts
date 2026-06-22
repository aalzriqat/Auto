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

function base64UrlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Meta's "signed_request" format used by Instagram's deauthorize and data
// deletion callbacks: base64url(HMAC-SHA256 signature) + "." + base64url(JSON payload).
async function verifyMetaSignedRequest(signedRequest: string, appSecret: string): Promise<Record<string, unknown> | null> {
  const [encodedSig, encodedPayload] = signedRequest.split(".");
  if (!encodedSig || !encodedPayload) return null;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expectedSig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encodedPayload)));
  const actualSig = base64UrlDecode(encodedSig);

  if (expectedSig.length !== actualSig.length) return null;
  let diff = 0;
  for (let i = 0; i < expectedSig.length; i++) diff |= expectedSig[i] ^ actualSig[i];
  if (diff !== 0) return null;

  return JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload)));
}

// Verifies Meta's `X-Hub-Signature-256` header — a hex-encoded HMAC-SHA256 of
// the raw request body, keyed with the Meta App Secret — sent on every
// WhatsApp Cloud API webhook POST. This is the only thing that proves a
// webhook call actually came from Meta; the `orgId` query param and message
// body are otherwise fully attacker-controlled.
async function verifyHubSignature256(rawBody: string, signatureHeader: string | null, appSecret: string): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expectedBytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  const expectedHex = Array.from(expectedBytes).map((b) => b.toString(16).padStart(2, "0")).join("");

  if (expectedHex.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i++) diff |= expectedHex.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
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

    let appSecret: string;
    try {
      const env = getValidatedEnv();
      if (!env.WHATSAPP_APP_SECRET) throw new ConvexError("WHATSAPP_APP_SECRET not set");
      appSecret = env.WHATSAPP_APP_SECRET;
    } catch {
      return new Response("Webhook secret not set or invalid env", { status: 500 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    if (!(await verifyHubSignature256(rawBody, signature, appSecret))) {
      return new Response("Invalid signature", { status: 401 });
    }

    let body: any;
    try {
      body = JSON.parse(rawBody);
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

// ─── Instagram OAuth callback ─────────────────────────────────────────────────
// Registered as a Valid OAuth Redirect URI in the Meta App's
// "Facebook Login for Business" settings:
//   https://<convex-site>/instagram-oauth-callback

http.route({
  path: "/instagram-oauth-callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const oauthError = url.searchParams.get("error");

    const env = getValidatedEnv();
    const appUrl = (env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");

    if (oauthError || !code || !state) {
      return Response.redirect(`${appUrl}/?instagramConnectError=1`, 302);
    }

    const stateRecord = await ctx.runMutation(internal.socialIntegrations.consumeOAuthState, { state });
    if (!stateRecord) {
      return Response.redirect(`${appUrl}/?instagramConnectError=1`, 302);
    }

    const settingsUrl = `${appUrl}/${stateRecord.orgId}/settings/integrations`;

    try {
      await ctx.runAction(internal.socialIntegrations.exchangeCodeForToken, {
        orgId: stateRecord.orgId,
        code,
      });
    } catch (err) {
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "instagram-oauth",
        status: "error",
        summary: "Token exchange failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.redirect(`${settingsUrl}?connected=instagram&error=1`, 302);
    }

    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "instagram-oauth",
      status: "success",
      summary: `Connected for org ${stateRecord.orgId}`,
    });

    return Response.redirect(`${settingsUrl}?connected=instagram`, 302);
  }),
});

// ─── Instagram deauthorize + data deletion callbacks ──────────────────────────
// Required dashboard fields for every Instagram Login app (Instagram API
// product → "Set up Instagram business login"):
//   Deauthorize callback URL:    https://<convex-site>/instagram-deauthorize
//   Data Deletion Request URL:   https://<convex-site>/instagram-data-deletion
// Meta POSTs a form-encoded `signed_request` to both when a user revokes
// access or requests data deletion from inside Instagram's own settings.

http.route({
  path: "/instagram-deauthorize",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const env = getValidatedEnv();
    if (!env.INSTAGRAM_APP_SECRET) return new Response("Not configured", { status: 500 });

    const form = await request.formData().catch(() => null);
    const signedRequest = form?.get("signed_request")?.toString();
    if (!signedRequest) return new Response("Bad request", { status: 400 });

    const payload = await verifyMetaSignedRequest(signedRequest, env.INSTAGRAM_APP_SECRET);
    if (!payload?.user_id) return new Response("Invalid signature", { status: 400 });

    await ctx.runMutation(internal.socialIntegrations.disconnectByInstagramUserId, {
      instagramBusinessAccountId: String(payload.user_id),
    });
    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "instagram-oauth",
      status: "success",
      summary: `Deauthorized by Instagram user ${payload.user_id}`,
    });

    return new Response(null, { status: 200 });
  }),
});

http.route({
  path: "/instagram-data-deletion",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const env = getValidatedEnv();
    if (!env.INSTAGRAM_APP_SECRET) return new Response("Not configured", { status: 500 });

    const form = await request.formData().catch(() => null);
    const signedRequest = form?.get("signed_request")?.toString();
    if (!signedRequest) return new Response("Bad request", { status: 400 });

    const payload = await verifyMetaSignedRequest(signedRequest, env.INSTAGRAM_APP_SECRET);
    if (!payload?.user_id) return new Response("Invalid signature", { status: 400 });

    // We only ever stored the dealer's own IG business account ID, access
    // token, and display name on orgSettings — clearing those is a complete
    // erasure, no async job needed.
    await ctx.runMutation(internal.socialIntegrations.disconnectByInstagramUserId, {
      instagramBusinessAccountId: String(payload.user_id),
    });

    const confirmationCode = `${payload.user_id}-${Date.now()}`;
    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "instagram-oauth",
      status: "success",
      summary: `Data deletion requested by Instagram user ${payload.user_id}`,
    });

    const appUrl = (env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
    return new Response(
      JSON.stringify({
        url: `${appUrl}/data-deletion-status?id=${confirmationCode}`,
        confirmation_code: confirmationCode,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }),
});

// ─── Instagram comments + DMs webhook ──────────────────────────────────────────
// Meta allows only one webhook callback URL per App (unlike WhatsApp, which
// gets one per org via ?orgId=) — subscribe this single URL to the
// "comments" and "messages" fields on the Instagram object in the Meta
// dashboard's Webhooks product:
//   GET  https://<convex-site>/instagram-webhook  (verification)
//   POST https://<convex-site>/instagram-webhook  (comments + DMs)
// orgId is resolved per-event by reverse-looking-up the IG business account
// ID Meta includes in every payload against orgSettings.

http.route({
  path: "/instagram-webhook",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode !== "subscribe" || !token || !challenge) {
      return new Response("Bad request", { status: 400 });
    }

    const env = getValidatedEnv();
    if (!env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN || env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN !== token) {
      return new Response("Forbidden", { status: 403 });
    }

    return new Response(challenge, { status: 200 });
  }),
});

http.route({
  path: "/instagram-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let appSecret: string;
    try {
      const env = getValidatedEnv();
      if (!env.INSTAGRAM_APP_SECRET) throw new ConvexError("INSTAGRAM_APP_SECRET not set");
      appSecret = env.INSTAGRAM_APP_SECRET;
    } catch {
      return new Response("Webhook secret not set or invalid env", { status: 500 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    if (!(await verifyHubSignature256(rawBody, signature, appSecret))) {
      return new Response("Invalid signature", { status: 401 });
    }

    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const entry = body?.entry?.[0];
    const igAccountId: string | undefined = entry?.id;
    if (!igAccountId) return new Response(null, { status: 200 });

    const limitStatus = await rateLimiter.limit(ctx, "webhook", { key: igAccountId });
    if (!limitStatus.ok) {
      return new Response("Too many requests", { status: 429 });
    }

    const settings = await ctx.runQuery(internal.instagramEngagement.getSettingsByInstagramAccountId, {
      instagramBusinessAccountId: igAccountId,
    });
    if (!settings) {
      // Unrecognized account (not connected to any org, or already
      // disconnected) — acknowledge so Meta doesn't retry forever.
      return new Response(null, { status: 200 });
    }
    const orgId = settings.orgId;

    // Comments arrive via entry[].changes[] (field === "comments");
    // DMs arrive via entry[].messaging[] (Messenger-style payload shape).
    const commentChange = entry?.changes?.find((c: any) => c.field === "comments");
    const messagingEvent = entry?.messaging?.[0];

    let summary = "Unrecognized event";
    try {
      if (commentChange?.value?.id) {
        const value = commentChange.value;
        const fromId = String(value.from?.id ?? "");
        const isOwnAccount =
          fromId !== "" &&
          (fromId === settings.instagramBusinessAccountId || fromId === settings.instagramWebhookAccountId);
        if (isOwnAccount) {
          // Our own auto/manual reply re-arriving as a webhook (Instagram fires a
          // "comments" event for replies we post too) — acknowledge without
          // reprocessing it as a new inbound comment, or we'd auto-reply to ourselves.
          return new Response(null, { status: 200 });
        }
        const result = await ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
          orgId,
          kind: "comment",
          externalId: String(value.id),
          senderInstagramId: String(value.from?.id ?? ""),
          senderUsername: value.from?.username,
          text: value.text,
          mediaId: value.media?.id ? String(value.media.id) : undefined,
        });
        summary = `Comment from ${value.from?.username ?? value.from?.id}`;
        if (result?.shouldAutoReply && result.replyText) {
          await ctx.runAction(internal.instagramEngagement.sendCommentReply, {
            orgId,
            commentId: String(value.id),
            message: result.replyText,
          });
        }
        if (result?.needsProfileEnrichment && result.customerId) {
          await ctx.runAction(internal.instagramEngagement.enrichCustomerProfile, {
            orgId,
            customerId: result.customerId,
            senderInstagramId: String(value.from?.id ?? ""),
          });
        }
      } else if (messagingEvent?.message?.text && !messagingEvent.message.is_echo) {
        const senderId = String(messagingEvent.sender?.id ?? "");
        const result = await ctx.runMutation(internal.instagramEngagement.handleIncomingInstagramEvent, {
          orgId,
          kind: "dm",
          externalId: String(messagingEvent.message.mid ?? `${senderId}-${messagingEvent.timestamp}`),
          senderInstagramId: senderId,
          text: messagingEvent.message.text,
        });
        summary = `DM from ${senderId}`;
        if (result?.shouldAutoReply && result.replyText) {
          await ctx.runAction(internal.instagramEngagement.sendDirectMessage, {
            orgId,
            recipientInstagramId: senderId,
            message: result.replyText,
          });
        }
        if (result?.needsProfileEnrichment && result.customerId) {
          await ctx.runAction(internal.instagramEngagement.enrichCustomerProfile, {
            orgId,
            customerId: result.customerId,
            senderInstagramId: senderId,
          });
        }
      } else {
        // Echoes, reactions, read receipts, etc. — acknowledge silently.
        return new Response(null, { status: 200 });
      }
    } catch (err) {
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "instagram",
        status: "error",
        summary,
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response(null, { status: 200 });
    }

    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "instagram",
      status: "success",
      summary,
    });

    return new Response(null, { status: 200 });
  }),
});

// ─── Facebook OAuth callback ────────────────────────────────────────────────
// Registered as a Valid OAuth Redirect URI in the Meta App's
// "Facebook Login for Business" settings:
//   https://<convex-site>/facebook-oauth-callback

http.route({
  path: "/facebook-oauth-callback",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const oauthError = url.searchParams.get("error");

    const env = getValidatedEnv();
    const appUrl = (env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");

    if (oauthError || !code || !state) {
      return Response.redirect(`${appUrl}/?facebookConnectError=1`, 302);
    }

    const stateRecord = await ctx.runMutation(internal.facebookIntegrations.consumeOAuthState, { state });
    if (!stateRecord) {
      return Response.redirect(`${appUrl}/?facebookConnectError=1`, 302);
    }

    const settingsUrl = `${appUrl}/${stateRecord.orgId}/settings/integrations`;

    try {
      await ctx.runAction(internal.facebookIntegrations.exchangeCodeForToken, {
        orgId: stateRecord.orgId,
        code,
      });
    } catch (err) {
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "facebook-oauth",
        status: "error",
        summary: "Token exchange failed",
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.redirect(`${settingsUrl}?connected=facebook&error=1`, 302);
    }

    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "facebook-oauth",
      status: "success",
      summary: `Connected for org ${stateRecord.orgId}`,
    });

    return Response.redirect(`${settingsUrl}?connected=facebook`, 302);
  }),
});

// ─── Facebook deauthorize + data deletion callbacks ────────────────────────
// Required dashboard fields for every Facebook Login app:
//   Deauthorize callback URL:    https://<convex-site>/facebook-deauthorize
//   Data Deletion Request URL:   https://<convex-site>/facebook-data-deletion
// Meta POSTs a form-encoded `signed_request` to both when a user revokes
// access or requests data deletion. Reuses the same signed_request verifier
// Instagram's callbacks use — it's a generic Meta format, not platform-specific.

http.route({
  path: "/facebook-deauthorize",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const env = getValidatedEnv();
    if (!env.FACEBOOK_APP_SECRET) return new Response("Not configured", { status: 500 });

    const form = await request.formData().catch(() => null);
    const signedRequest = form?.get("signed_request")?.toString();
    if (!signedRequest) return new Response("Bad request", { status: 400 });

    const payload = await verifyMetaSignedRequest(signedRequest, env.FACEBOOK_APP_SECRET);
    if (!payload?.user_id) return new Response("Invalid signature", { status: 400 });

    await ctx.runMutation(internal.facebookIntegrations.disconnectByFacebookConnectedUserId, {
      facebookConnectedByUserId: String(payload.user_id),
    });
    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "facebook-oauth",
      status: "success",
      summary: `Deauthorized by Facebook user ${payload.user_id}`,
    });

    return new Response(null, { status: 200 });
  }),
});

http.route({
  path: "/facebook-data-deletion",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const env = getValidatedEnv();
    if (!env.FACEBOOK_APP_SECRET) return new Response("Not configured", { status: 500 });

    const form = await request.formData().catch(() => null);
    const signedRequest = form?.get("signed_request")?.toString();
    if (!signedRequest) return new Response("Bad request", { status: 400 });

    const payload = await verifyMetaSignedRequest(signedRequest, env.FACEBOOK_APP_SECRET);
    if (!payload?.user_id) return new Response("Invalid signature", { status: 400 });

    // We only ever stored the dealer's own Page ID, access token, and
    // display name on orgSettings — clearing those is a complete erasure,
    // no async job needed.
    await ctx.runMutation(internal.facebookIntegrations.disconnectByFacebookConnectedUserId, {
      facebookConnectedByUserId: String(payload.user_id),
    });

    const confirmationCode = `${payload.user_id}-${Date.now()}`;
    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "facebook-oauth",
      status: "success",
      summary: `Data deletion requested by Facebook user ${payload.user_id}`,
    });

    const appUrl = (env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
    return new Response(
      JSON.stringify({
        url: `${appUrl}/data-deletion-status?id=${confirmationCode}`,
        confirmation_code: confirmationCode,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }),
});

// ─── Facebook Page comments + Messenger DMs webhook ────────────────────────
// Single app-level callback URL, subscribed to the "feed" and "messages"
// fields on the Page object in the Meta dashboard's Webhooks product:
//   GET  https://<convex-site>/facebook-webhook  (verification)
//   POST https://<convex-site>/facebook-webhook  (comments + DMs)
// orgId is resolved per-event by reverse-looking-up the Page ID Meta
// includes in every payload (entry[].id) against orgSettings.

http.route({
  path: "/facebook-webhook",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode !== "subscribe" || !token || !challenge) {
      return new Response("Bad request", { status: 400 });
    }

    const env = getValidatedEnv();
    if (!env.FACEBOOK_WEBHOOK_VERIFY_TOKEN || env.FACEBOOK_WEBHOOK_VERIFY_TOKEN !== token) {
      return new Response("Forbidden", { status: 403 });
    }

    return new Response(challenge, { status: 200 });
  }),
});

http.route({
  path: "/facebook-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let appSecret: string;
    try {
      const env = getValidatedEnv();
      if (!env.FACEBOOK_APP_SECRET) throw new ConvexError("FACEBOOK_APP_SECRET not set");
      appSecret = env.FACEBOOK_APP_SECRET;
    } catch {
      return new Response("Webhook secret not set or invalid env", { status: 500 });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    if (!(await verifyHubSignature256(rawBody, signature, appSecret))) {
      return new Response("Invalid signature", { status: 401 });
    }

    let body: any;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const entry = body?.entry?.[0];
    const pageId: string | undefined = entry?.id;
    if (!pageId) return new Response(null, { status: 200 });

    const limitStatus = await rateLimiter.limit(ctx, "webhook", { key: pageId });
    if (!limitStatus.ok) {
      return new Response("Too many requests", { status: 429 });
    }

    const settings = await ctx.runQuery(internal.facebookEngagement.getSettingsByFacebookPageId, {
      facebookPageId: pageId,
    });
    if (!settings) {
      // Unrecognized Page (not connected to any org, or already
      // disconnected) — acknowledge so Meta doesn't retry forever.
      return new Response(null, { status: 200 });
    }
    const orgId = settings.orgId;

    // Page comments arrive via entry[].changes[] (field === "feed",
    // value.item === "comment"); Messenger DMs arrive via entry[].messaging[]
    // (same shape Instagram DMs use — both ride the Messenger Platform).
    const feedChange = entry?.changes?.find((c: any) => c.field === "feed" && c.value?.item === "comment");
    const messagingEvent = entry?.messaging?.[0];

    let summary = "Unrecognized event";
    try {
      if (feedChange?.value?.comment_id && feedChange.value.verb === "add") {
        const value = feedChange.value;
        const fromId = String(value.from?.id ?? "");
        const isOwnPage = fromId !== "" && fromId === settings.facebookPageId;
        if (isOwnPage) {
          // Our own auto/manual reply re-arriving as a webhook (replying to a
          // comment via the Graph API fires a fresh "feed" event for it too)
          // — acknowledge without reprocessing it as a new inbound comment,
          // the exact loop bug found and fixed on the Instagram side.
          return new Response(null, { status: 200 });
        }

        const result = await ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, {
          orgId,
          kind: "comment",
          externalId: String(value.comment_id),
          senderFacebookId: fromId,
          senderName: value.from?.name,
          text: value.message,
          mediaId: value.post_id ? String(value.post_id) : undefined,
        });
        summary = `Comment from ${value.from?.name ?? fromId}`;
        if (result?.shouldAutoReply && result.replyText) {
          await ctx.runAction(internal.facebookEngagement.sendCommentReply, {
            orgId,
            commentId: String(value.comment_id),
            message: result.replyText,
          });
        }
      } else if (messagingEvent?.message?.text && !messagingEvent.message.is_echo) {
        const senderId = String(messagingEvent.sender?.id ?? "");
        const result = await ctx.runMutation(internal.facebookEngagement.handleIncomingFacebookEvent, {
          orgId,
          kind: "dm",
          externalId: String(messagingEvent.message.mid ?? `${senderId}-${messagingEvent.timestamp}`),
          senderFacebookId: senderId,
          text: messagingEvent.message.text,
        });
        summary = `DM from ${senderId}`;
        if (result?.shouldAutoReply && result.replyText) {
          await ctx.runAction(internal.facebookEngagement.sendDirectMessage, {
            orgId,
            recipientFacebookId: senderId,
            message: result.replyText,
          });
        }
      } else {
        // Edits, removals, reactions, read receipts, etc. — acknowledge silently.
        return new Response(null, { status: 200 });
      }
    } catch (err) {
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "facebook",
        status: "error",
        summary,
        error: err instanceof Error ? err.message : String(err),
      });
      return new Response(null, { status: 200 });
    }

    await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
      source: "facebook",
      status: "success",
      summary,
    });

    return new Response(null, { status: 200 });
  }),
});

export default http;
