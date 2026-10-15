/**
 * SCRUM-411 / SCRUM-407 c21031 - a financed CONSIGNED deal settled DIRECT to the
 * supplier is recognised under the same v3 convention as every other financed
 * deal.
 *
 * On this route the finance company pays the supplier its approved amount A
 * directly, so the dealership holds no finance receivable. What it earns is the
 * consideration K = A + R (R: the customer's gap owed to the showroom) less the
 * supplier's entitlement E, less the contribution D it owes the finance company:
 *
 *   Dr Receivable from suppliers   A - E   (what the supplier now owes the dealership)
 *   Dr Customer receivable         R
 *   Dr Consideration reductions    D       (contra-revenue)
 *       Cr Consignment commission  K - E
 *       Cr AP finance company      D       (forwarded to the company)
 *
 * Every expected figure is worked by hand from the fixture (A = 12,500 approved,
 * E = 9,000 supplier entitlement, D = 1,375 contribution, optional R = 500) -
 * never read back from the code under test - and each test reads the ledger
 * itself. The deal is dated on the evidenced handover, needs no legal invoice,
 * and refuses before its first write when that date has no open period.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex
 * runtime and not production data.
 */
import {
  C, G, closePriorYearPeriod, finalizeAsOwner, finalizeThenTakeForwardBack, payForwardAsOwner, readyDeal, refusalDataOf, refusalMessageOf,
  seedFinancedDealership,
} from "../test-utils/financedDealFixture";
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
const E = 9_000_000;
const R = 500_000;

async function seed(tag: string) {
  return await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: ALL_PERMS, label: "S411D", vinPrefix: "VIN411D",
    actors: {}, sourced: true,
  });
}
type Seeded = Awaited<ReturnType<typeof seed>>;

/** Net debit-positive movement per system account across the live events of a type. */
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

/** Net movement per account across EVERY journal line in the org, reversals included. */
async function everyLineNet(s: Seeded) {
  return await s.t.run(async (ctx) => {
    const entries = await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    const net = new Map<string, number>();
    for (const entry of entries) {
      const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id)).collect();
      for (const line of lines) {
        const account = await ctx.db.get(line.accountId);
        const key = account?.systemKey ?? String(line.accountId);
        net.set(key, (net.get(key) ?? 0) + line.debitMinor - line.creditMinor);
      }
    }
    return Object.fromEntries(net) as Record<string, number>;
  });
}

async function readyDirect(s: Seeded, over: { gapMinor?: number; contributionMinor?: number } = {}) {
  return await readyDeal(s, { ...over, route: "DIRECT_TO_SUPPLIER", deposit: false });
}

async function closeDirect(s: Seeded, over: { gapMinor?: number; contributionMinor?: number } = {}) {
  const { applicationId } = await readyDirect(s, over);
  await finalizeAsOwner(s, applicationId);
  const app = await s.t.run((ctx) => ctx.db.get(applicationId));
  const sale = await s.t.run((ctx) => ctx.db.get(app!.finalizedSaleId!));
  return { applicationId, saleId: app!.finalizedSaleId as Id<"sales">, app: app!, sale: sale! };
}

const WINDOW = () => ({ startDate: Date.now() - 30 * DAY, endDate: Date.now() + DAY });

