import { convexTest } from "convex-test";
import { expect, test, describe, beforeEach, afterEach } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";

const ORIGINAL_ALLOWLIST = process.env.SUPER_ADMIN_EMAILS;

beforeEach(() => {
  process.env.SUPER_ADMIN_EMAILS = "admin@autoflow.dev";
  process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
});

afterEach(() => {
  process.env.SUPER_ADMIN_EMAILS = ORIGINAL_ALLOWLIST;
});

async function seedRequestWithMatch(t: ReturnType<typeof convexTest>) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Dealer Org", createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("marketplaceDealerProfiles", {
      orgId,
      isOptedIn: true,
      areas: [],
      brandsCarried: [],
      whatsappNumber: "+962791111111",
      badges: [],
      totalResponses: 0,
      totalAccepted: 0,
      tier: "FREE_FOUNDING",
      leadsUsedThisPeriod: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const requestId = await t.run((ctx) =>
    ctx.db.insert("marketplaceRequests", {
      status: "MATCHED",
      buyerFirstName: "Sami",
      buyerPhone: "+962791234567",
      buyerCity: "Amman",
      paymentType: "CASH",
      buyerTimeframe: "ASAP",
      buyerIntent: "WARM",
      consentAcceptedAt: Date.now(),
      clientFingerprint: "fp-1",
      expiresAt: Date.now() + 100000,
      createdAt: Date.now(),
    })
  );
  const matchId = await t.run((ctx) =>
    ctx.db.insert("marketplaceRequestMatches", { requestId, orgId, matchedAt: Date.now() })
  );

  await t.run((ctx) => ctx.db.insert("users", { clerkId: "dev_1", email: "admin@autoflow.dev" }));
  await t.run((ctx) => ctx.db.insert("users", { clerkId: "member_1", email: "member@dealer.com" }));

  return { orgId, requestId, matchId, asAdmin: t.withIdentity({ subject: "dev_1" }), asMember: t.withIdentity({ subject: "member_1" }) };
}

describe("adminMarketplace", () => {
  test("listRequests rejects a non-super-admin caller", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { asMember } = await seedRequestWithMatch(t);
    await expect(asMember.query(api.adminMarketplace.listRequests, {})).rejects.toThrow();
  });

  test("listRequests enriches matches with dealer name and WhatsApp number", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { asAdmin } = await seedRequestWithMatch(t);

    const requests = await asAdmin.query(api.adminMarketplace.listRequests, {});
    expect(requests).toHaveLength(1);
    expect(requests[0].matches).toHaveLength(1);
    expect(requests[0].matches[0]).toMatchObject({
      dealerName: "Dealer Org",
      whatsappNumber: "+962791111111",
      notifiedAt: null,
    });
  });

  test("markMatchNotified stamps notifiedAt/notifiedVia and writes an audit log", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { asAdmin, matchId, orgId } = await seedRequestWithMatch(t);

    await asAdmin.mutation(api.adminMarketplace.markMatchNotified, { matchId });

    const match = await t.run((ctx) => ctx.db.get(matchId));
    expect(match?.notifiedVia).toBe("WHATSAPP_MANUAL");
    expect(match?.notifiedAt).toBeTypeOf("number");

    const auditRows = await t.run((ctx) => ctx.db.query("adminAuditLog").collect());
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({ action: "marketplaceMarkMatchNotified", orgId });
  });

  test("markSpam sets status to SPAM and rejects a non-super-admin caller", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { asAdmin, asMember, requestId } = await seedRequestWithMatch(t);

    await expect(asMember.mutation(api.adminMarketplace.markSpam, { requestId })).rejects.toThrow();

    await asAdmin.mutation(api.adminMarketplace.markSpam, { requestId });
    const request = await t.run((ctx) => ctx.db.get(requestId));
    expect(request?.status).toBe("SPAM");
  });

  test("listWeeklyReports only includes opted-in dealers with activity, and rejects a non-super-admin caller", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { asAdmin, asMember, orgId, requestId } = await seedRequestWithMatch(t);
    const respondingUserId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "sales_1", email: "sales@dealer.com" }));
    await t.run((ctx) =>
      ctx.db.insert("marketplaceResponses", {
        requestId,
        orgId,
        respondingUserId,
        kind: "HAVE_MATCH",
        createdAt: Date.now(),
      })
    );

    await expect(asMember.query(api.adminMarketplace.listWeeklyReports, {})).rejects.toThrow();

    const reports = await asAdmin.query(api.adminMarketplace.listWeeklyReports, {});
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      orgId,
      dealerName: "Dealer Org",
      whatsappNumber: "+962791111111",
      sentAt: null,
    });
    expect(reports[0].report.responsesSent).toBe(1);
  });

  test("markWeeklyReportSentViaWhatsApp records the send and listWeeklyReports reflects it", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { asAdmin, orgId, requestId } = await seedRequestWithMatch(t);
    const respondingUserId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "sales_1", email: "sales@dealer.com" }));
    await t.run((ctx) =>
      ctx.db.insert("marketplaceResponses", {
        requestId,
        orgId,
        respondingUserId,
        kind: "HAVE_MATCH",
        createdAt: Date.now(),
      })
    );

    await asAdmin.mutation(api.adminMarketplace.markWeeklyReportSentViaWhatsApp, { orgId });

    const sends = await t.run((ctx) => ctx.db.query("marketplaceWeeklyReportSends").collect());
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ orgId });

    const reports = await asAdmin.query(api.adminMarketplace.listWeeklyReports, {});
    expect(reports[0].sentAt).toBeTypeOf("number");

    const auditRows = await t.run((ctx) => ctx.db.query("adminAuditLog").collect());
    expect(auditRows.some((row) => row.action === "marketplaceMarkWeeklyReportSent")).toBe(true);
  });

  test("listDealerProfiles rejects a non-super-admin caller and lists opted-in dealers", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { asAdmin, asMember, orgId } = await seedRequestWithMatch(t);

    await expect(asMember.query(api.adminMarketplace.listDealerProfiles, {})).rejects.toThrow();

    const dealers = await asAdmin.query(api.adminMarketplace.listDealerProfiles, {});
    expect(dealers).toHaveLength(1);
    expect(dealers[0]).toMatchObject({ orgId, whatsappNumber: "+962791111111", phoneVerifiedAt: null });
  });

  test("verifyDealerPhone stamps phoneVerifiedAt, refreshes badges, and writes an audit log", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { asAdmin, orgId } = await seedRequestWithMatch(t);

    await asAdmin.mutation(api.adminMarketplace.verifyDealerPhone, { orgId });

    const profile = await t.run((ctx) =>
      ctx.db.query("marketplaceDealerProfiles").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()
    );
    expect(profile?.phoneVerifiedAt).toBeTypeOf("number");
    expect(profile?.badges).toContain("VERIFIED_PHONE");

    const auditRows = await t.run((ctx) => ctx.db.query("adminAuditLog").collect());
    expect(auditRows.some((row) => row.action === "marketplaceVerifyDealerPhone")).toBe(true);
  });
});

