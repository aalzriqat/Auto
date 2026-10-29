/**
 * SCRUM-869 S3a - supplier obligation due dates and aging (read side).
 *
 * Owner ruling SCRUM-869#c23883 (OQ-1), the coordinator's Jira record of a chat ruling (not the
 * owner's own text): the due date of a supplier payable, margin receivable or cost recovery is
 * derived on the server - the agreed date, else the ownership-model trigger read from recorded
 * facts only, else "No due date", which is never overdue. Buckets: Current, 1-30, 31-60, 61-90,
 * 90+ days overdue, in Asia/Amman. Disputed amounts are shown separately and stay in the gross.
 *
 * Coordinator rulings 2026-10-29 on the open points: "completed delivery" is only an explicit
 * record (financed `handoverStatus === HANDED_OVER` with `vehicleHandoverAt`); cleared proceeds are
 * not recorded, so a THROUGH_DEALERSHIP payable has no due date unless `paymentDueDate` is set;
 * a cost recovery has an agreed date or none.
 *
 * Rows are seeded directly: this slice reads, it writes nothing. Evidence boundary: convex-test
 * only (no runtime read limits, no OCC) and not production data.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const MODULES = import.meta.glob("./**/*.*s");
const DAY = 86_400_000;
// 2026-06-15 12:00 UTC = 15:00 in Amman (UTC+3).
const NOW = Date.parse("2026-06-15T09:00:00Z");

afterEach(() => {
  vi.useRealTimers();
});

function freezeNow(at: number = NOW) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
}

async function seed(tag: string, permissions: string[] = ["view:finance", "manage:finance"]) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S3 ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "S3 User" }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Finance", permissions }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag }));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VIN${tag}`, make: "Toyota", model: "Camry", year: 2024, mileage: 10, color: "White",
      fuelType: "Gas", transmission: "Auto", sellingPrice: 12_500, status: "AVAILABLE", sourceType: "SOURCED",
      sourcedFromName: "Amman Importer Co", sourceCost: 9_500,
    })
  );
  return { t, orgId, userId, asUser, customerId, vehicleId };
}
type Seed = Awaited<ReturnType<typeof seed>>;

async function addSale(s: Seed, fields: Record<string, unknown> = {}) {
  return await s.t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice: 12_500, saleDate: NOW - 40 * DAY, status: "COMPLETED", ...fields,
    } as never)
  );
}

async function addApplication(s: Seed, fields: Record<string, unknown>) {
  const companyId = await s.t.run((ctx) =>
    ctx.db.insert("financeCompanies", { orgId: s.orgId, name: "Bank", isActive: true, profitRate: 5, maxTermMonths: 72, gracePeriodMonths: 3 })
  );
  const quoteId = await s.t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, vehiclePrice: 12_000, downPayment: 2_000,
      totalFinancedAmount: 10_000, termMonths: 24, status: "DRAFT", companyId, createdBy: s.userId, createdAt: NOW,
    } as never)
  );
  return await s.t.run((ctx) =>
    ctx.db.insert("financeApplications", {
      orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId, companyId, quoteId, salespersonId: s.userId,
      status: "CLOSED", createdAt: NOW, updatedAt: NOW, ...fields,
    } as never)
  );
}

const addPayable = (s: Seed, fields: Record<string, unknown> = {}) =>
  s.t.run((ctx) =>
    ctx.db.insert("vehicleSupplierPayables", {
      orgId: s.orgId, vehicleId: s.vehicleId, sourcedFromName: "Amman Importer Co", amountDue: 9_500, currency: "JOD",
      status: "DUE_ON_SALE", createdBy: s.userId, createdAt: NOW, updatedAt: NOW, ...fields,
    } as never)
  );

const addReceivable = (s: Seed, saleId: Id<"sales">, fields: Record<string, unknown> = {}) =>
  s.t.run((ctx) =>
    ctx.db.insert("vehicleSupplierReceivables", {
      orgId: s.orgId, vehicleId: s.vehicleId, saleId, sourcedFromName: "Amman Importer Co", amountDue: 3_000,
      currency: "JOD", status: "OPEN", createdBy: s.userId, createdAt: NOW, updatedAt: NOW, ...fields,
    } as never)
  );

