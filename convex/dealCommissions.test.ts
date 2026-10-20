import { convexTestWithComponents } from "../test-utils/convexTest";
import { afterEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

// The pilot switch is ON in the build (convex/dealCommissionsPilot.test.ts pins
// that). These tests exercise the certified-by-test behaviour with it off.

const ADMIN = ["view:commissions", "manage:commissions", "view:sales", "create:sales", "view:vehicles", "edit:sales"];

async function seed(
  t: ReturnType<typeof convexTestWithComponents>,
  suffix: string,
  permissions: string[] = ADMIN,
  currency = "JOD"
) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `Dealer ${suffix}`, createdAt: Date.now() }));
  const mkUser = (name: string) =>
    t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", { clerkId: `${name}_${suffix}`, email: `${name}.${suffix}@example.com`, name });
      return userId;
    });
  const userId = await mkUser("admin");
  const buyerAgent = await mkUser("buyer");
  const executor = await mkUser("exec");
  const outsider = await mkUser("outsider");
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Admin", permissions }));
  for (const member of [userId, buyerAgent, executor]) {
    await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: member, roleId }));
  }
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency, currencySymbol: currency, enabledPaymentTypes: [], commissionMode: "MANUAL" })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VIN-${suffix}`, make: "Kia", model: "K5", year: 2024, color: "White",
      fuelType: "Gasoline", transmission: "Automatic", mileage: 10, sellingPrice: 15000, status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "A", lastName: "B", email: `${suffix}@example.com` })
  );
  const asAdmin = t.withIdentity({ subject: `admin_${suffix}`, clerkId: `admin_${suffix}` });
  const saleId = await asAdmin.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(), orgId, vehicleId, customerId, salespersonId: userId,
    salePrice: 15000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH",
  });
  return { orgId, userId, buyerAgent, executor, outsider, saleId, asAdmin };
}

describe("dealCommissions: several lines on one deal", () => {
  test("the owner's example: purchase 50 + sale 50 + execution 25 JOD totals 125 JOD", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const s = await seed(t, "example");
    // The salesperson's sale commission lives on the sale row (existing path).
    await s.asAdmin.mutation(api.sales.setCommissionAmount, { orgId: s.orgId, saleId: s.saleId, commissionAmount: 50 });
    await s.asAdmin.mutation(api.dealCommissions.addLine, {
      orgId: s.orgId, saleId: s.saleId, kind: "PURCHASE", employeeId: s.buyerAgent, amount: 50,
    });
    await s.asAdmin.mutation(api.dealCommissions.addLine, {
      orgId: s.orgId, saleId: s.saleId, kind: "EXECUTION", employeeId: s.executor, amount: 25, note: "Dar Al Tamweel file",
    });

    const view = await s.asAdmin.query(api.dealCommissions.forSale, { orgId: s.orgId, saleId: s.saleId });
    expect(view.currency).toBe("JOD");
    expect(view.salesperson.amountMinor).toBe(50_000);
    expect(view.lines.map((l) => [l.kind, l.amountMinor, l.employeeName])).toEqual([
      ["PURCHASE", 50_000, "buyer"],
      ["EXECUTION", 25_000, "exec"],
    ]);
    expect(view.totalMinor).toBe(125_000);
    expect(view.salePending).toBe(false);
  });

  test("an undecided sale commission is pending, not zero", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const s = await seed(t, "pending");
    await s.asAdmin.mutation(api.dealCommissions.addLine, {
      orgId: s.orgId, saleId: s.saleId, kind: "PURCHASE", employeeId: s.buyerAgent, amount: 10,
    });
    const view = await s.asAdmin.query(api.dealCommissions.forSale, { orgId: s.orgId, saleId: s.saleId });
    expect(view.salePending).toBe(true);
    expect(view.salesperson.amountMinor).toBeNull();
    expect(view.totalMinor).toBe(10_000);
  });

  // What a line does to the books (convex/dealCommissions.ts addLine ->
  // hookDealCommissionLineAccrued, convex/accounting/workflowHooks.ts). The
  // readiness fixture is the one convex/dealCommissionLinesLedger.test.ts uses.
  type Harness = ReturnType<typeof convexTestWithComponents<typeof schema>>;
  // chartOfAccounts.initialize and accountingPeriods.open schedule
  // drainPendingAccountingEvents with runAfter(0), which posts the queued
  // SALE_COMPLETED / sale-commission events. Without waiting for it those
  // postings land between or before the snapshots. Fake timers plus
  // finishAllScheduledFunctions is the documented way to let it finish.
  afterEach(() => {
    vi.useRealTimers();
  });
  const settle = (t: Harness) => t.finishAllScheduledFunctions(vi.runAllTimers);
  async function openChartAndPeriod(t: Harness, s: Awaited<ReturnType<typeof seed>>) {
    await t.run((ctx) =>
      ctx.db.insert("subscriptions", { orgId: s.orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
    );
    await s.asAdmin.mutation(api.chartOfAccounts.initialize, { orgId: s.orgId });
    const fiscalYear = new Date().getUTCFullYear();
    await s.asAdmin.mutation(api.accountingPeriods.create, {
      orgId: s.orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999), fiscalYear, periodNumber: 1,
    });
    for (const period of await s.asAdmin.query(api.accountingPeriods.list, { orgId: s.orgId })) {
      await s.asAdmin.mutation(api.accountingPeriods.open, { orgId: s.orgId, periodId: period._id });
    }
  }
  // Scoped to one organization by index, and every returned row is asserted to
  // carry that orgId, so a snapshot that leaked another tenant's rows (or a
  // query that lost its org filter) fails here instead of passing silently.
  // pendingAccountingEvents is read through by_org_status, using the orgId prefix only (every status).
  const snapshot = async (t: Harness, orgId: Id<"organizations">, saleId: Id<"sales">) => {
    const snap = await t.run(async (ctx) => ({
      events: await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect(),
      pending: await ctx.db.query("pendingAccountingEvents").withIndex("by_org_status", (q) => q.eq("orgId", orgId)).collect(),
      journalLines: await ctx.db.query("journalLines").withIndex("by_org", (q) => q.eq("orgId", orgId)).collect(),
      sale: (await ctx.db.get(saleId))?.commissionAmount ?? null,
      saleOrgId: (await ctx.db.get(saleId))?.orgId ?? null,
    }));
    for (const row of [...snap.events, ...snap.pending, ...snap.journalLines]) expect(row.orgId).toBe(orgId);
    expect(snap.saleOrgId).toBe(orgId);
    return snap;
  };
  // Rows of every tenant, to prove the fixture really holds another org's data.
  const allTenantRowCounts = (t: Harness) =>
    t.run(async (ctx) => ({
      events: (await ctx.db.query("accountingEvents").collect()).length,
      pending: (await ctx.db.query("pendingAccountingEvents").collect()).length,
      journalLines: (await ctx.db.query("journalLines").collect()).length,
    }));

  test("with a chart ready, a line posts exactly one accrual: Dr Commission Expense / Cr Commission Payable, exact fils", async () => {
    vi.useFakeTimers();
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const s = await seed(t, "ledger", [...ADMIN, "view:finance", "manage:finance"]);
    await s.asAdmin.mutation(api.sales.setCommissionAmount, { orgId: s.orgId, saleId: s.saleId, commissionAmount: 50 });
    await openChartAndPeriod(t, s);
    // A second organization with its own books and its own commission activity,
    // including a line posted between the two snapshots.
    const other = await seed(t, "ledgerother", [...ADMIN, "view:finance", "manage:finance"]);
    await other.asAdmin.mutation(api.sales.setCommissionAmount, { orgId: other.orgId, saleId: other.saleId, commissionAmount: 70 });
    await openChartAndPeriod(t, other);
    await settle(t);
    const before = await snapshot(t, s.orgId, s.saleId);
    const otherBefore = await snapshot(t, other.orgId, other.saleId);
    const otherLineId = await other.asAdmin.mutation(api.dealCommissions.addLine, {
      orgId: other.orgId, saleId: other.saleId, kind: "EXECUTION", employeeId: other.executor, amount: 11,
    });
    const lineId = await s.asAdmin.mutation(api.dealCommissions.addLine, {
      orgId: s.orgId, saleId: s.saleId, kind: "EXECUTION", employeeId: s.executor, amount: 25.125,
    });
    await settle(t);
    const after = await snapshot(t, s.orgId, s.saleId);
    const otherAfter = await snapshot(t, other.orgId, other.saleId);
    // The other org really did post an accrual of its own in the same window,
    // and it is visible to an unscoped read but not to this org's snapshot.
    expect(otherAfter.events.filter((e) => e.sourceId === otherLineId && e.eventType === "COMMISSION_ACCRUED")).toHaveLength(1);
    expect(otherAfter.events.length).toBe(otherBefore.events.length + 1);
    const everyone = await allTenantRowCounts(t);
    expect(everyone.events).toBe(after.events.length + otherAfter.events.length);
    expect(everyone.journalLines).toBe(after.journalLines.length + otherAfter.journalLines.length);
    expect(everyone.pending).toBe(after.pending.length + otherAfter.pending.length);

    const newEvents = after.events.filter((e) => !before.events.some((b) => b._id === e._id));
    expect(newEvents.map((e) => [e.eventType, e.sourceType, e.sourceId, e.orgId])).toEqual([
      ["COMMISSION_ACCRUED", "dealCommissionLines", lineId, s.orgId],
    ]);
    expect(after.events.filter((e) => e.sourceType === "dealCommissionLines")).toHaveLength(1);
    expect(after.pending).toEqual(before.pending);

    // The accrual is a POSTED event, and both journal lines belong to the entry it points at.
    expect(newEvents[0].status).toBe("POSTED");
    const entryId: Id<"journalEntries"> | undefined = newEvents[0].journalEntryId;
    expect(entryId).toBeTruthy();

    const accountRows = await t.run(async (ctx) => {
      const byKey = async (key: string) =>
        (await ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", s.orgId).eq("systemKey", key)).unique())!;
      return { expense: await byKey("COMMISSION_EXPENSE"), payable: await byKey("COMMISSION_PAYABLE") };
    });
    expect(accountRows.expense.orgId).toBe(s.orgId);
    expect(accountRows.payable.orgId).toBe(s.orgId);
    const accounts = { expense: accountRows.expense._id, payable: accountRows.payable._id };
    const newLines = after.journalLines.filter((l) => !before.journalLines.some((b) => b._id === l._id));
    expect(newLines).toHaveLength(2);
    for (const line of newLines) {
      expect(line.orgId).toBe(s.orgId);
      expect(line.journalEntryId).toBe(entryId);
    }
    const entry = await t.run((ctx) => ctx.db.get(entryId!));
    expect(entry?.orgId).toBe(s.orgId);
    // Reader-visible state: accountingReports.getPostedLines selects journalLines
    // with reportPosted === true (by_org_reportPosted_date), and reads POSTED entries.
    expect(entry?.status).toBe("POSTED");
    for (const line of newLines) expect(line.reportPosted).toBe(true);
    const readerLines = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_org_reportPosted_date", (q) => q.eq("orgId", s.orgId).eq("reportPosted", true)).collect()
    );
    expect(readerLines.filter((l) => l.journalEntryId === entryId).map((l) => l._id).sort()).toEqual(newLines.map((l) => l._id).sort());
    expect(newLines.find((l) => l.accountId === accounts.expense)).toMatchObject({ orgId: s.orgId, debitMinor: 25_125, creditMinor: 0 });
    expect(newLines.find((l) => l.accountId === accounts.payable)).toMatchObject({ orgId: s.orgId, debitMinor: 0, creditMinor: 25_125 });
    // The salesperson's own commission is untouched, on the same org's sale.
    expect(before.saleOrgId).toBe(s.orgId);
    expect(after.saleOrgId).toBe(s.orgId);
    expect(before.sale).toBe(50);
    expect(after.sale).toBe(50);
  });

  test("with no chart yet, a line posts nothing now: the accrual is queued once and the sale commission is untouched", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    vi.useFakeTimers();
    const s = await seed(t, "nochart");
    // Another organization, also without a chart, queues its own accrual between the snapshots.
    const other = await seed(t, "nochartother");
    await settle(t);
    const before = await snapshot(t, s.orgId, s.saleId);
    const otherBefore = await snapshot(t, other.orgId, other.saleId);
    // The before-snapshot must hold the seeded state, or every "unchanged" comparison below is vacuous:
    // each org already has its sale-completed posting queued (PENDING) and nothing posted.
    expect(before.pending.map((p) => [p.kind, p.status, p.idempotencyKey, p.orgId])).toEqual([
      ["POST", "PENDING", `sale_completed_${s.saleId}`, s.orgId],
    ]);
    expect(otherBefore.pending.map((p) => [p.kind, p.status, p.idempotencyKey, p.orgId])).toEqual([
      ["POST", "PENDING", `sale_completed_${other.saleId}`, other.orgId],
    ]);
    expect(before.events).toEqual([]);
    expect(before.journalLines).toEqual([]);
    const otherLineId = await other.asAdmin.mutation(api.dealCommissions.addLine, {
      orgId: other.orgId, saleId: other.saleId, kind: "EXECUTION", employeeId: other.executor, amount: 9,
    });
    const lineId = await s.asAdmin.mutation(api.dealCommissions.addLine, {
      orgId: s.orgId, saleId: s.saleId, kind: "EXECUTION", employeeId: s.executor, amount: 25,
    });
    await settle(t);
    const after = await snapshot(t, s.orgId, s.saleId);
    const otherAfter = await snapshot(t, other.orgId, other.saleId);
    expect(
      otherAfter.pending.filter((p) => !otherBefore.pending.some((b) => b._id === p._id)).map((p) => p.idempotencyKey)
    ).toEqual([`commission_line_accrued_${otherLineId}`]);
    const everyone = await allTenantRowCounts(t);
    expect(everyone.pending).toBe(after.pending.length + otherAfter.pending.length);
    expect(after.events).toEqual(before.events);
    expect(after.journalLines).toEqual(before.journalLines);
    expect(after.sale).toBe(before.sale);
    const queued = after.pending.filter((p) => !before.pending.some((b) => b._id === p._id));
    expect(queued.map((p) => [p.kind, p.status, p.idempotencyKey, p.orgId])).toEqual([
      ["POST", "PENDING", `commission_line_accrued_${lineId}`, s.orgId],
    ]);
  });

  test("removing a line keeps the row for history and drops it from the total", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const s = await seed(t, "remove");
    const lineId = await s.asAdmin.mutation(api.dealCommissions.addLine, {
      orgId: s.orgId, saleId: s.saleId, kind: "PURCHASE", employeeId: s.buyerAgent, amount: 40,
    });
    await s.asAdmin.mutation(api.dealCommissions.removeLine, { orgId: s.orgId, lineId });
    const view = await s.asAdmin.query(api.dealCommissions.forSale, { orgId: s.orgId, saleId: s.saleId });
    expect(view.lines).toEqual([]);
    expect(view.totalMinor).toBe(0);
    const rows = await t.run((ctx) => ctx.db.query("dealCommissionLines").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].removedAt).toBeTypeOf("number");
    // And it can be registered again.
    await s.asAdmin.mutation(api.dealCommissions.addLine, {
      orgId: s.orgId, saleId: s.saleId, kind: "PURCHASE", employeeId: s.buyerAgent, amount: 45,
    });
  });
});

describe("dealCommissions: refusals", () => {
  async function addArgs(s: Awaited<ReturnType<typeof seed>>, over: Record<string, unknown> = {}) {
    return { orgId: s.orgId, saleId: s.saleId, kind: "PURCHASE" as const, employeeId: s.buyerAgent, amount: 10, ...over };
  }

  test.each([[0], [-5], [Number.NaN], [Number.POSITIVE_INFINITY], [10.0001], [50.0000000001], [49.9999999999]])("amount %s is refused", async (amount) => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const s = await seed(t, `amt${String(amount).replace(/\W/g, "")}`);
    await expect(s.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(s, { amount }))).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("dealCommissionLines").collect())).toHaveLength(0);
  });

  test("the same employee and type twice is refused (double-click guard)", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const s = await seed(t, "dup");
    await s.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(s));
    await expect(s.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(s))).rejects.toThrow(/already has a commission/);
  });

  test("an employee outside the organization is refused", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const s = await seed(t, "outsider");
    await expect(
      s.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(s, { employeeId: s.outsider }))
    ).rejects.toThrow(/not an active member/);
  });

  test("another organization's sale is not found", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const a = await seed(t, "orgA");
    const b = await seed(t, "orgB");
    await expect(
      a.asAdmin.mutation(api.dealCommissions.addLine, { ...(await addArgs(a)), saleId: b.saleId })
    ).rejects.toThrow(/Sale not found/);
    await expect(a.asAdmin.query(api.dealCommissions.forSale, { orgId: a.orgId, saleId: b.saleId })).rejects.toThrow(/Sale not found/);
  });

  test("a caller without manage:commissions cannot write, and without view:commissions cannot read", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const viewer = await seed(t, "viewer", ["view:commissions", "view:sales", "create:sales", "view:vehicles"]);
    await expect(viewer.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(viewer))).rejects.toThrow(/Forbidden/);
    const view = await viewer.asAdmin.query(api.dealCommissions.forSale, { orgId: viewer.orgId, saleId: viewer.saleId });
    expect(view.canManage).toBe(false);

    const blind = await seed(t, "blind", ["view:sales", "create:sales", "view:vehicles"]);
    await expect(
      blind.asAdmin.query(api.dealCommissions.forSale, { orgId: blind.orgId, saleId: blind.saleId })
    ).rejects.toThrow(/Forbidden/);
  });

  test("a cancelled sale cannot be given a line, and its total counts as zero", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const s = await seed(t, "cancelled");
    await s.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(s));
    await t.run((ctx) => ctx.db.patch(s.saleId, { status: "CANCELLED" }));
    await expect(
      s.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(s, { kind: "EXECUTION", employeeId: s.executor }))
    ).rejects.toThrow(/cancelled sale/);
    const view = await s.asAdmin.query(api.dealCommissions.forSale, { orgId: s.orgId, saleId: s.saleId });
    expect(view.totalMinor).toBe(0);
  });

  test("a 3-decimal amount is exact in JOD and refused in USD", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const jod = await seed(t, "jod3");
    await jod.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(jod, { amount: 12.345 }));
    const view = await jod.asAdmin.query(api.dealCommissions.forSale, { orgId: jod.orgId, saleId: jod.saleId });
    expect(view.totalMinor).toBe(12_345);

    const usd = await seed(t, "usd3", ADMIN, "USD");
    await expect(usd.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(usd, { amount: 12.345 }))).rejects.toThrow(/at most 2 decimals/);
  });

  test("writes are audited", async () => {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const s = await seed(t, "audit");
    const lineId = await s.asAdmin.mutation(api.dealCommissions.addLine, await addArgs(s));
    await s.asAdmin.mutation(api.dealCommissions.removeLine, { orgId: s.orgId, lineId });
    const actions = (await t.run((ctx) => ctx.db.query("financialAuditLog").collect())).map((r) => r.actionType);
    expect(actions).toEqual(expect.arrayContaining(["ADD_DEAL_COMMISSION_LINE", "REMOVE_DEAL_COMMISSION_LINE"]));
  });
});

describe("reports show the margin after commissions (display only)", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const range = () => ({ startDate: Date.now() - DAY, endDate: Date.now() + DAY });

  async function costedSale(suffix: string, permissions: string[]) {
    const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
    const s = await seed(t, suffix, permissions);
    const sale = await t.run((ctx) => ctx.db.get(s.saleId));
    await t.run((ctx) => ctx.db.patch(sale!.vehicleId, { purchasePrice: 10000 }));
    return { t, s };
  }

  test("net after commissions = margin - (sale commission + lines); the margin itself is unchanged", async () => {
    const { s } = await costedSale("rep1", [...ADMIN, "view:reports"]);
    await s.asAdmin.mutation(api.sales.setCommissionAmount, { orgId: s.orgId, saleId: s.saleId, commissionAmount: 50 });
    await s.asAdmin.mutation(api.dealCommissions.addLine, { orgId: s.orgId, saleId: s.saleId, kind: "PURCHASE", employeeId: s.buyerAgent, amount: 50 });
    await s.asAdmin.mutation(api.dealCommissions.addLine, { orgId: s.orgId, saleId: s.saleId, kind: "EXECUTION", employeeId: s.executor, amount: 25 });

    const report = await s.asAdmin.query(api.reports.getSalesAndProfitReport, { orgId: s.orgId, ...range() });
    const row = report.sales[0];
    expect(row.netProfit).toBe(5000);
    expect(row.commissionsTotal).toBe(125);
    expect(row.netProfitAfterCommissions).toBe(4875);
    expect(report.totalProfit).toBe(5000);
    expect(report.totalCommissions).toBe(125);
    expect(report.totalNetProfitAfterCommissions).toBe(4875);
    expect(report.commissionIncompleteSaleCount).toBe(0);

    const perf = await s.asAdmin.query(api.reports.getSalespersonPerformance, { orgId: s.orgId, ...range() });
    expect(perf[0].totalProfit).toBe(5000);
    expect(perf[0].totalNetProfitAfterCommissions).toBe(4875);
  });

  test("an undecided salesperson commission gives no net figure and is counted, not zeroed", async () => {
    const { s } = await costedSale("rep2", [...ADMIN, "view:reports"]);
    const report = await s.asAdmin.query(api.reports.getSalesAndProfitReport, { orgId: s.orgId, ...range() });
    expect(report.sales[0].commissionPending).toBe(true);
    expect(report.sales[0].netProfitAfterCommissions).toBeNull();
    expect(report.totalNetProfitAfterCommissions).toBe(0);
    expect(report.commissionIncompleteSaleCount).toBe(1);
  });

  test("a caller without view:commissions gets no commission figures", async () => {
    const { s } = await costedSale("rep3", ["view:reports", "create:sales", "view:sales", "view:vehicles"]);
    const report = await s.asAdmin.query(api.reports.getSalesAndProfitReport, { orgId: s.orgId, ...range() });
    expect(report.sales[0].commissionsTotal).toBeNull();
    expect(report.sales[0].netProfitAfterCommissions).toBeNull();
    expect(report.totalCommissions).toBeNull();
    const perf = await s.asAdmin.query(api.reports.getSalespersonPerformance, { orgId: s.orgId, ...range() });
    expect(perf[0].totalCommissions).toBeNull();
  });
});
