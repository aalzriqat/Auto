import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getDocumentSize } from "convex/values";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getValidatedEnv } from "./utils/env";
import type { MutationCtx } from "./_generated/server";
import { META_LOG_REDACTION_WEDGED_AFTER_RESTARTS, redactOneStep } from "./metaLogRedaction";
import {
  META_LOG_REDACTION_MAX_BYTES_READ,
  META_LOG_REDACTION_PAGE_SIZE,
  REDACTED_META_USER,
} from "./utils/metaUserIdRedaction";

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
    redactMetaUserIdInText: (text: string, metaUserId: string, ...rest: [replacement?: string]) => {
      if (text === "POISON-ROW-842") throw new Error("injected page failure");
      return actual.redactMetaUserIdInText(text, metaUserId, ...rest);
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
type PlatformCase = (typeof PLATFORMS)[number];

const PLATFORMS: Array<{
  platform: Platform;
  otherPlatform: Platform;
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
    otherPlatform: "instagram",
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
    otherPlatform: "facebook",
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

/** Scheduled functions fire only when a test drains them (`finishAllScheduledFunctions(vi.runAllTimers)`). */
const useScheduledTimers = () =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });

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
    // Every callback leaves a redaction job scheduled (there is always a second
    // source to walk). Fake timers keep it from firing after the test ends.
    useScheduledTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // The four callbacks (two platforms, two routes) each have their own literal test title, so that the
  // SCRUM-761 regression library can bind one record to each (a parameterized title cannot be bound).
  async function theUserIdIsInNoLogResponseRequestOrConsole(p: PlatformCase, path: string) {
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
  }

  test("Facebook deauthorize: the Meta user id is in no log row, response, stored request or console output", () =>
    theUserIdIsInNoLogResponseRequestOrConsole(PLATFORMS[0], PLATFORMS[0].deauthorize));
  test("Facebook data-deletion: the Meta user id is in no log row, response, stored request or console output", () =>
    theUserIdIsInNoLogResponseRequestOrConsole(PLATFORMS[0], PLATFORMS[0].deletion));
  test("Instagram deauthorize: the Meta user id is in no log row, response, stored request or console output", () =>
    theUserIdIsInNoLogResponseRequestOrConsole(PLATFORMS[1], PLATFORMS[1].deauthorize));
  test("Instagram data-deletion: the Meta user id is in no log row, response, stored request or console output", () =>
    theUserIdIsInNoLogResponseRequestOrConsole(PLATFORMS[1], PLATFORMS[1].deletion));

  async function theConfirmationCodeIsOpaqueAndAnswersWithThisPlatform(p: PlatformCase) {
    const t = newTest();
    await seedConnectedOrg(t, p.platform);
    const signed = await signedRequest({ user_id: META_USER_ID }, p.secret);

    const first = (await (await post(t, p.deletion, signed)).json()) as { url: string; confirmation_code: string };
    const second = (await (await post(t, p.deletion, signed)).json()) as { url: string; confirmation_code: string };
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    for (const reply of [first, second]) {
      expect(reply.confirmation_code).toMatch(/^[0-9a-f]{32}$/);
      expect(reply.url).toBe(`https://app.test/data-deletion-status?id=${reply.confirmation_code}`);
      const status = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: reply.confirmation_code });
      expect(status?.platform).toBe(p.platform);
      expect(typeof status?.completedAt).toBe("number");
      // Still no user id, token or anything linking the code to a person: the platform, the
      // time, and whether a connection was found (a boolean).
      expect(Object.keys(status ?? {}).sort()).toEqual(["completedAt", "connectionRemoved", "platform"]);
    }
    expect(second.confirmation_code).not.toBe(first.confirmation_code);
  }

  test("Facebook data-deletion: the confirmation code is opaque, unique per request, and answers the status URL with this platform", () =>
    theConfirmationCodeIsOpaqueAndAnswersWithThisPlatform(PLATFORMS[0]));
  test("Instagram data-deletion: the confirmation code is opaque, unique per request, and answers the status URL with this platform", () =>
    theConfirmationCodeIsOpaqueAndAnswersWithThisPlatform(PLATFORMS[1]));

  describe.each(PLATFORMS)("$label", (p) => {
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
    useScheduledTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── Every source that can hold the id (SCRUM-842 round 4, Seat 2 HIGH) ───────
  //
  // The OAuth callback source is not the only `webhookLogs` source a Meta user id
  // was written to: the `instagram` / `facebook` sources carry the Instagram
  // "subscribed_apps failed for IG account <id>" rows and the auto-reply
  // failures. A receipt that reads "processed" while those rows keep the id is a
  // false statement on the public status page.
  async function aCompletedDeletionLeavesNoCopyInThePlatformsOwnWebhookRows(p: PlatformCase) {
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
  }

  test("Facebook: a completed signed deletion leaves no copy of the id in the platform's own webhook-source rows", () =>
    aCompletedDeletionLeavesNoCopyInThePlatformsOwnWebhookRows(PLATFORMS[0]));
  test("Instagram: a completed signed deletion leaves no copy of the id in the platform's own webhook-source rows", () =>
    aCompletedDeletionLeavesNoCopyInThePlatformsOwnWebhookRows(PLATFORMS[1]));

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
    test("only the signed user's identifier is touched: another user, a longer id, an unrelated source and the other platform's sources stay as written", async () => {
      const t = newTest();
      const other = await seedLegacyLog(t, p.logSource, legacyLine(p.label, OTHER_ID, "deletion"));
      const longer = await seedLegacyLog(t, p.logSource, legacyLine(p.label, LONGER_ID, "deauth"));
      const otherWebhookUser = await seedLegacyLog(t, p.platform, `Auto-reply DM to ${OTHER_ID} failed`, "error");
      const longerWebhookUser = await seedLegacyLog(t, p.platform, `DM from ${LONGER_ID}`);
      // A source no Meta callback writes the id to: not walked, so left exactly as written.
      const unrelatedSource = await seedLegacyLog(t, "whatsapp", `Note ${LEGACY_ID}`);
      const otherPlatformOauth = await seedLegacyLog(t, p.otherLogSource, legacyLine(p.otherLabel, LEGACY_ID, "deletion"));
      const otherPlatformWebhook = await seedLegacyLog(t, p.otherPlatform, `DM from ${LEGACY_ID}`);

      await post(t, p.deletion, await signedRequest({ user_id: LEGACY_ID }, p.secret));
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      expect((await logById(t, other))?.summary).toBe(legacyLine(p.label, OTHER_ID, "deletion"));
      expect((await logById(t, longer))?.summary).toBe(legacyLine(p.label, LONGER_ID, "deauth"));
      expect((await logById(t, otherWebhookUser))?.summary).toBe(`Auto-reply DM to ${OTHER_ID} failed`);
      expect((await logById(t, longerWebhookUser))?.summary).toBe(`DM from ${LONGER_ID}`);
      expect((await logById(t, unrelatedSource))?.summary).toBe(`Note ${LEGACY_ID}`);
      expect((await logById(t, otherPlatformOauth))?.summary).toBe(legacyLine(p.otherLabel, LEGACY_ID, "deletion"));
      expect((await logById(t, otherPlatformWebhook))?.summary).toBe(`DM from ${LEGACY_ID}`);
    });

    test("it is idempotent: a second callback for the same user changes nothing more and both receipts complete", async () => {
      const t = newTest();
      const rowId = await seedLegacyLog(t, p.logSource, legacyLine(p.label, LEGACY_ID, "deletion"));
      const webhookRowId = await seedLegacyLog(t, p.platform, `DM from ${LEGACY_ID}`);
      const signed = await signedRequest({ user_id: LEGACY_ID }, p.secret);

      const first = (await (await post(t, p.deletion, signed)).json()) as { confirmation_code: string };
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const afterFirst = [await logById(t, rowId), await logById(t, webhookRowId)];
      const second = (await (await post(t, p.deletion, signed)).json()) as { confirmation_code: string };
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      expect([await logById(t, rowId), await logById(t, webhookRowId)]).toEqual(afterFirst);
      for (const reply of [first, second]) {
        const status = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: reply.confirmation_code });
        expect(typeof status?.completedAt).toBe("number");
      }
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
      // No connection is seeded for this id, so the receipt says none was found.
      expect(pending).toEqual({ platform: p.platform, completedAt: null, connectionRemoved: false });
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

    test("a deletion whose sources are each one page still walks both: the receipt waits for the second source, and nothing keeps the id afterwards", async () => {
      const t = newTest();
      await seedLegacyLog(t, p.logSource, legacyLine(p.label, LEGACY_ID, "deletion"));
      await seedLegacyLog(t, p.platform, `DM from ${LEGACY_ID}`);

      const res = await post(t, p.deletion, await signedRequest({ user_id: LEGACY_ID }, p.secret));
      const reply = (await res.json()) as { confirmation_code: string };

      // The callback source is done, the platform's own source is not: not complete yet.
      const [job] = await jobRows(t);
      expect(job?.sourceIndex).toBe(1);
      expect(job?.cursor).toBeNull();
      const pending = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: reply.confirmation_code });
      expect(pending?.completedAt).toBeNull();

      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const done = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: reply.confirmation_code });
      expect(typeof done?.completedAt).toBe("number");
      expect(await jobRows(t)).toEqual([]);
      expect(JSON.stringify(await allWebhookLogs(t))).not.toContain(LEGACY_ID);
      await expectSchedulerHoldsNone(t, [LEGACY_ID, reply.confirmation_code]);
    });

    test("the walk crosses from one source to the next: the id sits only on the last page of the platform's own source, and the receipt is pending on every observation until then", async () => {
      const t = newTest();
      await seedLegacyLog(t, p.logSource, legacyLine(p.label, OTHER_ID, "deletion"));
      await seedFillerLogs(t, p.platform, META_LOG_REDACTION_PAGE_SIZE * 2 + 5);
      const lastRow = await seedLegacyLog(t, p.platform, `Auto-reply DM to ${LEGACY_ID} failed`, "error");

      const res = await post(t, p.deletion, await signedRequest({ user_id: LEGACY_ID }, p.secret));
      const reply = (await res.json()) as { confirmation_code: string };
      const statusOf = () => t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: reply.confirmation_code });

      const seenPositions: Array<string> = [];
      const seenCompletion: Array<number | null | undefined> = [(await statusOf())?.completedAt];
      for (let guard = 0; guard < 12 && (await jobRows(t)).length > 0; guard += 1) {
        const [job] = await jobRows(t);
        seenPositions.push(`${job?.sourceIndex}:${job?.cursor === null ? "start" : "mid"}`);
        await t.finishInProgressScheduledFunctions();
        vi.runOnlyPendingTimers();
        await t.finishInProgressScheduledFunctions();
        seenCompletion.push((await statusOf())?.completedAt);
      }

      // Source 1 was entered at its start and then paged through before the job ended.
      expect(seenPositions[0]).toBe("1:start");
      expect(seenPositions).toContain("1:mid");
      expect((await logById(t, lastRow))?.summary).toBe(`Auto-reply DM to ${REDACTED_META_USER} failed`);
      expect(seenCompletion[0]).toBeNull();
      expect(typeof seenCompletion[seenCompletion.length - 1]).toBe("number");
      expect(seenCompletion.slice(0, -1).every((value) => value === null)).toBe(true);
      expect(await jobRows(t)).toEqual([]);
    });

    test("the stored webhook body is redacted too: rawPayload and payloadPreview of a delivery-inbox row lose the id and keep their hash and event id", async () => {
      const t = newTest();
      const body = (id: string) => JSON.stringify({ object: p.platform, entry: [{ id, messaging: [{ sender: { id: OTHER_ID } }] }] });
      const rowId = await t.run((ctx) =>
        ctx.db.insert("webhookLogs", {
          source: p.platform,
          status: "success",
          summary: "Batch with 1 entries",
          eventId: "synthetic-event-sha",
          payloadSha256: "synthetic-event-sha",
          rawPayload: body(LEGACY_ID),
          payloadPreview: body(LEGACY_ID),
          payloadTruncated: false,
          createdAt: Date.now(),
        }),
      );

      await post(t, p.deletion, await signedRequest({ user_id: LEGACY_ID }, p.secret));
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const row = await logById(t, rowId);
      expect(row?.rawPayload).toBe(body(REDACTED_META_USER));
      expect(row?.payloadPreview).toBe(body(REDACTED_META_USER));
      // The other user named in the same body is not the signed user.
      expect(row?.rawPayload).toContain(OTHER_ID);
      expect(row?.eventId).toBe("synthetic-event-sha");
      expect(row?.payloadSha256).toBe("synthetic-event-sha");
      expect(row?.summary).toBe("Batch with 1 entries");
    });

    test("running the same job more than once, in any order, skips no page and completes once", async () => {
      const t = newTest();
      await seedFillerLogs(t, p.logSource, META_LOG_REDACTION_PAGE_SIZE + 5);
      await seedFillerLogs(t, p.platform, META_LOG_REDACTION_PAGE_SIZE);
      const lastRow = await seedLegacyLog(t, p.platform, `Auto-reply DM to ${LEGACY_ID} failed`, "error");
      await post(t, p.deletion, await signedRequest({ user_id: LEGACY_ID }, p.secret));
      const [job] = await jobRows(t);
      expect(job).toBeDefined();

      // A sweep restart racing the live chain: extra direct runs, each from the stored position.
      for (let i = 0; i < 3; i += 1) {
        await t.mutation(internal.metaLogRedaction.runMetaLogRedactionJob, { jobId: job._id });
      }
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      // And a run for a job that no longer exists is a no-op.
      await t.mutation(internal.metaLogRedaction.runMetaLogRedactionJob, { jobId: job._id });

      expect((await logById(t, lastRow))?.summary).toBe(`Auto-reply DM to ${REDACTED_META_USER} failed`);
      const receipts = await allDeletionRequests(t);
      expect(receipts).toHaveLength(1);
      expect(typeof receipts[0]?.completedAt).toBe("number");
      expect(await jobRows(t)).toEqual([]);
    });

    test("a stored position outside the source list fails the run: the receipt stays pending and the job stays", async () => {
      const t = newTest();
      const res = await post(t, p.deletion, await signedRequest({ user_id: LEGACY_ID }, p.secret));
      const reply = (await res.json()) as { confirmation_code: string };
      const [job] = await jobRows(t);
      await t.run((ctx) => ctx.db.patch(job._id, { sourceIndex: 9 }));

      await expect(t.mutation(internal.metaLogRedaction.runMetaLogRedactionJob, { jobId: job._id })).rejects.toThrow(
        "outside the source list",
      );

      expect(await jobRows(t)).toHaveLength(1);
      const status = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: reply.confirmation_code });
      expect(status?.completedAt).toBeNull();
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
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await jobRows(t)).toEqual([]);
      const [receipt] = await allDeletionRequests(t);
      expect(typeof receipt?.completedAt).toBe("number");
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

