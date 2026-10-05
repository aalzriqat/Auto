import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { sendSmsReminder } from "./collectionReminderActions";

/**
 * SCRUM-639: every external sender, driven on a sunk preview and on
 * production. The preview case proves nothing leaves; the production case is
 * acceptance item 3 — the same call still reaches the provider, unchanged.
 *
 * The providers are stubbed at their lowest seam (`fetch`, the Resend client,
 * web-push), so "reached the provider" is observed directly rather than
 * inferred from a return value.
 */

const MODULES = import.meta.glob("./**/*.ts");

const { resendSend, webpushSend } = vi.hoisted(() => ({
  resendSend: vi.fn(async () => ({ data: { id: "email_1" } })),
  webpushSend: vi.fn(async () => ({})),
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

vi.mock("web-push", () => ({
  default: { sendNotification: webpushSend, setVapidDetails: vi.fn() },
}));

const PREVIEW_URL = "https://combative-gerbil-860.convex.cloud";
const PROD_URL = "https://kindly-hound-172.convex.cloud";

type Where = "preview" | "production";

/** Production carries no deployment class; the preview carries "preview". */
function deployOn(where: Where) {
  vi.stubEnv("AUTOFLOW_DEPLOYMENT_CLASS", where === "preview" ? "preview" : undefined);
  vi.stubEnv("CONVEX_CLOUD_URL", where === "preview" ? PREVIEW_URL : PROD_URL);
}

function setup() {
  const t = convexTestWithComponents(schema, MODULES);
  registerRateLimiter(t);
  return t;
}

function okResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

function stubFetch(data: unknown = {}) {
  const fn = vi.fn<(input: unknown, init?: unknown) => Promise<Response>>(async () => okResponse(data));
  vi.stubGlobal("fetch", fn);
  return fn;
}

const NOTIFY = { locale: "en", type: "lead.assigned", data: { leadName: "Dana" } } as const;
const WHERE: Where[] = ["preview", "production"];
const SUNK = { success: false, error: "egress_sunk" };

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  resendSend.mockClear();
  webpushSend.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(WHERE)("email on %s", (where) => {
  const sunk = where === "preview";

  beforeEach(() => {
    deployOn(where);
    vi.stubEnv("RESEND_API_KEY", "re_test_key_not_real");
  });

  test("sendTaskAlarm (the task-alarm cron's email)", async () => {
    const t = setup();
    const r = await t.action(internal.email.sendTaskAlarm, {
      toEmail: "qa@example.test",
      taskTitle: "QA TEST",
      dueDate: Date.now(),
    });
    expect(resendSend).toHaveBeenCalledTimes(sunk ? 0 : 1);
    expect(r).toEqual({ success: true, mock: sunk });
  });

  test("sendNotificationEmail (dispatch's email)", async () => {
    const t = setup();
    const r = await t.action(internal.email.sendNotificationEmail, { toEmail: "qa@example.test", ...NOTIFY });
    expect(resendSend).toHaveBeenCalledTimes(sunk ? 0 : 1);
    expect(r).toEqual({ success: true });
  });

  test("sendTeamInvite", async () => {
    const t = setup();
    await t.action(internal.email.sendTeamInvite, {
      toEmail: "qa@example.test",
      orgName: "QA",
      inviteToken: "tok",
    });
    expect(resendSend).toHaveBeenCalledTimes(sunk ? 0 : 1);
  });
});

describe.each(WHERE)("WhatsApp notification on %s", (where) => {
  test("an org with real Meta credentials", async () => {
    deployOn(where);
    const t = setup();
    const orgId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("organizations", { name: "QA", createdAt: Date.now() });
      await ctx.db.insert("subscriptions", {
        orgId: id,
        plan: "professional",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("orgSettings", {
        orgId: id,
        currency: "JOD",
        currencySymbol: "JD",
        enabledPaymentTypes: [],
        whatsappPhoneNumberId: "123456",
        whatsappApiToken: "not-a-real-token",
      });
      return id;
    });
    const fetchFn = stubFetch({ messages: [{ id: "wamid" }] });

    const r = await t.action(internal.whatsappSend.sendNotificationWhatsapp, {
      orgId,
      toPhone: "+962790000000",
      ...NOTIFY,
    });

    if (where === "preview") {
      expect(fetchFn).not.toHaveBeenCalled();
      expect(r).toEqual(SUNK);
    } else {
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(String(fetchFn.mock.calls[0][0])).toContain("graph.facebook.com");
      expect(r).toEqual({ success: true });
    }
  });
});

describe.each(WHERE)("web push on %s", (where) => {
  test("a user with an enabled browser subscription", async () => {
    deployOn(where);
    vi.stubEnv("VAPID_PUBLIC_KEY", "pub");
    vi.stubEnv("VAPID_PRIVATE_KEY", "priv");
    vi.stubEnv("VAPID_SUBJECT", "mailto:qa@example.test");
    const t = setup();
    const { orgId, userId } = await t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", { name: "QA", createdAt: Date.now() });
      const userId = await ctx.db.insert("users", { clerkId: "qa", email: "qa@example.test", name: "QA" });
      await ctx.db.insert("pushSubscriptions", {
        orgId,
        userId,
        endpoint: "https://push.example.test/1",
        p256dh: "k",
        auth: "a",
        enabled: true,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
      });
      return { orgId, userId };
    });

    const r = await t.action(internal.pushSend.sendNotificationPush, { orgId, userId, ...NOTIFY });

    if (where === "preview") {
      expect(webpushSend).not.toHaveBeenCalled();
      expect(r).toEqual(SUNK);
    } else {
      expect(webpushSend).toHaveBeenCalledTimes(1);
      expect(r).toMatchObject({ success: true, sent: 1 });
    }
  });
});

describe.each(WHERE)("Expo push on %s", (where) => {
  async function seedUser(t: ReturnType<typeof setup>): Promise<Id<"users">> {
    return await t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: "qa", email: "qa@example.test", name: "QA" });
      await ctx.db.insert("mobilePushTokens", {
        userId,
        token: "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]",
        platform: "ANDROID",
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
      });
      return userId;
    });
  }

  test("sendMobilePush (dispatch schedules it whenever a token row exists)", async () => {
    deployOn(where);
    const t = setup();
    const userId = await seedUser(t);
    // No ticket id, so no receipt check is scheduled.
    const fetchFn = stubFetch({ data: [{ status: "ok" }] });

    const r = await t.action(internal.expoPush.sendMobilePush, { userId, ...NOTIFY });

    if (where === "preview") {
      expect(fetchFn).not.toHaveBeenCalled();
      expect(r).toEqual(SUNK);
    } else {
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(r).toEqual({ success: true, sent: 1, failed: 0 });
    }
  });

  test("checkPushReceipts", async () => {
    deployOn(where);
    const t = setup();
    const userId = await seedUser(t);
    const fetchFn = stubFetch({ data: { r1: { status: "ok" } } });

    const r = await t.action(internal.expoPush.checkPushReceipts, {
      userId,
      type: "lead.assigned",
      receipts: [{ id: "r1", token: "ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]" }],
    });

    if (where === "preview") {
      expect(fetchFn).not.toHaveBeenCalled();
      expect(r).toEqual(SUNK);
    } else {
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(r).toEqual({ success: true, pruned: 0 });
    }
  });

  test("sendBuyerOfferPush (anonymous marketplace buyer)", async () => {
    deployOn(where);
    const t = setup();
    await t.run((ctx) =>
      ctx.db.insert("marketplaceBuyerPushTokens", {
        publicId: "room_1",
        token: "ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]",
        platform: "ANDROID",
        createdAt: Date.now(),
      })
    );
    const fetchFn = stubFetch({ data: [{ status: "ok" }] });

    const r = await t.action(internal.marketplaceBuyerPush.sendBuyerOfferPush, { publicId: "room_1" });

    if (where === "preview") {
      expect(fetchFn).not.toHaveBeenCalled();
      expect(r).toEqual(SUNK);
    } else {
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(r).toEqual({ success: true, sent: 1, failed: 0 });
    }
  });
});

describe.each(WHERE)("collection SMS reminder on %s", (where) => {
  test("Twilio configured", async () => {
    deployOn(where);
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC_not_real");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "not_real");
    vi.stubEnv("TWILIO_FROM_NUMBER", "+10000000000");
    const fetchFn = stubFetch({ sid: "SM1" });

    const r = await sendSmsReminder("+962790000000", "ar", "collection.receivable_overdue", {
      customerName: "QA",
      amount: "1",
      dueDate: "1/1/2026",
    });

    if (where === "preview") {
      expect(fetchFn).not.toHaveBeenCalled();
      expect(r).toEqual({ success: false, skipped: true, error: "egress_sunk" });
    } else {
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(String(fetchFn.mock.calls[0][0])).toContain("api.twilio.com");
      expect(r).toEqual({ success: true });
    }
  });
});
