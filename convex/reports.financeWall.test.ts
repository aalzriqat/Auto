/**
 * SCRUM-928 finance wall: the report row's working (profitLines) carries finance-only amounts (dealer contribution,
 * approval excess, planned customer payment, closing-fee actual and forecast). The deal page serves those only to
 * `view:finance`, so the report serves the working only to the same readers (`mayReadFinanceEconomics`).
 *
 * The owner ruling "view:finance is not required" covers profit, revenue, cost and sale price only, so every one of
 * those figures stays exactly as it was for a caller without view:finance. `profitClassification` reveals no amount and
 * is still served. Absence is exact: the `profitLines` key does not exist in the row (never an empty array).
 * Evidence boundary: convex-test only, not the Convex runtime and not production data.
 */
import { describe, expect, test } from "vitest";
import { DATE, reportDealFixture as fixture } from "../test-utils/reportDealFixture";
import { seedSaleInvoice } from "../test-utils/saleInvoiceFixtures";
import { api } from "./_generated/api";
import { ALL_PERMISSIONS, DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";

type Fixture = Awaited<ReturnType<typeof fixture>>;

const withoutFinance = ALL_PERMISSIONS.filter((p) => p !== "view:finance");
const managerTemplate = DEFAULT_ROLE_TEMPLATES.find((template) => template.name === "MANAGER");
if (!managerTemplate) throw new Error("MANAGER template missing");
const manager = managerTemplate.permissions;

async function setRole(s: Fixture, permissions: readonly string[], isSystemOwnerRole = false) {
  await s.t.run((ctx) => ctx.db.patch(s.roleId, { permissions: [...permissions] as typeof ALL_PERMISSIONS, isSystemOwnerRole }));
}

/** The caller holds no view:finance: no working, every other figure as the finance reader sees it. */
async function expectWallHolds(s: Fixture, permissions: readonly string[]) {
  expect(permissions).not.toContain("view:finance");
  const ownerReport = (await s.report())!;
  const owner = ownerReport.sales[0];
  expect((owner.profitLines ?? []).length).toBeGreaterThan(0);

  await setRole(s, permissions);
  const report = (await s.report())!;
  const row = report.sales[0];
  expect(row).not.toHaveProperty("profitLines");
  expect(row).toHaveProperty("profitClassification");
  expect(row.profitClassification).toBe(owner.profitClassification);
  expect(row).toMatchObject({ salePrice: 12100, netProfit: 1133.7, netProfitAfterCommissions: 1023.7, commissionsTotal: 110 });
  expect(row.recognizedRevenue).toBe(owner.recognizedRevenue);
  expect(row.totalCost).toBe(owner.totalCost);
  expect(report.totalRevenue).toBe(ownerReport.totalRevenue);
  expect(report.totalCost).toBe(ownerReport.totalCost);
  expect(report.totalProfit).toBe(1133.7);
  expect(report.totalNetProfitAfterCommissions).toBe(1023.7);
}

describe("SCRUM-928 the report working stays behind the finance wall", () => {
  test("every permission except view:finance: a consignment row has no working and the same figures", async () => {
    await expectWallHolds(await fixture(), withoutFinance);
  });

  test("every permission except view:finance: an own-stock row with a dealer contribution has no working and the same figures", async () => {
    await expectWallHolds(await fixture({ stock: true }), withoutFinance);
  });

  test("the default MANAGER template: a consignment row has no working and the same figures", async () => {
    await expectWallHolds(await fixture(), manager);
  });

  test("the default MANAGER template: an own-stock row with a dealer contribution has no working and the same figures", async () => {
    await expectWallHolds(await fixture({ stock: true }), manager);
  });

  test("without view:finance an estimated deal keeps its estimate classification and loses its working", async () => {
    const s = await fixture();
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.applicationId!, { estimatedDealerBorneExpensesMinor: 600000, supplierDisbursedAmountMinor: 12000000 });
      await ctx.db.patch(s.feeId!, { reconciledAt: DATE });
      await ctx.db.insert("vehicleSupplierReceivables", {
        orgId: s.orgId, vehicleId: s.vehicleId, saleId: s.saleId, sourcedFromName: "Supplier",
        amountDue: 2100, amountReceived: 2100, currency: "JOD", status: "PAID",
        createdBy: s.userId, createdAt: DATE, updatedAt: DATE,
      });
      await seedSaleInvoice(ctx, { orgId: s.orgId, saleId: s.saleId, userId: s.userId,
        customerId: s.customerId, originalMinor: 100000, openMinor: 100000, posting: "POSTED" });
    });
    await setRole(s, manager);
    const row = (await s.report())!.sales[0];
    expect(row).not.toHaveProperty("profitLines");
    expect(row.profitClassification).toBe("ESTIMATED_AWAITING_SETTLEMENT");
    expect(row).toMatchObject({ netProfit: 985, netProfitAfterCommissions: 875 });
  });

  test("without view:finance the deal page serves no financial summary, so no before-commissions subtotal either", async () => {
    const s = await fixture({ stock: true });
    await setRole(s, manager);
    const overview = await s.asUser.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId: s.applicationId! });
    expect(overview?.financialSummary ?? null).toBeNull();
  });

  test("a role holding view:finance and the system owner both get the full working, which foots to the profit", async () => {
    for (const owner of [false, true]) {
      const s = await fixture({ stock: true });
      if (owner) await setRole(s, [], true);
      const row = (await s.report())!.sales[0];
      const lines = row.profitLines ?? [];
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.reduce((total, line) => total + line.sign * line.amount, 0)).toBeCloseTo(1133.7, 6);
      expect(row.netProfit).toBe(1133.7);
    }
  });
});
