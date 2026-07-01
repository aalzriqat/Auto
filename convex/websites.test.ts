import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const ORIGINAL_CLERK_ISSUER = process.env.CLERK_JWT_ISSUER_DOMAIN;
const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;
const ORIGINAL_TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY;
const ORIGINAL_DOMAIN_REGISTRAR_MODE = process.env.DOMAIN_REGISTRAR_MODE;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

const WEBSITE_PERMISSIONS = [
  "website.view",
  "website.manage",
  "website.publish",
  "website.domain.manage",
  "website.leads.manage",
  "view:settings",
];

beforeEach(() => {
  process.env.DOMAIN_REGISTRAR_MODE = "mock";
});

afterEach(() => {
  restoreEnv("DOMAIN_REGISTRAR_MODE", ORIGINAL_DOMAIN_REGISTRAR_MODE);
});

async function seedDealer() {
  const convex = convexTest(schema, import.meta.glob("./**/*.*s"));
  const orgId = await convex.run((ctx) =>
    ctx.db.insert("organizations", { name: "Premium Cars", createdAt: Date.now() })
  );
  await convex.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "enterprise",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  const ownerId = await convex.run((ctx) =>
    ctx.db.insert("users", { clerkId: "owner_clerk", email: "owner@example.com", name: "Owner" })
  );
  const ownerRoleId = await convex.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "MANAGER", permissions: WEBSITE_PERMISSIONS })
  );
  await convex.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ownerId, roleId: ownerRoleId }));
  await convex.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "د.أ",
      enabledPaymentTypes: ["CASH"],
      dealershipName: "Premium Cars",
      dealershipPhone: "+962799999999",
      dealershipAddress: "Amman",
    })
  );

  return { convex, orgId, ownerId, asOwner: convex.withIdentity({ subject: "owner_clerk" }) };
}

async function saveDealerWebsiteDraft() {
  const seededDealer = await seedDealer();
  await seededDealer.asOwner.mutation(api.websites.startSetup, { orgId: seededDealer.orgId });
  await seededDealer.asOwner.mutation(api.websites.saveDraft, {
    orgId: seededDealer.orgId,
    subdomainSlug: "premiumcars",
    sections: [
      { sectionKey: "inventory.soldVehicles", enabled: false },
      { sectionKey: "vehicle.vinChassis", enabled: false },
      { sectionKey: "vehicle.trim", enabled: true },
      { sectionKey: "vehicle.transmission", enabled: true },
      { sectionKey: "vehicle.fuelType", enabled: true },
      { sectionKey: "vehicle.exteriorColor", enabled: true },
    ],
  });
  return seededDealer;
}

async function publishDealerWebsite() {
  const seededDealer = await saveDealerWebsiteDraft();
  await seededDealer.asOwner.mutation(api.websites.publish, { orgId: seededDealer.orgId });
  return seededDealer;
}

async function seedWebsiteSalesTeam(
  convex: ReturnType<typeof convexTest>,
  orgId: any
) {
  const roleId = await convex.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["view:leads", "edit:leads"] })
  );
  const firstSalesId = await convex.run((ctx) =>
    ctx.db.insert("users", { clerkId: "website_sales_1", email: "website1@example.com", name: "Website Sales One" })
  );
  const secondSalesId = await convex.run((ctx) =>
    ctx.db.insert("users", { clerkId: "website_sales_2", email: "website2@example.com", name: "Website Sales Two" })
  );
  await convex.run((ctx) => ctx.db.insert("memberships", { orgId, userId: firstSalesId, roleId }));
  await convex.run((ctx) => ctx.db.insert("memberships", { orgId, userId: secondSalesId, roleId }));
  return { firstSalesId, secondSalesId };
}

