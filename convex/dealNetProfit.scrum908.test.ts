import { expect, test } from "vitest";
import { seedDealNetProfit } from "../test-utils/dealNetProfitFixture";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

test("SCRUM-908 sourced financed net subtracts all car expenses and commissions: 1009.2", async () => {
  const s = await seedDealNetProfit(modules);
  expect(await s.read()).toMatchObject({ available: true, amountMinor: 1_009_200 });
});

test("SCRUM-908 STOCK capitalized expense is deducted once through the vehicle basis", async () => {
  const s = await seedDealNetProfit(modules, "STOCK");
  await s.expense({ accountingTreatment: "CAPITALIZED_INVENTORY", capitalizedAmount: 200 });
  expect(await s.read()).toMatchObject({ available: true, amountMinor: 1_009_200 });
});

test("SCRUM-908 unreadable commission withholds profit rather than treating it as zero", async () => {
  const s = await seedDealNetProfit(modules);
  await s.t.run((ctx) => ctx.db.patch(s.commissionIds[0], { amountMinor: Number.NaN }));
  expect(await s.read()).toMatchObject({ available: false });
});

test("SCRUM-908 execution fee and car expenses remain separate operands", async () => {
  const s = await seedDealNetProfit(modules);
  const p = await s.read();
  expect(p).toMatchObject({ available: true, amountMinor: 1_009_200 });
  if (!p?.available) throw new Error("expected readable net");
  expect(p.lines).toEqual(expect.arrayContaining([
    { key: "ACTUAL_EXPENSES", sign: -1, amountMinor: 451_300 },
    { key: "PREPARATION_EXPENSES", sign: -1, amountMinor: 314_500 },
    { key: "COMMISSIONS", sign: -1, amountMinor: 110_000 },
  ]));
  await s.t.run((ctx) => ctx.db.patch(s.feeId, { actualAmountMinor: 463_300 }));
  expect(await s.read()).toMatchObject({ available: true, amountMinor: 997_200 });
});

test.each(["STOCK", "SOURCED"] as const)("SCRUM-908 cash %s net is management profit and leaves its accounting margin intact", async (sourceType) => {
  const s = await seedDealNetProfit(modules, sourceType, false);
  expect(await s.read()).toMatchObject({
    available: true, basis: "MANAGEMENT_NET", amountMinor: 1_775_500, postable: false,
  });
  const view = await s.asOwner.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
  expect(view?.money?.profit).toMatchObject({
    available: true, basis: "ACCOUNTING_RESULT", amountMinor: 2_200_000, reconcilesToLedger: true,
  });
});

test("SCRUM-908 cash STOCK unreadable capitalized cost withholds management net", async () => {
  const s = await seedDealNetProfit(modules, "STOCK", false);
  await s.expense({ accountingTreatment: "CAPITALIZED_INVENTORY", capitalizedAmount: undefined });
  expect(await s.read()).toMatchObject({ available: false });
});

test.each([-10, 10.0005, Number.NaN])("SCRUM-908 unreadable salesperson commission %s withholds net", async (commissionAmount) => {
  const s = await seedDealNetProfit(modules);
  await s.t.run((ctx) => ctx.db.patch(s.saleId, { commissionAmount }));
  expect(await s.read()).toMatchObject({ available: false });
});

test.each([
  ["foreign", { currency: "USD" }],
  ["fractional", { amountMinor: 0.5 }],
  ["negative", { amountMinor: -1 }],
] as const)("SCRUM-908 %s commission makes net unavailable", async (_tag, patch) => {
  const s = await seedDealNetProfit(modules);
  await s.t.run((ctx) => ctx.db.patch(s.commissionIds[0], patch));
  expect(await s.read()).toMatchObject({ available: false });
});

test("SCRUM-908 pending salesperson commission is unknown, never zero", async () => {
  const s = await seedDealNetProfit(modules);
  await s.t.run((ctx) => ctx.db.patch(s.saleId, { commissionAmount: undefined }));
  expect(await s.read()).toMatchObject({ available: false });
});

test("SCRUM-908 a decided salesperson commission joins the registered lines exactly once", async () => {
  const s = await seedDealNetProfit(modules);
  await s.t.run((ctx) => ctx.db.patch(s.saleId, { commissionAmount: 25 }));
  expect(await s.read()).toMatchObject({ available: true, amountMinor: 984_200 });
});

test("SCRUM-908 removed commissions and reversed or supplier expenses do not reduce net", async () => {
  const s = await seedDealNetProfit(modules);
  await s.t.run((ctx) => ctx.db.patch(s.commissionIds[0], { removedAt: 2 }));
  await s.expense({ reversedAt: 2 });
  await s.t.run((ctx) => ctx.db.patch(s.expenseIds[1], { costBearer: "SUPPLIER" }));
  expect(await s.read()).toMatchObject({ available: true, amountMinor: 1_381_700 });
});

test("SCRUM-908 paid car expenses net recoverable VAT regardless of category or registration date", async () => {
  const s = await seedDealNetProfit(modules);
  await s.expense({ category: "PREPAID", taxAmount: 20 });
  expect(await s.read()).toMatchObject({ available: true, amountMinor: 1_029_200 });
});

test("SCRUM-908 unreadable expense withholds net", async () => {
  const s = await seedDealNetProfit(modules);
  await s.expense({ amount: Number.NaN });
  expect(await s.read()).toMatchObject({ available: false });
});

test("SCRUM-908 commission permission withholds the net without exposing pay through a deduction", async () => {
  const s = await seedDealNetProfit(modules);
  await s.t.run((ctx) => ctx.db.patch(s.roleId, {
    name: "Finance reader", isSystemOwnerRole: false,
    permissions: ["view:sales", "view:finance", "view:cost_price"],
  }));
  expect(await s.read()).toEqual({ available: false, reason: "CommissionAccessRequired" });
});

test("SCRUM-908 commission cap withholds the result and keeps the overview readable", async () => {
  const s = await seedDealNetProfit(modules);
  await s.t.run(async (ctx) => {
    for (let index = 0; index < 99; index += 1) {
      await ctx.db.insert("dealCommissionLines", {
        orgId: s.orgId, saleId: s.saleId, employeeId: s.userId, createdBy: s.userId,
        kind: "SALE", amountMinor: 1, currency: "JOD", removedAt: 1,
      });
    }
  });
  expect(await s.read()).toMatchObject({ available: false, reason: "CommissionsUnreadable" });
  expect(await s.asOwner.query(api.dealCommissions.forSale, { orgId: s.orgId, saleId: s.saleId }))
    .toMatchObject({ totalMinor: null, lineEvidence: "UNAVAILABLE" });
});

test("SCRUM-908 expense cap refuses a prefix total", async () => {
  const s = await seedDealNetProfit(modules);
  await s.t.run(async (ctx) => {
    for (let index = 0; index < 197; index += 1) {
      await ctx.db.insert("expenses", {
        orgId: s.orgId, vehicleId: s.vehicleId, title: "Synthetic cap control", amount: 1,
        date: 1, category: "OTHER", status: "PAID", accountingTreatment: "PERIOD_EXPENSE",
      });
    }
  });
  expect(await s.read()).toMatchObject({ available: false });
});
