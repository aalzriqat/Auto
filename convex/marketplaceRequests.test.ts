import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { computeBuyerIntent, dealerMatchesRequest } from "./marketplaceRequests";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  enforceMarketplaceSubmissionRateLimit: vi.fn().mockResolvedValue(undefined),
}));

const ORIGINAL_TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY;
const ORIGINAL_CLERK_ISSUER = process.env.CLERK_JWT_ISSUER_DOMAIN;
const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  process.env.TURNSTILE_SECRET_KEY = "test_turnstile_secret_123456";
  process.env.CLERK_JWT_ISSUER_DOMAIN = "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL = "https://test.example.com";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ success: true, action: "turnstile-spin-v1" }), {
        headers: { "Content-Type": "application/json" },
      })
    )
  );
});

afterEach(() => {
  restoreEnv("TURNSTILE_SECRET_KEY", ORIGINAL_TURNSTILE_SECRET);
  restoreEnv("CLERK_JWT_ISSUER_DOMAIN", ORIGINAL_CLERK_ISSUER);
  restoreEnv("NEXT_PUBLIC_APP_URL", ORIGINAL_APP_URL);
  vi.unstubAllGlobals();
});

const baseRequestArgs = {
  buyerFirstName: "Sami",
  buyerPhone: "+962791234567",
  buyerCity: "Amman",
  paymentType: "FINANCE" as const,
  buyerTimeframe: "THIS_WEEK" as const,
  consentAccepted: true,
  clientFingerprint: "fp-1",
  turnstileToken: "valid-token",
};

