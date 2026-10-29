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

describe("SCRUM-869 S3a - receivable edges", () => {
  test("a receivable whose saleId is another organisation's sale reads no delivery from it", async () => {
    freezeNow();
    const a = await seed("fsale");
    // A handed-over application that is genuinely this organisation's; only the sale pointing at it is foreign.
    const ownApplication = await addApplication(a, { handoverStatus: "HANDED_OVER", vehicleHandoverAt: NOW - 70 * DAY });
    // The other organisation lives in the SAME harness: separate harnesses hand out identical ids.
    const foreignSale = await a.t.run(async (ctx) => {
      const org = await ctx.db.insert("organizations", { name: "Other", createdAt: NOW });
      const customerId = await ctx.db.insert("customers", { orgId: org, firstName: "X", lastName: "Y" });
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId: org, vin: "VINFOREIGN", make: "Kia", model: "Rio", year: 2024, mileage: 1, color: "Red",
        fuelType: "Gas", transmission: "Auto", sellingPrice: 1, status: "AVAILABLE",
      } as never);
      const applicationId = ownApplication;
      return await ctx.db.insert("sales", {
        orgId: org, vehicleId, customerId, salespersonId: a.userId, salePrice: 1, saleDate: NOW - DAY, status: "COMPLETED",
        supplierSettlementRoute: "DIRECT_TO_SUPPLIER", applicationId,
      } as never);
    });
    await a.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierReceivables", {
        orgId: a.orgId, vehicleId: a.vehicleId, saleId: foreignSale, sourcedFromName: "X", amountDue: 3_000, currency: "JOD",
        status: "OPEN", createdBy: a.userId, createdAt: NOW, updatedAt: NOW,
      } as never)
    );
    expect((await list(a, "RECEIVABLE")).rows[0]).toMatchObject({ dueAt: null, rule: "DELIVERY_NOT_RECORDED", bucket: "NO_DUE_DATE" });
  });

  test("a cancelled receivable and a fully received one are not outstanding", async () => {
    freezeNow();
    const s = await seed("rcan");
    const saleId = await addSale(s, { supplierSettlementRoute: "DIRECT_TO_SUPPLIER" });
    await addReceivable(s, saleId, { status: "CANCELLED", agreedDueDate: NOW - DAY });
    await addReceivable(s, saleId, { status: "PAID", amountReceived: 3_000, agreedDueDate: NOW - DAY });
    expect((await list(s, "RECEIVABLE")).rows).toHaveLength(0);
  });

  test("a status that says settled while the amounts say open does not hide the open money", async () => {
    freezeNow();
    const s = await seed("rinc");
    const saleId = await addSale(s, { supplierSettlementRoute: "DIRECT_TO_SUPPLIER" });
    await addReceivable(s, saleId, { status: "PAID", amountReceived: 1_000, agreedDueDate: NOW - DAY });
    await addRecovery(s, { status: "RECOVERED", amountRecoveredMinor: 50_000, agreedDueDate: NOW - DAY });
    expect((await list(s, "RECEIVABLE")).rows[0]).toMatchObject({ outstandingMinor: 2_000_000 });
    expect((await list(s, "RECOVERY")).rows[0]).toMatchObject({ outstandingMinor: 150_000 });
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

  test("a requested page size above the cap is cut to the cap", async () => {
    freezeNow();
    const s = await seed("cap");
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 101; i++) {
        await ctx.db.insert("vehicleSupplierPayables", {
          orgId: s.orgId, vehicleId: s.vehicleId, sourcedFromName: "X", amountDue: 1, currency: "JOD", status: "DUE_ON_SALE",
          paymentDueDate: NOW - DAY, createdBy: s.userId, createdAt: NOW, updatedAt: NOW,
        } as never);
      }
    });
    const r = await list(s, "PAYABLE", { limit: 100_000 });
    expect(r.rows).toHaveLength(100);
    expect(r.complete).toBe(false);
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

/**
 * SCRUM-869 S3b - owner ruling SCRUM-869#c23906 (given 2026-10-29), which replaces the coordinator's
 * default for the two sourced triggers:
 *  - "completed delivery" is handing the car to the customer, i.e. the recorded vehicle handover
 *    (`financeApplications.vehicleHandoverAt`, written by `applications.registerVehicleHandover` for
 *    EVERY operated deal, CASH included). A completed sale is not delivery.
 *  - "cleared proceeds" is the receipt of the financing from the financier: the recorded
 *    `financeApplications.disbursedAt` with `disbursedAmountMinor`, written by
 *    `applications.confirmDisbursement` and cleared by `returnFinanceDisbursementCheque`.
 *    CASH deals have no financier and stay outside the ruling.
 */
describe("SCRUM-869 S3b (c23906) - THROUGH_DEALERSHIP payable is due on the financier's funding", () => {
  const FUNDED_AT = NOW - 20 * DAY;
  const funded = { disbursedAt: FUNDED_AT, disbursedAmountMinor: 9_000_000, settlementStatus: "FULLY_SETTLED" };

  async function financedPayable(s: Seed, application: Record<string, unknown>, payable: Record<string, unknown> = {}) {
    const applicationId = await addApplication(s, { quoteModeAtSubmission: "CONFIGURED_FINANCE_COMPANY", ...application });
    const saleId = await addSale(s, {
      supplierSettlementRoute: "THROUGH_DEALERSHIP", financingType: "FINANCED", applicationId, saleDate: NOW - 400 * DAY,
    });
    await addPayable(s, { saleId, ...payable });
    return { applicationId, saleId };
  }

  test("a financed deal whose financier funding is recorded: due on that instant and aged from it", async () => {
    freezeNow();
    const s = await seed("fund1");
    await financedPayable(s, funded);
    expect((await list(s, "PAYABLE")).rows[0]).toMatchObject({
      kind: "PAYABLE", rule: "FINANCIER_FUNDING_RECORDED", dueAt: FUNDED_AT, daysOverdue: 20, bucket: "DAYS_1_30", outstandingMinor: 9_500_000,
    });
  });

  test("a financed deal with no funding received (requested or pending) has no due date and is never overdue", async () => {
    freezeNow();
    const s = await seed("fund2");
    await financedPayable(s, { settlementStatus: "EXPECTED", expectedDealerRemittanceMinor: 9_000_000 });
    expect((await list(s, "PAYABLE")).rows[0]).toMatchObject({
      dueAt: null, rule: "FINANCIER_FUNDING_NOT_RECORDED", daysOverdue: null, bucket: "NO_DUE_DATE",
    });
  });

  test("a funding that was reversed (cheque returned after clearing) is not received", async () => {
    freezeNow();
    const s = await seed("fund3");
    // The exact state `returnFinanceDisbursementCheque` leaves: the instant and amount cleared, the
    // status back to EXPECTED, the disbursement version bumped.
    await financedPayable(s, {
      disbursedAt: undefined, disbursedAmountMinor: undefined, settlementStatus: "EXPECTED", disbursementVersion: 2,
    });
    expect((await list(s, "PAYABLE")).rows[0]).toMatchObject({
      dueAt: null, rule: "FINANCIER_FUNDING_NOT_RECORDED", bucket: "NO_DUE_DATE",
    });
  });

  test("an instant with no recorded amount is not a received funding", async () => {
    freezeNow();
    const s = await seed("fund4");
    await financedPayable(s, { disbursedAt: FUNDED_AT });
    expect((await list(s, "PAYABLE")).rows[0]).toMatchObject({ dueAt: null, rule: "FINANCIER_FUNDING_NOT_RECORDED" });
  });

  test("the financier's payment to the supplier (direct route fact) is not the dealership's funding", async () => {
    freezeNow();
    const s = await seed("fund5");
    await financedPayable(s, { supplierDisbursementConfirmedAt: FUNDED_AT, supplierDisbursedAmountMinor: 9_000_000 });
    expect((await list(s, "PAYABLE")).rows[0]).toMatchObject({ dueAt: null, rule: "FINANCIER_FUNDING_NOT_RECORDED" });
  });

  test("a recorded vehicle handover does not stand in for funding", async () => {
    freezeNow();
    const s = await seed("fund6");
    await financedPayable(s, { handoverStatus: "HANDED_OVER", vehicleHandoverAt: FUNDED_AT });
    expect((await list(s, "PAYABLE")).rows[0]).toMatchObject({ dueAt: null, rule: "FINANCIER_FUNDING_NOT_RECORDED" });
  });

  test("an agreed paymentDueDate still wins over the funding instant", async () => {
    freezeNow();
    const s = await seed("fund7");
    await financedPayable(s, funded, { paymentDueDate: NOW - 3 * DAY, paymentDueTrigger: "FIXED_DATE" });
    expect((await list(s, "PAYABLE")).rows[0]).toMatchObject({ rule: "AGREED_DATE", daysOverdue: 3, bucket: "DAYS_1_30" });
  });

  test("a funded application of another organisation is not evidence of this deal's funding", async () => {
    freezeNow();
    const a = await seed("fund8");
    const foreignApplication = await a.t.run(async (ctx) => {
      const org = await ctx.db.insert("organizations", { name: "Other", createdAt: NOW });
      const customerId = await ctx.db.insert("customers", { orgId: org, firstName: "X", lastName: "Y" });
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId: org, vin: "VINF8", make: "Kia", model: "Rio", year: 2024, mileage: 1, color: "Red",
        fuelType: "Gas", transmission: "Auto", sellingPrice: 1, status: "AVAILABLE",
      } as never);
      const companyId = await ctx.db.insert("financeCompanies", { orgId: org, name: "B", isActive: true, profitRate: 5, maxTermMonths: 72, gracePeriodMonths: 3 });
      const quoteId = await ctx.db.insert("quotes", {
        orgId: org, vehicleId, customerId, vehiclePrice: 1, downPayment: 0, totalFinancedAmount: 1,
        termMonths: 12, status: "DRAFT", companyId, createdBy: a.userId, createdAt: NOW,
      } as never);
      return await ctx.db.insert("financeApplications", {
        orgId: org, customerId, vehicleId, companyId, quoteId, salespersonId: a.userId, status: "CLOSED",
        createdAt: NOW, updatedAt: NOW, ...funded,
      } as never);
    });
    const saleId = await addSale(a, {
      supplierSettlementRoute: "THROUGH_DEALERSHIP", financingType: "FINANCED", applicationId: foreignApplication,
    });
    await addPayable(a, { saleId });
    expect((await list(a, "PAYABLE")).rows[0]).toMatchObject({ dueAt: null, rule: "FINANCIER_FUNDING_NOT_RECORDED" });
  });

  test("a CASH deal is outside the ruling: no due date, never overdue, even beside stray funding data", async () => {
    freezeNow();
    const s = await seed("cash1");
    const applicationId = await addApplication(s, { quoteModeAtSubmission: "CASH", ...funded });
    const saleId = await addSale(s, {
      supplierSettlementRoute: "THROUGH_DEALERSHIP", financingType: "CASH", applicationId, saleDate: NOW - 400 * DAY,
    });
    await addPayable(s, { saleId });
    expect((await list(s, "PAYABLE")).rows[0]).toMatchObject({
      dueAt: null, rule: "CLEARED_PROCEEDS_NOT_RECORDED", daysOverdue: null, bucket: "NO_DUE_DATE",
    });
  });

  test("a CASH sale recorded without a deal application has no due date either", async () => {
    freezeNow();
    const s = await seed("cash2");
    const saleId = await addSale(s, { supplierSettlementRoute: "THROUGH_DEALERSHIP", financingType: "CASH", saleDate: NOW - 400 * DAY });
    await addPayable(s, { saleId });
    expect((await list(s, "PAYABLE")).rows[0]).toMatchObject({ dueAt: null, rule: "CLEARED_PROCEEDS_NOT_RECORDED", bucket: "NO_DUE_DATE" });
  });
});