describe("dealer website domain validation", () => {
  test("reserved_subdomain_is_blocked", async () => {
    const { orgId, asOwner } = await seedDealer();
    await asOwner.mutation(api.websites.startSetup, { orgId });

    const check = await asOwner.mutation(api.websites.checkSubdomain, { orgId, slug: "admin" });

    expect(check).toMatchObject({
      available: false,
      error: "This subdomain is reserved.",
    });
  });

  test("domain_search_and_mock_purchase_create_primary_domain", async () => {
    const { convex, orgId, asOwner } = await seedDealer();
    await asOwner.mutation(api.websites.startSetup, { orgId });

    const search = await asOwner.mutation(api.websites.searchDomain, {
      orgId,
      domain: "PremiumCarsJo.com",
    });
    expect(search).toMatchObject({
      available: true,
      domain: "premiumcarsjo.com",
      provider: "mock",
    });

    const domainId = await asOwner.mutation(api.websites.purchaseDomain, {
      orgId,
      domain: "premiumcarsjo.com",
    });

    await convex.run(async (ctx) => {
      const domain = await ctx.db.get(domainId);
      expect(domain).toMatchObject({
        domain: "premiumcarsjo.com",
        type: "purchased_custom_domain",
        status: "active",
        isPrimary: true,
        registrarProvider: "mock",
      });
    });
  });

  test("custom_domain_purchase_fails_closed_when_registrar_is_disabled", async () => {
    process.env.DOMAIN_REGISTRAR_MODE = "disabled";
    const { orgId, asOwner } = await seedDealer();
    await asOwner.mutation(api.websites.startSetup, { orgId });

    const search = await asOwner.mutation(api.websites.searchDomain, {
      orgId,
      domain: "PremiumCarsJo.com",
    });
    expect(search).toMatchObject({
      available: false,
      provider: "disabled",
    });

    await expect(
      asOwner.mutation(api.websites.purchaseDomain, {
        orgId,
        domain: "premiumcarsjo.com",
      })
    ).rejects.toThrow(/not available|unavailable/i);
  });
});

