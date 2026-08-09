/**
 * What a consigned sale contributes to the numbers a dealership reads.
 *
 * The dealership never owned the car, so its sticker price is not turnover. It
 * is still a real fact — the size of the deal that was arranged — so it is
 * reported alongside revenue rather than folded into it, together with the
 * supplier's share and the dealership's own margin.
 *
 * The requirement these tests exist for: a corrected historical agent sale and
 * a newly-posted one must report identically. They do, and for a stronger
 * reason than the migration running correctly — these figures are derived from
 * the sale and the vehicle, never from whichever basis the ledger happens to
 * carry, so they agree before the migration runs as well as after.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { saleEconomics } from "./utils/vehicleOwnership";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const PERMS = [
  "view:sales", "create:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "manage:finance", "view:finance", "view:reports",
  "view:commissions", "manage:commissions",
];

const SALE_PRICE = 12_500;
const ENTITLEMENT = 9_500;
const MARGIN = SALE_PRICE - ENTITLEMENT;

const OWNED_PRICE = 8_000;
const OWNED_COST = 6_000;
const OWNED_MARGIN = OWNED_PRICE - OWNED_COST;

/**
 * `withAccounting: false` leaves the org with no chart and no open period —
 * the state in which `postOrEnqueue` queues the event instead of posting it,
 * so no posting rule is evaluated at completion time. It is not an exotic
 * fixture: it is every org that has not finished accounting setup.
 */
async function seedDealer(tag: string, opts: { withAccounting?: boolean } = {}) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Rep ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "Rep User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  if (opts.withAccounting !== false) {
    await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

    const fiscalYear = new Date().getUTCFullYear();
    await asUser.mutation(api.accountingPeriods.create, {
      orgId,
      startDate: Date.UTC(fiscalYear, 0, 1),
      endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
      fiscalYear, periodNumber: 1,
    });
    const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
    await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  }

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag })
  );

  return { t, orgId, userId, asUser, customerId };
}

async function sellConsigned(s: Awaited<ReturnType<typeof seedDealer>>, vin: string) {
  const vehicleId = await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin, make: "Toyota", model: "Camry", year: 2024, mileage: 10,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: SALE_PRICE,
      status: "AVAILABLE", sourceType: "SOURCED",
      sourcedFromName: "Amman Importer Co", sourceCost: ENTITLEMENT,
    })
  );
  return await s.asUser.mutation(api.sales.create, {
    orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
    salePrice: SALE_PRICE, saleDate: Date.now(), status: "COMPLETED" as const,
  });
}

async function sellOwned(s: Awaited<ReturnType<typeof seedDealer>>, vin: string) {
  const vehicleId = await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin, make: "Kia", model: "Rio", year: 2023, mileage: 5,
      color: "Red", fuelType: "Gas", transmission: "Auto", sellingPrice: OWNED_PRICE,
      status: "AVAILABLE", sourceType: "STOCK", purchasePrice: OWNED_COST,
    })
  );
  return await s.asUser.mutation(api.sales.create, {
    orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
    salePrice: OWNED_PRICE, saleDate: Date.now(), status: "COMPLETED" as const,
  });
}

/** A consigned sale still carrying the OLD principal posting, as production does today. */
async function sellConsignedAsLegacyPrincipal(
  s: Awaited<ReturnType<typeof seedDealer>>,
  vin: string
) {
  const vehicleId = await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin, make: "Toyota", model: "Camry", year: 2024, mileage: 10,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: SALE_PRICE,
      status: "SOLD", sourceType: "SOURCED",
      sourcedFromName: "Amman Importer Co", sourceCost: ENTITLEMENT,
    })
  );
  return await s.t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice: SALE_PRICE, saleDate: Date.now(), status: "COMPLETED",
    })
  );
}

function range() {
  const now = Date.now();
  return { startDate: now - 86_400_000, endDate: now + 86_400_000 };
}

describe("the economics split", () => {
  test("an agent sale recognizes the margin as revenue and no cost at all", () => {
    const e = saleEconomics({
      salePrice: SALE_PRICE,
      vehicle: { sourceType: "SOURCED" },
      capitalizedCost: ENTITLEMENT,
    });
    expect(e.isAgentSale).toBe(true);
    expect(e.grossTransactionValue).toBe(SALE_PRICE);
    expect(e.supplierSettlement).toBe(ENTITLEMENT);
    expect(e.dealershipMargin).toBe(MARGIN);
    expect(e.recognizedRevenue).toBe(MARGIN);
    // There is no cost of a car you never bought.
    expect(e.recognizedCost).toBe(0);
  });

  test("an owned sale is unchanged — price is revenue, cost is cost", () => {
    const e = saleEconomics({
      salePrice: OWNED_PRICE,
      vehicle: { sourceType: "STOCK" },
      capitalizedCost: OWNED_COST,
    });
    expect(e.isAgentSale).toBe(false);
    expect(e.recognizedRevenue).toBe(OWNED_PRICE);
    expect(e.recognizedCost).toBe(OWNED_COST);
    expect(e.dealershipMargin).toBe(OWNED_MARGIN);
    expect(e.supplierSettlement).toBe(0);
  });

  test("margin is the same number under both bases, which is why profit never moves", () => {
    for (const sourceType of ["SOURCED", "STOCK"] as const) {
      const e = saleEconomics({
        salePrice: SALE_PRICE,
        vehicle: { sourceType },
        capitalizedCost: ENTITLEMENT,
      });
      expect(e.dealershipMargin).toBe(MARGIN);
      // ...and revenue less cost always equals it, whichever way it is split.
      expect(e.recognizedRevenue - e.recognizedCost).toBe(MARGIN);
    }
  });
});

