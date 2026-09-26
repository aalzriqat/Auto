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
    const customerStatusId = await ctx.db.insert("orgCustomerStatuses", {
      orgId,
      label: "Eligible",
      isActive: true,
      order: 1,
    });
    const companyId = await ctx.db.insert("financeCompanies", {
      orgId,
      name: "Finance Co",
      profitRate: 5,
      maxTermMonths: 72,
      gracePeriodMonths: 3,
      isActive: true,
      // The quotation solver refuses a company with no LTV, and the application
      // freezes the company rules at creation.
      defaultLtvPercent: 100,
      adminFees: 0,
    });
    return { orgId, userId, approverId, vehicleId, customerId, customerStatusId, companyId };
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
    customerEligibilityStatusIds: [ids.customerStatusId],
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
    ).rejects.toThrow(/finite number/i);
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
    // What the settlement posts from. Recorded before handover, which seals the
    // approved amount. These fixtures previously finalized on the legacy
    // no-quotation carve-out, so the deal posted from the customer principal.
    const vehiclePrice = 20000 + desiredProfit;
    await ids.asOwner.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: ids.orgId,
      applicationId,
      submittedQuotationMinor: vehiclePrice * 1000,
      source: "MANUAL_ENTRY",
    });
    await ids.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: ids.orgId,
      applicationId,
      approvedAmountMinor: vehiclePrice * 1000,
      basis: "MANUAL",
      notes: "Approved at the quotation.",
    });
    await registerHandover(ids.asOwner, api, ids.orgId, applicationId);
    await ids.asOwner.mutation(api.applications.registerExpectedPayment, {
      orgId: ids.orgId,
      applicationId,
      method: "CASH",
      expectedDate: Date.now(),
    });
    await ids.asOwner.mutation(api.financeDealCosts.recordLegalInvoice, {
      orgId: ids.orgId,
      applicationId,
      legalInvoiceAmountMinor: vehiclePrice * 1000,
      legalInvoiceNumber: `INV-${applicationId}`,
      legalInvoiceDate: Date.now(),
      issuedTo: "FINANCE_COMPANY",
    });
    const feeId = await ids.asOwner.mutation(api.financeDealCosts.recordDealFee, { expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(),
      orgId: ids.orgId,
      applicationId,
      feeType: "OTHER_CLOSING_EXPENSE",
      paidBy: "DEALER",
      paidTo: "OTHER",
      accountingTreatment: "SELLING_EXPENSE",
      deductedFromSettlement: false,
      actualAmountMinor: 0,
      description: "The dealership bore no closing costs on this deal.",
    });
    await ids.asOwner.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: ids.orgId, feeId, notes: "Nothing to match.",
    });
    await ids.asOwner.mutation(api.financeDealCosts.classifyDealAccounting, {
      orgId: ids.orgId,
      applicationId,
      notes: "Invoice and settlement advice on file.",
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
      ids.asOwner.mutation(api.applications.finalizeDeal, { idempotencyKey: crypto.randomUUID(), orgId: ids.orgId, applicationId })
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

    const saleId = await ids.asOwner.mutation(api.applications.finalizeDeal, { idempotencyKey: crypto.randomUUID(),
      orgId: ids.orgId,
      applicationId,
    });
    expect(saleId).toBeTruthy();
  });

  // SCRUM-260 replaced the exemption this test used to assert: a quote with no
  // recorded margin let a below-minimum deal finalize. The server now derives
  // the margin from the price the sale persists, so there is always one to
  // check. (Census, prod 2026-09-27: no in-flight deal could be stranded.)
  test("a quote written before the margin field existed is still checked at finalization", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "legacy", 1000);
    const { quoteId, applicationId } = await readyToFinalize(t, ids, 1000);

    await t.run((ctx: any) => ctx.db.patch(quoteId, { desiredProfit: undefined }));
    await t.run((ctx: any) => ctx.db.patch(ids.vehicleId, { minimumProfit: 5000 }));

    await expect(
      ids.asOwner.mutation(api.applications.finalizeDeal, { idempotencyKey: crypto.randomUUID(), orgId: ids.orgId, applicationId })
    ).rejects.toThrow(/below the minimum profit/i);
    expect(await salesOf(t, ids)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SCRUM-260: the margin is the server's, and an approval covers exactly the
// priced state the manager saw. Seeded list price 20,000; minimum 1,000.
// ---------------------------------------------------------------------------

function salesOf(t: any, ids: any) {
  return t.run((ctx: any) =>
    ctx.db.query("sales").withIndex("by_org", (q: any) => q.eq("orgId", ids.orgId)).collect()
  );
}

/** Requests with the pre-SCRUM-260 argument shape, then approves the newest request. */
async function approveLegacyRequest(t: any, ids: any, requestedProfit: number) {
  await ids.asOwner.mutation(api.approvals.requestProfitApproval, {
    orgId: ids.orgId,
    vehicleId: ids.vehicleId,
    requestedProfit,
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
  return pending._id;
}

function directFinancedSale(ids: any, salePrice: number) {
  return {
    idempotencyKey: crypto.randomUUID(),
    orgId: ids.orgId,
    vehicleId: ids.vehicleId,
    customerId: ids.customerId,
    salespersonId: ids.userId,
    salePrice,
    saleDate: Date.now(),
    financingType: "FINANCED" as const,
  };
}

describe("SCRUM-260: the server derives the margin from the price", () => {
  test("a claimed desiredProfit cannot clear a price below the list price", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "claimed", 1000);

    // The wizard folds an editable base into the price. Base 19,000 + claimed
    // 5,000 would be 24,000 — but the caller sends 19,500 and claims 5,000.
    await expect(
      ids.asOwner.mutation(api.quotes.saveQuote, { ...financedQuote(ids, 5000), vehiclePrice: 19500 })
    ).rejects.toThrow(/below the minimum profit/i);
  });

  test("the request records the vehicle's minimum, not the requester's", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "forgedmin", 1000);

    await ids.asOwner.mutation(api.approvals.requestProfitApproval, {
      orgId: ids.orgId,
      vehicleId: ids.vehicleId,
      requestedProfit: 400,
      minimumProfit: 0,
    });
    const rows: any[] = await t.run((ctx: any) => ctx.db.query("profitApprovalRequests").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].minimumProfit).toBe(1000);
    expect(rows[0].requestedProfit).toBe(400);
  });

  test("a legacy request is priced from its snapshot's edited base, not the list price", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "snapbase", 1000);

    // Base edited down to 19,000, profit 500: the quote will be 19,500.
    await ids.asOwner.mutation(api.approvals.requestProfitApproval, {
      orgId: ids.orgId,
      vehicleId: ids.vehicleId,
      requestedProfit: 500,
      minimumProfit: 1000,
      wizardSnapshot: { paymentType: "FINANCE", vehiclePrice: 19000, desiredProfit: 500, downPayment: 2000, termMonths: 60 },
    });
    const [row]: any[] = await t.run((ctx: any) => ctx.db.query("profitApprovalRequests").collect());
    expect(row.salePriceMinor).toBe(19_500_000);
    expect(row.requestedProfit).toBe(-500);
  });
});

