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
import { DEFAULT_ROLE_TEMPLATES } from "./utils/permissions";
import { getControlAccountBalancesAsOf, getCumulativeBalancesAsOf } from "./accounting/accountSnapshots";

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
async function directSale(s: Seed, tag: string, saleDate: number = Date.now()) {
  const vehicleId = await addSourcedVehicle(s, tag);
  const saleId = await s.asUser.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
    salePrice: SALE_PRICE, saleDate, status: "COMPLETED" as const,
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

    // A finance user of a DIFFERENT organization in the same database (separate harnesses hand out identical ids).
    const otherOrg = await s.t.run((ctx) => ctx.db.insert("organizations", { name: "S2 other", createdAt: Date.now() }));
    const otherUser = await s.t.run((ctx) => ctx.db.insert("users", { clerkId: "auth_other", email: "o@e.com", name: "Other" }));
    const otherRole = await s.t.run((ctx) => ctx.db.insert("roles", { orgId: otherOrg, name: "Owner", permissions: PERMS }));
    await s.t.run((ctx) => ctx.db.insert("memberships", { orgId: otherOrg, userId: otherUser, roleId: otherRole }));
    const asOther = s.t.withIdentity({ subject: "auth_other", clerkId: "auth_other" });
    await expect(asOther.query(api.accountingReports.supplierReceivablesReconciliation, { orgId: s.orgId })).rejects.toThrow();
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

const DAY = 86_400_000;

const accountOf = (s: Seed, systemKey: string) =>
  s.t.run(async (ctx) =>
    (await ctx.db.query("chartOfAccounts").withIndex("by_org_systemKey", (q) => q.eq("orgId", s.orgId).eq("systemKey", systemKey as never)).unique())!
  );
const periodOf = (s: Seed) =>
  s.t.run(async (ctx) => (await ctx.db.query("accountingPeriods").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).first())!);
/** Zero-valued snapshot shards: they add documents to the read without moving any balance. */
const addZeroSnapshots = (s: Seed, accountId: Id<"chartOfAccounts">, periodId: Id<"accountingPeriods">, count: number) =>
  s.t.run(async (ctx) => {
    for (let shard = 100; shard < 100 + count; shard += 1) {
      await ctx.db.insert("accountBalanceSnapshots", {
        orgId: s.orgId, accountId, currency: "JOD", periodId, shard, runningDebitMinor: 0, runningCreditMinor: 0, updatedAt: Date.now(),
      });
    }
  });

/**
 * SCRUM-858 F1. The GL side is read as of `toDate`; the subledger side is the rows' CURRENT state,
 * and a margin receipt carries no date of its own (`amountReceived` is a running total), so the
 * subledger cannot be rebuilt at a past date. A comparison at a past `toDate` would mix two
 * cutoffs, so it is refused: UNAVAILABLE, never "reconciled" and never a manufactured difference.
 */
