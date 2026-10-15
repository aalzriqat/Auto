/**
 * SCRUM-411 / SCRUM-407 c21031 - every report that reads a v3 financed sale's
 * recognized revenue reads the SAME figure the general ledger posts.
 *
 * The ledger credits the consideration K = A + R and DEBITS the showroom's
 * contribution D to SALES_CONSIDERATION_REDUCTIONS (contra-revenue), so the
 * revenue the deal earned is K - D (owned) or K - E - D (a consigned car, where
 * E is the supplier's entitlement). The sales report, the salesperson report and
 * the dashboard read `saleEconomics`, which used to answer the gross: K for an
 * owned car, K - E for a consigned one.
 *
 * Every expected figure below is worked by hand from the ruling and the fixture
 * (A = 12,500 approved, D = 1,375 contribution, owned cost 9,000, consigned
 * entitlement E = 9,000, optional customer gap R = 500) - never read back from
 * the code under test. Each test ALSO reads the ledger itself, so the report is
 * compared with the books and not only with the arithmetic.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex
 * runtime and not production data.
 */
import {
  C, G, finalizeAsOwner, finalizeThenTakeForwardBack, newApplication, readyDeal, seedFinancedDealership,
} from "../test-utils/financedDealFixture";
import { recordReconciledZeroCost, registerHandover } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
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
  "manage:supplier_settlement", "cancel:closed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "view:reports", "manage:settings",
];

const DAY = 24 * 60 * 60 * 1000;

async function seed(tag: string, sourced = false) {
  const dealership = await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: ALL_PERMS, label: "S411R", vinPrefix: "VIN411R",
    actors: {}, sourced,
  });
  return { ...dealership, sourced };
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** Net debit-positive movement per system account across the live (not reversed) events of a type. */
async function netByAccount(s: Seeded, eventType: string) {
  return await s.t.run(async (ctx) => {
    const events = (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).filter(
      (e) => e.eventType === eventType && e.status !== "REVERSED"
    );
    const entries = await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    const net = new Map<string, number>();
    for (const event of events) {
      for (const entry of entries.filter((e) => e.accountingEventId === event._id)) {
        const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)).collect();
        for (const line of lines) {
          const account = await ctx.db.get(line.accountId);
          const key = account?.systemKey ?? String(line.accountId);
          net.set(key, (net.get(key) ?? 0) + line.debitMinor - line.creditMinor);
        }
      }
    }
    return Object.fromEntries(net) as Record<string, number>;
  });
}

/** Net revenue the LEDGER recognized for the vehicle leg, in minor units: revenue credited less contra-revenue debited. */
async function ledgerNetRevenueMinor(s: Seeded, revenueKey: "SALES_REVENUE" | "CONSIGNMENT_COMMISSION_REVENUE") {
  const net = await netByAccount(s, "SALE_COMPLETED");
  // `0 - x` rather than `-x`: an empty ledger must read +0, not -0.
  return 0 - (net[revenueKey] ?? 0) - (net.SALES_CONSIDERATION_REDUCTIONS ?? 0);
}

/**
 * Drives a ready deal to CLOSED with an optional customer gap R and an optional
 * contribution override, then returns the application and sale. A consigned car
 * settles THROUGH_DEALERSHIP: the dealership collects the gross and owes the
 * supplier his entitlement.
 */
async function closeDeal(
  s: Seeded,
  over: { gapMinor?: number; contributionMinor?: number; takeForwardBack?: boolean } = {}
) {
  const { applicationId } = await readyDeal(s, {
    gapMinor: over.gapMinor,
    contributionMinor: over.contributionMinor,
    route: s.sourced ? "THROUGH_DEALERSHIP" : undefined,
  });
  // SCRUM-411 P2-01: the payment to the finance company precedes the close. A cancel is refused
  // while it is on the books, so a test that cancels takes it back after the close.
  if (over.takeForwardBack === true) await finalizeThenTakeForwardBack(s, applicationId);
  else await finalizeAsOwner(s, applicationId);
  const app = await s.t.run((ctx) => ctx.db.get(applicationId));
  const sale = await s.t.run((ctx) => ctx.db.get(app!.finalizedSaleId!));
  return { applicationId, saleId: app!.finalizedSaleId as Id<"sales">, sale: sale! };
}

