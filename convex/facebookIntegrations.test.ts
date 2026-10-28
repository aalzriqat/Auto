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

/**
 * Writes Facebook fields straight onto an org's settings row (insert or patch),
 * bypassing the mutations under test. saveFacebookCredentials only finalizes
 * credentials that are still pending, so a test that merely needs "an active
 * connection" or "pending credentials" seeds them here instead.
 */
type T = ReturnType<typeof convexTestWithComponents<typeof schema>>;

async function upsertOrgSettings(
  t: T,
  orgId: Id<"organizations">,
  fields: Partial<WithoutSystemFields<Doc<"orgSettings">>>
) {
  await t.run(async (ctx) => {
    const existing = await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique();
    if (existing) await ctx.db.patch(existing._id, fields);
    else await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: [], ...fields });
  });
}

describe("facebookIntegrations.createConnectUrl", () => {
  test("returns a Meta OAuth dialog URL with a state param, owner-only", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
    const { orgId, asOwner } = await seedOwner(t);

    const before = await asOwner.query(api.facebookIntegrations.getConnectionStatus, { orgId });
    expect(before.facebookConnected).toBe(false);

    await upsertOrgSettings(t, orgId, {
      facebookPageId: "page_123",
      facebookPageAccessToken: "page_token_abc",
      facebookPageName: "My Dealership Page",
    });

    const after = await asOwner.query(api.facebookIntegrations.getConnectionStatus, { orgId });
    expect(after.facebookConnected).toBe(true);
    expect(after.facebookPageName).toBe("My Dealership Page");
  });

  test("disconnect clears stored credentials", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
    const { orgId, asOwner } = await seedOwner(t);

    await upsertOrgSettings(t, orgId, { facebookPageId: "page_123", facebookPageAccessToken: "page_token_abc" });

    await asOwner.mutation(api.facebookIntegrations.disconnect, { orgId });

    const status = await asOwner.query(api.facebookIntegrations.getConnectionStatus, { orgId });
    expect(status.facebookConnected).toBe(false);
  });
});

