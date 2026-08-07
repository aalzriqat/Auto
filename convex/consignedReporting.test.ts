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

async function seedDealer(tag: string) {
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