const WINDOW = () => ({ startDate: Date.now() - 30 * DAY, endDate: Date.now() + DAY });

/** What each report consumer answers for the org's one sale, in major units. */
async function readEveryConsumer(s: Seeded) {
  const report = await s.owner.as.query(api.reports.getSalesAndProfitReport, { orgId: s.orgId, ...WINDOW() });
  const performance = await s.owner.as.query(api.reports.getSalespersonPerformance, { orgId: s.orgId, ...WINDOW() });
  const dashboard = await s.owner.as.query(api.dashboard.stats, { orgId: s.orgId, timeRange: "ALL_TIME" });
  const transactions = await s.t.run((ctx) =>
    ctx.db.query("transactions").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()
  );
  return {
    report,
    row: report.sales[0],
    performance: performance[0],
    dashboardRevenue: dashboard.salesVolumeThisMonth,
    saleTransaction: transactions.find((tx) => tx.recognizedRevenueAmount !== undefined),
  };
}

describe("SCRUM-411 - owned car: reports agree with the ledger's net revenue K - D", () => {
  test("A 12,500, D 1,375, R 0: ledger net 11,125; every report says 11,125, profit 11,125 - 9,000 = 2,125", async () => {
    const s = await seed("own1");
    await closeDeal(s);

    // The ledger: SALES_REVENUE credited 12,500, contribution debited 1,375 -> 11,125 (hand figure 11,125,000 minor).
    expect(await ledgerNetRevenueMinor(s, "SALES_REVENUE")).toBe(11_125_000);

    const r = await readEveryConsumer(s);
    expect(r.row.recognizedRevenue).toBe(11_125);
    expect(r.row.netProfit).toBe(2_125);
    expect(r.report.totalRevenue).toBe(11_125);
    expect(r.report.totalProfit).toBe(2_125);
    expect(r.performance.totalRevenue).toBe(11_125);
    expect(r.performance.totalProfit).toBe(2_125);
    expect(r.dashboardRevenue).toBe(11_125);
    // The cashflow row the dashboard falls back to carries the same figure.
    expect(r.saleTransaction?.recognizedRevenueAmount).toBe(11_125);
    // Revenue less cost of sales is the profit - the identity the report is built on.
    expect(r.row.recognizedRevenue).not.toBeNull();
    expect((r.row.recognizedRevenue ?? 0) - r.row.totalCost).toBe(r.row.netProfit);
  });

  test("with a customer gap R 500: K 13,000, ledger net 11,625, profit 2,625", async () => {
    const s = await seed("own2");
    await closeDeal(s, { gapMinor: 500_000 });

    expect(await ledgerNetRevenueMinor(s, "SALES_REVENUE")).toBe(11_625_000);

    const r = await readEveryConsumer(s);
    expect(r.row.recognizedRevenue).toBe(11_625);
    expect(r.row.netProfit).toBe(2_625);
    expect(r.report.totalRevenue).toBe(11_625);
    expect(r.performance.totalRevenue).toBe(11_625);
    expect(r.dashboardRevenue).toBe(11_625);
  });

  test("no contribution: nothing is subtracted, the report stays at the gross 12,500", async () => {
    const s = await seed("own3");
    await closeDeal(s, { contributionMinor: 0 });

    expect(await ledgerNetRevenueMinor(s, "SALES_REVENUE")).toBe(G);
    const r = await readEveryConsumer(s);
    expect(r.row.recognizedRevenue).toBe(12_500);
    expect(r.report.totalRevenue).toBe(12_500);
    expect(r.dashboardRevenue).toBe(12_500);
  });
});

