/**
 * The below-minimum-profit approval workflow, enforced on the backend.
 *
 * `CLAUDE.md` documents this as one of three approval workflows, but until now
 * it lived only in the sales wizard: `convex/sales.ts` and `convex/quotes.ts`
 * contained no reference to `profitApprovalRequests` or `minimumProfit`, so a
 * direct API call, an older client, or the mobile app could write a
 * below-minimum financed quote and carry it through to a completed sale with no
 * approval record.
 *
 * Every case here drives the raw Convex mutations, never the UI.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { registerHandover } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { ALL_PERMISSIONS } from "./utils/permissions";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

async function seedOrg(t: any, seed: string, minimumProfit: number | undefined) {
  const ids = await t.run(async (ctx: any) => {
    const orgId = await ctx.db.insert("organizations", {
      name: `Profit ${seed}`,
      createdAt: Date.now(),
    });
    const userId = await ctx.db.insert("users", {
      clerkId: `profit_${seed}`,
      email: `${seed}@profit.example.com`,
      name: "Owner",
    });
    const roleId = await ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ALL_PERMISSIONS,
      isSystemOwnerRole: true,
    });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    // A second member so the maker-checker guard on application approval has a
    // distinct actor to work with.
    const approverId = await ctx.db.insert("users", {
      clerkId: `profit_approver_${seed}`,
      email: `${seed}-approver@profit.example.com`,
      name: "Approver",
    });
    await ctx.db.insert("memberships", { orgId, userId: approverId, roleId });
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId,
      vin: `VIN-${seed}`,
      make: "Toyota",
      model: "Camry",
      year: 2024,
      color: "White",
      fuelType: "Petrol",
      transmission: "Automatic",
      mileage: 100,
      sellingPrice: 20000,
      minimumProfit,
      status: "AVAILABLE",
    });
    const customerId = await ctx.db.insert("customers", {
      orgId,
      firstName: "Sam",
      lastName: "Buyer",
      email: `${seed}-buyer@example.com`,
    });
    const companyId = await ctx.db.insert("financeCompanies", {
      orgId,
      name: "Finance Co",
      profitRate: 5,
      maxTermMonths: 72,
      gracePeriodMonths: 3,
      isActive: true,
    });
    return { orgId, userId, approverId, vehicleId, customerId, companyId };
  });
  return {
    ...ids,
    asOwner: t.withIdentity({ subject: `profit_${seed}` }),
    asApprover: t.withIdentity({ subject: `profit_approver_${seed}` }),
  };
}

function financedQuote(ids: any, desiredProfit: number | undefined) {
  return {
    orgId: ids.orgId,
    customerId: ids.customerId,
    vehicleId: ids.vehicleId,
    companyId: ids.companyId,
    mode: "CONFIGURED_FINANCE_COMPANY" as const,
    vehiclePrice: 20000 + (desiredProfit ?? 0),
    ...(desiredProfit === undefined ? {} : { desiredProfit }),
    downPayment: 2000,
    termMonths: 60,
  };
}

describe("quotes.saveQuote enforces the minimum-profit approval", () => {
  test("rejects a financed quote below the vehicle's minimum profit", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "below", 1000);

    await expect(
      ids.asOwner.mutation(api.quotes.saveQuote, financedQuote(ids, 400))
    ).rejects.toThrow(/below the minimum profit/i);
  });

  test("rejects a financed quote that omits the margin entirely", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "omitted", 1000);

    // An older client, or an attacker, simply not sending the field must not be
    // read as "no minimum applies" — absent is zero, which is below any minimum.
    await expect(
      ids.asOwner.mutation(api.quotes.saveQuote, financedQuote(ids, undefined))
    ).rejects.toThrow(/below the minimum profit/i);
  });

  test("rejects a financed quote whose margin is NaN", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "nan", 1000);

    // NaN fails every comparison, so a `desiredProfit < minimumProfit` guard
    // would read false and let it through.
    await expect(
      ids.asOwner.mutation(api.quotes.saveQuote, financedQuote(ids, NaN))
    ).rejects.toThrow(/below the minimum profit/i);
  });

  test("accepts a financed quote at or above the minimum profit", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "atmin", 1000);

    const quoteId = await ids.asOwner.mutation(api.quotes.saveQuote, financedQuote(ids, 1000));
    const quote: any = await t.run((ctx: any) => ctx.db.get(quoteId));
    expect(quote.desiredProfit).toBe(1000);
  });

  test("accepts a below-minimum quote once a manager has approved it", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "approved", 1000);

    await ids.asOwner.mutation(api.approvals.requestProfitApproval, {
      orgId: ids.orgId,
      vehicleId: ids.vehicleId,
      requestedProfit: 400,
      minimumProfit: 1000,
    });
    const pending: any = await ids.asOwner.query(api.approvals.checkPendingApproval, {
      orgId: ids.orgId,
      vehicleId: ids.vehicleId,
    });
    await ids.asOwner.mutation(api.approvals.respondToApproval, {
      orgId: ids.orgId,
      requestId: pending._id,
      status: "APPROVED",
    });

    const quoteId = await ids.asOwner.mutation(api.quotes.saveQuote, financedQuote(ids, 400));
    expect(quoteId).toBeTruthy();
  });

  test("an approval does not authorise a deeper discount than the one approved", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "deeper", 1000);

    await ids.asOwner.mutation(api.approvals.requestProfitApproval, {
      orgId: ids.orgId,
      vehicleId: ids.vehicleId,
      requestedProfit: 400,
      minimumProfit: 1000,
    });
    const pending: any = await ids.asOwner.query(api.approvals.checkPendingApproval, {
      orgId: ids.orgId,
      vehicleId: ids.vehicleId,
    });
    await ids.asOwner.mutation(api.approvals.respondToApproval, {
      orgId: ids.orgId,
      requestId: pending._id,
      status: "APPROVED",
    });

    // The manager saw 400; 100 is a different, worse deal.
    await expect(
      ids.asOwner.mutation(api.quotes.saveQuote, financedQuote(ids, 100))
    ).rejects.toThrow(/below the minimum profit/i);
  });

  test("a REJECTED request does not unblock the quote", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "rejected", 1000);

    await ids.asOwner.mutation(api.approvals.requestProfitApproval, {
      orgId: ids.orgId,
      vehicleId: ids.vehicleId,
      requestedProfit: 400,
      minimumProfit: 1000,
    });
    const pending: any = await ids.asOwner.query(api.approvals.checkPendingApproval, {
      orgId: ids.orgId,
      vehicleId: ids.vehicleId,
    });
    await ids.asOwner.mutation(api.approvals.respondToApproval, {
      orgId: ids.orgId,
      requestId: pending._id,
      status: "REJECTED",
    });

    await expect(
      ids.asOwner.mutation(api.quotes.saveQuote, financedQuote(ids, 400))
    ).rejects.toThrow(/below the minimum profit/i);
  });

  test("another org's approval for the same vehicle id does not unblock the quote", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "foreign", 1000);

    // A stray APPROVED row carrying a different orgId must be ignored — the
    // approval lookup enters by vehicle, so the org check is what scopes it.
    await t.run(async (ctx: any) => {
      const otherOrgId = await ctx.db.insert("organizations", {
        name: "Other",
        createdAt: Date.now(),
      });
      await ctx.db.insert("profitApprovalRequests", {
        orgId: otherOrgId,
        vehicleId: ids.vehicleId,
        requestedProfit: 0,
        minimumProfit: 1000,
        salespersonId: ids.userId,
        status: "APPROVED",
        createdAt: Date.now(),
      });
    });

    await expect(
      ids.asOwner.mutation(api.quotes.saveQuote, financedQuote(ids, 400))
    ).rejects.toThrow(/below the minimum profit/i);
  });

  test("a cash quote is exempt — the minimum applies to financed deals only", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "cash", 1000);

    const quoteId = await ids.asOwner.mutation(api.quotes.saveQuote, {
      orgId: ids.orgId,
      customerId: ids.customerId,
      vehicleId: ids.vehicleId,
      mode: "CASH",
      vehiclePrice: 20000,
      desiredProfit: 0,
      downPayment: 2000,
      termMonths: 0,
    });
    expect(quoteId).toBeTruthy();
  });

  test("a vehicle with no minimum profit set is unaffected", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "nomin", undefined);

    const quoteId = await ids.asOwner.mutation(api.quotes.saveQuote, financedQuote(ids, 0));
    expect(quoteId).toBeTruthy();
  });
});

describe("applications.finalizeDeal re-verifies at the commit point", () => {
  /** Drives a financed quote all the way to the point just before finalization. */
  async function readyToFinalize(t: any, ids: any, desiredProfit: number) {
    const quoteId = await ids.asOwner.mutation(api.quotes.saveQuote, financedQuote(ids, desiredProfit));
    const applicationId = await ids.asOwner.mutation(api.applications.createFromQuote, {
      orgId: ids.orgId,
      quoteId,
    });
    await ids.asOwner.mutation(api.applications.updateStatus, {
      orgId: ids.orgId,
      applicationId,
      status: "UNDER_REVIEW",
    });
    await ids.asApprover.mutation(api.applications.updateStatus, {
      orgId: ids.orgId,
      applicationId,
      status: "APPROVED",
    });
    await registerHandover(ids.asOwner, api, ids.orgId, applicationId);
    await ids.asOwner.mutation(api.applications.registerExpectedPayment, {
      orgId: ids.orgId,
      applicationId,
      method: "CASH",
      expectedDate: Date.now(),
    });
    return { quoteId, applicationId };
  }

  test("blocks finalization when the minimum was raised after the quote was written", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "raised", 1000);
    const { applicationId } = await readyToFinalize(t, ids, 1000);

    // Quote-time approval is not enough on its own: the margin has to still
    // clear the minimum when the sale is actually committed.
    await t.run((ctx: any) => ctx.db.patch(ids.vehicleId, { minimumProfit: 5000 }));

    await expect(
      ids.asOwner.mutation(api.applications.finalizeDeal, { orgId: ids.orgId, applicationId })
    ).rejects.toThrow(/below the minimum profit/i);

    const sales = await t.run((ctx: any) =>
      ctx.db.query("sales").withIndex("by_org", (q: any) => q.eq("orgId", ids.orgId)).collect()
    );
    expect(sales).toHaveLength(0);
  });

  test("finalizes normally when the margin still clears the minimum", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "clears", 1000);
    const { applicationId } = await readyToFinalize(t, ids, 1500);

    const saleId = await ids.asOwner.mutation(api.applications.finalizeDeal, {
      orgId: ids.orgId,
      applicationId,
    });
    expect(saleId).toBeTruthy();
  });

  test("lets a quote written before the margin field existed finalize", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "legacy", 1000);
    const { quoteId, applicationId } = await readyToFinalize(t, ids, 1000);

    // Simulate a quote from before this deploy: no margin recorded, so there is
    // nothing to re-check. In-flight deals must not be stranded.
    await t.run((ctx: any) => ctx.db.patch(quoteId, { desiredProfit: undefined }));
    await t.run((ctx: any) => ctx.db.patch(ids.vehicleId, { minimumProfit: 5000 }));

    const saleId = await ids.asOwner.mutation(api.applications.finalizeDeal, {
      orgId: ids.orgId,
      applicationId,
    });
    expect(saleId).toBeTruthy();
  });
});