describe("SCRUM-842 redaction step guards", () => {
  // convex-test only reports a page status when a byte or row budget is passed, and
  // the stand-in lets each Convex answer be driven exactly: the page, and what the
  // step asked for.
  const START = { sourceIndex: 0, cursor: null, pageSize: META_LOG_REDACTION_PAGE_SIZE };
  function contextReturning(page: Record<string, unknown>) {
    const asked: Array<Record<string, unknown>> = [];
    const patch = vi.fn();
    const ctx = {
      db: {
        query: () => ({ withIndex: () => ({ paginate: async (options: Record<string, unknown>) => (asked.push(options), page) }) }),
        patch,
      },
    } as unknown as MutationCtx;
    return { ctx, asked, patch };
  }
  const naming = (id: string) => ({ _id: "row-1", summary: `Auto-reply DM to ${id} failed` });

  test("every page is asked for with a byte budget below the 16 MiB a transaction may read", async () => {
    const { ctx, asked } = contextReturning({ page: [], isDone: true, continueCursor: "", pageStatus: null });

    await redactOneStep(ctx, "instagram", [LEGACY_ID], START);

    expect(asked).toEqual([
      { numItems: META_LOG_REDACTION_PAGE_SIZE, cursor: null, maximumBytesRead: META_LOG_REDACTION_MAX_BYTES_READ },
    ]);
    expect(META_LOG_REDACTION_MAX_BYTES_READ).toBeLessThan(16 * 1024 * 1024);
  });

  test("a page that reached the byte budget is not written and not walked past: the same cursor comes back at half the size", async () => {
    const { ctx, patch } = contextReturning({
      page: [naming(LEGACY_ID)],
      isDone: false,
      continueCursor: "next",
      pageStatus: "SplitRequired",
    });

    await expect(redactOneStep(ctx, "instagram", [LEGACY_ID], { sourceIndex: 1, cursor: "here", pageSize: 100 })).resolves.toEqual({
      done: false,
      next: { sourceIndex: 1, cursor: "here", pageSize: 50 },
    });
    expect(patch).not.toHaveBeenCalled();
  });

  test("halving stops at one row, and a one-row page that still reaches the budget fails instead of moving on", async () => {
    const { ctx, patch } = contextReturning({ page: [], isDone: false, continueCursor: "next", pageStatus: "SplitRequired" });

    await expect(redactOneStep(ctx, "instagram", [LEGACY_ID], { sourceIndex: 0, cursor: null, pageSize: 3 })).resolves.toMatchObject({
      next: { pageSize: 1 },
    });
    await expect(redactOneStep(ctx, "instagram", [LEGACY_ID], { sourceIndex: 0, cursor: null, pageSize: 1 })).rejects.toThrow(
      "cut short by the read limit even at one row",
    );
    expect(patch).not.toHaveBeenCalled();
  });

  test("a page Convex only recommends splitting is complete: it is redacted and walked on", async () => {
    const { ctx, patch } = contextReturning({
      page: [naming(LEGACY_ID)],
      isDone: false,
      continueCursor: "next",
      pageStatus: "SplitRecommended",
    });

    await expect(redactOneStep(ctx, "instagram", [LEGACY_ID], { sourceIndex: 1, cursor: "here", pageSize: 100 })).resolves.toMatchObject({
      done: false,
      next: { sourceIndex: 1, cursor: "next" },
    });
    expect(patch).toHaveBeenCalledWith("row-1", { summary: `Auto-reply DM to ${REDACTED_META_USER} failed` });
  });

  test("every id of the account is redacted from a row, not only the first", async () => {
    const { ctx, patch } = contextReturning({
      page: [{ _id: "row-1", summary: `Instagram account ${OTHER_ID} and ${LEGACY_ID}`, rawPayload: `{"id":"${OTHER_ID}"}` }],
      isDone: true,
      continueCursor: "",
      pageStatus: null,
    });

    await redactOneStep(ctx, "instagram", [LEGACY_ID, OTHER_ID], { sourceIndex: 1, cursor: null, pageSize: 100 });

    expect(patch).toHaveBeenCalledWith("row-1", {
      summary: `Instagram account ${REDACTED_META_USER} and ${REDACTED_META_USER}`,
      rawPayload: `{"id":"${REDACTED_META_USER}"}`,
    });
  });

  test("the end of the first source moves to the second, and the end of the last source ends the walk", async () => {
    const { ctx: ended } = contextReturning({ page: [], isDone: true, continueCursor: "", pageStatus: null });

    await expect(redactOneStep(ended, "facebook", [LEGACY_ID], { sourceIndex: 0, cursor: "x", pageSize: 100 })).resolves.toEqual({
      done: false,
      next: { sourceIndex: 1, cursor: null, pageSize: META_LOG_REDACTION_PAGE_SIZE },
    });
    await expect(redactOneStep(ended, "facebook", [LEGACY_ID], { sourceIndex: 1, cursor: "x", pageSize: 100 })).resolves.toEqual({
      done: true,
    });
  });
});
// ─── An Instagram account has two ids (SCRUM-842 round 5, Seat 1) ─────────────────
//
// The deauthorize / data-deletion callbacks name the business account id
// (`instagramBusinessAccountId`). The webhook bodies carry a DIFFERENT id in
// `entry[].id`, stored as `instagramWebhookAccountId` and cleared by the disconnect.
// A receipt that says "processed" must leave neither id behind.