describe("turnover excludes agent gross", () => {
  test("a consigned sale contributes its margin to revenue, not its price", async () => {
    const s = await seedDealer("turnover");
    await sellConsigned(s, "VINREP1");

    const report = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId, ...range(),
    });

    expect(report.totalRevenue).toBe(MARGIN);
    expect(report.totalCost).toBe(0);
    expect(report.totalProfit).toBe(MARGIN);
    // The deal is still visible at full ticket, just not as turnover.
    expect(report.totalGrossTransactionValue).toBe(SALE_PRICE);
    expect(report.totalSupplierSettlement).toBe(ENTITLEMENT);
    expect(report.agentSaleCount).toBe(1);
  });

  test("an owned sale is completely unaffected", async () => {
    const s = await seedDealer("owned");
    await sellOwned(s, "VINREP2");

    const report = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId, ...range(),
    });

    expect(report.totalRevenue).toBe(OWNED_PRICE);
    expect(report.totalCost).toBe(OWNED_COST);
    expect(report.totalProfit).toBe(OWNED_MARGIN);
    // With nothing consigned, gross transaction value IS turnover.
    expect(report.totalGrossTransactionValue).toBe(OWNED_PRICE);
    expect(report.totalSupplierSettlement).toBe(0);
    expect(report.agentSaleCount).toBe(0);
  });

  test("a mixed month adds up on both measures without double counting", async () => {
    const s = await seedDealer("mixed");
    await sellConsigned(s, "VINREP3");
    await sellOwned(s, "VINREP4");

    const report = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId, ...range(),
    });

    expect(report.totalRevenue).toBe(MARGIN + OWNED_PRICE);
    expect(report.totalCost).toBe(OWNED_COST);
    expect(report.totalProfit).toBe(MARGIN + OWNED_MARGIN);
    expect(report.totalGrossTransactionValue).toBe(SALE_PRICE + OWNED_PRICE);
    expect(report.totalSupplierSettlement).toBe(ENTITLEMENT);
    // Profit is still revenue less cost, so the split cannot have leaked.
    expect(report.totalRevenue - report.totalCost).toBe(report.totalProfit);
  });

  test("a salesperson is not credited with turnover they never turned over", async () => {
    const s = await seedDealer("rep");
    await sellConsigned(s, "VINREP5");

    const rows = await s.asUser.query(api.reports.getSalespersonPerformance, {
      orgId: s.orgId, ...range(),
    });
    const row = rows.find((r) => r.userId === s.userId)!;

    // Ranking reps on 12,500 of someone else's car would put this one above a
    // colleague who earned twice the margin on stock the dealership owned.
    expect(row.totalRevenue).toBe(MARGIN);
    expect(row.totalProfit).toBe(MARGIN);
    expect(row.totalGrossTransactionValue).toBe(SALE_PRICE);
  });
});

describe("historical and new agent sales report identically", () => {
  test("a legacy principal-posted sale already reports as agent basis", async () => {
    // The reports derive from the sale and the vehicle, not from the ledger, so
    // an uncorrected historical sale reports the same as a new one. That is the
    // point: reporting is fixed for every consigned sale the moment this ships,
    // whether or not the GL migration has run against that row yet.
    const legacy = await seedDealer("legacy");
    await sellConsignedAsLegacyPrincipal(legacy, "VINREP6");
    const fresh = await seedDealer("fresh");
    await sellConsigned(fresh, "VINREP7");

    const legacyReport = await legacy.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: legacy.orgId, ...range(),
    });
    const freshReport = await fresh.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: fresh.orgId, ...range(),
    });

    expect(legacyReport.totalRevenue).toBe(freshReport.totalRevenue);
    expect(legacyReport.totalCost).toBe(freshReport.totalCost);
    expect(legacyReport.totalProfit).toBe(freshReport.totalProfit);
    expect(legacyReport.totalGrossTransactionValue).toBe(freshReport.totalGrossTransactionValue);
    expect(legacyReport.totalSupplierSettlement).toBe(freshReport.totalSupplierSettlement);
  });

  test("running the GL migration does not move the reported figures either", async () => {
    const s = await seedDealer("postMig");
    await sellConsignedAsLegacyPrincipal(s, "VINREP8");

    const before = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId, ...range(),
    });
    await s.t.mutation(internal.migrateConsignedSaleBasis.migrateConsignedSaleBasis, {
      orgId: s.orgId,
    });
    const after = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId, ...range(),
    });

    expect(after.totalRevenue).toBe(before.totalRevenue);
    expect(after.totalCost).toBe(before.totalCost);
    expect(after.totalProfit).toBe(before.totalProfit);
    expect(after.totalGrossTransactionValue).toBe(before.totalGrossTransactionValue);
    expect(after.totalSupplierSettlement).toBe(before.totalSupplierSettlement);
  });
});

describe("per-sale detail", () => {
  test("each agent row carries its gross, the supplier's share and the margin", async () => {
    const s = await seedDealer("detail");
    await sellConsigned(s, "VINREP9");

    const report = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId, ...range(),
    });
    const row = report.sales[0]!;

    expect(row.isAgentSale).toBe(true);
    expect(row.settlementRoute).toBe("THROUGH_DEALERSHIP");
    expect(row.grossTransactionValue).toBe(SALE_PRICE);
    expect(row.supplierSettlement).toBe(ENTITLEMENT);
    expect(row.recognizedRevenue).toBe(MARGIN);
    expect(row.netProfit).toBe(MARGIN);
    // No cost of sales on a car the dealership never bought, even though the
    // vehicle's own cost basis is still shown for reference.
    expect(row.totalCost).toBe(0);
    expect(row.vehicleCost).toBe(ENTITLEMENT);
  });
});