describe("facebookIntegrations.disconnectByFacebookConnectedUserId", () => {
  test("resolves the org via the connecting user's Facebook ID, not the Page ID", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
    const { orgId } = await seedOwner(t);

    await upsertOrgSettings(t, orgId, {
      facebookPageId: "page_123",
      facebookPageAccessToken: "page_token_abc",
      facebookConnectedByUserId: "fb_connecting_user_1",
    });

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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
    const { orgId, asOwner } = await seedOwner(t);

    await expect(
      asOwner.mutation(api.facebookIntegrations.setFacebookLeadCreationConfig, {
        orgId,
        leadFromCommentsEnabled: false,
        leadFromDmsEnabled: true,
        leadFromDmsRequiresMobile: true,
      })
    ).rejects.toThrow(/connect facebook/i);

    await upsertOrgSettings(t, orgId, { facebookPageId: "page_123", facebookPageAccessToken: "page_token_abc" });

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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
    const { orgId, asOwner } = await seedOwner(t);

    await asOwner.mutation(api.facebookIntegrations.createConnectUrl, { orgId });
    const { state, createdAt } = await t.run(async (ctx) => {
      const row = await ctx.db.query("oauthStates").first();
      return { state: row!.state, createdAt: row!.createdAt };
    });

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.facebookIntegrations.consumeOAuthState, { state })
    );
    // The attempt's start, which the revocation fence is compared against.
    expect(result?.createdAt).toBe(createdAt);
    expect(result?.orgId).toBe(orgId);

    const replay = await t.run((ctx) =>
      ctx.runMutation(internal.facebookIntegrations.consumeOAuthState, { state })
    );
    expect(replay).toBeNull();
  });

  test("returns null for an unknown state", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
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

  // Finalizes a Page the way selectFacebookPage does: the credentials must be
  // pending first, so seed them, then call the mutation under test.
  const seedPending = (t: T, orgId: Id<"organizations">, facebookPageId: string) =>
    upsertOrgSettings(t, orgId, {
      facebookConnectedByUserId: "fb_user_x",
      facebookPendingAttemptId: "attempt-x",
      facebookPendingCredentials: [{ id: facebookPageId, name: "Page", token: "token" }],
    });
  const finalize = (t: T, orgId: Id<"organizations">, facebookPageId: string) =>
    t.run((ctx) =>
      ctx.runMutation(internal.facebookIntegrations.saveFacebookCredentials, {
        orgId,
        facebookPageId,
        facebookPageAccessToken: "token",
        facebookConnectedByUserId: "fb_user_x",
        pendingAttemptId: "attempt-x",
      })
    );
  const save = async (t: T, orgId: Id<"organizations">, facebookPageId: string) => {
    await seedPending(t, orgId, facebookPageId);
    return finalize(t, orgId, facebookPageId);
  };

  test("refuses a Page already connected to another org, and leaves both orgs unchanged", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
    const { orgId: orgA } = await seedOwner(t);
    const { orgId: orgB } = await seedSecondOrg(t);
    await save(t, orgA, "page_shared");
    await seedPending(t, orgB, "page_shared");
    const allSettings = () => t.run((ctx) => ctx.db.query("orgSettings").collect());
    const before = await allSettings();

    await expect(finalize(t, orgB, "page_shared")).rejects.toThrow(/already connected to another/i);

    expect(await allSettings()).toEqual(before);
    const holders = await t.run((ctx) =>
      ctx.db.query("orgSettings").withIndex("by_facebook_page_id", (q) => q.eq("facebookPageId", "page_shared")).collect()
    );
    expect(holders.map((s) => s.orgId)).toEqual([orgA]);
  });

  test("the same org may reconnect its own Page", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
    const { orgId } = await seedOwner(t);
    await save(t, orgId, "page_mine");
    await expect(save(t, orgId, "page_mine")).resolves.toBeNull();
  });

  test("once the first org disconnects, another org may connect the Page", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
    const { orgId: orgA, asOwner } = await seedOwner(t);
    const { orgId: orgB } = await seedSecondOrg(t);
    await save(t, orgA, "page_moving");
    await asOwner.mutation(api.facebookIntegrations.disconnect, { orgId: orgA });
    await expect(save(t, orgB, "page_moving")).resolves.toBeNull();
  });

  test("picking a Page another org holds is refused before the Page is subscribed", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
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
  const CHANGED = /changed before it could be completed/i;
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
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

    await t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc", attemptStartedAt: Date.now() });

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

    const text = await failureText(t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc", attemptStartedAt: Date.now() }));

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
      await upsertOrgSettings(t, orgId, {
        facebookPageId: "page_active",
        facebookPageAccessToken: "active-page-token-synthetic",
        facebookConnectedByUserId: EXISTING_USER,
      });
      const before = await settings();
      expect(before).toMatchObject({
        facebookConnectedByUserId: EXISTING_USER,
        facebookPageAccessToken: "active-page-token-synthetic",
      });
      expect(before?.facebookPendingCredentials).toBeUndefined();

      const text = await failureText(t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc", attemptStartedAt: Date.now() }));

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
      t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc", attemptStartedAt: Date.now() })
    ).rejects.toThrow(ME_FAILED);
    expect(await settings()).toBeNull();
  });

  test("a recorded /me id lets the data-deletion lookup erase the pending Page tokens", async () => {
    const { orgId, t, settings } = await run(PAGES);
    await t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc", attemptStartedAt: Date.now() });
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
    const text = await failureText(t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc", attemptStartedAt: Date.now() }));
    expect(text).toMatch(/unexpected Pages response/i);
    expect(text).not.toContain(SYNTHETIC_PAGE_TOKEN);
  });

  test("a non-JSON /me/accounts body fails generically without quoting the body", async () => {
    const { orgId, t } = await run(() => new Response(`<html>${SYNTHETIC_PROVIDER_TEXT}</html>`, { status: 200 }));
    const text = await failureText(t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc", attemptStartedAt: Date.now() }));
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
      const text = await failureText(t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc", attemptStartedAt: Date.now() }));
      expect(text).toMatch(expected);
      for (const secret of [...URL_CREDENTIALS, SYNTHETIC_PROVIDER_TEXT]) expect(text).not.toContain(secret);
    }
  );

  // The callback records err.message in webhookLogs, so this is the stored-row
  // boundary: drive the real route, then read what it persisted.
  test("the OAuth callback stores a fixed message, not a credential-bearing fetch failure", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
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
  // a real HMAC-signed signed_request to the HTTP route. "(action)" ones call the
  // named action directly, "(mutation)" ones the named mutation, and
  // "(mutation sequence + action)" ones park selectFacebookPage and run a named
  // mutation in the gap; none of those prove anything about the HTTP route.
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

    async function postToRoute(t: T, path: string, userId: string) {
      return t.fetch(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ signed_request: await signedRequest({ user_id: userId }) }).toString(),
      });
    }

    const newOrg = (t: T, name: string) => t.run((ctx) => ctx.db.insert("organizations", { name, createdAt: Date.now() }));
    const settingsOf = (t: T, orgId: Id<"organizations">) =>
      t.run((ctx) => ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());

    test.each(["/facebook-deauthorize", "/facebook-data-deletion"])(
      "(signed route) %s erases every org the Facebook user connected, not just the first or the first few",
      async (path) => {
        const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
        const shared = [await newOrg(t, "A"), await newOrg(t, "B"), await newOrg(t, "C")];
        const orgOther = await newOrg(t, "Other");
        const connected = (suffix: string, userId: string) => ({
          facebookPageId: `page_${suffix}`,
          facebookPageAccessToken: `synthetic-token-${suffix}`,
          facebookPageName: suffix,
          facebookConnectedByUserId: userId,
        });
        await upsertOrgSettings(t, shared[0], connected("a", "fb_shared_user"));
        await upsertOrgSettings(t, shared[1], {
          ...connected("b", "fb_shared_user"),
          facebookPendingCredentials: [{ id: "page_b2", name: "B2", token: "synthetic-pending-b" }],
          facebookAvailablePages: [{ id: "page_b2", name: "B2" }],
        });
        await upsertOrgSettings(t, shared[2], connected("c", "fb_shared_user"));
        await upsertOrgSettings(t, orgOther, connected("other", "fb_someone_else"));
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
        await upsertOrgSettings(t, orgId, { ...ACTIVE, ...owner });
        const allSettings = () => t.run((ctx) => ctx.db.query("orgSettings").collect());
        const before = await allSettings();

        const text = await failureText(t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc", attemptStartedAt: Date.now() }));

        expect(text).toMatch(OTHER_USER_FAILED);
        for (const secret of [...URL_CREDENTIALS, SYNTHETIC_PAGE_TOKEN, ACTIVE.facebookPageAccessToken]) {
          expect(text).not.toContain(secret);
        }
        expect(await allSettings()).toEqual(before);
      });

      test("(signed route) the original user's deauthorization still erases the active connection after the refused reconnect", async () => {
        const { orgId, t, settings } = await run(PAGES, { me: () => graphJson({ id: "fb_intruder" }) });
        await upsertOrgSettings(t, orgId, { ...ACTIVE, facebookConnectedByUserId: "fb_original_user" });
        await expect(
          t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc", attemptStartedAt: Date.now() })
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
        await upsertOrgSettings(t, orgId, { ...ACTIVE, facebookConnectedByUserId: "fb_original_user" });

        await t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc", attemptStartedAt: Date.now() });

        const row = await settings();
        expect(row?.facebookPageAccessToken).toBe(ACTIVE.facebookPageAccessToken);
        expect(row?.facebookConnectedByUserId).toBe("fb_original_user");
        expect(row?.facebookPendingCredentials).toEqual([{ id: "page_1", name: "Dealer One", token: SYNTHETIC_PAGE_TOKEN }]);
      });

      test("(action) a different user may replace pending-only state, which no active connection depends on", async () => {
        const { orgId, t, settings } = await run(PAGES, { me: () => graphJson({ id: "fb_new_user" }) });
        await upsertOrgSettings(t, orgId, {
          facebookConnectedByUserId: "fb_old_user",
          facebookPendingCredentials: [{ id: "page_old", name: "Old", token: "synthetic-old-pending" }],
        });

        await t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc", attemptStartedAt: Date.now() });

        const row = await settings();
        expect(row?.facebookConnectedByUserId).toBe("fb_new_user");
        expect(row?.facebookPendingCredentials).toEqual([{ id: "page_1", name: "Dealer One", token: SYNTHETIC_PAGE_TOKEN }]);
      });
    });

    // selectFacebookPage reads the pending Page token, awaits Meta's
    // subscribed_apps call, and only then finalizes. Anything that invalidates
    // the pending credentials during that await (Meta's deauthorize / deletion
    // callback, or a newer OAuth) must stop the finalization, or the token is
    // resurrected after the callback reported success.
    describe("finalizing a Page selection requires the pending credentials to still match", () => {
      const PENDING = [{ id: "page_1", name: "Dealer One", token: SYNTHETIC_PAGE_TOKEN }];

      // A test that fails before finishing must not leave the action parked.
      let releaseParked: (() => void) | undefined;
      afterEach(() => releaseParked?.());

      /** Starts selectFacebookPage and parks it inside its subscribed_apps fetch. */
      async function parkedSelect(extra: Partial<WithoutSystemFields<Doc<"orgSettings">>> = {}) {
        const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
        const { orgId, asOwner } = await seedOwner(t);
        await upsertOrgSettings(t, orgId, {
          facebookConnectedByUserId: "fb_user_1",
          facebookPendingAttemptId: "attempt-a",
          facebookPendingCredentials: PENDING,
          ...extra,
        });
        let release!: (reply: Response) => void;
        const gate = new Promise<Response>((resolve) => (release = resolve));
        releaseParked = () => release(graphJson({ success: true }));
        const fetchSpy = vi.fn(() => gate);
        vi.stubGlobal("fetch", fetchSpy);
        const run = asOwner.action(api.facebookIntegrations.selectFacebookPage, { orgId, pageId: "page_1" });
        run.catch(() => undefined); // observed later by finish*(); never an unhandled rejection
        await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
        return {
          t,
          asOwner,
          orgId,
          settings: () => settingsOf(t, orgId),
          /** Lets Meta's reply through and returns the failure text; fails the test if the action succeeded. */
          finish: async () => {
            releaseParked?.();
            return failureText(run);
          },
          /** Lets Meta's reply through and expects the action to succeed. */
          finishOk: async () => {
            releaseParked?.();
            await run;
          },
        };
      }
      const expectNoActiveCredentials = (row: Awaited<ReturnType<typeof settingsOf>>) => {
        expect(row?.facebookPageId).toBeUndefined();
        expect(row?.facebookPageAccessToken).toBeUndefined();
        expect(row?.facebookConnectedByUserId).toBeUndefined();
      };

      test.each(["/facebook-deauthorize", "/facebook-data-deletion"])(
        "(signed route + action) %s during the subscribe call stops the Page being finalized",
        async (path) => {
          const { t, settings, finish } = await parkedSelect();

          const res = await postToRoute(t, path, "fb_user_1");
          expect(res.status).toBe(200);
          expect((await settings())?.facebookPendingCredentials).toBeUndefined();

          const text = await finish();

          expect(text).toMatch(CHANGED);
          expect(text).not.toContain(SYNTHETIC_PAGE_TOKEN);
          const row = await settings();
          expectNoActiveCredentials(row);
          expect(row?.facebookPendingCredentials).toBeUndefined();
          expect(JSON.stringify(await t.run((ctx) => ctx.db.query("webhookLogs").collect()))).not.toContain(SYNTHETIC_PAGE_TOKEN);
        }
      );

      test.each([
        ["replaced the Page token", "fb_user_1", [{ id: "page_1", name: "Dealer One", access_token: "synthetic-newer-token" }]],
        ["came from a different Facebook user", "fb_user_2", [{ id: "page_1", name: "Dealer One", access_token: SYNTHETIC_PAGE_TOKEN }]],
        ["no longer lists the Page", "fb_user_1", [{ id: "page_other", name: "Other", access_token: "synthetic-newer-token" }]],
      ])(
        "(mutation sequence + action) a newer OAuth (saveFacebookPendingPages) that %s stops the Page being finalized and is not overwritten",
        async (_label, userId, pages) => {
          const { t, orgId, settings, finish } = await parkedSelect();
          await t.run((ctx) =>
            ctx.runMutation(internal.facebookIntegrations.saveFacebookPendingPages, {
              orgId,
              pages,
              connectedByUserId: userId,
              attemptStartedAt: Date.now(),
            })
          );

          const text = await finish();

          expect(text).toMatch(CHANGED);
          for (const secret of [SYNTHETIC_PAGE_TOKEN, "synthetic-newer-token"]) expect(text).not.toContain(secret);
          const row = await settings();
          expect(row?.facebookPageId).toBeUndefined();
          expect(row?.facebookPageAccessToken).toBeUndefined();
          expect(row?.facebookConnectedByUserId).toBe(userId);
          expect(row?.facebookPendingCredentials).toEqual(pages.map(({ id, name, access_token }) => ({ id, name, token: access_token })));
          expect(JSON.stringify(await t.run((ctx) => ctx.db.query("webhookLogs").collect()))).not.toMatch(/synthetic-(page|newer)/);
        }
      );

      test("(mutation sequence + action) switching Pages while connected: a refused finalization leaves the existing connection intact", async () => {
        const ACTIVE = { facebookPageId: "page_old", facebookPageAccessToken: "synthetic-old-active-token" };
        const { t, orgId, settings, finish } = await parkedSelect(ACTIVE);
        await t.run((ctx) =>
          ctx.runMutation(internal.facebookIntegrations.saveFacebookPendingPages, {
            orgId,
            pages: [{ id: "page_1", name: "Dealer One", access_token: "synthetic-newer-token" }],
            connectedByUserId: "fb_user_1",
            attemptStartedAt: Date.now(),
          })
        );

        expect(await finish()).toMatch(CHANGED);

        expect(await settings()).toMatchObject({ ...ACTIVE, facebookConnectedByUserId: "fb_user_1" });
      });

      test("(mutation + action) an admin disconnect during the subscribe call stops the Page being finalized", async () => {
        const { orgId, asOwner, settings, finish } = await parkedSelect();
        await asOwner.mutation(api.facebookIntegrations.disconnect, { orgId });

        const text = await finish();

        expect(text).toMatch(CHANGED);
        expect(text).not.toContain(SYNTHETIC_PAGE_TOKEN);
        const row = await settings();
        expectNoActiveCredentials(row);
        expect(row?.facebookPendingCredentials).toBeUndefined();
      });

      test("(signed route + action) a callback for an unrelated Facebook user does not stop the finalization", async () => {
        const { t, settings, finishOk } = await parkedSelect();
        expect((await postToRoute(t, "/facebook-deauthorize", "fb_someone_else")).status).toBe(200);

        await finishOk();

        const row = await settings();
        expect(row?.facebookPageAccessToken).toBe(SYNTHETIC_PAGE_TOKEN);
        expect(row?.facebookConnectedByUserId).toBe("fb_user_1");
      });

      describe("(mutation) saveFacebookCredentials itself", () => {
        const call = (
          t: T,
          orgId: Id<"organizations">,
          over: { pageId?: string; token?: string; userId?: string; attemptId?: string } = {}
        ) =>
          t.run((ctx) =>
            ctx.runMutation(internal.facebookIntegrations.saveFacebookCredentials, {
              orgId,
              facebookPageId: over.pageId ?? "page_1",
              facebookPageAccessToken: over.token ?? SYNTHETIC_PAGE_TOKEN,
              facebookPageName: "Dealer One",
              facebookConnectedByUserId: over.userId ?? "fb_user_1",
              pendingAttemptId: over.attemptId ?? "attempt-1",
            })
          );

        // The stored user id is explicit on every row: a default would silently
        // turn the missing-id case into the ordinary one.
        test.each([
          ["no pending credentials at all", {}, undefined, "fb_user_1"],
          ["a different Page token", { token: "synthetic-other-token" }, PENDING, "fb_user_1"],
          ["a different Page id", { pageId: "page_other" }, PENDING, "fb_user_1"],
          ["a different connecting user", { userId: "fb_user_2" }, PENDING, "fb_user_1"],
          ["an empty connecting user, even when the stored id is also empty", { userId: "" }, PENDING, ""],
          ["a row with no stored connecting user", {}, PENDING, undefined],
        ] as const)("refuses %s, with fixed text, and writes nothing", async (_label, over, pending, storedUserId) => {
          const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
          const { orgId } = await seedOwner(t);
          await upsertOrgSettings(t, orgId, {
            facebookConnectedByUserId: storedUserId,
            facebookPendingAttemptId: "attempt-1",
            facebookPendingCredentials: pending && [...pending],
          });
          const before = await settingsOf(t, orgId);

          const text = await failureText(call(t, orgId, over));

          expect(text).toMatch(CHANGED);
          for (const secret of [SYNTHETIC_PAGE_TOKEN, "synthetic-other-token"]) expect(text).not.toContain(secret);
          expect(await settingsOf(t, orgId)).toEqual(before);
        });

        // SCRUM-841: the Page, token and user can be identical across two attempts, so only
        // the attempt generation tells an old selection from the current one.
        test("refuses a different attempt generation even when the Page, token and user all match", async () => {
          const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
          const { orgId } = await seedOwner(t);
          await upsertOrgSettings(t, orgId, {
            facebookConnectedByUserId: "fb_user_1",
            facebookPendingAttemptId: "attempt-2",
            facebookPendingCredentials: [...PENDING],
          });
          const before = await settingsOf(t, orgId);

          const text = await failureText(call(t, orgId, { attemptId: "attempt-1" }));

          expect(text).toMatch(CHANGED);
          expect(text).not.toContain(SYNTHETIC_PAGE_TOKEN);
          expect(await settingsOf(t, orgId)).toEqual(before);
        });

        test("refuses when the row has no attempt generation at all", async () => {
          const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
          const { orgId } = await seedOwner(t);
          await upsertOrgSettings(t, orgId, { facebookConnectedByUserId: "fb_user_1", facebookPendingCredentials: [...PENDING] });
          const before = await settingsOf(t, orgId);

          await expect(call(t, orgId)).rejects.toThrow(CHANGED);

          expect(await settingsOf(t, orgId)).toEqual(before);
        });

        test("refuses when the org has no settings row at all, and creates none", async () => {
          const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
          const { orgId } = await seedOwner(t);

          expect(await failureText(call(t, orgId))).toMatch(CHANGED);

          expect(await t.run((ctx) => ctx.db.query("orgSettings").collect())).toEqual([]);
        });

        test("finalizes when the pending Page, token and connecting user all still match", async () => {
          const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
          const { orgId } = await seedOwner(t);
          await upsertOrgSettings(t, orgId, {
            facebookConnectedByUserId: "fb_user_1",
            facebookPendingAttemptId: "attempt-1",
            facebookPendingCredentials: [...PENDING, { id: "page_2", name: "Second", token: "synthetic-second-token" }],
            facebookAvailablePages: [{ id: "page_1", name: "Dealer One" }],
          });

          await call(t, orgId);

          const row = await settingsOf(t, orgId);
          expect(row).toMatchObject({
            facebookPageId: "page_1",
            facebookPageAccessToken: SYNTHETIC_PAGE_TOKEN,
            facebookPageName: "Dealer One",
            facebookConnectedByUserId: "fb_user_1",
          });
          expect(row?.facebookPendingCredentials).toBeUndefined();
          expect(row?.facebookAvailablePages).toBeUndefined();
          expect(row?.facebookPendingAttemptId).toBeUndefined();
        });
      });
    });

    // SCRUM-841 R1. The exchange awaits /me/accounts after it knows the Facebook
    // user. A signed callback for that user landing in that gap used to be undone
    // when the exchange then stored the Page tokens it had already fetched
    // (including for a first-time connection, where the callback finds no row to
    // clear). Every "(signed route + real callback)" test drives the real
    // /facebook-oauth-callback route. The parked ones hold the exchange at
    // /me/accounts, POST the HMAC-signed routes in that gap, then release it; the
    // sequential ones run the callback wholly before or wholly after the attempt.
    // "(owner disconnect + real callback)" tests do the same with the Owner's
    // disconnect, which the signed-callback fence cannot see (see its block below).
    // The two "(mutation)" blocks pin each fence's own rules (ties, monotonic time,
    // retention age); the hourly sweep that deletes expired Meta-user fences is
    // covered in adminSystem.test.ts.
    describe("an OAuth attempt begun before a signed callback or an Owner disconnect cannot restore credentials", () => {
      const USER = "fb_user_1";
      const REVOKED = /revoked while connecting/i;
      const EXPIRED = /connection attempt expired/i;
      const ROUTES = ["/facebook-deauthorize", "/facebook-data-deletion"] as const;
      const ACTIVE = { facebookPageId: "page_old", facebookPageAccessToken: "synthetic-old-active-token", facebookConnectedByUserId: USER };
      const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
      // A timer can fire with no measurable delay after a long microtask chain, so
      // order events on the clock the code under test reads: wait until it is
      // strictly past `ms`. Ties favour the revocation, so this is what makes
      // "strictly later" true.
      const after = async (ms: number) => {
        while (Date.now() <= ms) await sleep(1);
      };
      const fenceTime = async (t: T) => (await t.run((ctx) => ctx.db.query("facebookRevocations").first()))!.revokedAt;

      let releaseExchange: (() => void) | undefined;
      afterEach(() => releaseExchange?.());

      /** Creates a real OAuth state (the attempt's start) and returns its token. */
      async function startAttempt(asOwner: ReturnType<T["withIdentity"]>, orgId: Id<"organizations">) {
        const url = await asOwner.mutation(api.facebookIntegrations.createConnectUrl, { orgId });
        return new URL(url).searchParams.get("state")!;
      }
      const callbackUrl = (state: string) => `/facebook-oauth-callback?code=abc&state=${state}`;

      /** Runs the real callback with the exchange parked inside /me/accounts. */
      async function parkedExchange(seed?: (t: T, orgId: Id<"organizations">) => Promise<void>) {
        const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
        const { orgId, asOwner } = await seedOwner(t);
        await seed?.(t, orgId);
        const state = await startAttempt(asOwner, orgId);
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        releaseExchange = release;
        let parked = false;
        stubGraph(
          async () => {
            parked = true;
            await gate;
            return PAGES();
          },
          { me: () => graphJson({ id: USER }) }
        );
        const callback = t.fetch(callbackUrl(state), { redirect: "manual" });
        callback.catch(() => undefined); // observed by finish(); never an unhandled rejection
        await vi.waitFor(() => expect(parked).toBe(true), { timeout: 4_000 });
        return {
          t,
          orgId,
          asOwner,
          finish: async () => {
            release();
            return callback;
          },
        };
      }

      const logsOf = (t: T) => t.run((ctx) => ctx.db.query("webhookLogs").collect());
      /** The attempt was refused: error redirect, fixed log text, no token anywhere. */
      async function expectRefused(t: T, res: Response, reason: RegExp = REVOKED) {
        expect(res.status).toBe(302);
        expect(res.headers.get("location")).toContain("error=1");
        const logs = await logsOf(t);
        expect(logs.find((l) => l.source === "facebook-oauth" && l.status === "error")?.error).toMatch(reason);
        const visible = JSON.stringify(logs) + (res.headers.get("location") ?? "");
        for (const secret of [...URL_CREDENTIALS, SYNTHETIC_PAGE_TOKEN, ACTIVE.facebookPageAccessToken]) {
          expect(visible).not.toContain(secret);
        }
      }
      // Stores pending Pages for USER, as the exchange's final step does, for an attempt begun at the given time.
      const savePending = (t: T, orgId: Id<"organizations">, attemptStartedAt: number) =>
        t.run((ctx) =>
          ctx.runMutation(internal.facebookIntegrations.saveFacebookPendingPages, {
            orgId,
            pages: [{ id: "page_1", name: "Dealer One", access_token: SYNTHETIC_PAGE_TOKEN }],
            connectedByUserId: USER,
            attemptStartedAt,
          })
        );
      const expectNoCredentials = (row: Awaited<ReturnType<typeof settingsOf>>) => {
        expect(row?.facebookPageId).toBeUndefined();
        expect(row?.facebookPageAccessToken).toBeUndefined();
        expect(row?.facebookConnectedByUserId).toBeUndefined();
        expect(row?.facebookPendingCredentials).toBeUndefined();
        expect(row?.facebookAvailablePages).toBeUndefined();
      };

      test.each(ROUTES)("(signed route + real callback) %s during the exchange: a first-time connection stores nothing", async (path) => {
        const { t, orgId, finish } = await parkedExchange();

        expect((await postToRoute(t, path, USER)).status).toBe(200);
        const res = await finish();

        await expectRefused(t, res);
        expect(await settingsOf(t, orgId)).toBeNull();
      });

      test.each(ROUTES)("(signed route + real callback) %s during the exchange: a same-user reconnect over an active connection ends with no credentials", async (path) => {
        const { t, orgId, finish } = await parkedExchange((seedT, seedOrgId) => upsertOrgSettings(seedT, seedOrgId, ACTIVE));

        expect((await postToRoute(t, path, USER)).status).toBe(200);
        const res = await finish();

        await expectRefused(t, res);
        expectNoCredentials(await settingsOf(t, orgId));
      });

      test.each(ROUTES)("(signed route + real callback) %s during the exchange: every org of that user ends with no credentials", async (path) => {
        let orgB!: Id<"organizations">;
        const { t, orgId, finish } = await parkedExchange(async (seedT, seedOrgId) => {
          await upsertOrgSettings(seedT, seedOrgId, ACTIVE);
          orgB = await newOrg(seedT, "B");
          await upsertOrgSettings(seedT, orgB, {
            facebookPageId: "page_b",
            facebookPageAccessToken: "synthetic-b-active-token",
            facebookConnectedByUserId: USER,
            facebookPendingCredentials: [{ id: "page_b2", name: "B2", token: "synthetic-b-pending" }],
          });
        });

        expect((await postToRoute(t, path, USER)).status).toBe(200);
        const res = await finish();

        await expectRefused(t, res);
        expectNoCredentials(await settingsOf(t, orgId));
        expectNoCredentials(await settingsOf(t, orgB));
      });

      test.each(ROUTES)("(signed route + real callback) %s arriving after the attempt has stored its credentials still clears them", async (path) => {
        const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
        const { orgId, asOwner } = await seedOwner(t);
        stubGraph(PAGES, { me: () => graphJson({ id: USER }) });
        const res = await t.fetch(callbackUrl(await startAttempt(asOwner, orgId)), { redirect: "manual" });
        expect(res.headers.get("location")).toMatch(/\?connected=facebook$/);
        expect((await settingsOf(t, orgId))?.facebookPendingCredentials).toHaveLength(1);

        expect((await postToRoute(t, path, USER)).status).toBe(200);

        expectNoCredentials(await settingsOf(t, orgId));
      });

      test("(signed route + real callback) a callback for an unrelated Facebook user does not stop the attempt", async () => {
        const { t, orgId, finish } = await parkedExchange();

        expect((await postToRoute(t, "/facebook-deauthorize", "fb_someone_else")).status).toBe(200);
        const res = await finish();

        expect(res.headers.get("location")).toMatch(/\?connected=facebook$/);
        expect((await settingsOf(t, orgId))?.facebookPendingCredentials).toEqual([
          { id: "page_1", name: "Dealer One", token: SYNTHETIC_PAGE_TOKEN },
        ]);
      });

      test("(signed route + real callback) an attempt begun BEFORE the callback is refused even when its exchange runs entirely AFTER it", async () => {
        const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
        const { orgId, asOwner } = await seedOwner(t);
        const state = await startAttempt(asOwner, orgId);
        stubGraph(PAGES, { me: () => graphJson({ id: USER }) });

        expect((await postToRoute(t, "/facebook-deauthorize", USER)).status).toBe(200);
        // The route's own entry time must be strictly later than the callback, so a
        // tie cannot hide a regression that passes "now" instead of the state's
        // createdAt (which is what makes this attempt "begun before").
        await after(await fenceTime(t));
        const res = await t.fetch(callbackUrl(state), { redirect: "manual" });

        await expectRefused(t, res);
        expect(await settingsOf(t, orgId)).toBeNull();
      });

      test.each(ROUTES)("(signed route + real callback) a genuinely new attempt begun after %s still connects", async (path) => {
        const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
        const { orgId, asOwner } = await seedOwner(t);
        stubGraph(PAGES, { me: () => graphJson({ id: USER }) });
        expect((await postToRoute(t, path, USER)).status).toBe(200);
        await after(await fenceTime(t)); // the new state must be strictly later than the callback

        const res = await t.fetch(callbackUrl(await startAttempt(asOwner, orgId)), { redirect: "manual" });

        expect(res.headers.get("location")).toMatch(/\?connected=facebook$/);
        const row = await settingsOf(t, orgId);
        expect(row?.facebookConnectedByUserId).toBe(USER);
        expect(row?.facebookPendingCredentials).toHaveLength(1);
      });

      // SCRUM-841, Owner disconnect. The Owner's disconnect clears the org's credentials
      // but is not keyed by Facebook user, so the signed-callback fence above cannot see it.
      // An exchange already past consumeOAuthState, or a state never consumed, must not be
      // able to recreate pending credentials afterwards. The org-scoped fence
      // orgSettings.facebookDisconnectedAt is compared with the attempt's start inside the
      // save mutation: the Graph call is an action, outside any transaction.
      describe("an Owner disconnect cancels attempts begun before it", () => {
        const DISCONNECTED = /disconnected while connecting/i;
        const disconnectedAtOf = async (t: T, orgId: Id<"organizations">) => {
          const at = (await settingsOf(t, orgId))?.facebookDisconnectedAt;
          expect(at).toBeDefined();
          return at!;
        };

        test.each([
          ["an active connection", (seedT: T, seedOrgId: Id<"organizations">) => upsertOrgSettings(seedT, seedOrgId, ACTIVE)],
          ["a settings row with no Facebook data", (seedT: T, seedOrgId: Id<"organizations">) => upsertOrgSettings(seedT, seedOrgId, {})],
          ["no settings row at all", undefined],
        ])("(owner disconnect + real callback) during the exchange: %s ends with no credentials and a refused attempt", async (_label, seed) => {
          const { t, orgId, asOwner, finish } = await parkedExchange(seed);

          await asOwner.mutation(api.facebookIntegrations.disconnect, { orgId });
          const res = await finish();

          await expectRefused(t, res, DISCONNECTED);
          const row = await settingsOf(t, orgId);
          expectNoCredentials(row);
          expect(row?.facebookDisconnectedAt).toBeDefined();
        });

        test("(owner disconnect + real callback) a state that was never consumed cannot proceed after the disconnect", async () => {
          const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
          const { orgId, asOwner } = await seedOwner(t);
          const state = await startAttempt(asOwner, orgId);
          stubGraph(PAGES, { me: () => graphJson({ id: USER }) });

          await asOwner.mutation(api.facebookIntegrations.disconnect, { orgId });
          // The route's own entry time must be strictly later than the disconnect, so a tie
          // cannot hide a regression that passes "now" instead of the state's createdAt.
          await after(await disconnectedAtOf(t, orgId));
          const res = await t.fetch(callbackUrl(state), { redirect: "manual" });

          await expectRefused(t, res, DISCONNECTED);
          expectNoCredentials(await settingsOf(t, orgId));
        });

        test("(owner disconnect + real callback) a genuinely new attempt begun after the disconnect still connects", async () => {
          const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
          const { orgId, asOwner } = await seedOwner(t);
          await upsertOrgSettings(t, orgId, ACTIVE);
          stubGraph(PAGES, { me: () => graphJson({ id: USER }) });
          await asOwner.mutation(api.facebookIntegrations.disconnect, { orgId });
          const disconnectedAt = await disconnectedAtOf(t, orgId);
          await after(disconnectedAt); // the new state must be strictly later than the disconnect

          const res = await t.fetch(callbackUrl(await startAttempt(asOwner, orgId)), { redirect: "manual" });

          expect(res.headers.get("location")).toMatch(/\?connected=facebook$/);
          const row = await settingsOf(t, orgId);
          expect(row?.facebookConnectedByUserId).toBe(USER);
          expect(row?.facebookPendingCredentials).toHaveLength(1);
          expect(row?.facebookDisconnectedAt).toBe(disconnectedAt); // the fence is a record; connecting does not clear it
        });

        test("(owner disconnect + real callback) a disconnect after the attempt has stored its credentials still clears them", async () => {
          const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
          const { orgId, asOwner } = await seedOwner(t);
          stubGraph(PAGES, { me: () => graphJson({ id: USER }) });
          const res = await t.fetch(callbackUrl(await startAttempt(asOwner, orgId)), { redirect: "manual" });
          expect(res.headers.get("location")).toMatch(/\?connected=facebook$/);
          expect((await settingsOf(t, orgId))?.facebookPendingCredentials).toHaveLength(1);

          await asOwner.mutation(api.facebookIntegrations.disconnect, { orgId });

          expectNoCredentials(await settingsOf(t, orgId));
        });

        test("(owner disconnect + signed route) when both fences apply, the Meta-user fence is checked first", async () => {
          const { t, orgId, asOwner, finish } = await parkedExchange();

          expect((await postToRoute(t, "/facebook-deauthorize", USER)).status).toBe(200);
          await asOwner.mutation(api.facebookIntegrations.disconnect, { orgId });
          const res = await finish();

          await expectRefused(t, res); // REVOKED: the Meta-user fence, not the org fence, is what stopped it
          expectNoCredentials(await settingsOf(t, orgId));
        });

        // SCRUM-841. A Page selection is long-lived: it awaits Meta's subscribed_apps call and then
        // promotes whatever is pending. If the Owner disconnects meanwhile and a genuinely new
        // attempt for the same user, Pages and token stores pending credentials again, an old
        // selection that checks only Page, token and user would promote the NEW attempt's
        // credentials. Only the attempt generation tells them apart.
        describe("a Page selection begun on an earlier attempt cannot promote a later attempt's credentials", () => {
          /** Two real OAuth attempts (same user, Pages, token) with the first one's selection parked in between. */
          async function interleave(between: "an Owner disconnect" | "a second attempt, no disconnect" | "no second attempt") {
            const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
            const { orgId, asOwner } = await seedOwner(t);
            stubGraph(PAGES, { me: () => graphJson({ id: USER }) });
            const graphFetch = globalThis.fetch;
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            releaseExchange = release;
            let subscribeCalls = 0;
            vi.stubGlobal(
              "fetch",
              vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
                const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
                if (href.includes("/subscribed_apps")) {
                  subscribeCalls += 1;
                  await gate;
                  return graphJson({ success: true });
                }
                return graphFetch(input, init);
              })
            );
            const connect = async () => {
              const res = await t.fetch(callbackUrl(await startAttempt(asOwner, orgId)), { redirect: "manual" });
              expect(res.headers.get("location")).toMatch(/\?connected=facebook$/);
            };

            await connect(); // attempt 1
            const generation1 = (await settingsOf(t, orgId))?.facebookPendingAttemptId;
            const oldSelection = asOwner.action(api.facebookIntegrations.selectFacebookPage, { orgId, pageId: "page_1" });
            oldSelection.catch(() => undefined); // observed by the test; never an unhandled rejection
            await vi.waitFor(() => expect(subscribeCalls).toBe(1), { timeout: 4_000 });

            if (between !== "no second attempt") {
              if (between === "an Owner disconnect") {
                await asOwner.mutation(api.facebookIntegrations.disconnect, { orgId });
                await after(await disconnectedAtOf(t, orgId)); // the new attempt must start strictly later
              }
              await connect(); // attempt 2: the same user, Pages and token
            }
            const generation2 = (await settingsOf(t, orgId))?.facebookPendingAttemptId;
            return { t, orgId, asOwner, release, oldSelection, generation1, generation2 };
          }

          test.each([
            ["owner disconnect + real callback + selection", "an Owner disconnect"],
            ["real callback + selection", "a second attempt, no disconnect"],
          ] as const)(
            "(%s) after %s, the old selection is refused and the new attempt's credentials are untouched",
            async (_label, between) => {
              const x = await interleave(between);
              // The premise: the credentials are identical, only the generation differs.
              expect(x.generation1).toBeDefined();
              expect(x.generation2).toBeDefined();
              expect(x.generation2).not.toBe(x.generation1);

              x.release();
              const text = await failureText(x.oldSelection);

              expect(text).toMatch(CHANGED);
              expect(text).not.toContain(SYNTHETIC_PAGE_TOKEN);
              const row = await settingsOf(x.t, x.orgId);
              expect(row?.facebookPageId).toBeUndefined();
              expect(row?.facebookPageAccessToken).toBeUndefined();
              expect(row?.facebookPendingAttemptId).toBe(x.generation2);
              expect(row?.facebookPendingCredentials).toEqual([{ id: "page_1", name: "Dealer One", token: SYNTHETIC_PAGE_TOKEN }]);
            }
          );

          test("(owner disconnect + real callback + selection) the new attempt's own selection then succeeds", async () => {
            const x = await interleave("an Owner disconnect");
            x.release();
            await failureText(x.oldSelection); // the old one is refused...

            await x.asOwner.action(api.facebookIntegrations.selectFacebookPage, { orgId: x.orgId, pageId: "page_1" });

            const row = await settingsOf(x.t, x.orgId); // ...and the current one promotes
            expect(row?.facebookPageAccessToken).toBe(SYNTHETIC_PAGE_TOKEN);
            expect(row?.facebookConnectedByUserId).toBe(USER);
            expect(row?.facebookPendingCredentials).toBeUndefined();
            expect(row?.facebookPendingAttemptId).toBeUndefined();
          });

          test("(real callback + selection) an uninterrupted selection succeeds", async () => {
            const x = await interleave("no second attempt");
            expect(x.generation2).toBe(x.generation1);

            x.release();
            await x.oldSelection;

            const row = await settingsOf(x.t, x.orgId);
            expect(row?.facebookPageAccessToken).toBe(SYNTHETIC_PAGE_TOKEN);
            expect(row?.facebookPendingAttemptId).toBeUndefined();
          });
        });

        describe("(mutation) the org fence itself", () => {
          test("with no settings row the disconnect still records it: same millisecond is refused, 1 ms later is stored", async () => {
            const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
            const { orgId, asOwner } = await seedOwner(t);
            expect(await settingsOf(t, orgId)).toBeNull();

            await asOwner.mutation(api.facebookIntegrations.disconnect, { orgId });
            const disconnectedAt = await disconnectedAtOf(t, orgId);

            await expect(savePending(t, orgId, disconnectedAt)).rejects.toThrow(DISCONNECTED);
            expect((await settingsOf(t, orgId))?.facebookPendingCredentials).toBeUndefined();
            await expect(savePending(t, orgId, disconnectedAt + 1)).resolves.toBeNull();
            expect((await settingsOf(t, orgId))?.facebookPendingCredentials).toHaveLength(1);
          });

          test("a later disconnect never moves the fence backwards", async () => {
            const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
            const { orgId, asOwner } = await seedOwner(t);
            const later = Date.now() + 60_000;
            await upsertOrgSettings(t, orgId, { facebookDisconnectedAt: later });

            await asOwner.mutation(api.facebookIntegrations.disconnect, { orgId });

            expect(await disconnectedAtOf(t, orgId)).toBe(later);
          });

          test("it is per organization: another org's attempt of the same age is not blocked", async () => {
            const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
            const { orgId, asOwner } = await seedOwner(t);
            const otherOrg = await newOrg(t, "Other");
            await asOwner.mutation(api.facebookIntegrations.disconnect, { orgId });
            const disconnectedAt = await disconnectedAtOf(t, orgId);

            await expect(savePending(t, orgId, disconnectedAt)).rejects.toThrow(DISCONNECTED);
            await expect(savePending(t, otherOrg, disconnectedAt)).resolves.toBeNull();
            expect((await settingsOf(t, otherOrg))?.facebookDisconnectedAt).toBeUndefined();
          });

          test("only the Owner can set it: a member's disconnect is refused and records nothing", async () => {
            const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
            const { orgId } = await seedOwner(t);
            const memberUser = await t.run((ctx) =>
              ctx.db.insert("users", { clerkId: "fb_member_002", email: "fbm@test.com", name: "Member" })
            );
            const memberRole = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:settings"] }));
            await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: memberUser, roleId: memberRole }));
            const asMember = t.withIdentity({ subject: "fb_member_002" });

            await expect(asMember.mutation(api.facebookIntegrations.disconnect, { orgId })).rejects.toThrow(
              /only the organization owner/i
            );

            expect(await settingsOf(t, orgId)).toBeNull();
          });
        });
      });

      describe("(mutation) the Meta-user fence itself", () => {
        const fences = (t: T) => t.run((ctx) => ctx.db.query("facebookRevocations").collect());
        const revoke = (t: T, userId = USER) =>
          t.run((ctx) => ctx.runMutation(internal.facebookIntegrations.disconnectByFacebookConnectedUserId, { facebookConnectedByUserId: userId }));

        test("a callback with no org row records a fence; an attempt starting in the same millisecond is refused, one starting 1 ms later connects", async () => {
          const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
          const { orgId } = await seedOwner(t);
          await revoke(t);
          const [fence] = await fences(t);
          expect(fence).toMatchObject({ facebookUserId: USER });

          await expect(savePending(t, orgId, fence.revokedAt)).rejects.toThrow(REVOKED);
          expect(await settingsOf(t, orgId)).toBeNull();
          await expect(savePending(t, orgId, fence.revokedAt + 1)).resolves.toBeNull();
          expect((await settingsOf(t, orgId))?.facebookPendingCredentials).toHaveLength(1);
        });

        test("a repeated callback keeps one row per user and advances its time", async () => {
          const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
          await revoke(t);
          const [first] = await fences(t);
          expect(first).toMatchObject({ facebookUserId: USER });
          await after(first.revokedAt);
          await revoke(t);
          const rows = await fences(t);
          expect(rows).toHaveLength(1);
          expect(rows[0].revokedAt).toBeGreaterThan(first.revokedAt);
        });

        test("a callback never moves a fence's time backwards", async () => {
          const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
          const later = Date.now() + 60_000;
          await t.run((ctx) => ctx.db.insert("facebookRevocations", { facebookUserId: USER, revokedAt: later }));

          await revoke(t);

          expect(await fences(t)).toMatchObject([{ facebookUserId: USER, revokedAt: later }]);
        });

        test("an attempt older than the retention window is refused as expired when no fence is on record (as after the sweep)", async () => {
          const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
          const { orgId } = await seedOwner(t);
          expect(await fences(t)).toEqual([]);

          for (const age of [2 * 60 * 60 * 1000, 61 * 60 * 1000]) {
            await expect(savePending(t, orgId, Date.now() - age)).rejects.toThrow(EXPIRED);
          }
          expect(await settingsOf(t, orgId)).toBeNull();
        });

        test("an attempt still inside the retention window (59 minutes old) is not refused for age alone", async () => {
          const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
          const { orgId } = await seedOwner(t);

          await expect(savePending(t, orgId, Date.now() - 59 * 60 * 1000)).resolves.toBeNull();
        });
      });
    });

    describe("promoting pending credentials needs a stored Facebook user id", () => {
      async function select(fields: Partial<WithoutSystemFields<Doc<"orgSettings">>>) {
        const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
        const { orgId, asOwner } = await seedOwner(t);
        await upsertOrgSettings(t, orgId, {
          facebookPendingAttemptId: "attempt-1",
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
        ["a stored user id that is missing", {}],
        ["a stored user id that is empty", { facebookConnectedByUserId: "" }],
        ["a pending row with no attempt id", { facebookConnectedByUserId: "fb_user_1", facebookPendingAttemptId: undefined }],
      ])("(action) %s is refused before subscribed_apps, and nothing is promoted", async (_label, fields) => {
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
        await upsertOrgSettings(t, holder, { facebookPageId: "page_1", facebookPageAccessToken: "synthetic-holder-token" });

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
      t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc", attemptStartedAt: Date.now() })
    ).rejects.toThrow(/doesn't manage any Pages/i);
  });

  test("a provider error from /me/accounts is never reflected into the thrown error", async () => {
    const { orgId, t } = await run(() =>
      graphJson({ error: { message: `${SYNTHETIC_PROVIDER_TEXT} ${SYNTHETIC_PAGE_TOKEN}` } }, 400)
    );
    const text = await failureText(t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc", attemptStartedAt: Date.now() }));
    expect(text).toMatch(/could not be retrieved/i);
    expect(text).not.toContain(SYNTHETIC_PROVIDER_TEXT);
    expect(text).not.toContain(SYNTHETIC_PAGE_TOKEN);
  });

  test("a provider error from the token exchange is never reflected into the thrown error", async () => {
    const { orgId, t } = await run(() => graphJson({ data: [] }), {
      shortToken: () => graphJson({ error: { message: `${SYNTHETIC_PROVIDER_TEXT} ${SYNTHETIC_PAGE_TOKEN}` } }, 400),
    });
    const text = await failureText(t.action(internal.facebookIntegrations.exchangeCodeForToken, { orgId, code: "abc", attemptStartedAt: Date.now() }));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"), { storedOrgCurrency: false });
    const { orgId, asOwner } = await seedOwner(t);
    await t.run((ctx) =>
      ctx.db.insert("orgSettings", {
        orgId,
        currency: "JOD",
        currencySymbol: "JD",
        enabledPaymentTypes: [],
        facebookConnectedByUserId: "fb_user_1",
        facebookPendingAttemptId: "attempt-1",
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
