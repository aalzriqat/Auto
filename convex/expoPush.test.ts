import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const MODULES = import.meta.glob("./**/*.ts");

const TOKEN_A = "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]";
const TOKEN_B = "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]";

/**
 * The real rate-limiter component is registered here rather than stubbed with
 * `vi.mock("./rateLimit")` (the pattern most suites use) precisely because the
 * defect under test lives in the bucket configuration: a mocked limiter that
 * always answers `{ ok: true }` cannot tell a per-user bucket from a global
 * one, which is exactly how the unkeyed bucket survived.
 */
function setup() {
  const t = convexTestWithComponents(schema, MODULES);
  registerRateLimiter(t);
  return t;
}

async function seedUserWithToken(
  t: ReturnType<typeof setup>,
  clerkId: string,
  token: string
): Promise<Id<"users">> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert("users", {
      clerkId,
      email: `${clerkId}@test.com`,
      name: clerkId,
    });
    await ctx.db.insert("mobilePushTokens", {
      userId,
      token,
      platform: "ANDROID",
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    });
    return userId;
  });
}

function liveTokens(t: ReturnType<typeof setup>): Promise<string[]> {
  // `.collect()` + map rather than an index lookup: this helper's `t` parameter
  // widens `ctx.db` to a generic data model, where named indexes don't type.
  return t.run((ctx) => ctx.db.query("mobilePushTokens").collect()).then((rows) => rows.map((r) => r.token));
}

/** Minimal stand-in for a `Response`: only `.ok/.status/.statusText/.json()` are read. */
function fakeResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => data,
  } as unknown as Response;
}

function stubFetch(impl: (url: string) => Response | Promise<Response>) {
  const fn = vi.fn((input: unknown) => Promise.resolve(impl(String(input))));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const SEND_ARGS = { locale: "en", type: "lead.assigned", data: { leadName: "Dana" } } as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("sendMobilePush rate limiting", () => {
  test("the bucket is per-user: one user draining it does not block anyone else", async () => {
    const t = setup();
    const userA = await seedUserWithToken(t, "user_a", TOKEN_A);
    const userB = await seedUserWithToken(t, "user_b", TOKEN_B);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Tickets carry no id, so no receipt follow-up is scheduled and the test
    // leaves no 15-minute timers behind.
    stubFetch(() => fakeResponse({ data: [{ status: "ok" }] }));

    let dropped = 0;
    for (let i = 0; i < 40; i += 1) {
      const r = await t.action(internal.expoPush.sendMobilePush, { userId: userA, ...SEND_ARGS });
      if (!r.success && r.error === "rate_limited") dropped += 1;
    }
    // Sanity: user A really did exhaust their own bucket.
    expect(dropped).toBeGreaterThan(0);

    // The whole point. With a single unkeyed deployment-wide bucket, user B is
    // starved by user A's traffic and receives nothing.
    const forB = await t.action(internal.expoPush.sendMobilePush, { userId: userB, ...SEND_ARGS });
    expect(forB).toMatchObject({ success: true, sent: 1 });

    // A drop must be visible in the logs, not silent.
    const logged = warn.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("rate limit");
    expect(logged).toContain(userA);
  });
});

describe("sendMobilePush failure logging", () => {
  test("a thrown request logs the userId and token count, never the token itself", async () => {
    const t = setup();
    const userId = await seedUserWithToken(t, "user_a", TOKEN_A);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => {
      throw new Error("network unreachable");
    });

    const r = await t.action(internal.expoPush.sendMobilePush, { userId, ...SEND_ARGS });
    expect(r.success).toBe(false);

    const logged = error.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain(userId);
    expect(logged).toContain("tokens=1");
    expect(logged).not.toContain(TOKEN_A);
  });

  test("a non-OK HTTP response logs the status code", async () => {
    const t = setup();
    const userId = await seedUserWithToken(t, "user_a", TOKEN_A);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() => fakeResponse({ errors: [{ code: "PUSH_TOO_MANY_NOTIFICATIONS" }] }, 429));

    const r = await t.action(internal.expoPush.sendMobilePush, { userId, ...SEND_ARGS });
    expect(r).toMatchObject({ success: false, error: "expo_http_429" });

    const logged = error.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("429");
    expect(logged).toContain(userId);
    expect(logged).not.toContain(TOKEN_A);
  });

  test("an all-rejected send is logged distinguishably and reports the Expo error code", async () => {
    const t = setup();
    const userId = await seedUserWithToken(t, "user_a", TOKEN_A);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() =>
      fakeResponse({
        data: [{ status: "error", message: "sender id mismatch", details: { error: "MismatchSenderId" } }],
      })
    );

    const r = await t.action(internal.expoPush.sendMobilePush, { userId, ...SEND_ARGS });
    expect(r).toMatchObject({ success: false, sent: 0, failed: 1 });

    const logged = error.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("every ticket rejected");
    expect(logged).toContain("MismatchSenderId");

    // MismatchSenderId is a fault in OUR FCM credentials, not a dead device.
    // Pruning here would wipe every live token over one bad config.
    expect(await liveTokens(t)).toEqual([TOKEN_A]);
  });
});