describe("SCRUM-858 F1 - no mixed-cutoff comparison", () => {
  test("a real 3,000 error is not reported reconciled at a past toDate", async () => {
    const s = await seed("f1hide");
    // Sale A is dated ten days ago, so its 3,000 is in the GL at the cutoff. Its receivable row is then lost
    // (the real error). Sale B is made now: its row is created after the cutoff and its GL entry is later too.
    const a = await directSale(s, "f1hideA", Date.now() - 10 * DAY);
    await s.t.run((ctx) => ctx.db.delete(a.receivable._id));
    await directSale(s, "f1hideB");
    const r = await s.asUser.query(api.accountingReports.supplierReceivablesReconciliation, {
      orgId: s.orgId, toDate: Date.now() - 5 * DAY,
    });
    expect(r.isReconciled).toBe(false);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("AS_OF_DATE_UNSUPPORTED");
    expect(r.complete).toBe(false);
    expect(r.byCurrency).toEqual({});
  });

  test("a row created after a past toDate does not manufacture a difference", async () => {
    const s = await seed("f1art");
    await directSale(s, "f1art");
    const r = await s.asUser.query(api.accountingReports.supplierReceivablesReconciliation, {
      orgId: s.orgId, toDate: Date.now() - DAY,
    });
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("AS_OF_DATE_UNSUPPORTED");
    expect(r.currencies).toEqual([]);
    expect(r.byCurrency).toEqual({});
    expect(r.isReconciled).toBe(false);
  });

  test("a toDate only seconds in the past is still a past cutoff and is refused", async () => {
    const s = await seed("f1secs");
    await directSale(s, "f1secs");
    const r = await s.asUser.query(api.accountingReports.supplierReceivablesReconciliation, {
      orgId: s.orgId, toDate: Date.now() - 1000,
    });
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("AS_OF_DATE_UNSUPPORTED");
    expect(r.isReconciled).toBe(false);
  });

  test("CONTROL: an omitted toDate and a future toDate are the current state and still reconcile", async () => {
    const s = await seed("f1ok");
    await directSale(s, "f1ok");
    const omitted = await recon(s);
    const future = await s.asUser.query(api.accountingReports.supplierReceivablesReconciliation, {
      orgId: s.orgId, toDate: Date.now() + DAY,
    });
    for (const r of [omitted, future]) {
      expect(r.status).toBe("AVAILABLE");
      expect(r.byCurrency.JOD).toMatchObject({ glBalanceMinor: MARGIN * SCALE, subledgerBalanceMinor: MARGIN * SCALE, isReconciled: true });
      expect(r.complete).toBe(true);
    }
  });
});

/**
 * SCRUM-858 F2. The GL side used to read every period, every snapshot and possibly every journal
 * line of the organization before keeping the control accounts, so `readLimit` bounded nothing there.
 * The read is now scoped to the control accounts and counted against the limit.
 */