async function seedDealer(
  t: ReturnType<typeof convexTestWithComponents>,
  opts: { name: string; areas: string[]; brandsCarried: string[]; whatsappNumber?: string; suspended?: boolean; avgResponseMinutes?: number }
) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: opts.name, createdAt: Date.now(), suspended: opts.suspended })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `sales_${orgId}`, email: `sales_${orgId}@test.com`, name: "Sales" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["marketplace:respond"] })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("marketplaceDealerProfiles", {
      orgId,
      isOptedIn: true,
      areas: opts.areas,
      brandsCarried: opts.brandsCarried,
      whatsappNumber: opts.whatsappNumber,
      badges: [],
      totalResponses: 0,
      totalAccepted: 0,
      tier: "FREE_FOUNDING",
      leadsUsedThisPeriod: 0,
      avgResponseMinutes: opts.avgResponseMinutes,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  return { orgId, userId };
}

const WEBSITE_PERMS = ["website.view", "website.manage", "website.publish", "view:settings"];

/** Seeds a dealer with a real published site snapshot (enterprise plan → websiteBuilder), one AVAILABLE vehicle, and an opted-in profile — so createRequest's Tier A inventory scan has something to score. */
async function seedPublishedDealer(
  t: ReturnType<typeof convexTestWithComponents>,
  opts: {
    name: string;
    subdomainSlug: string;
    city: string;
    model?: string;
    sellingPrice?: number;
    tier?: "FREE_FOUNDING" | "LEAD_PACKAGE" | "FEATURED";
    quotaExhausted?: boolean;
  }
) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: opts.name, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "enterprise", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const ownerId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `owner_${orgId}`, email: `owner_${orgId}@test.com`, name: "Owner" }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "MANAGER", permissions: WEBSITE_PERMS }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: ownerId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "د.أ", enabledPaymentTypes: ["CASH"], dealershipName: opts.name })
  );
  await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, make: "Toyota", model: opts.model ?? "Corolla", year: 2021, mileage: 30000,
      color: "White", fuelType: "Petrol", transmission: "Automatic",
      sellingPrice: opts.sellingPrice ?? 18000, status: "AVAILABLE", isDeleted: false,
    })
  );
  const financeCompanyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", { orgId, name: "Test Finance", profitRate: 5, maxTermMonths: 60, gracePeriodMonths: 0, insuranceRate: 3, adminFees: 150, commission: 300, isActive: true })
  );
  const asOwner = t.withIdentity({ subject: `owner_${orgId}` });
  await asOwner.mutation(api.websites.startSetup, { orgId });
  await asOwner.mutation(api.websites.saveDraft, {
    orgId,
    subdomainSlug: opts.subdomainSlug,
    activeFinanceCompanyId: financeCompanyId,
    sections: [
      { sectionKey: "vehicle.price", enabled: true },
      { sectionKey: "vehicle.photos", enabled: true },
    ],
  });
  await asOwner.mutation(api.websites.publish, { orgId });
  await t.run((ctx) =>
    ctx.db.insert("marketplaceDealerProfiles", {
      orgId, isOptedIn: true, areas: [opts.city], brandsCarried: ["Toyota"], badges: [],
      totalResponses: 0, totalAccepted: 0, tier: opts.tier ?? "FREE_FOUNDING",
      leadQuota: opts.tier === "LEAD_PACKAGE" ? 1 : undefined,
      leadsUsedThisPeriod: opts.quotaExhausted ? 1 : 0,
      leadPeriodStartedAt: opts.quotaExhausted ? Date.now() : undefined,
      createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  return { orgId };
}

describe("two-tier inventory matching", () => {
  test("scores a dealer's published inventory into an INVENTORY-tier match with reasons + monthly estimate", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId } = await seedPublishedDealer(t, { name: "Amman Motors", subdomainSlug: "amanm1", city: "Amman", model: "Corolla", sellingPrice: 18000 });

    const result = await t.action(api.marketplaceRequests.submitRequest, {
      ...baseRequestArgs, make: "Toyota", model: "Corolla", priceMin: 15000, priceMax: 22000, monthlyBudget: 600,
    });

    const match = await t.run((ctx) =>
      ctx.db.query("marketplaceRequestMatches").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()
    );
    expect(match?.matchTier).toBe("INVENTORY");
    expect(match?.matchScore).toBeGreaterThan(0);
    expect(match?.matchReasons).toContain("model_exact");
    expect(match?.estimatedMonthlyPayment).toBeGreaterThan(0);
    expect(match?.calculationSnapshot?.vehiclePrice).toBe(18000);
  });

  test("an inventory match outranks an eligible-only dealer", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId: inventoryOrg } = await seedPublishedDealer(t, { name: "Stocked", subdomainSlug: "stocked1", city: "Amman", model: "Corolla" });
    // Eligible-only dealer: city/brand match but no published inventory.
    const { orgId: eligibleOrg } = await seedDealer(t, { name: "Sourcer", areas: ["Amman"], brandsCarried: ["Toyota"] });

    await t.action(api.marketplaceRequests.submitRequest, { ...baseRequestArgs, make: "Toyota", model: "Corolla" });

    const inv = await t.run((ctx) => ctx.db.query("marketplaceRequestMatches").withIndex("by_org", (q) => q.eq("orgId", inventoryOrg)).unique());
    const elig = await t.run((ctx) => ctx.db.query("marketplaceRequestMatches").withIndex("by_org", (q) => q.eq("orgId", eligibleOrg)).unique());
    expect(inv?.matchTier).toBe("INVENTORY");
    expect(elig?.matchTier).toBe("ELIGIBLE");
    expect(inv!.matchScore!).toBeGreaterThan(elig!.matchScore!);
  });

  test("a quota-exhausted dealer is excluded before consuming a match slot", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId } = await seedPublishedDealer(t, { name: "Maxed Out", subdomainSlug: "maxed1", city: "Amman", model: "Corolla", tier: "LEAD_PACKAGE", quotaExhausted: true });

    const result = await t.action(api.marketplaceRequests.submitRequest, { ...baseRequestArgs, make: "Toyota", model: "Corolla" });

    expect(result.matchedCount).toBe(0);
    const match = await t.run((ctx) => ctx.db.query("marketplaceRequestMatches").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique());
    expect(match).toBeNull();
  });
});

