import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { calculateUnifiedMurabaha } from "../lib/financing";

async function seedVehicle(t: ReturnType<typeof convexTest>, orgId: Id<"organizations">) {
  return await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      make: "Toyota",
      model: "Corolla",
      year: 2022,
      mileage: 30000,
      color: "White",
      fuelType: "Petrol",
      transmission: "Automatic",
      sellingPrice: 20000,
      status: "AVAILABLE",
      createdAt: Date.now(),
    })
  );
}

async function seedFinanceCompany(t: ReturnType<typeof convexTest>, orgId: Id<"organizations">) {
  return await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId,
      name: "Test Finance Co",
      profitRate: 5.5,
      maxTermMonths: 72,
      gracePeriodMonths: 0,
      insuranceRate: 3,
      adminFees: 150,
      commission: 300,
      includesCommissionInDebt: false,
      isActive: true,
    })
  );
}

// A positive reply that needs no vehicle — used by tests exercising scoring,
// quota, routing, and lifecycle rather than the HAVE_MATCH offer path.
const CAN_SOURCE_REPLY = {
  kind: "CAN_SOURCE" as const,
  sourcingRange: { minJod: 15000, maxJod: 18000, etaDays: 14 },
};

async function seedDealerOrg(t: ReturnType<typeof convexTest>, opts?: { name?: string }) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: opts?.name ?? "Dealer Org", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `sales_${orgId}`, email: `sales_${orgId}@test.com`, name: "Sales Rep" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "SALES", permissions: ["marketplace:respond"] })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("marketplaceDealerProfiles", {
      orgId,
      isOptedIn: true,
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

async function seedRequest(
  t: ReturnType<typeof convexTest>,
  overrides?: Partial<{ status: "OPEN" | "MATCHED" | "FULFILLED" | "EXPIRED" | "SPAM"; buyerPhone: string }>
) {
  return await t.run((ctx) =>
    ctx.db.insert("marketplaceRequests", {
      status: overrides?.status ?? "MATCHED",
      buyerFirstName: "Sami",
      buyerPhone: overrides?.buyerPhone ?? "+962791234567",
      buyerCity: "Amman",
      make: "Toyota",
      model: "Corolla",
      paymentType: "CASH",
      buyerTimeframe: "ASAP",
      buyerIntent: "HOT",
      consentAcceptedAt: Date.now(),
      clientFingerprint: "fp-1",
      expiresAt: Date.now() + 100000,
      createdAt: Date.now(),
    })
  );
}

async function seedMatch(
  t: ReturnType<typeof convexTest>,
  requestId: Id<"marketplaceRequests">,
  orgId: Id<"organizations">,
  overrides?: Partial<{ matchedAt: number; notifiedAt: number }>
) {
  return await t.run((ctx) =>
    ctx.db.insert("marketplaceRequestMatches", {
      requestId,
      orgId,
      matchedAt: overrides?.matchedAt ?? Date.now(),
      notifiedAt: overrides?.notifiedAt,
    })
  );
}

describe("respond", () => {
  test("records the response but creates NO customer or lead (lead now waits for buyer consent)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asSales } = await seedDealerOrg(t);
    const requestId = await seedRequest(t);
    await seedMatch(t, requestId, orgId);

    const { responseId } = await asSales.mutation(api.marketplaceResponses.respond, {
      orgId,
      requestId,
      kind: "CAN_SOURCE",
      sourcingRange: { minJod: 15000, maxJod: 18000, etaDays: 14 },
      note: "Can source within two weeks",
    });

    const response = await t.run((ctx) => ctx.db.get(responseId));
    expect(response).toMatchObject({ orgId, requestId, kind: "CAN_SOURCE" });

    const customers = await t.run((ctx) => ctx.db.query("customers").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect());
    expect(customers).toHaveLength(0);
    const leads = await t.run((ctx) => ctx.db.query("leads").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect());
    expect(leads).toHaveLength(0);
  });

  test("computes the finance offer from the dealer's finance company + down/term — dealer never types the installment", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asSales } = await seedDealerOrg(t);
    const requestId = await seedRequest(t);
    await seedMatch(t, requestId, orgId);
    const vehicleId = await seedVehicle(t, orgId);
    const financeCompanyId = await seedFinanceCompany(t, orgId);

    const { responseId } = await asSales.mutation(api.marketplaceResponses.respond, {
      orgId,
      requestId,
      kind: "HAVE_MATCH",
      vehicleId,
      offerPriceJod: 20000,
      financeCompanyId,
      downPayment: 4000,
      termMonths: 60,
    });

    const response = await t.run((ctx) => ctx.db.get(responseId));
    const expected = calculateUnifiedMurabaha({
      vehiclePrice: 20000,
      downPayment: 4000,
      commission: 300,
      processingFees: 150,
      annualProfitRate: 5.5,
      annualInsuranceRate: 3,
      termMonths: 60,
      gracePeriodMonths: 0,
      includesCommissionInDebt: false,
    });
    expect(response?.financeOffer).toMatchObject({
      vehiclePrice: 20000,
      downPayment: 4000,
      termMonths: 60,
      financeCompanyId,
    });
    expect(response?.financeOffer?.monthlyInstallment).toBeCloseTo(Math.round(expected.monthlyInstallment), 5);
  });

  test("moves the request to OFFERS_RECEIVED on a positive reply, never FULFILLED", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asSales } = await seedDealerOrg(t);
    const requestId = await seedRequest(t);
    await seedMatch(t, requestId, orgId);

    await asSales.mutation(api.marketplaceResponses.respond, {
      orgId,
      requestId,
      kind: "CAN_SOURCE",
      sourcingRange: { minJod: 15000, maxJod: 18000, etaDays: 10 },
    });

    expect((await t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("OFFERS_RECEIVED");
  });

  test("requires a vehicle for HAVE_MATCH and a sourcing range for CAN_SOURCE", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asSales } = await seedDealerOrg(t);
    const requestId = await seedRequest(t);
    await seedMatch(t, requestId, orgId);

    await expect(
      asSales.mutation(api.marketplaceResponses.respond, { orgId, requestId, kind: "HAVE_MATCH" })
    ).rejects.toThrow(/vehicle/i);

    await expect(
      asSales.mutation(api.marketplaceResponses.respond, { orgId, requestId, kind: "CAN_SOURCE" })
    ).rejects.toThrow(/range/i);
  });

  test("writes a response.sent marketplace event", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asSales } = await seedDealerOrg(t);
    const requestId = await seedRequest(t);
    await seedMatch(t, requestId, orgId);

    await asSales.mutation(api.marketplaceResponses.respond, {
      orgId,
      requestId,
      kind: "CAN_SOURCE",
      sourcingRange: { minJod: 15000, maxJod: 18000, etaDays: 7 },
    });

    const events = await t.run((ctx) =>
      ctx.db.query("marketplaceEvents").withIndex("by_request", (q) => q.eq("requestId", requestId)).collect()
    );
    expect(events.some((e) => e.event === "response.sent")).toBe(true);
  });

  test("updates responseScore using notifiedAt, falling back to matchedAt", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asSales } = await seedDealerOrg(t);
    const requestId = await seedRequest(t);
    const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
    await seedMatch(t, requestId, orgId, { matchedAt: tenMinutesAgo - 60000, notifiedAt: tenMinutesAgo });

    await asSales.mutation(api.marketplaceResponses.respond, { orgId, requestId, ...CAN_SOURCE_REPLY });

    const profile = await t.run((ctx) =>
      ctx.db.query("marketplaceDealerProfiles").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()
    );
    expect(profile?.totalResponses).toBe(1);
    expect(profile?.avgResponseMinutes).toBeGreaterThanOrEqual(9.9);
    expect(profile?.avgResponseMinutes).toBeLessThanOrEqual(10.1);
  });

  test("awards FAST_RESPONSE once enough quick responses are recorded (Phase 60)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asSales } = await seedDealerOrg(t);

    for (let i = 0; i < 3; i++) {
      const requestId = await seedRequest(t, { buyerPhone: `+96279900000${i}` });
      const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
      await seedMatch(t, requestId, orgId, { matchedAt: fiveMinutesAgo - 60000, notifiedAt: fiveMinutesAgo });
      await asSales.mutation(api.marketplaceResponses.respond, { orgId, requestId, ...CAN_SOURCE_REPLY });
    }

    const profile = await t.run((ctx) =>
      ctx.db.query("marketplaceDealerProfiles").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()
    );
    expect(profile?.totalResponses).toBe(3);
    expect(profile?.badges).toContain("FAST_RESPONSE");
  });

  test("moves to OFFERS_RECEIVED on a positive reply but stays MATCHED on NOT_AVAILABLE", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId: orgA, asSales: asSalesA } = await seedDealerOrg(t, { name: "Dealer A" });
    const { orgId: orgB, asSales: asSalesB } = await seedDealerOrg(t, { name: "Dealer B" });
    const requestId = await seedRequest(t);
    await seedMatch(t, requestId, orgA);
    await seedMatch(t, requestId, orgB);

    await asSalesA.mutation(api.marketplaceResponses.respond, { orgId: orgA, requestId, kind: "NOT_AVAILABLE" });
    expect((await t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("MATCHED");

    await asSalesB.mutation(api.marketplaceResponses.respond, { orgId: orgB, requestId, ...CAN_SOURCE_REPLY });
    expect((await t.run((ctx) => ctx.db.get(requestId)))?.status).toBe("OFFERS_RECEIVED");
  });

  test("rejects a response from an org the request was never routed to", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asSales } = await seedDealerOrg(t);
    const requestId = await seedRequest(t);
    // Deliberately no marketplaceRequestMatches row for this org.

    await expect(
      asSales.mutation(api.marketplaceResponses.respond, { orgId, requestId, kind: "HAVE_MATCH" })
    ).rejects.toThrow(/not routed/);
  });

  test("rejects a response to a SPAM request", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asSales } = await seedDealerOrg(t);
    const requestId = await seedRequest(t, { status: "SPAM" });
    await seedMatch(t, requestId, orgId);

    await expect(
      asSales.mutation(api.marketplaceResponses.respond, { orgId, requestId, kind: "HAVE_MATCH" })
    ).rejects.toThrow(/no longer open/);
  });

  test("rejects a response to an EXPIRED request", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asSales } = await seedDealerOrg(t);
    const requestId = await seedRequest(t, { status: "EXPIRED" });
    await seedMatch(t, requestId, orgId);

    await expect(
      asSales.mutation(api.marketplaceResponses.respond, { orgId, requestId, kind: "HAVE_MATCH" })
    ).rejects.toThrow(/no longer open/);
  });

  test("rejects a negative offer price", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asSales } = await seedDealerOrg(t);
    const requestId = await seedRequest(t);
    await seedMatch(t, requestId, orgId);

    const vehicleId = await seedVehicle(t, orgId);
    await expect(
      asSales.mutation(api.marketplaceResponses.respond, {
        orgId,
        requestId,
        kind: "HAVE_MATCH",
        vehicleId,
        offerPriceJod: -100,
      })
    ).rejects.toThrow(/non-negative/);
  });

  test("blocks a response once a FREE_FOUNDING dealer's window has expired (Phase 63)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asSales } = await seedDealerOrg(t);
    const requestId = await seedRequest(t);
    await seedMatch(t, requestId, orgId);
    await t.run((ctx) =>
      ctx.db
        .query("marketplaceDealerProfiles")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .unique()
        .then((profile) => ctx.db.patch(profile!._id, { foundingWindowEndsAt: Date.now() - 1000 }))
    );

    await expect(
      asSales.mutation(api.marketplaceResponses.respond, { orgId, requestId, ...CAN_SOURCE_REPLY })
    ).rejects.toThrow(/Upgrade required/);
  });

  test("blocks a response once a LEAD_PACKAGE dealer's quota is exhausted (Phase 63)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asSales } = await seedDealerOrg(t);
    const requestId = await seedRequest(t);
    await seedMatch(t, requestId, orgId);
    await t.run((ctx) =>
      ctx.db
        .query("marketplaceDealerProfiles")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .unique()
        .then((profile) =>
          ctx.db.patch(profile!._id, { tier: "LEAD_PACKAGE", leadQuota: 1, leadsUsedThisPeriod: 1, leadPeriodStartedAt: Date.now() })
        )
    );

    await expect(
      asSales.mutation(api.marketplaceResponses.respond, { orgId, requestId, ...CAN_SOURCE_REPLY })
    ).rejects.toThrow(/Upgrade required/);
  });

  test("consumes one lead from a LEAD_PACKAGE dealer's quota on a successful response (Phase 63)", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asSales } = await seedDealerOrg(t);
    const requestId = await seedRequest(t);
    await seedMatch(t, requestId, orgId);
    await t.run((ctx) =>
      ctx.db
        .query("marketplaceDealerProfiles")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .unique()
        .then((profile) =>
          ctx.db.patch(profile!._id, { tier: "LEAD_PACKAGE", leadQuota: 5, leadsUsedThisPeriod: 0, leadPeriodStartedAt: Date.now() })
        )
    );

    await asSales.mutation(api.marketplaceResponses.respond, { orgId, requestId, ...CAN_SOURCE_REPLY });

    const profile = await t.run((ctx) =>
      ctx.db.query("marketplaceDealerProfiles").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()
    );
    expect(profile?.leadsUsedThisPeriod).toBe(1);
  });

  test("does not consume quota for a FEATURED dealer and allows unlimited responses", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId, asSales } = await seedDealerOrg(t);
    await t.run((ctx) =>
      ctx.db
        .query("marketplaceDealerProfiles")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .unique()
        .then((profile) => ctx.db.patch(profile!._id, { tier: "FEATURED" }))
    );

    for (let i = 0; i < 3; i++) {
      const requestId = await seedRequest(t, { buyerPhone: `+96279900111${i}` });
      await seedMatch(t, requestId, orgId);
      await asSales.mutation(api.marketplaceResponses.respond, { orgId, requestId, ...CAN_SOURCE_REPLY });
    }

    const profile = await t.run((ctx) =>
      ctx.db.query("marketplaceDealerProfiles").withIndex("by_org", (q) => q.eq("orgId", orgId)).unique()
    );
    expect(profile?.leadsUsedThisPeriod).toBe(0);
  });
});