describe("SCRUM-858 F2 - the GL read is bounded", () => {
  test("more control-account snapshot rows than the read limit is UNAVAILABLE (OVER_LIMIT), never a partial total", async () => {
    const s = await seed("f2over");
    await directSale(s, "f2over");
    const ar = await accountOf(s, "RECEIVABLE_FROM_SUPPLIERS");
    await addZeroSnapshots(s, ar._id, (await periodOf(s))._id, 6);
    const tight = await s.t.run((ctx) => computeSupplierReceivablesReconciliation(ctx, s.orgId, undefined, { readLimit: 3 }));
    expect(tight.status).toBe("UNAVAILABLE");
    expect(tight.unavailableReason).toBe("OVER_LIMIT");
    expect(tight.isReconciled).toBe(false);
    expect(tight.complete).toBe(false);
    const roomy = await s.t.run((ctx) => computeSupplierReceivablesReconciliation(ctx, s.orgId, undefined, { readLimit: 100 }));
    expect(roomy.status).toBe("AVAILABLE");
    expect(roomy.byCurrency.JOD).toMatchObject({ glBalanceMinor: MARGIN * SCALE, isReconciled: true });
  });

  test("snapshots of accounts that are not control accounts do not count against the limit", async () => {
    const s = await seed("f2scope");
    await directSale(s, "f2scope");
    const cash = await accountOf(s, "CASH_ON_HAND");
    await addZeroSnapshots(s, cash._id, (await periodOf(s))._id, 40);
    const r = await s.t.run((ctx) => computeSupplierReceivablesReconciliation(ctx, s.orgId, undefined, { readLimit: 10 }));
    expect(r.status).toBe("AVAILABLE");
    expect(r.byCurrency.JOD).toMatchObject({ glBalanceMinor: MARGIN * SCALE, isReconciled: true });
  });

  test("accounting periods are read against the limit too: more periods than the limit is OVER_LIMIT", async () => {
    const s = await seed("f2periods");
    await directSale(s, "f2periods");
    const ar = await accountOf(s, "RECEIVABLE_FROM_SUPPLIERS");
    const period = await periodOf(s);
    await s.t.run(async (ctx) => {
      for (let i = 1; i <= 10; i += 1) {
        await ctx.db.insert("accountingPeriods", {
          orgId: s.orgId, startDate: period.startDate - (i + 1) * 30 * DAY, endDate: period.startDate - i * 30 * DAY - 1,
          fiscalYear: period.fiscalYear - 1, periodNumber: i, status: "CLOSED", createdAt: Date.now(),
        });
      }
    });
    const read = (readLimit: number) =>
      s.t.run((ctx) => getControlAccountBalancesAsOf(ctx, s.orgId, [ar._id], Date.now() + DAY, readLimit));
    expect((await read(8)).status).toBe("OVER_LIMIT");
    const roomy = await read(100);
    expect(roomy.status).toBe("OK");
    if (roomy.status === "OK") expect(roomy.balances).toEqual([{ accountId: ar._id, currency: "JOD", debitMinor: MARGIN * SCALE, creditMinor: 0 }]);
  });

  test("the scoped read returns what the full read returns for the control account", async () => {
    const s = await seed("f2parity");
    await directSale(s, "f2par1", Date.now() - 10 * DAY);
    await directSale(s, "f2par2");
    const ar = await accountOf(s, "RECEIVABLE_FROM_SUPPLIERS");
    const period = await periodOf(s);
    // A fully elapsed earlier period holding 500 more of debit on 1240, summed from its snapshot.
    const earlier = await s.t.run(async (ctx) => {
      const id = await ctx.db.insert("accountingPeriods", {
        orgId: s.orgId, startDate: period.startDate - 365 * DAY, endDate: period.startDate - 1, fiscalYear: period.fiscalYear - 1,
        periodNumber: 1, status: "CLOSED", createdAt: Date.now(),
      });
      await ctx.db.insert("accountBalanceSnapshots", {
        orgId: s.orgId, accountId: ar._id, currency: "JOD", periodId: id, shard: 0, runningDebitMinor: 500, runningCreditMinor: 0, updatedAt: Date.now(),
      });
      return id;
    });
    expect(earlier).toBeTruthy();
    const compare = async (asOf: number) =>
      s.t.run(async (ctx) => {
        const scoped = await getControlAccountBalancesAsOf(ctx, s.orgId, [ar._id], asOf, 4000);
        const full = (await getCumulativeBalancesAsOf(ctx, s.orgId, asOf)).filter((b) => b.accountId === ar._id);
        return { scoped, full };
      });
    for (const fastPath of [true, false]) {
      await s.t.run((ctx) => ctx.db.patch(period._id, { snapshotFastPathEligible: fastPath }));
      for (const asOf of [Date.now() + DAY, Date.now() - 5 * DAY, Date.now() - 20 * DAY]) {
        const { scoped, full } = await compare(asOf);
        expect(scoped.status).toBe("OK");
        if (scoped.status === "OK") expect(scoped.balances).toEqual(full);
      }
    }
    const now = await compare(Date.now() + DAY);
    expect(now.full).toEqual([{ accountId: ar._id, currency: "JOD", debitMinor: 2 * MARGIN * SCALE + 500, creditMinor: 0 }]);
  });
});

/**
 * SCRUM-858 F4. A/P runs the opening-parent integrity check on every payable, native ones too: a native
 * row that a POSTED opening draft claims as its own result is a contradiction, not a native row. A/R
 * ran it only for OPENING recoveries.
 */
