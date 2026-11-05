/**
 * SCRUM-902 round 3 (PR #766), owner ruling "Yes, gate all" (SCRUM-902 c24475). Five more readers returned a cost or a
 * cost-derived figure to a role without view:cost_price: the transaction register (acquisition-cost rows, tested in
 * transactions.test.ts), the operational profit and loss, the accounting-event payloads, the expense readers'
 * capitalized and per-car landed totals, and the cash deal cockpit's profit.
 * Test names are literal: the regression library binds a scenario to one named test.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }), check: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seed(tag: string, permissions: string[]) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S902d ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "U" }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Custom", permissions }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] }));
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag }));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `S902D${tag.toUpperCase()}0000000`.slice(0, 17), make: "Kia", model: "Rio", year: 2023, mileage: 5,
      color: "Red", fuelType: "Gas", transmission: "Auto", sellingPrice: 8000, status: "AVAILABLE",
      sourceType: "STOCK", purchasePrice: 6000,
    })
  );
  const as = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  return { t, orgId, userId, customerId, vehicleId, as };
}

const NOW = Date.now();
const RANGE = { startDate: NOW - 86_400_000, endDate: NOW + 86_400_000 };

describe("SCRUM-902 operational profit and loss", () => {
  test("reports.getProfitAndLoss: a role with view:reports but without view:cost_price gets null, not cost of goods sold or gross profit (SCRUM-902)", async () => {
    const s = await seed("pl", ["view:reports"]);
    expect(await s.as.query(api.reports.getProfitAndLoss, { orgId: s.orgId, ...RANGE })).toBeNull();
  });
  test("reports.getProfitAndLoss: a role holding both view:reports and view:cost_price still reads (SCRUM-902 positive control)", async () => {
    const s = await seed("plboth", ["view:reports", "view:cost_price"]);
    expect(await s.as.query(api.reports.getProfitAndLoss, { orgId: s.orgId, ...RANGE })).not.toBeNull();
  });
  test("reports.getProfitAndLoss: view:cost_price without view:reports is still refused (SCRUM-902 negative control)", async () => {
    const s = await seed("plcost", ["view:cost_price"]);
    await expect(s.as.query(api.reports.getProfitAndLoss, { orgId: s.orgId, ...RANGE })).rejects.toThrow(/view:reports/);
  });
});

describe("SCRUM-902 accounting event payloads", () => {
  test("accountingLedger.listAccountingEvents: a role with view:finance but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await seed("ev", ["view:finance"]);
    await expect(s.as.query(api.accountingLedger.listAccountingEvents, { orgId: s.orgId })).rejects.toThrow(/view:cost_price/);
  });
  test("accountingLedger.listAccountingEvents: a role holding both view:finance and view:cost_price still reads (SCRUM-902 positive control)", async () => {
    const s = await seed("evboth", ["view:finance", "view:cost_price"]);
    await expect(s.as.query(api.accountingLedger.listAccountingEvents, { orgId: s.orgId })).resolves.toBeDefined();
  });
  test("accountingLedger.listAccountingEvents: view:cost_price without view:finance is still refused (SCRUM-902 negative control)", async () => {
    const s = await seed("evcost", ["view:cost_price"]);
    await expect(s.as.query(api.accountingLedger.listAccountingEvents, { orgId: s.orgId })).rejects.toThrow(/view:finance/);
  });
});

describe("SCRUM-902 opening stock choices", () => {
  test("accountingCutover.listOpeningStockChoices: a role with manage:finance but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await seed("os", ["manage:finance"]);
    await expect(s.as.query(api.accountingCutover.listOpeningStockChoices, { orgId: s.orgId })).rejects.toThrow(/view:cost_price/);
  });
  test("accountingCutover.listOpeningStockChoices: a role holding both manage:finance and view:cost_price still reads (SCRUM-902 positive control)", async () => {
    const s = await seed("osboth", ["manage:finance", "view:cost_price"]);
    await expect(s.as.query(api.accountingCutover.listOpeningStockChoices, { orgId: s.orgId })).resolves.toEqual([]);
  });
  test("accountingCutover.listOpeningStockChoices: view:cost_price without manage:finance is still refused (SCRUM-902 negative control)", async () => {
    const s = await seed("oscost", ["view:cost_price"]);
    await expect(s.as.query(api.accountingCutover.listOpeningStockChoices, { orgId: s.orgId })).rejects.toThrow(/manage:finance/);
  });
});

describe("SCRUM-902 expense readers", () => {
  async function withExpense(tag: string, permissions: string[]) {
    const s = await seed(tag, permissions);
    await s.t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId: s.orgId, vehicleId: s.vehicleId, title: "Brake job", amount: 116, taxAmount: 16, date: NOW, category: "REPAIR",
        status: "PAID", accountingTreatment: "CAPITALIZED_INVENTORY", capitalizedAmount: 100,
      })
    );
    return s;
  }
  const page = { numItems: 10, cursor: null };

  test("expenses.list: a role with view:expenses but without view:cost_price cannot reconstruct vehicle cost from expense rows (SCRUM-902)", async () => {
    const s = await withExpense("exl", ["view:expenses"]);
    const result = await s.as.query(api.expenses.list, { orgId: s.orgId, paginationOpts: page });
    expect(result.page).toEqual([]);
  });
  test("expenses.list: a role holding both view:expenses and view:cost_price still gets the capitalized amount (SCRUM-902 positive control)", async () => {
    const s = await withExpense("exlboth", ["view:expenses", "view:cost_price"]);
    const result = await s.as.query(api.expenses.list, { orgId: s.orgId, paginationOpts: page });
    expect(result.page[0]).toMatchObject({ capitalizedAmount: 100 });
  });
  test("expenses.list: a role without view:cost_price asking for one car's expenses is refused (SCRUM-902)", async () => {
    const s = await withExpense("exlveh", ["view:expenses"]);
    await expect(
      s.as.query(api.expenses.list, { orgId: s.orgId, vehicleId: s.vehicleId, paginationOpts: page })
    ).rejects.toThrow(/view:cost_price/);
  });
  test("expenses.totalByVehicle: a role with view:expenses but without view:cost_price is refused (SCRUM-902)", async () => {
    const s = await withExpense("ext", ["view:expenses"]);
    await expect(s.as.query(api.expenses.totalByVehicle, { orgId: s.orgId, vehicleId: s.vehicleId })).rejects.toThrow(/view:cost_price/);
  });
  test("expenses.totalByVehicle: a role holding both view:expenses and view:cost_price still reads the total (SCRUM-902 positive control)", async () => {
    const s = await withExpense("extboth", ["view:expenses", "view:cost_price"]);
    expect(await s.as.query(api.expenses.totalByVehicle, { orgId: s.orgId, vehicleId: s.vehicleId })).toBe(116);
  });
  test("expenses readers: view:cost_price without view:expenses is still refused (SCRUM-902 negative control)", async () => {
    const s = await withExpense("excost", ["view:cost_price"]);
    await expect(s.as.query(api.expenses.totalByVehicle, { orgId: s.orgId, vehicleId: s.vehicleId })).rejects.toThrow(/view:expenses/);
    await expect(s.as.query(api.expenses.list, { orgId: s.orgId, paginationOpts: page })).rejects.toThrow(/view:expenses/);
  });
});

describe("SCRUM-902 cash deal cockpit", () => {
  const DEAL = ["view:sales", "view:vehicles", "view:finance"];
  async function withSale(tag: string, permissions: string[]) {
    const s = await seed(tag, permissions);
    const saleId = await s.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId,
        salePrice: 8000, saleDate: NOW, status: "COMPLETED" as const,
      } as never)
    );
    return { ...s, saleId };
  }

  test("sales.dealCockpit: a role with view:finance but without view:cost_price gets the deal and no profit or vehicle-cost line (SCRUM-902)", async () => {
    const s = await withSale("dc", DEAL);
    const deal = await s.as.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
    expect(deal).not.toBeNull();
    expect(deal!.stages.length).toBeGreaterThan(0);
    expect(deal!.money).not.toBeNull();
    expect(deal!.money!.profit).toEqual({ available: false, reason: "CostAccessRequired" });
    expect(JSON.stringify(deal)).not.toContain("VEHICLE_COST");
    expect(JSON.stringify(deal!.money)).not.toContain("2000000");
  });
  test("sales.dealCockpit: a role holding view:finance and view:cost_price still gets the profit with its vehicle-cost line (SCRUM-902 positive control)", async () => {
    const s = await withSale("dcboth", [...DEAL, "view:cost_price"]);
    const deal = await s.as.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
    const profit = deal!.money!.profit;
    expect(profit.available).toBe(true);
    if (!profit.available) throw new Error("unreachable");
    expect(profit.amountMinor).toBe(2_000_000);
    expect(profit.lines.some((line) => line.key === "VEHICLE_COST" && line.amountMinor === 6_000_000)).toBe(true);
  });
  test("sales.dealCockpit: view:cost_price without view:finance still gets no money at all (SCRUM-902 negative control)", async () => {
    const s = await withSale("dccost", ["view:sales", "view:vehicles", "view:cost_price"]);
    const deal = await s.as.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
    expect(deal!.money).toBeNull();
  });
});
