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
});