describe("updateMarketplaceTier (Phase 63)", () => {
  async function setPlan(
    t: ReturnType<typeof convexTest>,
    orgId: Id<"organizations">,
    plan: "free" | "starter" | "professional" | "enterprise"
  ) {
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", { orgId, plan, status: "active", createdAt: Date.now(), updatedAt: Date.now() })
    );
  }

  test("rejects a non-super-admin caller", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { asMember, orgId } = await seedRequestWithMatch(t);
    await expect(
      asMember.mutation(api.adminMarketplace.updateMarketplaceTier, { orgId, tier: "LEAD_PACKAGE" })
    ).rejects.toThrow();
  });

  test("rejects LEAD_PACKAGE when the org's plan doesn't include marketplaceLeadPackage (default free plan)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { asAdmin, orgId } = await seedRequestWithMatch(t);

    await expect(
      asAdmin.mutation(api.adminMarketplace.updateMarketplaceTier, { orgId, tier: "LEAD_PACKAGE", leadQuota: 20 })
    ).rejects.toThrow(/Upgrade required/);
  });

  test("allows LEAD_PACKAGE once the org is on a plan that includes it, and sets leadQuota", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { asAdmin, orgId } = await seedRequestWithMatch(t);
    await setPlan(t, orgId, "professional");

    await asAdmin.mutation(api.adminMarketplace.updateMarketplaceTier, { orgId, tier: "LEAD_PACKAGE", leadQuota: 20 });

    const profile = await t.run((ctx) =>
      ctx.db.query("marketplaceDealerProfiles").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()
    );
    expect(profile?.tier).toBe("LEAD_PACKAGE");
    expect(profile?.leadQuota).toBe(20);
    expect(profile?.leadsUsedThisPeriod).toBe(0);
  });

  test("rejects FEATURED on a plan that only includes marketplaceLeadPackage, not marketplaceFeatured", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { asAdmin, orgId } = await seedRequestWithMatch(t);
    await setPlan(t, orgId, "professional");

    await expect(
      asAdmin.mutation(api.adminMarketplace.updateMarketplaceTier, { orgId, tier: "FEATURED" })
    ).rejects.toThrow(/Upgrade required/);
  });

  test("allows FEATURED once the org is on enterprise", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { asAdmin, orgId } = await seedRequestWithMatch(t);
    await setPlan(t, orgId, "enterprise");

    await asAdmin.mutation(api.adminMarketplace.updateMarketplaceTier, { orgId, tier: "FEATURED" });

    const profile = await t.run((ctx) =>
      ctx.db.query("marketplaceDealerProfiles").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()
    );
    expect(profile?.tier).toBe("FEATURED");
  });

  test("resets leadsUsedThisPeriod when the tier actually changes, and writes an audit log", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { asAdmin, orgId } = await seedRequestWithMatch(t);
    await setPlan(t, orgId, "enterprise");
    await t.run((ctx) =>
      ctx.db
        .query("marketplaceDealerProfiles")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .unique()
        .then((profile) => ctx.db.patch(profile!._id, { tier: "LEAD_PACKAGE", leadQuota: 10, leadsUsedThisPeriod: 7 }))
    );

    await asAdmin.mutation(api.adminMarketplace.updateMarketplaceTier, { orgId, tier: "FEATURED" });

    const profile = await t.run((ctx) =>
      ctx.db.query("marketplaceDealerProfiles").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()
    );
    expect(profile?.tier).toBe("FEATURED");
    expect(profile?.leadsUsedThisPeriod).toBe(0);

    const auditRows = await t.run((ctx) => ctx.db.query("adminAuditLog").collect());
    expect(auditRows.some((row) => row.action === "marketplaceUpdateTier")).toBe(true);
  });
});