describe("SCRUM-858 F4 - a native recovery is checked against the opening drafts too", () => {
  const postedDraft = (s: Seed, allocationResults: unknown[]) =>
    s.t.run((ctx) =>
      ctx.db.insert("openingBalanceDrafts", {
        orgId: s.orgId, status: "POSTED", lines: [], asOfDate: Date.now(), createdBy: s.userId, createdAt: Date.now(), allocationResults,
      } as never)
    );

  test("a native recovery that a POSTED opening draft claims as its result is UNAVAILABLE", async () => {
    const s = await seed("f4claim");
    const { recovery } = await supplierBornePayment(s, "f4claim");
    expect(recovery.origin ?? "EXPENSE").toBe("EXPENSE");
    await postedDraft(s, [{ kind: "SUPPLIER_RECOVERABLE", rowKey: "r1", recoveryId: recovery._id }]);
    const r = await recon(s);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("OPENING_SOURCE_UNAVAILABLE");
    expect(r.isReconciled).toBe(false);
    expect(r.complete).toBe(false);
  });

  test("CONTROL: a POSTED opening draft that claims a different recovery does not block a native one", async () => {
    const s = await seed("f4other");
    const { recovery } = await supplierBornePayment(s, "f4other1");
    const { recovery: elsewhere } = await supplierBornePayment(s, "f4other2");
    await s.t.run((ctx) => ctx.db.delete(elsewhere._id));
    await postedDraft(s, [{ kind: "SUPPLIER_RECOVERABLE", rowKey: "r1", recoveryId: elsewhere._id }]);
    const r = await recon(s);
    expect(r.status).toBe("AVAILABLE");
    expect(r.byCurrency.JOD.recoveryMinor).toBe(SUPPLIER_COST * SCALE);
    expect(recovery._id).not.toBe(elsewhere._id);
  });

  test("more POSTED opening drafts than can be checked is UNAVAILABLE, as it is for A/P", async () => {
    const s = await seed("f4many");
    await supplierBornePayment(s, "f4many");
    for (let i = 0; i < 101; i += 1) await postedDraft(s, []);
    const r = await recon(s);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("OPENING_SOURCE_UNAVAILABLE");
  });
});

/**
 * SCRUM-858 F3. Each test below pins one fact that a mutation of the reconciliation used to survive.
 * Expected figures are literals worked out by hand, never recomputed with the code's own arithmetic.
 */
describe("SCRUM-858 F3 - the in-flight posting check", () => {
  // The five event types whose rule touches 1240 (postingRules.ts SUPPLIER_RECEIVABLE_AFFECTING_BY_EVENT_TYPE).
  const AFFECTING = [
    "SALE_COMPLETED", "DEPOSIT_APPLIED_TO_SETTLEMENT", "EXPENSE_POSTED", "SUPPLIER_RECEIVABLE_COLLECTED", "SUPPLIER_COST_RECOVERY_RECEIVED",
  ] as const;

  test.each(AFFECTING)("a queued %s posting reports pending", async (eventType) => {
    const s = await seed(`f3q${eventType.slice(0, 6)}`);
    await directSale(s, "f3q");
    await queueEvent(s, { status: "PENDING", eventType });
    const r = await recon(s);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("PENDING_POSTINGS");
  });

  test.each(AFFECTING)("a FAILED %s posting reports pending too", async (eventType) => {
    const s = await seed(`f3f${eventType.slice(0, 6)}`);
    await directSale(s, "f3f");
    await queueEvent(s, { status: "FAILED", eventType });
    const r = await recon(s);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("PENDING_POSTINGS");
  });

  test("a queued posting with no event type is treated as touching 1240", async () => {
    const s = await seed("f3notype");
    await directSale(s, "f3notype");
    await s.t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId: s.orgId, kind: "POST", status: "PENDING", idempotencyKey: "f3_notype", accountingDate: Date.now(), actorId: s.userId,
        attempts: 0, createdAt: Date.now(), sourceType: "x", sourceId: "x",
      })
    );
    expect((await recon(s)).unavailableReason).toBe("PENDING_POSTINGS");
  });

  const postedEvent = (s: Seed, eventType: string) =>
    s.t.run((ctx) =>
      ctx.db.insert("accountingEvents", {
        orgId: s.orgId, eventType, sourceType: "x", sourceId: `f3_${eventType}`, eventVersion: 1, idempotencyKey: `f3_${eventType}_${Math.random()}`,
        occurredAt: Date.now(), accountingDate: Date.now(), currency: "JOD", payload: {}, status: "POSTED", createdBy: s.userId, createdAt: Date.now(),
      })
    );
  const queueReverse = (s: Seed, originalEventId?: Id<"accountingEvents">) =>
    s.t.run((ctx) =>
      ctx.db.insert("pendingAccountingEvents", {
        orgId: s.orgId, kind: "REVERSE", status: "PENDING", idempotencyKey: `f3_rev_${Math.random()}`, accountingDate: Date.now(),
        actorId: s.userId, attempts: 0, createdAt: Date.now(), sourceType: "x", sourceId: "x", ...(originalEventId ? { originalEventId } : {}),
      })
    );

  test("a queued reversal of an event that touches 1240 reports pending", async () => {
    const s = await seed("f3revhit");
    await directSale(s, "f3revhit");
    await queueReverse(s, await postedEvent(s, "SALE_COMPLETED"));
    expect((await recon(s)).unavailableReason).toBe("PENDING_POSTINGS");
  });

  test("a queued reversal of an event that cannot touch 1240 does not block the comparison", async () => {
    const s = await seed("f3revmiss");
    await directSale(s, "f3revmiss");
    await queueReverse(s, await postedEvent(s, "COMMISSION_PAID"));
    const r = await recon(s);
    expect(r.status).toBe("AVAILABLE");
    expect(r.isReconciled).toBe(true);
  });

  test("a queued reversal that names no event, or an event that no longer exists, reports pending", async () => {
    const s = await seed("f3revnone");
    await directSale(s, "f3revnone");
    const reversal = await queueReverse(s);
    expect((await recon(s)).unavailableReason).toBe("PENDING_POSTINGS");
    await s.t.run((ctx) => ctx.db.delete(reversal));

    const gone = await postedEvent(s, "COMMISSION_PAID");
    await queueReverse(s, gone);
    await s.t.run((ctx) => ctx.db.delete(gone));
    expect((await recon(s)).unavailableReason).toBe("PENDING_POSTINGS");
  });
});

