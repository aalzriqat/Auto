import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getValidatedEnv } from "./utils/env";
import { META_LOG_REDACTION_PAGE_SIZE, REDACTED_META_USER } from "./utils/metaUserIdRedaction";

// SCRUM-842: Meta's deauthorize and data-deletion callbacks must not copy the
// Meta user id into anything that outlives the request (webhookLogs, the
// confirmation code, the status URL, console output), must answer the status URL
// with the right platform, and must refuse a bad signature before writing.
// Every test posts a real HMAC-signed `signed_request` to the HTTP route.

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

// A thin wrapper over the real redaction: the one row whose summary is exactly
// "POISON-ROW-842" makes it throw, to fail a later page of a multi-page run.
vi.mock("./utils/metaUserIdRedaction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils/metaUserIdRedaction")>();
  return {
    ...actual,
    redactMetaUserIdInText: (text: string, metaUserId: string) => {
      if (text === "POISON-ROW-842") throw new Error("injected page failure");
      return actual.redactMetaUserIdInText(text, metaUserId);
    },
  };
});
const FACEBOOK_SECRET = "test_fb_app_secret_842";
const INSTAGRAM_SECRET = "test_ig_app_secret_842";

vi.mock("./utils/env", () => ({
  getValidatedEnv: vi.fn(() => ({
    FACEBOOK_APP_ID: "test_fb_app_id",
    FACEBOOK_APP_SECRET: "test_fb_app_secret_842",
    INSTAGRAM_APP_SECRET: "test_ig_app_secret_842",
    CONVEX_SITE_URL: "https://example.convex.site",
    NEXT_PUBLIC_APP_URL: "https://app.test",
    SUPER_ADMIN_EMAILS: "admin@autoflow.dev",
  })),
}));

// A synthetic id, deliberately unlike any real Meta app-scoped id.
const META_USER_ID = "synthetic-meta-user-842";

type T = ReturnType<typeof convexTestWithComponents<typeof schema>>;

const newTest = () => convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));

const toBase64Url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");

async function sign(encodedPayload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encodedPayload)));
  return toBase64Url(sig);
}

async function signedRequest(payload: Record<string, unknown>, secret: string): Promise<string> {
  const encoded = toBase64Url(JSON.stringify(payload));
  return `${await sign(encoded, secret)}.${encoded}`;
}

function post(t: T, path: string, signed: string) {
  return t.fetch(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ signed_request: signed }).toString(),
  });
}

type Platform = "facebook" | "instagram";

const PLATFORMS: Array<{
  platform: Platform;
  label: string;
  otherLabel: string;
  secret: string;
  otherSecret: string;
  deauthorize: string;
  deletion: string;
  logSource: string;
  otherLogSource: string;
}> = [
  {
    platform: "facebook",
    label: "Facebook",
    otherLabel: "Instagram",
    secret: FACEBOOK_SECRET,
    otherSecret: INSTAGRAM_SECRET,
    deauthorize: "/facebook-deauthorize",
    deletion: "/facebook-data-deletion",
    logSource: "facebook-oauth",
    otherLogSource: "instagram-oauth",
  },
  {
    platform: "instagram",
    label: "Instagram",
    otherLabel: "Facebook",
    secret: INSTAGRAM_SECRET,
    otherSecret: FACEBOOK_SECRET,
    deauthorize: "/instagram-deauthorize",
    deletion: "/instagram-data-deletion",
    logSource: "instagram-oauth",
    otherLogSource: "facebook-oauth",
  },
];

async function seedConnectedOrg(t: T, platform: Platform): Promise<Id<"organizations">> {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Synthetic Org", createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      enabledPaymentTypes: [],
      ...(platform === "facebook"
        ? {
            facebookPageId: "page_842",
            facebookPageAccessToken: "synthetic-page-token-842",
            facebookPageName: "Synthetic Page",
            facebookConnectedByUserId: META_USER_ID,
          }
        : {
            instagramBusinessAccountId: META_USER_ID,
            instagramAccessToken: "synthetic-ig-token-842",
            instagramPageName: "synthetic_ig",
          }),
    }),
  );
  return orgId;
}

const settingsOf = (t: T, orgId: Id<"organizations">) =>
  t.run((ctx) =>
    ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .unique(),
  );

const allWebhookLogs = (t: T) => t.run((ctx) => ctx.db.query("webhookLogs").collect());
const allDeletionRequests = (t: T) =>
  t.run((ctx) => ctx.db.query("metaDataDeletionRequests").collect());