describe("SCRUM-842 an Instagram account has two ids", () => {
  const BUSINESS_ID = "17841400000000842";
  const WEBHOOK_ID = "17841400000099842";
  const UNRELATED_BUSINESS_ID = "17841400000011111";
  const UNRELATED_WEBHOOK_ID = "17841400000022222";
  let consoleOutput: string[];

  beforeEach(() => {
    consoleOutput = captureConsole();
    useScheduledTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const seedAccount = (t: T, businessId: string, webhookId: string) =>
    t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", { name: "Synthetic Org", createdAt: Date.now() });
      await ctx.db.insert("orgSettings", {
        orgId,
        currency: "JOD",
        currencySymbol: "JD",
        enabledPaymentTypes: [],
        instagramBusinessAccountId: businessId,
        instagramWebhookAccountId: webhookId,
        instagramAccessToken: "synthetic-ig-token-842",
        instagramPageName: "synthetic_ig",
      });
      return orgId;
    });

  const webhookBody = (entryId: string) =>
    JSON.stringify({ object: "instagram", entry: [{ id: entryId, messaging: [{ sender: { id: OTHER_ID } }] }] });

  async function seedInstagramRows(t: T, businessId: string, webhookId: string) {
    const inbox = await t.run((ctx) =>
      ctx.db.insert("webhookLogs", {
        source: "instagram",
        status: "success",
        summary: "Batch with 1 entries",
        eventId: "synthetic-event-sha",
        payloadSha256: "synthetic-event-sha",
        rawPayload: webhookBody(webhookId),
        payloadPreview: webhookBody(webhookId),
        payloadTruncated: false,
        createdAt: Date.now(),
      }),
    );
    const ambiguous = await seedLegacyLog(
      t,
      "instagram",
      `Instagram account ${webhookId} is connected to more than one org; entry skipped`,
      "error",
    );
    const subscription = await seedLegacyLog(t, "instagram", `subscribed_apps failed for IG account ${businessId}`, "error");
    const oauth = await seedLegacyLog(t, "instagram-oauth", legacyLine("Instagram", businessId, "deletion"));
    return { inbox, ambiguous, subscription, oauth };
  }

  async function theWebhookAccountIdIsRedactedEverywhere(path: string) {
    const t = newTest();
    await seedAccount(t, BUSINESS_ID, WEBHOOK_ID);
    await seedAccount(t, UNRELATED_BUSINESS_ID, UNRELATED_WEBHOOK_ID);
    const mine = await seedInstagramRows(t, BUSINESS_ID, WEBHOOK_ID);
    const theirs = await seedInstagramRows(t, UNRELATED_BUSINESS_ID, UNRELATED_WEBHOOK_ID);

    const res = await post(t, path, await signedRequest({ user_id: BUSINESS_ID }, INSTAGRAM_SECRET));
    expect(res.status).toBe(200);
    const code = path.endsWith("data-deletion") ? ((await res.json()) as { confirmation_code: string }).confirmation_code : null;
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const stored = JSON.stringify(await allWebhookLogs(t));
    expect(stored).not.toContain(BUSINESS_ID);
    expect(stored).not.toContain(WEBHOOK_ID);
    const inbox = await logById(t, mine.inbox);
    expect(inbox?.rawPayload).toBe(webhookBody(REDACTED_META_USER));
    expect(inbox?.payloadPreview).toBe(webhookBody(REDACTED_META_USER));
    expect(inbox?.eventId).toBe("synthetic-event-sha");
    expect(inbox?.payloadSha256).toBe("synthetic-event-sha");
    expect((await logById(t, mine.ambiguous))?.summary).toBe(
      `Instagram account ${REDACTED_META_USER} is connected to more than one org; entry skipped`,
    );
    // Another dealer's account is a different person: not one byte of it moves.
    expect((await logById(t, theirs.inbox))?.rawPayload).toBe(webhookBody(UNRELATED_WEBHOOK_ID));
    expect((await logById(t, theirs.ambiguous))?.summary).toContain(UNRELATED_WEBHOOK_ID);
    expect((await logById(t, theirs.oauth))?.summary).toContain(UNRELATED_BUSINESS_ID);

    expect(await t.run((ctx) => ctx.db.query("metaLogRedactionJobs").collect())).toEqual([]);
    if (code !== null) {
      const status = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code });
      expect(typeof status?.completedAt).toBe("number");
    }
    await expectSchedulerHoldsNone(t, [BUSINESS_ID, WEBHOOK_ID, ...(code ? [code] : [])]);
    expect(JSON.stringify(await allDeletionRequests(t))).not.toContain(WEBHOOK_ID);
    expect(consoleOutput.join("\n")).not.toContain(WEBHOOK_ID);
    expect(consoleOutput.join("\n")).not.toContain(BUSINESS_ID);
  }

  test("Instagram deauthorize: the webhook account id is redacted from every stored webhook row, summary and job, not only the id the callback named", () =>
    theWebhookAccountIdIsRedactedEverywhere("/instagram-deauthorize"));
  test("Instagram data-deletion: the webhook account id is redacted from every stored webhook row, summary and job, not only the id the callback named", () =>
    theWebhookAccountIdIsRedactedEverywhere("/instagram-data-deletion"));

  test("the receipt is not complete while the webhook account id is still in a stored row", async () => {
    const t = newTest();
    await seedAccount(t, BUSINESS_ID, WEBHOOK_ID);
    const mine = await seedInstagramRows(t, BUSINESS_ID, WEBHOOK_ID);

    const res = await post(t, "/instagram-data-deletion", await signedRequest({ user_id: BUSINESS_ID }, INSTAGRAM_SECRET));
    const { confirmation_code } = (await res.json()) as { confirmation_code: string };

    // The callback source is walked inline; the platform's own source is not yet.
    expect((await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: confirmation_code }))?.completedAt).toBeNull();
    expect((await logById(t, mine.inbox))?.rawPayload).toContain(WEBHOOK_ID);

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await logById(t, mine.inbox))?.rawPayload).not.toContain(WEBHOOK_ID);
  });

  test("a callback that names the webhook account id still erases the business account id of the same account", async () => {
    const t = newTest();
    await seedAccount(t, BUSINESS_ID, WEBHOOK_ID);
    const mine = await seedInstagramRows(t, BUSINESS_ID, WEBHOOK_ID);

    const res = await post(t, "/instagram-deauthorize", await signedRequest({ user_id: WEBHOOK_ID }, INSTAGRAM_SECRET));
    expect(res.status).toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const stored = JSON.stringify(await allWebhookLogs(t));
    expect(stored).not.toContain(BUSINESS_ID);
    expect(stored).not.toContain(WEBHOOK_ID);
    expect((await logById(t, mine.subscription))?.summary).toBe(`subscribed_apps failed for IG account ${REDACTED_META_USER}`);
  });

  test("the disconnect reads the other ids of the account before it clears them, and the account's settings are cleared", async () => {
    const t = newTest();
    const orgId = await seedAccount(t, BUSINESS_ID, WEBHOOK_ID);

    const read = await t.mutation(internal.socialIntegrations.disconnectByInstagramUserId, {
      instagramBusinessAccountId: BUSINESS_ID,
    });

    expect(read).toEqual([WEBHOOK_ID]);
    const settings = await settingsOf(t, orgId);
    expect(settings?.instagramBusinessAccountId).toBeUndefined();
    expect(settings?.instagramWebhookAccountId).toBeUndefined();
    expect(settings?.instagramAccessToken).toBeUndefined();
    // Nothing connected under this id any more: nothing to read, nothing to fail.
    await expect(
      t.mutation(internal.socialIntegrations.disconnectByInstagramUserId, { instagramBusinessAccountId: BUSINESS_ID }),
    ).resolves.toEqual([]);
  });
});