describe("every revenue consumer agrees on the same month", () => {
  test("sales report, P&L and dashboard all report the margin, never the gross", async () => {
    // The requirement in one assertion: a sourced month must not report 3,000
    // in Sales Reports and 12,500 in the P&L or on the dashboard. Before this,
    // `createSaleTransaction` wrote a VEHICLE_SALE row for the gross and
    // `getProfitAndLoss` summed that category as revenue, so the two disagreed
    // by the supplier's entire share.
    const s = await seedDealer("crossAll");
    await sellConsigned(s, "VINREPX1");
    await sellOwned(s, "VINREPX2");

    const expectedTurnover = MARGIN + OWNED_PRICE;
    const expectedGross = SALE_PRICE + OWNED_PRICE;

    const sales = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId, ...range(),
    });
    const pl = await s.asUser.query(api.reports.getProfitAndLoss, {
      orgId: s.orgId, ...range(),
    });
    // The dashboard takes a coarse window rather than explicit dates.
    const dash = await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId, timeRange: "YEAR" as const,
    });

    expect(sales.totalRevenue).toBe(expectedTurnover);
    expect(pl.totalRevenue).toBe(expectedTurnover);
    expect(dash.salesVolumeThisMonth).toBe(expectedTurnover);

    // And the gross is still reported, explicitly labelled and outside turnover.
    expect(sales.totalGrossTransactionValue).toBe(expectedGross);
    expect(pl.grossTransactionValue).toBe(expectedGross);
    expect(dash.grossTransactionValueThisMonth).toBe(expectedGross);
  });

  test("a deposit does not change what the deal was transacted for", async () => {
    // Gross transaction value is the size of the deal, and a deposit is a
    // payment against a deal rather than a deal itself. Two customers buying
    // identical 8,000 cars transacted for the same amount whether or not one of
    // them put 3,000 down first.
    //
    // The P&L read the figure off the VEHICLE_SALE cashflow row's `amount`,
    // which is NET of anything already collected, while the sales report and
    // the dashboard read `sales.salePrice`. A deposit therefore made "gross"
    // transaction value SMALLER on one screen than on the other two, by exactly
    // what the customer had already paid.
    const s = await seedDealer("gtvDeposit");
    const vehicleId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: "VINGTVDEP1", make: "Kia", model: "Rio", year: 2023,
        mileage: 5, color: "Red", fuelType: "Gas", transmission: "Auto",
        sellingPrice: OWNED_PRICE, status: "AVAILABLE", sourceType: "STOCK",
        purchasePrice: OWNED_COST,
      })
    );
    const quoteId = await s.t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId: s.orgId, customerId: s.customerId, vehicleId,
        vehiclePrice: OWNED_PRICE, downPayment: 0, termMonths: 0,
        status: "ACCEPTED", createdBy: s.userId, createdAt: Date.now(),
      })
    );
    await s.asUser.mutation(api.deposits.create, {
      orgId: s.orgId, quoteId, amount: 3_000, method: "CASH" as const,
    });
    await s.asUser.mutation(api.sales.create, {
      orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice: OWNED_PRICE, saleDate: Date.now(), status: "COMPLETED" as const,
      quoteId,
    });

    const sales = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId, ...range(),
    });
    const pl = await s.asUser.query(api.reports.getProfitAndLoss, {
      orgId: s.orgId, ...range(),
    });
    const dash = await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId, timeRange: "YEAR" as const,
    });

    expect(sales.totalGrossTransactionValue).toBe(OWNED_PRICE);
    expect(pl.grossTransactionValue).toBe(OWNED_PRICE);
    expect(dash.grossTransactionValueThisMonth).toBe(OWNED_PRICE);
  });

  test("a salesperson's revenue matches the same basis on both surfaces", async () => {
    const s = await seedDealer("crossRep");
    await sellConsigned(s, "VINREPX3");

    const perf = await s.asUser.query(api.reports.getSalespersonPerformance, {
      orgId: s.orgId, ...range(),
    });
    // The dashboard takes a coarse window rather than explicit dates.
    const dash = await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId, timeRange: "YEAR" as const,
    });

    expect(perf.find((r) => r.userId === s.userId)!.totalRevenue).toBe(MARGIN);
    expect(dash.topPerformer?.revenue).toBe(MARGIN);
  });
});

/**
 * The back-book: consigned sales already on the books when this shipped.
 *
 * `recognizedRevenueAmount` is written by `createSaleTransaction`, so it only
 * ever reaches sales made from this deploy onward. Historical rows carry the
 * gross and nothing else, and `getProfitAndLoss` — which reads the transaction
 * ledger rather than the sale rows — went on reporting it while the sales
 * report and the dashboard, which read sale rows and cost basis, reported the
 * margin. Same month, two answers, and the migration is what closes it.
 */