describe("SCRUM-411 - direct-to-supplier financed sourced deal: plan v3 and its ledger", () => {
  test("A 12,500, E 9,000, D 1,375, R 0: posts the v3 shape; the claim is A - E and the net commission is 2,125", async () => {
    const s = await seed("d1");
    const { app, sale, saleId } = await closeDirect(s);

    // Recognised under plan v3, frozen on the application.
    expect(app.financedSalePlanVersion).toBe(3);
    expect(app.financedSaleRecognitionFingerprint).toMatch(/^v3;/);
    // The finance company pays the SUPPLIER: the dealership holds no finance receivable,
    // and D (the contribution) is the only thing it owes the company.
    expect(app.financedSaleNetReceivableMinor).toBe(0);
    expect(app.financeCompanyForwardDueMinor).toBe(C);
    expect(app.expectedDealerRemittanceMinor).toBe(0);

    // The ledger, hand-worked: Dr claim 3,500 + Dr contra 1,375 = Cr commission 3,500 + Cr AP-finance 1,375.
    const net = await netByAccount(s, "SALE_COMPLETED");
    expect(net.RECEIVABLE_FROM_SUPPLIERS).toBe(3_500_000);
    expect(net.SALES_CONSIDERATION_REDUCTIONS).toBe(C);
    expect(net.CONSIGNMENT_COMMISSION_REVENUE).toBe(-3_500_000);
    expect(net.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-C);
    // Nothing the through-dealership shape books: no finance receivable, no supplier payable, no customer receivable.
    expect(net.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES ?? 0).toBe(0);
    expect(net.ACCOUNTS_PAYABLE_SUPPLIERS ?? 0).toBe(0);
    expect(net.ACCOUNTS_RECEIVABLE_CUSTOMERS ?? 0).toBe(0);
    expect(Object.values(net).reduce((sum, amount) => sum + amount, 0)).toBe(0);

    // The supplier's claim is what reaches him less his entitlement: A - E, untouched by D (major units).
    const claims = await s.t.run((ctx) => ctx.db.query("vehicleSupplierReceivables").collect());
    expect(claims.filter((c) => c.saleId === saleId).map((c) => c.amountDue)).toEqual([3_500]);

    // No finance-company receivable document exists: the company does not owe the dealership A.
    const financeReceivables = await s.t.run((ctx) =>
      ctx.db.query("receivableDocuments").collect()
    );
    expect(financeReceivables.filter((r) => r.payerType === "FINANCE_COMPANY")).toEqual([]);

    // The frozen net revenue the reports read is K - E - D = 2,125.
    expect(sale.financedNetRevenue).toEqual({ minor: 2_125_000, currency: "JOD", considerationMinor: 12_500_000 });
  });

  test("no legal invoice is needed or invented: the deal closes with none, and the stored plan carries no invoice figure", async () => {
    const s = await seed("d2");
    const { app, sale } = await closeDirect(s);

    expect(app.legalInvoiceAmountMinor).toBeUndefined();
    expect(app.legalInvoiceNumber).toBeUndefined();
    expect(app.legalInvoiceDate).toBeUndefined();
    expect(app.legalInvoiceIssuedTo).toBeUndefined();
    expect(app.legalInvoiceIssuedBy).toBeUndefined();
    expect(app.legalInvoiceIssuerName).toBeUndefined();
    // The fingerprint names the server-derived consideration K, never an invoice figure L.
    expect(app.financedSaleRecognitionFingerprint).toContain("K12500000");
    expect(app.financedSaleRecognitionFingerprint).not.toMatch(/;L\d/);
    expect(sale.status).toBe("COMPLETED");
  });

  test("the sale is dated on the evidenced handover, not on the wall clock", async () => {
    const s = await seed("d3");
    const { applicationId } = await readyDirect(s);
    // Clamped to the seeded (current UTC) fiscal year: on Jan 1-3, now - 3 days is in the prior, unopened year.
    const handoverAt = Math.max(Date.now() - 3 * DAY, Date.UTC(s.fiscalYear, 0, 1));
    await s.t.run((ctx) => ctx.db.patch(applicationId, { vehicleHandoverAt: handoverAt }));
    await finalizeAsOwner(s, applicationId);
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    const sale = await s.t.run((ctx) => ctx.db.get(app!.finalizedSaleId!));
    expect(sale!.saleDate).toBe(handoverAt);
  });

  test("with a customer gap R 500: K 13,000, commission 4,000, customer owes 500, the claim stays 3,500, net 2,625", async () => {
    const s = await seed("d4");
    const { saleId, sale } = await closeDirect(s, { gapMinor: R });

    const net = await netByAccount(s, "SALE_COMPLETED");
    expect(net.RECEIVABLE_FROM_SUPPLIERS).toBe(3_500_000);
    expect(net.ACCOUNTS_RECEIVABLE_CUSTOMERS).toBe(R);
    expect(net.SALES_CONSIDERATION_REDUCTIONS).toBe(C);
    expect(net.CONSIGNMENT_COMMISSION_REVENUE).toBe(-4_000_000);
    expect(net.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-C);
    expect(Object.values(net).reduce((sum, amount) => sum + amount, 0)).toBe(0);

    const claims = await s.t.run((ctx) => ctx.db.query("vehicleSupplierReceivables").collect());
    expect(claims.filter((c) => c.saleId === saleId).map((c) => c.amountDue)).toEqual([3_500]);
    expect(sale.financedNetRevenue).toEqual({ minor: 2_625_000, currency: "JOD", considerationMinor: 13_000_000 });

    // The canonical customer invoice bills exactly the gap the ledger debits.
    const invoices = await s.t.run((ctx) => ctx.db.query("receivableDocuments").collect());
    const customerInvoice = invoices.find((r) => r.sourceType === "sales" && String(r.sourceId) === String(saleId));
    expect(customerInvoice?.originalAmountMinor).toBe(R);
  });

  test("no contribution and no gap: the journal is the plain claim and commission, with nothing owed onward", async () => {
    const s = await seed("d5");
    const { app } = await closeDirect(s, { contributionMinor: 0 });

    const net = await netByAccount(s, "SALE_COMPLETED");
    expect(net.RECEIVABLE_FROM_SUPPLIERS).toBe(3_500_000);
    expect(net.CONSIGNMENT_COMMISSION_REVENUE).toBe(-3_500_000);
    expect(net.SALES_CONSIDERATION_REDUCTIONS ?? 0).toBe(0);
    expect(net.ACCOUNTS_PAYABLE_FINANCE_COMPANIES ?? 0).toBe(0);
    expect(app.financeCompanyForwardDueMinor).toBe(0);
  });
});