describe("dealer website publishing", () => {
  test("settings_save_persists_section_toggles", async () => {
    const { convex, orgId, asOwner } = await seedDealer();
    await asOwner.mutation(api.websites.startSetup, { orgId });
    await asOwner.mutation(api.websites.saveDraft, {
      orgId,
      subdomainSlug: "premiumcars",
      heroTitle: "Premium inventory",
      sections: [{ sectionKey: "finance.calculator", enabled: true }],
    });

    await convex.run(async (ctx) => {
      const settings = await ctx.db.query("websiteSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique();
      expect(settings?.heroTitle).toBe("Premium inventory");
      const financeSection = await ctx.db
        .query("websitePublishedSections")
        .withIndex("by_org_settings_section", (q) =>
          q.eq("orgId", orgId).eq("websiteSettingsId", settings!._id).eq("sectionKey", "finance.calculator")
        )
        .unique();
      expect(financeSection?.enabled).toBe(true);
    });
  });

  test("resolve_domain_returns_public_projection_without_private_vehicle_fields", async () => {
    const { convex, orgId, asOwner } = await saveDealerWebsiteDraft();
    await convex.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "PRIVATEVIN123",
        make: "Toyota",
        model: "Land Cruiser",
        year: 2024,
        trim: "GXR",
        mileage: 1200,
        color: "Black",
        fuelType: "Gasoline",
        transmission: "Automatic",
        purchasePrice: 30000,
        landedCostTotal: 33000,
        minimumProfit: 4000,
        sellingPrice: 45000,
        status: "AVAILABLE",
        notes: "Internal margin note",
      })
    );
    await asOwner.mutation(api.websites.publish, { orgId });

    const site = await convex.query(api.websites.resolveDomain, {
      host: "premiumcars.autoflowdealer.com",
    });

    expect(site?.profile.dealershipName).toBe("Premium Cars");
    expect(site?.vehicles).toHaveLength(1);
    expect(site?.vehicles[0]).toMatchObject({
      make: "Toyota",
      model: "Land Cruiser",
      vin: null,
    });
    expect(site?.vehicles[0]).not.toHaveProperty("purchasePrice");
    expect(site?.vehicles[0]).not.toHaveProperty("landedCostTotal");
    expect(site?.vehicles[0]).not.toHaveProperty("minimumProfit");
    expect(site?.vehicles[0]).not.toHaveProperty("notes");
  });

  test("resolve_domain_serves_the_published_snapshot_until_republished", async () => {
    const { convex, orgId, asOwner } = await saveDealerWebsiteDraft();
    const vehicleId = await convex.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "SNAPSHOTVIN123",
        make: "Toyota",
        model: "Prado",
        year: 2023,
        mileage: 2500,
        color: "Silver",
        fuelType: "Gasoline",
        transmission: "Automatic",
        sellingPrice: 35_000,
        status: "AVAILABLE",
      })
    );
    const firstPublish = await asOwner.mutation(api.websites.publish, { orgId });

    await convex.run((ctx) => ctx.db.patch(vehicleId, { sellingPrice: 38_000 }));

    const firstResolve = await convex.query(api.websites.resolveDomain, {
      host: "premiumcars.autoflowdealer.com",
    });
    expect(firstResolve?.publishedSnapshot.version).toBe(firstPublish.version);
    expect(firstResolve?.vehicles[0].price).toBe(35_000);

    const secondPublish = await asOwner.mutation(api.websites.publish, { orgId });
    const secondResolve = await convex.query(api.websites.resolveDomain, {
      host: "premiumcars.autoflowdealer.com",
    });

    expect(secondResolve?.publishedSnapshot.version).toBe(secondPublish.version);
    expect(secondResolve?.vehicles[0].price).toBe(38_000);
  });

  test("publish_requires_publish_permission", async () => {
    const { convex, orgId, asOwner } = await seedDealer();
    await asOwner.mutation(api.websites.startSetup, { orgId });
    await asOwner.mutation(api.websites.saveDraft, { orgId, subdomainSlug: "premiumcars" });

    const viewerId = await convex.run((ctx) =>
      ctx.db.insert("users", { clerkId: "viewer_clerk", email: "viewer@example.com", name: "Viewer" })
    );
    const viewerRoleId = await convex.run((ctx) =>
      ctx.db.insert("roles", { orgId, name: "VIEWER", permissions: ["website.view", "website.manage"] })
    );
    await convex.run((ctx) => ctx.db.insert("memberships", { orgId, userId: viewerId, roleId: viewerRoleId }));

    await expect(
      convex.withIdentity({ subject: "viewer_clerk" }).mutation(api.websites.publish, { orgId })
    ).rejects.toThrow(/website.publish/);
  });
});