describe("computeBuyerIntent", () => {
  test("HOT when urgent timeframe and budget are both given", () => {
    expect(computeBuyerIntent({ buyerTimeframe: "ASAP", monthlyBudget: 300 })).toBe("HOT");
    expect(computeBuyerIntent({ buyerTimeframe: "THIS_WEEK", priceMax: 15000 })).toBe("HOT");
  });

  test("WARM when only one signal is given", () => {
    expect(computeBuyerIntent({ buyerTimeframe: "ASAP" })).toBe("WARM");
    expect(computeBuyerIntent({ buyerTimeframe: "JUST_LOOKING", priceMin: 10000 })).toBe("WARM");
  });

  test("COLD when neither signal is given", () => {
    expect(computeBuyerIntent({ buyerTimeframe: "THIS_MONTH" })).toBe("COLD");
    expect(computeBuyerIntent({ buyerTimeframe: "JUST_LOOKING" })).toBe("COLD");
  });
});

describe("dealerMatchesRequest", () => {
  test("matches on city and brand when both are specified", () => {
    expect(
      dealerMatchesRequest({ areas: ["Amman"], brandsCarried: ["Toyota"] }, { buyerCity: "amman", make: "toyota" })
    ).toBe(true);
    expect(
      dealerMatchesRequest({ areas: ["Amman"], brandsCarried: ["Toyota"] }, { buyerCity: "Irbid", make: "Toyota" })
    ).toBe(false);
    expect(
      dealerMatchesRequest({ areas: ["Amman"], brandsCarried: ["Toyota"] }, { buyerCity: "Amman", make: "Kia" })
    ).toBe(false);
  });

  test("empty areas/brands lists act as a wildcard", () => {
    expect(dealerMatchesRequest({ areas: [], brandsCarried: [] }, { buyerCity: "Zarqa", make: "Hyundai" })).toBe(true);
    expect(dealerMatchesRequest({ areas: ["Amman"], brandsCarried: [] }, { buyerCity: "Amman" })).toBe(true);
  });
});

describe("submitRequest", () => {
  test("matches, caps at 5, ranks by response time, and notifies each matched org", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));

    for (let i = 0; i < 6; i++) {
      await seedDealer(t, {
        name: `Dealer ${i}`,
        areas: ["Amman"],
        brandsCarried: [],
        whatsappNumber: `+96279000000${i}`,
        avgResponseMinutes: 60 - i, // Dealer 5 has the best (lowest) response time
      });
    }
    // Non-matching dealer (wrong city) — must never be matched.
    await seedDealer(t, { name: "Irbid Dealer", areas: ["Irbid"], brandsCarried: [] });

    const result = await t.action(api.marketplaceRequests.submitRequest, baseRequestArgs);
    expect(result.matchedCount).toBe(5);

    const matches = await t.run((ctx) => ctx.db.query("marketplaceRequestMatches").collect());
    expect(matches).toHaveLength(5);

    const request = await t.run((ctx) => ctx.db.get(result.requestId));
    expect(request?.status).toBe("MATCHED");
    // THIS_WEEK (urgent) but no budget/price fields given -> WARM, not HOT.
    expect(request?.buyerIntent).toBe("WARM");

    const notifications = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notifications.length).toBeGreaterThanOrEqual(5);
  });

  test("a FEATURED dealer wins fan-out priority over faster-but-unfeatured dealers, capped at 5 (Phase 63)", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));

    for (let i = 0; i < 5; i++) {
      await seedDealer(t, {
        name: `Fast Dealer ${i}`,
        areas: ["Amman"],
        brandsCarried: [],
        avgResponseMinutes: 5, // faster than the featured dealer below
      });
    }
    const { orgId: featuredOrgId } = await seedDealer(t, {
      name: "Featured Dealer",
      areas: ["Amman"],
      brandsCarried: [],
      avgResponseMinutes: 500, // slowest of all — would rank last without the featured boost
    });
    await t.run((ctx) =>
      ctx.db
        .query("marketplaceDealerProfiles")
        .withIndex("by_org", (q) => q.eq("orgId", featuredOrgId))
        .unique()
        .then((profile) => ctx.db.patch(profile!._id, { tier: "FEATURED" }))
    );

    const result = await t.action(api.marketplaceRequests.submitRequest, baseRequestArgs);
    expect(result.matchedCount).toBe(5);

    const matches = await t.run((ctx) => ctx.db.query("marketplaceRequestMatches").collect());
    expect(matches.some((match) => match.orgId === featuredOrgId)).toBe(true);
  });

  test("rejects submission without consent", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    await expect(
      t.action(api.marketplaceRequests.submitRequest, { ...baseRequestArgs, consentAccepted: false })
    ).rejects.toThrow();
  });

  test("excludes suspended orgs even if opted in and matching", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    await seedDealer(t, { name: "Suspended Dealer", areas: ["Amman"], brandsCarried: [], suspended: true });

    const result = await t.action(api.marketplaceRequests.submitRequest, baseRequestArgs);
    expect(result.matchedCount).toBe(0);

    const request = await t.run((ctx) => ctx.db.get(result.requestId));
    expect(request?.status).toBe("OPEN");
  });
});

