import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

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
// stores in the admin-visible webhook log.
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

  // /me is untrusted too: connectedByUserId travels in the same mutation call as
  // the page tokens, so a non-string id would fail argument validation with the
  // whole argument — tokens included — in the error.
  test.each([
    ["a numeric id", 12345],
    ["an object id", { nested: "value" }],
    ["an empty id", ""],
  ])("%s from /me is omitted and the connection still completes", async (_label, badId) => {
    const { orgId, t, settings } = await run(
      () => graphJson({ data: [{ id: "page_1", name: "Dealer One", access_token: SYNTHETIC_PAGE_TOKEN }] }),
      { me: () => graphJson({ id: badId }) }
    );

    await t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc" });

    const row = await settings();
    expect(row?.facebookConnectedByUserId).toBeUndefined();
    expect(row?.facebookPendingCredentials).toEqual([
      { id: "page_1", name: "Dealer One", token: SYNTHETIC_PAGE_TOKEN },
    ]);
  });

  test("a valid /me id is still recorded", async () => {
    const { orgId, t, settings } = await run(() =>
      graphJson({ data: [{ id: "page_1", name: "Dealer One", access_token: SYNTHETIC_PAGE_TOKEN }] })
    );
    await t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc" });
    expect((await settings())?.facebookConnectedByUserId).toBe("fb_user_1");
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

  test("a rejected /me fetch is non-fatal and records no connected user id", async () => {
    const { orgId, t, settings } = await run(
      () => graphJson({ data: [{ id: "page_1", name: "Dealer One", access_token: SYNTHETIC_PAGE_TOKEN }] }),
      { me: rejectEmbeddingUrl }
    );
    await t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc" });
    const row = await settings();
    expect(row?.facebookConnectedByUserId).toBeUndefined();
    expect(row?.facebookAvailablePages).toEqual([{ id: "page_1", name: "Dealer One" }]);
  });

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
