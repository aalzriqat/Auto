import { convexTest } from "convex-test";
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { computeBuyerIntent, dealerMatchesRequest } from "./marketplaceRequests";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
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
  t: ReturnType<typeof convexTest>,
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
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));

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

  test("rejects submission without consent", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    await expect(
      t.action(api.marketplaceRequests.submitRequest, { ...baseRequestArgs, consentAccepted: false })
    ).rejects.toThrow();
  });

  test("excludes suspended orgs even if opted in and matching", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
    await seedDealer(t, { name: "Suspended Dealer", areas: ["Amman"], brandsCarried: [], suspended: true });

    const result = await t.action(api.marketplaceRequests.submitRequest, baseRequestArgs);
    expect(result.matchedCount).toBe(0);

    const request = await t.run((ctx) => ctx.db.get(result.requestId));
    expect(request?.status).toBe("OPEN");
  });
});

describe("getStatusForBuyer", () => {
  test("returns status/count for the correct phone, null otherwise", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
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
});

describe("expireStaleRequests", () => {
  test("expires OPEN/MATCHED requests past expiresAt, leaves fresh ones alone", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.*s"));
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
});
