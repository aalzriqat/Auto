import { ConvexError } from "convex/values";
import { httpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { Webhook } from "svix";
import { Id } from "./_generated/dataModel";
import { getValidatedEnv } from "./utils/env";
import { verifyPaymentWebhook } from "./utils/paymentWebhook";
import { rateLimiter } from "./rateLimit";
import { normalizedWebsiteHost } from "./websiteConfig";
import { isLikelyBot } from "./utils/userAgent";

const http = httpRouter();
const WEBHOOK_RAW_PAYLOAD_MAX_CHARS = 700_000;
const WEBHOOK_PAYLOAD_PREVIEW_CHARS = 16_384;

function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown"
  );
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
    },
  });
}

function webhookProcessingFailedResponse(): Response {
  return new Response("Webhook processing failed", { status: 500 });
}

/** Shared "429 if this key is over the webhook rate limit" check — every inbound webhook route below applies it with its own key (org id, client IP, or a fixed platform key). */
async function enforceWebhookRateLimit(ctx: ActionCtx, key: string): Promise<Response | null> {
  const limitStatus = await rateLimiter.limit(ctx, "webhook", { key });
  return limitStatus.ok ? null : new Response("Too many requests", { status: 429 });
}

/** Parses + validates a Meta subscription-verification GET request's `hub.mode`/`hub.verify_token`/`hub.challenge` query params — shared by `/whatsapp-webhook` and `/marketplace-whatsapp-webhook`'s GET handlers. Null means malformed (missing param or `hub.mode` isn't "subscribe"); the caller still has to check `token` against its own secret. */
function parseHubChallengeParams(url: URL): { token: string; challenge: string } | null {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode !== "subscribe" || !token || !challenge) return null;
  return { token, challenge };
}

type VerifiedWebhookSource =
  | "clerk"
  | "whatsapp"
  | "resend"
  | "instagram"
  | "facebook"
  | "marketplace-whatsapp";

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type WebhookClaim = {
  logId: Id<"webhookLogs">;
  claimedAt?: number;
  disposition: "process" | "skip_processed" | "skip_in_flight";
};

/**
 * Claims a verified provider delivery in the durable webhook inbox: exactly
 * one row per (source, eventId). Callers must honor the returned disposition —
 * skip_processed ⇒ ack with 200 without reprocessing, skip_in_flight ⇒ respond
 * non-2xx so the provider redelivers later — and, when told to process,
 * complete the same row via completeWebhookDelivery.
 */
async function claimWebhookDelivery(
  ctx: ActionCtx,
  args: {
    source: VerifiedWebhookSource;
    summary: string;
    rawPayload: string;
    eventId?: string;
  },
): Promise<WebhookClaim> {
  const payloadSha256 = await sha256Hex(args.rawPayload);
  const payloadTruncated = args.rawPayload.length > WEBHOOK_RAW_PAYLOAD_MAX_CHARS;
  const deliveryLog = {
    source: args.source,
    summary: args.summary,
    eventId: args.eventId ?? payloadSha256,
    payloadSha256,
    payloadPreview: args.rawPayload.slice(0, WEBHOOK_PAYLOAD_PREVIEW_CHARS),
    payloadTruncated,
  };

  return await ctx.runMutation(
    internal.adminSystem.webhookInboxIntake,
    payloadTruncated
      ? deliveryLog
      : { ...deliveryLog, rawPayload: args.rawPayload },
  );
}

async function completeWebhookDelivery(
  ctx: ActionCtx,
  claim: WebhookClaim,
  outcome: "success" | "error",
  error?: string,
): Promise<void> {
  if (claim.claimedAt === undefined) {
    throw new Error("Cannot complete an unclaimed webhook delivery.");
  }
  await ctx.runMutation(internal.adminSystem.webhookInboxComplete, {
    logId: claim.logId,
    claimedAt: claim.claimedAt,
    outcome,
    ...(error !== undefined ? { error } : {}),
  });
}

/** 409 tells the provider "duplicate delivery is in flight — redeliver later". */
function webhookInFlightResponse(): Response {
  return new Response("Duplicate delivery already in flight", { status: 409 });
}

/**
 * Shared completion for Meta batch handlers (Instagram/Facebook): on any
 * rate-limited or failed entry the delivery is left retryable — Meta
 * redelivers on non-2xx and the reclaim path reprocesses it (per-event dedup
 * downstream makes the partial work safe to repeat).
 */
async function completeBatchWebhookDelivery(
  ctx: ActionCtx,
  claim: WebhookClaim,
  outcome: { anyRateLimited: boolean; anyProcessingFailed: boolean },
): Promise<Response> {
  if (outcome.anyRateLimited || outcome.anyProcessingFailed) {
    await completeWebhookDelivery(
      ctx,
      claim,
      "error",
      outcome.anyRateLimited
        ? "Rate limited — batch partially deferred"
        : "One or more entries failed",
    );
    return outcome.anyRateLimited
      ? new Response("Too many requests", { status: 429 })
      : webhookProcessingFailedResponse();
  }

  await completeWebhookDelivery(ctx, claim, "success");
  return new Response(null, { status: 200 });
}

function hasMatchingSecret(
  providedSecret: string | null,
  expectedSecret: string,
): boolean {
  if (!providedSecret || providedSecret.length !== expectedSecret.length)
    return false;

  let diff = 0;
  for (let i = 0; i < expectedSecret.length; i++) {
    diff |= expectedSecret.charCodeAt(i) ^ providedSecret.charCodeAt(i);
  }
  return diff === 0;
}

type FacebookSourceSurface = "post" | "reel" | "story" | "ad" | "unknown";

const META_TEXT_KEYS = [
  "text",
  "title",
  "description",
  "name",
  "caption",
  "url",
  "payload",
  "ref",
  "source",
  "type",
  "phone",
  "phone_number",
  "mobile",
  "number",
  "value",
  "label",
] as const;

const META_NESTED_TEXT_KEYS = [
  "attachments",
  "data",
  "quick_reply",
  "reply_to",
  "referral",
  "postback",
] as const;

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const records: Record<string, unknown>[] = [];
  for (const item of value) {
    const record = optionalRecord(item);
    if (record) records.push(record);
  }
  return records;
}

