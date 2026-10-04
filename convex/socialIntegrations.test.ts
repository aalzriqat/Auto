import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

vi.mock("./utils/env", () => ({
  getValidatedEnv: vi.fn(() => ({
    INSTAGRAM_APP_ID: "test_app_id",
    INSTAGRAM_APP_SECRET: "test_app_secret",
    CONVEX_SITE_URL: "https://example.convex.site",
    NEXT_PUBLIC_APP_URL: "https://app.test",
  })),
}));

async function seedOwner(t: ReturnType<typeof convexTestWithComponents>) {
  const orgId = await t.run(async (ctx) =>
    ctx.db.insert("organizations", { name: "Test Org", createdAt: Date.now() }),
  );
  await t.run(async (ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", {
      clerkId: "owner_001",
      email: "owner@test.com",
      name: "Owner",
    }),
  );
  const roleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ["view:settings", "edit:settings"],
      isSystemOwnerRole: true,
    }),
  );
  await t.run(async (ctx) =>
    ctx.db.insert("memberships", { orgId, userId, roleId }),
  );
  return { orgId, userId, asOwner: t.withIdentity({ subject: "owner_001" }) };
}

function rawTextResponse(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Bad Request",
    text: async () => body,
  } as Response;
}

function jsonTextResponse(body: unknown, ok = true, status = 200): Response {
  return rawTextResponse(JSON.stringify(body), ok, status);
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Bad Request",
    json: async () => body,
  } as Response;
}

describe("socialIntegrations.createConnectUrl", () => {
  test("returns a Meta OAuth dialog URL with a state param, owner-only", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    const url = await asOwner.mutation(
      api.socialIntegrations.createConnectUrl,
      { orgId },
    );

    expect(url).toContain("instagram.com");
    expect(url).toContain("client_id=test_app_id");
    expect(url).toContain("redirect_uri=");
    expect(url).toContain("state=");

    await t.run(async (ctx) => {
      const states = await ctx.db.query("oauthStates").collect();
      expect(states.length).toBe(1);
      expect(states[0].orgId).toBe(orgId);
      expect(states[0].provider).toBe("instagram");
    });
  });

  test("rejects non-owners", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOwner(t);

    const userId2 = await t.run((ctx) =>
      ctx.db.insert("users", {
        clerkId: "member_002",
        email: "m@test.com",
        name: "Member",
      }),
    );
    const roleId2 = await t.run((ctx) =>
      ctx.db.insert("roles", {
        orgId,
        name: "SALES",
        permissions: ["view:settings"],
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("memberships", { orgId, userId: userId2, roleId: roleId2 }),
    );
    const asMember = t.withIdentity({ subject: "member_002" });

    await expect(
      asMember.mutation(api.socialIntegrations.createConnectUrl, { orgId }),
    ).rejects.toThrow();
  });
});

