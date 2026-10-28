/**
 * SCRUM-778, owner ruling SCRUM-760 c23812 #6 (2026-10-28): unset means
 * MANUAL. Automatic accrual requires explicit AUTO opt-in. Historical amounts
 * are preserved; manager-authorized amounts still reach journals and payroll.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { effectiveCommissionMode } from "./utils/commissionMode";
import { payFullPriceByDeposit } from "../test-utils/cashDealerFixture";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { expectAppError } from "../test-utils/expectAppError";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const PERMISSIONS = [
  "create:sales", "view:sales", "edit:sales", "view:vehicles",
  "view:commissions", "manage:commissions", "view:finance", "manage:finance",
  "view:payroll", "manage:payroll",
];

/**
 * A dealership whose salesperson carries a 10% member rate, so an automatic
 * mode WOULD produce a commission. `commissionMode` omitted = never chosen.
 */
async function seedDealer(suffix: string, commissionMode?: "MANUAL" | "AUTO_MEMBER" | "AUTO_TIERS", commissionRate = 10) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S778 ${suffix}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `s778_${suffix}`, email: `s778${suffix}@example.com`, name: "Rep User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: PERMISSIONS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId, commissionRate }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "USD", currencySymbol: "$", enabledPaymentTypes: ["CASH"],
      ...(commissionMode ? { commissionMode } : {}),
      ...(commissionMode === "AUTO_TIERS" ? { commissionTiers: [{ minProfitAmount: 0, commissionPct: 10 }] } : {}),
    })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VIN-S778-${suffix}`, make: "Honda", model: "Accord", year: 2020, color: "Black",
      fuelType: "Gasoline", transmission: "Automatic", mileage: 50000,
      purchasePrice: 10000, sellingPrice: 15000, status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "John", lastName: "Doe", email: `${suffix}.c@example.com` })
  );
  const as = t.withIdentity({ subject: `s778_${suffix}`, clerkId: `s778_${suffix}` });
  await as.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await as.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999), fiscalYear, periodNumber: 1,
  });
  const period = (await as.query(api.accountingPeriods.list, { orgId }))[0];
  await as.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  // SCRUM-802 (#526): a cash sale completes only once the deposit holds the full price, so the fixture pays first.
  const completeSale = async () =>
    as.mutation(api.sales.create, {
      quoteId: await payFullPriceByDeposit(as, { orgId, customerId, vehicleId, price: 15000 }),
      idempotencyKey: crypto.randomUUID(), orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH",
    });

  /** Net Commission Payable in minor units, straight off the GL. */
  const commissionPayableMinor = () =>
    t.run(async (ctx) => {
      const account = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "COMMISSION_PAYABLE"))
        .unique();
      if (!account) return 0;
      const lines = await ctx.db
        .query("journalLines")
        .withIndex("by_org_account", (q) => q.eq("orgId", orgId).eq("accountId", account._id))
        .collect();
      return lines.reduce((sum, l) => sum + l.creditMinor - l.debitMinor, 0);
    });

  return { t, orgId, userId, as, completeSale, commissionPayableMinor };
}

describe("SCRUM-778: an unset commission mode means MANUAL", () => {
  test("the shared resolver reads an unset mode as MANUAL and keeps explicit modes", () => {
    expect(effectiveCommissionMode(null)).toBe("MANUAL");
    expect(effectiveCommissionMode(undefined)).toBe("MANUAL");
    expect(effectiveCommissionMode({})).toBe("MANUAL");
    expect(effectiveCommissionMode({ commissionMode: "AUTO_MEMBER" })).toBe("AUTO_MEMBER");
    expect(effectiveCommissionMode({ commissionMode: "AUTO_TIERS" })).toBe("AUTO_TIERS");
    expect(effectiveCommissionMode({ commissionMode: "MANUAL" })).toBe("MANUAL");
  });

  test("completing a sale with no mode stored accrues no automatic commission", async () => {
    const d = await seedDealer("unset");
    const saleId = await d.completeSale();
    const sale = await d.t.run((ctx) => ctx.db.get(saleId));
    expect(sale?.status).toBe("COMPLETED");
    expect(sale?.commissionAmount).toBeUndefined();
    expect(await d.commissionPayableMinor()).toBe(0);
    expect(await d.as.query(api.orgSettings.getCommissionMode, { orgId: d.orgId })).toBe("MANUAL");
    const row = await d.t.run((ctx) => ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", d.orgId)).unique());
    expect(row).not.toBeNull();
    expect(row).not.toHaveProperty("commissionMode");
    expect(await d.t.run((ctx) => ctx.db.query("adminAuditLog").collect())).toHaveLength(0);
  });

  test("with no mode stored, recalculation refuses without creating a commission or journal", async () => {
    const d = await seedDealer("unset_recalc");
    const saleId = await d.completeSale();
    const before = await dbSnapshot(d.t, Object.keys(schema.tables));
    await expect(d.as.mutation(api.sales.recalculateCommission, { orgId: d.orgId, saleId }))
      .rejects.toThrow(/automatic commission modes/i);
    expect(await dbSnapshot(d.t, Object.keys(schema.tables))).toEqual(before);
    expect(await d.commissionPayableMinor()).toBe(0);
  });

  test.each(["AUTO_MEMBER", "AUTO_TIERS"] as const)("explicit %s still accrues and keeps its stored opt-in", async (mode) => {
    const d = await seedDealer(`explicit_${mode}`, mode);
    const saleId = await d.completeSale();
    expect((await d.t.run((ctx) => ctx.db.get(saleId)))?.commissionAmount).toBe(500);
    expect(await d.commissionPayableMinor()).toBe(50_000);
    expect(await d.as.query(api.orgSettings.getCommissionMode, { orgId: d.orgId })).toBe(mode);
    const settings = await d.t.run((ctx) => ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", d.orgId)).unique());
    expect(settings?.commissionMode).toBe(mode);
    const before = await dbSnapshot(d.t, Object.keys(schema.tables));
    await expect(d.as.mutation(api.sales.recalculateCommission, { orgId: d.orgId, saleId })).rejects.toThrow(/correction workflow/i);
    expect(await dbSnapshot(d.t, Object.keys(schema.tables))).toEqual(before);
  });

  test("manager entry under the unset MANUAL default posts once and payroll clears only the payable", async () => {
    const mode = "unset";
    const d = await seedDealer("manual_unset");
    const saleId = await d.completeSale();
    expect((await d.t.run((ctx) => ctx.db.get(saleId)))?.commissionAmount).toBeUndefined();
    expect(await d.commissionPayableMinor()).toBe(0);
    const managerId = await d.t.run((ctx) => ctx.db.insert("users", { clerkId: `manager_${mode}`, email: `manager_${mode}@example.com`, name: "Manager" }));
    const roleId = await d.t.run((ctx) => ctx.db.insert("roles", { orgId: d.orgId, name: "MANAGER", permissions: ["view:commissions", "manage:commissions"] }));
    await d.t.run((ctx) => ctx.db.insert("memberships", { orgId: d.orgId, userId: managerId, roleId }));
    const manager = d.t.withIdentity({ subject: `manager_${mode}`, clerkId: `manager_${mode}` });
    const enter = () => manager.mutation(api.sales.setCommissionAmount, { orgId: d.orgId, saleId, commissionAmount: 250 });
    await enter();
    await enter();
    expect(await d.commissionPayableMinor()).toBe(25_000);
    const accrual = await d.t.run(async (ctx) => {
      const entries = await ctx.db.query("journalEntries").withIndex("by_org_source", (q) => q.eq("orgId", d.orgId).eq("sourceType", "sales").eq("sourceId", `commission_${saleId}`)).collect();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ orgId: d.orgId, status: "POSTED", postedBy: managerId });
      const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entries[0]._id)).collect();
      return Promise.all(lines.map(async (line) => ({
        account: (await ctx.db.get(line.accountId))?.systemKey,
        orgId: line.orgId,
        salespersonId: line.salespersonId,
        currency: line.currency,
        debitMinor: line.debitMinor,
        creditMinor: line.creditMinor,
      })));
    });
    expect(accrual).toEqual([
      { account: "COMMISSION_EXPENSE", orgId: d.orgId, salespersonId: d.userId, currency: "USD", debitMinor: 25_000, creditMinor: 0 },
      { account: "COMMISSION_PAYABLE", orgId: d.orgId, salespersonId: d.userId, currency: "USD", debitMinor: 0, creditMinor: 25_000 },
    ]);
    const now = new Date();
    const runId = await d.as.mutation(api.payroll.createRun, { orgId: d.orgId, periodYear: now.getUTCFullYear(), periodMonth: now.getUTCMonth() + 1 });
    await d.as.mutation(api.payroll.approveRun, { orgId: d.orgId, runId });
    expect(await d.commissionPayableMinor()).toBe(25_000);
    const item = await d.t.run((ctx) => ctx.db.query("payrollItems").withIndex("by_run", (q) => q.eq("runId", runId)).unique());
    expect(item).toMatchObject({ orgId: d.orgId, userId: d.userId, commissionMinor: 25_000, grossMinor: 25_000, commissionSaleIds: [saleId] });
    await d.as.mutation(api.payroll.payRun, { orgId: d.orgId, runId, method: "CASH" });
    expect(await d.commissionPayableMinor()).toBe(0);
    const expense = await d.t.run(async (ctx) => {
      const account = await ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", d.orgId).eq("systemKey", "COMMISSION_EXPENSE")).unique();
      if (!account) throw new Error("fixture commission expense missing");
      const lines = await ctx.db.query("journalLines").withIndex("by_org_account", (q) => q.eq("orgId", d.orgId).eq("accountId", account._id)).collect();
      return lines.reduce((sum, line) => sum + line.debitMinor - line.creditMinor, 0);
    });
    expect(expense).toBe(25_000);
    expect((await d.t.run((ctx) => ctx.db.get(saleId)))?.commissionPaidAt).toBeTypeOf("number");
  });

  test.each(["AUTO_MEMBER", "AUTO_TIERS"] as const)("explicit %s recalculates an uncomputed commission once", async (mode) => {
    const d = await seedDealer(`recalc_${mode}`, "MANUAL");
    const saleId = await d.completeSale();
    await d.as.mutation(api.orgSettings.setCommissionMode, { orgId: d.orgId, commissionMode: mode });
    if (mode === "AUTO_TIERS") {
      await d.t.run(async (ctx) => {
        const row = await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", d.orgId)).unique();
        if (!row) throw new Error("fixture settings missing");
        await ctx.db.patch(row._id, { commissionTiers: [{ minProfitAmount: 0, commissionPct: 10 }] });
      });
    }
    await d.as.mutation(api.sales.recalculateCommission, { orgId: d.orgId, saleId });
    expect((await d.t.run((ctx) => ctx.db.get(saleId)))?.commissionAmount).toBe(500);
    expect(await d.commissionPayableMinor()).toBe(50_000);
    const before = await dbSnapshot(d.t, Object.keys(schema.tables));
    await expect(d.as.mutation(api.sales.recalculateCommission, { orgId: d.orgId, saleId })).rejects.toThrow(/correction workflow/i);
    expect(await dbSnapshot(d.t, Object.keys(schema.tables))).toEqual(before);
  });

  test("a member without commission authority cannot enter a manual amount", async () => {
    const d = await seedDealer("unauthorized");
    const saleId = await d.completeSale();
    const userId = await d.t.run((ctx) => ctx.db.insert("users", { clerkId: "s778_reader", email: "reader@example.com", name: "Reader" }));
    const roleId = await d.t.run((ctx) => ctx.db.insert("roles", { orgId: d.orgId, name: "VIEWER", permissions: ["view:commissions"] }));
    await d.t.run((ctx) => ctx.db.insert("memberships", { orgId: d.orgId, userId, roleId }));
    const reader = d.t.withIdentity({ subject: "s778_reader", clerkId: "s778_reader" });
    const before = await dbSnapshot(d.t, Object.keys(schema.tables));
    await expect(reader.mutation(api.sales.setCommissionAmount, { orgId: d.orgId, saleId, commissionAmount: 250 })).rejects.toMatchObject({ data: { code: "FORBIDDEN" } });
    expect(await dbSnapshot(d.t, Object.keys(schema.tables))).toEqual(before);
  });

  test("historical AUTO-default accrual survives reads, refused recalculation, and payroll approval", async () => {
    // Reconstruct a pre-fix row with real completion journals, then remove only
    // its mode to represent the old unset organization. This is fixture setup.
    const d = await seedDealer("historical_default", "AUTO_MEMBER");
    const saleId = await d.completeSale();
    await d.t.run(async (ctx) => {
      const row = await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", d.orgId)).unique();
      if (!row) throw new Error("fixture settings missing");
      await ctx.db.patch(row._id, { commissionMode: undefined });
    });
    const before = await dbSnapshot(d.t, Object.keys(schema.tables));
    await d.as.query(api.orgSettings.getCommissionMode, { orgId: d.orgId });
    await d.as.query(api.sales.listCommissionsPaginated, { orgId: d.orgId, paginationOpts: { numItems: 20, cursor: null } });
    await expect(d.as.mutation(api.sales.recalculateCommission, { orgId: d.orgId, saleId })).rejects.toThrow(/correction workflow/i);
    expect(await dbSnapshot(d.t, Object.keys(schema.tables))).toEqual(before);
    expect(await d.commissionPayableMinor()).toBe(50_000);
    const now = new Date();
    const runId = await d.as.mutation(api.payroll.createRun, { orgId: d.orgId, periodYear: now.getUTCFullYear(), periodMonth: now.getUTCMonth() + 1 });
    await d.as.mutation(api.payroll.approveRun, { orgId: d.orgId, runId });
    expect(await d.commissionPayableMinor()).toBe(50_000);
    expect((await d.t.run((ctx) => ctx.db.get(saleId)))?.commissionAmount).toBe(500);
  });

  // Reproduce a historical AUTO-default accrual without changing its amount or journals.
  async function historicalAccrual(tag: string) {
    const d = await seedDealer(tag, "AUTO_MEMBER");
    const saleId = await d.completeSale();
    await d.t.run(async (ctx) => {
      const row = await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", d.orgId)).unique();
      if (!row) throw new Error("fixture settings missing");
      await ctx.db.patch(row._id, { commissionMode: undefined });
    });
    expect(await d.as.query(api.orgSettings.getCommissionMode, { orgId: d.orgId })).toBe("MANUAL");
    expect(await d.commissionPayableMinor()).toBe(50_000);
    return { ...d, saleId };
  }

  type HistoricalDealer = Awaited<ReturnType<typeof historicalAccrual>>;

  async function commissionExpenseMinor(d: HistoricalDealer) {
    return d.t.run(async (ctx) => {
      const account = await ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", d.orgId).eq("systemKey", "COMMISSION_EXPENSE")).unique();
      if (!account) throw new Error("fixture commission expense missing");
      const lines = await ctx.db.query("journalLines").withIndex("by_org_account", (q) => q.eq("orgId", d.orgId).eq("accountId", account._id)).collect();
      return lines.reduce((sum, line) => sum + line.debitMinor - line.creditMinor, 0);
    });
  }

  async function addManager(d: HistoricalDealer, tag: string) {
    const userId = await d.t.run((ctx) => ctx.db.insert("users", { clerkId: tag, email: `${tag}@example.com`, name: "Manager" }));
    const roleId = await d.t.run((ctx) => ctx.db.insert("roles", {
      orgId: d.orgId, name: "Manager", permissions: ["view:commissions", "manage:commissions", "view:sales", "edit:sales", "approve:requests", "manage:finance"],
    }));
    await d.t.run((ctx) => ctx.db.insert("memberships", { orgId: d.orgId, userId, roleId }));
    return { userId, as: d.t.withIdentity({ subject: tag, clerkId: tag }) };
  }

  async function payHistoricalCommission(d: HistoricalDealer, expectedMinor: number) {
    const now = new Date();
    const runId = await d.as.mutation(api.payroll.createRun, { orgId: d.orgId, periodYear: now.getUTCFullYear(), periodMonth: now.getUTCMonth() + 1 });
    await d.as.mutation(api.payroll.approveRun, { orgId: d.orgId, runId });
    expect(await d.commissionPayableMinor()).toBe(expectedMinor);
    const item = await d.t.run((ctx) => ctx.db.query("payrollItems").withIndex("by_run", (q) => q.eq("runId", runId)).unique());
    expect(item).toMatchObject({ orgId: d.orgId, userId: d.userId, commissionMinor: expectedMinor, netMinor: expectedMinor, commissionSaleIds: [d.saleId] });
    await d.as.mutation(api.payroll.payRun, { orgId: d.orgId, runId, method: "CASH" });
    expect(await d.commissionPayableMinor()).toBe(0);
    expect(await commissionExpenseMinor(d)).toBe(expectedMinor);
    expect((await d.t.run((ctx) => ctx.db.get(d.saleId)))?.commissionPaidAt).toBeTypeOf("number");
    const payment = await d.t.run(async (ctx) => {
      const events = await ctx.db.query("accountingEvents").withIndex("by_org_eventType", (q) => q.eq("orgId", d.orgId).eq("eventType", "PAYROLL_PAID")).collect();
      expect(events).toHaveLength(1);
      if (!events[0].journalEntryId) throw new Error("payroll journal missing");
      expect(events[0].status).toBe("POSTED");
      const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", events[0].journalEntryId!)).collect();
      return Promise.all(lines.map(async (line) => ({ key: (await ctx.db.get(line.accountId))?.systemKey, debitMinor: line.debitMinor, creditMinor: line.creditMinor })));
    });
    expect(payment).toEqual(expect.arrayContaining([
      { key: "COMMISSION_PAYABLE", debitMinor: expectedMinor, creditMinor: 0 },
      { key: "CASH_ON_HAND", debitMinor: 0, creditMinor: expectedMinor },
    ]));
    expect(payment).toHaveLength(2);
    const beforeRetry = await dbSnapshot(d.t, ["journalEntries", "journalLines", "accountingEvents"]);
    await expect(d.as.mutation(api.payroll.payRun, { orgId: d.orgId, runId, method: "CASH" })).rejects.toThrow(/approved payroll run/i);
    expect(await dbSnapshot(d.t, ["journalEntries", "journalLines", "accountingEvents"])).toEqual(beforeRetry);
  }

  test("payroll pays a historical unset-org accrual once without duplicating expense", async () => {
    const d = await historicalAccrual("historical_pay");
    await payHistoricalCommission(d, 50_000);
  });

  async function assertHistoricalAdjustment({ amount, deltaMinor, payableMinor, debitKey, creditKey }: {
    amount: number; deltaMinor: number; payableMinor: number; debitKey: string; creditKey: string;
  }) {
    const d = await historicalAccrual(`historical_adjust_${amount}`);
    const manager = await addManager(d, `historical_manager_${amount}`);
    const edit = () => manager.as.mutation(api.sales.setCommissionAmount, { orgId: d.orgId, saleId: d.saleId, commissionAmount: amount });
    await edit();
    await edit();
    expect(await d.commissionPayableMinor()).toBe(payableMinor);
    expect(await commissionExpenseMinor(d)).toBe(payableMinor);
    await d.t.run(async (ctx) => {
      const accruals = await ctx.db.query("accountingEvents").withIndex("by_org_eventType", (q) => q.eq("orgId", d.orgId).eq("eventType", "COMMISSION_ACCRUED")).collect();
      expect(accruals).toHaveLength(1);
      expect(accruals[0]).toMatchObject({ status: "POSTED", payload: { amountMinor: 50_000 } });
      const adjustments = await ctx.db.query("accountingEvents").withIndex("by_org_eventType", (q) => q.eq("orgId", d.orgId).eq("eventType", "COMMISSION_ADJUSTED")).collect();
      expect(adjustments).toHaveLength(1);
      const adjustment = adjustments[0];
      expect(adjustment).toMatchObject({ status: "POSTED", createdBy: manager.userId, payload: { saleId: d.saleId, deltaMinor } });
      if (!adjustment.journalEntryId) throw new Error("adjustment journal missing");
      const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", adjustment.journalEntryId!)).collect();
      const actual = await Promise.all(lines.map(async (line) => ({ key: (await ctx.db.get(line.accountId))?.systemKey, debitMinor: line.debitMinor, creditMinor: line.creditMinor })));
      expect(actual).toEqual(expect.arrayContaining([
        { key: debitKey, debitMinor: 12_500, creditMinor: 0 },
        { key: creditKey, debitMinor: 0, creditMinor: 12_500 },
      ]));
      expect(actual).toHaveLength(2);
    });
    await payHistoricalCommission(d, payableMinor);
  }

  test("a manager reduces a historical unset-org accrual with one signed adjustment and payroll pays it", async () => {
    await assertHistoricalAdjustment({ amount: 375, deltaMinor: -12_500, payableMinor: 37_500, debitKey: "COMMISSION_PAYABLE", creditKey: "COMMISSION_EXPENSE" });
  });

  test("a manager increases a historical unset-org accrual with one signed adjustment and payroll pays it", async () => {
    await assertHistoricalAdjustment({ amount: 625, deltaMinor: 12_500, payableMinor: 62_500, debitKey: "COMMISSION_EXPENSE", creditKey: "COMMISSION_PAYABLE" });
  });

  test("cancelling a historical unset-org accrual reverses its ledger exactly once", async () => {
    const d = await historicalAccrual("historical_cancel");
    const manager = await addManager(d, "historical_cancel_manager");
    const cancel = () => manager.as.mutation(api.sales.update, { orgId: d.orgId, saleId: d.saleId, status: "CANCELLED" });
    await cancel();
    expect(await d.commissionPayableMinor()).toBe(0);
    expect(await commissionExpenseMinor(d)).toBe(0);
    await d.t.run(async (ctx) => {
      const events = await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", d.orgId)).collect();
      const accruals = events.filter((event) => event.eventType === "COMMISSION_ACCRUED");
      expect(accruals).toHaveLength(1);
      expect(accruals[0].status).toBe("REVERSED");
      const reversals = events.filter((event) => event.reversalOfEventId === accruals[0]._id);
      expect(reversals).toHaveLength(1);
      expect(reversals[0].status).toBe("POSTED");
      if (!reversals[0].journalEntryId) throw new Error("commission reversal journal missing");
      const lines = await ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", reversals[0].journalEntryId!)).collect();
      const actual = await Promise.all(lines.map(async (line) => ({ key: (await ctx.db.get(line.accountId))?.systemKey, debitMinor: line.debitMinor, creditMinor: line.creditMinor })));
      expect(actual).toEqual(expect.arrayContaining([
        { key: "COMMISSION_PAYABLE", debitMinor: 50_000, creditMinor: 0 },
        { key: "COMMISSION_EXPENSE", debitMinor: 0, creditMinor: 50_000 },
      ]));
      expect(actual).toHaveLength(2);
    });
    const beforeRetry = await dbSnapshot(d.t, ["journalEntries", "journalLines", "accountingEvents"]);
    await cancel();
    expect(await dbSnapshot(d.t, ["journalEntries", "journalLines", "accountingEvents"])).toEqual(beforeRetry);
  });

  test("an old org without a settings row reads MANUAL without stamping a mode", async () => {
    const d = await seedDealer("no_settings");
    await d.t.run(async (ctx) => {
      const row = await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", d.orgId)).unique();
      if (row) await ctx.db.delete(row._id);
    });
    const before = await dbSnapshot(d.t, Object.keys(schema.tables));
    expect(await d.as.query(api.orgSettings.getCommissionMode, { orgId: d.orgId })).toBe("MANUAL");
    expect(await dbSnapshot(d.t, Object.keys(schema.tables))).toEqual(before);
  });
});

describe("SCRUM-853: commission policy changes preserve existing accrual locks", () => {
  test("unexpected settings faults return a generic error and leave all rows unchanged", async () => {
    const d = await seedDealer("853_settings_fault", "AUTO_MEMBER");
    await d.t.run((ctx) => ctx.db.insert("orgSettings", {
      orgId: d.orgId, currency: "USD", currencySymbol: "$", enabledPaymentTypes: ["CASH"],
    }));
    const before = await dbSnapshot(d.t, Object.keys(schema.tables));
    await expect(d.as.mutation(api.orgSettings.setCommissionMode, {
      orgId: d.orgId, commissionMode: "MANUAL",
    })).rejects.toMatchObject({ data: "An unexpected error occurred. Please try again later." });
    expect(await dbSnapshot(d.t, Object.keys(schema.tables))).toEqual(before);
  });

  test.each([0, undefined])("a genuine no-accrual amount of %s does not strand the owner in AUTO", async (amount) => {
    const d = await seedDealer(`853_legacy_${amount}`, "AUTO_MEMBER", 0);
    const saleId = await d.completeSale();
    expect(await d.commissionPayableMinor()).toBe(0);
    await d.t.run((ctx) => ctx.db.patch(saleId, { commissionAmount: amount }));
    await expectAppError(d.as.mutation(api.sales.markCommissionPaid, {
      orgId: d.orgId, saleId, idempotencyKey: crypto.randomUUID(),
    }), "VALIDATION_FAILED", "This sale has no commission amount to pay.");
    await d.as.mutation(api.orgSettings.setCommissionMode, {
      orgId: d.orgId, commissionMode: "MANUAL",
    });
    expect(await d.as.query(api.orgSettings.getCommissionMode, { orgId: d.orgId })).toBe("MANUAL");
    expect(await d.commissionPayableMinor()).toBe(0);
    await d.as.mutation(api.sales.setCommissionAmount, { orgId: d.orgId, saleId, commissionAmount: 250 });
    expect(await d.commissionPayableMinor()).toBe(25_000);
  });

  test.each([
    ["NaN", NaN], ["negative NaN", -NaN], ["infinity", Infinity],
    ["negative infinity", -Infinity], ["negative", -1],
  ] as const)("a corrupt unpaid %s amount requires accounting review, without writes", async (label, amount) => {
    const d = await seedDealer(`853_corrupt_${label}`, "AUTO_MEMBER");
    const saleId = await d.completeSale();
    // Historical amount shapes around finite rows exercise both index extrema.
    // These inserts are index/validation fixtures, not accounting-flow proof.
    await d.t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      if (!sale) throw new Error("fixture sale missing");
      const { _id, _creationTime, ...fields } = sale;
      await ctx.db.patch(_id, { commissionAmount: amount });
      await ctx.db.insert("sales", { ...fields, commissionAmount: 0 });
      await ctx.db.insert("sales", { ...fields, commissionAmount: 1 });
    });
    const before = await dbSnapshot(d.t, Object.keys(schema.tables));
    await expectAppError(d.as.mutation(api.orgSettings.setCommissionMode, {
      orgId: d.orgId, commissionMode: "MANUAL",
    }), "VALIDATION_FAILED", "Completed sale commission amounts need accounting review before changing the commission mode.");
    expect(await dbSnapshot(d.t, Object.keys(schema.tables))).toEqual(before);
  });

  test("an unpaid AUTO commission does not prevent switching between automatic policies", async () => {
    const d = await seedDealer("853_auto_auto", "AUTO_MEMBER");
    const saleId = await d.completeSale();
    const before = await d.commissionPayableMinor();
    await d.as.mutation(api.orgSettings.setCommissionMode, { orgId: d.orgId, commissionMode: "AUTO_TIERS" });
    expect(await d.as.query(api.orgSettings.getCommissionMode, { orgId: d.orgId })).toBe("AUTO_TIERS");
    expect(await d.commissionPayableMinor()).toBe(before);
    await expectAppError(d.as.mutation(api.sales.setCommissionAmount, {
      orgId: d.orgId, saleId, commissionAmount: 1,
    }), "SALE_ALREADY_COMPLETED", "Completed sale commission amounts are locked. Use a correction workflow.");
  });

  test.each(["paid", "cancelled", "deleted"] as const)("%s sales do not block a deliberate mode choice", async (state) => {
    const d = await seedDealer(`853_${state}`, "AUTO_MEMBER");
    const saleId = await d.completeSale();
    // Historical lifecycle shapes isolate policy eligibility; payment and
    // cancellation accounting have their own public-door regression suites.
    await d.t.run((ctx) => ctx.db.patch(saleId, state === "paid"
      ? { commissionPaidAt: 0 }
      : state === "cancelled" ? { status: "CANCELLED" } : { isDeleted: true }));
    const ledgerBefore = await d.commissionPayableMinor();
    await d.as.mutation(api.orgSettings.setCommissionMode, { orgId: d.orgId, commissionMode: "MANUAL" });
    expect(await d.as.query(api.orgSettings.getCommissionMode, { orgId: d.orgId })).toBe("MANUAL");
    expect(await d.commissionPayableMinor()).toBe(ledgerBefore);
    expect(await d.t.run((ctx) => ctx.db.query("adminAuditLog").collect())).toHaveLength(1);
  });

  test("another tenant's unpaid sale does not block the owner and grants no access to that tenant", async () => {
    const d = await seedDealer("853_tenant", "AUTO_MEMBER");
    const otherOrgId = await d.t.run((ctx) => ctx.db.insert("organizations", { name: "Other dealer", createdAt: Date.now() }));
    const saleId = await d.completeSale();
    await d.t.run((ctx) => ctx.db.patch(saleId, { orgId: otherOrgId }));
    await d.as.mutation(api.orgSettings.setCommissionMode, { orgId: d.orgId, commissionMode: "MANUAL" });
    expect(await d.as.query(api.orgSettings.getCommissionMode, { orgId: d.orgId })).toBe("MANUAL");
    const before = await dbSnapshot(d.t, Object.keys(schema.tables));
    await expectAppError(d.as.mutation(api.orgSettings.setCommissionMode, {
      orgId: otherOrgId, commissionMode: "MANUAL",
    }), "UNAUTHORIZED", "Unauthorized: You are not a member of this organization.");
    expect(await dbSnapshot(d.t, Object.keys(schema.tables))).toEqual(before);
  });

  test("a large paid history permits switching and does not hide a later unpaid obligation", async () => {
    const d = await seedDealer("853_limit", "AUTO_MEMBER");
    const saleId = await d.completeSale();
    const historicalSale = await d.t.run(async (ctx) => {
      const sale = await ctx.db.get(saleId);
      if (!sale) throw new Error("fixture sale missing");
      const { _id, _creationTime, ...fields } = sale;
      await ctx.db.patch(_id, { commissionPaidAt: 1 });
      return { ...fields, commissionPaidAt: 1 };
    });
    await d.t.run(async (ctx) => {
      for (let index = 1; index < 1001; index++) await ctx.db.insert("sales", historicalSale);
    });
    await d.as.mutation(api.orgSettings.setCommissionMode, { orgId: d.orgId, commissionMode: "MANUAL" });
    await d.as.mutation(api.orgSettings.setCommissionMode, { orgId: d.orgId, commissionMode: "AUTO_MEMBER" });
    await d.t.run((ctx) => ctx.db.insert("sales", {
      ...historicalSale, saleDate: historicalSale.saleDate + 1, commissionPaidAt: undefined,
    }));
    const before = await dbSnapshot(d.t, Object.keys(schema.tables));
    await expectAppError(d.as.mutation(api.orgSettings.setCommissionMode, {
      orgId: d.orgId, commissionMode: "MANUAL",
    }), "VALIDATION_FAILED", "Settle completed sale commissions before switching to manual mode.");
    expect(await dbSnapshot(d.t, Object.keys(schema.tables))).toEqual(before);
  });

  test.each(["AUTO_MEMBER", "AUTO_TIERS"] as const)(
    "an unpaid completed sale under %s prevents a switch to MANUAL",
    async (initialMode) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const d = await seedDealer(`853_${initialMode ?? "unset"}`, initialMode);
        const saleId = await d.completeSale();
        const sale = await d.t.run((ctx) => ctx.db.get(saleId));
        expect(sale?.status).toBe("COMPLETED");
        expect(sale?.commissionPaidAt).toBeUndefined();
        expect(sale?.commissionAmount).toBeGreaterThan(1);
        expect(await d.commissionPayableMinor()).toBeGreaterThan(0);

        const edit = () => d.as.mutation(api.sales.setCommissionAmount, {
          orgId: d.orgId, saleId, commissionAmount: 1,
        });
        const lockedMessage = "Completed sale commission amounts are locked. Use a correction workflow.";
        // Control: the same edit is refused before the policy changes.
        await expectAppError(edit(), "SALE_ALREADY_COMPLETED", lockedMessage);
        const before = await dbSnapshot(d.t, Object.keys(schema.tables));
        await expectAppError(d.as.mutation(api.orgSettings.setCommissionMode, {
          orgId: d.orgId, commissionMode: "MANUAL",
        }), "VALIDATION_FAILED", "Settle completed sale commissions before switching to manual mode.");
        expect(await dbSnapshot(d.t, Object.keys(schema.tables))).toEqual(before);
        expect(await d.as.query(api.orgSettings.getCommissionMode, { orgId: d.orgId })).toBe(initialMode ?? "AUTO_MEMBER");
        await expectAppError(edit(), "SALE_ALREADY_COMPLETED", lockedMessage);
        expect(await dbSnapshot(d.t, Object.keys(schema.tables))).toEqual(before);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

/**
 * SCRUM-778 seat finding F1 (Codex HIGH / Opus MEDIUM): a mobile bundle built
 * before this change defaults an unset mode to AUTO_MEMBER inside its general
 * settings form and sends it on every save. A generic settings save must not
 * be able to switch a dealership into automatic commission — only a deliberate
 * mode choice may, through `setCommissionMode`.
 */
describe("SCRUM-778: an automatic mode needs a deliberate choice", () => {
  const storedMode = (d: Awaited<ReturnType<typeof seedDealer>>) =>
    d.t.run(async (ctx) => {
      const row = await ctx.db
        .query("orgSettings")
        .withIndex("by_org", (q) => q.eq("orgId", d.orgId))
        .unique();
      return effectiveCommissionMode(row);
    });

  test("a legacy general-settings save carrying a different mode cannot switch an org that never chose one", async () => {
    const d = await seedDealer("legacy_save");
    await expect(
      d.as.mutation(api.orgSettings.upsert, {
        orgId: d.orgId, dealershipPhone: "+962790000000", commissionMode: "AUTO_MEMBER",
      })
    ).rejects.toThrow(/commission mode/i);
    expect(await storedMode(d)).toBe("MANUAL");

    await d.completeSale();
    expect(await d.commissionPayableMinor()).toBe(0);
  });

  test("a legacy save never changes a stored mode", async () => {
    const d = await seedDealer("legacy_stored", "MANUAL");
    await expect(
      d.as.mutation(api.orgSettings.upsert, { orgId: d.orgId, dealershipPhone: "+962790000003", commissionMode: "AUTO_TIERS" })
    ).rejects.toThrow(/commission mode/i);
    expect(await storedMode(d)).toBe("MANUAL");
  });

  test("a legacy save resending the effective default saves the other fields and stores no mode", async () => {
    const d = await seedDealer("legacy_resend_default");
    await d.as.mutation(api.orgSettings.upsert, { orgId: d.orgId, dealershipPhone: "+962790000004", commissionMode: "MANUAL" });
    const row = await d.t.run((ctx) =>
      ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", d.orgId)).unique()
    );
    expect(row?.dealershipPhone).toBe("+962790000004");
    expect(row?.commissionMode).toBeUndefined();
  });

  test("the same legacy save on an org with no settings row creates no stored mode", async () => {
    const d = await seedDealer("legacy_norow");
    await d.t.run(async (ctx) => {
      const row = await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", d.orgId)).unique();
      if (row) await ctx.db.delete(row._id);
    });
    await expect(
      d.as.mutation(api.orgSettings.upsert, { orgId: d.orgId, dealershipPhone: "+962790000001", commissionMode: "AUTO_MEMBER" })
    ).rejects.toThrow(/commission mode/i);
    expect(await storedMode(d)).toBe("MANUAL");
  });

  // Control: resending the mode already in force is not a change and still saves.
  test("a settings save that resends the mode already in force still saves", async () => {
    const d = await seedDealer("resend", "AUTO_MEMBER");
    await d.as.mutation(api.orgSettings.upsert, { orgId: d.orgId, dealershipPhone: "+962790000002", commissionMode: "AUTO_MEMBER" });
    expect(await storedMode(d)).toBe("AUTO_MEMBER");
    const phone = await d.t.run(async (ctx) =>
      (await ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", d.orgId)).unique())?.dealershipPhone
    );
    expect(phone).toBe("+962790000002");
  });

  test("choosing MANUAL is an explicit owner action: it is stored, audited, and stops automatic accrual", async () => {
    const d = await seedDealer("choose_manual");
    await d.as.mutation(api.orgSettings.setCommissionMode, { orgId: d.orgId, commissionMode: "MANUAL" });
    expect(await storedMode(d)).toBe("MANUAL");
    const rows = await d.t.run((ctx) => ctx.db.query("adminAuditLog").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "commission mode changed",
      before: { commissionMode: "MANUAL" },
      after: { commissionMode: "MANUAL" },
    });

    await d.completeSale();
    expect(await d.commissionPayableMinor()).toBe(0);

    await d.as.mutation(api.orgSettings.setCommissionMode, { orgId: d.orgId, commissionMode: "AUTO_TIERS" });
    expect(await storedMode(d)).toBe("AUTO_TIERS");
  });

  test("only the owner may change the commission mode", async () => {
    const d = await seedDealer("nonowner");
    const managerId = await d.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "s778_mgr", email: "s778mgr@example.com", name: "Manager" })
    );
    const roleId = await d.t.run((ctx) =>
      ctx.db.insert("roles", { orgId: d.orgId, name: "MANAGER", permissions: PERMISSIONS })
    );
    await d.t.run((ctx) => ctx.db.insert("memberships", { orgId: d.orgId, userId: managerId, roleId }));
    const asManager = d.t.withIdentity({ subject: "s778_mgr", clerkId: "s778_mgr" });

    const refusal = await asManager
      .mutation(api.orgSettings.setCommissionMode, { orgId: d.orgId, commissionMode: "MANUAL" })
      .then(() => null, (e: unknown) => e as { data?: { code?: string } });
    expect(refusal?.data?.code).toBe("FORBIDDEN");
    expect(await storedMode(d)).toBe("MANUAL");
    expect(await d.t.run((ctx) => ctx.db.query("adminAuditLog").collect())).toHaveLength(0);
  });

  test("setting the mode already stored writes no audit row, and an unset org explicitly opting into AUTO pins it", async () => {
    const d = await seedDealer("noop", "AUTO_MEMBER");
    await d.as.mutation(api.orgSettings.setCommissionMode, { orgId: d.orgId, commissionMode: "AUTO_MEMBER" });
    expect(await d.t.run((ctx) => ctx.db.query("adminAuditLog").collect())).toHaveLength(0);

    const unset = await seedDealer("pin");
    await unset.as.mutation(api.orgSettings.setCommissionMode, { orgId: unset.orgId, commissionMode: "AUTO_MEMBER" });
    expect(await storedMode(unset)).toBe("AUTO_MEMBER");
    expect(await unset.t.run((ctx) => ctx.db.query("adminAuditLog").collect())).toHaveLength(1);
  });

  // An access refusal reads as "no mode visible"; any other failure must surface.
  test("getCommissionMode returns null on an access refusal but rethrows other errors", async () => {
    const d = await seedDealer("rethrow", "AUTO_MEMBER");
    const strangerId = await d.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "s778_stranger", email: "s778stranger@example.com", name: "Stranger" })
    );
    const asStranger = d.t.withIdentity({ subject: "s778_stranger", clerkId: "s778_stranger" });
    expect(strangerId).toBeTruthy();
    // Signed out: no identity at all reads as no mode, not as an error.
    expect(await d.t.query(api.orgSettings.getCommissionMode, { orgId: d.orgId })).toBeNull();
    expect(await asStranger.query(api.orgSettings.getCommissionMode, { orgId: d.orgId })).toBeNull();

    // A membership whose role row is gone is corrupt data, not "no access".
    const brokenId = await d.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "s778_broken", email: "s778broken@example.com", name: "Broken" })
    );
    const goneRoleId = await d.t.run(async (ctx) => {
      const id = await ctx.db.insert("roles", { orgId: d.orgId, name: "GONE", permissions: [] });
      await ctx.db.insert("memberships", { orgId: d.orgId, userId: brokenId, roleId: id });
      await ctx.db.delete(id);
      return id;
    });
    expect(goneRoleId).toBeTruthy();
    const asBroken = d.t.withIdentity({ subject: "s778_broken", clerkId: "s778_broken" });
    await expect(asBroken.query(api.orgSettings.getCommissionMode, { orgId: d.orgId })).rejects.toThrow(/role not found/i);
  });

  // Seat finding F2 (Opus): a commissions reviewer without VIEW_SETTINGS read
  // orgSettings.get as null, so an AUTO org showed them the MANUAL work queue.
  test("a commissions reviewer without settings access reads the mode actually in force", async () => {
    const d = await seedDealer("reviewer", "AUTO_MEMBER");
    const reviewerId = await d.t.run((ctx) =>
      ctx.db.insert("users", { clerkId: "s778_rev", email: "s778rev@example.com", name: "Reviewer" })
    );
    const roleId = await d.t.run((ctx) =>
      ctx.db.insert("roles", { orgId: d.orgId, name: "SENIOR_ACCOUNTANT", permissions: ["view:commissions", "manage:commissions"] })
    );
    await d.t.run((ctx) => ctx.db.insert("memberships", { orgId: d.orgId, userId: reviewerId, roleId }));
    const asReviewer = d.t.withIdentity({ subject: "s778_rev", clerkId: "s778_rev" });

    expect(await asReviewer.query(api.orgSettings.get, { orgId: d.orgId })).toBeNull();
    expect(await asReviewer.query(api.orgSettings.getCommissionMode, { orgId: d.orgId })).toBe("AUTO_MEMBER");
  });
});

/**
 * The two commission listing reads must resolve an unset mode as MANUAL.
 * A completed sale with no computed commission is the discriminator: an
 * automatic mode flags it for recalculation, MANUAL lists it as undecided work.
 */
describe("SCRUM-778: the commission listings read an unset mode as MANUAL", () => {
  async function uncomputedSale(suffix: string, mode?: "MANUAL") {
    const d = await seedDealer(suffix, mode);
    const saleId = await d.completeSale();
    // Strip any computed commission: a COMPLETED sale whose commission was never computed.
    await d.t.run((ctx) => ctx.db.patch(saleId, { commissionAmount: undefined }));
    return { d, saleId };
  }

  test("commissionPage (listCommissionsPaginated): an unset org gets the manual work queue", async () => {
    const { d, saleId } = await uncomputedSale("list_pg_unset");
    const res = await d.as.query(api.sales.listCommissionsPaginated, {
      orgId: d.orgId, paginationOpts: { numItems: 20, cursor: null },
    });
    const row = res.page.find((r) => r._id === saleId);
    expect(row?.needsRecalculation).toBe(false);
    expect(row?.canSetAmount).toBe(true);

    const { d: m, saleId: mSale } = await uncomputedSale("list_pg_manual", "MANUAL");
    const mRes = await m.as.query(api.sales.listCommissionsPaginated, {
      orgId: m.orgId, paginationOpts: { numItems: 20, cursor: null },
    });
    const mRow = mRes.page.find((r) => r._id === mSale);
    expect(mRow?.needsRecalculation).toBe(false);
    expect(mRow?.canSetAmount).toBe(true);
  });

  test("listCommissions (deprecated unpaginated read): an unset org gets the manual work queue", async () => {
    const { d, saleId } = await uncomputedSale("list_legacy_unset");
    const rows = await d.as.query(api.sales.listCommissions, { orgId: d.orgId });
    expect(rows.find((r) => r._id === saleId)).toBeUndefined();

    const { d: m, saleId: mSale } = await uncomputedSale("list_legacy_manual", "MANUAL");
    const mRows = await m.as.query(api.sales.listCommissions, { orgId: m.orgId });
    expect(mRows.find((r) => r._id === mSale)).toBeUndefined();
  });
});

// RT11-DOORS: historical lifecycle mechanics with the pilot doors explicitly open.
// Shipped-state refusals and controls live in rt11DoorContainment.test.ts.
vi.mock("./utils/rt11DoorContainment", async (importOriginal) =>
  (await import("../test-utils/rt11DoorSwitches")).openRt11Doors(
    await importOriginal<typeof import("./utils/rt11DoorContainment")>()
  ));
