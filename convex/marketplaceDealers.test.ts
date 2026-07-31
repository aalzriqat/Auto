import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { computeBadges, MarketplaceBadge, checkMarketplaceQuota, effectiveFoundingWindowEndsAt, compareDealerRank, listOptedInDealerProfiles } from "./marketplaceDealers";

async function seedDealer(t: ReturnType<typeof convexTestWithComponents>, opts?: { name?: string; suspended?: boolean }) {
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
  t: ReturnType<typeof convexTestWithComponents>,
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asOwner } = await seedDealer(t);
    const profile = await asOwner.query(api.marketplaceDealers.getMyProfile, { orgId });
    expect(profile).toBeNull();
  });

  test("getMyProfile throws when unauthenticated", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const { orgId } = await seedDealer(t);
    await expect(t.query(api.marketplaceDealers.getMyProfile, { orgId })).rejects.toThrow();
  });

  test("updateProfile inserts a new profile and normalizes areas/brands", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
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
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
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

describe("listOptedInDealerProfiles does not spend its limit on deleted rows", () => {
  /**
   * Inserts `count` opted-in profiles directly, marking the first
   * `deletedPrefix` of them as soft-deleted. Direct inserts because the point is
   * the read path's ordering, and the index is ascending by _creationTime — so
   * the deleted ones are exactly the rows a `.take()` reaches first.
   */
  async function seedProfiles(t: ReturnType<typeof convexTestWithComponents>, count: number, deletedPrefix: number) {
    for (let i = 0; i < count; i++) {
      const orgId = await t.run((ctx) =>
        ctx.db.insert("organizations", { name: `Dealer ${i}`, createdAt: Date.now() })
      );
      await t.run((ctx) =>
        ctx.db.insert("marketplaceDealerProfiles", {
          orgId,
          isOptedIn: true,
          isDeleted: i < deletedPrefix ? true : undefined,
          areas: [],
          brandsCarried: [],
          badges: [],
          totalResponses: 0,
          totalAccepted: 0,
          leadsUsedThisPeriod: 0,
          tier: "FREE_FOUNDING",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      );
    }
  }

  test("a limit of N returns N live dealers even when the oldest rows are deleted", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    // 4 deleted, then 3 live. Filtering after the take returned 1 of 3 live
    // dealers for a limit of 5; the other 2 were invisible to public browse,
    // affordability search and WhatsApp intake with nothing to indicate it.
    await seedProfiles(t, 7, 4);

    const profiles = await t.run((ctx) => listOptedInDealerProfiles(ctx, 5));

    expect(profiles).toHaveLength(3);
    expect(profiles.every((p) => !p.isDeleted)).toBe(true);
  });

  test("the limit still caps the result when there are more live dealers than it", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    await seedProfiles(t, 6, 0);

    const profiles = await t.run((ctx) => listOptedInDealerProfiles(ctx, 4));

    expect(profiles).toHaveLength(4);
  });
});

describe("recomputeAllDealerBadges pages across every dealer", () => {
  test("recomputes past the first batch instead of stopping at one collect", async () => {
    // convex-test only advances its scheduler when the clock moves, so a
    // `runAfter(0, ...)` continuation stays pending under real timers and the
    // assertion below would see page one only — passing for the wrong reason.
    // Same recipe as liveChat.test.ts.
    vi.useFakeTimers();
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));

    // Note what this does and does not prove. The old unbounded `.collect()`
    // handled 105 rows fine — its failure mode only appears at a budget limit no
    // test can reach. So this is not a pre-fix reproduction; it seeds past the
    // 100-row page boundary to prove the paginated version still reaches the
    // tail. It fails if the continuation is not rescheduled, which is the way
    // this rewrite would plausibly go wrong.
    const orgIds: Id<"organizations">[] = [];
    for (let i = 0; i < 105; i++) {
      const orgId = await t.run((ctx) =>
        ctx.db.insert("organizations", { name: `Dealer ${i}`, createdAt: Date.now() })
      );
      orgIds.push(orgId);
      await t.run((ctx) =>
        ctx.db.insert("marketplaceDealerProfiles", {
          orgId,
          isOptedIn: true,
          areas: [],
          brandsCarried: [],
          // Stale: computeBadges will drop FAST_RESPONSE, since there is no
          // response history to support it. Seeing it gone proves this row was
          // visited.
          badges: ["FAST_RESPONSE"],
          totalResponses: 0,
          totalAccepted: 0,
          leadsUsedThisPeriod: 0,
          tier: "FREE_FOUNDING",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      );
    }

    try {
      await t.mutation(internal.marketplaceDealers.recomputeAllDealerBadges, {});
      await t.finishAllScheduledFunctions(vi.runAllTimers);

      const stillStale = await t.run(async (ctx) => {
        const rows = await ctx.db.query("marketplaceDealerProfiles").collect();
        return rows.filter((r) => r.badges.includes("FAST_RESPONSE")).length;
      });
      expect(stillStale).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