describe("sendMobilePush token pruning", () => {
  test("a ticket-level DeviceNotRegistered still prunes the token", async () => {
    const t = setup();
    const userId = await seedUserWithToken(t, "user_a", TOKEN_A);
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(() =>
      fakeResponse({
        data: [{ status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } }],
      })
    );

    await t.action(internal.expoPush.sendMobilePush, { userId, ...SEND_ARGS });
    expect(await liveTokens(t)).toEqual([]);
  });

  test("a device FCM has dropped is pruned from the receipt, which the ticket never reveals", async () => {
    vi.useFakeTimers();
    const t = setup();
    const userId = await seedUserWithToken(t, "user_a", TOKEN_A);
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch((url) =>
      url.includes("getReceipts")
        ? fakeResponse({
            data: {
              "ticket-1": {
                status: "error",
                message: "The recipient device is not registered with FCM.",
                details: { error: "DeviceNotRegistered" },
              },
            },
          })
        : fakeResponse({ data: [{ status: "ok", id: "ticket-1" }] })
    );

    const r = await t.action(internal.expoPush.sendMobilePush, { userId, ...SEND_ARGS });
    // Expo accepted the message: the ticket says "ok" even though the device is
    // long gone. Nothing is prunable at this point.
    expect(r).toMatchObject({ success: true, sent: 1 });
    expect(await liveTokens(t)).toEqual([TOKEN_A]);

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // The receipt is the only place the truth shows up.
    expect(await liveTokens(t)).toEqual([]);
  });

  test("a delivered receipt prunes nothing", async () => {
    vi.useFakeTimers();
    const t = setup();
    const userId = await seedUserWithToken(t, "user_a", TOKEN_A);
    stubFetch((url) =>
      url.includes("getReceipts")
        ? fakeResponse({ data: { "ticket-1": { status: "ok" } } })
        : fakeResponse({ data: [{ status: "ok", id: "ticket-1" }] })
    );

    await t.action(internal.expoPush.sendMobilePush, { userId, ...SEND_ARGS });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await liveTokens(t)).toEqual([TOKEN_A]);
  });

  test("a receipt reporting MismatchSenderId is logged but never prunes", async () => {
    vi.useFakeTimers();
    const t = setup();
    const userId = await seedUserWithToken(t, "user_a", TOKEN_A);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch((url) =>
      url.includes("getReceipts")
        ? fakeResponse({
            data: { "ticket-1": { status: "error", details: { error: "MismatchSenderId" } } },
          })
        : fakeResponse({ data: [{ status: "ok", id: "ticket-1" }] })
    );

    await t.action(internal.expoPush.sendMobilePush, { userId, ...SEND_ARGS });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await liveTokens(t)).toEqual([TOKEN_A]);
    const logged = error.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("undelivered on receipt");
    expect(logged).toContain("MismatchSenderId");
    expect(logged).not.toContain(TOKEN_A);
  });
});