describe("SCRUM-858 F3 - the read limits", () => {
  const cloneRecovery = (s: Seed, recovery: Awaited<ReturnType<typeof supplierBornePayment>>["recovery"], fields: Record<string, unknown>) =>
    s.t.run((ctx) => {
      const { _id, _creationTime, ...rest } = recovery;
      void _id; void _creationTime;
      return ctx.db.insert("supplierCostRecoveries", { ...rest, ...fields } as never);
    });
  const reconWith = (s: Seed, readLimit: number) =>
    s.t.run((ctx) => computeSupplierReceivablesReconciliation(ctx, s.orgId, undefined, { readLimit }));

  test("cost recoveries share one limit across statuses: over it is UNAVAILABLE, exactly at it is available", async () => {
    const s = await seed("f3rec");
    const { recovery } = await supplierBornePayment(s, "f3rec");
    await cloneRecovery(s, recovery, { status: "OPEN" });
    await cloneRecovery(s, recovery, { status: "RECOVERED", amountRecoveredMinor: recovery.amountDueMinor });
    await cloneRecovery(s, recovery, { status: "RECOVERED", amountRecoveredMinor: recovery.amountDueMinor });
    // 4 rows: two OPEN, two RECOVERED. A per-status budget would see 2 + 2 and pass at 3.
    const over = await reconWith(s, 3);
    expect(over.status).toBe("UNAVAILABLE");
    expect(over.unavailableReason).toBe("OVER_LIMIT");
    expect(over.complete).toBe(false);
    const exact = await reconWith(s, 4);
    expect(exact.status).toBe("AVAILABLE");
    expect(exact.rowsRead).toEqual({ receivables: 0, recoveries: 4 });
  });

  test("margin receivables share one limit across statuses", async () => {
    const s = await seed("f3rcv");
    const { vehicleId, saleId } = await directSale(s, "f3rcv");
    await insertReceivable(s, vehicleId, saleId, { amountDue: 1, status: "PAID", amountReceived: 1 });
    await insertReceivable(s, vehicleId, saleId, { amountDue: 1, status: "PAID", amountReceived: 1 });
    // 3 rows: one OPEN, two PAID.
    const over = await reconWith(s, 2);
    expect(over.unavailableReason).toBe("OVER_LIMIT");
    expect((await reconWith(s, 3)).status).toBe("AVAILABLE");
  });

  const queueOthers = async (s: Seed, status: "PENDING" | "FAILED", count: number) => {
    for (let i = 0; i < count; i += 1) await queueEvent(s, { status, eventType: "COMMISSION_PAID" });
  };

  test.each(["PENDING", "FAILED"] as const)("more %s outbox rows than the limit is UNAVAILABLE (OVER_LIMIT)", async (status) => {
    const s = await seed(`f3ob${status}`);
    await directSale(s, "f3ob");
    await queueOthers(s, status, 3);
    const over = await reconWith(s, 2);
    expect(over.status).toBe("UNAVAILABLE");
    expect(over.unavailableReason).toBe("OVER_LIMIT");
    // Exactly at the limit all three are read, none touches 1240, so the comparison goes ahead.
    const exact = await reconWith(s, 3);
    expect(exact.status).toBe("AVAILABLE");
  });

  test("more pending drafts than the limit is UNAVAILABLE (OVER_LIMIT)", async () => {
    const s = await seed("f3drafts");
    await directSale(s, "f3drafts");
    const other = await accountOf(s, "ACCOUNTS_PAYABLE_SUPPLIERS");
    await s.t.run(async (ctx) => {
      for (let i = 0; i < 3; i += 1) {
        await ctx.db.insert("manualJournalDrafts", {
          orgId: s.orgId, status: "PENDING_APPROVAL", memo: "m", idempotencyKey: `f3_draft_${i}`, createdBy: s.userId, createdAt: Date.now(),
          lines: [{ accountId: other._id, debitMinor: 1, creditMinor: 0 }],
        });
      }
    });
    expect((await reconWith(s, 2)).unavailableReason).toBe("OVER_LIMIT");
    expect((await reconWith(s, 3)).status).toBe("AVAILABLE");
  });
});