describe("SCRUM-411 - direct route: every report reads the ledger's net commission", () => {
  test("A 12,500, E 9,000, D 1,375: ledger net commission 2,125; sales report, performance and dashboard say 2,125", async () => {
    const s = await seed("r1");
    await closeDirect(s);

    const net = await netByAccount(s, "SALE_COMPLETED");
    // `0 - x`: an empty ledger must read +0, not -0.
    const ledgerNet = 0 - (net.CONSIGNMENT_COMMISSION_REVENUE ?? 0) - (net.SALES_CONSIDERATION_REDUCTIONS ?? 0);
    expect(ledgerNet).toBe(2_125_000);

    const report = await s.owner.as.query(api.reports.getSalesAndProfitReport, { orgId: s.orgId, ...WINDOW() });
    const performance = await s.owner.as.query(api.reports.getSalespersonPerformance, { orgId: s.orgId, ...WINDOW() });
    const dashboard = await s.owner.as.query(api.dashboard.stats, { orgId: s.orgId, timeRange: "ALL_TIME" });
    expect(report.sales[0].isAgentSale).toBe(true);
    expect(report.sales[0].recognizedRevenue).toBe(2_125);
    expect(report.sales[0].netProfit).toBe(2_125);
    expect(report.totalRevenue).toBe(2_125);
    expect(report.totalProfit).toBe(2_125);
    expect(performance[0].totalRevenue).toBe(2_125);
    expect(dashboard.salesVolumeThisMonth).toBe(2_125);
    // What belongs to the supplier is unchanged by the showroom's contribution.
    expect(report.sales[0].supplierSettlement).toBe(9_000);
  });

  test("with R 500 the reports say 2,625, the ledger's figure", async () => {
    const s = await seed("r2");
    await closeDirect(s, { gapMinor: R });
    const report = await s.owner.as.query(api.reports.getSalesAndProfitReport, { orgId: s.orgId, ...WINDOW() });
    expect(report.sales[0].recognizedRevenue).toBe(2_625);
    expect(report.totalProfit).toBe(2_625);
  });

  test("an erased legacy margin does not hide the ledger net, but with the net erased too the earning is withheld", async () => {
    const s = await seed("r3");
    const { saleId } = await closeDirect(s);

    await s.t.run((ctx) => ctx.db.patch(saleId, { consignedMarginMinor: undefined }));
    const survived = await s.owner.as.query(api.reports.getSalesAndProfitReport, { orgId: s.orgId, ...WINDOW() });
    expect(survived.totalProfit).toBe(2_125);

    await s.t.run((ctx) => ctx.db.patch(saleId, { financedNetRevenue: undefined }));
    const withheld = await s.owner.as.query(api.reports.getSalesAndProfitReport, { orgId: s.orgId, ...WINDOW() });
    expect(withheld.sales[0].recognizedRevenue).toBeNull();
    expect(withheld.totalProfit).toBe(0);
  });

  test("a present-but-invalid frozen net withholds the earning instead of falling back to the gross", async () => {
    const s = await seed("r4");
    const { saleId } = await closeDirect(s);

    await s.t.run((ctx) => ctx.db.patch(saleId, { financedNetRevenue: { minor: 2_125_000.5, currency: "JOD" } }));
    const report = await s.owner.as.query(api.reports.getSalesAndProfitReport, { orgId: s.orgId, ...WINDOW() });
    expect(report.sales[0].recognizedRevenue).toBeNull();
    expect(report.totalProfit).toBe(0);

    await s.t.run((ctx) => ctx.db.patch(saleId, { financedNetRevenue: { minor: 2_125_000, currency: "USD" } }));
    const wrongCurrency = await s.owner.as.query(api.reports.getSalesAndProfitReport, { orgId: s.orgId, ...WINDOW() });
    expect(wrongCurrency.sales[0].recognizedRevenue).toBeNull();
  });
});

