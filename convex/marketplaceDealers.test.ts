import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { computeBadges, MarketplaceBadge, checkMarketplaceQuota, effectiveFoundingWindowEndsAt, compareDealerRank } from "./marketplaceDealers";

async function seedDealer(t: ReturnType<typeof convexTest>, opts?: { name?: string; suspended?: boolean }) {
  const orgId = await t.run(async (ctx) =>
    ctx.db.insert("organizations", { name: opts?.name ?? "Test Dealer", createdAt: Date.now(), suspended: opts?.suspended })
  );
  const userId = await t.run(async (ctx) =>
    ctx.db.insert("users", { clerkId: `owner_${orgId}`, email: `owner_${orgId}@test.com`, name: "Owner" })
  );
  const roleId = await t.run(async (ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ["marketplace:settings"],
      isSystemOwnerRole: true,
    })
  );
  await t.run(async (ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return { orgId, userId, asOwner: t.withIdentity({ subject: `owner_${orgId}` }) };
}

async function seedVehicle(
  t: ReturnType<typeof convexTest>,
  orgId: Id<"organizations">,
  overrides?: Partial<{ status: "AVAILABLE" | "SOLD"; isDeleted: boolean }>
) {
  await t.run(async (ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      make: "Toyota",
      model: "Corolla",
      year: 2020,
      mileage: 50000,
      color: "White",
      fuelType: "Petrol",
      transmission: "Automatic",
      sellingPrice: 15000,
      status: overrides?.status ?? "AVAILABLE",
      isDeleted: overrides?.isDeleted ?? false,
    })
  );
}