describe("historical consigned sales after the migration", () => {
  /**
   * The principal journal the OLD code posted for a consigned sale: gross
   * revenue, a fabricated cost against AP-Suppliers, a gross receivable.
   * Written directly because the current code refuses to post it — which is
   * exactly why the migration exists.
   */
  async function postLegacyPrincipalJournal(
    s: Awaited<ReturnType<typeof seedDealer>>,
    saleId: Id<"sales">,
    vin: string
  ) {
    await s.t.run(async (ctx) => {
      const sale = (await ctx.db.get(saleId))!;
      const accounts = (await ctx.db.query("chartOfAccounts").collect())
        .filter((a) => a.orgId === s.orgId);
      const byKey = new Map(accounts.filter((a) => a.systemKey).map((a) => [a.systemKey!, a._id]));
      const entryId = await ctx.db.insert("journalEntries", {
        orgId: s.orgId, journalNumber: `LEGACY-${vin}`, accountingDate: sale.saleDate,
        sourceType: "sales", sourceId: saleId, category: "SYSTEM",
        memo: "Legacy principal posting", status: "POSTED", currency: "JOD",
        postedBy: s.userId, postedAt: Date.now(), createdAt: Date.now(),
      });
      const lines: Array<[string, number, number]> = [
        [SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS, SALE_PRICE * 1000, 0],
        [SYSTEM_KEYS.SALES_REVENUE, 0, SALE_PRICE * 1000],
        [SYSTEM_KEYS.COST_OF_VEHICLES_SOLD, ENTITLEMENT * 1000, 0],
        [SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS, 0, ENTITLEMENT * 1000],
      ];
      let n = 1;
      for (const [key, debitMinor, creditMinor] of lines) {
        await ctx.db.insert("journalLines", {
          orgId: s.orgId, journalEntryId: entryId, lineNumber: n++,
          accountId: byKey.get(key)!, debitMinor, creditMinor,
          currency: "JOD", scale: 3, accountingDate: sale.saleDate,
        });
      }
    });
  }

  /** A legacy sale with the operational transaction row the old code wrote for it. */
  async function sellLegacyWithLedgerRow(
    s: Awaited<ReturnType<typeof seedDealer>>,
    vin: string
  ) {
    const saleId = await sellConsignedAsLegacyPrincipal(s, vin);
    await postLegacyPrincipalJournal(s, saleId, vin);
    const sale = await s.t.run((ctx) => ctx.db.get(saleId));
    await s.t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId: s.orgId,
        type: "IN" as const,
        amount: SALE_PRICE,
        date: sale!.saleDate,
        category: "VEHICLE_SALE",
        description: `Sale of vehicle ${vin}`,
        vehicleId: sale!.vehicleId,
        customerId: s.customerId,
      })
    );
    return saleId;
  }

  test("the P&L reports the gross until the migration runs", async () => {
    // Not a hypothetical: this is what every existing dealership's P&L says
    // today, and it is why a gross fallback cannot be described as exact.
    const s = await seedDealer("backbookBefore");
    await sellLegacyWithLedgerRow(s, "VINBB1");

    const pl = await s.asUser.query(api.reports.getProfitAndLoss, {
      orgId: s.orgId, ...range(),
    });
    expect(pl.totalRevenue).toBe(SALE_PRICE);
  });

  test("the migration restates the reporting basis, and all three then agree", async () => {
    const s = await seedDealer("backbookAfter");
    await sellLegacyWithLedgerRow(s, "VINBB2");

    const report = await s.t.mutation(
      internal.migrateConsignedSaleBasis.migrateConsignedSaleBasis,
      { orgId: s.orgId }
    );
    expect(report.corrected).toBe(1);
    expect(report.reportingBasisBackfilled).toBe(1);

    const sales = await s.asUser.query(api.reports.getSalesAndProfitReport, {
      orgId: s.orgId, ...range(),
    });
    const pl = await s.asUser.query(api.reports.getProfitAndLoss, {
      orgId: s.orgId, ...range(),
    });
    const dash = await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId, timeRange: "YEAR" as const,
    });

    expect(sales.totalRevenue).toBe(MARGIN);
    expect(pl.totalRevenue).toBe(MARGIN);
    expect(dash.salesVolumeThisMonth).toBe(MARGIN);

    // The gross survives as a labelled operational figure, outside turnover.
    expect(pl.grossTransactionValue).toBe(SALE_PRICE);
    expect(dash.grossTransactionValueThisMonth).toBe(SALE_PRICE);
  });

  test("a row whose amount no longer matches the sale is left for a human", async () => {
    // Deposits booked as their own revenue rows, or a hand-edited amount: the
    // margin cannot be derived from this row alone without moving revenue
    // between periods to make a total come out right. So it is not.
    const s = await seedDealer("backbookConflict");
    const saleId = await sellConsignedAsLegacyPrincipal(s, "VINBB3");
    await postLegacyPrincipalJournal(s, saleId, "VINBB3");
    const sale = await s.t.run((ctx) => ctx.db.get(saleId));
    await s.t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId: s.orgId,
        type: "IN" as const,
        amount: SALE_PRICE - 1_000,
        date: sale!.saleDate,
        category: "VEHICLE_SALE",
        description: "Sale net of a deposit already booked",
        vehicleId: sale!.vehicleId,
        customerId: s.customerId,
      })
    );

    const report = await s.t.mutation(
      internal.migrateConsignedSaleBasis.migrateConsignedSaleBasis,
      { orgId: s.orgId }
    );
    expect(report.requiresReconciliation).toBe(1);
    expect(report.reportingBasisBackfilled).toBe(0);

    const correction = await s.t.run(async (ctx) =>
      (await ctx.db.query("consignedSaleCorrections").collect()).find((c) => c.saleId === saleId)
    );
    // The journal correction is unaffected — it is only the operational
    // transaction row that needs a person. Two ledgers, two outcomes.
    expect(correction!.status).toBe("POSTED");
    expect(correction!.reportingBasisStatus).toBe("REQUIRES_RECONCILIATION");
    // And it says why, so the person picking it up does not have to guess.
    expect(correction!.reportingBasisReason).toMatch(/deposits or an edit/i);
  });

  test("two vehicle-sale rows for one car are never guessed between", async () => {
    const s = await seedDealer("backbookAmbiguous");
    const saleId = await sellConsignedAsLegacyPrincipal(s, "VINBB4");
    await postLegacyPrincipalJournal(s, saleId, "VINBB4");
    const sale = await s.t.run((ctx) => ctx.db.get(saleId));
    for (let i = 0; i < 2; i += 1) {
      await s.t.run((ctx) =>
        ctx.db.insert("transactions", {
          orgId: s.orgId,
          type: "IN" as const,
          amount: SALE_PRICE,
          date: sale!.saleDate,
          category: "VEHICLE_SALE",
          description: `Duplicate ${i}`,
          vehicleId: sale!.vehicleId,
          customerId: s.customerId,
        })
      );
    }

    const report = await s.t.mutation(
      internal.migrateConsignedSaleBasis.migrateConsignedSaleBasis,
      { orgId: s.orgId }
    );
    expect(report.requiresReconciliation).toBe(1);

    // Neither row was touched — a guess would have restated the wrong one.
    const rows = await s.t.run(async (ctx) =>
      (await ctx.db.query("transactions").collect()).filter((tx) => tx.orgId === s.orgId)
    );
    expect(rows.every((tx) => tx.recognizedRevenueAmount === undefined)).toBe(true);
  });
});

/**
 * The settlement preview on a quote that carries more than one car.
 *
 * A quote's `vehiclePrice` is the total of the whole deal. Pairing it with one
 * car's supplier cost produces a margin belonging to no vehicle at all — the
 * first car's cost subtracted from every car's price — and that number was
 * shown to the operator, beside that car's name, as its profit.
 */