describe("dealer website leads", () => {
  beforeEach(() => {
    process.env.CLERK_JWT_ISSUER_DOMAIN = "https://test.clerk.accounts.dev";
    process.env.NEXT_PUBLIC_APP_URL = "https://test.example.com";
    process.env.TURNSTILE_SECRET_KEY = "test_turnstile_secret_123456";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ success: true, action: "turnstile-spin-v1" }), {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    restoreEnv("CLERK_JWT_ISSUER_DOMAIN", ORIGINAL_CLERK_ISSUER);
    restoreEnv("NEXT_PUBLIC_APP_URL", ORIGINAL_APP_URL);
    restoreEnv("TURNSTILE_SECRET_KEY", ORIGINAL_TURNSTILE_SECRET);
    vi.unstubAllGlobals();
  });

  test("contact_form_creates_customer_and_lead", async () => {
    const { convex, orgId } = await publishDealerWebsite();

    await convex.action(api.websites.submitPublicLead, {
      host: "premiumcars.autoflowdealer.com",
      formType: "contact",
      firstName: "Lina",
      lastName: "Saleh",
      email: "lina@example.com",
      message: "Interested in inventory",
      turnstileToken: "valid-token",
      clientFingerprint: "visitor-1",
    });

    await convex.run(async (ctx) => {
      const customers = await ctx.db.query("customers").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      const leads = await ctx.db.query("leads").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();

      expect(customers).toHaveLength(1);
      expect(customers[0]).toMatchObject({ firstName: "Lina", email: "lina@example.com" });
      expect(leads).toHaveLength(1);
      expect(leads[0]).toMatchObject({ source: "Dealer website: contact", stage: "NEW" });
    });
  });

  test("contact_form_auto_assigns_generated_leads_and_notifies_sales", async () => {
    const { convex, orgId } = await publishDealerWebsite();
    const { firstSalesId, secondSalesId } = await seedWebsiteSalesTeam(convex, orgId);
    await convex.run(async (ctx) => {
      const settings = await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique();
      await ctx.db.patch(settings!._id, { generatedLeadAutoAssignmentEnabled: true });
    });

    await convex.action(api.websites.submitPublicLead, {
      host: "premiumcars.autoflowdealer.com",
      formType: "contact",
      firstName: "Rami",
      email: "rami@example.com",
      turnstileToken: "valid-token",
      clientFingerprint: "visitor-1",
    });
    await convex.action(api.websites.submitPublicLead, {
      host: "premiumcars.autoflowdealer.com",
      formType: "contact",
      firstName: "Dana",
      email: "dana@example.com",
      turnstileToken: "valid-token",
      clientFingerprint: "visitor-2",
    });

    await convex.run(async (ctx) => {
      const leads = await ctx.db.query("leads").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      expect(leads.map((lead) => lead.assignedUserId)).toEqual([firstSalesId, secondSalesId]);

      const firstSalesNotifications = await ctx.db
        .query("notifications")
        .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", firstSalesId))
        .collect();
      expect(firstSalesNotifications.some((notification) => notification.type === "lead.assigned")).toBe(true);
    });
  });

  test("duplicate public contact submission reuses the existing open lead", async () => {
    const { convex, orgId } = await publishDealerWebsite();

    const first = await convex.action(api.websites.submitPublicLead, {
      host: "premiumcars.autoflowdealer.com",
      formType: "contact",
      firstName: "Lina",
      email: "lina@example.com",
      message: "First request",
      turnstileToken: "valid-token",
      clientFingerprint: "visitor-1",
    });
    const second = await convex.action(api.websites.submitPublicLead, {
      host: "premiumcars.autoflowdealer.com",
      formType: "contact",
      firstName: "Lina",
      email: "lina@example.com",
      message: "Duplicate request",
      turnstileToken: "valid-token",
      clientFingerprint: "visitor-1",
    });

    expect(second).toMatchObject({ success: true, leadId: first.leadId, duplicate: true });
    await convex.run(async (ctx) => {
      const customers = await ctx.db.query("customers").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      const leads = await ctx.db.query("leads").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      const abuseEvents = await ctx.db
        .query("websiteLeadAbuseEvents")
        .withIndex("by_org_createdAt", (q) => q.eq("orgId", orgId))
        .collect();

      expect(customers).toHaveLength(1);
      expect(leads).toHaveLength(1);
      expect(abuseEvents.some((event) => event.reason === "duplicate_suppressed")).toBe(true);
    });
  });

  test("public lead submission rejects invalid email before creating CRM rows", async () => {
    const { convex, orgId } = await publishDealerWebsite();

    await expect(
      convex.action(api.websites.submitPublicLead, {
        host: "premiumcars.autoflowdealer.com",
        formType: "contact",
        firstName: "Bad Email",
        email: "not-an-email",
        turnstileToken: "valid-token",
        clientFingerprint: "visitor-1",
      }),
    ).rejects.toThrow(/Email is invalid/);

    await convex.run(async (ctx) => {
      const customers = await ctx.db.query("customers").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      const leads = await ctx.db.query("leads").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect();
      expect(customers).toHaveLength(0);
      expect(leads).toHaveLength(0);
    });
  });
});