function optionalMetaId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function collectTextParts(value: unknown, parts: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectTextParts(item, parts);
    return parts;
  }
  if (!value || typeof value !== "object") return parts;
  const record = value as Record<string, unknown>;
  for (const key of META_TEXT_KEYS) {
    const text = optionalString(record[key]);
    if (text) parts.push(text);
  }
  for (const key of META_NESTED_TEXT_KEYS) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      for (const item of nested) collectTextParts(item, parts);
    } else if (nested && typeof nested === "object") {
      collectTextParts(nested, parts);
    }
  }
  const payload = record.payload;
  if (payload && typeof payload === "object") collectTextParts(payload, parts);
  return parts;
}

function facebookSurfaceFromPayload(value: unknown): FacebookSourceSurface {
  if (!value || typeof value !== "object") return "unknown";
  const text = collectTextParts(value).join(" ").toLowerCase();
  const record = value as Record<string, unknown>;
  // DM messaging events carry these under message.referral (or, for m.me
  // referral-link opens, referral directly) rather than at the top level —
  // mirrors the same nesting facebookMessageMediaId() already reads from.
  const message = optionalRecord(record.message);
  const referral = optionalRecord(record.referral) ?? optionalRecord(message?.referral);
  const field = (key: string) => optionalString(record[key]) ?? optionalString(referral?.[key]);
  if (field("reel_id") || text.includes("reel")) return "reel";
  if (field("story_id") || text.includes("story")) return "story";
  if (field("ad_id") || text.includes("ad")) return "ad";
  if (field("post_id") || field("video_id") || field("media_id")) return "post";
  return "unknown";
}

function facebookMediaIdFromFeedValue(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return (
    optionalString(record.post_id) ??
    optionalString(record.video_id) ??
    optionalString(record.reel_id) ??
    optionalString(record.media_id) ??
    optionalString(record.object_id)
  );
}

function metaMessageText(messagingEvent: unknown): string | undefined {
  if (!messagingEvent || typeof messagingEvent !== "object") return undefined;
  const event = messagingEvent as Record<string, unknown>;
  const message = event.message as Record<string, unknown> | undefined;
  const parts: string[] = [];
  collectTextParts(message, parts);
  collectTextParts(event.referral, parts);
  const combined = parts.join(" ").trim();
  return combined || undefined;
}

function facebookMessageMediaId(messagingEvent: unknown): string | undefined {
  if (!messagingEvent || typeof messagingEvent !== "object") return undefined;
  const event = messagingEvent as Record<string, unknown>;
  const message = event.message as Record<string, unknown> | undefined;
  const referral = (message?.referral ?? event.referral) as
    | Record<string, unknown>
    | undefined;
  return (
    optionalString(referral?.post_id) ??
    optionalString(referral?.video_id) ??
    optionalString(referral?.reel_id) ??
    optionalString(referral?.media_id) ??
    optionalString(referral?.object_id)
  );
}

function base64UrlDecode(input: string): Uint8Array {
  const padded = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Meta's "signed_request" format used by Instagram's deauthorize and data
// deletion callbacks: base64url(HMAC-SHA256 signature) + "." + base64url(JSON payload).
async function verifyMetaSignedRequest(
  signedRequest: string,
  appSecret: string,
): Promise<Record<string, unknown> | null> {
  const [encodedSig, encodedPayload] = signedRequest.split(".");
  if (!encodedSig || !encodedPayload) return null;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expectedSig = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(encodedPayload),
    ),
  );
  const actualSig = base64UrlDecode(encodedSig);

  if (expectedSig.length !== actualSig.length) return null;
  let diff = 0;
  for (let i = 0; i < expectedSig.length; i++)
    diff |= expectedSig[i] ^ actualSig[i];
  if (diff !== 0) return null;

  return JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload)));
}

// Verifies Meta's `X-Hub-Signature-256` header — a hex-encoded HMAC-SHA256 of
// the raw request body, keyed with the Meta App Secret — sent on every
// WhatsApp Cloud API webhook POST. This is the only thing that proves a
// webhook call actually came from Meta; the `orgId` query param and message
// body are otherwise fully attacker-controlled.
async function verifyHubSignature256(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expectedBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)),
  );
  const expectedHex = Array.from(expectedBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expectedHex.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i++)
    diff |= expectedHex.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

/**
 * Shared skeleton for a signed WhatsApp Cloud API webhook POST: verify the
 * signature, parse `entry[].changes[].value.messages[]` into caller-defined
 * message objects, dedupe/claim the delivery, dispatch each message (letting
 * the caller's `dispatch` decide what "skip this one" means for its own
 * route — throwing marks the whole batch for redelivery, returning quietly
 * does not), and complete the delivery. `/whatsapp-webhook` (per-org) and
 * `/marketplace-whatsapp-webhook` (platform-wide) both wrap this — same
 * envelope, different per-message shape and dispatch target.
 */