describe("marketplaceDealers", () => {
  test("getMyProfile returns null when never configured", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asOwner } = await seedDealer(t);
    const profile = await asOwner.query(api.marketplaceDealers.getMyProfile, { orgId });
    expect(profile).toBeNull();
  });

  test("getMyProfile throws when unauthenticated", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId } = await seedDealer(t);
    await expect(t.query(api.marketplaceDealers.getMyProfile, { orgId })).rejects.toThrow();
  });

  test("updateProfile inserts a new profile and normalizes areas/brands", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asOwner } = await seedDealer(t);

    await asOwner.mutation(api.marketplaceDealers.updateProfile, {
      orgId,
      isOptedIn: true,
      areas: [" Amman ", "Amman", "", "Zarqa"],
      brandsCarried: ["Toyota", " Kia "],
      whatsappNumber: " +962700000000 ",
    });

    const profile = await asOwner.query(api.marketplaceDealers.getMyProfile, { orgId });
    expect(profile?.isOptedIn).toBe(true);
    expect(profile?.areas).toEqual(["Amman", "Zarqa"]);
    expect(profile?.brandsCarried).toEqual(["Toyota", "Kia"]);
    expect(profile?.whatsappNumber).toBe("+962700000000");
    expect(profile?.tier).toBe("FREE_FOUNDING");
  });

  test("updateProfile upserts in place rather than duplicating", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asOwner } = await seedDealer(t);

    await asOwner.mutation(api.marketplaceDealers.updateProfile, {
      orgId,
      isOptedIn: true,
      areas: ["Amman"],
      brandsCarried: [],
    });
    await asOwner.mutation(api.marketplaceDealers.updateProfile, {
      orgId,
      isOptedIn: false,
      areas: ["Irbid"],
      brandsCarried: [],
    });

    const rows = await t.run((ctx) => ctx.db.query("marketplaceDealerProfiles").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].isOptedIn).toBe(false);
    expect(rows[0].areas).toEqual(["Irbid"]);
  });

  test("updateProfile restores a soft-deleted profile", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId, asOwner } = await seedDealer(t);

    await asOwner.mutation(api.marketplaceDealers.updateProfile, {
      orgId,
      isOptedIn: true,
      areas: ["Amman"],
      brandsCarried: [],
    });
    const created = await t.run((ctx) => ctx.db.query("marketplaceDealerProfiles").collect());
    await t.run((ctx) =>
      ctx.db.patch(created[0]._id, { isDeleted: true, deletedAt: Date.now(), deletedBy: userId })
    );

    await asOwner.mutation(api.marketplaceDealers.updateProfile, {
      orgId,
      isOptedIn: true,
      areas: ["Zarqa"],
      brandsCarried: ["Kia"],
    });

    const profile = await asOwner.query(api.marketplaceDealers.getMyProfile, { orgId });
    expect(profile?.isDeleted).toBe(false);
    expect(profile?.deletedAt).toBeUndefined();
    expect(profile?.deletedBy).toBeUndefined();
    expect(profile?.areas).toEqual(["Zarqa"]);
    expect(profile?.brandsCarried).toEqual(["Kia"]);
  });

  test("listPublicDirectory only returns opted-in dealers with a live vehicle count", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const optedIn = await seedDealer(t, { name: "Opted In Dealer" });
    const optedOut = await seedDealer(t, { name: "Opted Out Dealer" });

    await optedIn.asOwner.mutation(api.marketplaceDealers.updateProfile, {
      orgId: optedIn.orgId,
      isOptedIn: true,
      areas: ["Amman"],
      brandsCarried: ["Toyota"],
    });
    await optedOut.asOwner.mutation(api.marketplaceDealers.updateProfile, {
      orgId: optedOut.orgId,
      isOptedIn: false,
      areas: ["Amman"],
      brandsCarried: [],
    });

    await seedVehicle(t, optedIn.orgId, { status: "AVAILABLE" });
    await seedVehicle(t, optedIn.orgId, { status: "AVAILABLE" });
    await seedVehicle(t, optedIn.orgId, { status: "SOLD" });
    await seedVehicle(t, optedIn.orgId, { status: "AVAILABLE", isDeleted: true });

    const directory = await t.query(api.marketplaceDealers.listPublicDirectory, {});
    expect(directory).toHaveLength(1);
    expect(directory[0].dealershipName).toBe("Opted In Dealer");
    expect(directory[0].activeVehicleCount).toBe(2);
  });

  test("listPublicDirectory excludes orgs suspended after opting in", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const dealer = await seedDealer(t, { name: "Later Suspended Dealer" });

    await dealer.asOwner.mutation(api.marketplaceDealers.updateProfile, {
      orgId: dealer.orgId,
      isOptedIn: true,
      areas: [],
      brandsCarried: [],
    });
    await t.run((ctx) => ctx.db.patch(dealer.orgId, { suspended: true }));

    const directory = await t.query(api.marketplaceDealers.listPublicDirectory, {});
    expect(directory).toHaveLength(0);
  });

  test("listPublicDirectory ranks FAST_RESPONSE dealers above others, then by response time", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const slow = await seedDealer(t, { name: "Slow Dealer" });
    const fast = await seedDealer(t, { name: "Fast Dealer" });

    for (const dealer of [slow, fast]) {
      await dealer.asOwner.mutation(api.marketplaceDealers.updateProfile, {
        orgId: dealer.orgId,
        isOptedIn: true,
        areas: [],
        brandsCarried: [],
      });
    }
    await t.run((ctx) =>
      ctx.db
        .query("marketplaceDealerProfiles")
        .withIndex("by_org", (q) => q.eq("orgId", slow.orgId))
        .unique()
        .then((profile) => ctx.db.patch(profile!._id, { avgResponseMinutes: 500, totalResponses: 5 }))
    );
    await t.run((ctx) =>
      ctx.db
        .query("marketplaceDealerProfiles")
        .withIndex("by_org", (q) => q.eq("orgId", fast.orgId))
        .unique()
        .then((profile) => ctx.db.patch(profile!._id, { avgResponseMinutes: 10, totalResponses: 5, badges: ["FAST_RESPONSE"] }))
    );

    const directory = await t.query(api.marketplaceDealers.listPublicDirectory, {});
    expect(directory.map((row) => row.dealershipName)).toEqual(["Fast Dealer", "Slow Dealer"]);
  });

  test("listPublicDirectory ranks a FEATURED dealer above a FAST_RESPONSE one (Phase 63)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const fast = await seedDealer(t, { name: "Fast Dealer" });
    const featured = await seedDealer(t, { name: "Featured Dealer" });

    for (const dealer of [fast, featured]) {
      await dealer.asOwner.mutation(api.marketplaceDealers.updateProfile, {
        orgId: dealer.orgId,
        isOptedIn: true,
        areas: [],
        brandsCarried: [],
      });
    }
    await t.run((ctx) =>
      ctx.db
        .query("marketplaceDealerProfiles")
        .withIndex("by_org", (q) => q.eq("orgId", fast.orgId))
        .unique()
        .then((profile) => ctx.db.patch(profile!._id, { avgResponseMinutes: 5, totalResponses: 5, badges: ["FAST_RESPONSE"] }))
    );
    await t.run((ctx) =>
      ctx.db
        .query("marketplaceDealerProfiles")
        .withIndex("by_org", (q) => q.eq("orgId", featured.orgId))
        .unique()
        .then((profile) => ctx.db.patch(profile!._id, { tier: "FEATURED" }))
    );

    const directory = await t.query(api.marketplaceDealers.listPublicDirectory, {});
    expect(directory.map((row) => row.dealershipName)).toEqual(["Featured Dealer", "Fast Dealer"]);
  });
});

describe("compareDealerRank", () => {
  test("FEATURED sorts before FAST_RESPONSE regardless of response time", () => {
    const featured = { badges: [] as MarketplaceBadge[], avgResponseMinutes: 999, createdAt: 2, tier: "FEATURED" as const };
    const fast = { badges: ["FAST_RESPONSE"] as MarketplaceBadge[], avgResponseMinutes: 1, createdAt: 1, tier: "FREE_FOUNDING" as const };
    expect(compareDealerRank(featured, fast)).toBeLessThan(0);
  });
});

describe("effectiveFoundingWindowEndsAt", () => {
  test("falls back to createdAt + 60 days when foundingWindowEndsAt is unset (pre-Phase-63 rows)", () => {
    const createdAt = Date.now();
    expect(effectiveFoundingWindowEndsAt({ createdAt, foundingWindowEndsAt: undefined })).toBe(
      createdAt + 60 * 24 * 60 * 60 * 1000
    );
  });

  test("uses the stamped value when present", () => {
    expect(effectiveFoundingWindowEndsAt({ createdAt: 0, foundingWindowEndsAt: 12345 })).toBe(12345);
  });
});

