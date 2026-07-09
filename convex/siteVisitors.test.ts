import { convexTest } from "convex-test";
import { expect, test, describe, vi, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

const ORIGINAL_ALLOWLIST = process.env.SUPER_ADMIN_EMAILS;

beforeEach(() => {
  process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
  process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
});

afterEach(() => {
  process.env.SUPER_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
  vi.restoreAllMocks();
});

vi.mock("./utils/geoProvider", () => ({
  lookupGeoForIp: vi.fn().mockResolvedValue({ country: "Jordan", region: "Amman", city: "Amman" }),
}));

function baseEventArgs(overrides: Record<string, unknown> = {}) {
  return {
    orgId: undefined,
    host: "autoflowdealer.com",
    visitorId: "visitor-1",
    sessionId: "session-1",
    type: "page_view" as const,
    path: "/",
    ...overrides,
  };
}

async function seedOrg(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ctx.db.insert("organizations", { name: "Acme Motors", createdAt: Date.now() }));
}

describe("siteVisitors.recordEvent", () => {
  test("creates a new visitor profile and event on first contact", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));

    const result = await t.mutation(internal.siteVisitors.recordEvent, baseEventArgs());
    expect(result.isNewVisitor).toBe(true);

    const visitor = await t.run(async (ctx) => ctx.db.get(result.siteVisitorId));
    expect(visitor?.visitCount).toBe(1);
    expect(visitor?.pageViewCount).toBe(1);
    expect(visitor?.linkClickCount).toBe(0);
    expect(visitor?.geoLookupStatus).toBe("pending");

    const events = await t.run(async (ctx) => ctx.db.query("siteVisitorEvents").collect());
    expect(events).toHaveLength(1);
    expect(events[0].trafficSource).toBe("Direct");
  });

  test("a second event in the same session updates the profile without incrementing visitCount", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));

    const first = await t.mutation(internal.siteVisitors.recordEvent, baseEventArgs());
    const second = await t.mutation(
      internal.siteVisitors.recordEvent,
      baseEventArgs({ type: "link_click", path: "/inventory", linkTarget: "/inventory" })
    );

    expect(second.isNewVisitor).toBe(false);
    expect(second.siteVisitorId).toBe(first.siteVisitorId);

    const visitor = await t.run(async (ctx) => ctx.db.get(first.siteVisitorId));
    expect(visitor?.visitCount).toBe(1);
    expect(visitor?.pageViewCount).toBe(1);
    expect(visitor?.linkClickCount).toBe(1);

    const events = await t.run(async (ctx) => ctx.db.query("siteVisitorEvents").collect());
    expect(events).toHaveLength(2);
  });

  test("a new session for a known visitor increments visitCount", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));

    const first = await t.mutation(internal.siteVisitors.recordEvent, baseEventArgs());
    await t.mutation(internal.siteVisitors.recordEvent, baseEventArgs({ sessionId: "session-2" }));

    const visitor = await t.run(async (ctx) => ctx.db.get(first.siteVisitorId));
    expect(visitor?.visitCount).toBe(2);
  });

  test("the same visitorId is tracked independently per org (and platform)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const orgId = await seedOrg(t);

    const platform = await t.mutation(internal.siteVisitors.recordEvent, baseEventArgs());
    const org = await t.mutation(internal.siteVisitors.recordEvent, baseEventArgs({ orgId, host: "bloomcars.autoflowdealer.com" }));

    expect(platform.isNewVisitor).toBe(true);
    expect(org.isNewVisitor).toBe(true);
    expect(platform.siteVisitorId).not.toBe(org.siteVisitorId);
  });

  test("fbclid on the first event wins the traffic-source classification", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const result = await t.mutation(
      internal.siteVisitors.recordEvent,
      baseEventArgs({ referrerHost: "example.com", clickIdType: "fbclid", clickIdValue: "abc" })
    );
    const events = await t.run(async (ctx) => ctx.db.query("siteVisitorEvents").collect());
    expect(events[0].trafficSource).toBe("Facebook Ads");

    const visitor = await t.run(async (ctx) => ctx.db.get(result.siteVisitorId));
    expect(visitor?.firstTrafficSource).toBe("Facebook Ads");
  });
});

describe("siteVisitors geo enrichment", () => {
  test("enrichVisitorGeo patches the visitor with the mocked lookup result", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    const { siteVisitorId } = await t.mutation(internal.siteVisitors.recordEvent, baseEventArgs());

    await t.action(internal.siteVisitors.enrichVisitorGeo, { siteVisitorId, ip: "8.8.8.8" });

    const visitor = await t.run(async (ctx) => ctx.db.get(siteVisitorId));
    expect(visitor?.geoLookupStatus).toBe("done");
    expect(visitor?.country).toBe("Jordan");
    expect(visitor?.city).toBe("Amman");
  });
});

describe("siteVisitors.purgeEventsOlderThan", () => {
  test("rejects a non-superadmin caller", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    await t.run(async (ctx) => ctx.db.insert("users", { clerkId: "not_admin", email: "someone@example.com" }));
    const asUser = t.withIdentity({ subject: "not_admin" });

    await expect(asUser.mutation(api.siteVisitors.purgeEventsOlderThan, { olderThanDays: 90 })).rejects.toThrow();
  });

  test("deletes events older than the cutoff and leaves recent events intact", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    await t.run(async (ctx) => ctx.db.insert("users", { clerkId: "dev_admin", email: "admin@autoflow.dev" }));
    const asAdmin = t.withIdentity({ subject: "dev_admin" });

    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("siteVisitorEvents", {
        host: "autoflowdealer.com",
        visitorId: "old-visitor",
        sessionId: "s1",
        type: "page_view",
        path: "/",
        trafficSource: "Direct",
        createdAt: now - 200 * 24 * 60 * 60 * 1000,
      });
      await ctx.db.insert("siteVisitorEvents", {
        host: "autoflowdealer.com",
        visitorId: "recent-visitor",
        sessionId: "s2",
        type: "page_view",
        path: "/",
        trafficSource: "Direct",
        createdAt: now,
      });
    });

    await asAdmin.mutation(api.siteVisitors.purgeEventsOlderThan, { olderThanDays: 90 });

    const remaining = await t.run(async (ctx) => ctx.db.query("siteVisitorEvents").collect());
    expect(remaining).toHaveLength(1);
    expect(remaining[0].visitorId).toBe("recent-visitor");

    const auditRows = await t.run(async (ctx) => ctx.db.query("adminAuditLog").collect());
    expect(auditRows.some((row) => row.action === "site-analytics-purge")).toBe(true);
  });
});
