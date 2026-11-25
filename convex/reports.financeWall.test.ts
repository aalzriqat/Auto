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
const manager = DEFAULT_ROLE_TEMPLATES.find((template) => template.name === "MANAGER");
if (!manager) throw new Error("MANAGER template missing");

const callers = [
  { label: "every permission except view:finance", permissions: withoutFinance },
  { label: "the default MANAGER template", permissions: manager.permissions },
] as const;
const deals = [
  { label: "consignment (SOURCED) financed deal", options: {} },
  { label: "own-stock financed deal with a dealer contribution", options: { stock: true } },
] as const;

async function setRole(s: Fixture, permissions: readonly string[], isSystemOwnerRole = false) {
  await s.t.run((ctx) => ctx.db.patch(s.roleId, { permissions: [...permissions] as typeof ALL_PERMISSIONS, isSystemOwnerRole }));
}

describe("SCRUM-928 the report working stays behind the finance wall", () => {
  describe.each(callers)("$label", ({ permissions }) => {
    test.each(deals)("$label: no working, same figures, classification still served", async ({ options }) => {
      expect(permissions).not.toContain("view:finance");
      const s = await fixture(options);
      const owner = (await s.report())!.sales[0];
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
      const { profitLines: _lines, ...ownerRest } = owner;
      expect(row).toEqual(expect.objectContaining(Object.fromEntries(Object.entries(ownerRest).filter(([key]) => !["commissionBase", "consignedSupplierConcessionMinor"].includes(key)))));
      expect(report.totalProfit).toBe(1133.7);
      expect(report.totalNetProfitAfterCommissions).toBe(1023.7);
    });

    test("an estimated deal keeps its classification without its working", async () => {
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
      await setRole(s, permissions);
      const row = (await s.report())!.sales[0];
      expect(row).not.toHaveProperty("profitLines");
      expect(row.profitClassification).toBe("ESTIMATED_AWAITING_SETTLEMENT");
      expect(row).toMatchObject({ netProfit: 985, netProfitAfterCommissions: 875 });
    });

    test("the deal page serves it no financial summary, so no before-commissions subtotal either", async () => {
      const s = await fixture({ stock: true });
      await setRole(s, permissions);
      const overview = await s.asUser.query(api.dealOverview.financedDealOverview, { orgId: s.orgId, applicationId: s.applicationId! });
      expect(overview?.financialSummary ?? null).toBeNull();
    });
  });

  describe.each(deals)("a caller with view:finance, $label", ({ options }) => {
    test.each([
      { who: "a role holding view:finance", owner: false },
      { who: "the system owner", owner: true },
    ])("$who gets the full working and it foots to the profit", async ({ owner }) => {
      const s = await fixture(options);
      if (owner) await setRole(s, [], true);
      const row = (await s.report())!.sales[0];
      const lines = row.profitLines ?? [];
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.reduce((total, line) => total + line.sign * line.amount, 0)).toBeCloseTo(1133.7, 6);
      expect(row.netProfit).toBe(1133.7);
    });
  });
});
