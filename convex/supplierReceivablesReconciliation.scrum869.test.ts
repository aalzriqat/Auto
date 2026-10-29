/**
 * SCRUM-869 slice S2 - the supplier receivables subledger reconciled to GL 1240
 * (Receivable from Suppliers), per currency.
 *
 * Owner ruling SCRUM-869#c23881: supplier payable payment, consignment margin
 * receipt and cost-recovery receipt are all in the pilot and must be certified.
 * Design decisions SCRUM-869#c23880 (W2, W7, W13, OQ-10): the reconciliation is
 * per currency, has an Unlinked bucket, says UNAVAILABLE when it cannot be
 * computed, stores no balance, and a difference is displayed - never posted,
 * never a period-close gate.
 *
 * Subledger = the signed open balance of every non-CANCELLED margin receivable
 * (`vehicleSupplierReceivables`) plus every non-REVERSED cost recovery
 * (`supplierCostRecoveries`). Both post to 1240 (recognition Dr, receipt Cr).
 *
 * Writers are the real mutations (sales.create, supplierReceivables.recordReceipt,
 * expenses.create, supplierCostRecoveries.recordReceipt); rows are patched or
 * seeded directly only to make the subledger and the GL disagree, which no
 * writer can do.
 *
 * Evidence boundary: convex-test only - repository behaviour, not the Convex
 * runtime (no read-limit enforcement, no OCC) and not production data.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { computeSupplierReceivablesReconciliation } from "./accountingReports";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");
const PERIOD_CLOSE_SOURCE = import.meta.glob("./accountingPeriods.ts", { query: "?raw", import: "default", eager: true });

const PERMS = [
  "view:sales", "create:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "approve:requests",
  "view:expenses", "create:expenses",
];

const SCALE = 1000; // JOD has three decimals
const SALE_PRICE = 12_500;
const ENTITLEMENT = 9_500;
const MARGIN = SALE_PRICE - ENTITLEMENT; // 3,000 owed back by the supplier
const SUPPLIER_COST = 200;

async function seed(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S2 ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "S2 User" }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"] })
  );
  const asUser = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999), fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag }));
  return { t, orgId, userId, asUser, customerId };
}
type Seed = Awaited<ReturnType<typeof seed>>;

const addSourcedVehicle = (s: Seed, tag: string) =>
  s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin: `VINS2${tag}`, make: "Toyota", model: "Camry", year: 2024, mileage: 10, color: "White",
      fuelType: "Gas", transmission: "Auto", sellingPrice: SALE_PRICE, status: "AVAILABLE", sourceType: "SOURCED",
      sourcedFromName: "Amman Importer Co", sourceCost: ENTITLEMENT,
    })
  );

/** A COMPLETED consigned sale settled DIRECT_TO_SUPPLIER: the real posting debits 1240 and opens the receivable. */
async function directSale(s: Seed, tag: string) {
  const vehicleId = await addSourcedVehicle(s, tag);
  const saleId = await s.asUser.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
    salePrice: SALE_PRICE, saleDate: Date.now(), status: "COMPLETED" as const,
    supplierSettlementRoute: "DIRECT_TO_SUPPLIER" as const,
  });
  const receivable = (await s.t.run((ctx) =>
    ctx.db.query("vehicleSupplierReceivables").withIndex("by_sale", (q) => q.eq("saleId", saleId)).unique()
  ))!;
  return { vehicleId, saleId, receivable };
}

/** A supplier-borne cost paid by the showroom: the real posting debits 1240 and opens one recovery. */
async function supplierBornePayment(s: Seed, tag: string) {
  const vehicleId = await addSourcedVehicle(s, tag);
  const expenseId = (await s.asUser.mutation(api.expenses.create, {
    orgId: s.orgId, vehicleId, title: "Transport from the supplier's yard", amount: SUPPLIER_COST,
    date: Date.now() - 60_000, category: "TRANSPORT" as const, status: "PAID" as const, paymentMethod: "CASH" as const,
    costBearer: "SUPPLIER" as const, idempotencyKey: crypto.randomUUID(),
  } as never)) as Id<"expenses">;
  const recovery = (await s.t.run((ctx) =>
    ctx.db.query("supplierCostRecoveries").withIndex("by_org_expense", (q) => q.eq("orgId", s.orgId).eq("expenseId", expenseId)).first()
  ))!;
  return { vehicleId, expenseId, recovery };
}