describe("socialIntegrations.getConnectionStatus / disconnect", () => {
  test("reports not connected by default, then connected after credentials are saved", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    const before = await asOwner.query(
      api.socialIntegrations.getConnectionStatus,
      { orgId },
    );
    expect(before.instagramConnected).toBe(false);

    await t.run((ctx) =>
      ctx.runMutation(internal.socialIntegrations.saveInstagramCredentials, {
        orgId,
        instagramBusinessAccountId: "ig_123",
        instagramWebhookAccountId: "ig_hook_123",
        instagramAccessToken: "token_abc",
        instagramPageName: "My Dealership",
      }),
    );

    const after = await asOwner.query(
      api.socialIntegrations.getConnectionStatus,
      { orgId },
    );
    expect(after.instagramConnected).toBe(true);
    expect(after.instagramPageName).toBe("My Dealership");
  });

  test("disconnect clears stored credentials", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    await t.run((ctx) =>
      ctx.runMutation(internal.socialIntegrations.saveInstagramCredentials, {
        orgId,
        instagramBusinessAccountId: "ig_123",
        instagramWebhookAccountId: "ig_hook_123",
        instagramAccessToken: "token_abc",
      }),
    );

    await asOwner.mutation(api.socialIntegrations.disconnect, { orgId });

    const status = await asOwner.query(
      api.socialIntegrations.getConnectionStatus,
      { orgId },
    );
    expect(status.instagramConnected).toBe(false);
  });

  // SCRUM-623: webhooks are routed only by the webhook account id, so a
  // connection without one can never receive a DM or comment.
  test("refuses to save credentials without a webhook account id", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedOwner(t);
    const save = (instagramWebhookAccountId: string | undefined) =>
      t.run((ctx) =>
        ctx.runMutation(internal.socialIntegrations.saveInstagramCredentials, {
          orgId,
          instagramBusinessAccountId: "ig_123",
          instagramAccessToken: "token_abc",
          ...(instagramWebhookAccountId === undefined ? {} : { instagramWebhookAccountId }),
        } as never),
      );

    await expect(save(undefined)).rejects.toThrow();
    await expect(save("   ")).rejects.toThrow();
    const row = await t.run((ctx) =>
      ctx.db
        .query("orgSettings")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .unique(),
    );
    expect(row?.instagramAccessToken).toBeUndefined();
  });

  test("a stored token and business id without a webhook account id is not reported connected", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);
    await t.run(async (ctx) => {
      const existing = await ctx.db
        .query("orgSettings")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .unique();
      const legacy = { instagramBusinessAccountId: "ig_123", instagramAccessToken: "token_abc" };
      if (existing) {
        await ctx.db.patch(existing._id, legacy);
      } else {
        await ctx.db.insert("orgSettings", {
          orgId,
          currency: "JOD",
          currencySymbol: "JD",
          enabledPaymentTypes: [],
          ...legacy,
        });
      }
    });

    const status = await asOwner.query(api.socialIntegrations.getConnectionStatus, { orgId });
    expect(status.instagramConnected).toBe(false);
  });
});

// SCRUM-623-04: the refresh reads the token, waits on Meta, then writes. A
// Disconnect or reconnect landing in that wait must not be undone by the write.
describe("socialIntegrations.refreshInstagramToken", () => {
  async function seedConnected(t: ReturnType<typeof convexTestWithComponents>) {
    const owner = await seedOwner(t);
    await t.run((ctx) =>
      ctx.runMutation(internal.socialIntegrations.saveInstagramCredentials, {
        orgId: owner.orgId,
        instagramBusinessAccountId: "ig_123",
        instagramWebhookAccountId: "ig_hook_123",
        instagramAccessToken: "token_old",
      }),
    );
    return owner;
  }

  function stubRefresh(during: () => Promise<unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await during();
        return jsonResponse({ access_token: "token_refreshed", expires_in: 5184000 });
      }),
    );
  }

  const makeT = () => convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const readRow = (t: ReturnType<typeof makeT>, orgId: Id<"organizations">) =>
    t.run((ctx) =>
      ctx.db
        .query("orgSettings")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .unique(),
    );

  test("refreshes the token of the connection it read", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId } = await seedConnected(t);
    stubRefresh(async () => {});

    await t.action(internal.socialIntegrations.refreshInstagramToken, { orgId });

    const row = await readRow(t, orgId);
    expect(row?.instagramAccessToken).toBe("token_refreshed");
    expect(row?.instagramTokenExpiresAt).toBeGreaterThan(Date.now());
    vi.unstubAllGlobals();
  });

  test("a refresh finishing after Disconnect does not restore the token", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedConnected(t);
    stubRefresh(() => asOwner.mutation(api.socialIntegrations.disconnect, { orgId }));

    await t.action(internal.socialIntegrations.refreshInstagramToken, { orgId });

    const row = await readRow(t, orgId);
    expect(row?.instagramAccessToken).toBeUndefined();
    expect(row?.instagramTokenExpiresAt).toBeUndefined();
    const status = await asOwner.query(api.socialIntegrations.getConnectionStatus, { orgId });
    expect(status.instagramConnected).toBe(false);
    vi.unstubAllGlobals();
  });

  test("a refresh finishing after a reconnect does not overwrite the new connection's token", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedConnected(t);
    stubRefresh(async () => {
      await asOwner.mutation(api.socialIntegrations.disconnect, { orgId });
      await t.run((ctx) =>
        ctx.runMutation(internal.socialIntegrations.saveInstagramCredentials, {
          orgId,
          instagramBusinessAccountId: "ig_456",
          instagramWebhookAccountId: "ig_hook_456",
          instagramAccessToken: "token_new_connection",
        }),
      );
    });

    await t.action(internal.socialIntegrations.refreshInstagramToken, { orgId });

    const row = await readRow(t, orgId);
    expect(row?.instagramAccessToken).toBe("token_new_connection");
    expect(row?.instagramBusinessAccountId).toBe("ig_456");
    vi.unstubAllGlobals();
  });

  test.each(["instagramWebhookAccountId", "instagramBusinessAccountId"] as const)(
    "does not keep a legacy connection without %s alive",
    async (missing) => {
      const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
      const { orgId } = await seedConnected(t);
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("orgSettings")
          .withIndex("by_org", (q) => q.eq("orgId", orgId))
          .unique();
        await ctx.db.patch(row!._id, { [missing]: undefined });
      });
      stubRefresh(async () => {});

      await t.action(internal.socialIntegrations.refreshInstagramToken, { orgId });

      expect((await readRow(t, orgId))?.instagramAccessToken).toBe("token_old");
      vi.unstubAllGlobals();
    },
  );
});