const addRecovery = (s: Seed, fields: Record<string, unknown> = {}) =>
  s.t.run(async (ctx) => {
    const expenseId = await ctx.db.insert("expenses", {
      orgId: s.orgId, vehicleId: s.vehicleId, title: "Transport", amount: 200, date: NOW - DAY, category: "TRANSPORT", status: "PAID",
    } as never);
    return await ctx.db.insert("supplierCostRecoveries", {
      orgId: s.orgId, vehicleId: s.vehicleId, expenseId, sourceEventKey: `ev_${Math.random()}`,
      sourcedFromName: "Amman Importer Co", amountDueMinor: 200_000, amountRecoveredMinor: 0, currency: "JOD",
      receiptSeq: 0, status: "OPEN", createdBy: s.userId, createdAt: NOW, updatedAt: NOW, ...fields,
    } as never);
  });

const list = (s: Seed, kind: "PAYABLE" | "RECEIVABLE" | "RECOVERY", extra: Record<string, unknown> = {}) =>
  s.asUser.query(api.supplierDueAging.list, { orgId: s.orgId, kind, ...extra } as never);

describe("SCRUM-869 S3a - payables", () => {
  test("an agreed paymentDueDate wins and ages by Amman calendar days", async () => {
    freezeNow();
    const s = await seed("pay1");
    await addPayable(s, { paymentDueDate: NOW - 10 * DAY, paymentDueTrigger: "FIXED_DATE" });
    const r = await list(s, "PAYABLE");
    expect(r.complete).toBe(true);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({
      kind: "PAYABLE", rule: "AGREED_DATE", daysOverdue: 10, bucket: "DAYS_1_30", outstandingMinor: 9_500_000, disputedMinor: 0,
    });
    expect(r.rows[0].explanation).toMatch(/agreed/i);
  });

  test("THROUGH_DEALERSHIP payable with a completed sale but no agreed date: no due date, cleared proceeds not recorded", async () => {
    freezeNow();
    const s = await seed("pay2");
    const saleId = await addSale(s, { supplierSettlementRoute: "THROUGH_DEALERSHIP", saleDate: NOW - 400 * DAY });
    await addPayable(s, { saleId });
    const r = await list(s, "PAYABLE");
    expect(r.rows[0]).toMatchObject({ dueAt: null, rule: "CLEARED_PROCEEDS_NOT_RECORDED", daysOverdue: null, bucket: "NO_DUE_DATE" });
  });

  test("an ON_ACCOUNT-style payable (no sale) with no agreed terms has no due date", async () => {
    freezeNow();
    const s = await seed("pay3");
    await addPayable(s, { status: "NOT_YET_DUE" });
    const r = await list(s, "PAYABLE");
    expect(r.rows[0]).toMatchObject({ dueAt: null, rule: "TERMS_NOT_RECORDED", bucket: "NO_DUE_DATE" });
  });

  test("an agreed date in the future is Current, with a negative day count", async () => {
    freezeNow();
    const s = await seed("pay4");
    await addPayable(s, { paymentDueDate: NOW + 5 * DAY });
    const r = await list(s, "PAYABLE");
    expect(r.rows[0]).toMatchObject({ daysOverdue: -5, bucket: "CURRENT" });
  });

  test("the Amman midnight edge: due that day is Current until 00:00 Amman, then 1 day overdue", async () => {
    const s = await seed("pay5");
    await addPayable(s, { paymentDueDate: Date.parse("2026-06-10T08:00:00Z") });
    freezeNow(Date.parse("2026-06-10T20:59:59.999Z"));
    expect((await list(s, "PAYABLE")).rows[0]).toMatchObject({ daysOverdue: 0, bucket: "CURRENT" });
    freezeNow(Date.parse("2026-06-10T21:00:00.000Z"));
    expect((await list(s, "PAYABLE")).rows[0]).toMatchObject({ daysOverdue: 1, bucket: "DAYS_1_30" });
  });

  test("a disputed payable is shown separately but stays in the gross outstanding and in its aging bucket", async () => {
    freezeNow();
    const s = await seed("pay6");
    await addPayable(s, { status: "DISPUTED", paymentDueDate: NOW - 45 * DAY, amountPaid: 1_500 });
    await addPayable(s, { paymentDueDate: NOW - 45 * DAY, amountDue: 500 });
    const r = await list(s, "PAYABLE");
    const disputed = r.rows.find((row: { disputedMinor: number }) => row.disputedMinor > 0)!;
    expect(disputed).toMatchObject({ outstandingMinor: 8_000_000, disputedMinor: 8_000_000, bucket: "DAYS_31_60" });
    expect(r.totals).toContainEqual({ currency: "JOD", bucket: "DAYS_31_60", grossMinor: 8_500_000, disputedMinor: 8_000_000 });
  });

  test("paid and cancelled payables are not outstanding", async () => {
    freezeNow();
    const s = await seed("pay7");
    await addPayable(s, { status: "PAID", amountPaid: 9_500, paymentDueDate: NOW - 5 * DAY });
    await addPayable(s, { status: "CANCELLED", paymentDueDate: NOW - 5 * DAY });
    expect((await list(s, "PAYABLE")).rows).toHaveLength(0);
  });
});