describe("checkMarketplaceQuota", () => {
  const base = { leadQuota: undefined as number | undefined, leadsUsedThisPeriod: 0, leadPeriodStartedAt: undefined as number | undefined };

  test("FREE_FOUNDING is allowed within the window and blocked once it expires", () => {
    const now = Date.now();
    expect(checkMarketplaceQuota({ ...base, tier: "FREE_FOUNDING", createdAt: now, foundingWindowEndsAt: now + 1000 }, now)).toEqual({ allowed: true });
    expect(checkMarketplaceQuota({ ...base, tier: "FREE_FOUNDING", createdAt: now, foundingWindowEndsAt: now - 1000 }, now)).toEqual({
      allowed: false,
      reason: "FOUNDING_WINDOW_EXPIRED",
    });
  });

  test("LEAD_PACKAGE is blocked once leadsUsedThisPeriod reaches leadQuota, within the same period", () => {
    const now = Date.now();
    expect(
      checkMarketplaceQuota({ ...base, tier: "LEAD_PACKAGE", createdAt: now, leadQuota: 5, leadsUsedThisPeriod: 4, leadPeriodStartedAt: now }, now)
    ).toEqual({ allowed: true });
    expect(
      checkMarketplaceQuota({ ...base, tier: "LEAD_PACKAGE", createdAt: now, leadQuota: 5, leadsUsedThisPeriod: 5, leadPeriodStartedAt: now }, now)
    ).toEqual({ allowed: false, reason: "LEAD_QUOTA_EXHAUSTED" });
  });

  test("LEAD_PACKAGE resets once the 30-day period has elapsed, even if leadsUsedThisPeriod is stale", () => {
    const now = Date.now();
    const staleStart = now - 31 * 24 * 60 * 60 * 1000;
    expect(
      checkMarketplaceQuota({ ...base, tier: "LEAD_PACKAGE", createdAt: staleStart, leadQuota: 5, leadsUsedThisPeriod: 5, leadPeriodStartedAt: staleStart }, now)
    ).toEqual({ allowed: true });
  });

  test("FEATURED is always allowed", () => {
    const now = Date.now();
    expect(checkMarketplaceQuota({ ...base, tier: "FEATURED", createdAt: now }, now)).toEqual({ allowed: true });
  });
});

describe("computeBadges", () => {
  test("adds FAST_RESPONSE only once the sample size and avg threshold are both met", () => {
    const base = { badges: [] as MarketplaceBadge[], phoneVerifiedAt: undefined };

    expect(computeBadges({ ...base, avgResponseMinutes: 10, totalResponses: 2 }, false)).not.toContain("FAST_RESPONSE");
    expect(computeBadges({ ...base, avgResponseMinutes: 90, totalResponses: 5 }, false)).not.toContain("FAST_RESPONSE");
    expect(computeBadges({ ...base, avgResponseMinutes: 10, totalResponses: 5 }, false)).toContain("FAST_RESPONSE");
  });

  test("adds VERIFIED_PHONE when phoneVerifiedAt is set, and FINANCE_AVAILABLE from the passed-in flag", () => {
    const badges = computeBadges(
      { badges: [], avgResponseMinutes: undefined, totalResponses: 0, phoneVerifiedAt: Date.now() },
      true
    );
    expect(badges).toEqual(expect.arrayContaining(["VERIFIED_PHONE", "FINANCE_AVAILABLE"]));
  });

  test("preserves pre-existing VERIFIED_LOCATION/FOUNDING_DEALER badges it doesn't compute itself", () => {
    const badges = computeBadges(
      { badges: ["VERIFIED_LOCATION", "FOUNDING_DEALER"], avgResponseMinutes: undefined, totalResponses: 0, phoneVerifiedAt: undefined },
      false
    );
    expect(badges).toEqual(expect.arrayContaining(["VERIFIED_LOCATION", "FOUNDING_DEALER"]));
  });
});

describe("recomputeAllDealerBadges", () => {
  test("persists FINANCE_AVAILABLE for an opted-in dealer with an active finance company", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const dealer = await seedDealer(t);

    await dealer.asOwner.mutation(api.marketplaceDealers.updateProfile, {
      orgId: dealer.orgId,
      isOptedIn: true,
      areas: [],
      brandsCarried: [],
    });
    await t.run((ctx) =>
      ctx.db.insert("financeCompanies", {
        orgId: dealer.orgId,
        name: "Test Finance",
        profitRate: 5,
        maxTermMonths: 60,
        gracePeriodMonths: 0,
        isActive: true,
      })
    );

    await t.mutation(internal.marketplaceDealers.recomputeAllDealerBadges, {});

    const profile = await t.run((ctx) =>
      ctx.db.query("marketplaceDealerProfiles").withIndex("by_org", (q) => q.eq("orgId", dealer.orgId)).unique()
    );
    expect(profile?.badges).toContain("FINANCE_AVAILABLE");
  });
});
