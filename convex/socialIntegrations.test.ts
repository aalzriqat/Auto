import { convexTest } from "convex-test";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

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

async function seedOwner(t: ReturnType<typeof convexTest>) {
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
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    await t.run((ctx) =>
      ctx.runMutation(internal.socialIntegrations.saveInstagramCredentials, {
        orgId,
        instagramBusinessAccountId: "ig_123",
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
});

describe("socialIntegrations.setAutoPostEnabled", () => {
  test("rejects enabling auto-post when Instagram isn't connected", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    await expect(
      asOwner.mutation(api.socialIntegrations.setAutoPostEnabled, {
        orgId,
        enabled: true,
      }),
    ).rejects.toThrow(/connect instagram/i);
  });

  test("allows enabling once connected", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { orgId, asOwner } = await seedOwner(t);

    await t.run((ctx) =>
      ctx.runMutation(internal.socialIntegrations.saveInstagramCredentials, {
        orgId,
        instagramBusinessAccountId: "ig_123",
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
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
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
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
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
          return jsonResponse({
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
