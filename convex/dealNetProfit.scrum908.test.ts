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

test.each([false, true])("SCRUM-908 financed=%s STOCK completed work order is a period expense deducted once, including legacy rows", async (financed) => {
  const s = await seedDealNetProfit(modules, "STOCK", financed);
  const workOrderId = await s.asOwner.mutation(api.workOrders.create, {
    orgId: s.orgId, vehicleId: s.vehicleId, title: "Synthetic repair", status: "COMPLETED",
    idempotencyKey: "scrum908-work-order",
    tasks: [{ id: "repair", description: "Synthetic repair", partsCost: 12, laborCost: 8, completed: true }],
  });
  const expense = await s.t.run(async (ctx) => {
    const workOrder = await ctx.db.get(workOrderId);
    if (!workOrder?.expenseId) throw new Error("Expected work order expense");
    return ctx.db.get(workOrder.expenseId);
  });
  // This numeric assertion reproduces the headline failure before checking the writer's new metadata.
  expect(await s.read()).toMatchObject({ available: true, amountMinor: financed ? 989_200 : 1_755_500 });
  expect(expense?.accountingTreatment).toBe("PERIOD_EXPENSE");
  if (!expense) throw new Error("Expected expense");
  await s.t.run((ctx) => ctx.db.patch(expense._id, { accountingTreatment: undefined }));
  expect(await s.read()).toMatchObject({ available: true, amountMinor: financed ? 989_200 : 1_755_500 });
});

test("SCRUM-908 an unknown STOCK legacy expense cannot claim work-order provenance by its title", async () => {
  const s = await seedDealNetProfit(modules, "STOCK");
  await s.expense({ title: "Work Order: Synthetic repair", accountingTreatment: undefined });
  expect(await s.read()).toMatchObject({ available: false });
});

test.each(["STOCK", "SOURCED"] as const)("SCRUM-908 %s legacy work-order links prove period treatment", async (sourceType) => {
  const s = await seedDealNetProfit(modules, sourceType);
  await s.t.run(async (ctx) => {
    const expenseId = await ctx.db.insert("expenses", {
      orgId: s.orgId, vehicleId: s.vehicleId, title: "Legacy work order", amount: 20,
      category: "REPAIR", status: "PAID", date: 1,
    });
    await ctx.db.insert("workOrders", {
      orgId: s.orgId, vehicleId: s.vehicleId, title: "Legacy work order", status: "COMPLETED",
      totalCost: 20, tasks: [], expenseId,
    });
  });
  expect(await s.read()).toMatchObject({ available: true, amountMinor: 989_200 });
});

test.each(["foreign org", "different vehicle", "different amount", "truncated links"] as const)(
  "SCRUM-908 %s cannot prove a legacy expense's work-order treatment", async (evidence) => {
    const s = await seedDealNetProfit(modules, "STOCK");
    await s.expense({ category: "REPAIR", accountingTreatment: undefined });
    await s.t.run(async (ctx) => {
      const orgId = evidence === "foreign org"
        ? await ctx.db.insert("organizations", { name: "Synthetic foreign org", createdAt: 1 }) : s.orgId;
      const vehicleId = evidence === "different vehicle"
        ? await ctx.db.insert("vehicles", {
          orgId, vin: "SYNTHETIC908-OTHER", make: "Example", model: "Other", year: 2026, mileage: 0,
          color: "White", fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 12_100, status: "AVAILABLE",
        }) : s.vehicleId;
      const count = evidence === "truncated links" ? 201 : 1;
      for (let index = 0; index < count; index += 1) {
        await ctx.db.insert("workOrders", {
          orgId, vehicleId, title: "Synthetic provenance", status: "COMPLETED", tasks: [],
          totalCost: evidence === "different amount" ? 201 : 200,
          ...(index === 0 ? { expenseId: s.expenseIds[0] } : {}),
        });
      }
    });
    expect(await s.read()).toMatchObject({ available: false });
  }
);

test("SCRUM-908 unreadable commission withholds profit rather than treating it as zero", async () => {
  const s = await seedDealNetProfit(modules);
  await s.t.run((ctx) => ctx.db.patch(s.commissionIds[0], { amountMinor: Number.NaN }));
  expect(await s.read()).toEqual({ available: false, reason: "CommissionsUnreadable" });
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
  expect(await s.read()).toEqual({ available: false, reason: "CommissionsPending" });
});

test.each([
  [false, "SOURCED"], [true, "SOURCED"], [false, "STOCK"], [true, "STOCK"],
] as const)("SCRUM-908 financed=%s %s management net requires cost permission", async (financed, sourceType) => {
  const s = await seedDealNetProfit(modules, sourceType, financed);
  await s.t.run((ctx) => ctx.db.patch(s.roleId, {
    name: "Deal reader", isSystemOwnerRole: false,
    permissions: ["view:sales", "view:finance", "view:commissions"],
  }));
  expect(await s.read()).toEqual({ available: false, reason: "CostAccessRequired" });
  await s.t.run((ctx) => ctx.db.patch(s.roleId, {
    permissions: ["view:sales", "view:finance", "view:commissions", "view:cost_price"],
  }));
  expect(await s.read()).toMatchObject({ available: true, amountMinor: financed ? 1_009_200 : 1_775_500 });
});