async function processMetaMessagingWebhook<T extends { messageId?: string }>(
  ctx: ActionCtx,
  args: {
    request: Request;
    appSecret: string;
    source: VerifiedWebhookSource;
    parseMessage: (message: Record<string, unknown>, contacts: Record<string, unknown>[]) => T;
    dispatch: (message: T) => Promise<void>;
  },
): Promise<Response> {
  const rawBody = await args.request.text();
  const signature = args.request.headers.get("x-hub-signature-256");
  if (!(await verifyHubSignature256(rawBody, signature, args.appSecret))) {
    return new Response("Invalid signature", { status: 401 });
  }

  let body: Record<string, unknown> | undefined;
  try {
    body = optionalRecord(JSON.parse(rawBody));
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const messages: T[] = [];
  let statusUpdateCount = 0;

  for (const entry of recordArray(body?.entry)) {
    for (const changeRecord of recordArray(entry.changes)) {
      const change = optionalRecord(changeRecord.value);
      const contacts = recordArray(change?.contacts);
      statusUpdateCount += recordArray(change?.statuses).length;

      for (const message of recordArray(change?.messages)) {
        messages.push(args.parseMessage(message, contacts));
      }
    }
  }

  const messageIds = messages
    .map((message) => message.messageId)
    .filter((messageId): messageId is string => typeof messageId === "string");
  const claim = await claimWebhookDelivery(ctx, {
    source: args.source,
    eventId: messageIds.length > 0 ? messageIds.join(":") : undefined,
    summary: messages.length > 0
      ? `Batch with ${messages.length} message(s)`
      : `Status update batch with ${statusUpdateCount} status update(s)`,
    rawPayload: rawBody,
  });
  if (claim.disposition === "skip_processed") return new Response(null, { status: 200 });
  if (claim.disposition === "skip_in_flight") return webhookInFlightResponse();

  if (messages.length === 0) {
    // Delivery receipts and status updates — acknowledge silently
    await completeWebhookDelivery(ctx, claim, "success");
    return new Response(null, { status: 200 });
  }

  let processingError: string | undefined;
  for (const message of messages) {
    try {
      await args.dispatch(message);
    } catch (err) {
      processingError = err instanceof Error ? err.message : String(err);
    }
  }

  if (processingError) {
    await completeWebhookDelivery(ctx, claim, "error", processingError);
    return webhookProcessingFailedResponse();
  }

  await completeWebhookDelivery(ctx, claim, "success");
  return new Response(null, { status: 200 });
}

http.route({
  path: "/load-test/health",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    try {
      const env = getValidatedEnv();
      if (!env.LOAD_TEST_SECRET) {
        return new Response("Not found", { status: 404 });
      }

      const providedSecret = request.headers.get("x-load-test-secret");
      if (!hasMatchingSecret(providedSecret, env.LOAD_TEST_SECRET)) {
        return new Response("Forbidden", { status: 403 });
      }

      return jsonResponse(
        {
          status: "ok",
          service: "AutoFlow Convex",
          timestamp: new Date().toISOString(),
        },
        200,
      );
    } catch (err) {
      console.error("Load test health check failed", err);
      return jsonResponse(
        {
          success: false,
          error: "An unexpected error occurred. Please try again later.",
        },
        500,
      );
    }
  }),
});

http.route({
  path: "/clerk-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const rateLimited = await enforceWebhookRateLimit(ctx, clientIp(request));
    if (rateLimited) return rateLimited;

    let webhookSecret: string;
    try {
      const env = getValidatedEnv();
      if (!env.CLERK_WEBHOOK_SECRET)
        throw new ConvexError("CLERK_WEBHOOK_SECRET not set");
      webhookSecret = env.CLERK_WEBHOOK_SECRET;
    } catch {
      return new Response("Webhook secret not set or invalid env", {
        status: 500,
      });
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
    const claim = await claimWebhookDelivery(ctx, {
      source: "clerk",
      eventId: svixId,
      summary: type,
      rawPayload: payload,
    });
    if (claim.disposition === "skip_processed") return new Response(null, { status: 200 });
    if (claim.disposition === "skip_in_flight") return webhookInFlightResponse();

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
      await completeWebhookDelivery(
        ctx,
        claim,
        "error",
        err instanceof Error ? err.message : String(err),
      );
      return webhookProcessingFailedResponse();
    }

    await completeWebhookDelivery(ctx, claim, "success");

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
    const rateLimited = await enforceWebhookRateLimit(ctx, clientIp(request));
    if (rateLimited) return rateLimited;

    let webhookSecret: string;
    let resendApiKey: string | undefined;
    try {
      const env = getValidatedEnv();
      if (!env.RESEND_WEBHOOK_SECRET)
        throw new ConvexError("RESEND_WEBHOOK_SECRET not set");
      webhookSecret = env.RESEND_WEBHOOK_SECRET;
      resendApiKey = env.RESEND_API_KEY;
    } catch {
      return new Response("Webhook secret not set or invalid env", {
        status: 500,
      });
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

    const claim = await claimWebhookDelivery(ctx, {
      source: "resend",
      eventId: svixId,
      summary: event.type,
      rawPayload: payload,
    });
    if (claim.disposition === "skip_processed") return new Response(null, { status: 200 });
    if (claim.disposition === "skip_in_flight") return webhookInFlightResponse();

    if (event.type !== "email.received") {
      // Nothing to process for other event types — acknowledged as done.
      await completeWebhookDelivery(ctx, claim, "success");
      return new Response(null, { status: 200 });
    }

    try {
      const { email_id, from, to, subject } = event.data;

      let bodyText: string | undefined;
      let bodyHtml: string | undefined;
      if (resendApiKey) {
        const contentRes = await fetch(
          `https://api.resend.com/emails/receiving/${email_id}`,
          {
            headers: { Authorization: `Bearer ${resendApiKey}` },
          },
        );
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
      await completeWebhookDelivery(
        ctx,
        claim,
        "error",
        err instanceof Error ? err.message : String(err),
      );
      return webhookProcessingFailedResponse();
    }

    await completeWebhookDelivery(ctx, claim, "success");

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
    const hub = parseHubChallengeParams(url);

    if (!orgId || !hub) {
      return new Response("Bad request", { status: 400 });
    }

    const rateLimited = await enforceWebhookRateLimit(ctx, orgId);
    if (rateLimited) return rateLimited;

    const settings = await ctx.runQuery(internal.whatsapp.getSettingsByOrg, {
      orgId,
    });
    if (
      !settings?.whatsappWebhookSecret ||
      settings.whatsappWebhookSecret !== hub.token
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    return new Response(hub.challenge, { status: 200 });
  }),
});

type WhatsAppMessage = {
  messageId?: string;
  senderPhone?: string;
  senderName?: string;
  messageText?: string;
};

function parseWhatsAppMessage(message: Record<string, unknown>, contacts: Record<string, unknown>[]): WhatsAppMessage {
  const senderPhone = optionalMetaId(message.from);
  const contact =
    contacts.find((candidate) => optionalMetaId(candidate.wa_id) === senderPhone) ??
    contacts[0];
  const profile = optionalRecord(contact?.profile);
  const textPayload = optionalRecord(message.text);

  return {
    messageId: optionalMetaId(message.id),
    senderPhone,
    senderName: optionalString(profile?.name),
    messageText: optionalString(message.type) === "text" ? optionalString(textPayload?.body) : undefined,
  };
}

http.route({
  path: "/whatsapp-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const orgId = url.searchParams.get("orgId") as Id<"organizations"> | null;
    if (!orgId) return new Response("Bad request", { status: 400 });

    const rateLimited = await enforceWebhookRateLimit(ctx, orgId);
    if (rateLimited) return rateLimited;

    let appSecret: string;
    try {
      const env = getValidatedEnv();
      if (!env.WHATSAPP_APP_SECRET)
        throw new ConvexError("WHATSAPP_APP_SECRET not set");
      appSecret = env.WHATSAPP_APP_SECRET;
    } catch {
      return new Response("Webhook secret not set or invalid env", {
        status: 500,
      });
    }

    return await processMetaMessagingWebhook<WhatsAppMessage>(ctx, {
      request,
      appSecret,
      source: "whatsapp",
      parseMessage: parseWhatsAppMessage,
      dispatch: async (message) => {
        if (!message.senderPhone) throw new Error("Message without sender phone");
        await ctx.runMutation(internal.whatsapp.handleIncomingMessage, {
          orgId,
          senderPhone: message.senderPhone,
          senderName: message.senderName,
          messageText: message.messageText,
        });
      },
    });
  }),
});