describe("SCRUM-260: an approval covers exactly the priced state approved", () => {
  test("an approval at one price does not authorize a different below-minimum price", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "otherprice", 1000);
    await approveLegacyRequest(t, ids, 400);

    // 20,600 is a better deal than the approved 20,400 but still below the
    // minimum, and nobody approved it.
    await expect(
      ids.asOwner.mutation(api.quotes.saveQuote, financedQuote(ids, 600))
    ).rejects.toThrow(/below the minimum profit/i);
  });

  test("the exact approved state saves, and saves again on replay", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "replay", 1000);
    await approveLegacyRequest(t, ids, 400);

    expect(await ids.asOwner.mutation(api.quotes.saveQuote, financedQuote(ids, 400))).toBeTruthy();
    expect(await ids.asOwner.mutation(api.quotes.saveQuote, financedQuote(ids, 400))).toBeTruthy();
  });

  test("a list-price change after approval voids it", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "listmoved", 1000);
    await approveLegacyRequest(t, ids, 400);

    // Same price 20,400 and the same claimed profit; the list moved to 20,100,
    // so the margin is now 300 — a state the manager never saw.
    await t.run((ctx: any) => ctx.db.patch(ids.vehicleId, { sellingPrice: 20100 }));
    await expect(
      ids.asOwner.mutation(api.quotes.saveQuote, financedQuote(ids, 400))
    ).rejects.toThrow(/below the minimum profit/i);
  });

  test("a currency change voids an approval whose numbers still match", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "currency", 1000);
    await approveLegacyRequest(t, ids, 400);

    // JOD and KWD share a scale, so every minor-unit number still matches.
    await t.run(async (ctx: any) => {
      const settings = await ctx.db.query("orgSettings").withIndex("by_org", (q: any) => q.eq("orgId", ids.orgId)).unique();
      if (settings) await ctx.db.patch(settings._id, { currency: "KWD" });
      else await ctx.db.insert("orgSettings", { orgId: ids.orgId, currency: "KWD", currencySymbol: "KD", enabledPaymentTypes: [] });
    });
    await expect(
      ids.asOwner.mutation(api.quotes.saveQuote, financedQuote(ids, 400))
    ).rejects.toThrow(/below the minimum profit/i);
  });

  test("changing a pending request creates a new row instead of rewriting the one a manager may be viewing", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "immutable", 1000);

    const request = (requestedProfit: number) =>
      ids.asOwner.mutation(api.approvals.requestProfitApproval, {
        orgId: ids.orgId, vehicleId: ids.vehicleId, requestedProfit, minimumProfit: 1000,
      });
    await request(400);
    const [first]: any[] = await t.run((ctx: any) => ctx.db.query("profitApprovalRequests").collect());
    await request(100);

    // The manager approves the card they opened — the 400 request.
    await expect(
      ids.asOwner.mutation(api.approvals.respondToApproval, { orgId: ids.orgId, requestId: first._id, status: "APPROVED" })
    ).rejects.toThrow(/already been resolved/i);
    const firstNow: any = await t.run((ctx: any) => ctx.db.get(first._id));
    expect(firstNow.requestedProfit).toBe(400);
    expect(firstNow.status).toBe("REJECTED");
    expect(firstNow.supersededAt).toBeTypeOf("number");

    // …and the 100 deal remains unapproved.
    await expect(
      ids.asOwner.mutation(api.quotes.saveQuote, financedQuote(ids, 100))
    ).rejects.toThrow(/below the minimum profit/i);
  });

  test("an identical re-request returns the same pending row", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "idempotent", 1000);
    const args = { orgId: ids.orgId, vehicleId: ids.vehicleId, salePrice: 20400 };

    const first = await ids.asOwner.mutation(api.approvals.requestProfitApproval, args);
    const second = await ids.asOwner.mutation(api.approvals.requestProfitApproval, args);
    expect(second).toBe(first);
  });

  test("a price that already clears the minimum is not accepted as a request", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "noneed", 1000);

    await expect(
      ids.asOwner.mutation(api.approvals.requestProfitApproval, { orgId: ids.orgId, vehicleId: ids.vehicleId, salePrice: 21000 })
    ).rejects.toThrow(/needs no approval/i);
  });
});