test.each([
  [false, "SOURCED"], [true, "SOURCED"], [false, "STOCK"], [true, "STOCK"],
] as const)("SCRUM-908 complete cockpit responses financed=%s %s withhold every cost projection", async (financed, sourceType) => {
  const s = await seedDealNetProfit(modules, sourceType, financed);
  const permissions = ["view:sales", "view:finance", "view:commissions"];
  await s.t.run((ctx) => ctx.db.patch(s.roleId, {
    name: "Deal reader", isSystemOwnerRole: false, permissions: [...permissions, "view:cost_price"],
  }));
  const readApplication = () => s.asOwner.query(api.applications.dealCockpit, {
    orgId: s.orgId, applicationId: s.applicationId,
  });
  const readSale = () => s.asOwner.query(api.sales.dealCockpit, { orgId: s.orgId, saleId: s.saleId });
  const allowedApplication = await readApplication();
  const allowedSale = await readSale();
  if (!allowedApplication?.money || (!financed && !allowedSale?.money)) throw new Error("Expected finance evidence");
  expect(allowedApplication.money.profit).toMatchObject(sourceType === "SOURCED"
    ? { available: true, amountMinor: 1_433_700 }
    : { available: false, reason: "NoSupplierSettlement" });
  expect(allowedApplication.money.managementProfit).toEqual(allowedApplication.money.profit);
  if (!financed) expect(allowedSale?.money?.profit).toMatchObject({ available: true, amountMinor: 2_200_000 });
  else expect(allowedSale?.money).toBeNull(); // The application is the sole financed money reader.

  await s.t.run((ctx) => ctx.db.patch(s.roleId, { permissions }));
  const withheld = { available: false, reason: "CostAccessRequired" };
  const restrictedApplication = await readApplication();
  const restrictedSale = await readSale();
  // Compare the COMPLETE API payloads. Only the declared cost projections may change;
  // all other finance evidence must remain readable.
  expect(restrictedApplication).toEqual({
    ...allowedApplication,
    money: {
      ...allowedApplication.money, profit: withheld, managementProfit: withheld,
      parties: allowedApplication.money.parties.map((party) =>
        party.party === "SUPPLIER" ? { ...party, amountMinor: null } : party),
    },
  });
  expect(restrictedSale).toEqual(!financed && allowedSale?.money ? {
    ...allowedSale,
    money: {
      ...allowedSale.money, profit: withheld, managementNetProfit: withheld,
      parties: allowedSale.money.parties.map((party) => ({ ...party, amountMinor: null })),
    },
  } : allowedSale);
  for (const response of [restrictedApplication, restrictedSale]) {
    const wire = JSON.stringify(response);
    for (const costField of ["SUPPLIER_SETTLEMENT", "VEHICLE_COST", "SUPPLIER_ENTITLEMENT", "ACCOUNTING_MARGIN", "purchasePrice", "sourceCost"]) {
      expect(wire).not.toContain(`"${costField}"`);
    }
    expect(wire).not.toContain("9900000");
  }

  // Owner bypass is independent of explicit grants, including view:finance/cost.
  await s.t.run((ctx) => ctx.db.patch(s.roleId, { name: "OWNER", isSystemOwnerRole: true, permissions: [] }));
  expect((await readApplication())?.money).toMatchObject({
    profit: allowedApplication.money.profit, managementProfit: allowedApplication.money.managementProfit,
    parties: allowedApplication.money.parties,
  });
  if (!financed) expect((await readSale())?.money).toMatchObject({
    profit: allowedSale?.money?.profit, managementNetProfit: allowedSale?.money?.managementNetProfit,
  });
});

test.each(["deleted", "foreign"] as const)("SCRUM-908 %s finalized sale cannot supply commission evidence", async (state) => {
  const s = await seedDealNetProfit(modules, "STOCK");
  expect(await s.read()).toMatchObject({ available: true, amountMinor: 1_009_200 });
  await s.t.run(async (ctx) => {
    if (state === "deleted") await ctx.db.patch(s.saleId, { isDeleted: true });
    else {
      const orgId = await ctx.db.insert("organizations", { name: "Synthetic foreign sale", createdAt: 1 });
      await ctx.db.patch(s.saleId, { orgId });
    }
  });
  expect(await s.read()).toEqual({ available: false, reason: "CommissionsUnreadable" });
});

test.each(["missing cost", "mixed currency"] as const)("SCRUM-908 cash STOCK %s has a cost-basis refusal", async (state) => {
  const s = await seedDealNetProfit(modules, "STOCK", false);
  if (state === "missing cost") await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { purchasePrice: undefined }));
  else await s.t.run(async (ctx) => {
    const settings = await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).unique();
    if (!settings) throw new Error("Expected settings");
    await ctx.db.patch(settings._id, { currency: "USD" });
  });
  expect(await s.read()).toEqual({ available: false, reason: "VehicleCostBasisUnreadable" });
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

test.each([false, true])("SCRUM-908 financed=%s commission permission withholds the net without exposing pay through a deduction", async (financed) => {
  const s = await seedDealNetProfit(modules, "SOURCED", financed);
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
  expect(await s.read()).toMatchObject({ available: false, reason: "CommissionsReadBoundExceeded" });
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