describe("SCRUM-411 - direct route: refusals happen before the first write", () => {
  test("a direct-to-supplier handover dated in a CLOSED accounting period refuses finalize, and nothing is written", async () => {
    const s = await seed("p1");
    const { applicationId } = await readyDirect(s);
    // A real prior-year period, opened and then closed through the accounting-period mutations.
    const { periodId, handoverAt } = await closePriorYearPeriod(s);
    expect((await s.t.run((ctx) => ctx.db.get(periodId)))?.status).toBe("CLOSED");
    await s.t.run((ctx) => ctx.db.patch(applicationId, { vehicleHandoverAt: handoverAt }));

    const refusal = await refusalDataOf(
      s.owner.as.mutation(api.applications.finalizeDeal, {
        idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId,
      })
    );
    expect(refusal).toEqual({
      code: "RECOGNITION_PERIOD_NOT_OPEN",
      message:
        "The vehicle was handed over on a date that has no open accounting period, so the sale cannot be recognised. Open or reopen that period before finalizing.",
    });

    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app!.status).not.toBe("CLOSED");
    expect(app!.finalizedSaleId).toBeUndefined();
    expect(await s.t.run((ctx) => ctx.db.query("sales").collect())).toEqual([]);
    expect(await s.t.run((ctx) => ctx.db.query("vehicleSupplierReceivables").collect())).toEqual([]);
    expect(await s.t.run((ctx) => ctx.db.query("accountingEvents").collect())).toEqual([]);
    expect(await s.t.run((ctx) => ctx.db.query("journalEntries").collect())).toEqual([]);
    expect(await s.t.run((ctx) => ctx.db.query("journalLines").collect())).toEqual([]);
  });

  test("a deal that holds a reservation deposit finalizes on this route once the deposit and contribution are paid", async () => {
    // Owner rulings SCRUM-407 c21031/c21033: the deposit is forwarded to the finance
    // company with the contribution, never revenue. Hand-worked from A 12,500, E 9,000,
    // H 200, D 1,375 (R 0):
    //   Dr claim A - E 3,500 + Dr deposit liability 200 + Dr contra-revenue 1,375 = 5,075
    //   Cr commission A + R - E 3,500 + Cr AP-finance H + D 1,575              = 5,075
    const s = await seed("p2");
    const { applicationId } = await readyDeal(s, { route: "DIRECT_TO_SUPPLIER" });
    await finalizeAsOwner(s, applicationId);
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app!.status).toBe("CLOSED");
    expect(app!.financeCompanyForwardDueMinor).toBe(1_575_000);
    expect(app!.financedSaleNetReceivableMinor).toBe(0);

    const net = await netByAccount(s, "SALE_COMPLETED");
    expect(net.RECEIVABLE_FROM_SUPPLIERS).toBe(3_500_000);
    expect(net.CUSTOMER_DEPOSITS_LIABILITY).toBe(200_000);
    expect(net.SALES_CONSIDERATION_REDUCTIONS).toBe(C);
    expect(net.CONSIGNMENT_COMMISSION_REVENUE).toBe(-3_500_000);
    expect(net.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-1_575_000);
    expect(net.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES ?? 0).toBe(0);
    expect(Object.values(net).reduce((sum, amount) => sum + amount, 0)).toBe(0);

    // The payment made before the sale cleared exactly what the sale then owed onward.
    const forward = await netByAccount(s, "FINANCE_COMPANY_FORWARD_PAID");
    expect(forward.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(1_575_000);
    const all = await everyLineNet(s);
    expect(all.ACCOUNTS_PAYABLE_FINANCE_COMPANIES ?? 0).toBe(0);
  });

  test("the same deal is refused until the deposit and contribution are on the books, and nothing is written", async () => {
    const s = await seed("p2b");
    const { applicationId } = await readyDeal(s, { route: "DIRECT_TO_SUPPLIER" });
    const refusal = await refusalDataOf(
      s.owner.as.mutation(api.applications.finalizeDeal, {
        idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId,
      })
    );
    expect(refusal?.code).toBe("FORWARD_FINALIZE_UNPAID");
    expect(refusal?.message).toMatch(/have not been paid yet/i);
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app!.status).not.toBe("CLOSED");
    expect(await s.t.run((ctx) => ctx.db.query("sales").collect())).toEqual([]);
    expect(await s.t.run((ctx) => ctx.db.query("journalLines").collect())).toEqual([]);
  });

  test("an approved amount below the supplier's entitlement still refuses (the supplier would be short)", async () => {
    const s = await seed("p3");
    const { applicationId } = await readyDirect(s);
    await s.t.run((ctx) => ctx.db.patch(applicationId, { approvedDealerPurchaseAmountMinor: E - 1_000 }));
    const refusal = await refusalMessageOf(
      s.owner.as.mutation(api.applications.finalizeDeal, {
        idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId,
      })
    );
    expect(refusal).not.toBeNull();
    const sales = await s.t.run((ctx) => ctx.db.query("sales").collect());
    expect(sales).toEqual([]);
  });
});

