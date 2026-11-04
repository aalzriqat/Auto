import { expect, test } from "vitest";
import { seedFinancedDealership, newApplication } from "../test-utils/financedDealFixture";
import { api } from "./_generated/api";
import { ALL_PERMISSIONS } from "./utils/permissions";

async function fixture(tag: string) {
  const permissions = ["view:vehicles", "view:finance_applications", "view:finance"];
  return seedFinancedDealership(tag, {
    modules: import.meta.glob("./**/*.ts"), ownerPerms: ALL_PERMISSIONS,
    label: "Synthetic cost sweep", vinPrefix: "S902G", sourced: true,
    actors: { NoCost: permissions, Cost: [...permissions, "view:cost_price"] },
  });
}

test.each([false, true])("SCRUM-902 work orders with vehicle filter=%s require cost access", async filtered => {
  const s = await fixture(`work-${filtered}`);
  await s.t.run(ctx => ctx.db.insert("workOrders", {
    orgId: s.orgId, vehicleId: s.vehicleId, title: "Synthetic repair", status: "OPEN", totalCost: 150,
    tasks: [{ id: "repair", description: "Parts and labor", partsCost: 100, laborCost: 50, completed: false }],
  }));
  const args = { orgId: s.orgId, ...(filtered ? { vehicleId: s.vehicleId } : {}) };
  expect(await s.actors.Cost.as.query(api.workOrders.list, args)).toMatchObject([
    { totalCost: 150, tasks: [{ partsCost: 100, laborCost: 50 }] },
  ]);
  await expect(s.actors.NoCost.as.query(api.workOrders.list, args)).rejects.toThrow(/view:cost_price/);
});

test("SCRUM-902 bundled deal cost reader protects acquisition lines and their totals", async () => {
  const s = await fixture("fees");
  const { applicationId } = await newApplication(s);
  await s.t.run(async ctx => {
    const common = { orgId: s.orgId, applicationId, currency: "JOD", paidBy: "DEALER" as const,
      paidTo: "OTHER" as const, includedInQuotation: false, deductedFromSettlement: false, refundable: false,
      source: "MANUAL" as const, createdBy: s.owner.userId, createdAt: Date.now(), updatedAt: Date.now() };
    await ctx.db.insert("financeDealFees", { ...common, feeType: "OTHER_CLOSING_EXPENSE",
      description: "Synthetic acquisition entitlement", accountingTreatment: "CAPITALIZED_TO_VEHICLE",
      estimatedAmountMinor: 9000000, actualAmountMinor: 9000000 });
    await ctx.db.insert("financeDealFees", { ...common, feeType: "LICENSING",
      description: "Ordinary deal fee", accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE", actualAmountMinor: 20000 });
  });
  const args = { orgId: s.orgId, applicationId };
  const granted = await s.actors.Cost.as.query(api.financeDealCosts.listDealCosts, args);
  expect(granted.fees).toEqual(expect.arrayContaining([
    expect.objectContaining({ accountingTreatment: "CAPITALIZED_TO_VEHICLE", actualAmountMinor: 9000000 }),
    expect.objectContaining({ accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE", actualAmountMinor: 20000 }),
  ]));
  expect(granted.summary?.actualTotalMinor).toBe(9020000);
  await expect(s.actors.NoCost.as.query(api.financeDealCosts.listDealCosts, args)).rejects.toThrow(/view:cost_price/);
});
