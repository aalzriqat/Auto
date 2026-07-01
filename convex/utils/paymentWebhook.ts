import { scaleForCurrency, toMinorUnits } from "./money";

export type SupportedPaymentWebhookProvider = "stripe" | "tap";

export type PaymentWebhookEnv = {
  STRIPE_WEBHOOK_SECRET?: string;
  TAP_SECRET_API_KEY?: string;
};

export type VerifiedPaymentWebhook =
  | {
      kind: "settled";
      provider: SupportedPaymentWebhookProvider;
      externalId: string;
      amountMinor: number;
      currency: string;
      providerPayload: Record<string, unknown>;
      providerEventId?: string;
      providerEventType?: string;
      providerAccountId?: string;
      signatureVerifiedAt: number;
    }
  | {
      kind: "ignored";
      provider: SupportedPaymentWebhookProvider;
      providerEventId?: string;
      providerEventType?: string;
    };

export type PaymentWebhookVerificationResult =
  | { ok: true; value: VerifiedPaymentWebhook }
  | { ok: false; status: number; error: string };

const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const TAP_WEBHOOK_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let mismatch = ab.length === bb.length ? 0 : 1;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) mismatch |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return mismatch === 0;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return bytesToHex(new Uint8Array(digest));
}

function parseJsonBody(rawBody: string): Record<string, unknown> | null {
  try {
    return optionalRecord(JSON.parse(rawBody)) ?? null;
  } catch {
    return null;
  }
}

function parseStripeSignatureHeader(header: string | null): {
  timestamp: number;
  signatures: string[];
} | null {
  if (!header) return null;
  let timestamp: number | undefined;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const [rawKey, rawValue] = part.split("=", 2);
    const key = rawKey?.trim();
    const value = rawValue?.trim();
    if (!key || !value) continue;
    if (key === "t") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === "v1") {
      signatures.push(value);
    }
  }

  if (timestamp === undefined || signatures.length === 0) return null;
  return { timestamp, signatures };
}

async function verifyStripeWebhook(
  rawBody: string,
  headers: Headers,
  env: PaymentWebhookEnv,
  nowMs: number,
): Promise<PaymentWebhookVerificationResult> {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret || secret.length < 16) {
    return { ok: false, status: 503, error: "Stripe webhook is not configured." };
  }

  const parsedSignature = parseStripeSignatureHeader(headers.get("stripe-signature"));
  if (!parsedSignature) {
    return { ok: false, status: 401, error: "Missing or invalid Stripe signature." };
  }

  const ageSeconds = Math.abs(Math.floor(nowMs / 1000) - parsedSignature.timestamp);
  if (ageSeconds > STRIPE_SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, status: 401, error: "Stale Stripe webhook signature." };
  }

  const expected = await hmacSha256Hex(secret, `${parsedSignature.timestamp}.${rawBody}`);
  if (!parsedSignature.signatures.some((sig) => timingSafeEqual(sig, expected))) {
    return { ok: false, status: 401, error: "Invalid Stripe signature." };
  }

  const body = parseJsonBody(rawBody);
  if (!body) return { ok: false, status: 400, error: "Invalid JSON." };

  const eventType = optionalString(body.type);
  const eventId = optionalString(body.id);
  const eventAccountId = optionalString(body.account);
  const data = optionalRecord(body.data);
  const object = optionalRecord(data?.object);

  if (eventType === "checkout.session.completed") {
    if (!object) return { ok: false, status: 400, error: "Missing Stripe object." };
    const paymentStatus = optionalString(object.payment_status)?.toLowerCase();
    const status = optionalString(object.status)?.toLowerCase();
    if (paymentStatus !== "paid" && status !== "complete") {
      return { ok: true, value: { kind: "ignored", provider: "stripe", providerEventId: eventId, providerEventType: eventType } };
    }

    const externalId = optionalString(object.id);
    const amountMinor = optionalNumber(object.amount_total);
    const currency = optionalString(object.currency)?.toUpperCase();
    if (!externalId || amountMinor === undefined || !currency) {
      return { ok: false, status: 400, error: "Incomplete Stripe checkout session." };
    }

    return {
      ok: true,
      value: {
        kind: "settled",
        provider: "stripe",
        externalId,
        amountMinor,
        currency,
        providerPayload: body,
        ...(eventId ? { providerEventId: eventId } : {}),
        providerEventType: eventType,
        ...(eventAccountId ? { providerAccountId: eventAccountId } : {}),
        signatureVerifiedAt: nowMs,
      },
    };
  }

  if (eventType === "payment_intent.succeeded") {
    if (!object) return { ok: false, status: 400, error: "Missing Stripe object." };
    if (optionalString(object.status) !== "succeeded") {
      return { ok: true, value: { kind: "ignored", provider: "stripe", providerEventId: eventId, providerEventType: eventType } };
    }

    const externalId = optionalString(object.id);
    const amountMinor = optionalNumber(object.amount_received) ?? optionalNumber(object.amount);
    const currency = optionalString(object.currency)?.toUpperCase();
    if (!externalId || amountMinor === undefined || !currency) {
      return { ok: false, status: 400, error: "Incomplete Stripe payment intent." };
    }

    return {
      ok: true,
      value: {
        kind: "settled",
        provider: "stripe",
        externalId,
        amountMinor,
        currency,
        providerPayload: body,
        ...(eventId ? { providerEventId: eventId } : {}),
        providerEventType: eventType,
        ...(eventAccountId ? { providerAccountId: eventAccountId } : {}),
        signatureVerifiedAt: nowMs,
      },
    };
  }

  return {
    ok: true,
    value: { kind: "ignored", provider: "stripe", providerEventId: eventId, providerEventType: eventType },
  };
}