describe("SCRUM-411 - direct route: cancellation mirrors the posted plan", () => {
  test("cancelling the closed deal reverses the v3 journal exactly and cancels the supplier claim", async () => {
    const s = await seed("c1");
    // A paid forward blocks the cancel (it must be reported returned first), so the
    // payment is taken back before the sale is cancelled; the payable then nets to nothing.
    const { applicationId } = await readyDirect(s, { gapMinor: R });
    await finalizeThenTakeForwardBack(s, applicationId);
    const closed = await s.t.run((ctx) => ctx.db.get(applicationId));
    const saleId = closed!.finalizedSaleId as Id<"sales">;

    await s.owner.as.mutation(api.applications.cancelApplication, {
      orgId: s.orgId, applicationId, reason: "Customer withdrew.", idempotencyKey: crypto.randomUUID(),
    });

    const sale = await s.t.run((ctx) => ctx.db.get(saleId));
    expect(sale!.status).toBe("CANCELLED");
    const claims = await s.t.run((ctx) => ctx.db.query("vehicleSupplierReceivables").collect());
    expect(claims.filter((c) => c.saleId === saleId).every((c) => c.status === "CANCELLED")).toBe(true);

    // The original entry and its reversal net to nothing on every account the plan touched.
    const all = await everyLineNet(s);
    for (const key of [
      "RECEIVABLE_FROM_SUPPLIERS", "ACCOUNTS_RECEIVABLE_CUSTOMERS", "SALES_CONSIDERATION_REDUCTIONS",
      "CONSIGNMENT_COMMISSION_REVENUE", "ACCOUNTS_PAYABLE_FINANCE_COMPANIES",
    ]) {
      expect(all[key] ?? 0, key).toBe(0);
    }
  });
});