// ─── Pages are bounded by bytes, not only by rows (SCRUM-842 round 5, Seat 2 HIGH) ─
//
// A delivery-inbox row keeps the webhook body (up to 700,000 characters). A page of
// 100 such rows reads far more than the 16 MiB a transaction may read, so the run
// threw, the cursor never moved and the cron retried the same failing page for ever
// while the receipt stayed pending. These tests enforce Convex's real transaction
// limits in convex-test (`transactionLimits: true`: 16 MiB read, 16 MiB written).
// That is the harness's model of the limits, not a deployment.

describe("SCRUM-842 large webhook bodies cannot wedge the redaction", () => {
  const BIG_BODY_CHARS = 650_000;
  const BIG_ROWS = 30; // 30 x ~650 KB is well past 16 MiB, so a 100-row page cannot fit
  const limitedTest = () =>
    convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { transactionLimits: true });

  beforeEach(() => {
    captureConsole();
    useScheduledTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Counts the stored bodies that name `id`, that carry the redaction text, and that name
   * `other`, reading a few large rows per transaction (the test's own reads obey the limit too).
   */
  async function bodyReport(t: T, id: string) {
    const report = { named: 0, redacted: 0, otherUser: 0, total: 0 };
    let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard += 1) {
      const result: { page: Array<{ rawPayload?: string; payloadPreview?: string }>; isDone: boolean; continueCursor: string } =
        await t.run((ctx) => ctx.db.query("webhookLogs").paginate({ numItems: 8, cursor }));
      for (const row of result.page) {
        const text = `${row.rawPayload ?? ""}${row.payloadPreview ?? ""}`;
        report.total += 1;
        if (text.includes(id)) report.named += 1;
        if (text.includes(REDACTED_META_USER)) report.redacted += 1;
        if (text.includes(OTHER_ID)) report.otherUser += 1;
      }
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    return report;
  }

  /** Big webhook bodies in batches that fit one write transaction; every `plantEvery`-th names the user. */
  async function seedBigBodies(t: T, source: string, platform: Platform, id: string, plantEvery: number) {
    const planted: Array<Id<"webhookLogs">> = [];
    for (let batch = 0; batch < BIG_ROWS; batch += 10) {
      await t.run(async (ctx) => {
        for (let i = batch; i < batch + 10; i += 1) {
          const named = i % plantEvery === 0;
          const head = JSON.stringify({ object: platform, entry: [{ id: named ? id : OTHER_ID }] });
          const body = head + "x".repeat(BIG_BODY_CHARS - head.length);
          const rowId = await ctx.db.insert("webhookLogs", {
            source: source as never,
            status: "success",
            summary: `Batch ${i}`,
            eventId: `big-event-${source}-${i}`,
            rawPayload: body,
            payloadPreview: head,
            payloadTruncated: false,
            createdAt: Date.now(),
          });
          if (named) planted.push(rowId);
        }
      });
    }
    return planted;
  }

  // One literal title per platform so that the SCRUM-761 regression library can bind a record to each.
  async function aSourceOfLargeBodiesIsRedactedToTheEnd(p: PlatformCase) {
    const t = limitedTest();
    const planted = await seedBigBodies(t, p.platform, p.platform, LEGACY_ID, 7);
    expect(planted.length).toBeGreaterThan(3);

    const res = await post(t, p.deletion, await signedRequest({ user_id: LEGACY_ID }, p.secret));
    expect(res.status).toBe(200);
    const { confirmation_code } = (await res.json()) as { confirmation_code: string };
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const report = await bodyReport(t, LEGACY_ID);
    expect(report.named).toBe(0);
    expect(report.redacted).toBe(planted.length);
    // Rows of another user keep their bodies as written.
    expect(report.otherUser).toBe(BIG_ROWS - planted.length);
    const status = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: confirmation_code });
    expect(typeof status?.completedAt).toBe("number");
    expect(await t.run((ctx) => ctx.db.query("metaLogRedactionJobs").collect())).toEqual([]);
  }

  async function aPageOfLargeBodiesIsHalvedAndTheReceiptStaysPending(p: PlatformCase) {
    const t = limitedTest();
    await seedBigBodies(t, p.platform, p.platform, LEGACY_ID, 1);
    const res = await post(t, p.deletion, await signedRequest({ user_id: LEGACY_ID }, p.secret));
    const { confirmation_code } = (await res.json()) as { confirmation_code: string };
    const [before] = await t.run((ctx) => ctx.db.query("metaLogRedactionJobs").collect());
    expect(before).toMatchObject({ sourceIndex: 1, cursor: null, pageSize: META_LOG_REDACTION_PAGE_SIZE });

    await t.mutation(internal.metaLogRedaction.runMetaLogRedactionJob, { jobId: before._id });

    const [after] = await t.run((ctx) => ctx.db.query("metaLogRedactionJobs").collect());
    expect(after).toMatchObject({ sourceIndex: 1, cursor: null, pageSize: META_LOG_REDACTION_PAGE_SIZE / 2 });
    expect((await bodyReport(t, LEGACY_ID)).named).toBe(BIG_ROWS);
    const status = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: confirmation_code });
    expect(status?.completedAt).toBeNull();
  }

  test("Facebook: a source of large bodies is redacted to the end: the walk shrinks its page, finishes, and the receipt completes", () =>
    aSourceOfLargeBodiesIsRedactedToTheEnd(PLATFORMS[0]));
  test("Instagram: a source of large bodies is redacted to the end: the walk shrinks its page, finishes, and the receipt completes", () =>
    aSourceOfLargeBodiesIsRedactedToTheEnd(PLATFORMS[1]));
  test("Facebook: a page of large bodies is halved and nothing is written or skipped by that attempt; the job keeps its cursor and the receipt stays pending", () =>
    aPageOfLargeBodiesIsHalvedAndTheReceiptStaysPending(PLATFORMS[0]));
  test("Instagram: a page of large bodies is halved and nothing is written or skipped by that attempt; the job keeps its cursor and the receipt stays pending", () =>
    aPageOfLargeBodiesIsHalvedAndTheReceiptStaysPending(PLATFORMS[1]));

  describe.each(PLATFORMS)("$label", (p) => {
    test("large bodies already in the FIRST source do not fail the callback: it answers with a code and the job finishes", async () => {
      const t = limitedTest();
      await seedBigBodies(t, p.logSource, p.platform, LEGACY_ID, 11);

      const res = await post(t, p.deletion, await signedRequest({ user_id: LEGACY_ID }, p.secret));

      expect(res.status).toBe(200);
      const { confirmation_code } = (await res.json()) as { confirmation_code: string };
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect((await bodyReport(t, LEGACY_ID)).named).toBe(0);
      const status = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: confirmation_code });
      expect(typeof status?.completedAt).toBe("number");
    });
  });
});