describe("socialIntegrations.setAutoPostEnabled", () => {
  test("rejects enabling auto-post when Instagram isn't connected", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    await expect(
      asOwner.mutation(api.socialIntegrations.setAutoPostEnabled, {
        orgId,
        enabled: true,
      }),
    ).rejects.toThrow(/connect instagram/i);
  });

  test("allows enabling once connected", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    await t.run((ctx) =>
      ctx.runMutation(internal.socialIntegrations.saveInstagramCredentials, {
        orgId,
        instagramBusinessAccountId: "ig_123",
        instagramWebhookAccountId: "ig_hook_123",
        instagramAccessToken: "token_abc",
      }),
    );

    await asOwner.mutation(api.socialIntegrations.setAutoPostEnabled, {
      orgId,
      enabled: true,
    });

    const status = await asOwner.query(
      api.socialIntegrations.getConnectionStatus,
      { orgId },
    );
    expect(status.socialAutoPostEnabled).toBe(true);
  });

  test("allows enabling when only Facebook is connected (shared flag, not Instagram-specific)", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    await t.run((ctx) =>
      ctx.runMutation(internal.facebookIntegrations.saveFacebookCredentials, {
        orgId,
        facebookPageId: "page_123",
        facebookPageAccessToken: "page_token_abc",
      }),
    );

    await asOwner.mutation(api.socialIntegrations.setAutoPostEnabled, {
      orgId,
      enabled: true,
    });

    const status = await asOwner.query(
      api.socialIntegrations.getConnectionStatus,
      { orgId },
    );
    expect(status.socialAutoPostEnabled).toBe(true);
  });
});

describe("socialIntegrations.setInstagramLeadCreationConfig", () => {
  test("requires a connection before configuring, then persists the toggles", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    await expect(
      asOwner.mutation(api.socialIntegrations.setInstagramLeadCreationConfig, {
        orgId,
        leadFromCommentsEnabled: false,
        leadFromDmsEnabled: true,
        leadFromDmsRequiresMobile: true,
      }),
    ).rejects.toThrow(/connect instagram/i);

    await t.run((ctx) =>
      ctx.runMutation(internal.socialIntegrations.saveInstagramCredentials, {
        orgId,
        instagramBusinessAccountId: "ig_123",
        instagramWebhookAccountId: "ig_hook_123",
        instagramAccessToken: "token_abc",
      }),
    );

    await asOwner.mutation(
      api.socialIntegrations.setInstagramLeadCreationConfig,
      {
        orgId,
        leadFromCommentsEnabled: false,
        leadFromDmsEnabled: true,
        leadFromDmsRequiresMobile: true,
      },
    );

    const status = await asOwner.query(
      api.socialIntegrations.getConnectionStatus,
      { orgId },
    );
    expect(status.instagramLeadFromCommentsEnabled).toBe(false);
    expect(status.instagramLeadFromDmsEnabled).toBe(true);
    expect(status.instagramLeadFromDmsRequiresMobile).toBe(true);
  });
});