describe("SCRUM-842 Meta deauthorize and data-deletion callbacks", () => {
  let consoleOutput: string[];

  beforeEach(() => {
    consoleOutput = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleOutput.push(args.map(String).join(" "));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each(PLATFORMS)("$label", (p) => {
    test.each([
      ["deauthorize", p.deauthorize],
      ["data-deletion", p.deletion],
    ])("%s: the Meta user id is in no log row, response, stored request or console output", async (_name, path) => {
      const t = newTest();
      await seedConnectedOrg(t, p.platform);

      const res = await post(t, path, await signedRequest({ user_id: META_USER_ID }, p.secret));
      const body = await res.text();

      expect(res.status).toBe(200);
      expect(body).not.toContain(META_USER_ID);
      expect(JSON.stringify([...res.headers])).not.toContain(META_USER_ID);
      expect(JSON.stringify(await allWebhookLogs(t))).not.toContain(META_USER_ID);
      expect(JSON.stringify(await allDeletionRequests(t))).not.toContain(META_USER_ID);
      expect(consoleOutput.join("\n")).not.toContain(META_USER_ID);
    });

    test.each([
      ["deauthorize", p.deauthorize],
      ["data-deletion", p.deletion],
    ])("%s: the log row names this platform and never the other one", async (_name, path) => {
      const t = newTest();
      await seedConnectedOrg(t, p.platform);

      await post(t, path, await signedRequest({ user_id: META_USER_ID }, p.secret));

      const logs = await allWebhookLogs(t);
      expect(logs).toHaveLength(1);
      expect(logs[0].source).toBe(p.logSource);
      expect(logs[0].status).toBe("success");
      expect(logs[0].summary).toContain(p.label);
      expect(logs[0].summary).not.toContain(p.otherLabel);
    });

    test("data-deletion: the connection is still erased", async () => {
      const t = newTest();
      const orgId = await seedConnectedOrg(t, p.platform);

      const res = await post(t, p.deletion, await signedRequest({ user_id: META_USER_ID }, p.secret));

      expect(res.status).toBe(200);
      const row = await settingsOf(t, orgId);
      if (p.platform === "facebook") {
        expect(row?.facebookPageId).toBeUndefined();
        expect(row?.facebookPageAccessToken).toBeUndefined();
        expect(row?.facebookConnectedByUserId).toBeUndefined();
      } else {
        expect(row?.instagramBusinessAccountId).toBeUndefined();
        expect(row?.instagramAccessToken).toBeUndefined();
      }
    });

    test("data-deletion: the confirmation code is opaque, unique per request, and answers the status URL with this platform", async () => {
      const t = newTest();
      await seedConnectedOrg(t, p.platform);
      const signed = await signedRequest({ user_id: META_USER_ID }, p.secret);

      const first = (await (await post(t, p.deletion, signed)).json()) as { url: string; confirmation_code: string };
      const second = (await (await post(t, p.deletion, signed)).json()) as { url: string; confirmation_code: string };

      for (const reply of [first, second]) {
        expect(reply.confirmation_code).toMatch(/^[0-9a-f]{32}$/);
        expect(reply.url).toBe(`https://app.test/data-deletion-status?id=${reply.confirmation_code}`);
        const status = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: reply.confirmation_code });
        expect(status?.platform).toBe(p.platform);
        expect(typeof status?.completedAt).toBe("number");
        expect(Object.keys(status ?? {}).sort()).toEqual(["completedAt", "platform"]);
      }
      expect(second.confirmation_code).not.toBe(first.confirmation_code);
    });

    test("data-deletion for a user we hold nothing for still answers with a status code and stores no user id", async () => {
      const t = newTest();

      const res = await post(t, p.deletion, await signedRequest({ user_id: "synthetic-unknown-user-842" }, p.secret));
      const reply = (await res.json()) as { confirmation_code: string };

      expect(res.status).toBe(200);
      expect(
        (await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: reply.confirmation_code }))?.platform,
      ).toBe(p.platform);
      expect(JSON.stringify(await allWebhookLogs(t))).not.toContain("synthetic-unknown-user-842");
      expect(JSON.stringify(await allDeletionRequests(t))).not.toContain("synthetic-unknown-user-842");
    });

    test.each([
      ["deauthorize", p.deauthorize],
      ["data-deletion", p.deletion],
    ])("%s: a bad signature is refused with nothing written", async (_name, path) => {
      const t = newTest();
      const orgId = await seedConnectedOrg(t, p.platform);
      const before = await settingsOf(t, orgId);

      const encoded = toBase64Url(JSON.stringify({ user_id: META_USER_ID }));
      const wrongSecret = `${await sign(encoded, "not-the-app-secret")}.${encoded}`;
      const otherPlatformSecret = await signedRequest({ user_id: META_USER_ID }, p.otherSecret);
      const tampered = `${(await sign(encoded, p.secret))}.${toBase64Url(JSON.stringify({ user_id: "someone-else" }))}`;

      for (const bad of [wrongSecret, otherPlatformSecret, tampered]) {
        const res = await post(t, path, bad);
        expect(res.status).toBe(400);
        expect(await res.text()).not.toContain(META_USER_ID);
      }

      expect(await allWebhookLogs(t)).toHaveLength(0);
      expect(await allDeletionRequests(t)).toHaveLength(0);
      expect(await settingsOf(t, orgId)).toEqual(before);
      expect(consoleOutput.join("\n")).not.toContain(META_USER_ID);
    });

    test.each([
      ["deauthorize", p.deauthorize],
      ["data-deletion", p.deletion],
    ])("%s: an unconfigured app secret answers 500 and nothing is written", async (_name, path) => {
      const t = newTest();
      const orgId = await seedConnectedOrg(t, p.platform);
      const before = await settingsOf(t, orgId);
      vi.mocked(getValidatedEnv).mockReturnValueOnce({
        NEXT_PUBLIC_APP_URL: "https://app.test",
      } as unknown as ReturnType<typeof getValidatedEnv>);

      const res = await post(t, path, await signedRequest({ user_id: META_USER_ID }, p.secret));

      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Not configured");
      expect(await allWebhookLogs(t)).toHaveLength(0);
      expect(await allDeletionRequests(t)).toHaveLength(0);
      expect(await settingsOf(t, orgId)).toEqual(before);
    });

    test.each([
      ["deauthorize", p.deauthorize],
      ["data-deletion", p.deletion],
    ])("%s: a request with no signed_request is refused with 400 and nothing is written", async (_name, path) => {
      const t = newTest();
      const orgId = await seedConnectedOrg(t, p.platform);
      const before = await settingsOf(t, orgId);

      const emptyForm = await t.fetch(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      });
      const notAForm = await t.fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signed_request: await signedRequest({ user_id: META_USER_ID }, p.secret) }),
      });

      for (const res of [emptyForm, notAForm]) {
        expect(res.status).toBe(400);
        expect(await res.text()).toBe("Bad request");
      }
      expect(await allWebhookLogs(t)).toHaveLength(0);
      expect(await allDeletionRequests(t)).toHaveLength(0);
      expect(await settingsOf(t, orgId)).toEqual(before);
    });
  });

  describe("getMetaDataDeletionStatus", () => {
    test("an unknown or malformed code answers null and reveals nothing", async () => {
      const t = newTest();
      const [fb] = PLATFORMS;
      await seedConnectedOrg(t, "facebook");
      await post(t, fb.deletion, await signedRequest({ user_id: META_USER_ID }, fb.secret));

      for (const code of ["0".repeat(32), "", "not-a-code", "A".repeat(500), META_USER_ID]) {
        expect(await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code })).toBeNull();
      }
    });
  });
});