describe("SCRUM-869 S3a - margin receivables", () => {
  const HANDED_OVER_AT = NOW - 70 * DAY;

  test("financed delivery recorded: due on handover and aged from it", async () => {
    freezeNow();
    const s = await seed("rec1");
    const applicationId = await addApplication(s, { handoverStatus: "HANDED_OVER", vehicleHandoverAt: HANDED_OVER_AT });
    const saleId = await addSale(s, { supplierSettlementRoute: "DIRECT_TO_SUPPLIER", applicationId });
    await addReceivable(s, saleId);
    const r = await list(s, "RECEIVABLE");
    expect(r.rows[0]).toMatchObject({
      kind: "RECEIVABLE", rule: "DELIVERY_RECORDED", daysOverdue: 70, bucket: "DAYS_61_90", outstandingMinor: 3_000_000,
    });
  });

  test("a COMPLETED sale is not delivery: no application means no due date", async () => {
    freezeNow();
    const s = await seed("rec2");
    const saleId = await addSale(s, { supplierSettlementRoute: "DIRECT_TO_SUPPLIER", status: "COMPLETED", saleDate: NOW - 200 * DAY });
    await addReceivable(s, saleId);
    expect((await list(s, "RECEIVABLE")).rows[0]).toMatchObject({ dueAt: null, rule: "DELIVERY_NOT_RECORDED", bucket: "NO_DUE_DATE" });
  });

  test.each(["READY", "BLOCKED"])("handoverStatus %s is not delivery", async (handoverStatus) => {
    freezeNow();
    const s = await seed(`rec3${handoverStatus}`);
    const applicationId = await addApplication(s, { handoverStatus, vehicleHandoverAt: HANDED_OVER_AT });
    const saleId = await addSale(s, { supplierSettlementRoute: "DIRECT_TO_SUPPLIER", applicationId });
    await addReceivable(s, saleId);
    expect((await list(s, "RECEIVABLE")).rows[0]).toMatchObject({ dueAt: null, rule: "DELIVERY_NOT_RECORDED", bucket: "NO_DUE_DATE" });
  });

  test("HANDED_OVER with no handover timestamp is a missing fact, never overdue", async () => {
    freezeNow();
    const s = await seed("rec4");
    const applicationId = await addApplication(s, { handoverStatus: "HANDED_OVER" });
    const saleId = await addSale(s, { supplierSettlementRoute: "DIRECT_TO_SUPPLIER", applicationId });
    await addReceivable(s, saleId);
    expect((await list(s, "RECEIVABLE")).rows[0]).toMatchObject({ dueAt: null, rule: "DELIVERY_NOT_RECORDED", bucket: "NO_DUE_DATE" });
  });

  test("an agreedDueDate on the receivable beats the delivery trigger", async () => {
    freezeNow();
    const s = await seed("rec5");
    const applicationId = await addApplication(s, { handoverStatus: "HANDED_OVER", vehicleHandoverAt: HANDED_OVER_AT });
    const saleId = await addSale(s, { supplierSettlementRoute: "DIRECT_TO_SUPPLIER", applicationId });
    await addReceivable(s, saleId, { agreedDueDate: NOW - 3 * DAY });
    expect((await list(s, "RECEIVABLE")).rows[0]).toMatchObject({ rule: "AGREED_DATE", daysOverdue: 3, bucket: "DAYS_1_30" });
  });

  test("a disputed receivable keeps its outstanding in gross and reports it as disputed", async () => {
    freezeNow();
    const s = await seed("rec6");
    const saleId = await addSale(s, { supplierSettlementRoute: "DIRECT_TO_SUPPLIER" });
    await addReceivable(s, saleId, { status: "DISPUTED", agreedDueDate: NOW - 100 * DAY, amountReceived: 1_000 });
    const r = await list(s, "RECEIVABLE");
    expect(r.rows[0]).toMatchObject({ outstandingMinor: 2_000_000, disputedMinor: 2_000_000, bucket: "DAYS_90_PLUS" });
  });

  test("a sale from another organisation is not read as a fact of this one", async () => {
    freezeNow();
    const a = await seed("recX");
    const otherOrg = await a.t.run((ctx) => ctx.db.insert("organizations", { name: "Other", createdAt: NOW }));
    const otherVehicle = await a.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: otherOrg, vin: "VINOTHER", make: "Kia", model: "Rio", year: 2024, mileage: 1, color: "Red",
        fuelType: "Gas", transmission: "Auto", sellingPrice: 1, status: "AVAILABLE",
      } as never)
    );
    const otherApp = await a.t.run(async (ctx) => {
      const companyId = await ctx.db.insert("financeCompanies", { orgId: otherOrg, name: "B", isActive: true, profitRate: 5, maxTermMonths: 72, gracePeriodMonths: 3 });
      const customerId = await ctx.db.insert("customers", { orgId: otherOrg, firstName: "X", lastName: "Y" });
      const quoteId = await ctx.db.insert("quotes", {
        orgId: otherOrg, vehicleId: otherVehicle, customerId, vehiclePrice: 1, downPayment: 0, totalFinancedAmount: 1,
        termMonths: 12, status: "DRAFT", companyId, createdBy: a.userId, createdAt: NOW,
      } as never);
      return await ctx.db.insert("financeApplications", {
        orgId: otherOrg, customerId, vehicleId: otherVehicle, companyId, quoteId, salespersonId: a.userId, status: "CLOSED",
        handoverStatus: "HANDED_OVER", vehicleHandoverAt: HANDED_OVER_AT, createdAt: NOW, updatedAt: NOW,
      } as never);
    });
    // This org's sale points at the other org's handed-over application.
    const saleId = await addSale(a, { supplierSettlementRoute: "DIRECT_TO_SUPPLIER", applicationId: otherApp });
    await addReceivable(a, saleId);
    expect((await list(a, "RECEIVABLE")).rows[0]).toMatchObject({ dueAt: null, rule: "DELIVERY_NOT_RECORDED", bucket: "NO_DUE_DATE" });
  });
});

