import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { WithoutSystemFields } from "convex/server";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

vi.mock("./utils/env", () => ({
  getValidatedEnv: vi.fn(() => ({
    FACEBOOK_APP_ID: "test_fb_app_id",
    FACEBOOK_APP_SECRET: "test_fb_app_secret",
    CONVEX_SITE_URL: "https://example.convex.site",
    NEXT_PUBLIC_APP_URL: "https://app.test",
  })),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedOwner(t: ReturnType<typeof convexTestWithComponents>) {
  const orgId = await t.run(async (ctx) =>
    ctx.db.insert("organizations", { name: "Test Org", createdAt: Date.now() })
  );
  // Seed a professional subscription so requireFeature("socialInbox") passes.
  await t.run(async (ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { clerkId: "fb_owner_001", email: "fbowner@test.com", name: "Owner" })
  );
  const roleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ["view:settings", "edit:settings"],
      isSystemOwnerRole: true,
    })
  );
  await t.run(async (ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return { orgId, userId, asOwner: t.withIdentity({ subject: "fb_owner_001" }) };
}

describe("facebookIntegrations.createConnectUrl", () => {
  test("returns a Meta OAuth dialog URL with a state param, owner-only", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    const url = await asOwner.mutation(api.facebookIntegrations.createConnectUrl, { orgId });

    expect(url).toContain("facebook.com");
    expect(url).toContain("client_id=test_fb_app_id");
    expect(url).toContain("redirect_uri=");
    expect(url).toContain("state=");

    await t.run(async (ctx) => {
      const states = await ctx.db.query("oauthStates").collect();
      expect(states.length).toBe(1);
      expect(states[0].orgId).toBe(orgId);
      expect(states[0].provider).toBe("facebook");
    });
  });

  test("rejects non-owners", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOwner(t);

    const userId2 = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "fb_member_002", email: "fbm@test.com", name: "Member" })
    );
    const roleId2 = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:settings"] })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: userId2, roleId: roleId2 }));
    const asMember = t.withIdentity({ subject: "fb_member_002" });

    await expect(
      asMember.mutation(api.facebookIntegrations.createConnectUrl, { orgId })
    ).rejects.toThrow();
  });
});

describe("facebookIntegrations.getConnectionStatus / disconnect", () => {
  test("reports not connected by default, then connected after credentials are saved", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    const before = await asOwner.query(api.facebookIntegrations.getConnectionStatus, { orgId });
    expect(before.facebookConnected).toBe(false);

    await t.run((ctx) =>
      ctx.runMutation(internal.facebookIntegrations.saveFacebookCredentials, {
        orgId,
        facebookPageId: "page_123",
        facebookPageAccessToken: "page_token_abc",
        facebookPageName: "My Dealership Page",
      })
    );

    const after = await asOwner.query(api.facebookIntegrations.getConnectionStatus, { orgId });
    expect(after.facebookConnected).toBe(true);
    expect(after.facebookPageName).toBe("My Dealership Page");
  });

  test("disconnect clears stored credentials", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    await t.run((ctx) =>
      ctx.runMutation(internal.facebookIntegrations.saveFacebookCredentials, {
        orgId,
        facebookPageId: "page_123",
        facebookPageAccessToken: "page_token_abc",
      })
    );

    await asOwner.mutation(api.facebookIntegrations.disconnect, { orgId });

    const status = await asOwner.query(api.facebookIntegrations.getConnectionStatus, { orgId });
    expect(status.facebookConnected).toBe(false);
  });
});

describe("facebookIntegrations.disconnectByFacebookConnectedUserId", () => {
  test("resolves the org via the connecting user's Facebook ID, not the Page ID", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOwner(t);

    await t.run((ctx) =>
      ctx.runMutation(internal.facebookIntegrations.saveFacebookCredentials, {
        orgId,
        facebookPageId: "page_123",
        facebookPageAccessToken: "page_token_abc",
        facebookConnectedByUserId: "fb_connecting_user_1",
      })
    );

    await t.run((ctx) =>
      ctx.runMutation(internal.facebookIntegrations.disconnectByFacebookConnectedUserId, {
        facebookConnectedByUserId: "fb_connecting_user_1",
      })
    );

    const settings = await t.run((ctx) =>
      ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()
    );
    expect(settings?.facebookPageId).toBeUndefined();
    expect(settings?.facebookPageAccessToken).toBeUndefined();
  });
});