describe("the consigned preview on a multi-vehicle quote", () => {
  const SECOND_PRICE = 20_000;
  const SECOND_ENTITLEMENT = 17_000;

  async function twoCarQuote(tag: string) {
    const s = await seedDealer(tag);
    const first = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: `VINPREV${tag}A`, make: "Toyota", model: "Camry", year: 2024,
        mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
        sellingPrice: SALE_PRICE, status: "AVAILABLE", sourceType: "SOURCED",
        sourcedFromName: "Amman Importer Co", sourceCost: ENTITLEMENT,
      })
    );
    const second = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: `VINPREV${tag}B`, make: "Lexus", model: "ES", year: 2024,
        mileage: 12, color: "Black", fuelType: "Gas", transmission: "Auto",
        sellingPrice: SECOND_PRICE, status: "AVAILABLE", sourceType: "SOURCED",
        sourcedFromName: "Amman Importer Co", sourceCost: SECOND_ENTITLEMENT,
      })
    );
    const quoteId = await s.t.run((ctx) =>
      ctx.db.insert("quotes", {
        orgId: s.orgId, customerId: s.customerId, vehicleId: first,
        vehiclePrice: SALE_PRICE + SECOND_PRICE,
        vehicleItems: [
          { vehicleId: first, unitPrice: SALE_PRICE },
          { vehicleId: second, unitPrice: SECOND_PRICE },
        ],
        downPayment: 0, termMonths: 0,
        status: "ACCEPTED", createdBy: s.userId, createdAt: Date.now(),
      })
    );
    return { s, quoteId, first, second };
  }

  test("prices each car off its own line, not off the quote total", async () => {
    const { s, quoteId, first, second } = await twoCarQuote("prevLine");

    const previewA = await s.asUser.query(api.sales.consignedSalePreview, {
      orgId: s.orgId, vehicleId: first, quoteId,
    });
    const previewB = await s.asUser.query(api.sales.consignedSalePreview, {
      orgId: s.orgId, vehicleId: second, quoteId,
    });

    expect(previewA!.salePrice).toBe(SALE_PRICE);
    expect(previewA!.grossTransactionValue).toBe(SALE_PRICE);
    expect(previewA!.supplierEntitlement).toBe(ENTITLEMENT);
    expect(previewA!.dealershipMargin).toBe(MARGIN);
    expect(previewA!.quoteLineIndex).toBe(0);

    expect(previewB!.salePrice).toBe(SECOND_PRICE);
    expect(previewB!.dealershipMargin).toBe(SECOND_PRICE - SECOND_ENTITLEMENT);
    expect(previewB!.quoteLineIndex).toBe(1);

    // The tell-tale of the old behaviour: the first car's margin computed off
    // the whole quote's price.
    expect(previewA!.dealershipMargin).not.toBe(SALE_PRICE + SECOND_PRICE - ENTITLEMENT);
  });

  test("refuses a vehicle that is not a line on the quote", async () => {
    const { s, quoteId } = await twoCarQuote("prevOther");
    const stranger = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: "VINPREVSTRANGE", make: "Kia", model: "Rio", year: 2023,
        mileage: 5, color: "Red", fuelType: "Gas", transmission: "Auto",
        sellingPrice: OWNED_PRICE, status: "AVAILABLE", sourceType: "SOURCED",
        sourcedFromName: "Amman Importer Co", sourceCost: 1_000,
      })
    );

    expect(
      await s.asUser.query(api.sales.consignedSalePreview, {
        orgId: s.orgId, vehicleId: stranger, quoteId,
      })
    ).toBeNull();
  });

  test("the receivable follows the line as well as the margin", async () => {
    const { s, quoteId, second } = await twoCarQuote("prevReceivable");

    const through = await s.asUser.query(api.sales.consignedSalePreview, {
      orgId: s.orgId, vehicleId: second, quoteId,
      settlementRoute: "THROUGH_DEALERSHIP" as const,
    });
    expect(through!.customerVehicleReceivable).toBe(SECOND_PRICE);
    expect(through!.supplierPayable).toBe(SECOND_ENTITLEMENT);

    const direct = await s.asUser.query(api.sales.consignedSalePreview, {
      orgId: s.orgId, vehicleId: second, quoteId,
      settlementRoute: "DIRECT_TO_SUPPLIER" as const,
    });
    expect(direct!.customerVehicleReceivable).toBe(0);
    expect(direct!.supplierReceivable).toBe(SECOND_PRICE - SECOND_ENTITLEMENT);
  });
});

/**
 * Where the agency-tax refusal has to live.
 *
 * `consignedAgentSaleLines` throws on tax, and that reads like enforcement.
 * It is not, on its own: `postOrEnqueue` evaluates a posting rule only when a
 * chart and an open period exist. Without one it enqueues the raw payload, so
 * the sale completes — vehicle SOLD, cashflow row, receivable, commission —
 * and the journal fails privately in the outbox later. The refusal has to be
 * at the mutation boundary or it is conditional on the accounting calendar.
 */