function formatTapAmount(amount: number, currency: string): string {
  return amount.toFixed(scaleForCurrency(currency));
}

function tapCreatedAtMillis(created: string): number | null {
  const asNumber = Number(created);
  if (!Number.isFinite(asNumber)) return null;
  return asNumber < 10_000_000_000 ? asNumber * 1000 : asNumber;
}

function buildTapHashString(body: Record<string, unknown>): string | null {
  const id = optionalString(body.id);
  const amountValue = optionalNumber(body.amount);
  const currency = optionalString(body.currency)?.toUpperCase();
  const reference = optionalRecord(body.reference);
  const transaction = optionalRecord(body.transaction);
  const status = optionalString(body.status);
  const created =
    optionalString(transaction?.created) ??
    (typeof transaction?.created === "number" ? String(transaction.created) : undefined) ??
    optionalString(body.created) ??
    (typeof body.created === "number" ? String(body.created) : undefined);

  if (!id || amountValue === undefined || !currency || !status || !created) return null;

  const gatewayReference = optionalString(reference?.gateway) ?? "";
  const paymentReference = optionalString(reference?.payment) ?? "";
  const amount = formatTapAmount(amountValue, currency);

  return [
    "x_id",
    id,
    "x_amount",
    amount,
    "x_currency",
    currency,
    "x_gateway_reference",
    gatewayReference,
    "x_payment_reference",
    paymentReference,
    "x_status",
    status,
    "x_created",
    created,
  ].join("");
}

async function verifyTapWebhook(
  rawBody: string,
  headers: Headers,
  env: PaymentWebhookEnv,
  nowMs: number,
): Promise<PaymentWebhookVerificationResult> {
  const secret = env.TAP_SECRET_API_KEY;
  if (!secret || secret.length < 16) {
    return { ok: false, status: 503, error: "Tap webhook is not configured." };
  }

  const postedHashString = headers.get("hashstring");
  if (!postedHashString) {
    return { ok: false, status: 401, error: "Missing Tap hashstring." };
  }

  const body = parseJsonBody(rawBody);
  if (!body) return { ok: false, status: 400, error: "Invalid JSON." };

  const toHash = buildTapHashString(body);
  if (!toHash) {
    return { ok: false, status: 400, error: "Incomplete Tap webhook payload." };
  }

  const expected = await hmacSha256Hex(secret, toHash);
  if (!timingSafeEqual(postedHashString, expected)) {
    return { ok: false, status: 401, error: "Invalid Tap hashstring." };
  }

  const transaction = optionalRecord(body.transaction);
  const created =
    optionalString(transaction?.created) ??
    (typeof transaction?.created === "number" ? String(transaction.created) : undefined) ??
    optionalString(body.created) ??
    (typeof body.created === "number" ? String(body.created) : undefined);
  const createdMs = created ? tapCreatedAtMillis(created) : null;
  if (!createdMs || Math.abs(nowMs - createdMs) > TAP_WEBHOOK_MAX_AGE_MS) {
    return { ok: false, status: 401, error: "Stale Tap webhook." };
  }

  const status = optionalString(body.status);
  const objectType = optionalString(body.object) ?? "charge";
  const eventType = `tap.${objectType}.${status ?? "unknown"}`;
  if (status !== "CAPTURED") {
    return { ok: true, value: { kind: "ignored", provider: "tap", providerEventId: optionalString(body.id), providerEventType: eventType } };
  }

  const externalId = optionalString(body.id);
  const amount = optionalNumber(body.amount);
  const currency = optionalString(body.currency)?.toUpperCase();
  if (!externalId || amount === undefined || !currency) {
    return { ok: false, status: 400, error: "Incomplete Tap settlement payload." };
  }

  const merchant = optionalRecord(body.merchant);
  const providerAccountId = optionalString(merchant?.id);

  return {
    ok: true,
    value: {
      kind: "settled",
      provider: "tap",
      externalId,
      amountMinor: toMinorUnits(amount, currency),
      currency,
      providerPayload: body,
      providerEventId: externalId,
      providerEventType: eventType,
      ...(providerAccountId ? { providerAccountId } : {}),
      signatureVerifiedAt: nowMs,
    },
  };
}

export async function verifyPaymentWebhook(
  provider: string,
  rawBody: string,
  headers: Headers,
  env: PaymentWebhookEnv,
  nowMs = Date.now(),
): Promise<PaymentWebhookVerificationResult> {
  switch (provider) {
    case "stripe":
      return await verifyStripeWebhook(rawBody, headers, env, nowMs);
    case "tap":
      return await verifyTapWebhook(rawBody, headers, env, nowMs);
    default:
      return { ok: false, status: 400, error: "Unsupported payment provider." };
  }
}