const recon = (s: Seed) => s.asUser.query(api.accountingReports.supplierReceivablesReconciliation, { orgId: s.orgId });

const collect = (s: Seed, receivableId: Id<"vehicleSupplierReceivables">, amount: number) =>
  s.asUser.mutation(api.supplierReceivables.recordReceipt, {
    orgId: s.orgId, receivableId, amount, receiptMethod: "CASH", idempotencyKey: crypto.randomUUID(),
  });

const queueEvent = (s: Seed, fields: Record<string, unknown>) =>
  s.t.run((ctx) =>
    ctx.db.insert("pendingAccountingEvents", {
      orgId: s.orgId, kind: "POST", status: "PENDING", idempotencyKey: `k_${Math.random()}`, accountingDate: Date.now(),
      actorId: s.userId, attempts: 0, createdAt: Date.now(), sourceType: "supplierReceivables", sourceId: "x",
      eventType: "SUPPLIER_RECEIVABLE_COLLECTED", ...fields,
    } as never)
  );

const insertReceivable = (s: Seed, vehicleId: Id<"vehicles">, saleId: Id<"sales">, fields: Record<string, unknown>) => {
  const now = Date.now();
  return s.t.run((ctx) =>
    ctx.db.insert("vehicleSupplierReceivables", {
      orgId: s.orgId, vehicleId, saleId, sourcedFromName: "Amman Importer Co", currency: "JOD", status: "OPEN",
      createdBy: s.userId, createdAt: now, updatedAt: now, ...fields,
    } as never)
  );
};