describe("SCRUM-869 S3b (c23906) - the margin receivable is due on the recorded vehicle handover only", () => {
  const HANDED_OVER_AT = NOW - 70 * DAY;

  test("a CASH deal records the same handover and is due on it", async () => {
    freezeNow();
    const s = await seed("rcash1");
    const applicationId = await addApplication(s, {
      quoteModeAtSubmission: "CASH", handoverStatus: "HANDED_OVER", vehicleHandoverAt: HANDED_OVER_AT,
    });
    const saleId = await addSale(s, { supplierSettlementRoute: "DIRECT_TO_SUPPLIER", financingType: "CASH", applicationId });
    await addReceivable(s, saleId);
    expect((await list(s, "RECEIVABLE")).rows[0]).toMatchObject({
      rule: "DELIVERY_RECORDED", dueAt: HANDED_OVER_AT, daysOverdue: 70, bucket: "DAYS_61_90",
    });
  });

  test("a CASH sale completed without a deal application has no handover record: not delivery", async () => {
    freezeNow();
    const s = await seed("rcash2");
    const saleId = await addSale(s, {
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER", financingType: "CASH", status: "COMPLETED", saleDate: NOW - 200 * DAY,
    });
    await addReceivable(s, saleId);
    expect((await list(s, "RECEIVABLE")).rows[0]).toMatchObject({ dueAt: null, rule: "DELIVERY_NOT_RECORDED", bucket: "NO_DUE_DATE" });
  });

  test("a funded financed deal with no recorded handover is still not delivered", async () => {
    freezeNow();
    const s = await seed("rfund");
    const applicationId = await addApplication(s, { disbursedAt: NOW - 30 * DAY, disbursedAmountMinor: 9_000_000 });
    const saleId = await addSale(s, { supplierSettlementRoute: "DIRECT_TO_SUPPLIER", financingType: "FINANCED", applicationId });
    await addReceivable(s, saleId);
    expect((await list(s, "RECEIVABLE")).rows[0]).toMatchObject({ dueAt: null, rule: "DELIVERY_NOT_RECORDED", bucket: "NO_DUE_DATE" });
  });
});