describe("SCRUM-869 S3a - cost recoveries", () => {
  test("no agreed date: no due date, collectibility not recorded", async () => {
    freezeNow();
    const s = await seed("cr1");
    await addRecovery(s);
    expect((await list(s, "RECOVERY")).rows[0]).toMatchObject({
      kind: "RECOVERY", dueAt: null, rule: "COLLECTIBILITY_NOT_RECORDED", bucket: "NO_DUE_DATE", outstandingMinor: 200_000,
    });
  });

  test("an agreed date ages the outstanding minor units", async () => {
    freezeNow();
    const s = await seed("cr2");
    await addRecovery(s, { agreedDueDate: NOW - 95 * DAY, amountRecoveredMinor: 50_000, status: "PARTIALLY_RECOVERED" });
    expect((await list(s, "RECOVERY")).rows[0]).toMatchObject({
      rule: "AGREED_DATE", daysOverdue: 95, bucket: "DAYS_90_PLUS", outstandingMinor: 150_000, disputedMinor: 0,
    });
  });

  test("recovered and reversed recoveries are not outstanding", async () => {
    freezeNow();
    const s = await seed("cr3");
    await addRecovery(s, { status: "RECOVERED", amountRecoveredMinor: 200_000, agreedDueDate: NOW - DAY });
    await addRecovery(s, { status: "REVERSED", agreedDueDate: NOW - DAY });
    expect((await list(s, "RECOVERY")).rows).toHaveLength(0);
  });
});