describe("publicId", () => {
  test("every request gets a distinct unguessable publicId, returned to the buyer and stored on the row", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    await seedDealer(t, { name: "Dealer", areas: ["Amman"], brandsCarried: [] });

    const first = await t.action(api.marketplaceRequests.submitRequest, baseRequestArgs);
    const second = await t.action(api.marketplaceRequests.submitRequest, {
      ...baseRequestArgs,
      clientFingerprint: "fp-2",
      buyerPhone: "+962791234568",
    });

    expect(first.publicId).toMatch(/^[0-9a-f]{32}$/);
    expect(second.publicId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.publicId).not.toBe(second.publicId);

    const stored = await t.run((ctx) => ctx.db.get(first.requestId));
    expect(stored?.publicId).toBe(first.publicId);
  });

  test("backfill assigns publicIds to legacy rows and leaves existing ones untouched", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const legacyRow = {
      status: "OPEN" as const,
      buyerFirstName: "Legacy",
      buyerPhone: "+962790000000",
      buyerCity: "Amman",
      paymentType: "CASH" as const,
      buyerTimeframe: "THIS_MONTH" as const,
      buyerIntent: "COLD" as const,
      consentAcceptedAt: Date.now(),
      clientFingerprint: "fp-legacy",
      expiresAt: Date.now() + 1000,
      createdAt: Date.now(),
    };
    const legacyId = await t.run((ctx) => ctx.db.insert("marketplaceRequests", legacyRow));
    const keptId = await t.run((ctx) =>
      ctx.db.insert("marketplaceRequests", { ...legacyRow, publicId: "pre-existing-token" })
    );

    await t.mutation(internal.migrateMarketplacePublicIds.backfillMarketplacePublicIds, {});

    const legacy = await t.run((ctx) => ctx.db.get(legacyId));
    expect(legacy?.publicId).toMatch(/^[0-9a-f]{32}$/);
    const kept = await t.run((ctx) => ctx.db.get(keptId));
    expect(kept?.publicId).toBe("pre-existing-token");
  });
});

describe("getStatusForBuyer", () => {
  test("returns status/count for the correct phone, null otherwise", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    await seedDealer(t, { name: "Dealer", areas: ["Amman"], brandsCarried: [] });
    const result = await t.action(api.marketplaceRequests.submitRequest, baseRequestArgs);

    const status = await t.query(api.marketplaceRequests.getStatusForBuyer, {
      requestId: result.requestId,
      buyerPhone: baseRequestArgs.buyerPhone,
    });
    expect(status).toMatchObject({ status: "MATCHED", matchedCount: 1 });

    const wrongPhone = await t.query(api.marketplaceRequests.getStatusForBuyer, {
      requestId: result.requestId,
      buyerPhone: "+962700000000",
    });
    expect(wrongPhone).toBeNull();
  });

  test("getStatusForBuyerByPublicId accepts a raw id string and returns null for a malformed id", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    await seedDealer(t, { name: "Dealer", areas: ["Amman"], brandsCarried: [] });
    const result = await t.action(api.marketplaceRequests.submitRequest, baseRequestArgs);

    const status = await t.query(api.marketplaceRequests.getStatusForBuyerByPublicId, {
      requestId: result.requestId,
      buyerPhone: baseRequestArgs.buyerPhone,
    });
    expect(status).toMatchObject({ status: "MATCHED", matchedCount: 1 });

    const malformed = await t.query(api.marketplaceRequests.getStatusForBuyerByPublicId, {
      requestId: "not-a-real-id",
      buyerPhone: baseRequestArgs.buyerPhone,
    });
    expect(malformed).toBeNull();
  });
});