// ─── Retained webhook logs: redaction of rows written before SCRUM-842 ────────
//
// Before this change the deauthorize and data-deletion callbacks wrote
// "... by <Platform> user <id>" into webhookLogs, and SCRUM-807 forbids deleting
// operational history. A signed callback for a user therefore redacts that one
// identifier out of the retained rows (the row stays), in bounded pages, and the
// receipt is not marked complete until the last page is done.

// Synthetic, numeric like a real Meta id, and deliberately not any real one.
const LEGACY_ID = "990000000000842";
const OTHER_ID = "990000000000999";
// Contains LEGACY_ID as a substring but is a different user.
const LONGER_ID = `${LEGACY_ID}7`;

const ADMIN_EMAIL = "admin@autoflow.dev";

async function seedLegacyLog(t: T, source: string, summary: string, status = "success"): Promise<Id<"webhookLogs">> {
  return t.run((ctx) =>
    ctx.db.insert("webhookLogs", {
      source: source as never,
      status: status as never,
      summary,
      createdAt: Date.now(),
    }),
  );
}

const legacyLine = (label: string, id: string, kind: "deauth" | "deletion") =>
  kind === "deauth" ? `Deauthorized by ${label} user ${id}` : `Data deletion requested by ${label} user ${id}`;

const logById = (t: T, id: Id<"webhookLogs">) => t.run((ctx) => ctx.db.get(id));

// ─── Scheduler inspection ─────────────────────────────────────────────────────
//
// Convex keeps a finished scheduled function, with its arguments, for 7 days and
// exposes it through the `_scheduled_functions` system table
// (https://docs.convex.dev/scheduling/scheduled-functions). A continuation that
// carried the Meta user id (or the receipt code that links the request to it) in
// its arguments would therefore keep the identifier the deletion exists to erase.

// The injected page failure: any row with exactly this summary makes the (mocked)
// redaction throw, so a later page fails after earlier pages have committed.
const POISON_SUMMARY = "POISON-ROW-842";

async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The secret as it could be recovered from a stored copy: plain, escaped, encoded, reversed or hashed. */
async function recoverableForms(secret: string): Promise<string[]> {
  const bytes = Buffer.from(secret);
  const hex = bytes.toString("hex");
  return [
    secret,
    secret.toUpperCase(),
    [...secret].reverse().join(""),
    encodeURIComponent(secret),
    JSON.stringify(secret).slice(1, -1),
    bytes.toString("base64"),
    bytes.toString("base64url"),
    hex,
    hex.toUpperCase(),
    await sha256Hex(secret),
  ];
}

