import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { getValidatedEnv } from "./utils/env";

// SCRUM-842: Meta's deauthorize and data-deletion callbacks must not copy the
// Meta user id into anything that outlives the request (webhookLogs, the
// confirmation code, the status URL, console output), must answer the status URL
// with the right platform, and must refuse a bad signature before writing.
// Every test posts a real HMAC-signed `signed_request` to the HTTP route.

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const FACEBOOK_SECRET = "test_fb_app_secret_842";
const INSTAGRAM_SECRET = "test_ig_app_secret_842";

vi.mock("./utils/env", () => ({
  getValidatedEnv: vi.fn(() => ({
    FACEBOOK_APP_ID: "test_fb_app_id",
    FACEBOOK_APP_SECRET: "test_fb_app_secret_842",
    INSTAGRAM_APP_SECRET: "test_ig_app_secret_842",
    CONVEX_SITE_URL: "https://example.convex.site",
    NEXT_PUBLIC_APP_URL: "https://app.test",
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