describe("getBuyerOffers", () => {
  async function seedRequestWithPublicId(t: ReturnType<typeof convexTestWithComponents>, publicId: string) {
    return await t.run((ctx) =>
      ctx.db.insert("marketplaceRequests", {
        status: "OFFERS_RECEIVED",
        publicId,
        buyerFirstName: "Sami",
        buyerPhone: "+962791234567",
        buyerCity: "Amman",
        make: "Toyota",
        model: "Corolla",
        paymentType: "FINANCE",
        buyerTimeframe: "ASAP",
        buyerIntent: "HOT",
        consentAcceptedAt: Date.now(),
        clientFingerprint: "fp-offers",
        expiresAt: Date.now() + 100000,
        createdAt: Date.now(),
      })
    );
  }

  test("returns sanitized offers for a valid publicId and omits NOT_AVAILABLE replies", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Bloom Cars", createdAt: Date.now() }));
    const otherOrgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Other Motors", createdAt: Date.now() }));
    const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "u1", email: "u1@test.com", name: "Rep" }));
    await t.run((ctx) =>
      ctx.db.insert("marketplaceDealerProfiles", {
        orgId, isOptedIn: true, areas: [], brandsCarried: [], badges: ["FAST_RESPONSE"],
        totalResponses: 3, totalAccepted: 1, avgResponseMinutes: 12, tier: "FEATURED",
        leadsUsedThisPeriod: 0, createdAt: Date.now(), updatedAt: Date.now(),
      })
    );
    const requestId = await seedRequestWithPublicId(t, "room-token-1");

    await t.run((ctx) =>
      ctx.db.insert("marketplaceResponses", {
        requestId, orgId, respondingUserId: userId, kind: "CAN_SOURCE",
        sourcingRange: { minJod: 15000, maxJod: 18000, etaDays: 10 },
        createdAt: Date.now(),
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("marketplaceResponses", {
        requestId, orgId: otherOrgId, respondingUserId: userId, kind: "NOT_AVAILABLE",
        createdAt: Date.now(),
      })
    );

    const result = await t.query(api.marketplaceRequests.getBuyerOffers, { publicId: "room-token-1" });
    expect(result?.status).toBe("OFFERS_RECEIVED");
    expect(result?.offers).toHaveLength(1);
    expect(result?.offers[0]).toMatchObject({
      dealerName: "Bloom Cars",
      dealerBadges: ["FAST_RESPONSE"],
      dealerAvgResponseMinutes: 12,
      kind: "CAN_SOURCE",
      sourcingRange: { minJod: 15000, maxJod: 18000, etaDays: 10 },
    });
  });

  test("marks an offer expired once its finance-offer expiry has passed", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Bloom Cars", createdAt: Date.now() }));
    const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "u2", email: "u2@test.com", name: "Rep" }));
    const requestId = await seedRequestWithPublicId(t, "room-token-2");
    await t.run((ctx) =>
      ctx.db.insert("marketplaceResponses", {
        requestId, orgId, respondingUserId: userId, kind: "HAVE_SIMILAR",
        offerPriceJod: 19000,
        financeOffer: {
          vehiclePrice: 19000, downPayment: 4000, termMonths: 60, monthlyInstallment: 320,
          totalContractValue: 23200, totalProfit: 3000, insuranceAmount: 1200,
          commission: 300, processingFees: 150, expiresAt: Date.now() - 1000,
        },
        createdAt: Date.now(),
      })
    );

    const result = await t.query(api.marketplaceRequests.getBuyerOffers, { publicId: "room-token-2" });
    expect(result?.offers[0].isExpired).toBe(true);
  });

  test("returns null for an unknown publicId", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const result = await t.query(api.marketplaceRequests.getBuyerOffers, { publicId: "does-not-exist" });
    expect(result).toBeNull();
  });

  test("reports matchedCount and respondedCount for the Request Room timeline", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Bloom Cars", createdAt: Date.now() }));
    const otherOrgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Other Motors", createdAt: Date.now() }));
    const silentOrgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Quiet Autos", createdAt: Date.now() }));
    const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "u3", email: "u3@test.com", name: "Rep" }));
    const requestId = await seedRequestWithPublicId(t, "room-token-3");

    // Three dealers were matched...
    for (const matchedOrgId of [orgId, otherOrgId, silentOrgId]) {
      await t.run((ctx) =>
        ctx.db.insert("marketplaceRequestMatches", {
          requestId, orgId: matchedOrgId, matchTier: "ELIGIBLE", matchedAt: Date.now(),
        })
      );
    }
    // ...one replied with an offer, one said NOT_AVAILABLE, one stayed silent.
    await t.run((ctx) =>
      ctx.db.insert("marketplaceResponses", {
        requestId, orgId, respondingUserId: userId, kind: "CAN_SOURCE",
        sourcingRange: { minJod: 15000, maxJod: 18000, etaDays: 10 }, createdAt: Date.now(),
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("marketplaceResponses", {
        requestId, orgId: otherOrgId, respondingUserId: userId, kind: "NOT_AVAILABLE", createdAt: Date.now(),
      })
    );

    const result = await t.query(api.marketplaceRequests.getBuyerOffers, { publicId: "room-token-3" });
    expect(result?.matchedCount).toBe(3);
    // NOT_AVAILABLE is not an offer, so it doesn't count as a reply.
    expect(result?.respondedCount).toBe(1);
  });
});

