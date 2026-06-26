import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";

const WEBSITE_PERMISSIONS = [
  "website.view",
  "website.manage",
  "website.publish",
  "website.domain.manage",
  "website.leads.manage",
  "view:settings",
];

async function seedDealer() {
  const convex = convexTest(schema, import.meta.glob("./**/*.*s"));
  const orgId = await convex.run((ctx) =>
    ctx.db.insert("organizations", { name: "Premium Cars", createdAt: Date.now() })
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

async function publishDealerWebsite() {
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
  await seededDealer.asOwner.mutation(api.websites.publish, { orgId: seededDealer.orgId });
  return seededDealer;
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
    const { convex, orgId } = await publishDealerWebsite();
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
  test("contact_form_creates_customer_and_lead", async () => {
    const { convex, orgId } = await publishDealerWebsite();

    await convex.mutation(api.websites.submitPublicLead, {
      host: "premiumcars.autoflowdealer.com",
      formType: "contact",
      firstName: "Lina",
      lastName: "Saleh",
      email: "lina@example.com",
      message: "Interested in inventory",
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
});
