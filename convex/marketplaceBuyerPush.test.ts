import { convexTest } from "convex-test";
import { expect, test, describe, afterEach, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const GOOD = "ExponentPushToken[good-device]";
const DEAD = "ExponentPushToken[dead-device]";

describe("registerBuyerPushToken", () => {
  test("stores a valid Expo token keyed by publicId", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await t.mutation(api.marketplaceBuyerPush.registerBuyerPushToken, {
      publicId: "room-1",
      token: GOOD,
      platform: "ANDROID",
    });
    const rows = await t.run((ctx) =>
      ctx.db.query("marketplaceBuyerPushTokens").withIndex("by_publicId", (q) => q.eq("publicId", "room-1")).collect()
    );
    expect(rows.map((r) => r.token)).toEqual([GOOD]);
  });

  test("rejects a token that isn't an Expo push token", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await expect(
      t.mutation(api.marketplaceBuyerPush.registerBuyerPushToken, { publicId: "room-1", token: "not-a-token", platform: "IOS" })
    ).rejects.toThrow(/token/i);
  });

  test("de-duplicates by token — a device that re-registers or moves rooms keeps one row", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await t.mutation(api.marketplaceBuyerPush.registerBuyerPushToken, { publicId: "room-1", token: GOOD, platform: "ANDROID" });
    await t.mutation(api.marketplaceBuyerPush.registerBuyerPushToken, { publicId: "room-2", token: GOOD, platform: "ANDROID" });

    const all = await t.run((ctx) => ctx.db.query("marketplaceBuyerPushTokens").collect());
    expect(all).toHaveLength(1);
    expect(all[0].publicId).toBe("room-2");
  });
});

describe("sendBuyerOfferPush", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("no-ops cleanly when the room has no registered devices", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await t.action(internal.marketplaceBuyerPush.sendBuyerOfferPush, { publicId: "empty-room" });
    expect(result).toEqual({ success: true, sent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("pushes to the room's devices and prunes the ones Expo says are dead", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await t.mutation(api.marketplaceBuyerPush.registerBuyerPushToken, { publicId: "room-1", token: GOOD, platform: "ANDROID" });
    await t.mutation(api.marketplaceBuyerPush.registerBuyerPushToken, { publicId: "room-1", token: DEAD, platform: "IOS" });

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ status: "ok" }, { status: "error", details: { error: "DeviceNotRegistered" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await t.action(internal.marketplaceBuyerPush.sendBuyerOfferPush, { publicId: "room-1" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://exp.host/--/api/v2/push/send",
      expect.objectContaining({ method: "POST" })
    );
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);

    const remaining = await t.run((ctx) =>
      ctx.db.query("marketplaceBuyerPushTokens").withIndex("by_publicId", (q) => q.eq("publicId", "room-1")).collect()
    );
    expect(remaining.map((r) => r.token)).toEqual([GOOD]);
  });

  test("reports an Expo HTTP failure without throwing", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    await t.mutation(api.marketplaceBuyerPush.registerBuyerPushToken, { publicId: "room-1", token: GOOD, platform: "ANDROID" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nope", { status: 500 })));
    const result = await t.action(internal.marketplaceBuyerPush.sendBuyerOfferPush, { publicId: "room-1" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("expo_http_500");
  });
});