describe("socialIntegrations.consumeOAuthState", () => {
  test("returns the orgId for a valid state and consumes it (one-time use)", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    await asOwner.mutation(api.socialIntegrations.createConnectUrl, { orgId });
    const state = await t.run(async (ctx) => {
      const row = await ctx.db.query("oauthStates").first();
      return row!.state;
    });

    const result = await t.run((ctx) =>
      ctx.runMutation(internal.socialIntegrations.consumeOAuthState, { state }),
    );
    expect(result?.orgId).toBe(orgId);

    const replay = await t.run((ctx) =>
      ctx.runMutation(internal.socialIntegrations.consumeOAuthState, { state }),
    );
    expect(replay).toBeNull();
  });

  test("returns null for an unknown state", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const result = await t.run((ctx) =>
      ctx.runMutation(internal.socialIntegrations.consumeOAuthState, {
        state: "does-not-exist",
      }),
    );
    expect(result).toBeNull();
  });
});

describe("socialIntegrations.exchangeCodeForToken", () => {
  test("retries long-lived token exchange with POST when Meta rejects GET", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const orgId = await t.run((ctx) =>
      ctx.db.insert("organizations", {
        name: "Instagram Org",
        createdAt: Date.now(),
      }),
    );
    const instagramUserId = "17841409999999999";

    const fetchMock = vi.fn(
      async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = input.toString();
        const method = init?.method ?? "GET";

        if (url === "https://api.instagram.com/oauth/access_token") {
          expect(method).toBe("POST");
          return rawTextResponse(
            `{"access_token":"short_token","user_id":${instagramUserId}}`,
          );
        }

        if (
          url.startsWith("https://graph.instagram.com/access_token") &&
          method === "GET"
        ) {
          return jsonTextResponse(
            { error: { message: "Unsupported request - method type: get" } },
            false,
            400,
          );
        }

        if (
          url === "https://graph.instagram.com/access_token" &&
          method === "POST"
        ) {
          expect(init?.body?.toString()).toContain(
            "grant_type=ig_exchange_token",
          );
          return jsonTextResponse({
            access_token: "long_token",
            expires_in: 5184000,
          });
        }

        if (url.includes(`/v21.0/${instagramUserId}`) && method === "GET") {
          return jsonTextResponse({
            username: "dealer_ig",
            user_id: "webhook_123",
          });
        }

        if (
          url.includes(`/${instagramUserId}/subscribed_apps`) &&
          method === "POST"
        ) {
          return jsonResponse({ success: true });
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      },
    );

    vi.stubGlobal("fetch", fetchMock);

    await t.action(internal.socialIntegrations.exchangeCodeForToken, {
      orgId,
      code: "auth_code",
    });

    const settings = await t.run((ctx) =>
      ctx.db
        .query("orgSettings")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .unique(),
    );
    expect(settings?.instagramBusinessAccountId).toBe(instagramUserId);
    expect(settings?.instagramWebhookAccountId).toBe("webhook_123");
    expect(settings?.instagramAccessToken).toBe("long_token");
    expect(settings?.instagramPageName).toBe("dealer_ig");
    expect(settings?.instagramTokenExpiresAt).toBeGreaterThan(Date.now());

    const longLivedCalls = fetchMock.mock.calls.filter(([input]) =>
      input.toString().startsWith("https://graph.instagram.com/access_token"),
    );
    expect(longLivedCalls.map(([, init]) => init?.method ?? "GET")).toEqual([
      "GET",
      "POST",
    ]);

    vi.unstubAllGlobals();
  });
});