describe("SCRUM-411 - consigned car: reports agree with the ledger's net commission K - E - D", () => {
  test("A 12,500, E 9,000, D 1,375: commission 3,500, ledger net 2,125; every report says 2,125", async () => {
    const s = await seed("src1", true);
    const { sale } = await closeDeal(s);

    // Hand figure: 12,500 - 9,000 = 3,500 commission; less the 1,375 contribution = 2,125.
    expect(await ledgerNetRevenueMinor(s, "CONSIGNMENT_COMMISSION_REVENUE")).toBe(2_125_000);

    const r = await readEveryConsumer(s);
    expect(r.row.isAgentSale).toBe(true);
    expect(r.row.recognizedRevenue).toBe(2_125);
    expect(r.row.netProfit).toBe(2_125);
    expect(r.report.totalRevenue).toBe(2_125);
    expect(r.report.totalProfit).toBe(2_125);
    expect(r.performance.totalRevenue).toBe(2_125);
    expect(r.dashboardRevenue).toBe(2_125);
    expect(r.saleTransaction?.recognizedRevenueAmount).toBe(2_125);
    // What belongs to the supplier is unchanged by the showroom's contribution.
    expect(r.row.supplierSettlement).toBe(9_000);
    // The commission/claim basis is untouched: the frozen consigned margin is still K - E.
    expect(sale.consignedMarginMinor).toBe(3_500_000);
  });

  test("with a customer gap R 500: commission 4,000, ledger net 2,625", async () => {
    const s = await seed("src2", true);
    await closeDeal(s, { gapMinor: 500_000 });

    expect(await ledgerNetRevenueMinor(s, "CONSIGNMENT_COMMISSION_REVENUE")).toBe(2_625_000);
    const r = await readEveryConsumer(s);
    expect(r.row.recognizedRevenue).toBe(2_625);
    expect(r.row.netProfit).toBe(2_625);
    expect(r.dashboardRevenue).toBe(2_625);
  });

  test("a contribution equal to the commission nets to a real zero, not an unknown", async () => {
    const s = await seed("src3", true);
    await closeDeal(s, { contributionMinor: 3_500_000 });

    expect(await ledgerNetRevenueMinor(s, "CONSIGNMENT_COMMISSION_REVENUE")).toBe(0);
    const r = await readEveryConsumer(s);
    expect(r.row.recognizedRevenue).toBe(0);
    expect(r.row.netProfit).toBe(0);
    expect(r.report.unknownMarginSaleCount).toBe(0);
    expect(r.dashboardRevenue).toBe(0);
  });

  test("a contribution above the commission is reported as the loss the ledger booked: -500, never floored", async () => {
    const s = await seed("src4", true);
    await closeDeal(s, { contributionMinor: 4_000_000 });

    // 3,500 commission - 4,000 contribution = -500.
    expect(await ledgerNetRevenueMinor(s, "CONSIGNMENT_COMMISSION_REVENUE")).toBe(-500_000);
    const r = await readEveryConsumer(s);
    expect(r.row.recognizedRevenue).toBe(-500);
    expect(r.row.netProfit).toBe(-500);
    expect(r.report.totalRevenue).toBe(-500);
    expect(r.dashboardRevenue).toBe(-500);
  });
});