describe("SCRUM-858 F3 - every balance-carrying status is in the subledger", () => {
  test("OPEN, PARTIALLY_PAID, DISPUTED and PAID receivables count; CANCELLED does not", async () => {
    const s = await seed("f3st");
    const { vehicleId, saleId, receivable } = await directSale(s, "f3st");
    await s.t.run((ctx) => ctx.db.delete(receivable._id));
    await insertReceivable(s, vehicleId, saleId, { amountDue: 10, status: "OPEN" });
    await insertReceivable(s, vehicleId, saleId, { amountDue: 20, amountReceived: 5, status: "PARTIALLY_PAID" });
    await insertReceivable(s, vehicleId, saleId, { amountDue: 40, status: "DISPUTED" });
    await insertReceivable(s, vehicleId, saleId, { amountDue: 80, amountReceived: 30, status: "PAID" });
    await insertReceivable(s, vehicleId, saleId, { amountDue: 160, status: "CANCELLED" });
    const r = await recon(s);
    // 10 + (20 - 5) + 40 + (80 - 30) = 115 JOD.
    expect(r.byCurrency.JOD.marginMinor).toBe(115_000);
    expect(r.rowsRead).toEqual({ receivables: 4, recoveries: 0 });
  });

  test("OPEN, PARTIALLY_RECOVERED and RECOVERED recoveries count; REVERSED does not", async () => {
    const s = await seed("f3strec");
    const { recovery } = await supplierBornePayment(s, "f3strec");
    const clone = (fields: Record<string, unknown>) =>
      s.t.run((ctx) => {
        const { _id, _creationTime, ...rest } = recovery;
        void _id; void _creationTime;
        return ctx.db.insert("supplierCostRecoveries", { ...rest, ...fields } as never);
      });
    await s.t.run((ctx) => ctx.db.patch(recovery._id, { amountDueMinor: 10_000, amountRecoveredMinor: 0, status: "OPEN" }));
    await clone({ amountDueMinor: 20_000, amountRecoveredMinor: 5_000, status: "PARTIALLY_RECOVERED" });
    await clone({ amountDueMinor: 40_000, amountRecoveredMinor: 30_000, status: "RECOVERED" });
    await clone({ amountDueMinor: 80_000, amountRecoveredMinor: 0, status: "REVERSED" });
    const r = await recon(s);
    // 10,000 + (20,000 - 5,000) + (40,000 - 30,000) = 35,000 minor units.
    expect(r.byCurrency.JOD.recoveryMinor).toBe(35_000);
    expect(r.rowsRead).toEqual({ receivables: 0, recoveries: 3 });
  });
});