const scheduledRecords = (t: T) => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());

async function expectSchedulerHoldsNone(t: T, secrets: string[]): Promise<void> {
  const dump = JSON.stringify(await scheduledRecords(t));
  for (const secret of secrets) {
    for (const form of await recoverableForms(secret)) {
      expect(dump, `scheduler record holds a recoverable form of an identifier (${form.length} chars)`).not.toContain(form);
    }
  }
}

async function seedFillerLogs(t: T, source: string, count: number): Promise<void> {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i += 1) {
      await ctx.db.insert("webhookLogs", {
        source: source as never,
        status: "success",
        summary: `Connected for org filler-${i}`,
        createdAt: Date.now(),
      });
    }
  });
}

function captureConsole(): string[] {
  const output: string[] = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      output.push(args.map(String).join(" "));
    });
  }
  return output;
}

describe("SCRUM-842 retained webhookLogs redaction", () => {
  beforeEach(() => {
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation(() => undefined);
    }
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe.each(PLATFORMS)("$label", (p) => {
    test.each([
      ["deauthorize", p.deauthorize, "deauth" as const],
      ["data-deletion", p.deletion, "deletion" as const],
    ])("%s: a historical row naming the user is redacted in place and keeps its audit fields", async (_name, path, kind) => {
      const t = newTest();
      const rowId = await seedLegacyLog(t, p.logSource, legacyLine(p.label, LEGACY_ID, kind));
      const before = await logById(t, rowId);

      const res = await post(t, path, await signedRequest({ user_id: LEGACY_ID }, p.secret));
      expect(res.status).toBe(200);

      const after = await logById(t, rowId);
      expect(after?.summary).toBe(legacyLine(p.label, REDACTED_META_USER, kind));
      expect(JSON.stringify(await allWebhookLogs(t))).not.toContain(LEGACY_ID);
      // Only the identifier moved: the row, its time, status and source are the audit value.
      expect({ ...after, summary: "" }).toEqual({ ...before, summary: "" });
    });

    test("the error of a callback-source row that names the user is redacted too", async () => {
      const t = newTest();
      const rowId = await t.run((ctx) =>
        ctx.db.insert("webhookLogs", {
          source: p.logSource as never,
          status: "error",
          summary: "Callback failed",
          error: `Graph rejected user ${LEGACY_ID}`,
          createdAt: Date.now(),
        }),
      );

      await post(t, p.deletion, await signedRequest({ user_id: LEGACY_ID }, p.secret));

      expect((await logById(t, rowId))?.error).toBe(`Graph rejected user ${REDACTED_META_USER}`);
    });
    test("only the signed user's identifier is touched: another user, a longer id, another source and another platform stay as written", async () => {
      const t = newTest();
      const other = await seedLegacyLog(t, p.logSource, legacyLine(p.label, OTHER_ID, "deletion"));
      const longer = await seedLegacyLog(t, p.logSource, legacyLine(p.label, LONGER_ID, "deauth"));
      const wrongSource = await seedLegacyLog(t, p.platform, `Facebook note ${LEGACY_ID}`);
      const otherPlatform = await seedLegacyLog(
        t,
        p.platform === "facebook" ? "instagram-oauth" : "facebook-oauth",
        legacyLine(p.otherLabel, LEGACY_ID, "deletion"),
      );

      await post(t, p.deletion, await signedRequest({ user_id: LEGACY_ID }, p.secret));

      expect((await logById(t, other))?.summary).toBe(legacyLine(p.label, OTHER_ID, "deletion"));
      expect((await logById(t, longer))?.summary).toBe(legacyLine(p.label, LONGER_ID, "deauth"));
      expect((await logById(t, wrongSource))?.summary).toBe(`Facebook note ${LEGACY_ID}`);
      expect((await logById(t, otherPlatform))?.summary).toBe(legacyLine(p.otherLabel, LEGACY_ID, "deletion"));
    });

    test("it is idempotent: a second callback for the same user changes nothing more and both receipts complete", async () => {
      const t = newTest();
      const rowId = await seedLegacyLog(t, p.logSource, legacyLine(p.label, LEGACY_ID, "deletion"));
      const signed = await signedRequest({ user_id: LEGACY_ID }, p.secret);

      const first = (await (await post(t, p.deletion, signed)).json()) as { confirmation_code: string };
      const afterFirst = await logById(t, rowId);
      const second = (await (await post(t, p.deletion, signed)).json()) as { confirmation_code: string };

      expect(await logById(t, rowId)).toEqual(afterFirst);
      for (const reply of [first, second]) {
        const status = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: reply.confirmation_code });
        expect(typeof status?.completedAt).toBe("number");
      }
    });

    // ─── Every source that can hold the id (SCRUM-842 round 4, Seat 2 HIGH) ───────
    //
    // The OAuth callback source is not the only `webhookLogs` source a Meta user id
    // was written to: the `instagram` / `facebook` sources carry the Instagram
    // "subscribed_apps failed for IG account <id>" rows and the auto-reply
    // failures. A receipt that reads "processed" while those rows keep the id is a
    // false statement on the public status page.
    test("a completed signed deletion leaves no copy of the id in the platform's own webhook-source rows", async () => {
      const t = newTest();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const subject = p.platform === "instagram" ? "IG account" : "Page";
      const subscriptionFailure = await t.run((ctx) =>
        ctx.db.insert("webhookLogs", {
          source: p.platform,
          status: "error",
          summary: `subscribed_apps failed for ${subject} ${LEGACY_ID}`,
          error: `Graph rejected ${subject} ${LEGACY_ID}`,
          createdAt: Date.now(),
        }),
      );
      const autoReplyFailure = await seedLegacyLog(t, p.platform, `Auto-reply DM to ${LEGACY_ID} failed`, "error");

      const res = await post(t, p.deletion, await signedRequest({ user_id: LEGACY_ID }, p.secret));
      const reply = (await res.json()) as { confirmation_code: string };
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      // The receipt says processed, so storage must be clean.
      const done = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: reply.confirmation_code });
      expect(typeof done?.completedAt).toBe("number");
      expect(JSON.stringify(await allWebhookLogs(t))).not.toContain(LEGACY_ID);
      const row = await logById(t, subscriptionFailure);
      expect(row?.summary).toBe(`subscribed_apps failed for ${subject} ${REDACTED_META_USER}`);
      expect(row?.error).toBe(`Graph rejected ${subject} ${REDACTED_META_USER}`);
      expect((await logById(t, autoReplyFailure))?.summary).toBe(`Auto-reply DM to ${REDACTED_META_USER} failed`);
    });

    test("a request whose redaction needs more than one page completes, and no scheduler record ever holds the user id or the receipt code", async () => {
      const t = newTest();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      await seedFillerLogs(t, p.logSource, META_LOG_REDACTION_PAGE_SIZE * 2 + 5);
      const lastPageRow = await seedLegacyLog(t, p.logSource, legacyLine(p.label, LEGACY_ID, "deletion"));
      const lastPageRow2 = await seedLegacyLog(t, p.logSource, legacyLine(p.label, LEGACY_ID, "deauth"));
      // The same id in the OTHER platform's source, on a page of its own: it must not be touched.
      const otherPlatformRow = await seedLegacyLog(
        t,
        p.otherLogSource,
        legacyLine(p.otherLabel, LEGACY_ID, "deletion"),
      );

      const res = await post(t, p.deletion, await signedRequest({ user_id: LEGACY_ID }, p.secret));
      const reply = (await res.json()) as { confirmation_code: string };

      expect(res.status).toBe(200);
      expect(reply.confirmation_code).toMatch(/^[0-9a-f]{32}$/);
      // Whatever is scheduled right now (nothing, once the work runs inside the request).
      await expectSchedulerHoldsNone(t, [LEGACY_ID, reply.confirmation_code]);

      await t.finishAllScheduledFunctions(vi.runAllTimers);

      expect((await logById(t, lastPageRow))?.summary).toBe(legacyLine(p.label, REDACTED_META_USER, "deletion"));
      expect((await logById(t, lastPageRow2))?.summary).toBe(legacyLine(p.label, REDACTED_META_USER, "deauth"));
      expect((await logById(t, otherPlatformRow))?.summary).toBe(legacyLine(p.otherLabel, LEGACY_ID, "deletion"));
      const done = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: reply.confirmation_code });
      expect(done?.platform).toBe(p.platform);
      expect(typeof done?.completedAt).toBe("number");
      // Completed scheduled records are kept for 7 days with their arguments (Convex docs).
      await expectSchedulerHoldsNone(t, [LEGACY_ID, reply.confirmation_code]);
    });

    test("deauthorize with more than one page of rows is finished too, and no scheduler record holds the user id", async () => {
      const t = newTest();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      await seedFillerLogs(t, p.logSource, META_LOG_REDACTION_PAGE_SIZE + 3);
      const lastPageRow = await seedLegacyLog(t, p.logSource, legacyLine(p.label, LEGACY_ID, "deauth"));

      const res = await post(t, p.deauthorize, await signedRequest({ user_id: LEGACY_ID }, p.secret));
      expect(res.status).toBe(200);
      await expectSchedulerHoldsNone(t, [LEGACY_ID]);

      await t.finishAllScheduledFunctions(vi.runAllTimers);

      expect((await logById(t, lastPageRow))?.summary).toBe(legacyLine(p.label, REDACTED_META_USER, "deauth"));
      await expectSchedulerHoldsNone(t, [LEGACY_ID]);
    });

    // ─── Durable continuation (SCRUM-842 round 3) ───────────────────────────────
    //
    // The HTTP request does ONE bounded page and returns. The rest is a job row
    // advanced one page per scheduled run (the scheduled argument is the job's own
    // document id, never the Meta user id or the receipt code), so a request that
    // dies cannot strand the work and a replayed callback does not restart it.

    const jobRows = (t: T) => t.run((ctx) => ctx.db.query("metaLogRedactionJobs").collect());
    const scheduledJobRuns = async (t: T) =>
      (await scheduledRecords(t)).filter((r) => String(r.name).includes("runMetaLogRedactionJob"));

    test("a data-deletion request whose source needs three pages answers at once with a pending receipt and the work survives the request", async () => {
      const t = newTest();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      await seedFillerLogs(t, p.logSource, META_LOG_REDACTION_PAGE_SIZE * 2 + 5);
      const lastPageRow = await seedLegacyLog(t, p.logSource, legacyLine(p.label, LEGACY_ID, "deletion"));

      const res = await post(t, p.deletion, await signedRequest({ user_id: LEGACY_ID }, p.secret));
      const reply = (await res.json()) as { confirmation_code: string };

      // The request ended here, after one page. Nothing finished it yet.
      expect(res.status).toBe(200);
      expect((await logById(t, lastPageRow))?.summary).toContain(LEGACY_ID);
      const pending = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: reply.confirmation_code });
      expect(pending).toEqual({ platform: p.platform, completedAt: null });
      const jobs = await jobRows(t);
      expect(jobs).toHaveLength(1);
      expect(await scheduledJobRuns(t)).toHaveLength(1);
      await expectSchedulerHoldsNone(t, [LEGACY_ID, reply.confirmation_code]);

      // The continuation, with no further request, completes it.
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      expect((await logById(t, lastPageRow))?.summary).toBe(legacyLine(p.label, REDACTED_META_USER, "deletion"));
      const done = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: reply.confirmation_code });
      expect(typeof done?.completedAt).toBe("number");
      // One page per run: every request-sized budget was exhausted by a single page.
      expect((await scheduledJobRuns(t)).length).toBeGreaterThanOrEqual(2);
      // Nothing keeps the identifier after completion: not the job, not a receipt, not a scheduler record.
      expect(await jobRows(t)).toEqual([]);
      expect(JSON.stringify(await allDeletionRequests(t))).not.toContain(LEGACY_ID);
      await expectSchedulerHoldsNone(t, [LEGACY_ID, reply.confirmation_code]);
    });

    test("the receipt is marked complete only by the last page, never early", async () => {
      const t = newTest();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      await seedFillerLogs(t, p.logSource, META_LOG_REDACTION_PAGE_SIZE * 2 + 5);
      const res = await post(t, p.deletion, await signedRequest({ user_id: LEGACY_ID }, p.secret));
      const reply = (await res.json()) as { confirmation_code: string };
      const statusOf = () => t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: reply.confirmation_code });

      const seen: Array<number | null | undefined> = [(await statusOf())?.completedAt];
      // Step the chain one scheduled run at a time.
      for (let guard = 0; guard < 10 && (await jobRows(t)).length > 0; guard += 1) {
        await t.finishInProgressScheduledFunctions();
        vi.runOnlyPendingTimers();
        await t.finishInProgressScheduledFunctions();
        seen.push((await statusOf())?.completedAt);
      }

      expect(seen[0]).toBeNull();
      expect(typeof seen[seen.length - 1]).toBe("number");
      // Pending on every observation until the job row is gone.
      expect(seen.slice(0, -1).every((value) => value === null)).toBe(true);
      expect(await jobRows(t)).toEqual([]);
    });

    test("deauthorize with more than one page is carried by the same durable job and leaves no identifier behind", async () => {
      const t = newTest();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      await seedFillerLogs(t, p.logSource, META_LOG_REDACTION_PAGE_SIZE * 2 + 5);
      const lastPageRow = await seedLegacyLog(t, p.logSource, legacyLine(p.label, LEGACY_ID, "deauth"));

      const res = await post(t, p.deauthorize, await signedRequest({ user_id: LEGACY_ID }, p.secret));
      expect(res.status).toBe(200);
      expect(await jobRows(t)).toHaveLength(1);
      expect((await logById(t, lastPageRow))?.summary).toContain(LEGACY_ID);

      await t.finishAllScheduledFunctions(vi.runAllTimers);

      expect((await logById(t, lastPageRow))?.summary).toBe(legacyLine(p.label, REDACTED_META_USER, "deauth"));
      expect(await jobRows(t)).toEqual([]);
      await expectSchedulerHoldsNone(t, [LEGACY_ID]);
    });

    test("a source of one page never stores a job: the identifier is used inside one transaction and kept nowhere", async () => {
      const t = newTest();
      await seedLegacyLog(t, p.logSource, legacyLine(p.label, LEGACY_ID, "deletion"));

      const res = await post(t, p.deletion, await signedRequest({ user_id: LEGACY_ID }, p.secret));
      const reply = (await res.json()) as { confirmation_code: string };

      expect(await jobRows(t)).toEqual([]);
      expect(await scheduledRecords(t)).toEqual([]);
      const status = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: reply.confirmation_code });
      expect(typeof status?.completedAt).toBe("number");
    });

    test("a continuation that fails leaves the receipt pending and no identifier in any scheduler record, response or console line; the stalled-job sweep then finishes the SAME receipt", async () => {
      const t = newTest();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const consoleOutput = captureConsole();
      // Page 1 is clean; the injected failure sits on page 2; the user's own row on page 3.
      await seedFillerLogs(t, p.logSource, META_LOG_REDACTION_PAGE_SIZE);
      const poisoned = await seedLegacyLog(t, p.logSource, POISON_SUMMARY);
      await seedFillerLogs(t, p.logSource, META_LOG_REDACTION_PAGE_SIZE);
      const lastPageRow = await seedLegacyLog(t, p.logSource, legacyLine(p.label, LEGACY_ID, "deletion"));

      const res = await post(t, p.deletion, await signedRequest({ user_id: LEGACY_ID }, p.secret));
      const reply = (await res.json()) as { confirmation_code: string };
      await t.finishAllScheduledFunctions(vi.runAllTimers).catch(() => undefined);

      // Meta already has its code and the status page says "in progress": both true.
      expect(res.status).toBe(200);
      const [receipt] = await allDeletionRequests(t);
      expect(receipt?.completedAt).toBeUndefined();
      expect((await logById(t, lastPageRow))?.summary).toContain(LEGACY_ID);
      const stuck = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: reply.confirmation_code });
      expect(stuck?.completedAt).toBeNull();
      const [job] = await jobRows(t);
      expect(job).toBeDefined();
      await expectSchedulerHoldsNone(t, [LEGACY_ID, reply.confirmation_code]);
      expect(consoleOutput.join("\n")).not.toContain(LEGACY_ID);

      // A job that was advanced a moment ago is left to its own chain.
      await t.mutation(internal.metaLogRedaction.resumeStalledMetaLogRedactionJobs, {});
      expect(await scheduledJobRuns(t)).toHaveLength(1);

      // The fault is gone and the job has gone quiet: the sweep restarts it.
      await t.run((ctx) => ctx.db.patch(poisoned, { summary: "Connected for org recovered" }));
      await t.run((ctx) => ctx.db.patch(job._id, { updatedAt: Date.now() - 60 * 60 * 1000 }));
      await t.mutation(internal.metaLogRedaction.resumeStalledMetaLogRedactionJobs, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      expect((await logById(t, lastPageRow))?.summary).toBe(legacyLine(p.label, REDACTED_META_USER, "deletion"));
      const receipts = await allDeletionRequests(t);
      expect(receipts).toHaveLength(1);
      expect(typeof receipts[0]?.completedAt).toBe("number");
      expect(await jobRows(t)).toEqual([]);
      await expectSchedulerHoldsNone(t, [LEGACY_ID, reply.confirmation_code]);
    });

    test("a failure on the FIRST page rolls the whole request back: generic 500, no receipt, no job, and a replay completes", async () => {
      const t = newTest();
      captureConsole();
      const poisoned = await seedLegacyLog(t, p.logSource, POISON_SUMMARY);
      const signed = await signedRequest({ user_id: LEGACY_ID }, p.secret);

      const failed = await post(t, p.deletion, signed);

      expect(failed.status).toBe(500);
      expect(await failed.text()).toBe("An unexpected error occurred. Please try again later.");
      expect(await allDeletionRequests(t)).toEqual([]);
      expect(await jobRows(t)).toEqual([]);

      await t.run((ctx) => ctx.db.patch(poisoned, { summary: "Connected for org recovered" }));
      const replay = await post(t, p.deletion, signed);
      expect(replay.status).toBe(200);
      expect(await jobRows(t)).toEqual([]);
    });

    test("a deauthorize whose first page fails answers a generic 500 and stores no job", async () => {
      const t = newTest();
      const consoleOutput = captureConsole();
      await seedLegacyLog(t, p.logSource, POISON_SUMMARY);

      const res = await post(t, p.deauthorize, await signedRequest({ user_id: LEGACY_ID }, p.secret));

      expect(res.status).toBe(500);
      expect(await res.text()).not.toContain(LEGACY_ID);
      expect(await jobRows(t)).toEqual([]);
      expect(consoleOutput.join("\n")).not.toContain(LEGACY_ID);
    });
  });
  describe("admin reader", () => {
    const adminReader = async (t: T) => {
      await t.run((ctx) => ctx.db.insert("users", { clerkId: "admin_clerk", email: ADMIN_EMAIL }));
      return t.withIdentity({ subject: "admin_clerk" });
    };
    const summaries = async (t: T) => {
      const admin = await adminReader(t);
      const result = await admin.query(api.adminSystem.listWebhookLogs, { paginationOpts: { numItems: 50, cursor: null } });
      return result.page.map((row) => ({ source: row.source, summary: row.summary }));
    };

    test("a row the redaction has not reached never leaves the backend with a Meta user id", async () => {
      const t = newTest();
      await seedLegacyLog(t, "facebook-oauth", legacyLine("Facebook", LEGACY_ID, "deletion"));
      await seedLegacyLog(t, "instagram-oauth", legacyLine("Instagram", LEGACY_ID, "deauth"));
      await seedLegacyLog(t, "facebook", `Deauthorized by Facebook user ${LEGACY_ID}`);
      await seedLegacyLog(t, "instagram", `Data deletion requested by Instagram user ${LEGACY_ID}`);

      const rows = await summaries(t);

      expect(rows).toHaveLength(4);
      expect(JSON.stringify(rows)).not.toContain(LEGACY_ID);
      expect(rows.every((row) => row.summary.includes(REDACTED_META_USER))).toBe(true);
    });

    test("the mask changes only the reply: the stored row is untouched, other text stays, other sources stay", async () => {
      const t = newTest();
      const stored = legacyLine("Facebook", LEGACY_ID, "deletion");
      const rowId = await seedLegacyLog(t, "facebook-oauth", stored);
      await seedLegacyLog(t, "clerk", `user.created ${LEGACY_ID}`);
      await seedLegacyLog(t, "facebook-oauth", "Connected for org jd7abc123def456ghi789jkl012mno3");
      await seedLegacyLog(t, "instagram-oauth", "Instagram token refresh cron: refreshed 3/10 token(s) in this page.");

      const rows = await summaries(t);

      expect(rows.find((row) => row.source === "clerk")?.summary).toBe(`user.created ${LEGACY_ID}`);
      expect(rows.map((row) => row.summary)).toContain("Connected for org jd7abc123def456ghi789jkl012mno3");
      expect(rows.map((row) => row.summary)).toContain("Instagram token refresh cron: refreshed 3/10 token(s) in this page.");
      expect(rows.map((row) => row.summary)).toContain(legacyLine("Facebook", REDACTED_META_USER, "deletion"));
      expect((await logById(t, rowId))?.summary).toBe(stored);
    });

    test("the 'IG account <id>' row of a failed subscription is masked in the summary and the error, and the stored row is untouched", async () => {
      const t = newTest();
      const rowId = await t.run((ctx) =>
        ctx.db.insert("webhookLogs", {
          source: "instagram",
          status: "error",
          summary: `subscribed_apps failed for IG account ${LEGACY_ID}`,
          error: `Invalid OAuth access token for object ${LEGACY_ID}`,
          createdAt: Date.now(),
        }),
      );
      const admin = await adminReader(t);

      const result = await admin.query(api.adminSystem.listWebhookLogs, { paginationOpts: { numItems: 50, cursor: null } });

      expect(JSON.stringify(result.page)).not.toContain(LEGACY_ID);
      expect(result.page[0].summary).toBe(`subscribed_apps failed for IG account ${REDACTED_META_USER}`);
      expect(result.page[0].error).toBe(`Invalid OAuth access token for object ${REDACTED_META_USER}`);
      expect((await t.run((ctx) => ctx.db.get(rowId)))?.summary).toContain(LEGACY_ID);
    });

    test("the error of a Meta-source row is masked, and a row with no error stays without one", async () => {
      const t = newTest();
      for (const source of ["facebook-oauth", "instagram-oauth", "facebook", "instagram"]) {
        await t.run((ctx) =>
          ctx.db.insert("webhookLogs", { source: source as never, status: "error", summary: "x", error: `boom ${LEGACY_ID}`, createdAt: Date.now() }),
        );
      }
      await seedLegacyLog(t, "clerk", "no error here");
      const admin = await adminReader(t);

      const result = await admin.query(api.adminSystem.listWebhookLogs, { paginationOpts: { numItems: 50, cursor: null } });

      expect(JSON.stringify(result.page)).not.toContain(LEGACY_ID);
      expect(result.page.filter((row) => row.error !== undefined)).toHaveLength(4);
      expect(result.page.find((row) => row.source === "clerk")?.error).toBeUndefined();
    });
    test("a row that is already redacted is returned as it is", async () => {
      const t = newTest();
      await seedLegacyLog(t, "facebook-oauth", legacyLine("Facebook", REDACTED_META_USER, "deletion"));

      expect((await summaries(t))[0].summary).toBe(legacyLine("Facebook", REDACTED_META_USER, "deletion"));
    });
  });
});