describe("SCRUM-411 - direct route: the supplier advice and the showroom's payment to the finance company", () => {
  type AppId = Id<"financeApplications">;
  const adviceArgs = (s: Seeded, applicationId: AppId) => ({
    orgId: s.orgId, applicationId, disbursedAmountMinor: G, reference: "WIRE-411", idempotencyKey: crypto.randomUUID(),
  });
  const confirmAdvice = (s: Seeded, applicationId: AppId) =>
    s.owner.as.mutation(api.applications.confirmSupplierDisbursement, adviceArgs(s, applicationId));
  const voidForward = (s: Seeded, applicationId: AppId, forwardId: Id<"financeCompanyForwards">) =>
    s.owner.as.mutation(api.financeCompanyForward.reverseFinanceCompanyForward, {
      orgId: s.orgId, applicationId, forwardId, reason: "Recorded in error.", idempotencyKey: crypto.randomUUID(),
    });
  const returnForward = (s: Seeded, applicationId: AppId, forwardId: Id<"financeCompanyForwards">) =>
    s.owner.as.mutation(api.financeCompanyForward.reportFinanceCompanyForwardReturned, {
      orgId: s.orgId, applicationId, forwardId, reason: "The company sent it back.", idempotencyKey: crypto.randomUUID(),
    });
  const cancelDeal = (s: Seeded, applicationId: AppId) =>
    s.owner.as.mutation(api.applications.cancelApplication, {
      orgId: s.orgId, applicationId, reason: "Customer withdrew.", idempotencyKey: crypto.randomUUID(),
    });
  const transferConfirmed = async (s: Seeded, applicationId: AppId) =>
    (await s.owner.as.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId }))?.forward.transferConfirmed;
  const forwardRows = (s: Seeded, applicationId: AppId) =>
    s.t.run((ctx) =>
      ctx.db.query("financeCompanyForwards").withIndex("by_org_application", (q) => q.eq("orgId", s.orgId).eq("applicationId", applicationId)).take(10)
    );
  /** Everything a refused or evidence-only call must leave untouched: the ledger, its events and the forward rows. */
  const books = async (s: Seeded, applicationId: AppId) => ({
    ledger: await everyLineNet(s),
    events: (await s.t.run((ctx) => ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect())).length,
    forwards: await forwardRows(s, applicationId),
  });
  /** A finalized direct deal whose sale was cancelled by `cancelApplication` after its payment was recovered. */
  const cancelledAfterFinalize = async (
    s: Seeded,
    recover: (s: Seeded, applicationId: AppId, forwardId: Id<"financeCompanyForwards">) => Promise<unknown>
  ) => {
    const { applicationId } = await readyDirect(s, { gapMinor: R });
    const forwardId = await payForwardAsOwner(s, applicationId);
    await finalizeAsOwner(s, applicationId, { payForward: false });
    await recover(s, applicationId, forwardId!);
    await cancelDeal(s, applicationId);
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app!.status).toBe("CANCELLED");
    const saleId = app!.finalizedSaleId as Id<"sales">;
    expect((await s.t.run((ctx) => ctx.db.get(saleId)))!.status).toBe("CANCELLED");
    return { applicationId, saleId };
  };

  test("after the finance company paid the supplier, the showroom's payment can no longer be voided, and nothing changes", async () => {
    const s = await seed("v1");
    const { applicationId } = await readyDirect(s);
    const forwardId = await payForwardAsOwner(s, applicationId);
    expect(forwardId).not.toBeNull();
    await finalizeAsOwner(s, applicationId, { payForward: false });
    await confirmAdvice(s, applicationId);
    // The direct route confirms its transfer through the supplier advice, not through `disbursedAt`.
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app!.disbursedAt).toBeUndefined();
    expect(app!.supplierDisbursementConfirmedAt).toBeDefined();
    // On a live deal the company's payment to the supplier moves settlement to EXPECTED (never settled).
    expect(app!.settlementStatus).toBe("EXPECTED");
    // The cockpit offers "report returned", not "void", for the same reason.
    expect(await transferConfirmed(s, applicationId)).toBe(true);

    const before = await books(s, applicationId);
    expect(before.forwards.every((row) => row.reversalRequestedAt === undefined)).toBe(true);
    expect(await refusalMessageOf(voidForward(s, applicationId, forwardId!))).toMatch(/already confirmed/i);
    expect(await books(s, applicationId)).toEqual(before);

    // The way out the refusal names stays open: the company can still send the money back.
    await returnForward(s, applicationId, forwardId!);
    expect((await forwardRows(s, applicationId)).some((row) => row.reversalRequestedAt !== undefined)).toBe(true);
  });

  test("control: before the advice is recorded the same payment can still be voided", async () => {
    const s = await seed("v1c");
    const { applicationId } = await readyDirect(s);
    const forwardId = await payForwardAsOwner(s, applicationId);
    await finalizeAsOwner(s, applicationId, { payForward: false });
    expect(await transferConfirmed(s, applicationId)).toBe(false);
    await voidForward(s, applicationId, forwardId!);
    expect((await forwardRows(s, applicationId)).some((row) => row.reversalRequestedAt !== undefined)).toBe(true);
  });

  test.each([
    ["taken back", "v2a", voidForward],
    ["reported returned", "v2b", returnForward],
  ] as const)(
    "a late advice on a cancelled sale whose payment was %s is still recorded as evidence, and revives nothing",
    async (_label, tag, recover) => {
      const s = await seed(tag);
      const { applicationId, saleId } = await cancelledAfterFinalize(s, recover);

      const before = await books(s, applicationId);
      await confirmAdvice(s, applicationId);

      // The advice is on file for the approved amount, agreeing with it.
      const app = await s.t.run((ctx) => ctx.db.get(applicationId));
      expect(app!.supplierDisbursementConfirmedAt).toBeDefined();
      // The cancelled deal's settlement status stays where `cancelApplication` put it; the evidence does not reopen it.
      expect(app!.settlementStatus).toBe("NOT_READY");
      expect(app!.status).toBe("CANCELLED");
      expect(app!.supplierDisbursedAmountMinor).toBe(G);
      expect(app!.supplierDisbursementReference).toBe("WIRE-411");
      expect(app!.supplierDisbursementStatus).toBe("CONFIRMED");
      // Nothing is revived: the sale stays cancelled, no payment or journal is written, the supplier claim stays cancelled.
      expect((await s.t.run((ctx) => ctx.db.get(saleId)))!.status).toBe("CANCELLED");
      expect(await books(s, applicationId)).toEqual(before);
      const claims = await s.t.run((ctx) =>
        ctx.db.query("vehicleSupplierReceivables").withIndex("by_org_sale", (q) => q.eq("orgId", s.orgId).eq("saleId", saleId)).collect()
      );
      expect(claims.length).toBeGreaterThan(0);
      expect(claims.every((c) => c.status === "CANCELLED")).toBe(true);
      // Nobody is sent to reconcile a deal that no longer exists; the exception has its own owner.
      const notices = await s.t.run((ctx) => ctx.db.query("notifications").collect());
      expect(notices.filter((n) => n.type === "application.settlement_advice_discrepancy")).toHaveLength(0);
      expect(notices.filter((n) => n.type === "application.payment_on_cancelled_deal").length).toBeGreaterThan(0);
    }
  );

  test("control: on a LIVE sale the advice still needs the showroom's payment on the books", async () => {
    const s = await seed("v2c");
    const { applicationId } = await readyDirect(s);
    await finalizeThenTakeForwardBack(s, applicationId);

    expect((await refusalDataOf(confirmAdvice(s, applicationId)))?.code).toBe("FORWARD_TRANSFER_UNPAID");
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app!.supplierDisbursementConfirmedAt).toBeUndefined();
  });

  test("control: an application cancelled BEFORE it was finalized has no sale, and an advice on it is refused", async () => {
    const s = await seed("v2n");
    const { applicationId } = await readyDirect(s);
    await cancelDeal(s, applicationId);
    const cancelled = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(cancelled!.status).toBe("CANCELLED");
    expect(cancelled!.finalizedSaleId).toBeUndefined();

    expect(await refusalMessageOf(confirmAdvice(s, applicationId))).toMatch(/once the deal is finalized/i);
    const after = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(after!.supplierDisbursementConfirmedAt).toBeUndefined();
  });

  test("another organization cannot record an advice on a cancelled deal, nor lend it a cancelled sale", async () => {
    const s = await seed("v2t");
    const { applicationId, saleId } = await cancelledAfterFinalize(s, voidForward);
    const otherOrgId = await s.t.run(async (ctx) => {
      const orgId = await ctx.db.insert("organizations", { name: "S411D other", createdAt: Date.now() });
      await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
      const userId = await ctx.db.insert("users", { clerkId: "s411d_other", email: "s411d.other@example.com", name: "other" });
      const roleId = await ctx.db.insert("roles", { orgId, name: "OWNER", permissions: [...ALL_PERMS], isSystemOwnerRole: true });
      await ctx.db.insert("memberships", { orgId, userId, roleId });
      return orgId;
    });
    const outsider = s.t.withIdentity({ subject: "s411d_other", clerkId: "s411d_other" });
    expect(
      await refusalMessageOf(
        outsider.mutation(api.applications.confirmSupplierDisbursement, { ...adviceArgs(s, applicationId), orgId: otherOrgId })
      )
    ).toContain("Application not found");

    // A cancelled sale only makes a CANCELLED application eligible when it is this organization's own.
    await s.t.run((ctx) => ctx.db.patch(saleId, { orgId: otherOrgId }));
    expect(await refusalMessageOf(confirmAdvice(s, applicationId))).toMatch(/once the deal is finalized/i);
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app!.supplierDisbursementConfirmedAt).toBeUndefined();
  });
});

