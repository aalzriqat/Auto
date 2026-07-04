import { describe, expect, test } from "vitest";
import {
  hmacSha256Hex,
  verifyPaymentWebhook,
} from "./utils/paymentWebhook";

describe("payment webhook verification", () => {
  test("verifies Stripe signatures over the raw body and normalizes checkout settlement", async () => {
    const secret = "whsec_test_secret_123456789";
    const nowMs = Date.UTC(2026, 6, 1, 12, 0, 0);
    const timestamp = Math.floor(nowMs / 1000);
    const rawBody = JSON.stringify({
      id: "evt_stripe_1",
      type: "checkout.session.completed",
      account: "acct_123",
      data: {
        object: {
          id: "cs_test_123",
          payment_status: "paid",
          status: "complete",
          amount_total: 500000,
          currency: "jod",
        },
      },
    });
    const signature = await hmacSha256Hex(secret, `${timestamp}.${rawBody}`);

    const result = await verifyPaymentWebhook(
      "stripe",
      rawBody,
      new Headers({ "stripe-signature": `t=${timestamp},v1=${signature}` }),
      { STRIPE_WEBHOOK_SECRET: secret },
      nowMs,
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "settled") throw new Error("Expected settled webhook");
    expect(result.value.externalId).toBe("cs_test_123");
    expect(result.value.amountMinor).toBe(500000);
    expect(result.value.currency).toBe("JOD");
    expect(result.value.providerAccountId).toBe("acct_123");
  });

  test("rejects stale Stripe signatures", async () => {
    const secret = "whsec_test_secret_123456789";
    const nowMs = Date.UTC(2026, 6, 1, 12, 0, 0);
    const oldTimestamp = Math.floor((nowMs - 10 * 60 * 1000) / 1000);
    const rawBody = JSON.stringify({ id: "evt_old", type: "payment_intent.succeeded" });
    const signature = await hmacSha256Hex(secret, `${oldTimestamp}.${rawBody}`);

    const result = await verifyPaymentWebhook(
      "stripe",
      rawBody,
      new Headers({ "stripe-signature": `t=${oldTimestamp},v1=${signature}` }),
      { STRIPE_WEBHOOK_SECRET: secret },
      nowMs,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected stale signature rejection");
    expect(result.status).toBe(401);
  });

  test("verifies Tap hashstring and converts decimal amounts to minor units", async () => {
    const secret = "sk_test_secret_123456789";
    const nowMs = Date.UTC(2026, 6, 1, 12, 0, 0);
    const created = String(nowMs);
    const rawBody = JSON.stringify({
      id: "chg_tap_1",
      object: "charge",
      status: "CAPTURED",
      amount: 1.5,
      currency: "JOD",
      transaction: { created },
      reference: {
        gateway: "gw_123",
        payment: "pay_123",
      },
      merchant: { id: "merchant_123" },
    });
    const hashString =
      "x_idchg_tap_1x_amount1.500x_currencyJODx_gateway_referencegw_123" +
      "x_payment_referencepay_123x_statusCAPTUREDx_created" +
      created;
    const signature = await hmacSha256Hex(secret, hashString);

    const result = await verifyPaymentWebhook(
      "tap",
      rawBody,
      new Headers({ hashstring: signature }),
      { TAP_SECRET_API_KEY: secret },
      nowMs,
    );

    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "settled") throw new Error("Expected settled webhook");
    expect(result.value.externalId).toBe("chg_tap_1");
    expect(result.value.amountMinor).toBe(1500);
    expect(result.value.currency).toBe("JOD");
    expect(result.value.providerAccountId).toBe("merchant_123");
  });

  test("rejects Tap payloads whose hashstring does not match", async () => {
    const nowMs = Date.UTC(2026, 6, 1, 12, 0, 0);
    const rawBody = JSON.stringify({
      id: "chg_tap_bad",
      object: "charge",
      status: "CAPTURED",
      amount: 1,
      currency: "SAR",
      transaction: { created: String(nowMs) },
      reference: { gateway: "", payment: "" },
    });

    const result = await verifyPaymentWebhook(
      "tap",
      rawBody,
      new Headers({ hashstring: "wrong" }),
      { TAP_SECRET_API_KEY: "sk_test_secret_123456789" },
      nowMs,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected invalid hashstring rejection");
    expect(result.status).toBe(401);
  });

  // GL Phase 16 acceptance gate: a provider without a verifier must be
  // rejected, not silently accepted. Covers both a name that sounds
  // plausible (an unonboarded real gateway) and an arbitrary string.
  test.each(["telr", "hyperpay", "checkout", "totally-made-up"])(
    "rejects an unsupported provider (%s) rather than accepting it",
    async (provider) => {
      const result = await verifyPaymentWebhook(
        provider,
        JSON.stringify({ id: "evt_1" }),
        new Headers(),
        {},
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Expected unsupported-provider rejection");
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/unsupported payment provider/i);
    },
  );

  // Stripe staleness is already covered above; Tap's replay window needs the
  // same coverage to satisfy "each supported provider validates its ...
  // timestamp and replay window" for both providers, not just one.
  test("rejects a stale Tap webhook even with a correct hashstring", async () => {
    const secret = "sk_test_secret_123456789";
    const nowMs = Date.UTC(2026, 6, 1, 12, 0, 0);
    const staleCreated = String(nowMs - 4 * 24 * 60 * 60 * 1000); // 4 days old
    const rawBody = JSON.stringify({
      id: "chg_tap_stale",
      object: "charge",
      status: "CAPTURED",
      amount: 1,
      currency: "JOD",
      transaction: { created: staleCreated },
      reference: { gateway: "gw_1", payment: "pay_1" },
    });
    const hashString =
      "x_idchg_tap_stalex_amount1.000x_currencyJODx_gateway_referencegw_1" +
      "x_payment_referencepay_1x_statusCAPTUREDx_created" +
      staleCreated;
    const signature = await hmacSha256Hex(secret, hashString);

    const result = await verifyPaymentWebhook(
      "tap",
      rawBody,
      new Headers({ hashstring: signature }),
      { TAP_SECRET_API_KEY: secret },
      nowMs,
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected stale Tap webhook rejection");
    expect(result.status).toBe(401);
    expect(result.error).toMatch(/stale tap webhook/i);
  });

  test("rejects a Stripe webhook with no signature header at all", async () => {
    const result = await verifyPaymentWebhook(
      "stripe",
      JSON.stringify({ id: "evt_1", type: "checkout.session.completed" }),
      new Headers(),
      { STRIPE_WEBHOOK_SECRET: "whsec_test_secret_123456789" },
      Date.UTC(2026, 6, 1, 12, 0, 0),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected missing-signature rejection");
    expect(result.status).toBe(401);
  });

  test("rejects a Tap webhook with no hashstring header at all", async () => {
    const result = await verifyPaymentWebhook(
      "tap",
      JSON.stringify({ id: "chg_1", status: "CAPTURED" }),
      new Headers(),
      { TAP_SECRET_API_KEY: "sk_test_secret_123456789" },
      Date.UTC(2026, 6, 1, 12, 0, 0),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected missing-hashstring rejection");
    expect(result.status).toBe(401);
  });

  test("fails closed (503) for a supported provider whose secret isn't configured", async () => {
    const result = await verifyPaymentWebhook(
      "stripe",
      JSON.stringify({ id: "evt_1" }),
      new Headers({ "stripe-signature": "t=1,v1=whatever" }),
      {}, // no STRIPE_WEBHOOK_SECRET
      Date.UTC(2026, 6, 1, 12, 0, 0),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected not-configured rejection");
    expect(result.status).toBe(503);
  });
});