describe("SCRUM-260: every completion door enforces the rule on the persisted price", () => {
  test("sales.create refuses a below-minimum financed sale with no approval and writes nothing", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "direct", 1000);

    await expect(
      ids.asOwner.mutation(api.sales.create, { ...directFinancedSale(ids, 20400), status: "COMPLETED" as const })
    ).rejects.toThrow(/below the minimum profit/i);
    expect(await salesOf(t, ids)).toHaveLength(0);
    const vehicle: any = await t.run((ctx: any) => ctx.db.get(ids.vehicleId));
    expect(vehicle.status).toBe("AVAILABLE");
  });

  test("sales.completeDraft refuses a below-minimum financed draft", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "draft", 1000);

    // A draft is not a sale and is not gated; completing it is.
    const saleId = await ids.asOwner.mutation(api.sales.createDraft, directFinancedSale(ids, 20400));
    await expect(
      ids.asOwner.mutation(api.sales.completeDraft, { orgId: ids.orgId, saleId, idempotencyKey: crypto.randomUUID() })
    ).rejects.toThrow(/below the minimum profit/i);
    const draft: any = await t.run((ctx: any) => ctx.db.get(saleId));
    expect(draft.status).toBe("PENDING");
  });

  test("sales.completeFromQuote gates a legacy quote with no mode, which is financed", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "legacymode", 1000);

    const quoteId = await t.run((ctx: any) =>
      ctx.db.insert("quotes", {
        orgId: ids.orgId,
        customerId: ids.customerId,
        vehicleId: ids.vehicleId,
        vehiclePrice: 20400,
        desiredProfit: 5000,
        downPayment: 0,
        termMonths: 0,
        status: "DRAFT",
        createdBy: ids.userId,
        createdAt: Date.now(),
      })
    );
    await expect(
      ids.asOwner.mutation(api.sales.completeFromQuote, { orgId: ids.orgId, quoteId, idempotencyKey: crypto.randomUUID() })
    ).rejects.toThrow(/below the minimum profit/i);
    expect(await salesOf(t, ids)).toHaveLength(0);
  });

  test("a cash direct sale below the list price is exempt", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "cashdirect", 1000);

    const saleId = await ids.asOwner.mutation(api.sales.create, {
      ...directFinancedSale(ids, 19000),
      financingType: "CASH" as const,
      status: "COMPLETED" as const,
    });
    expect(saleId).toBeTruthy();
  });

  test("an approved price completes through the direct door", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "directok", 1000);
    await approveLegacyRequest(t, ids, 400);

    const saleId = await ids.asOwner.mutation(api.sales.create, { ...directFinancedSale(ids, 20400), status: "COMPLETED" as const });
    expect(saleId).toBeTruthy();
  });
});