describe("listForOrg", () => {
  test("only returns requests matched to the caller's org, with their own latest response", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId: orgA, asSales: asSalesA } = await seedDealerOrg(t, { name: "Dealer A" });
    const { orgId: orgB } = await seedDealerOrg(t, { name: "Dealer B" });
    const requestForA = await seedRequest(t);
    const requestForB = await seedRequest(t, { buyerPhone: "+962799999999" });
    await seedMatch(t, requestForA, orgA);
    await seedMatch(t, requestForB, orgB);

    const listBeforeResponse = await asSalesA.query(api.marketplaceResponses.listForOrg, { orgId: orgA });
    expect(listBeforeResponse).toHaveLength(1);
    expect(listBeforeResponse[0].requestId).toBe(requestForA);
    expect(listBeforeResponse[0].latestResponse).toBeNull();

    await asSalesA.mutation(api.marketplaceResponses.respond, { orgId: orgA, requestId: requestForA, ...CAN_SOURCE_REPLY });

    const listAfterResponse = await asSalesA.query(api.marketplaceResponses.listForOrg, { orgId: orgA });
    expect(listAfterResponse[0].latestResponse).toMatchObject({ kind: "CAN_SOURCE" });
  });
});

describe("getStatusForBuyer respondedCount", () => {
  test("counts distinct responding orgs excluding NOT_AVAILABLE", async () => {
    const t = convexTest(schema, import.meta.glob("./**/*.ts"));
    const { orgId: orgA, asSales: asSalesA } = await seedDealerOrg(t, { name: "Dealer A" });
    const { orgId: orgB, asSales: asSalesB } = await seedDealerOrg(t, { name: "Dealer B" });
    const requestId = await seedRequest(t);
    await seedMatch(t, requestId, orgA);
    await seedMatch(t, requestId, orgB);

    await asSalesA.mutation(api.marketplaceResponses.respond, { orgId: orgA, requestId, kind: "NOT_AVAILABLE" });
    await asSalesB.mutation(api.marketplaceResponses.respond, { orgId: orgB, requestId, ...CAN_SOURCE_REPLY });

    const status = await t.query(api.marketplaceRequests.getStatusForBuyer, {
      requestId,
      buyerPhone: "+962791234567",
    });
    expect(status).toMatchObject({ matchedCount: 2, respondedCount: 1 });
  });
});
