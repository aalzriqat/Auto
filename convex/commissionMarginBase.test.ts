/**
 * SCRUM-390 (owner ruling OR-5) - the automatic commission base on a financed
 * sale is the "Commissionable vehicle margin":
 *
 *     approved amount (G) - showroom contribution (C) - vehicle acquisition cost
 *
 * Invariant: the new base applies only when (1) `applications.finalizeDeal`
 * completes the sale, (2) the car is dealer-owned, and (3) finalize froze a
 * financed-sale plan of VERSION 2. G and C are frozen onto the sale row at
 * completion, and `recalculateCommission` reads ONLY those frozen values.
 * Everything else (cash, `sales.create`, consigned, MANUAL mode) is unchanged.
 *
 * Worked figure: 12,500 - 1,375 - 10,000 = 1,125; at 10% that is 112.5.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex
 * runtime and not production data.
 */
import { convexTestWithComponents, registerHandover, recordReconciledZeroCost } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

const ALL_PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "finalize:financed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "view:reports", "manage:settings",
];

const SCALE = 1_000; // JOD, 3 decimals
const RATE_PERCENT = 10;

interface SeedOpts {
  /** Vehicle acquisition cost in major units; undefined leaves the car with NO recorded cost. */
  cost: number | undefined;
  price: number;
  commissionMode?: "AUTO_MEMBER" | "AUTO_TIERS" | "MANUAL";
  /** Only read in AUTO_TIERS mode. */
  tiers?: { minProfitAmount: number; commissionPct: number }[];
  /** A consigned (SOURCED) car: `cost` is then the supplier entitlement. */
  sourced?: boolean;
}

