import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";

function legacyRow(status: "FULFILLED" | "MATCHED", phone: string) {
  return {
    status,
    buyerFirstName: "Legacy",
    buyerPhone: phone,
    buyerCity: "Amman",
    paymentType: "CASH" as const,
    buyerTimeframe: "THIS_MONTH" as const,
    buyerIntent: "COLD" as const,
    consentAcceptedAt: Date.now(),
    clientFingerprint: `fp-${phone}`,
    expiresAt: Date.now() + 1000,
    createdAt: Date.now(),
  };
}

describe("backfillMarketplaceStatuses", () => {
  test("maps FULFILLED to OFFERS_RECEIVED and leaves other statuses untouched", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const fulfilledId = await t.run((ctx) => ctx.db.insert("marketplaceRequests", legacyRow("FULFILLED", "+962790000001")));
    const matchedId = await t.run((ctx) => ctx.db.insert("marketplaceRequests", legacyRow("MATCHED", "+962790000002")));

    await t.mutation(internal.migrateMarketplaceStatuses.backfill, {});

    expect((await t.run((ctx) => ctx.db.get(fulfilledId)))?.status).toBe("OFFERS_RECEIVED");
    expect((await t.run((ctx) => ctx.db.get(matchedId)))?.status).toBe("MATCHED");
  });

  test("is idempotent — a second run changes nothing", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const fulfilledId = await t.run((ctx) => ctx.db.insert("marketplaceRequests", legacyRow("FULFILLED", "+962790000003")));

    const first = await t.mutation(internal.migrateMarketplaceStatuses.backfill, {});
    const second = await t.mutation(internal.migrateMarketplaceStatuses.backfill, {});

    expect(first).toContain("1");
    expect(second).toContain("0");
    expect((await t.run((ctx) => ctx.db.get(fulfilledId)))?.status).toBe("OFFERS_RECEIVED");
  });
});
