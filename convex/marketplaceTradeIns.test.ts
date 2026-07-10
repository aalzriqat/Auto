import { convexTest } from "convex-test";
import { expect, test, describe, beforeEach, afterEach, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";

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

async function seedDealer(t: ReturnType<typeof convexTest>, opts?: { isOptedIn?: boolean; suspended?: boolean }) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Dealer Org", createdAt: Date.now(), suspended: opts?.suspended })
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
      isOptedIn: opts?.isOptedIn ?? true,
      areas: [],
      brandsCarried: [],
      badges: [],
      totalResponses: 0,
      totalAccepted: 0,
      tier: "FREE_FOUNDING",
      leadsUsedThisPeriod: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  );
  return { orgId, userId, asSales: t.withIdentity({ subject: `sales_${orgId}` }) };
}

const baseTradeInMutationArgs = {
  buyerFirstName: "Lina",
  buyerPhone: "+962791234567",
  currentMake: "Hyundai",
  currentModel: "Elantra",
  currentYear: 2018,
  currentMileage: 80000,
  condition: "GOOD" as const,
  consentAccepted: true,
  clientFingerprint: "fp-tradein-1",
};
const baseTradeInArgs = { ...baseTradeInMutationArgs, turnstileToken: "valid-token" };

describe("submitTradeInRequest", () => {
  test("creates a PENDING request and notifies dealers with marketplace:respond", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, userId } = await seedDealer(t);

    const result = await t.action(api.marketplaceTradeIns.submitTradeInRequest, { ...baseTradeInArgs, orgId });
    expect(result.tradeInRequestId).toBeDefined();

    const tradeIn = await t.run((ctx) => ctx.db.get(result.tradeInRequestId));
    expect(tradeIn).toMatchObject({ orgId, status: "PENDING", buyerFirstName: "Lina", buyerPhone: "+962791234567" });

    const notifications = await t.run((ctx) =>
      ctx.db.query("notifications").withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId)).collect()
    );
    expect(notifications.some((n) => n.type === "marketplace.tradein_submitted")).toBe(true);
  });

  test("rejects a request to an org that isn't opted in", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId } = await seedDealer(t, { isOptedIn: false });

    await expect(
      t.action(api.marketplaceTradeIns.submitTradeInRequest, { ...baseTradeInArgs, orgId })
    ).rejects.toThrow();
  });

  test("rejects a request to a suspended org", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId } = await seedDealer(t, { suspended: true });

    await expect(
      t.action(api.marketplaceTradeIns.submitTradeInRequest, { ...baseTradeInArgs, orgId })
    ).rejects.toThrow();
  });
});

describe("listForOrg / makeOffer", () => {
  test("listForOrg rejects a caller without marketplace:respond and scopes to the org", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asSales } = await seedDealer(t);
    const other = await seedDealer(t);

    await t.mutation(internal.marketplaceTradeIns.createTradeInRequest, { ...baseTradeInMutationArgs, orgId });
    await t.mutation(internal.marketplaceTradeIns.createTradeInRequest, { ...baseTradeInMutationArgs, orgId: other.orgId });

    await expect(t.query(api.marketplaceTradeIns.listForOrg, { orgId })).rejects.toThrow();

    const rows = await asSales.query(api.marketplaceTradeIns.listForOrg, { orgId });
    expect(rows).toHaveLength(1);
    expect(rows[0].orgId).toBe(orgId);
  });

  test("makeOffer moves status to OFFERED and rejects re-offering or a negative amount", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asSales } = await seedDealer(t);
    const { tradeInRequestId } = await t.mutation(internal.marketplaceTradeIns.createTradeInRequest, {
      ...baseTradeInMutationArgs,
      orgId,
    });

    await expect(
      asSales.mutation(api.marketplaceTradeIns.makeOffer, { orgId, tradeInRequestId, offerAmountJod: -100 })
    ).rejects.toThrow(/non-negative/);

    await asSales.mutation(api.marketplaceTradeIns.makeOffer, { orgId, tradeInRequestId, offerAmountJod: 3500 });
    const tradeIn = await t.run((ctx) => ctx.db.get(tradeInRequestId));
    expect(tradeIn).toMatchObject({ status: "OFFERED", offerAmountJod: 3500 });

    await expect(
      asSales.mutation(api.marketplaceTradeIns.makeOffer, { orgId, tradeInRequestId, offerAmountJod: 4000 })
    ).rejects.toThrow(/already has an offer/);
  });
});

describe("getStatusForBuyer / acceptOffer / declineOffer", () => {
  test("getStatusForBuyer is phone-gated and returns null for a wrong number", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId } = await seedDealer(t);
    const { tradeInRequestId } = await t.mutation(internal.marketplaceTradeIns.createTradeInRequest, {
      ...baseTradeInMutationArgs,
      orgId,
    });

    const wrongPhone = await t.query(api.marketplaceTradeIns.getStatusForBuyer, {
      tradeInRequestId,
      buyerPhone: "+962700000000",
    });
    expect(wrongPhone).toBeNull();

    const rightPhone = await t.query(api.marketplaceTradeIns.getStatusForBuyer, {
      tradeInRequestId,
      buyerPhone: baseTradeInArgs.buyerPhone,
    });
    expect(rightPhone).toMatchObject({ status: "PENDING", offerAmountJod: null });
  });

  test("acceptOffer creates an attributed lead and rejects when there's no active offer", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asSales } = await seedDealer(t);
    const { tradeInRequestId } = await t.mutation(internal.marketplaceTradeIns.createTradeInRequest, {
      ...baseTradeInMutationArgs,
      orgId,
    });

    await expect(
      t.mutation(api.marketplaceTradeIns.acceptOffer, { tradeInRequestId, buyerPhone: baseTradeInArgs.buyerPhone })
    ).rejects.toThrow(/no active offer/);

    await asSales.mutation(api.marketplaceTradeIns.makeOffer, { orgId, tradeInRequestId, offerAmountJod: 3500 });

    const { leadId } = await t.mutation(api.marketplaceTradeIns.acceptOffer, {
      tradeInRequestId,
      buyerPhone: baseTradeInArgs.buyerPhone,
    });
    const lead = await t.run((ctx) => ctx.db.get(leadId));
    expect(lead).toMatchObject({ orgId, sourceChannel: "marketplace", stage: "NEW" });

    const tradeIn = await t.run((ctx) => ctx.db.get(tradeInRequestId));
    expect(tradeIn).toMatchObject({ status: "ACCEPTED", leadId });

    const customers = await t.run((ctx) => ctx.db.query("customers").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect());
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({ firstName: "Lina", phone: baseTradeInArgs.buyerPhone });
  });

  test("declineOffer sets status to DECLINED", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asSales } = await seedDealer(t);
    const { tradeInRequestId } = await t.mutation(internal.marketplaceTradeIns.createTradeInRequest, {
      ...baseTradeInMutationArgs,
      orgId,
    });
    await asSales.mutation(api.marketplaceTradeIns.makeOffer, { orgId, tradeInRequestId, offerAmountJod: 3500 });

    await t.mutation(api.marketplaceTradeIns.declineOffer, { tradeInRequestId, buyerPhone: baseTradeInArgs.buyerPhone });
    const tradeIn = await t.run((ctx) => ctx.db.get(tradeInRequestId));
    expect(tradeIn?.status).toBe("DECLINED");
  });
});