// ─── A job that cannot finish is visible (SCRUM-842 round 5, Seat 2) ──────────────
//
// The sweep used to restart a failing job for ever with nothing to show for it. It
// now counts restarts that moved nothing, reports the job once as an error row in
// the platform's webhook log, and writes an error line to the Convex logs. Neither
// carries an identifier or the receipt code, and the receipt stays pending.

describe("SCRUM-842 a wedged redaction job is reported, not retried in silence", () => {
  let consoleOutput: string[];

  beforeEach(() => {
    consoleOutput = captureConsole();
    useScheduledTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const jobs = (t: T) => t.run((ctx) => ctx.db.query("metaLogRedactionJobs").collect());
  const wedgeReports = async (t: T) =>
    (await allWebhookLogs(t)).filter((row) => row.status === "error" && row.summary.includes("has not advanced"));

  async function startWedgedJobFor(p: PlatformCase, t: T) {
    await seedLegacyLog(t, p.platform, POISON_SUMMARY);
    const res = await post(t, p.deletion, await signedRequest({ user_id: LEGACY_ID }, p.secret));
    const { confirmation_code } = (await res.json()) as { confirmation_code: string };
    await t.finishAllScheduledFunctions(vi.runAllTimers).catch(() => undefined);
    const [job] = await jobs(t);
    expect(job).toBeDefined();
    return { job, code: confirmation_code };
  }

  /** One sweep after the job went quiet, with the failing run it schedules drained. */
  async function sweepOnce(t: T, jobId: Id<"metaLogRedactionJobs">) {
    await t.run((ctx) => ctx.db.patch(jobId, { updatedAt: Date.now() - 60 * 60 * 1000 }));
    await t.mutation(internal.metaLogRedaction.resumeStalledMetaLogRedactionJobs, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers).catch(() => undefined);
  }

  async function aWedgedJobIsReportedOnceAndTheReceiptStaysPending(p: PlatformCase) {
    const t = newTest();
    const { job, code } = await startWedgedJobFor(p, t);

    for (let i = 1; i < META_LOG_REDACTION_WEDGED_AFTER_RESTARTS; i += 1) await sweepOnce(t, job._id);
    expect(await wedgeReports(t)).toEqual([]);
    expect((await jobs(t))[0]?.stalledRestarts).toBe(META_LOG_REDACTION_WEDGED_AFTER_RESTARTS - 1);

    await sweepOnce(t, job._id);
    const [report, ...rest] = await wedgeReports(t);
    expect(rest).toEqual([]);
    expect(report?.source).toBe(p.logSource);
    expect(report?.summary).toContain(p.platform);
    await sweepOnce(t, job._id);
    expect(await wedgeReports(t)).toHaveLength(1);

    // The logs carry a fixed line, the platform and a count: never an id or the code.
    const lines = consoleOutput.filter((line) => line.includes("[meta-log-redaction]"));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const text of [...lines, JSON.stringify(report), JSON.stringify(await allWebhookLogs(t))]) {
      expect(text).not.toContain(code);
    }
    expect(lines.join("\n")).not.toContain(LEGACY_ID);
    expect(JSON.stringify(report)).not.toContain(LEGACY_ID);
    const status = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code });
    expect(status?.completedAt).toBeNull();
    expect(await jobs(t)).toHaveLength(1);
  }

  test("Facebook: below the threshold nothing is reported; at it exactly one error row appears with no identifier, then none more, and the receipt stays pending", () =>
    aWedgedJobIsReportedOnceAndTheReceiptStaysPending(PLATFORMS[0]));
  test("Instagram: below the threshold nothing is reported; at it exactly one error row appears with no identifier, then none more, and the receipt stays pending", () =>
    aWedgedJobIsReportedOnceAndTheReceiptStaysPending(PLATFORMS[1]));

  describe.each(PLATFORMS)("$label", (p) => {
    const startWedgedJob = (t: T) => startWedgedJobFor(p, t);

    test("once the fault is gone the same job finishes and the same receipt completes", async () => {
      const t = newTest();
      const { job, code } = await startWedgedJob(t);
      for (let i = 0; i < META_LOG_REDACTION_WEDGED_AFTER_RESTARTS; i += 1) await sweepOnce(t, job._id);
      const poisoned = (await allWebhookLogs(t)).find((row) => row.summary === POISON_SUMMARY);
      await t.run((ctx) => ctx.db.patch(poisoned!._id, { summary: "Connected for org recovered" }));

      await sweepOnce(t, job._id);

      expect(await jobs(t)).toEqual([]);
      const status = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code });
      expect(typeof status?.completedAt).toBe("number");
    });

    test("a committed page resets the count: restarts that were followed by progress are not a wedge", async () => {
      const t = newTest();
      await seedFillerLogs(t, p.platform, META_LOG_REDACTION_PAGE_SIZE + 5);
      const res = await post(t, p.deletion, await signedRequest({ user_id: LEGACY_ID }, p.secret));
      expect(res.status).toBe(200);
      const [job] = await jobs(t);
      await t.run((ctx) => ctx.db.patch(job._id, { stalledRestarts: META_LOG_REDACTION_WEDGED_AFTER_RESTARTS - 1 }));

      await t.mutation(internal.metaLogRedaction.runMetaLogRedactionJob, { jobId: job._id });

      expect((await jobs(t))[0]?.stalledRestarts).toBe(0);
      expect(await wedgeReports(t)).toEqual([]);
    });
  });
});
// ─── Round 5: the identifiers are captured with the disconnect, every id finds its account,
// and a redacted document always fits (SCRUM-842, PR #740 round 5) ────────────────────────────
//
// B1: the disconnect used to commit alone and clear the Instagram webhook account id; if the
// next mutation failed, a retry could no longer learn that id and completed the receipt while a
// stored webhook body still held it. Disconnect, receipt and first redaction page are now one
// transaction, so a failure leaves the account connected and the retry sees every id.
// B2: a callback that carried the webhook account id (not the business account id) cleared
// nothing, and only the first of several organisations holding the account was cleared.
// B3: the replacement text is longer than a short id, so redaction could push one document past
// Convex's 1 MiB limit (https://docs.convex.dev/production/state/limits) and the patch would be
// refused for ever.