// SCRUM-622: the webhook resolves an org by the account's webhook id, and the
// deauthorize callback by its business id — each may belong to one org only.
describe("socialIntegrations: an Instagram account belongs to one org", () => {
  type T = ReturnType<typeof convexTestWithComponents>;
  const newOrg = (t: T) =>
    t.run((ctx) => ctx.db.insert("organizations", { name: "Org", createdAt: Date.now() }));
  const save = (
    t: T,
    orgId: Id<"organizations">,
    instagramBusinessAccountId: string,
    instagramWebhookAccountId: string,
  ) =>
    t.run((ctx) =>
      ctx.runMutation(internal.socialIntegrations.saveInstagramCredentials, {
        orgId,
        instagramBusinessAccountId,
        instagramWebhookAccountId,
        instagramAccessToken: "token",
      }),
    );

  test("refuses a business account already connected to another org", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const orgA = await newOrg(t);
    const orgB = await newOrg(t);
    await save(t, orgA, "ig_biz", "ig_hook");
    await expect(save(t, orgB, "ig_biz", "ig_hook_other")).rejects.toThrow(/already connected to another/i);
  });

  test("refuses a webhook account id already connected to another org", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const orgA = await newOrg(t);
    const orgB = await newOrg(t);
    await save(t, orgA, "ig_biz_a", "ig_hook");
    await expect(save(t, orgB, "ig_biz_b", "ig_hook")).rejects.toThrow(/already connected to another/i);
    const holders = await t.run((ctx) =>
      ctx.db
        .query("orgSettings")
        .withIndex("by_instagram_webhook_account_id", (q) => q.eq("instagramWebhookAccountId", "ig_hook"))
        .collect(),
    );
    expect(holders.map((s) => s.orgId)).toEqual([orgA]);
  });

  test("the same org may reconnect its own account", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const orgA = await newOrg(t);
    await save(t, orgA, "ig_biz", "ig_hook");
    await expect(save(t, orgA, "ig_biz", "ig_hook")).resolves.toBeNull();
  });

  test("once the first org's account is deauthorized, another org may connect it", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const orgA = await newOrg(t);
    const orgB = await newOrg(t);
    await save(t, orgA, "ig_biz", "ig_hook");
    await t.run((ctx) =>
      ctx.runMutation(internal.socialIntegrations.disconnectByInstagramUserId, { instagramBusinessAccountId: "ig_biz" }),
    );
    await expect(save(t, orgB, "ig_biz", "ig_hook")).resolves.toBeNull();
  });

  test("a downgraded org can still disconnect, releasing the account for another org", async () => {
    // The refusal above tells the second org to disconnect in the first one.
    // That has to be possible even after the holder dropped below the plan
    // that includes the Social Inbox, or the account is locked for good.
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const { orgId: orgA, asOwner } = await seedOwner(t);
    const orgB = await newOrg(t);
    await save(t, orgA, "ig_biz", "ig_hook");
    await t.run(async (ctx) => {
      const sub = await ctx.db
        .query("subscriptions")
        .withIndex("by_org", (q) => q.eq("orgId", orgA))
        .unique();
      await ctx.db.patch(sub!._id, { plan: "starter" });
    });

    await asOwner.mutation(api.socialIntegrations.disconnect, { orgId: orgA });
    await expect(save(t, orgB, "ig_biz", "ig_hook")).resolves.toBeNull();
  });

  test("the OAuth callback tells the dealer the account is in use, not 'try again later'", async () => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        if (url.includes("api.instagram.com/oauth/access_token")) return json({ access_token: "short", user_id: "ig_biz" });
        if (url.includes("graph.instagram.com/access_token")) return json({ access_token: "long", expires_in: 5184000 });
        if (url.includes("subscribed_apps")) return json({ success: true });
        return json({ username: "dealer", user_id: "ig_hook" });
      }),
    );
    try {
      const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
      const orgA = await newOrg(t);
      const orgB = await newOrg(t);
      await save(t, orgA, "ig_biz", "ig_hook");
      await t.run((ctx) =>
        ctx.db.insert("oauthStates", {
          orgId: orgB,
          state: "state_b",
          provider: "instagram",
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        }),
      );

      const res = await t.fetch("/instagram-oauth-callback?code=abc&state=state_b", { redirect: "manual" });

      const location = decodeURIComponent(res.headers.get("location") ?? "");
      expect(location).toContain("error=1");
      expect(location).toContain("already connected to another AutoFlow organization");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