async function seedDealership(tag: string, opts: SeedOpts) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S390 ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_owner`, email: `${tag}.owner@example.com`, name: "owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: ALL_PERMS, isSystemOwnerRole: true })
  );
  const membershipId = await t.run((ctx) =>
    ctx.db.insert("memberships", { orgId, userId, roleId, commissionRate: RATE_PERCENT })
  );
  const as = t.withIdentity({ subject: `${tag}_owner`, clerkId: `${tag}_owner` });
  // A second approver: an application cannot be approved by its own salesperson.
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_appr`, email: `${tag}.appr@example.com`, name: "appr" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  const approver = t.withIdentity({ subject: `${tag}_appr`, clerkId: `${tag}_appr` });
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
      commissionMode: opts.commissionMode ?? "AUTO_MEMBER",
      ...(opts.tiers ? { commissionTiers: opts.tiers } : {}),
    })
  );
  await as.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await as.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear,
    periodNumber: 1,
  });
  const period = (await as.query(api.accountingPeriods.list, { orgId }))[0];
  await as.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag }));
  const customerStatusId = await t.run((ctx) =>
    ctx.db.insert("orgCustomerStatuses", { orgId, label: "Eligible", isActive: true, order: 1 })
  );
  const mkVehicle = (vin: string) =>
    t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin: `VIN390${tag}${vin}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10,
        color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
        sellingPrice: opts.price, status: "AVAILABLE",
        ...(opts.sourced
          ? { sourceType: "SOURCED" as const, sourcedFromName: "Amman Importer Co", sourceCost: opts.cost }
          : { sourceType: "STOCK" as const, ...(opts.cost !== undefined ? { purchasePrice: opts.cost } : {}) }),
      })
    );
  const vehicleId = await mkVehicle("A");
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId, name: "Jordan Auto Finance", profitRate: 5, maxTermMonths: 60,
      gracePeriodMonths: 0, isActive: true, defaultLtvPercent: 85, adminFees: 0,
    })
  );
  return { t, orgId, userId, membershipId, as, approver, customerId, customerStatusId, vehicleId, companyId, mkVehicle };
}
type Seeded = Awaited<ReturnType<typeof seedDealership>>;

/** The finishing steps every finalizable deal shares. */
async function finishDeal(
  s: Seeded,
  applicationId: Id<"financeApplications">,
  invoiceMinor: number,
  firstPaymentMinor: number,
  issuedTo: "CUSTOMER" | "FINANCE_COMPANY"
) {
  await registerHandover(s.as, api, s.orgId, applicationId);
  await s.as.mutation(api.applications.registerExpectedPayment, {
    orgId: s.orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });
  await s.as.mutation(api.financeDealCosts.recordLegalInvoice, {
    orgId: s.orgId, applicationId, legalInvoiceAmountMinor: invoiceMinor, legalInvoiceNumber: `INV-${applicationId}`,
    legalInvoiceDate: Date.now(), issuedTo,
  });
  await recordReconciledZeroCost(s.as, api, s.orgId, applicationId);
  await s.t.run((ctx) => ctx.db.patch(applicationId, { customerFirstPaymentMinor: firstPaymentMinor }));
}

/**
 * Configured company, sale price 13,000, approved G = 12,500, first payment 500,
 * showroom contribution C = 1,375 (the stored `dealerContributionMinor`, exactly
 * as finalize reads it).
 */
async function readyConfiguredDeal(s: Seeded, o: { price: number; g: number; c: number; first: number }) {
  const quoteId = await s.as.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId,
    vehiclePrice: o.price, downPayment: o.first / SCALE, termMonths: 48,
    mode: "CONFIGURED_FINANCE_COMPANY", companyId: s.companyId,
    customerEligibilityStatusIds: [s.customerStatusId], totalFinancedAmount: o.g / SCALE,
  });
  const applicationId = await s.as.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
  await s.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
  await s.approver.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
  await s.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId: s.orgId, applicationId, submittedQuotationMinor: o.g, source: "MANUAL_ENTRY",
  });
  await s.approver.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    orgId: s.orgId, applicationId, approvedAmountMinor: o.g, basis: "MANUAL", notes: "Approved.",
  });
  await finishDeal(s, applicationId, o.price * SCALE, o.first, "FINANCE_COMPANY");
  await s.t.run((ctx) => ctx.db.patch(applicationId, {
      dealerContributionMinor: o.c,
      // The legal invoice (13,000) exceeds G (12,500) by what the customer owes the dealership.
      customerGapCashToDealerMinor: o.price * SCALE - o.g,
    }));
  return { applicationId, quoteId };
}

/** Manual company (OR-8 letter): G, S = what the dealership sends, H = deposit held and applied, so C = S - H. */
async function readyManualDeal(s: Seeded, o: { price: number; g: number; sends: number; h: number }) {
  const quoteId = await s.as.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId,
    vehiclePrice: o.price, downPayment: 0, termMonths: 48,
    mode: "MANUAL_FINANCE_COMPANY", manualProviderName: "Other finance option",
    manualAdminFees: 0, manualProfitRate: 5,
  });
  const applicationId = await s.as.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
  await s.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
  await s.approver.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
  await s.approver.mutation(api.financingEconomics.recordManualFinanceApproval, {
    orgId: s.orgId, applicationId, approvedAmountMinor: o.g, financierName: "Al-Ameen Islamic Finance",
    dealerSendsMinor: o.sends,
  });
  await finishDeal(s, applicationId, o.price * SCALE, o.h, "FINANCE_COMPANY");
  if (o.h > 0) {
    await s.t.run(async (ctx) => {
      await ctx.db.insert("deposits", {
        orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, quoteId,
        amount: o.h / SCALE, amountMinor: o.h, currency: "JOD", method: "CASH", status: "HELD", holdActive: true,
        createdBy: s.userId, createdAt: Date.now(),
      } as never);
    });
  }
  return { applicationId, quoteId };
}

const finalize = (s: Seeded, applicationId: Id<"financeApplications">, key = crypto.randomUUID()) =>
  s.as.mutation(api.applications.finalizeDeal, { idempotencyKey: key, orgId: s.orgId, applicationId });

async function saleOf(s: Seeded, applicationId: Id<"financeApplications">) {
  return await s.t.run(async (ctx) => {
    const app = await ctx.db.get(applicationId);
    return app?.finalizedSaleId ? await ctx.db.get(app.finalizedSaleId) : null;
  });
}

const CONFIGURED = { price: 13_000, g: 12_500_000, c: 1_375_000, first: 500_000 };
// 5% from 0, 10% from 1,000: the bracket edge sits exactly on a JOD margin of 1,000.
const TIERS = [
  { minProfitAmount: 0, commissionPct: 5 },
  { minProfitAmount: 1_000, commissionPct: 10 },
];
const MANUAL = { price: 12_000, g: 12_000_000, sends: 1_650_000, h: 500_000 }; // C = 1,150

describe("SCRUM-390 OR-5: commissionable vehicle margin on a v2 financed sale", () => {
  test("1. configured company, owned car: 12,500 - 1,375 - 10,000 = 1,125 at 10% = 112.5, frozen on the sale", async () => {
    const s = await seedDealership("cfg", { cost: 10_000, price: CONFIGURED.price });
    const { applicationId } = await readyConfiguredDeal(s, CONFIGURED);
    await finalize(s, applicationId);
    const sale = await saleOf(s, applicationId);
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.financedSalePlanVersion).toBe(2);
    // The old base (sale price - cost = 3,000) would pay 300.
    expect(sale?.commissionAmount).toBeCloseTo(112.5, 6);
    expect(sale?.commissionBase).toEqual({ approvedMinor: 12_500_000, contributionMinor: 1_375_000, currency: "JOD" });
  });

  test("2. manual company with a held deposit applied: G 12,000, S 1,650, H 500, C 1,150, cost 10,000 -> 850 -> 85", async () => {
    const s = await seedDealership("man", { cost: 10_000, price: MANUAL.price });
    const { applicationId } = await readyManualDeal(s, MANUAL);
    await finalize(s, applicationId);
    const sale = await saleOf(s, applicationId);
    expect(sale?.commissionAmount).toBeCloseTo(85, 6);
    expect(sale?.commissionBase).toEqual({ approvedMinor: 12_000_000, contributionMinor: 1_150_000, currency: "JOD" });
  });

  test("3. no cost at finalize: commission is null; recalculation after the cost is recorded uses the FROZEN G and C, not the application", async () => {
    const s = await seedDealership("nocost", { cost: undefined, price: CONFIGURED.price });
    const { applicationId } = await readyConfiguredDeal(s, CONFIGURED);
    await finalize(s, applicationId);
    const before = await saleOf(s, applicationId);
    expect(before?.commissionAmount).toBeUndefined();
    expect(before?.commissionBase).toMatchObject({ approvedMinor: 12_500_000, contributionMinor: 1_375_000 });

    // The application moves AFTER completion: nothing may be re-derived from it.
    await s.t.run((ctx) =>
      ctx.db.patch(applicationId, { approvedDealerPurchaseAmountMinor: 9_000_000, dealerContributionMinor: 5_000_000 })
    );
    await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { purchasePrice: 10_000 }));

    const result = await s.as.mutation(api.sales.recalculateCommission, { orgId: s.orgId, saleId: before!._id });
    expect(result.commissionAmount).toBeCloseTo(112.5, 6);
    expect((await saleOf(s, applicationId))?.commissionAmount).toBeCloseTo(112.5, 6);
  });

  test("5. G - C - cost below zero pays 0, never a negative commission", async () => {
    const s = await seedDealership("neg", { cost: 11_500, price: CONFIGURED.price });
    const { applicationId } = await readyConfiguredDeal(s, CONFIGURED);
    await finalize(s, applicationId);
    const sale = await saleOf(s, applicationId);
    // 12,500 - 1,375 - 11,500 = -375
    expect(sale?.commissionAmount).toBe(0);
  });

  test("4a. MANUAL commission mode stays unset (the ruling does not enable automatic commission)", async () => {
    const s = await seedDealership("manualmode", { cost: 10_000, price: CONFIGURED.price, commissionMode: "MANUAL" });
    const { applicationId } = await readyConfiguredDeal(s, CONFIGURED);
    await finalize(s, applicationId);
    const sale = await saleOf(s, applicationId);
    expect(sale?.commissionAmount).toBeUndefined();
  });

  test.each([
    ["4b. a FINANCED sale with no application (sales.create)", "FINANCED"],
    ["4c. a cash sale", "CASH"],
  ] as const)("%s keeps sale price - cost and freezes no commissionBase", async (_label, financingType) => {
    const s = await seedDealership(`ctl_${financingType}`, { cost: 10_000, price: 13_000 });
    const saleId = await s.as.mutation(api.sales.create, {
      idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId,
      salespersonId: s.userId, salePrice: 13_000, saleDate: Date.now(), status: "COMPLETED", financingType,
    });
    const sale = await s.t.run((ctx) => ctx.db.get(saleId));
    expect(sale?.commissionAmount).toBeCloseTo(300, 6);
    expect(sale?.commissionBase).toBeUndefined();
  });
  test("6a. control: a consigned financed v2 deal through finalizeDeal keeps today's basis and freezes no commissionBase", async () => {
    const s = await seedDealership("consigned", { cost: 10_000, price: CONFIGURED.price, sourced: true });
    const { applicationId } = await readyConfiguredDeal(s, CONFIGURED);
    await s.t.run((ctx) => ctx.db.patch(applicationId, { supplierSettlementRoute: "THROUGH_DEALERSHIP" }));
    await finalize(s, applicationId);
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    // The deal really is a v2 plan, so the exclusion is the ownership check and not a missing plan.
    expect(app?.financedSalePlanVersion).toBe(2);
    const sale = await saleOf(s, applicationId);
    expect(sale?.commissionBase).toBeUndefined();
    // Today's consigned basis: sale price 13,000 - entitlement 10,000 = 3,000 at 10%.
    // (The new base would give 112.5.)
    expect(sale?.commissionAmount).toBeCloseTo(300, 6);
  });

  async function frozenNoCostSale(tag: string) {
    const s = await seedDealership(tag, { cost: undefined, price: CONFIGURED.price });
    const { applicationId } = await readyConfiguredDeal(s, CONFIGURED);
    await finalize(s, applicationId);
    const sale = await saleOf(s, applicationId);
    expect(sale?.commissionAmount).toBeUndefined();
    await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { purchasePrice: 10_000 }));
    return { s, saleId: sale!._id };
  }

  test("6b. recalculateCommission refuses when the org currency changed after completion, leaving the commission untouched", async () => {
    const { s, saleId } = await frozenNoCostSale("recalcccy");
    await s.t.run(async (ctx) => {
      const settings = (await ctx.db.query("orgSettings").collect()).find((x) => x.orgId === s.orgId)!;
      await ctx.db.patch(settings._id, { currency: "USD", currencySymbol: "$" });
    });
    const error = await s.as
      .mutation(api.sales.recalculateCommission, { orgId: s.orgId, saleId })
      .then(() => null, (e: unknown) => e as { data?: { code?: string; message?: string } });
    expect(error?.data?.code).toBe("COMMISSION_BASE_UNUSABLE_RECALC");
    expect(error?.data?.message).toMatch(/different currency/i);
    const after = await s.t.run((ctx) => ctx.db.get(saleId));
    expect(after?.commissionAmount).toBeUndefined();
  });

  test.each([
    ["fractional", 1_375_000.5],
    ["negative", -1],
    ["not finite", Number.NaN],
  ])("6c. recalculateCommission refuses a %s frozen amount instead of falling back to salePrice - cost", async (label, bad) => {
    const { s, saleId } = await frozenNoCostSale(`recalcbad${label.replace(/\W/g, "")}`);
    await s.t.run((ctx) =>
      ctx.db.patch(saleId, { commissionBase: { approvedMinor: 12_500_000, contributionMinor: bad, currency: "JOD" } })
    );
    const error = await s.as
      .mutation(api.sales.recalculateCommission, { orgId: s.orgId, saleId })
      .then(() => null, (e: unknown) => e as { data?: { code?: string; message?: string } });
    expect(error?.data?.code).toBe("COMMISSION_BASE_UNUSABLE_RECALC");
    expect(error?.data?.message).toMatch(/unusable amount/i);
    const after = await s.t.run((ctx) => ctx.db.get(saleId));
    expect(after?.commissionAmount).toBeUndefined();
  });

  // S390-1: G, C and cost are exact minor units (fils); the margin must be
  // subtracted as integers or a sale one float-ulp under a tier edge lands in the
  // wrong bracket. Deal: G 10,000.005 - C 1,000.000 - cost 8,000.005 = 1,000.000.
  const EDGE = { price: 13_000, g: 10_000_005, c: 1_000_000, first: 500_000 };

  test("S390-1a. JOD exact tier threshold: margin exactly 1,000.000 lands in the 10% bracket (commission 100)", async () => {
    const s = await seedDealership("edge", { cost: 8_000.005, price: EDGE.price, commissionMode: "AUTO_TIERS", tiers: TIERS });
    const { applicationId } = await readyConfiguredDeal(s, EDGE);
    await finalize(s, applicationId);
    const sale = await saleOf(s, applicationId);
    expect(sale?.commissionBase).toEqual({ approvedMinor: 10_000_005, contributionMinor: 1_000_000, currency: "JOD" });
    expect(sale?.commissionAmount).toBeCloseTo(100, 9);
  });

  test("S390-1b. one fil below the threshold (margin 999.999) stays in the 5% bracket", async () => {
    const s = await seedDealership("edgebelow", { cost: 8_000.006, price: EDGE.price, commissionMode: "AUTO_TIERS", tiers: TIERS });
    const { applicationId } = await readyConfiguredDeal(s, EDGE);
    await finalize(s, applicationId);
    const sale = await saleOf(s, applicationId);
    expect(sale?.commissionAmount).toBeCloseTo(999.999 * 0.05, 9);
  });

  test("S390-1c. recalculation of the exact-threshold deal (cost recorded after finalize) also lands at 100", async () => {
    const s = await seedDealership("edgerecalc", { cost: undefined, price: EDGE.price, commissionMode: "AUTO_TIERS", tiers: TIERS });
    const { applicationId } = await readyConfiguredDeal(s, EDGE);
    await finalize(s, applicationId);
    const before = await saleOf(s, applicationId);
    expect(before?.commissionAmount).toBeUndefined();
    await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { purchasePrice: 8_000.005 }));
    const result = await s.as.mutation(api.sales.recalculateCommission, { orgId: s.orgId, saleId: before!._id });
    expect(result.commissionAmount).toBeCloseTo(100, 9);
  });

  test("S390-1e. AUTO_TIERS on the reference deal (margin 1,125) picks the tier by the margin, not by the 3,000 sale-price spread", async () => {
    // Tiers chosen so the two bases fall in different brackets: 1,125 -> 10%, 3,000 -> 20%.
    const tiers = [...TIERS, { minProfitAmount: 2_000, commissionPct: 20 }];
    const s = await seedDealership("tiersref", { cost: 10_000, price: CONFIGURED.price, commissionMode: "AUTO_TIERS", tiers });
    const { applicationId } = await readyConfiguredDeal(s, CONFIGURED);
    await finalize(s, applicationId);
    const sale = await saleOf(s, applicationId);
    expect(sale?.commissionAmount).toBeCloseTo(112.5, 9);
  });

  test("S390-1f. MANUAL mode still freezes commissionBase on finalize and sets no automatic amount", async () => {
    const s = await seedDealership("manualfrozen", { cost: 10_000, price: CONFIGURED.price, commissionMode: "MANUAL" });
    const { applicationId } = await readyConfiguredDeal(s, CONFIGURED);
    await finalize(s, applicationId);
    const sale = await saleOf(s, applicationId);
    expect(sale?.commissionAmount).toBeUndefined();
    expect(sale?.commissionBase).toEqual({ approvedMinor: 12_500_000, contributionMinor: 1_375_000, currency: "JOD" });
  });

  test("S390-1g. finalize retried after success (same key, and a fresh key) leaves the commission and frozen base unchanged", async () => {
    const s = await seedDealership("retry", { cost: 10_000, price: CONFIGURED.price });
    const { applicationId } = await readyConfiguredDeal(s, CONFIGURED);
    const key = crypto.randomUUID();
    await finalize(s, applicationId, key);
    const first = await saleOf(s, applicationId);
    const sales = () => s.t.run((ctx) => ctx.db.query("sales").collect());
    const countBefore = (await sales()).length;

    await finalize(s, applicationId, key); // same key: a replay, not a second completion
    // A fresh key on an already-finalized deal: whether it replays or refuses, state must not move.
    await finalize(s, applicationId, crypto.randomUUID()).catch(() => undefined);

    const after = await saleOf(s, applicationId);
    expect(after?._id).toBe(first?._id);
    expect(after?.commissionAmount).toBe(first?.commissionAmount);
    expect(after?.commissionBase).toEqual(first?.commissionBase);
    expect(await sales()).toHaveLength(countBefore);
  });
});