describe("SCRUM-869 S2 - the supplier receivables subledger reconciles to GL 1240", () => {
  test("CONTROL: a fresh direct-settled sale reconciles - A/R subledger equals 1240", async () => {
    const s = await seed("ctl");
    await directSale(s, "ctl");
    const r = await recon(s);
    expect(r.status).toBe("AVAILABLE");
    expect(r.byCurrency.JOD).toMatchObject({
      glBalanceMinor: MARGIN * SCALE, subledgerBalanceMinor: MARGIN * SCALE, discrepancyMinor: 0, isReconciled: true,
    });
    expect(r.isReconciled).toBe(true);
    expect(r.complete).toBe(true);
  });

  test("a partial margin receipt lowers the subledger and 1240 by the same amount", async () => {
    const s = await seed("part");
    const { receivable } = await directSale(s, "part");
    await collect(s, receivable._id, 1_000);
    const r = await recon(s);
    expect(r.byCurrency.JOD).toMatchObject({
      glBalanceMinor: 2_000 * SCALE, subledgerBalanceMinor: 2_000 * SCALE, isReconciled: true,
    });
  });

  test("a supplier-borne cost recovery is part of the 1240 total, and its receipt lowers both sides", async () => {
    const s = await seed("rec");
    await directSale(s, "rec1");
    const { recovery } = await supplierBornePayment(s, "rec2");
    const open = await recon(s);
    expect(open.byCurrency.JOD).toMatchObject({
      glBalanceMinor: (MARGIN + SUPPLIER_COST) * SCALE, subledgerBalanceMinor: (MARGIN + SUPPLIER_COST) * SCALE, isReconciled: true,
    });
    expect(open.byCurrency.JOD.recoveryMinor).toBe(SUPPLIER_COST * SCALE);
    expect(open.byCurrency.JOD.marginMinor).toBe(MARGIN * SCALE);

    await s.asUser.mutation(api.supplierCostRecoveries.recordReceipt, {
      orgId: s.orgId, recoveryId: recovery._id, amountMinor: 80 * SCALE, method: "CASH",
      receivedDate: Date.now() - 1_000, idempotencyKey: crypto.randomUUID(),
    } as never);
    const after = await recon(s);
    expect(after.byCurrency.JOD).toMatchObject({
      glBalanceMinor: (MARGIN + SUPPLIER_COST - 80) * SCALE, subledgerBalanceMinor: (MARGIN + SUPPLIER_COST - 80) * SCALE, isReconciled: true,
    });
  });

  test("a receipt posted to the GL but not recorded in the subledger is a difference", async () => {
    const s = await seed("glonly");
    const { receivable } = await directSale(s, "glonly");
    await collect(s, receivable._id, 1_000);
    // The subledger forgets the receipt the GL already holds.
    await s.t.run((ctx) => ctx.db.patch(receivable._id, { amountReceived: undefined, status: "OPEN" }));
    const r = await recon(s);
    expect(r.status).toBe("AVAILABLE");
    expect(r.byCurrency.JOD).toMatchObject({
      glBalanceMinor: 2_000 * SCALE, subledgerBalanceMinor: 3_000 * SCALE, discrepancyMinor: -1_000 * SCALE, isReconciled: false,
    });
    expect(r.isReconciled).toBe(false);
  });

  test("a receipt recorded in the subledger but never posted to the GL is the reverse difference", async () => {
    const s = await seed("subonly");
    const { receivable } = await directSale(s, "subonly");
    await s.t.run((ctx) => ctx.db.patch(receivable._id, { amountReceived: 1_000, status: "PARTIALLY_PAID" }));
    const r = await recon(s);
    expect(r.byCurrency.JOD).toMatchObject({
      glBalanceMinor: 3_000 * SCALE, subledgerBalanceMinor: 2_000 * SCALE, discrepancyMinor: 1_000 * SCALE, isReconciled: false,
    });
    expect(r.isReconciled).toBe(false);
  });

  test("a currency with subledger rows and no GL balance is a difference, not zero", async () => {
    const s = await seed("ccy");
    const { vehicleId, saleId } = await directSale(s, "ccy");
    await insertReceivable(s, vehicleId, saleId, { amountDue: 400, currency: "USD" });
    const r = await recon(s);
    expect(r.currencies).toEqual(["JOD", "USD"]);
    expect(r.byCurrency.USD).toMatchObject({ glBalanceMinor: 0, subledgerBalanceMinor: 400 * 100, discrepancyMinor: -400 * 100, isReconciled: false });
    expect(r.byCurrency.JOD.isReconciled).toBe(true);
    expect(r.isReconciled).toBe(false);
  });

  test("rows with no supplier identity fall in the Unlinked bucket and still count toward the total", async () => {
    const s = await seed("unl");
    const { receivable } = await directSale(s, "unl");
    await s.t.run((ctx) => ctx.db.patch(receivable._id, { sourcedFromName: "Unknown supplier" }));
    const r = await recon(s);
    expect(r.byCurrency.JOD.unlinkedMinor).toBe(MARGIN * SCALE);
    expect(r.byCurrency.JOD.linkedMinor).toBe(0);
    expect(r.byCurrency.JOD.subledgerBalanceMinor).toBe(MARGIN * SCALE);
    expect(r.isReconciled).toBe(true);

    await s.t.run((ctx) => ctx.db.patch(receivable._id, { sourcedFromName: "Amman Importer Co" }));
    const named = await recon(s);
    expect(named.byCurrency.JOD.unlinkedMinor).toBe(0);
    expect(named.byCurrency.JOD.linkedMinor).toBe(MARGIN * SCALE);
  });

  test("a CANCELLED receivable and a REVERSED recovery carry no balance", async () => {
    const s = await seed("canc");
    const { vehicleId, saleId } = await directSale(s, "canc");
    await insertReceivable(s, vehicleId, saleId, { amountDue: 900, status: "CANCELLED", cancelledAt: Date.now() });
    const { recovery } = await supplierBornePayment(s, "canc2");
    await s.t.run((ctx) => ctx.db.patch(recovery._id, { status: "REVERSED", reversedAt: Date.now() }));
    const r = await recon(s);
    // Only the live margin is in the subledger; the reversed recovery is still in the GL here, so it shows as a difference rather than vanishing.
    expect(r.byCurrency.JOD.subledgerBalanceMinor).toBe(MARGIN * SCALE);
    expect(r.byCurrency.JOD.glBalanceMinor).toBe((MARGIN + SUPPLIER_COST) * SCALE);
  });

  test("a queued posting that touches 1240 reports pending, not a difference", async () => {
    const s = await seed("pend");
    await directSale(s, "pend");
    await queueEvent(s, { status: "PENDING" });
    const r = await recon(s);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("PENDING_POSTINGS");
    expect(r.isReconciled).toBe(false);
    expect(r.currencies).toEqual([]);
    expect(r.byCurrency).toEqual({});
    expect(r.complete).toBe(false);
  });

  test("a queued posting that cannot touch 1240 does not block the comparison", async () => {
    const s = await seed("pendother");
    await directSale(s, "pendother");
    await queueEvent(s, { eventType: "COMMISSION_PAID" });
    const r = await recon(s);
    expect(r.status).toBe("AVAILABLE");
    expect(r.isReconciled).toBe(true);
  });

  test("a pending draft that touches the 1240 account reports pending", async () => {
    const s = await seed("draft");
    await directSale(s, "draft");
    const ar = await s.t.run((ctx) =>
      ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", s.orgId).eq("systemKey", "RECEIVABLE_FROM_SUPPLIERS")).unique()
    );
    const other = await s.t.run((ctx) =>
      ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", s.orgId).eq("systemKey", "ACCOUNTS_PAYABLE_SUPPLIERS")).unique()
    );
    const draft = (accountId: Id<"chartOfAccounts">, key: string) =>
      s.t.run((ctx) =>
        ctx.db.insert("manualJournalDrafts", {
          orgId: s.orgId, status: "PENDING_APPROVAL", memo: "m", idempotencyKey: key, createdBy: s.userId, createdAt: Date.now(),
          lines: [{ accountId, debitMinor: 1, creditMinor: 0 }],
        })
      );
    await draft(other!._id, "s2_draft_other");
    expect((await recon(s)).status).toBe("AVAILABLE");
    await draft(ar!._id, "s2_draft_ar");
    const r = await recon(s);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("PENDING_POSTINGS");
  });

  test("more rows than the read limit is UNAVAILABLE (OVER_LIMIT), never a partial total", async () => {
    const s = await seed("lim");
    const { vehicleId, saleId } = await directSale(s, "lim");
    await insertReceivable(s, vehicleId, saleId, { amountDue: 1 });
    await insertReceivable(s, vehicleId, saleId, { amountDue: 1 });
    const r = await s.t.run((ctx) => computeSupplierReceivablesReconciliation(ctx, s.orgId, undefined, { readLimit: 2 }));
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("OVER_LIMIT");
    expect(r.isReconciled).toBe(false);
    expect(r.complete).toBe(false);
  });

  test("is protected by finance read and scoped to the caller's tenant", async () => {
    const s = await seed("auth");
    await directSale(s, "auth");
    const noFinanceRole = await s.t.run((ctx) => ctx.db.insert("roles", { orgId: s.orgId, name: "Sales", permissions: ["view:sales"] }));
    const salesUser = await s.t.run((ctx) => ctx.db.insert("users", { clerkId: "auth_sales", email: "s@e.com", name: "Sales" }));
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: s.orgId, userId: salesUser, roleId: noFinanceRole }));
    const asSales = s.t.withIdentity({ subject: "auth_sales", clerkId: "auth_sales" });
    await expect(asSales.query(api.accountingReports.supplierReceivablesReconciliation, { orgId: s.orgId })).rejects.toThrow();

    const other = await seed("auth2");
    await expect(other.asUser.query(api.accountingReports.supplierReceivablesReconciliation, { orgId: s.orgId })).rejects.toThrow();
    const own = await recon(other);
    expect(own.byCurrency).toEqual({});
  });

  test("it only reports: nothing is written and period close does not read it", async () => {
    const s = await seed("ro");
    await directSale(s, "ro");
    const count = () =>
      s.t.run(async (ctx) => ({
        events: (await ctx.db.query("accountingEvents").collect()).length,
        journals: (await ctx.db.query("journalEntries").collect()).length,
        outbox: (await ctx.db.query("pendingAccountingEvents").collect()).length,
        receivables: (await ctx.db.query("vehicleSupplierReceivables").collect()).length,
      }));
    const before = await count();
    await recon(s);
    expect(await count()).toEqual(before);
    // OQ-10 (SCRUM-869#c23880): displayed, not a close gate.
    const source = Object.values(PERIOD_CLOSE_SOURCE)[0] as string;
    expect(source.length).toBeGreaterThan(1000);
    expect(source).not.toMatch(/SupplierReceivablesReconciliation/);
  });
});