describe("SCRUM-411 - consigned THROUGH_DEALERSHIP: the entitlement ceiling is the persisted consideration K", () => {
  /**
   * CodeRabbit 4276958526, driven end to end through public mutations - no `salePrice` patch.
   *
   * The reachable case is a financing-TERMS shortfall, which the net shortfall embeds and the
   * gross (price - approved) does not: the quotation, its submitted figure and the approval are
   * all 12,500, but the company approves at 90% where the quote-time LTV was 100%. The
   * showroom's contribution rises 0 -> 1,250, so N = (12,500 - 0) - (12,500 - 1,250) = 1,250
   * while price - approved = 0. `resolveAppraisalGap` bounds the customer's share by N alone,
   * so the customer can absorb all 1,250 in cash: R = 1,250, K = A + R = 13,750, and finalize
   * passes the quote's 12,500 as the sale price. K exceeds the price by R.
   *
   * A supplier entitlement E = 13,000 sits between the two: completion measures his position
   * against K and accepts it, so every reader must publish it.
   * Hand figures: commission K - E = 750; contribution 1,250; net 750 - 1,250 = -500.
   */
  async function closeWithEntitlementAbovePrice(tag: string) {
    const s = await seed(tag, true);
    const { applicationId } = await newApplication(s);
    await s.owner.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
    await s.approver.as.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
    await s.owner.as.mutation(api.applications.setSupplierSettlementRoute, {
      orgId: s.orgId, applicationId, route: "THROUGH_DEALERSHIP",
    });
    await s.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId, applicationId, submittedQuotationMinor: G, source: "MANUAL_ENTRY",
    });
    await s.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId, applicationId, approvedAmountMinor: G, appliedLtvPercent: 90, basis: "MANUAL",
      notes: "Approved at the quotation, at a lower LTV.",
    });
    // The customer absorbs the whole terms shortfall, paid in cash to the dealership.
    const served = await s.approver.as.query(api.applications.get, { orgId: s.orgId, applicationId });
    await s.approver.as.mutation(api.financingEconomics.resolveAppraisalGap, {
      orgId: s.orgId, applicationId, economicsStamp: served!.economicsStamp!,
      customerGapShareMinor: 1_250_000, dealerGapShareMinor: 0,
      customerGapCashToDealerMinor: 1_250_000, customerGapInstallmentToDealerMinor: 0,
      customerGapToFinanceCompanyMinor: 0,
    });
    await registerHandover(s.owner.as, api, s.orgId, applicationId);
    await s.owner.as.mutation(api.applications.registerExpectedPayment, {
      orgId: s.orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
    });
    await recordReconciledZeroCost(s.owner.as, api, s.orgId, applicationId);
    await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { sourceCost: 13_000 }));
    await finalizeAsOwner(s, applicationId);
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    const sale = (await s.t.run((ctx) => ctx.db.get(app!.finalizedSaleId!)))!;
    return { s, applicationId, saleId: sale._id, sale };
  }

  test("completion freezes K, the ledger nets -500, and every report publishes E 13,000 as the supplier's settlement", async () => {
    const { s, applicationId, sale } = await closeWithEntitlementAbovePrice("ceil1");

    // The reachable shape, asserted rather than assumed: net shortfall above price - approved.
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app!.netShortfallMinor).toBe(1_250_000);
    expect(sale.salePrice).toBe(12_500);
    expect(sale.consignedSupplierEntitlementMinor).toBe(13_000_000);
    expect(sale.financedNetRevenue).toEqual({ minor: -500_000, currency: "JOD", considerationMinor: 13_750_000 });
    expect(await ledgerNetRevenueMinor(s, "CONSIGNMENT_COMMISSION_REVENUE")).toBe(-500_000);

    const r = await readEveryConsumer(s);
    expect(r.row.isAgentSale).toBe(true);
    expect(r.row.supplierSettlement).toBe(13_000);
    expect(r.row.recognizedRevenue).toBe(-500);
    expect(r.report.totalRevenue).toBe(-500);
  });

  test("a v3 row completed before K was recorded keeps the sale-price ceiling: the same entitlement is withheld", async () => {
    const { s, saleId, sale } = await closeWithEntitlementAbovePrice("ceil2");
    await s.t.run((ctx) =>
      ctx.db.patch(saleId, { financedNetRevenue: { minor: sale.financedNetRevenue!.minor, currency: "JOD" } })
    );

    const r = await readEveryConsumer(s);
    expect(r.row.supplierSettlement).toBeNull();
  });
});

describe("SCRUM-411 - rows without the frozen net basis keep the legacy reading", () => {
  test("an owned sale with no frozen net revenue reads its sale price, as every v1/v2 row does", async () => {
    const s = await seed("leg1");
    const { saleId } = await closeDeal(s);
    await s.t.run((ctx) => ctx.db.patch(saleId, { financedNetRevenue: undefined }));

    const r = await readEveryConsumer(s);
    expect(r.row.recognizedRevenue).toBe(12_500);
    expect(r.row.netProfit).toBe(3_500);
  });

  test("a consigned sale with no frozen net revenue reads its frozen margin K - E", async () => {
    const s = await seed("leg2", true);
    const { saleId } = await closeDeal(s);
    await s.t.run((ctx) => ctx.db.patch(saleId, { financedNetRevenue: undefined }));

    const r = await readEveryConsumer(s);
    expect(r.row.recognizedRevenue).toBe(3_500);
    expect(r.row.netProfit).toBe(3_500);
  });

});