/**
 * SCRUM-858 F3 - opening recoveries. An OPENING recovery is the cutover's own 1240-family claim: it
 * posts to a declared control account (here a synthetic 1999), not necessarily to 1240, and is
 * verified against the POSTED opening draft that created it.
 */
describe("SCRUM-858 F3 - opening cost recoveries", () => {
  const OPENING_MINOR = 100_000; // 100 JOD

  async function openingRecovery(s: Seed, asOfDate: number) {
    const owner = DEFAULT_ROLE_TEMPLATES.find((role) => role.name === "OWNER")!;
    await s.t.run(async (ctx) => {
      const membership = await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).first();
      await ctx.db.patch(membership!.roleId, { isSystemOwnerRole: true, permissions: [...owner.permissions] });
    });
    const accountId = await s.asUser.mutation(api.chartOfAccounts.create, {
      orgId: s.orgId, code: "1999", name: "Synthetic declared opening control", type: "ASSET", normalBalance: "DEBIT",
      currencyRestriction: "JOD", isControlAccount: true, allowManualPosting: false,
    });
    const retained = (await s.asUser.query(api.chartOfAccounts.list, { orgId: s.orgId })).find((a) => a.systemKey === "RETAINED_EARNINGS")!;
    await s.asUser.mutation(api.accountingCutover.postOpeningBalanceDirect, {
      orgId: s.orgId, expectedCurrency: "JOD", asOfDate,
      lines: [
        { accountId, debitMinor: OPENING_MINOR, creditMinor: 0 },
        { accountId: retained._id, debitMinor: 0, creditMinor: OPENING_MINOR },
      ],
      allocations: [
        { kind: "SUPPLIER_RECOVERABLE", counterpartyName: "Synthetic supplier", title: "Synthetic opening claim", purpose: "CLAIM",
          rowKey: "open-1", accountId, amountMinor: OPENING_MINOR },
      ],
    });
    const row = (await s.t.run((ctx) =>
      ctx.db.query("supplierCostRecoveries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).filter((q) => q.eq(q.field("origin"), "OPENING")).unique()
    ))!;
    return { accountId, row };
  }
  const at = (s: Seed, toDate: number) =>
    s.asUser.query(api.accountingReports.supplierReceivablesReconciliation, { orgId: s.orgId, toDate });

  test("an opening recovery posts to its declared account and reconciles", async () => {
    const s = await seed("f3open");
    const { row } = await openingRecovery(s, Date.now() - 1_000);
    expect(row.origin).toBe("OPENING");
    const r = await recon(s);
    expect(r.status).toBe("AVAILABLE");
    expect(r.byCurrency.JOD).toMatchObject({
      glBalanceMinor: OPENING_MINOR, subledgerBalanceMinor: OPENING_MINOR, discrepancyMinor: 0, isReconciled: true, recoveryMinor: OPENING_MINOR,
    });
  });

  test("an opening recovery dated after the cutoff is on neither side; a later toDate brings it in on both", async () => {
    const s = await seed("f3openfut");
    await openingRecovery(s, Date.now() + 2 * DAY);
    const current = await recon(s);
    expect(current.status).toBe("AVAILABLE");
    expect(current.currencies).toEqual([]);
    expect(current.isReconciled).toBe(true);

    const later = await at(s, Date.now() + 5 * DAY);
    expect(later.byCurrency.JOD).toMatchObject({
      glBalanceMinor: OPENING_MINOR, subledgerBalanceMinor: OPENING_MINOR, isReconciled: true, recoveryMinor: OPENING_MINOR,
    });
  });

  test("an opening recovery whose row no longer matches its POSTED draft is UNAVAILABLE", async () => {
    const s = await seed("f3openbad");
    const { row } = await openingRecovery(s, Date.now() - 1_000);
    await s.t.run((ctx) => ctx.db.patch(row._id, { amountDueMinor: OPENING_MINOR - 1 }));
    const r = await recon(s);
    expect(r.status).toBe("UNAVAILABLE");
    expect(r.unavailableReason).toBe("OPENING_SOURCE_UNAVAILABLE");
    expect(r.isReconciled).toBe(false);
    expect(r.complete).toBe(false);
  });
});