describe("SCRUM-260: numeric inputs fail closed", () => {
  test("a list price not representable in the currency refuses rather than rounding", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "subfils", 1000);

    await t.run((ctx: any) => ctx.db.patch(ids.vehicleId, { sellingPrice: 20000.0004 }));
    await expect(
      ids.asOwner.mutation(api.quotes.saveQuote, financedQuote(ids, 1000))
    ).rejects.toThrow(/cannot be represented/i);
  });
});

describe("SCRUM-260: approvals.profitApprovalStatus is the same verdict the mutations enforce", () => {
  test("reports NOT_REQUIRED, REQUIRED, PENDING and APPROVED", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
    const ids = await seedOrg(t, "status", 1000);
    const status = (salePrice: number) =>
      ids.asOwner.query(api.approvals.profitApprovalStatus, { orgId: ids.orgId, vehicleId: ids.vehicleId, salePrice });

    expect((await status(21000))?.status).toBe("NOT_REQUIRED");
    expect((await status(20400))?.status).toBe("REQUIRED");
    const requestId = await ids.asOwner.mutation(api.approvals.requestProfitApproval, {
      orgId: ids.orgId, vehicleId: ids.vehicleId, salePrice: 20400,
    });
    expect(await status(20400)).toMatchObject({ status: "PENDING", requestId });
    await ids.asOwner.mutation(api.approvals.respondToApproval, { orgId: ids.orgId, requestId, status: "APPROVED" });
    expect((await status(20400))?.status).toBe("APPROVED");
    expect((await status(20500))?.status).toBe("REQUIRED");
    expect((await status(Number.NaN))?.status).toBe("INVALID");

    // A manager's rejection is reported; a request the salesperson replaced is not.
    const rejectedId = await ids.asOwner.mutation(api.approvals.requestProfitApproval, {
      orgId: ids.orgId, vehicleId: ids.vehicleId, salePrice: 20500,
    });
    await ids.asOwner.mutation(api.approvals.respondToApproval, { orgId: ids.orgId, requestId: rejectedId, status: "REJECTED" });
    expect((await status(20500))?.status).toBe("REJECTED");
    await ids.asOwner.mutation(api.approvals.requestProfitApproval, { orgId: ids.orgId, vehicleId: ids.vehicleId, salePrice: 20600 });
    await ids.asOwner.mutation(api.approvals.requestProfitApproval, { orgId: ids.orgId, vehicleId: ids.vehicleId, salePrice: 20700 });
    expect((await status(20600))?.status).toBe("REQUIRED");
  });
});