describe("SCRUM-411 - direct route: an optional genuine invoice must describe THIS deal", () => {
  const baseInvoice = {
    legalInvoiceAmountMinor: G,
    legalInvoiceNumber: "INV-2026-001",
    issuedTo: "FINANCE_COMPANY" as const,
    issuedBy: "THIRD_PARTY" as const,
    issuerName: "Amman Importer Co",
  };
  const record = (s: Seeded, applicationId: Id<"financeApplications">, over: Record<string, unknown> = {}) =>
    s.owner.as.mutation(api.financeDealCosts.recordLegalInvoice, {
      orgId: s.orgId, applicationId, legalInvoiceDate: Date.now() - DAY, ...baseInvoice, ...over,
    } as never);

  test("an importer's invoice to the finance company for the approved amount is accepted as evidence only", async () => {
    const s = await seed("i1");
    const { applicationId } = await readyDirect(s);
    expect(await refusalMessageOf(record(s, applicationId))).toBeNull();
    await finalizeAsOwner(s, applicationId);
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    // Evidence only: the consideration is still the server's K = A + R.
    expect(app!.financedSaleRecognitionFingerprint).toContain("K12500000");
    expect(app!.legalInvoiceIssuedBy).toBe("THIRD_PARTY");
    expect(app!.legalInvoiceIssuerName).toBe("Amman Importer Co");
  });

  test("an importer's invoice cannot be recorded as the dealership's", async () => {
    const s = await seed("i2");
    const { applicationId } = await readyDirect(s);
    const refusal = await refusalMessageOf(record(s, applicationId, { issuedBy: "DEALERSHIP", issuerName: undefined }));
    expect(refusal).not.toBeNull();
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app!.legalInvoiceAmountMinor).toBeUndefined();
  });

  test("an invoice with no issuer defaulted in is not treated as the dealership's either", async () => {
    const s = await seed("i3");
    const { applicationId } = await readyDirect(s);
    const refusal = await refusalMessageOf(record(s, applicationId, { issuedBy: undefined, issuerName: undefined }));
    expect(refusal).not.toBeNull();
  });

  test("a third-party invoice must name its issuer: nothing is fabricated", async () => {
    const s = await seed("i4");
    const { applicationId } = await readyDirect(s);
    const refusal = await refusalMessageOf(record(s, applicationId, { issuerName: "   " }));
    expect(refusal).not.toBeNull();
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app!.legalInvoiceIssuerName).toBeUndefined();
  });

  test("an invoice addressed to the customer is refused", async () => {
    const s = await seed("i5");
    const { applicationId } = await readyDirect(s);
    expect(await refusalMessageOf(record(s, applicationId, { issuedTo: "CUSTOMER" }))).not.toBeNull();
  });

  test("an invoice for any amount but the approved one is refused", async () => {
    const s = await seed("i6");
    const { applicationId } = await readyDirect(s);
    expect(await refusalMessageOf(record(s, applicationId, { legalInvoiceAmountMinor: G + 1_000 }))).not.toBeNull();
    expect(await refusalMessageOf(record(s, applicationId, { legalInvoiceAmountMinor: G - 1_000 }))).not.toBeNull();
  });

  test("a wrong invoice already on the record blocks finalize at LEGAL_INVOICE_RECORDED, before any write", async () => {
    const s = await seed("i7");
    const { applicationId } = await readyDirect(s);
    // A row written outside the door (raw edit, or a legacy row): a dealership-issued invoice on a consigned car.
    await s.t.run((ctx) =>
      ctx.db.patch(applicationId, {
        legalInvoiceAmountMinor: G, legalInvoiceNumber: "X-1", legalInvoiceDate: Date.now() - DAY,
        legalInvoiceIssuedTo: "FINANCE_COMPANY", legalInvoiceIssuedBy: "DEALERSHIP",
      })
    );
    const refusal = await refusalMessageOf(
      s.owner.as.mutation(api.applications.finalizeDeal, {
        idempotencyKey: crypto.randomUUID(), orgId: s.orgId, applicationId,
      })
    );
    expect(refusal).not.toBeNull();
    const sales = await s.t.run((ctx) => ctx.db.query("sales").collect());
    expect(sales).toEqual([]);
  });
});