describe("facebookIntegrations.setFacebookLeadCreationConfig", () => {
  test("requires a connection before configuring, then persists the toggles", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    await expect(
      asOwner.mutation(api.facebookIntegrations.setFacebookLeadCreationConfig, {
        orgId,
        leadFromCommentsEnabled: false,
        leadFromDmsEnabled: true,
        leadFromDmsRequiresMobile: true,
      })
    ).rejects.toThrow(/connect facebook/i);

    await t.run((ctx) =>
      ctx.runMutation(internal.facebookIntegrations.saveFacebookCredentials, {
        orgId,
        facebookPageId: "page_123",
        facebookPageAccessToken: "page_token_abc",
      })
    );

    await asOwner.mutation(api.facebookIntegrations.setFacebookLeadCreationConfig, {
      orgId,
      leadFromCommentsEnabled: false,
      leadFromDmsEnabled: true,
      leadFromDmsRequiresMobile: true,
    });

    const status = await asOwner.query(api.facebookIntegrations.getConnectionStatus, { orgId });
    expect(status.facebookLeadFromCommentsEnabled).toBe(false);
    expect(status.facebookLeadFromDmsEnabled).toBe(true);
    expect(status.facebookLeadFromDmsRequiresMobile).toBe(true);
  });
});

describe("facebookIntegrations.consumeOAuthState", () => {
  test("returns the orgId for a valid state and consumes it (one-time use)", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    await asOwner.mutation(api.facebookIntegrations.createConnectUrl, { orgId });
    const state = await t.run(async (ctx) => {
      const row = await ctx.db.query("oauthStates").first();
      return row!.state;
    });

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.facebookIntegrations.consumeOAuthState, { state })
    );
    expect(result?.orgId).toBe(orgId);

    const replay = await t.run((ctx) =>
      ctx.runMutation(internal.facebookIntegrations.consumeOAuthState, { state })
    );
    expect(replay).toBeNull();
  });

  test("returns null for an unknown state", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const result = await t.run((ctx) =>
      ctx.runMutation(internal.facebookIntegrations.consumeOAuthState, { state: "does-not-exist" })
    );
    expect(result).toBeNull();
  });
});