describe("tax on an agency sale, with no open accounting period", () => {
  async function sellSourced(
    tag: string,
    opts: { withAccounting: boolean; taxAmount?: number; salePrice?: number }
  ) {
    const s = await seedDealer(tag, { withAccounting: opts.withAccounting });
    const vehicleId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: `VINTAX${tag}`, make: "Toyota", model: "Camry", year: 2024,
        mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
        sellingPrice: SALE_PRICE, status: "AVAILABLE", sourceType: "SOURCED",
        sourcedFromName: "Amman Importer Co", sourceCost: ENTITLEMENT,
      })
    );
    return {
      s,
      vehicleId,
      attempt: () =>
        s.asUser.mutation(api.sales.create, {
          orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
          salePrice: opts.salePrice ?? SALE_PRICE, saleDate: Date.now(),
          status: "COMPLETED" as const,
          ...(opts.taxAmount !== undefined ? { taxAmount: opts.taxAmount } : {}),
        }),
    };
  }
  const sellSourcedWithTax = (tag: string, withAccounting: boolean) =>
    sellSourced(tag, { withAccounting, taxAmount: 500 });

  /**
   * The recognized margin is the journal's margin, to the minor unit.
   *
   * Recognition used to recompute the spread in MAJOR units — `salePrice -
   * costAmount` — while the accounting path derived it in integer minor units
   * (`toMinorUnits(salePrice) - costMinor`). In JOD, at three decimals, those
   * are not the same number: 12,500.7 − 9,500.5 evaluates to
   * 3000.2000000000007, so the P&L stored float noise while the journal
   * credited 3000.2, and the two could never be tied exactly.
   *
   * Sub-unit money is still wrong money: it is the difference between a report
   * that reconciles to the ledger and one that is off by "almost nothing" on
   * every consigned sale, which is the kind of discrepancy nobody can ever
   * close. `fromMinorUnits(marginMinor)` is the same figure the claim path
   * already uses in this file.
   */
  test("recognizes the margin the journal posted, without float drift", async () => {
    const s = await seedDealer("marginScale", { withAccounting: false });
    const vehicleId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: "VINSCALE1", make: "Toyota", model: "Camry", year: 2024,
        mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
        sellingPrice: 12_500.7, status: "AVAILABLE", sourceType: "SOURCED",
        sourcedFromName: "Amman Importer Co", sourceCost: 9_500.5,
      })
    );
    await s.asUser.mutation(api.sales.create, {
      orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice: 12_500.7, saleDate: Date.now(), status: "COMPLETED" as const,
    });

    const tx = await s.t.run(async (ctx) =>
      (await ctx.db.query("transactions").collect()).find(
        (r) => r.category === "VEHICLE_SALE" && r.vehicleId === vehicleId
      )
    );
    // Exactly 3000.2 — not 3000.2000000000007.
    expect(tx?.recognizedRevenueAmount).toBe(3_000.2);
  });

  test("is refused even though no posting rule runs", async () => {
    const { attempt } = await sellSourcedWithTax("taxNoPeriod", false);
    await expect(attempt()).rejects.toThrow(/tax/i);
  });

  test("leaves no sale, no sold vehicle and nothing queued behind it", async () => {
    // A Convex mutation is one transaction, so the throw must take the whole
    // completion with it. Otherwise the refusal simply relocates the damage:
    // a car marked SOLD against a sale that does not exist.
    const { s, vehicleId, attempt } = await sellSourcedWithTax("taxNoPeriodState", false);
    await expect(attempt()).rejects.toThrow();

    const state = await s.t.run(async (ctx) => ({
      sales: (await ctx.db.query("sales").collect()).length,
      queued: (await ctx.db.query("pendingAccountingEvents").collect()).length,
      status: (await ctx.db.get(vehicleId))?.status,
    }));
    expect(state.sales).toBe(0);
    expect(state.queued).toBe(0);
    expect(state.status).toBe("AVAILABLE");
  });

  test("is refused with a period open too, so the two paths agree", async () => {
    const { attempt } = await sellSourcedWithTax("taxWithPeriod", true);
    await expect(attempt()).rejects.toThrow(/tax/i);
  });

  /**
   * The same defect, in the refusal three lines away.
   *
   * `consignedAgentSaleLines` also refuses a sale below the supplier's
   * entitlement, and that refusal was equally calendar-dependent: with no open
   * period covering the sale date — an org still setting accounting up, or any
   * BACKDATED sale into a closed month — nothing evaluated it either.
   *
   * This one is worse than the tax case, because it does not merely skip a
   * journal. `applySaleCompletionSideEffects` writes a `vehicleSupplierPayables`
   * row for the FULL entitlement, so the dealership owes the supplier 9,500 on
   * a deal that collected 9,000, with no journal recording the shortfall. When
   * finance later pays it, `ruleSupplierPaymentSettled` debits an
   * ACCOUNTS_PAYABLE_SUPPLIERS that the sale never credited — real cash out
   * against a payable the ledger never recognized.
   */
  const BELOW_ENTITLEMENT = ENTITLEMENT - 500;

  test("a sale below the supplier's entitlement is refused with no open period", async () => {
    const { attempt } = await sellSourced("belowEntNoPeriod", {
      withAccounting: false, salePrice: BELOW_ENTITLEMENT,
    });
    await expect(attempt()).rejects.toThrow(/entitlement/i);
  });

  test("and leaves no payable standing for money the ledger never recognized", async () => {
    const { s, vehicleId, attempt } = await sellSourced("belowEntState", {
      withAccounting: false, salePrice: BELOW_ENTITLEMENT,
    });
    await expect(attempt()).rejects.toThrow();

    const state = await s.t.run(async (ctx) => ({
      sales: (await ctx.db.query("sales").collect()).length,
      queued: (await ctx.db.query("pendingAccountingEvents").collect()).length,
      payables: (await ctx.db.query("vehicleSupplierPayables").collect()).length,
      status: (await ctx.db.get(vehicleId))?.status,
    }));
    expect(state.sales).toBe(0);
    expect(state.queued).toBe(0);
    expect(state.payables).toBe(0);
    expect(state.status).toBe("AVAILABLE");
  });

  test("is refused with a period open too, so acceptance never depends on the calendar", async () => {
    const { attempt } = await sellSourced("belowEntWithPeriod", {
      withAccounting: true, salePrice: BELOW_ENTITLEMENT,
    });
    await expect(attempt()).rejects.toThrow(/entitlement/i);
  });
});

/**
 * A financed consigned deal cannot be settled directly with the supplier.
 *
 * `finalizeDeal` calls `completeSale` with no `supplierSettlementRoute`, and an
 * absent route reads as THROUGH_DEALERSHIP. So the wizard offered the choice,
 * the operator picked DIRECT_TO_SUPPLIER, and the deal posted the opposite way
 * — dealership owing the supplier the gross and the customer owing the
 * dealership, when the financier had paid the supplier and the supplier owed
 * the dealership its margin. Both sides inverted, with nothing on screen or in
 * the ledger saying so.
 *
 * The refusal is enforced at the mutation boundary rather than by hiding the
 * control, because the form is not the only caller.
 */