// ─── Marketplace WhatsApp intake webhook (Phase 64) ───────────────────────────
// A single AutoFlow-platform WhatsApp number for the dealer-network
// marketplace's guided listing flow — distinct from the per-org
// /whatsapp-webhook above (each org's own number, own secret, own customer
// inbox). No orgId query param: the sender's phone is resolved to a dealer
// org internally, via marketplaceDealerProfiles.whatsappNumber, inside
// marketplaceWhatsAppIntake.ts.
//   GET  https://<convex-site>/marketplace-whatsapp-webhook  (verification)
//   POST https://<convex-site>/marketplace-whatsapp-webhook  (incoming messages)

http.route({
  path: "/marketplace-whatsapp-webhook",
  method: "GET",
  handler: httpAction(async (_ctx, request) => {
    const url = new URL(request.url);
    const hub = parseHubChallengeParams(url);

    let env: ReturnType<typeof getValidatedEnv>;
    try {
      env = getValidatedEnv();
    } catch {
      return new Response("Webhook secret not set or invalid env", { status: 500 });
    }

    if (
      !hub ||
      !env.MARKETPLACE_WHATSAPP_WEBHOOK_VERIFY_TOKEN ||
      hub.token !== env.MARKETPLACE_WHATSAPP_WEBHOOK_VERIFY_TOKEN
    ) {
      return new Response("Forbidden", { status: 403 });
    }

    return new Response(hub.challenge, { status: 200 });
  }),
});

type MarketplaceWhatsAppMessage = {
  messageId?: string;
  senderPhone?: string;
  input?:
    | { kind: "text"; text: string }
    | { kind: "button"; buttonId: string }
    | { kind: "image"; mediaId: string };
};

function parseMarketplaceWhatsAppMessage(message: Record<string, unknown>): MarketplaceWhatsAppMessage {
  const senderPhone = optionalMetaId(message.from);
  const messageId = optionalMetaId(message.id);
  const type = optionalString(message.type);

  if (type === "text") {
    const text = optionalString(optionalRecord(message.text)?.body);
    return { messageId, senderPhone, input: text ? { kind: "text", text } : undefined };
  }
  if (type === "interactive") {
    const interactive = optionalRecord(message.interactive);
    const buttonReply = optionalRecord(interactive?.button_reply);
    const buttonId = optionalString(buttonReply?.id);
    return { messageId, senderPhone, input: buttonId ? { kind: "button", buttonId } : undefined };
  }
  if (type === "image") {
    const mediaId = optionalMetaId(optionalRecord(message.image)?.id);
    return { messageId, senderPhone, input: mediaId ? { kind: "image", mediaId } : undefined };
  }
  return { messageId, senderPhone, input: undefined };
}