describe("SCRUM-869 S3a - bounded reads, tenancy, permission", () => {
  test("pagination is bounded and `complete` is only true on the last page", async () => {
    freezeNow();
    const s = await seed("pg");
    for (let i = 0; i < 5; i++) await addPayable(s, { paymentDueDate: NOW - (i + 1) * DAY });
    const first = await list(s, "PAYABLE", { limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.complete).toBe(false);
    const second = await list(s, "PAYABLE", { limit: 2, cursor: first.continueCursor });
    expect(second.complete).toBe(false);
    const third = await list(s, "PAYABLE", { limit: 2, cursor: second.continueCursor });
    expect(third.rows).toHaveLength(1);
    expect(third.complete).toBe(true);
  });

  test("another organisation's obligations are never returned", async () => {
    freezeNow();
    const a = await seed("tenA");
    const otherOrg = await a.t.run((ctx) => ctx.db.insert("organizations", { name: "Other", createdAt: NOW }));
    await a.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierPayables", {
        orgId: otherOrg, vehicleId: a.vehicleId, sourcedFromName: "X", amountDue: 1, currency: "JOD", status: "DUE_ON_SALE",
        paymentDueDate: NOW - DAY, createdBy: a.userId, createdAt: NOW, updatedAt: NOW,
      } as never)
    );
    await addPayable(a, { paymentDueDate: NOW - DAY });
    const r = await list(a, "PAYABLE");
    expect(r.rows).toHaveLength(1);
    await expect(a.asUser.query(api.supplierDueAging.list, { orgId: otherOrg, kind: "PAYABLE" } as never)).rejects.toThrow();
  });

  test("a member without view:finance is refused", async () => {
    freezeNow();
    const s = await seed("perm", ["view:sales"]);
    await expect(list(s, "PAYABLE")).rejects.toThrow();
  });
});

describe("SCRUM-869 S3a - schema widening (agreedDueDate is optional)", () => {
  test("a receivable and a recovery written before the field exists are valid, and one with it is valid too", async () => {
    const s = await seed("schema");
    const saleId = await addSale(s);
    const oldReceivable = await addReceivable(s, saleId);
    const newReceivable = await addReceivable(s, saleId, { agreedDueDate: NOW });
    const oldRecovery = await addRecovery(s);
    const newRecovery = await addRecovery(s, { agreedDueDate: NOW });
    const rows = await s.t.run(async (ctx) => [
      await ctx.db.get(oldReceivable), await ctx.db.get(newReceivable), await ctx.db.get(oldRecovery), await ctx.db.get(newRecovery),
    ]);
    expect(rows[0]!.agreedDueDate).toBeUndefined();
    expect(rows[1]!.agreedDueDate).toBe(NOW);
    expect(rows[2]!.agreedDueDate).toBeUndefined();
    expect(rows[3]!.agreedDueDate).toBe(NOW);
  });
});