describe("expireStaleRequests", () => {
  test("expires OPEN/MATCHED requests past expiresAt, leaves fresh ones alone", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const staleId = await t.run((ctx) =>
      ctx.db.insert("marketplaceRequests", {
        status: "OPEN",
        buyerFirstName: "Old",
        buyerPhone: "+962700000001",
        buyerCity: "Amman",
        paymentType: "CASH",
        buyerTimeframe: "JUST_LOOKING",
        buyerIntent: "COLD",
        consentAcceptedAt: Date.now() - 1000,
        clientFingerprint: "fp-old",
        expiresAt: Date.now() - 1000,
        createdAt: Date.now() - 2000,
      })
    );
    const freshId = await t.run((ctx) =>
      ctx.db.insert("marketplaceRequests", {
        status: "OPEN",
        buyerFirstName: "New",
        buyerPhone: "+962700000002",
        buyerCity: "Amman",
        paymentType: "CASH",
        buyerTimeframe: "JUST_LOOKING",
        buyerIntent: "COLD",
        consentAcceptedAt: Date.now(),
        clientFingerprint: "fp-new",
        expiresAt: Date.now() + 100000,
        createdAt: Date.now(),
      })
    );

    await t.mutation(internal.marketplaceRequests.expireStaleRequests, {});

    expect((await t.run((ctx) => ctx.db.get(staleId)))?.status).toBe("EXPIRED");
    expect((await t.run((ctx) => ctx.db.get(freshId)))?.status).toBe("OPEN");
  });

  // SCRUM-807 — the sweep must read only the requests that are actually due.
  type Status = "OPEN" | "MATCHED" | "OFFERS_RECEIVED";
  const seedRequest = (
    status: Status,
    expiresAt: number,
    extra: { bodyType?: string } = {}
  ) => ({
    status,
    buyerFirstName: "Buyer",
    buyerPhone: "+962700000009",
    buyerCity: "Amman",
    paymentType: "CASH" as const,
    buyerTimeframe: "JUST_LOOKING" as const,
    buyerIntent: "COLD" as const,
    consentAcceptedAt: 1,
    clientFingerprint: "fp-scrum807",
    expiresAt,
    createdAt: 1,
    ...extra,
  });
  const countByStatus = async (
    t: ReturnType<typeof convexTestWithComponents<typeof schema>>
  ) => {
    const rows = await t.run((ctx) => ctx.db.query("marketplaceRequests").collect());
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    return counts;
  };

  test("a stale cohort larger than one batch is processed in bounded batches and still fully drained", async () => {
    vi.useFakeTimers();
    try {
      const NOW = 1_800_000_000_000;
      vi.setSystemTime(NOW);
      const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
      // 101 per status: one more than the 100-row batch, so a single hop cannot
      // finish either status.
      await t.run(async (ctx) => {
        for (let i = 0; i < 101; i++) {
          await ctx.db.insert("marketplaceRequests", seedRequest("OPEN", NOW - 1 - i));
          await ctx.db.insert("marketplaceRequests", seedRequest("MATCHED", NOW - 1 - i));
        }
        await ctx.db.insert("marketplaceRequests", seedRequest("OPEN", NOW + 60_000));
      });

      await t.mutation(internal.marketplaceRequests.expireStaleRequests, {});

      // One hop: at most one batch per status. The remainder waits for the
      // continuation rather than being read into the same transaction.
      expect(await countByStatus(t)).toEqual({ EXPIRED: 200, OPEN: 2, MATCHED: 1 });

      // The sweep drains itself through its own continuation (no second cron tick).
      await t.finishAllScheduledFunctions(vi.runAllTimers);
      expect(await countByStatus(t)).toEqual({ EXPIRED: 202, OPEN: 1 });

      const fresh = await t.run((ctx) =>
        ctx.db.query("marketplaceRequests").withIndex("by_status", (q) => q.eq("status", "OPEN")).collect()
      );
      expect(fresh.map((r) => r.expiresAt)).toEqual([NOW + 60_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("expiry is strictly before now, for OPEN and MATCHED only", async () => {
    vi.useFakeTimers();
    try {
      const NOW = 1_800_000_000_000;
      vi.setSystemTime(NOW);
      const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
      const ids = await t.run(async (ctx) => ({
        openAtNow: await ctx.db.insert("marketplaceRequests", seedRequest("OPEN", NOW)),
        openJustPast: await ctx.db.insert("marketplaceRequests", seedRequest("OPEN", NOW - 1)),
        matchedAtNow: await ctx.db.insert("marketplaceRequests", seedRequest("MATCHED", NOW)),
        matchedJustPast: await ctx.db.insert("marketplaceRequests", seedRequest("MATCHED", NOW - 1)),
        // Not swept by this cron today; pinned so a change is deliberate.
        offersStale: await ctx.db.insert("marketplaceRequests", seedRequest("OFFERS_RECEIVED", NOW - 1)),
      }));

      await t.mutation(internal.marketplaceRequests.expireStaleRequests, {});

      const status = async (id: (typeof ids)[keyof typeof ids]) =>
        (await t.run((ctx) => ctx.db.get(id)))?.status;
      expect(await status(ids.openAtNow)).toBe("OPEN");
      expect(await status(ids.openJustPast)).toBe("EXPIRED");
      expect(await status(ids.matchedAtNow)).toBe("MATCHED");
      expect(await status(ids.matchedJustPast)).toBe("EXPIRED");
      expect(await status(ids.offersStale)).toBe("OFFERS_RECEIVED");
    } finally {
      vi.useRealTimers();
    }
  });

  test("live requests are not read: a large fresh backlog stays under the platform read ceiling", async () => {
    // convex-test enforces the ceilings but exposes no usage counters, so
    // "resolves" is the signal. ~4,500 x 4 KB of fresh OPEN requests is ~18 MiB,
    // past the 16 MiB read ceiling; a full-status `.collect()` cannot finish.
    const FAT = "x".repeat(4_000);
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"), {
      transactionLimits: true,
    });
    const now = Date.now();
    for (let chunk = 0; chunk < 10; chunk++) {
      await t.run(async (ctx) => {
        for (let i = 0; i < 450; i++) {
          await ctx.db.insert("marketplaceRequests", seedRequest("OPEN", now + 86_400_000, { bodyType: FAT }));
        }
      });
    }
    const staleId = await t.run((ctx) =>
      ctx.db.insert("marketplaceRequests", seedRequest("OPEN", now - 1_000))
    );

    await t.mutation(internal.marketplaceRequests.expireStaleRequests, {});

    // Asserted with bounded reads: the fat backlog itself is past the ceiling.
    const expired = await t.run((ctx) =>
      ctx.db.query("marketplaceRequests").withIndex("by_status", (q) => q.eq("status", "EXPIRED")).take(2)
    );
    expect(expired.map((r) => r._id)).toEqual([staleId]);
    const stillOpen = await t.run((ctx) =>
      ctx.db.query("marketplaceRequests").withIndex("by_status", (q) => q.eq("status", "OPEN")).take(5)
    );
    expect(stillOpen).toHaveLength(5);
  }, 120_000);
});