// SCRUM-622: the webhook resolves an org by Page id, so one Page may belong to
// one org only — a second owner made every delivery for that Page ambiguous.
describe("facebookIntegrations: a Page belongs to one org", () => {
  async function seedSecondOrg(t: ReturnType<typeof convexTestWithComponents>) {
    const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Other Org", createdAt: Date.now() }));
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", {
        orgId,
        plan: "professional",
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
    );
    const userId = await t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "fb_owner_b", email: "b@test.com", name: "Owner B" })
    );
    const roleId = await t.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ["view:settings", "edit:settings"], isSystemOwnerRole: true })
    );
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
    return { orgId, asOwner: t.withIdentity({ subject: "fb_owner_b" }) };
  }

  const save = (t: ReturnType<typeof convexTestWithComponents>, orgId: Id<"organizations">, facebookPageId: string) =>
    t.run((ctx) =>
      ctx.runMutation(internal.facebookIntegrations.saveFacebookCredentials, {
        orgId,
        facebookPageId,
        facebookPageAccessToken: "token",
      })
    );

  test("refuses a Page already connected to another org, and leaves both orgs unchanged", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId: orgA } = await seedOwner(t);
    const { orgId: orgB } = await seedSecondOrg(t);
    await save(t, orgA, "page_shared");

    await expect(save(t, orgB, "page_shared")).rejects.toThrow(/already connected to another/i);

    const holders = await t.run((ctx) =>
      ctx.db.query("orgSettings").withIndex("by_facebook_page_id", (q) => q.eq("facebookPageId", "page_shared")).collect()
    );
    expect(holders.map((s) => s.orgId)).toEqual([orgA]);
  });

  test("the same org may reconnect its own Page", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOwner(t);
    await save(t, orgId, "page_mine");
    await expect(save(t, orgId, "page_mine")).resolves.toBeNull();
  });

  test("once the first org disconnects, another org may connect the Page", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId: orgA, asOwner } = await seedOwner(t);
    const { orgId: orgB } = await seedSecondOrg(t);
    await save(t, orgA, "page_moving");
    await asOwner.mutation(api.facebookIntegrations.disconnect, { orgId: orgA });
    await expect(save(t, orgB, "page_moving")).resolves.toBeNull();
  });

  test("picking a Page another org holds is refused before the Page is subscribed", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId: orgA } = await seedOwner(t);
    const { orgId: orgB, asOwner: asOwnerB } = await seedSecondOrg(t);
    await save(t, orgA, "page_shared");
    await t.run(async (ctx) => {
      await ctx.db.insert("orgSettings", {
        orgId: orgB,
        currency: "JOD",
        currencySymbol: "JD",
        enabledPaymentTypes: [],
        facebookPendingCredentials: [{ id: "page_shared", name: "Shared", token: "pending_token" }],
      });
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(
      asOwnerB.action(api.facebookIntegrations.selectFacebookPage, { orgId: orgB, pageId: "page_shared" })
    ).rejects.toThrow(/already connected to another/i);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

// SCRUM-841: the /me/accounts response is untrusted provider data. A type
// annotation does not strip the extra fields Meta returns per Page, and the
// strict mutation validator then rejected the argument and echoed the rejected
// value — page token included — into the thrown error, which the OAuth callback
// stores in the admin-visible webhook log. It also requires a valid /me id before
// any write, since Meta's deauthorize/data-deletion callbacks resolve the org
// only through it.
describe("facebookIntegrations.exchangeCodeForToken: Page payload boundary", () => {
  const SYNTHETIC_PAGE_TOKEN = "synthetic-page-token-DO-NOT-LEAK";
  const SYNTHETIC_PROVIDER_TEXT = "synthetic-provider-error-DO-NOT-LEAK";
  const graphJson = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  /** A Graph step: a reply, or a throw (a rejected fetch). Receives the real request URL. */
  type Step = (url: URL) => Response | Promise<Response>;
  type Steps = { shortToken?: Step; longToken?: Step; me?: Step };
  const SYNTHETIC_FETCH_SECRET = "synthetic-fetch-secret-DO-NOT-LEAK";
  /** What undici-style failures can look like: the message embeds the full request URL. */
  const rejectEmbeddingUrl: Step = (url) => {
    throw new Error(`request to ${url.href} failed, reason: ${SYNTHETIC_FETCH_SECRET}`);
  };
  /** Every credential the action puts in a Graph URL (or that the mock env holds). */
  const URL_CREDENTIALS = ["test_fb_app_secret", "short_user_token", "long_user_token", SYNTHETIC_FETCH_SECRET];

  /** Routes the four Graph calls the action makes; `accounts` is the /me/accounts reply. */
  function stubGraph(accounts: Step, overrides: Steps = {}) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.pathname.endsWith("/me/accounts")) return accounts(url);
        if (url.pathname.endsWith("/me")) return overrides.me?.(url) ?? graphJson({ id: "fb_user_1" });
        if (url.searchParams.get("grant_type") === "fb_exchange_token")
          return overrides.longToken?.(url) ?? graphJson({ access_token: "long_user_token" });
        return overrides.shortToken?.(url) ?? graphJson({ access_token: "short_user_token" });
      })
    );
  }

  async function run(accounts: Step, overrides: Steps = {}) {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOwner(t);
    stubGraph(accounts, overrides);
    const settings = () =>
      t.run((ctx) => ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
    return { orgId, t, settings };
  }

  async function failureText(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
    } catch (err) {
      const e = err as { message?: string; data?: unknown };
      return `${e.message ?? ""} ${JSON.stringify(e.data ?? "")}`;
    }
    throw new Error("expected the action to fail");
  }

  test("Pages carrying Meta's extra fields are stored as id/name/token only", async () => {
    const { orgId, t, settings } = await run(() =>
      graphJson({
        data: [
          {
            id: "page_1",
            name: "Dealer One",
            access_token: SYNTHETIC_PAGE_TOKEN,
            category: "Automotive Dealership",
            category_list: [{ id: "1", name: "Automotive Dealership" }],
            tasks: ["ADVERTISE", "ANALYZE", "CREATE_CONTENT", "MESSAGING", "MODERATE", "MANAGE"],
          },
        ],
      })
    );

    await t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc" });

    const row = await settings();
    expect(row?.facebookAvailablePages).toEqual([{ id: "page_1", name: "Dealer One" }]);
    expect(row?.facebookPendingCredentials).toEqual([
      { id: "page_1", name: "Dealer One", token: SYNTHETIC_PAGE_TOKEN },
    ]);
  });

  test.each([
    ["a Page without a token", { id: "page_1", name: "Dealer One" }],
    ["a Page with a non-string name", { id: "page_1", name: 7, access_token: SYNTHETIC_PAGE_TOKEN }],
    ["a Page with an empty id", { id: "", name: "Dealer One", access_token: SYNTHETIC_PAGE_TOKEN }],
    ["a row that is not an object", "page_1"],
  ])("%s fails the whole connection with a generic error and stores nothing", async (_label, bad) => {
    const good = { id: "page_2", name: "Dealer Two", access_token: SYNTHETIC_PAGE_TOKEN };
    const { orgId, t, settings } = await run(() => graphJson({ data: [good, bad] }));

    const text = await failureText(t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc" }));

    expect(text).toMatch(/unexpected Pages response/i);
    expect(text).not.toContain(SYNTHETIC_PAGE_TOKEN);
    expect((await settings())?.facebookPendingCredentials).toBeUndefined();
  });

  // /me is untrusted, and its id is the ONLY key Meta's deauthorize and
  // data-deletion callbacks use to find this org's credentials
  // (disconnectByFacebookConnectedUserId). Storing Page tokens without it would
  // leave credentials those callbacks cannot erase while reporting success, so
  // any /me failure aborts the connection before anything is written.
  const PAGES = () => graphJson({ data: [{ id: "page_1", name: "Dealer One", access_token: SYNTHETIC_PAGE_TOKEN }] });
  const EXISTING_USER = "fb_existing_user";
  const ME_FAILED = /could not identify the connecting account/i;

  test.each([
    ["a numeric id", { me: () => graphJson({ id: 12345 }) }],
    ["an object id", { me: () => graphJson({ id: { nested: "value" } }) }],
    ["an empty id", { me: () => graphJson({ id: "" }) }],
    ["no id", { me: () => graphJson({}) }],
    ["an array body", { me: () => graphJson(["fb_user_1"]) }],
    // A valid id alongside an error status: the status must be checked too.
    ["an HTTP error status", { me: () => graphJson({ id: "fb_user_1", error: { message: SYNTHETIC_PROVIDER_TEXT } }, 500) }],
    ["a non-JSON body", { me: () => new Response(`<html>${SYNTHETIC_PROVIDER_TEXT}</html>`, { status: 200 }) }],
    ["a rejected fetch", { me: rejectEmbeddingUrl }],
  ] as const)(
    "%s from /me aborts before any credential is written and leaves an existing connection untouched",
    async (_label, overrides) => {
      const { orgId, t, settings } = await run(PAGES, overrides);
      await t.run((ctx) =>
        ctx.runMutation(internal.facebookIntegrations.saveFacebookCredentials, {
          orgId,
          facebookPageId: "page_active",
          facebookPageAccessToken: "active-page-token-synthetic",
          facebookConnectedByUserId: EXISTING_USER,
        })
      );
      const before = await settings();
      expect(before).toMatchObject({
        facebookConnectedByUserId: EXISTING_USER,
        facebookPageAccessToken: "active-page-token-synthetic",
      });
      expect(before?.facebookPendingCredentials).toBeUndefined();

      const text = await failureText(t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc" }));

      expect(text).toMatch(ME_FAILED);
      for (const secret of [...URL_CREDENTIALS, SYNTHETIC_PROVIDER_TEXT, SYNTHETIC_PAGE_TOKEN]) {
        expect(text).not.toContain(secret);
      }
      // Nothing written: the whole row, not just the fields we know about.
      expect(await settings()).toEqual(before);

      // The existing connection is still erasable by Meta's callbacks.
      await t.run((ctx) =>
        ctx.runMutation(internal.facebookIntegrations.disconnectByFacebookConnectedUserId, {
          facebookConnectedByUserId: EXISTING_USER,
        })
      );
      const erased = await settings();
      expect(erased?.facebookPageAccessToken).toBeUndefined();
      expect(erased?.facebookConnectedByUserId).toBeUndefined();
    }
  );

  test("a first-time connection whose /me fails stores no pending credentials at all", async () => {
    const { orgId, t, settings } = await run(PAGES, { me: () => graphJson({ id: 12345 }) });
    await expect(
      t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc" })
    ).rejects.toThrow(ME_FAILED);
    expect(await settings()).toBeNull();
  });

  test("a recorded /me id lets the data-deletion lookup erase the pending Page tokens", async () => {
    const { orgId, t, settings } = await run(PAGES);
    await t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc" });
    expect((await settings())?.facebookPendingCredentials).toHaveLength(1);
    expect((await settings())?.facebookConnectedByUserId).toBe("fb_user_1");

    await t.run((ctx) =>
      ctx.runMutation(internal.facebookIntegrations.disconnectByFacebookConnectedUserId, {
        facebookConnectedByUserId: "fb_user_1",
      })
    );

    const row = await settings();
    expect(row?.facebookPendingCredentials).toBeUndefined();
    expect(row?.facebookAvailablePages).toBeUndefined();
  });

  test("a /me/accounts body whose data is not an array fails generically", async () => {
    const { orgId, t } = await run(() => graphJson({ data: { access_token: SYNTHETIC_PAGE_TOKEN } }));
    const text = await failureText(t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc" }));
    expect(text).toMatch(/unexpected Pages response/i);
    expect(text).not.toContain(SYNTHETIC_PAGE_TOKEN);
  });

  test("a non-JSON /me/accounts body fails generically without quoting the body", async () => {
    const { orgId, t } = await run(() => new Response(`<html>${SYNTHETIC_PROVIDER_TEXT}</html>`, { status: 200 }));
    const text = await failureText(t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc" }));
    expect(text).toMatch(/unexpected Pages response/i);
    expect(text).not.toContain(SYNTHETIC_PROVIDER_TEXT);
  });

  test.each([
    ["the token exchange", { shortToken: rejectEmbeddingUrl }, () => graphJson({ data: [] }), /token exchange failed/i],
    ["the long-lived token exchange", { longToken: rejectEmbeddingUrl }, () => graphJson({ data: [] }), /long-lived token exchange failed/i],
    ["/me/accounts", {}, rejectEmbeddingUrl, /could not be retrieved/i],
    [
      "a long-lived token provider error",
      { longToken: () => graphJson({ error: { message: `${SYNTHETIC_PROVIDER_TEXT} ${SYNTHETIC_FETCH_SECRET}` } }, 400) },
      () => graphJson({ data: [] }),
      /long-lived token exchange failed/i,
    ],
  ] as const)(
    "a failure in %s throws a fixed step-specific error that quotes no credential",
    async (_label, overrides, accounts, expected) => {
      const { orgId, t } = await run(accounts, overrides);
      const text = await failureText(t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc" }));
      expect(text).toMatch(expected);
      for (const secret of [...URL_CREDENTIALS, SYNTHETIC_PROVIDER_TEXT]) expect(text).not.toContain(secret);
    }
  );

  // The callback records err.message in webhookLogs, so this is the stored-row
  // boundary: drive the real route, then read what it persisted.
  test("the OAuth callback stores a fixed message, not a credential-bearing fetch failure", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    await asOwner.mutation(api.facebookIntegrations.createConnectUrl, { orgId });
    const state = await t.run(async (ctx) => (await ctx.db.query("oauthStates").first())!.state);
    stubGraph(() => graphJson({ data: [] }), { longToken: rejectEmbeddingUrl });

    const res = await t.fetch(`/facebook-oauth-callback?code=abc&state=${state}`, { redirect: "manual" });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=1");
    const logs = await t.run((ctx) => ctx.db.query("webhookLogs").collect());
    const failure = logs.find((l) => l.source === "facebook-oauth" && l.status === "error");
    expect(failure?.error).toMatch(/long-lived token exchange failed/i);
    for (const secret of URL_CREDENTIALS) expect(JSON.stringify(logs)).not.toContain(secret);
  });

  // The deletion invariant: every credential row Meta's deauthorize and
  // data-deletion callbacks must be able to erase is reachable through
  // orgSettings.facebookConnectedByUserId. Tests labelled "(signed route)" POST
  // a real HMAC-signed signed_request to the HTTP route; "(action)" ones call the
  // named action directly and prove nothing about the route.
  describe("deletion invariants", () => {
    const APP_SECRET = "test_fb_app_secret"; // the mocked getValidatedEnv value
    const toBase64Url = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");

    async function signedRequest(payload: Record<string, unknown>): Promise<string> {
      const encoded = toBase64Url(JSON.stringify(payload));
      const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(APP_SECRET),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );
      const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded)));
      return `${toBase64Url(sig)}.${encoded}`;
    }

    type T = ReturnType<typeof convexTestWithComponents<typeof schema>>;
    async function postToRoute(t: T, path: string, userId: string) {
      return t.fetch(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ signed_request: await signedRequest({ user_id: userId }) }).toString(),
      });
    }

    const newOrg = (t: T, name: string) => t.run((ctx) => ctx.db.insert("organizations", { name, createdAt: Date.now() }));
    const insertSettings = (t: T, orgId: Id<"organizations">, fields: Partial<WithoutSystemFields<Doc<"orgSettings">>>) =>
      t.run((ctx) =>
        ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: [], ...fields })
      );
    const settingsOf = (t: T, orgId: Id<"organizations">) =>
      t.run((ctx) => ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());

    test.each(["/facebook-deauthorize", "/facebook-data-deletion"])(
      "(signed route) %s erases every org the Facebook user connected, not just the first or the first few",
      async (path) => {
        const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
        const shared = [await newOrg(t, "A"), await newOrg(t, "B"), await newOrg(t, "C")];
        const orgOther = await newOrg(t, "Other");
        const connected = (suffix: string, userId: string) => ({
          facebookPageId: `page_${suffix}`,
          facebookPageAccessToken: `synthetic-token-${suffix}`,
          facebookPageName: suffix,
          facebookConnectedByUserId: userId,
        });
        await insertSettings(t, shared[0], connected("a", "fb_shared_user"));
        await insertSettings(t, shared[1], {
          ...connected("b", "fb_shared_user"),
          facebookPendingCredentials: [{ id: "page_b2", name: "B2", token: "synthetic-pending-b" }],
          facebookAvailablePages: [{ id: "page_b2", name: "B2" }],
        });
        await insertSettings(t, shared[2], connected("c", "fb_shared_user"));
        await insertSettings(t, orgOther, connected("other", "fb_someone_else"));
        const otherBefore = await settingsOf(t, orgOther);

        const res = await postToRoute(t, path, "fb_shared_user");

        expect(res.status).toBe(200);
        for (const orgId of shared) {
          const row = await settingsOf(t, orgId);
          expect(row?.facebookPageId).toBeUndefined();
          expect(row?.facebookPageAccessToken).toBeUndefined();
          expect(row?.facebookConnectedByUserId).toBeUndefined();
          expect(row?.facebookPendingCredentials).toBeUndefined();
          expect(row?.facebookAvailablePages).toBeUndefined();
        }
        expect(await settingsOf(t, orgOther)).toEqual(otherBefore);
      }
    );

    describe("a different Facebook user cannot take over the id of an active connection", () => {
      const ACTIVE = { facebookPageId: "page_active", facebookPageAccessToken: "active-page-token-synthetic" };
      const OTHER_USER_FAILED = /different Facebook account/i;

      test.each([
        ["a different user", { facebookConnectedByUserId: "fb_original_user" }],
        ["an unknown (legacy) user", {}],
        ["an empty (corrupt) stored user", { facebookConnectedByUserId: "" }],
      ])("(action) a reconnect by a different Facebook user over an active connection owned by %s is refused before any write", async (_label, owner) => {
        const { orgId, t } = await run(PAGES, { me: () => graphJson({ id: "fb_intruder" }) });
        await insertSettings(t, orgId, { ...ACTIVE, ...owner });
        const allSettings = () => t.run((ctx) => ctx.db.query("orgSettings").collect());
        const before = await allSettings();

        const text = await failureText(t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc" }));

        expect(text).toMatch(OTHER_USER_FAILED);
        for (const secret of [...URL_CREDENTIALS, SYNTHETIC_PAGE_TOKEN, ACTIVE.facebookPageAccessToken]) {
          expect(text).not.toContain(secret);
        }
        expect(await allSettings()).toEqual(before);
      });

      test("(signed route) the original user's deauthorization still erases the active connection after the refused reconnect", async () => {
        const { orgId, t, settings } = await run(PAGES, { me: () => graphJson({ id: "fb_intruder" }) });
        await insertSettings(t, orgId, { ...ACTIVE, facebookConnectedByUserId: "fb_original_user" });
        await expect(
          t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc" })
        ).rejects.toThrow(OTHER_USER_FAILED);

        const res = await postToRoute(t, "/facebook-deauthorize", "fb_original_user");

        expect(res.status).toBe(200);
        const row = await settings();
        expect(row?.facebookPageId).toBeUndefined();
        expect(row?.facebookPageAccessToken).toBeUndefined();
        expect(row?.facebookConnectedByUserId).toBeUndefined();
      });

      test("(action) the same user may reconnect over their own active connection", async () => {
        const { orgId, t, settings } = await run(PAGES, { me: () => graphJson({ id: "fb_original_user" }) });
        await insertSettings(t, orgId, { ...ACTIVE, facebookConnectedByUserId: "fb_original_user" });

        await t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc" });

        const row = await settings();
        expect(row?.facebookPageAccessToken).toBe(ACTIVE.facebookPageAccessToken);
        expect(row?.facebookConnectedByUserId).toBe("fb_original_user");
        expect(row?.facebookPendingCredentials).toEqual([{ id: "page_1", name: "Dealer One", token: SYNTHETIC_PAGE_TOKEN }]);
      });

      test("(action) a different user may replace pending-only state, which no active connection depends on", async () => {
        const { orgId, t, settings } = await run(PAGES, { me: () => graphJson({ id: "fb_new_user" }) });
        await insertSettings(t, orgId, {
          facebookConnectedByUserId: "fb_old_user",
          facebookPendingCredentials: [{ id: "page_old", name: "Old", token: "synthetic-old-pending" }],
        });

        await t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc" });

        const row = await settings();
        expect(row?.facebookConnectedByUserId).toBe("fb_new_user");
        expect(row?.facebookPendingCredentials).toEqual([{ id: "page_1", name: "Dealer One", token: SYNTHETIC_PAGE_TOKEN }]);
      });
    });

    describe("promoting pending credentials needs a stored Facebook user id", () => {
      async function select(fields: Partial<WithoutSystemFields<Doc<"orgSettings">>>) {
        const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
        const { orgId, asOwner } = await seedOwner(t);
        await insertSettings(t, orgId, {
          ...fields,
          facebookPendingCredentials: [{ id: "page_1", name: "Dealer One", token: SYNTHETIC_PAGE_TOKEN }],
        });
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);
        return {
          t,
          orgId,
          fetchSpy,
          settings: () => settingsOf(t, orgId),
          call: () => asOwner.action(api.facebookIntegrations.selectFacebookPage, { orgId, pageId: "page_1" }),
        };
      }

      test.each([
        ["missing", {}],
        ["empty", { facebookConnectedByUserId: "" }],
      ])("(action) a stored user id that is %s is refused before subscribed_apps, and nothing is promoted", async (_label, fields) => {
        const { fetchSpy, settings, call } = await select(fields);
        const before = await settings();

        const text = await failureText(call());

        expect(text).toMatch(/incomplete.*reconnect/i);
        expect(text).not.toMatch(/not in the pending list/i);
        expect(text).not.toContain(SYNTHETIC_PAGE_TOKEN);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(await settings()).toEqual(before);
      });

      // The id check must run AFTER the Page-in-use check, so a Page another org
      // holds is still reported as such.
      test("(action) a Page held by another org is still reported as such when the stored user id is also missing", async () => {
        const { t, fetchSpy, call } = await select({});
        const holder = await newOrg(t, "Holder");
        await insertSettings(t, holder, { facebookPageId: "page_1", facebookPageAccessToken: "synthetic-holder-token" });

        await expect(call()).rejects.toThrow(/already connected to another/i);
        expect(fetchSpy).not.toHaveBeenCalled();
      });

      test("(action) a stored user id still promotes the Page and keeps the id", async () => {
        const { fetchSpy, settings, call } = await select({ facebookConnectedByUserId: "fb_user_1" });
        fetchSpy.mockResolvedValue(graphJson({ success: true }));

        await call();

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(String(fetchSpy.mock.calls[0][0])).toContain("/page_1/subscribed_apps");
        const row = await settings();
        expect(row?.facebookPageAccessToken).toBe(SYNTHETIC_PAGE_TOKEN);
        expect(row?.facebookConnectedByUserId).toBe("fb_user_1");
      });
    });
  });

  test("an account with no Pages keeps its own message", async () => {
    const { orgId, t } = await run(() => graphJson({ data: [] }));
    await expect(
      t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc" })
    ).rejects.toThrow(/doesn't manage any Pages/i);
  });

  test("a provider error from /me/accounts is never reflected into the thrown error", async () => {
    const { orgId, t } = await run(() =>
      graphJson({ error: { message: `${SYNTHETIC_PROVIDER_TEXT} ${SYNTHETIC_PAGE_TOKEN}` } }, 400)
    );
    const text = await failureText(t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc" }));
    expect(text).toMatch(/could not be retrieved/i);
    expect(text).not.toContain(SYNTHETIC_PROVIDER_TEXT);
    expect(text).not.toContain(SYNTHETIC_PAGE_TOKEN);
  });

  test("a provider error from the token exchange is never reflected into the thrown error", async () => {
    const { orgId, t } = await run(() => graphJson({ data: [] }), {
      shortToken: () => graphJson({ error: { message: `${SYNTHETIC_PROVIDER_TEXT} ${SYNTHETIC_PAGE_TOKEN}` } }, 400),
    });
    const text = await failureText(t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc" }));
    expect(text).toMatch(/token exchange failed/i);
    expect(text).not.toContain(SYNTHETIC_PROVIDER_TEXT);
    expect(text).not.toContain(SYNTHETIC_PAGE_TOKEN);
  });
});

// SCRUM-841: selectFacebookPage's subscribed_apps URL carries the Page token as
// `access_token`, and its failure is persisted verbatim in webhookLogs. Neither
// Meta's error.message (which can echo a malformed token) nor a fetch failure
// (whose message can embed the request URL) may reach that row.
describe("facebookIntegrations.selectFacebookPage: subscription failure logging", () => {
  const SYNTHETIC_PAGE_TOKEN = "synthetic-page-token-DO-NOT-LEAK";
  const SYNTHETIC_PROVIDER_TEXT = "synthetic-provider-error-DO-NOT-LEAK";

  async function selectWith(subscribe: () => Promise<Response>) {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    await t.run((ctx) =>
      ctx.db.insert("orgSettings", {
        orgId,
        currency: "JOD",
        currencySymbol: "JD",
        enabledPaymentTypes: [],
        facebookConnectedByUserId: "fb_user_1",
        facebookPendingCredentials: [{ id: "page_1", name: "Dealer One", token: SYNTHETIC_PAGE_TOKEN }],
      })
    );
    vi.stubGlobal("fetch", vi.fn(subscribe));
    await asOwner.action(api.facebookIntegrations.selectFacebookPage, { orgId, pageId: "page_1" });
    const logs = await t.run((ctx) => ctx.db.query("webhookLogs").collect());
    const settings = await t.run((ctx) =>
      ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()
    );
    return { logs, settings };
  }

  test.each([
    [
      "a provider error that echoes the token",
      async () =>
        new Response(
          JSON.stringify({ error: { message: `${SYNTHETIC_PROVIDER_TEXT} Malformed access token ${SYNTHETIC_PAGE_TOKEN}` } }),
          { status: 400, headers: { "content-type": "application/json" } }
        ),
    ],
    [
      "a non-JSON provider body",
      async () => new Response(`<html>${SYNTHETIC_PROVIDER_TEXT} ${SYNTHETIC_PAGE_TOKEN}</html>`, { status: 502 }),
    ],
    [
      "a network failure whose message embeds the request URL",
      async () => {
        throw new Error(`request to https://graph.facebook.com/v1/page_1/subscribed_apps?access_token=${SYNTHETIC_PAGE_TOKEN} failed`);
      },
    ],
  ])("%s is logged without provider text or the token, and the Page is still saved", async (_label, subscribe) => {
    const { logs, settings } = await selectWith(subscribe);

    const failure = logs.find((l) => l.source === "facebook" && l.status === "error");
    expect(failure).toBeDefined();
    const stored = JSON.stringify(logs);
    expect(stored).not.toContain(SYNTHETIC_PAGE_TOKEN);
    expect(stored).not.toContain(SYNTHETIC_PROVIDER_TEXT);
    // Non-fatal by design: the connection is still completed.
    expect(settings?.facebookPageId).toBe("page_1");
    expect(settings?.facebookPageAccessToken).toBe(SYNTHETIC_PAGE_TOKEN);
  });
});