http.route({
  path: "/marketplace-whatsapp-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    let env: ReturnType<typeof getValidatedEnv>;
    try {
      env = getValidatedEnv();
      if (!env.MARKETPLACE_WHATSAPP_APP_SECRET) throw new ConvexError("MARKETPLACE_WHATSAPP_APP_SECRET not set");
    } catch {
      return new Response("Webhook secret not set or invalid env", { status: 500 });
    }

    const rateLimited = await enforceWebhookRateLimit(ctx, "marketplace-whatsapp");
    if (rateLimited) return rateLimited;

    return await processMetaMessagingWebhook<MarketplaceWhatsAppMessage>(ctx, {
      request,
      appSecret: env.MARKETPLACE_WHATSAPP_APP_SECRET,
      source: "marketplace-whatsapp",
      parseMessage: (message) => parseMarketplaceWhatsAppMessage(message),
      dispatch: async (message) => {
        if (!message.senderPhone || !message.input) return;
        await ctx.runAction(internal.marketplaceWhatsAppIntake.handleIntakeMessage, {
          phone: message.senderPhone,
          input: message.input,
        });
      },
    });
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

    const stateRecord = await ctx.runMutation(
      internal.socialIntegrations.consumeOAuthState,
      { state },
    );
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
      const message = err instanceof Error ? err.message : String(err);
      const userMessage =
        "Instagram connection failed. Please try again later.";
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "instagram-oauth",
        status: "error",
        summary: "Token exchange failed",
        error: message,
      });
      return Response.redirect(
        `${settingsUrl}?connected=instagram&error=1&errorMessage=${encodeURIComponent(userMessage)}`,
        302,
      );
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
    if (!env.INSTAGRAM_APP_SECRET)
      return new Response("Not configured", { status: 500 });

    const form = await request.formData().catch(() => null);
    const signedRequest = form?.get("signed_request")?.toString();
    if (!signedRequest) return new Response("Bad request", { status: 400 });

    const payload = await verifyMetaSignedRequest(
      signedRequest,
      env.INSTAGRAM_APP_SECRET,
    );
    if (!payload?.user_id)
      return new Response("Invalid signature", { status: 400 });

    await ctx.runMutation(
      internal.socialIntegrations.disconnectByInstagramUserId,
      {
        instagramBusinessAccountId: String(payload.user_id),
      },
    );
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
    if (!env.INSTAGRAM_APP_SECRET)
      return new Response("Not configured", { status: 500 });

    const form = await request.formData().catch(() => null);
    const signedRequest = form?.get("signed_request")?.toString();
    if (!signedRequest) return new Response("Bad request", { status: 400 });

    const payload = await verifyMetaSignedRequest(
      signedRequest,
      env.INSTAGRAM_APP_SECRET,
    );
    if (!payload?.user_id)
      return new Response("Invalid signature", { status: 400 });

    // We only ever stored the dealer's own IG business account ID, access
    // token, and display name on orgSettings — clearing those is a complete
    // erasure, no async job needed.
    await ctx.runMutation(
      internal.socialIntegrations.disconnectByInstagramUserId,
      {
        instagramBusinessAccountId: String(payload.user_id),
      },
    );

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
      { status: 200, headers: { "Content-Type": "application/json" } },
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
    if (
      !env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN ||
      env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN !== token
    ) {
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
      if (!env.INSTAGRAM_APP_SECRET)
        throw new ConvexError("INSTAGRAM_APP_SECRET not set");
      appSecret = env.INSTAGRAM_APP_SECRET;
    } catch {
      return new Response("Webhook secret not set or invalid env", {
        status: 500,
      });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    if (!(await verifyHubSignature256(rawBody, signature, appSecret))) {
      return new Response("Invalid signature", { status: 401 });
    }

    let body: Record<string, unknown> | undefined;
    try {
      body = optionalRecord(JSON.parse(rawBody));
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // Meta batches multiple accounts' events into entry[], and multiple
    // comments/DMs for one account into changes[]/messaging[], when volume is
    // high. Processing only [0] of each would silently drop the rest of a
    // burst — so we iterate everything in the payload.
    const entries = recordArray(body?.entry);
    const claim = await claimWebhookDelivery(ctx, {
      source: "instagram",
      summary: `Batch with ${entries.length} entries`,
      rawPayload: rawBody,
    });
    if (claim.disposition === "skip_processed") return new Response(null, { status: 200 });
    if (claim.disposition === "skip_in_flight") return webhookInFlightResponse();
    let anyRateLimited = false;
    let anyProcessingFailed = false;

    for (const entry of entries) {
      const igAccountId = optionalMetaId(entry.id);
      if (!igAccountId) continue;

      const limitStatus = await rateLimiter.limit(ctx, "webhook", {
        key: igAccountId,
      });
      if (!limitStatus.ok) {
        // Skip this account's events for now but signal the batch as
        // rate-limited so we return 429 below — Meta will redeliver the
        // whole payload later. Safe to redeliver: handleIncomingInstagramEvent
        // dedupes by externalId, so events already processed in this pass
        // won't be reprocessed.
        anyRateLimited = true;
        continue;
      }

      const settings = await ctx.runQuery(
        internal.instagramEngagement.getSettingsByInstagramAccountId,
        {
          instagramBusinessAccountId: igAccountId,
        },
      );
      if (!settings) {
        // Unrecognized account (not connected to any org, or already
        // disconnected) — acknowledge so Meta doesn't retry forever.
        continue;
      }
      const orgId = settings.orgId;

      // Comments arrive via entry[].changes[] (field === "comments");
      // DMs arrive via entry[].messaging[] (Messenger-style payload shape).
      const commentChanges = recordArray(entry.changes).filter(
        (commentChange) => commentChange.field === "comments",
      );
      const messagingEvents = recordArray(entry.messaging);

      for (const commentChange of commentChanges) {
        const value = optionalRecord(commentChange.value);
        if (!value?.id) continue;
        const from = optionalRecord(value.from);
        const media = optionalRecord(value.media);

        const summary = `Comment from ${optionalString(from?.username) ?? optionalMetaId(from?.id)}`;
        try {
          const fromId = optionalMetaId(from?.id) ?? "";
          if (!fromId) continue;
          const isOwnAccount =
            fromId !== "" &&
            (fromId === settings.instagramBusinessAccountId ||
              fromId === settings.instagramWebhookAccountId);
          if (isOwnAccount) {
            // Our own auto/manual reply re-arriving as a webhook (Instagram fires a
            // "comments" event for replies we post too) — acknowledge without
            // reprocessing it as a new inbound comment, or we'd auto-reply to ourselves.
            continue;
          }
          const result = await ctx.runMutation(
            internal.instagramEngagement.handleIncomingInstagramEvent,
            {
              orgId,
              kind: "comment",
              externalId: String(value.id),
              senderInstagramId: fromId,
              senderUsername: optionalString(from?.username),
              text: optionalString(value.text),
              mediaId: optionalMetaId(media?.id),
            },
          );
          if (result?.shouldAutoReply && result.replyText) {
            if (result.smartReplyVisibility === "dm") {
              await ctx.runAction(
                internal.instagramEngagement.sendDirectMessage,
                {
                  orgId,
                  recipientInstagramId: fromId,
                  message: result.replyText,
                  eventId: result.eventId,
                  replySource: result.replySource ?? "canned",
                },
              );
            } else {
              await ctx.runAction(
                internal.instagramEngagement.sendCommentReply,
                {
                  orgId,
                  commentId: String(value.id),
                  message: result.replyText,
                  eventId: result.eventId,
                  replySource: result.replySource ?? "canned",
                },
              );
            }
          }
          if (result?.needsProfileEnrichment && result.customerId) {
            await ctx.runAction(
              internal.instagramEngagement.enrichCustomerProfile,
              {
                orgId,
                customerId: result.customerId,
                senderInstagramId: fromId,
              },
            );
          }
          // If no vehicle was matched via socialPosts, try the comment text
          // first then the post caption (covers posts not published through AutoFlow).
          const mediaId = optionalMetaId(media?.id);
          if (result && !result.vehicleId) {
            await ctx.runAction(
              internal.instagramEngagement.enrichEventVehicleFromPost,
              {
                orgId,
                externalId: String(value.id),
                mediaId,
                text: optionalString(value.text),
              },
            );
          }
          await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
            source: "instagram",
            status: "success",
            summary,
          });
        } catch (err) {
          anyProcessingFailed = true;
          await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
            source: "instagram",
            status: "error",
            summary,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      for (const messagingEvent of messagingEvents) {
        const message = optionalRecord(messagingEvent.message);
        if (!message || message.is_echo === true) {
          // Echoes, reactions, read receipts, etc. — skip silently.
          continue;
        }

        const sender = optionalRecord(messagingEvent.sender);
        const senderId = optionalMetaId(sender?.id) ?? "";
        if (!senderId) continue;
        const messageText = metaMessageText(messagingEvent);
        const summary = `DM from ${senderId}`;
        try {
          const result = await ctx.runMutation(
            internal.instagramEngagement.handleIncomingInstagramEvent,
            {
              orgId,
              kind: "dm",
              externalId: String(
                optionalMetaId(message.mid) ??
                  `${senderId}-${optionalMetaId(messagingEvent.timestamp) ?? "unknown"}`,
              ),
              senderInstagramId: senderId,
              text: messageText,
            },
          );
          if (result?.shouldAutoReply && result.replyText) {
            await ctx.runAction(
              internal.instagramEngagement.sendDirectMessage,
              {
                orgId,
                recipientInstagramId: senderId,
                message: result.replyText,
                eventId: result.eventId,
                replySource: result.replySource ?? "canned",
              },
            );
          }
          if (result?.needsProfileEnrichment && result.customerId) {
            await ctx.runAction(
              internal.instagramEngagement.enrichCustomerProfile,
              {
                orgId,
                customerId: result.customerId,
                senderInstagramId: senderId,
              },
            );
          }
          // Try to match a vehicle from the DM text (customer often mentions
          // the car they saw in a post, e.g. "I want the E-Bora 2020").
          if (result && !result.vehicleId && messageText) {
            await ctx.runAction(
              internal.instagramEngagement.enrichEventVehicleFromPost,
              {
                orgId,
                externalId: String(
                  optionalMetaId(message.mid) ??
                    `${senderId}-${optionalMetaId(messagingEvent.timestamp) ?? "unknown"}`,
                ),
                text: messageText,
              },
            );
          }
          await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
            source: "instagram",
            status: "success",
            summary,
          });
        } catch (err) {
          anyProcessingFailed = true;
          await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
            source: "instagram",
            status: "error",
            summary,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return await completeBatchWebhookDelivery(ctx, claim, { anyRateLimited, anyProcessingFailed });
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

    const stateRecord = await ctx.runMutation(
      internal.facebookIntegrations.consumeOAuthState,
      { state },
    );
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
      const message = err instanceof Error ? err.message : String(err);
      await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
        source: "facebook-oauth",
        status: "error",
        summary: "Token exchange failed",
        error: message,
      });
      return Response.redirect(
        `${settingsUrl}?connected=facebook&error=1&errorMessage=${encodeURIComponent(message)}`,
        302,
      );
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
    if (!env.FACEBOOK_APP_SECRET)
      return new Response("Not configured", { status: 500 });

    const form = await request.formData().catch(() => null);
    const signedRequest = form?.get("signed_request")?.toString();
    if (!signedRequest) return new Response("Bad request", { status: 400 });

    const payload = await verifyMetaSignedRequest(
      signedRequest,
      env.FACEBOOK_APP_SECRET,
    );
    if (!payload?.user_id)
      return new Response("Invalid signature", { status: 400 });

    await ctx.runMutation(
      internal.facebookIntegrations.disconnectByFacebookConnectedUserId,
      {
        facebookConnectedByUserId: String(payload.user_id),
      },
    );
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
    if (!env.FACEBOOK_APP_SECRET)
      return new Response("Not configured", { status: 500 });

    const form = await request.formData().catch(() => null);
    const signedRequest = form?.get("signed_request")?.toString();
    if (!signedRequest) return new Response("Bad request", { status: 400 });

    const payload = await verifyMetaSignedRequest(
      signedRequest,
      env.FACEBOOK_APP_SECRET,
    );
    if (!payload?.user_id)
      return new Response("Invalid signature", { status: 400 });

    // We only ever stored the dealer's own Page ID, access token, and
    // display name on orgSettings — clearing those is a complete erasure,
    // no async job needed.
    await ctx.runMutation(
      internal.facebookIntegrations.disconnectByFacebookConnectedUserId,
      {
        facebookConnectedByUserId: String(payload.user_id),
      },
    );

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
      { status: 200, headers: { "Content-Type": "application/json" } },
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
    if (
      !env.FACEBOOK_WEBHOOK_VERIFY_TOKEN ||
      env.FACEBOOK_WEBHOOK_VERIFY_TOKEN !== token
    ) {
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
      if (!env.FACEBOOK_APP_SECRET)
        throw new ConvexError("FACEBOOK_APP_SECRET not set");
      appSecret = env.FACEBOOK_APP_SECRET;
    } catch {
      return new Response("Webhook secret not set or invalid env", {
        status: 500,
      });
    }

    const rawBody = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    if (!(await verifyHubSignature256(rawBody, signature, appSecret))) {
      return new Response("Invalid signature", { status: 401 });
    }

    let body: Record<string, unknown> | undefined;
    try {
      body = optionalRecord(JSON.parse(rawBody));
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    // Meta batches multiple pages' events into entry[], and multiple
    // comments/DMs for one page into changes[]/messaging[], when volume is
    // high. Processing only [0] of each would silently drop the rest of a
    // burst — so we iterate everything in the payload (mirrors the
    // Instagram handler above).
    const entries = recordArray(body?.entry);
    const claim = await claimWebhookDelivery(ctx, {
      source: "facebook",
      summary: `Batch with ${entries.length} entries`,
      rawPayload: rawBody,
    });
    if (claim.disposition === "skip_processed") return new Response(null, { status: 200 });
    if (claim.disposition === "skip_in_flight") return webhookInFlightResponse();
    let anyRateLimited = false;
    let anyProcessingFailed = false;

    for (const entry of entries) {
      const pageId = optionalMetaId(entry.id);
      if (!pageId) continue;

      const limitStatus = await rateLimiter.limit(ctx, "webhook", {
        key: pageId,
      });
      if (!limitStatus.ok) {
        // Skip this page's events for now but signal the batch as
        // rate-limited so we return 429 below — Meta will redeliver the
        // whole payload later. Safe to redeliver: handleIncomingFacebookEvent
        // dedupes by externalId, so events already processed in this pass
        // won't be reprocessed.
        anyRateLimited = true;
        continue;
      }

      const settings = await ctx.runQuery(
        internal.facebookEngagement.getSettingsByFacebookPageId,
        {
          facebookPageId: pageId,
        },
      );
      if (!settings) {
        // Unrecognized Page (not connected to any org, or already
        // disconnected) — acknowledge so Meta doesn't retry forever.
        continue;
      }
      const orgId = settings.orgId;

      // Page comments arrive via entry[].changes[] (field === "feed",
      // value.item === "comment"); Messenger DMs arrive via entry[].messaging[]
      // (same shape Instagram DMs use — both ride the Messenger Platform).
      const feedChanges = recordArray(entry.changes).filter((feedChange) => {
        const value = optionalRecord(feedChange.value);
        return feedChange.field === "feed" && value?.item === "comment";
      });
      const messagingEvents = recordArray(entry.messaging);

      for (const feedChange of feedChanges) {
        const value = optionalRecord(feedChange.value);
        if (!value?.comment_id || value.verb !== "add") continue;
        const from = optionalRecord(value.from);

        const fromId = optionalMetaId(from?.id) ?? "";
        const summary = `Comment from ${optionalString(from?.name) ?? fromId}`;
        const fbPostId = facebookMediaIdFromFeedValue(value);
        const sourceSurface = facebookSurfaceFromPayload(value);
        try {
          const isOwnPage = fromId !== "" && fromId === settings.facebookPageId;
          if (isOwnPage) {
            // Our own auto/manual reply re-arriving as a webhook (replying to a
            // comment via the Graph API fires a fresh "feed" event for it too)
            // — acknowledge without reprocessing it as a new inbound comment,
            // the exact loop bug found and fixed on the Instagram side.
            continue;
          }

          const result = await ctx.runMutation(
            internal.facebookEngagement.handleIncomingFacebookEvent,
            {
              orgId,
              kind: "comment",
              externalId: String(value.comment_id),
              senderFacebookId: fromId,
              senderName: optionalString(from?.name),
              text: optionalString(value.message),
              mediaId: fbPostId,
              sourceSurface,
            },
          );
          if (result?.shouldAutoReply && result.replyText) {
            if (result.smartReplyVisibility === "dm") {
              await ctx.runAction(
                internal.facebookEngagement.sendDirectMessage,
                {
                  orgId,
                  recipientFacebookId: fromId,
                  message: result.replyText,
                  eventId: result.eventId,
                  replySource: result.replySource ?? "canned",
                },
              );
            } else {
              await ctx.runAction(
                internal.facebookEngagement.sendCommentReply,
                {
                  orgId,
                  commentId: String(value.comment_id),
                  message: result.replyText,
                  eventId: result.eventId,
                  replySource: result.replySource ?? "canned",
                },
              );
            }
          }
          // If no vehicle was matched via socialPosts, try extracting one from
          // the comment text first, then the post content (covers posts not
          // published through AutoFlow, including WhatsApp-link style posts
          // where the vehicle name lives in the attachment title).
          if (result && !result.vehicleId) {
            await ctx.runAction(
              internal.facebookEngagement.enrichEventVehicleFromPost,
              {
                orgId,
                externalId: String(value.comment_id),
                postId: fbPostId,
                text: optionalString(value.message),
                sourceSurface,
              },
            );
          }
          await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
            source: "facebook",
            status: "success",
            summary,
          });
        } catch (err) {
          anyProcessingFailed = true;
          await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
            source: "facebook",
            status: "error",
            summary,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      for (const messagingEvent of messagingEvents) {
        const message = optionalRecord(messagingEvent.message);
        if (!message || message.is_echo === true) {
          // Echoes, reactions, read receipts, etc. — skip silently.
          continue;
        }

        const sender = optionalRecord(messagingEvent.sender);
        const senderId = optionalMetaId(sender?.id) ?? "";
        if (!senderId) continue;
        const messageText = metaMessageText(messagingEvent);
        const mediaId = facebookMessageMediaId(messagingEvent);
        const sourceSurface = facebookSurfaceFromPayload(messagingEvent);
        const summary = `DM from ${senderId}`;
        try {
          const result = await ctx.runMutation(
            internal.facebookEngagement.handleIncomingFacebookEvent,
            {
              orgId,
              kind: "dm",
              externalId: String(
                optionalMetaId(message.mid) ??
                  `${senderId}-${optionalMetaId(messagingEvent.timestamp) ?? "unknown"}`,
              ),
              senderFacebookId: senderId,
              text: messageText,
              mediaId,
              sourceSurface,
            },
          );
          if (result?.shouldAutoReply && result.replyText) {
            await ctx.runAction(internal.facebookEngagement.sendDirectMessage, {
              orgId,
              recipientFacebookId: senderId,
              message: result.replyText,
              eventId: result.eventId,
              replySource: result.replySource ?? "canned",
            });
          }
          // Try to match a vehicle from the DM text (customer often mentions
          // the car they saw in a post, e.g. "I want the E-Bora 2020").
          if (result && !result.vehicleId && (messageText || mediaId)) {
            await ctx.runAction(
              internal.facebookEngagement.enrichEventVehicleFromPost,
              {
                orgId,
                externalId: String(
                  optionalMetaId(message.mid) ??
                    `${senderId}-${optionalMetaId(messagingEvent.timestamp) ?? "unknown"}`,
                ),
                postId: mediaId,
                text: messageText,
                sourceSurface,
              },
            );
          }
          await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
            source: "facebook",
            status: "success",
            summary,
          });
        } catch (err) {
          anyProcessingFailed = true;
          await ctx.runMutation(internal.adminSystem.logWebhookEvent, {
            source: "facebook",
            status: "error",
            summary,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return await completeBatchWebhookDelivery(ctx, claim, { anyRateLimited, anyProcessingFailed });
  }),
});

// ─── Payment provider webhooks ────────────────────────────────────────────────
// Provider-native settlement endpoint. The `provider` query param selects a
// verifier; each verifier must authenticate the raw provider payload and return
// normalized settlement money before any payment intent can be settled.

http.route({
  path: "/api/payment-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const url = new URL(request.url);
      const provider = (url.searchParams.get("provider") ?? "").toLowerCase();

      const rawBody = await request.text();
      const verification = await verifyPaymentWebhook(
        provider,
        rawBody,
        request.headers,
        getValidatedEnv(),
      );

      if (!verification.ok) {
        return new Response(JSON.stringify({ ok: false, error: verification.error }), {
          status: verification.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (verification.value.kind === "settled") {
        const settlement = verification.value;
        await ctx.runMutation(internal.paymentIntents.settleByExternalId, {
          provider: settlement.provider,
          externalId: settlement.externalId,
          amountMinor: settlement.amountMinor,
          currency: settlement.currency,
          providerSignatureVerifiedAt: settlement.signatureVerifiedAt,
          providerPayload: settlement.providerPayload,
          ...(settlement.providerEventId ? { providerEventId: settlement.providerEventId } : {}),
          ...(settlement.providerEventType ? { providerEventType: settlement.providerEventType } : {}),
          ...(settlement.providerAccountId ? { providerAccountId: settlement.providerAccountId } : {}),
        });
      }

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("[payment-webhook] error:", err);
      return new Response(JSON.stringify({ ok: false }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

// ─── Public site-visitor analytics beacon ──────────────────────────────────
// Deliberately a plain httpAction (not a mutation/action called via the
// reactive client) because only the raw Request here exposes the caller's
// real IP (x-forwarded-for) and User-Agent header — see convex/siteVisitors.ts
// for why the reactive client protocol can't provide either. Always responds
// 204 (even on validation/rate-limit failure) since sendBeacon never surfaces
// errors to the page — there's nothing useful a non-204 status could do here.

const SITE_EVENTS_CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function siteEventsNoContent(): Response {
  return new Response(null, { status: 204, headers: SITE_EVENTS_CORS_HEADERS });
}

type SiteEventBody = {
  host: string;
  visitorId: string;
  sessionId: string;
  type: "page_view" | "link_click";
  path: string;
  linkTarget?: string;
  linkLabel?: string;
  referrerUrl?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  clickIdType?: string;
  clickIdValue?: string;
  language?: string;
  timezone?: string;
  screenWidth?: number;
  screenHeight?: number;
  viewportWidth?: number;
  viewportHeight?: number;
};

function optionalStringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalNumberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseSiteEventBody(raw: unknown): SiteEventBody | null {
  if (!raw || typeof raw !== "object") return null;
  const body = raw as Record<string, unknown>;
  const host = optionalStringField(body.host);
  const visitorId = optionalStringField(body.visitorId);
  const sessionId = optionalStringField(body.sessionId);
  const path = optionalStringField(body.path);
  const type = body.type === "page_view" || body.type === "link_click" ? body.type : undefined;
  if (!host || !visitorId || !sessionId || !path || !type) return null;

  return {
    host,
    visitorId,
    sessionId,
    type,
    path,
    linkTarget: optionalStringField(body.linkTarget),
    linkLabel: optionalStringField(body.linkLabel),
    referrerUrl: optionalStringField(body.referrerUrl),
    utmSource: optionalStringField(body.utmSource),
    utmMedium: optionalStringField(body.utmMedium),
    utmCampaign: optionalStringField(body.utmCampaign),
    utmTerm: optionalStringField(body.utmTerm),
    utmContent: optionalStringField(body.utmContent),
    clickIdType: optionalStringField(body.clickIdType),
    clickIdValue: optionalStringField(body.clickIdValue),
    language: optionalStringField(body.language),
    timezone: optionalStringField(body.timezone),
    screenWidth: optionalNumberField(body.screenWidth),
    screenHeight: optionalNumberField(body.screenHeight),
    viewportWidth: optionalNumberField(body.viewportWidth),
    viewportHeight: optionalNumberField(body.viewportHeight),
  };
}

function referrerHostFrom(referrerUrl: string | undefined): string | undefined {
  if (!referrerUrl) return undefined;
  try {
    return new URL(referrerUrl).hostname;
  } catch {
    return undefined;
  }
}

http.route({
  path: "/site-events",
  method: "OPTIONS",
  handler: httpAction(async () => siteEventsNoContent()),
});

http.route({
  path: "/site-events",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    try {
      const userAgent = request.headers.get("user-agent") ?? undefined;
      if (isLikelyBot(userAgent)) return siteEventsNoContent();

      const raw = await request.text();
      if (raw.length > 8192) return siteEventsNoContent();

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        return siteEventsNoContent();
      }

      const body = parseSiteEventBody(parsedJson);
      if (!body) return siteEventsNoContent();

      const requestHost = normalizedWebsiteHost(body.host);
      const env = getValidatedEnv();
      const appHost = normalizedWebsiteHost(new URL(env.NEXT_PUBLIC_APP_URL).host);

      let orgId: Id<"organizations"> | undefined;
      if (requestHost !== appHost) {
        const resolved = await ctx.runQuery(internal.websites.resolveOrgIdForHost, { host: requestHost });
        if (!resolved) return siteEventsNoContent(); // unrecognized host — anti-pollution guard
        orgId = resolved;
      }

      const hostLimit = await rateLimiter.limit(ctx, "websiteEventHost", { key: requestHost });
      if (!hostLimit.ok) return siteEventsNoContent();
      const visitorLimit = await rateLimiter.limit(ctx, "websiteEventVisitor", { key: body.visitorId });
      if (!visitorLimit.ok) return siteEventsNoContent();

      const { isNewVisitor, siteVisitorId } = await ctx.runMutation(internal.siteVisitors.recordEvent, {
        orgId,
        host: requestHost,
        visitorId: body.visitorId,
        sessionId: body.sessionId,
        type: body.type,
        path: body.path,
        linkTarget: body.linkTarget,
        linkLabel: body.linkLabel,
        referrerHost: referrerHostFrom(body.referrerUrl),
        referrerUrl: body.referrerUrl,
        utmSource: body.utmSource,
        utmMedium: body.utmMedium,
        utmCampaign: body.utmCampaign,
        utmTerm: body.utmTerm,
        utmContent: body.utmContent,
        clickIdType: body.clickIdType,
        clickIdValue: body.clickIdValue,
        userAgent,
        language: body.language,
        timezone: body.timezone,
        screenWidth: body.screenWidth,
        screenHeight: body.screenHeight,
        viewportWidth: body.viewportWidth,
        viewportHeight: body.viewportHeight,
      });

      if (isNewVisitor) {
        const ip = clientIp(request);
        if (ip !== "unknown") {
          await ctx.scheduler.runAfter(0, internal.siteVisitors.enrichVisitorGeo, { siteVisitorId, ip });
        }
      }

      return siteEventsNoContent();
    } catch (err) {
      console.error("[site-events] error:", err);
      return siteEventsNoContent();
    }
  }),
});

export default http;