describe("a financed consigned sale settled directly with the supplier", () => {
  async function financedDirect(
    tag: string,
    overrides: { financingType?: "CASH" | "FINANCED" | "LEASE"; route?: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER" } = {}
  ) {
    const s = await seedDealer(tag);
    const vehicleId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: `VINFIN${tag}`, make: "Toyota", model: "Camry", year: 2024,
        mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
        sellingPrice: SALE_PRICE, status: "AVAILABLE", sourceType: "SOURCED",
        sourcedFromName: "Amman Importer Co", sourceCost: ENTITLEMENT,
      })
    );
    return {
      s,
      vehicleId,
      attempt: () =>
        s.asUser.mutation(api.sales.create, {
          orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
          salePrice: SALE_PRICE, saleDate: Date.now(), status: "COMPLETED" as const,
          financingType: overrides.financingType ?? "FINANCED",
          supplierSettlementRoute: overrides.route ?? "DIRECT_TO_SUPPLIER",
        }),
    };
  }

  test("is refused rather than posted the other way round", async () => {
    const { attempt } = await financedDirect("finDirect");
    await expect(attempt()).rejects.toThrow(/financed/i);
  });

  /**
   * What the supplier owes must be the figure the journal posted, to the unit.
   *
   * The GL debit on the direct route is built from `marginMinor`
   * (`toMinorUnits(salePrice) - costMinor`). The receivable was built from
   * `toMinorUnits(salePrice - costAmount)` — `round(a) - round(b)` against
   * `round(a - b)`. Where either amount carries more decimals than the currency
   * scale those differ by a minor unit, and a claim that disagrees with its own
   * posting by one fils can never be settled to zero. It sits on the aging
   * report forever, which is the exact outcome the comment above it set out to
   * prevent.
   *
   * The same defect was fixed for `recognizedRevenueAmount`; this is its
   * sibling, two hundred lines further down the same function.
   */
  test("the supplier receivable equals the journal's margin, to the minor unit", async () => {
    const s = await seedDealer("claimScale");
    // Both carry sub-fils precision, so round(a-b) and round(a)-round(b) split.
    const SALE = 12_500.7005;
    const COST = 9_500.5002;
    const vehicleId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: "VINCLAIM1", make: "Toyota", model: "Camry", year: 2024,
        mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
        sellingPrice: SALE, status: "AVAILABLE", sourceType: "SOURCED",
        sourcedFromName: "Amman Importer Co", sourceCost: COST,
      })
    );
    await s.asUser.mutation(api.sales.create, {
      orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice: SALE, saleDate: Date.now(), status: "COMPLETED" as const,
      financingType: "CASH" as const,
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER" as const,
    });

    const receivable = await s.t.run(async (ctx) =>
      (await ctx.db.query("vehicleSupplierReceivables").collect()).find((r) => r.vehicleId === vehicleId)
    );
    // marginMinor = round(12500.7005*1000) - round(9500.5002*1000) = 3000201.
    expect(receivable?.amountDue).toBe(3_000.201);
  });

  /**
   * And what the dealership owes is stored at the currency's scale.
   *
   * `sourceCost` is a decimal a person typed, and the capitalized cost is a sum
   * of them. Stored raw, a payable of 9500.5002 is one no payment can ever
   * close: `recordPayment` refuses to overpay, so the last fraction of a fils
   * is unpayable and the row never reaches PAID. The receivable side already
   * rounds through the currency; this side did not.
   */
  test("the supplier payable is stored at the currency's scale", async () => {
    const s = await seedDealer("payScale");
    const COST = 9_500.5002;
    const vehicleId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: "VINPAY1", make: "Toyota", model: "Camry", year: 2024,
        mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
        sellingPrice: 12_500, status: "AVAILABLE", sourceType: "SOURCED",
        sourcedFromName: "Amman Importer Co", sourceCost: COST,
      })
    );
    await s.asUser.mutation(api.sales.create, {
      orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice: 12_500, saleDate: Date.now(), status: "COMPLETED" as const,
      financingType: "CASH" as const,
      supplierSettlementRoute: "THROUGH_DEALERSHIP" as const,
    });

    const payable = await s.t.run(async (ctx) =>
      (await ctx.db.query("vehicleSupplierPayables").collect()).find((p) => p.vehicleId === vehicleId)
    );
    expect(payable?.amountDue).toBe(9_500.5);
  });

  test("leaves nothing behind — no sale, no sold vehicle, no supplier payable", async () => {
    const { s, vehicleId, attempt } = await financedDirect("finDirectState");
    await expect(attempt()).rejects.toThrow();

    const state = await s.t.run(async (ctx) => ({
      sales: (await ctx.db.query("sales").collect()).length,
      payables: (await ctx.db.query("vehicleSupplierPayables").collect()).length,
      status: (await ctx.db.get(vehicleId))?.status,
    }));
    expect(state.sales).toBe(0);
    expect(state.payables).toBe(0);
    expect(state.status).toBe("AVAILABLE");
  });

  test("a LEASE is treated as financed too", async () => {
    const { attempt } = await financedDirect("finLease", { financingType: "LEASE" });
    await expect(attempt()).rejects.toThrow(/financed/i);
  });

  test("a CASH consigned sale keeps the direct route", async () => {
    // The refusal is scoped to what is genuinely unsupported. Cash deals are
    // the whole reason the direct route exists.
    const { s, attempt } = await financedDirect("finCash", { financingType: "CASH" });
    const saleId = await attempt();

    const route = await s.t.run(async (ctx) => (await ctx.db.get(saleId))?.supplierSettlementRoute);
    expect(route).toBe("DIRECT_TO_SUPPLIER");
  });

  test("a financed sale settled THROUGH the dealership is unaffected", async () => {
    const { attempt } = await financedDirect("finThrough", { route: "THROUGH_DEALERSHIP" });
    await expect(attempt()).resolves.toBeDefined();
  });
});

/**
 * The dashboard costs at most 500 distinct sold vehicles per window, because
 * `computeVehicleCapitalizedCost` reads every expense logged against a car and
 * running it unbounded on a live subscription is what the cap exists to stop.
 *
 * Turnover then has to say what a sale past that cap contributed. A consigned
 * one genuinely cannot be answered — its turnover IS its margin, and the margin
 * needs the cost. But a car the dealership owned needs no cost at all: its
 * turnover is the price on the sale row, which was already read. Excluding both
 * threw away figures that were never in doubt, and an org past the cap had its
 * headline revenue, its monthly chart and its per-salesperson ranking silently
 * shortened by the whole tail.
 */