describe("SCRUM-842 round 5: identifiers are captured atomically with the disconnect", () => {
  const BUSINESS_ID = "17841400000000842";
  const WEBHOOK_ID = "17841400000099842";
  let consoleOutput: string[];

  beforeEach(() => {
    consoleOutput = captureConsole();
    useScheduledTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const seedAccount = (t: T, businessId: string, webhookId: string) =>
    t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", { name: "Synthetic Org", createdAt: Date.now() });
      await ctx.db.insert("orgSettings", {
        orgId,
        currency: "JOD",
        currencySymbol: "JD",
        enabledPaymentTypes: [],
        instagramBusinessAccountId: businessId,
        instagramWebhookAccountId: webhookId,
        instagramAccessToken: "synthetic-ig-token-842",
        instagramPageName: "synthetic_ig",
      });
      return orgId;
    });

  const seedWebhookBody = (t: T, webhookId: string) =>
    t.run((ctx) =>
      ctx.db.insert("webhookLogs", {
        source: "instagram",
        status: "success",
        summary: "Batch with 1 entries",
        eventId: "synthetic-event-sha",
        rawPayload: JSON.stringify({ object: "instagram", entry: [{ id: webhookId }] }),
        payloadTruncated: false,
        createdAt: Date.now(),
      }),
    );

  async function aFailedFirstAttemptKeepsTheAccountSoTheRetryErasesTheWebhookIdBeforeCompleting(path: string) {
    const t = newTest();
    const orgId = await seedAccount(t, BUSINESS_ID, WEBHOOK_ID);
    const inbox = await seedWebhookBody(t, WEBHOOK_ID);
    const poisoned = await seedLegacyLog(t, "instagram-oauth", POISON_SUMMARY);
    const signed = await signedRequest({ user_id: BUSINESS_ID }, INSTAGRAM_SECRET);

    const failed = await post(t, path, signed);

    expect(failed.status).toBe(500);
    // Nothing committed: the account is still connected, so its second id is still on file.
    const kept = await settingsOf(t, orgId);
    expect(kept?.instagramBusinessAccountId).toBe(BUSINESS_ID);
    expect(kept?.instagramWebhookAccountId).toBe(WEBHOOK_ID);
    expect(kept?.instagramAccessToken).toBe("synthetic-ig-token-842");
    expect(await allDeletionRequests(t)).toEqual([]);

    await t.run((ctx) => ctx.db.patch(poisoned, { summary: "Connected for org recovered" }));
    const retried = await post(t, path, signed);
    expect(retried.status).toBe(200);

    // Until the walk reaches the platform's own source the receipt is pending AND the id is still there.
    const [pending] = await allDeletionRequests(t);
    if (path.endsWith("data-deletion")) {
      expect(pending?.completedAt).toBeUndefined();
      expect((await logById(t, inbox))?.rawPayload).toContain(WEBHOOK_ID);
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(JSON.stringify(await allWebhookLogs(t))).not.toContain(WEBHOOK_ID);
    expect(JSON.stringify(await allWebhookLogs(t))).not.toContain(BUSINESS_ID);
    if (path.endsWith("data-deletion")) {
      const [receipt] = await allDeletionRequests(t);
      expect(typeof receipt?.completedAt).toBe("number");
    }
    const cleared = await settingsOf(t, orgId);
    expect(cleared?.instagramAccessToken).toBeUndefined();
    expect(await t.run((ctx) => ctx.db.query("metaLogRedactionJobs").collect())).toEqual([]);
    expect(consoleOutput.join("\n")).not.toContain(WEBHOOK_ID);
  }

  test("Instagram data-deletion: a first attempt that fails after the disconnect step leaves the account connected, and the retry erases the webhook account id before the receipt completes", () =>
    aFailedFirstAttemptKeepsTheAccountSoTheRetryErasesTheWebhookIdBeforeCompleting("/instagram-data-deletion"));
  test("Instagram deauthorize: a first attempt that fails after the disconnect step leaves the account connected, and the retry erases the webhook account id", () =>
    aFailedFirstAttemptKeepsTheAccountSoTheRetryErasesTheWebhookIdBeforeCompleting("/instagram-deauthorize"));

  test("Facebook data-deletion: a first attempt that fails leaves the connection in place and no receipt, and the retry completes", async () => {
    const t = newTest();
    const orgId = await seedConnectedOrg(t, "facebook");
    const poisoned = await seedLegacyLog(t, "facebook-oauth", POISON_SUMMARY);
    const signed = await signedRequest({ user_id: META_USER_ID }, FACEBOOK_SECRET);

    const failed = await post(t, "/facebook-data-deletion", signed);

    expect(failed.status).toBe(500);
    expect((await settingsOf(t, orgId))?.facebookPageAccessToken).toBe("synthetic-page-token-842");
    expect(await allDeletionRequests(t)).toEqual([]);

    await t.run((ctx) => ctx.db.patch(poisoned, { summary: "Connected for org recovered" }));
    expect((await post(t, "/facebook-data-deletion", signed)).status).toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await settingsOf(t, orgId))?.facebookPageAccessToken).toBeUndefined();
    const [receipt] = await allDeletionRequests(t);
    expect(typeof receipt?.completedAt).toBe("number");
  });
});