// A v3 sale that CARRIES a frozen net revenue was written by the one writer that
// derives it, so a value on the row that cannot be trusted is corruption of a
// figure the ledger already booked - not "no figure yet". Falling back to the
// gross would publish 12,500 beside a ledger that netted 11,125, which is the
// defect this file exists to close. Absent is legacy (above); present-but-invalid
// is WITHHELD: no revenue, no profit, counted as an unknown margin.
describe("SCRUM-411 - a frozen net revenue that is present but untrustworthy is withheld, never the gross", () => {
  const CASES: ReadonlyArray<{ tag: string; why: string; frozen: { minor: number; currency: string } }> = [
    { tag: "bad1", why: "malformed currency (the symbol, not the code)", frozen: { minor: 11_125_000, currency: "JD" } },
    { tag: "bad2", why: "empty currency", frozen: { minor: 11_125_000, currency: "" } },
    { tag: "bad3", why: "fractional minor units", frozen: { minor: 11_125_000.5, currency: "JOD" } },
    { tag: "bad4", why: "minor units beyond the safe-integer range", frozen: { minor: 2 ** 60, currency: "JOD" } },
    { tag: "bad5", why: "NaN", frozen: { minor: Number.NaN, currency: "JOD" } },
    // Valid ISO code, valid amount - and still not this organization's money.
    // 11,125,000 USD-cents is 111,250.00 USD; reading it as JOD fils would be a
    // thousand-fold lie and converting it would invent an exchange rate.
    { tag: "bad6", why: "a valid currency that is not the organization's (USD on a JOD org)", frozen: { minor: 11_125_000, currency: "USD" } },
  ];

  for (const c of CASES) {
    test(`owned: ${c.why} -> revenue and profit withheld, counted unknown`, async () => {
      const s = await seed(c.tag);
      const { saleId } = await closeDeal(s);
      await s.t.run((ctx) => ctx.db.patch(saleId, { financedNetRevenue: c.frozen }));

      // The books are untouched by the corrupt read-model: the ledger still nets 11,125.
      expect(await ledgerNetRevenueMinor(s, "SALES_REVENUE")).toBe(11_125_000);

      const r = await readEveryConsumer(s);
      expect(r.row.recognizedRevenue).toBeNull();
      expect(r.row.netProfit).toBeNull();
      expect(r.report.unknownMarginSaleCount).toBe(1);
      expect(r.report.totalRevenue).toBe(0);
      expect(r.report.totalProfit).toBe(0);
      expect(r.performance.totalRevenue).toBe(0);
      // Excluded from turnover (0) - never the gross 12,500, never a rescaled figure.
      expect(r.dashboardRevenue).toBe(0);
    });
  }

  test("consigned: a wrong-currency frozen net revenue is withheld, never the commission K - E", async () => {
    const s = await seed("bad7", true);
    const { saleId } = await closeDeal(s);
    await s.t.run((ctx) =>
      ctx.db.patch(saleId, { financedNetRevenue: { minor: 2_125_000, currency: "USD" } })
    );

    const r = await readEveryConsumer(s);
    expect(r.row.recognizedRevenue).toBeNull();
    expect(r.row.netProfit).toBeNull();
    expect(r.report.unknownMarginSaleCount).toBe(1);
    // The supplier's share is its own frozen fact and is unaffected.
    expect(r.row.supplierSettlement).toBe(9_000);
  });

  test("the valid, matching, frozen value still reads exactly (control for the withholding above)", async () => {
    const s = await seed("good1");
    const { saleId } = await closeDeal(s);
    await s.t.run((ctx) =>
      ctx.db.patch(saleId, { financedNetRevenue: { minor: 11_125_000, currency: "JOD" } })
    );
    const r = await readEveryConsumer(s);
    expect(r.row.recognizedRevenue).toBe(11_125);
    expect(r.report.unknownMarginSaleCount).toBe(0);
  });
});

describe("SCRUM-411 - cancelling the deal removes it from every report", () => {
  test("a cancelled owned deal contributes nothing and the ledger nets to zero", async () => {
    const s = await seed("can1");
    const { applicationId } = await closeDeal(s, { takeForwardBack: true });
    await s.owner.as.mutation(api.applications.cancelApplication, {
      orgId: s.orgId, applicationId, reason: "Customer withdrew.", idempotencyKey: crypto.randomUUID(),
    });

    const report = await s.owner.as.query(api.reports.getSalesAndProfitReport, { orgId: s.orgId, ...WINDOW() });
    expect(report.totalRevenue).toBe(0);
    expect(report.totalProfit).toBe(0);
    expect(report.sales).toHaveLength(0);
    expect(await ledgerNetRevenueMinor(s, "SALES_REVENUE")).toBe(0);
  });
});

// Keeps the contribution constant imported for the oracle comments above honest: D is the fixture's C.
test("the fixture's contribution is the 1,375 the hand figures subtract", () => {
  expect(C).toBe(1_375_000);
});