describe("turnover past the dashboard's costing cap", () => {
  /**
   * These seed 502 vehicles and 502 sales apiece, because the cap under test
   * is 500. Around a second each normally, but well past vitest's 5s default
   * once the coverage run instruments every module — which is how CI first
   * failed them while every local run passed.
   */
  const HEAVY_TEST_TIMEOUT_MS = 60_000;
  const CAP = 500;
  const PAST_CAP_OWNED_PRICE = 7_777;

  /**
   * Fills the cap with owned sales, then adds one owned and one consigned sale
   * behind it. Rows are inserted directly: the dashboard reads `sales` and
   * `vehicles`, and putting 502 deals through `api.sales.create` would post 502
   * journals to prove something about a read path.
   */
  async function dealerPastTheCap(tag: string, baseAt?: number) {
    const s = await seedDealer(tag);
    // Ascending `saleDate`, because the dashboard's window query returns them
    // in that order and the cap is applied to that order. The last two are the
    // ones past it, deterministically.
    const base = baseAt ?? Date.now() - 600_000;
    const pastCap = await s.t.run(async (ctx) => {
      const insert = async (
        i: number,
        sourceType: "STOCK" | "SOURCED",
        price: number
      ) => {
        const vehicleId = await ctx.db.insert("vehicles", {
          orgId: s.orgId, vin: `CAP${tag}${i}`, make: "Kia", model: "Rio", year: 2023,
          mileage: 5, color: "Red", fuelType: "Gas", transmission: "Auto",
          sellingPrice: price, status: "SOLD", sourceType,
          ...(sourceType === "STOCK"
            ? { purchasePrice: OWNED_COST }
            : { sourcedFromName: "Amman Importer Co", sourceCost: ENTITLEMENT }),
        });
        await ctx.db.insert("sales", {
          orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
          salePrice: price, saleDate: base + i, status: "COMPLETED" as const,
        });
        return vehicleId;
      };
      for (let i = 0; i < CAP; i++) await insert(i, "STOCK", OWNED_PRICE);
      return {
        owned: await insert(CAP, "STOCK", PAST_CAP_OWNED_PRICE),
        consigned: await insert(CAP + 1, "SOURCED", SALE_PRICE),
      };
    });
    return { s, pastCap };
  }

  test("an owned sale past the cap still contributes its price", async () => {
    const { s } = await dealerPastTheCap("capOwned");

    const dash = await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId, timeRange: "YEAR" as const,
    });

    // The dealership owned this car. Nothing about its turnover was ever
    // uncertain — only its PROFIT needed a cost, and profit is reported
    // separately with its own truncation flag. The consigned car behind it
    // contributes its margin, which the next test is about.
    expect(dash.salesVolumeThisMonth).toBe(
      CAP * OWNED_PRICE + PAST_CAP_OWNED_PRICE + MARGIN
    );
  }, HEAVY_TEST_TIMEOUT_MS);

  test("a consigned sale past the cap contributes its MARGIN, not nothing", async () => {
    const { s } = await dealerPastTheCap("capConsigned");

    const dash = await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId, timeRange: "YEAR" as const,
    });

    // `computeVehicleCapitalizedCost` returns `sourceCost` for a SOURCED
    // vehicle before it reads a single expense, so the margin costs one field
    // access off a row already in hand. This was briefly excluded on the
    // stated grounds that "the margin needs the cost" — wrong about that
    // function, and on a consigned-heavy lot it discarded the larger half of
    // the tail while reporting the figure as merely truncated.
    expect(dash.salesVolumeThisMonth).toBe(
      CAP * OWNED_PRICE + PAST_CAP_OWNED_PRICE + MARGIN
    );
    // And nothing is short, so the flag must not claim otherwise.
    expect(dash.truncated.turnover).toBe(false);
  }, HEAVY_TEST_TIMEOUT_MS);

  test("a consigned sale with no recorded supplier cost is excluded, and says so", async () => {
    // The one case that genuinely cannot be answered. Zero counts as missing,
    // exactly as `hasVehicleCostBasis` treats it: a 0 basis would report the
    // supplier's entire share as the dealership's turnover.
    const { s, pastCap } = await dealerPastTheCap("capNoCost");
    await s.t.run(async (ctx) => {
      await ctx.db.patch(pastCap.consigned, { sourceCost: undefined });
    });

    const dash = await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId, timeRange: "YEAR" as const,
    });

    expect(dash.salesVolumeThisMonth).toBe(CAP * OWNED_PRICE + PAST_CAP_OWNED_PRICE);
    expect(dash.truncated.turnover).toBe(true);
  }, HEAVY_TEST_TIMEOUT_MS);

  test("a past-cap vehicle belonging to another org is excluded, never booked at gross", async () => {
    // A tenancy guard with no regression test is a tenancy guard that will be
    // refactored away. `sourceType` absent would read as owned stock, so the
    // check that must hold is the org one.
    const { s, pastCap } = await dealerPastTheCap("capForeign");
    const otherOrgId = await s.t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Somebody else", createdAt: Date.now() })
    );
    await s.t.run(async (ctx) => {
      await ctx.db.patch(pastCap.owned, { orgId: otherOrgId });
    });

    const dash = await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId, timeRange: "YEAR" as const,
    });

    // The foreign car's price is gone from turnover; the consigned one still counts.
    expect(dash.salesVolumeThisMonth).toBe(CAP * OWNED_PRICE + MARGIN);
    expect(dash.truncated.turnover).toBe(true);
  }, HEAVY_TEST_TIMEOUT_MS);

  test("the salesperson ranking counts the same sale the headline does", async () => {
    const { s } = await dealerPastTheCap("capRanking");

    const dash = await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId, timeRange: "YEAR" as const,
    });

    // `revenueBySalesperson` runs through the same `recognizedRevenueOfSale`,
    // so a tail dropped from turnover was dropped from the leaderboard too —
    // and commission disputes start with a salesperson reading this number.
    expect(dash.topPerformer?.revenue).toBe(
      CAP * OWNED_PRICE + PAST_CAP_OWNED_PRICE + MARGIN
    );
  }, HEAVY_TEST_TIMEOUT_MS);

  test("the COMPARISON window gets the same treatment, so a basis change is not read as growth", async () => {
    // The previous window only exists for DAY and MONTH (`comparesPeriods`),
    // so a YEAR test never executes a line of it. Every test above is YEAR —
    // which left the whole previous-window path, and the invariant it was
    // written for, asserted by nothing.
    //
    // MONTH is a ROLLING 30 days here, not a calendar month: the current
    // window is `now - 30d`, the previous one `now - 60d`. 45 days back sits
    // squarely inside the previous window and is relative to `now`, so no
    // calendar boundary can move it.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const { s } = await dealerPastTheCap("capPrevWindow", Date.now() - 45 * DAY_MS);

    const dash = await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId, timeRange: "MONTH" as const,
    });

    // Had the previous window kept excluding its tail while the current window
    // counted its own, the delta between them would have reported the
    // difference in treatment as a change in trade.
    expect(dash.previousPeriod?.sales).toBe(
      CAP * OWNED_PRICE + PAST_CAP_OWNED_PRICE + MARGIN
    );
  }, HEAVY_TEST_TIMEOUT_MS);
});
