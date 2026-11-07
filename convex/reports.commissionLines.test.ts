// NON-PILOT-CERTIFYING: directly seeds legacy deal commission lines for report coverage.
// The pilot census treats this insert as opening the commission-line door. Legacy rows
// still need coverage. No containment switch is replaced or changed by this suite.
import { describe, expect, test } from "vitest";
import { DATE, reportDealFixture as fixture } from "../test-utils/reportDealFixture";
import { api } from "./_generated/api";
import { ALL_PERMISSIONS, DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";

describe("SCRUM-928 reports include legacy commission lines", () => {
  // Scenario records require one non-parameterized registration per binding.
  test("owner before commissions: MANAGER SOURCED financed", async () => {
    await expectCommissionSplit({ role: "MANAGER", cash: false, before: 1133.7, after: 998.7, pageMinor: 998700 });
  });
  test("owner before commissions: ADMIN SOURCED financed", async () => {
    await expectCommissionSplit({ role: "ADMIN", cash: false, before: 1133.7, after: 998.7, pageMinor: 998700 });
  });
  test("owner before commissions: MANAGER CASH", async () => {
    await expectCommissionSplit({ role: "MANAGER", cash: true, before: 1900, after: 1765, pageMinor: 1765000 });
  });
  test("owner before commissions: ADMIN CASH", async () => {
    await expectCommissionSplit({ role: "ADMIN", cash: true, before: 1900, after: 1765, pageMinor: 1765000 });
  });
  async function expectCommissionSplit({ role, cash, before, after, pageMinor }: {
    role: "MANAGER" | "ADMIN"; cash: boolean; before: number; after: number; pageMinor: number;
  }) {
    const s = await fixture({ cash });
    await s.t.run(async (ctx) => {
      await ctx.db.insert("dealCommissionLines", {
        orgId: s.orgId, saleId: s.saleId, kind: "PURCHASE", employeeId: s.userId,
        amountMinor: 25000, currency: "JOD", createdBy: s.userId,
      });
    });
    const page = await s.deal();
    expect(page.profit).toMatchObject({ available: true, amountMinor: pageMinor });
    await s.t.run(async (ctx) => {
      const manager = DEFAULT_ROLE_TEMPLATES.find((template) => template.name === "MANAGER");
      if (!manager) throw new Error("MANAGER template missing");
      await ctx.db.patch(s.roleId, { name: role, permissions: role === "MANAGER" ? manager.permissions : ALL_PERMISSIONS });
    });
    const report = await s.report();
    expect(report!.sales[0]).toMatchObject({ netProfit: before, netProfitAfterCommissions: after, commissionsTotal: 135 });
    expect(report).toMatchObject({ totalProfit: before, totalNetProfitAfterCommissions: after, totalCommissions: 135, commissionIncompleteSaleCount: 0 });
    expect(await s.asUser.query(api.reports.getSalespersonPerformance, { orgId: s.orgId, startDate: DATE, endDate: DATE }))
      .toMatchObject([{ totalProfit: before, totalNetProfitAfterCommissions: after, totalCommissions: 135, commissionIncompleteSaleCount: 0 }]);
  }
});
