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
    FACEBOOK_APP_ID: "test_fb_app_id",
    FACEBOOK_APP_SECRET: "test_fb_app_secret",
    CONVEX_SITE_URL: "https://example.convex.site",
    NEXT_PUBLIC_APP_URL: "https://app.test",
  })),
}));

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