describe("SCRUM-842 round 5: a callback finds the account by either Instagram id", () => {
  const BUSINESS_ID = "17841400000000842";
  const WEBHOOK_ID = "17841400000099842";

  beforeEach(() => {
    captureConsole();
    useScheduledTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const seedAccount = (t: T, businessId: string, webhookId: string) =>
    t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", { name: "Synthetic Org", createdAt: Date.now() });
      await ctx.db.insert("orgSettings", {
        orgId,
        currency: "JOD",
        currencySymbol: "JD",
        enabledPaymentTypes: [],
        instagramBusinessAccountId: businessId,
        instagramWebhookAccountId: webhookId,
        instagramAccessToken: "synthetic-ig-token-842",
        instagramPageName: "synthetic_ig",
        instagramAutoReplyEnabled: true,
      });
      return orgId;
    });

  const expectDisconnected = async (t: T, orgId: Id<"organizations">) => {
    const settings = await settingsOf(t, orgId);
    expect(settings?.instagramBusinessAccountId).toBeUndefined();
    expect(settings?.instagramWebhookAccountId).toBeUndefined();
    expect(settings?.instagramAccessToken).toBeUndefined();
    expect(settings?.instagramPageName).toBeUndefined();
    expect(settings?.instagramAutoReplyEnabled).toBe(false);
  };

  async function aCallbackNamingTheWebhookAccountIdDisconnectsTheAccount(path: string) {
    const t = newTest();
    const orgId = await seedAccount(t, BUSINESS_ID, WEBHOOK_ID);

    const res = await post(t, path, await signedRequest({ user_id: WEBHOOK_ID }, INSTAGRAM_SECRET));

    expect(res.status).toBe(200);
    await expectDisconnected(t, orgId);
    if (path.endsWith("data-deletion")) {
      const { confirmation_code } = (await res.json()) as { confirmation_code: string };
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      const status = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: confirmation_code });
      expect(status?.connectionRemoved).toBe(true);
    }
  }

  test("Instagram deauthorize: a callback that names the webhook account id disconnects the account", () =>
    aCallbackNamingTheWebhookAccountIdDisconnectsTheAccount("/instagram-deauthorize"));
  test("Instagram data-deletion: a callback that names the webhook account id disconnects the account and the receipt says so", () =>
    aCallbackNamingTheWebhookAccountIdDisconnectsTheAccount("/instagram-data-deletion"));

  test("Instagram data-deletion: a callback that names the business account id disconnects the account and the receipt says so", async () => {
    const t = newTest();
    const orgId = await seedAccount(t, BUSINESS_ID, WEBHOOK_ID);

    const res = await post(t, "/instagram-data-deletion", await signedRequest({ user_id: BUSINESS_ID }, INSTAGRAM_SECRET));

    expect(res.status).toBe(200);
    await expectDisconnected(t, orgId);
    const { confirmation_code } = (await res.json()) as { confirmation_code: string };
    const status = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: confirmation_code });
    expect(status?.connectionRemoved).toBe(true);
  });

  test("Instagram: every organisation that holds the same legacy account is disconnected, not only the first", async () => {
    const t = newTest();
    const first = await seedAccount(t, BUSINESS_ID, WEBHOOK_ID);
    const second = await seedAccount(t, BUSINESS_ID, WEBHOOK_ID);
    const unrelated = await seedAccount(t, "17841400000011111", "17841400000022222");

    const res = await post(t, "/instagram-deauthorize", await signedRequest({ user_id: BUSINESS_ID }, INSTAGRAM_SECRET));
    expect(res.status).toBe(200);
    await expectDisconnected(t, first);
    await expectDisconnected(t, second);
    expect((await settingsOf(t, unrelated))?.instagramAccessToken).toBe("synthetic-ig-token-842");

    // The same account again, found through the webhook account id this time.
    const third = await seedAccount(t, BUSINESS_ID, WEBHOOK_ID);
    const fourth = await seedAccount(t, BUSINESS_ID, WEBHOOK_ID);
    const viaWebhook = await post(t, "/instagram-deauthorize", await signedRequest({ user_id: WEBHOOK_ID }, INSTAGRAM_SECRET));
    expect(viaWebhook.status).toBe(200);
    await expectDisconnected(t, third);
    await expectDisconnected(t, fourth);
    expect((await settingsOf(t, unrelated))?.instagramAccessToken).toBe("synthetic-ig-token-842");
  });

  async function anIdThatMatchesNoConnectionIsNotReportedAsRemoved(p: PlatformCase) {
    const t = newTest();

    const res = await post(t, p.deletion, await signedRequest({ user_id: "990000000000777" }, p.secret));

    expect(res.status).toBe(200);
    const { confirmation_code } = (await res.json()) as { confirmation_code: string };
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const status = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: confirmation_code });
    expect(typeof status?.completedAt).toBe("number");
    expect(status?.connectionRemoved).toBe(false);
  }

  test("Facebook data-deletion: an id that matches no connection completes without claiming credentials were removed", () =>
    anIdThatMatchesNoConnectionIsNotReportedAsRemoved(PLATFORMS[0]));
  test("Instagram data-deletion: an id that matches no connection completes without claiming credentials were removed", () =>
    anIdThatMatchesNoConnectionIsNotReportedAsRemoved(PLATFORMS[1]));

  test("Facebook data-deletion: a matching connection is reported as removed", async () => {
    const t = newTest();
    await seedConnectedOrg(t, "facebook");
    const res = await post(t, "/facebook-data-deletion", await signedRequest({ user_id: META_USER_ID }, FACEBOOK_SECRET));
    const { confirmation_code } = (await res.json()) as { confirmation_code: string };
    const status = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: confirmation_code });
    expect(status?.connectionRemoved).toBe(true);
  });
});

describe("SCRUM-842 round 5: a redacted document never outgrows Convex's 1 MiB limit", () => {
  const DOCUMENT_LIMIT_BYTES = 1024 * 1024;
  const IG_ID = "17841400000000842";

  beforeEach(() => {
    captureConsole();
    useScheduledTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // A body packed with the shortest realistic ids: every 18 bytes becomes 21, so a body above
  // about 900,000 bytes grows past the limit if the replacement is the long fixed text.
  const packedBody = (id: string, bytes: number) => `${id} `.repeat(Math.floor(bytes / (id.length + 1)));

  async function aNearLimitBodyPackedWithTheIdIsPatchedAndStaysUnderTheLimit(p: PlatformCase) {
    const t = newTest();
    const body = packedBody(IG_ID, 1_000_000);
    const rowId = await t.run((ctx) =>
      ctx.db.insert("webhookLogs", {
        source: p.platform,
        status: "success",
        summary: "Batch with 1 entries",
        eventId: "synthetic-event-sha",
        payloadSha256: "synthetic-event-sha",
        rawPayload: body,
        payloadTruncated: false,
        createdAt: Date.now(),
      }),
    );
    const before = await t.run(async (ctx) => getDocumentSize((await ctx.db.get(rowId))!));
    expect(before).toBeLessThan(DOCUMENT_LIMIT_BYTES);
    // The long replacement text WOULD overflow: this is what the test guards against.
    expect(before + (REDACTED_META_USER.length - IG_ID.length) * Math.floor(1_000_000 / (IG_ID.length + 1))).toBeGreaterThan(
      DOCUMENT_LIMIT_BYTES,
    );

    const res = await post(t, p.deletion, await signedRequest({ user_id: IG_ID }, p.secret));
    expect(res.status).toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const after = await t.run(async (ctx) => (await ctx.db.get(rowId))!);
    expect(getDocumentSize(after)).toBeLessThanOrEqual(DOCUMENT_LIMIT_BYTES);
    expect(after.rawPayload).not.toContain(IG_ID);
    expect(after.eventId).toBe("synthetic-event-sha");
    expect(after.payloadSha256).toBe("synthetic-event-sha");
    const { confirmation_code } = { confirmation_code: (await allDeletionRequests(t))[0]?.code ?? "" };
    const status = await t.query(api.socialIntegrations.getMetaDataDeletionStatus, { code: confirmation_code });
    expect(typeof status?.completedAt).toBe("number");
  }

  test("Facebook: a near-limit webhook body packed with the id is redacted without outgrowing the document limit", () =>
    aNearLimitBodyPackedWithTheIdIsPatchedAndStaysUnderTheLimit(PLATFORMS[0]));
  test("Instagram: a near-limit webhook body packed with the id is redacted without outgrowing the document limit", () =>
    aNearLimitBodyPackedWithTheIdIsPatchedAndStaysUnderTheLimit(PLATFORMS[1]));

  test("a normal row keeps the readable replacement text", async () => {
    const t = newTest();
    const rowId = await seedLegacyLog(t, "instagram", `DM from ${IG_ID}`);
    await post(t, "/instagram-deauthorize", await signedRequest({ user_id: IG_ID }, INSTAGRAM_SECRET));
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await logById(t, rowId))?.summary).toBe(`DM from ${REDACTED_META_USER}`);
  });
});

describe("SCRUM-842 round 5: a page of mid-size rows packed with a short id stays inside the write limit", () => {
  const SHORT_ID = "abc";

  beforeEach(() => {
    captureConsole();
    useScheduledTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("Instagram: sixty 100 KB bodies packed with a 3-character id are redacted under Convex's 16 MiB write limit", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { transactionLimits: true });
    const body = `${SHORT_ID} `.repeat(25_000);
    for (let batch = 0; batch < 60; batch += 10) {
      await t.run(async (ctx) => {
        for (let i = 0; i < 10; i += 1) {
          await ctx.db.insert("webhookLogs", {
            source: "instagram",
            status: "success",
            summary: `Batch ${batch + i}`,
            eventId: `mid-event-${batch + i}`,
            rawPayload: body,
            payloadTruncated: false,
            createdAt: Date.now(),
          });
        }
      });
    }

    const res = await post(t, "/instagram-deauthorize", await signedRequest({ user_id: SHORT_ID }, INSTAGRAM_SECRET));
    expect(res.status).toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.run((ctx) => ctx.db.query("metaLogRedactionJobs").collect())).toEqual([]);
    let remaining = 0;
    let cursor: string | null = null;
    for (let guard = 0; guard < 100; guard += 1) {
      const result: { page: Array<{ rawPayload?: string }>; isDone: boolean; continueCursor: string } = await t.run((ctx) =>
        ctx.db.query("webhookLogs").paginate({ numItems: 8, cursor }),
      );
      remaining += result.page.filter((row) => /(?<![A-Za-z0-9])abc(?![A-Za-z0-9])/.test(row.rawPayload ?? "")).length;
      if (result.isDone) break;
      cursor = result.continueCursor;
    }
    expect(remaining).toBe(0);
  });
});
