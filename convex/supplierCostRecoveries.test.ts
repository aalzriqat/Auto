/**
 * SCRUM-389 — the supplier cost bearer on SOURCED-vehicle expenses.
 *
 * A cost the SUPPLIER bears is paid by the showroom and owed back: the payment
 * debits Receivable from Suppliers, never an expense account, and opens one
 * recovery row the supplier's receipts are recorded against. These tests hold
 * the rule at every door that can put such a cost on the books, every reader
 * that could count it as the showroom's, and every path that could un-happen it.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import { deriveDealerPreparationExpenses } from "./utils/vehicleCostBasis";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const PERMS = [
  "view:sales", "create:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "view:users",
  "manage:finance", "view:finance", "view:reports",
  "view:expenses", "create:expenses", "edit:expenses", "delete:expenses",
];

const SCALE = 1000; // JOD
const SUPPLIER_COST = 200;
const SHOWROOM_COST = 50;

type T = ReturnType<typeof convexTestWithComponents>;

async function addOrg(t: T, tag: string) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `SCR ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: `SCR ${tag}` })
  );
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Manager", permissions: PERMS }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );
  const as = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  await as.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await as.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await as.query(api.accountingPeriods.list, { orgId }))[0];
  await as.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  return { orgId, userId, as };
}

async function addVehicle(t: T, orgId: Id<"organizations">, tag: string, extra: Record<string, unknown>) {
  return await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VINSCR${tag}`, make: "Toyota", model: "Camry", year: 2024, mileage: 10,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 12_500,
      status: "AVAILABLE",
      ...extra,
    } as any)
  );
}

async function seed(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const org = await addOrg(t, tag);
  const sourcedId = await addVehicle(t, org.orgId, `${tag}S`, {
    sourceType: "SOURCED", sourcedFromName: "Amman Importer Co", sourceCost: 9_500,
  });
  const stockId = await addVehicle(t, org.orgId, `${tag}K`, { sourceType: "STOCK", purchasePrice: 8_000 });
  return { t, ...org, sourcedId, stockId };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

function expenseArgs(s: Seeded, overrides: Record<string, unknown> = {}) {
  return {
    orgId: s.orgId,
    vehicleId: s.sourcedId,
    title: "Transport from the supplier's yard",
    amount: SUPPLIER_COST,
    date: Date.now() - 60_000,
    category: "TRANSPORT" as const,
    status: "PAID" as const,
    paymentMethod: "CASH" as const,
    costBearer: "SUPPLIER" as const,
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  } as any;
}

async function paySupplierCost(s: Seeded, overrides: Record<string, unknown> = {}) {
  const expenseId = (await s.as.mutation(api.expenses.create, expenseArgs(s, overrides))) as Id<"expenses">;
  const recovery = await s.t.run((ctx) =>
    ctx.db
      .query("supplierCostRecoveries")
      .withIndex("by_org_expense", (q) => q.eq("orgId", s.orgId).eq("expenseId", expenseId))
      .first()
  );
  return { expenseId, recovery: recovery! };
}

/**
 * Net debit−credit per system key across the org's journal. A reversed entry
 * is marked REVERSED and its reversing entry POSTED; both are ledger history,
 * so both count — reading POSTED only would drop the original and keep its undo.
 */
async function ledger(t: T, orgId: Id<"organizations">): Promise<Record<string, number>> {
  return await t.run(async (ctx) => {
    const accounts = (await ctx.db.query("chartOfAccounts").collect()).filter((a) => a.orgId === orgId);
    const keyByAccount = new Map<string, string>();
    const typeByAccount = new Map<string, string>();
    for (const a of accounts) {
      if (a.systemKey) keyByAccount.set(a._id, a.systemKey);
      typeByAccount.set(a._id, a.type);
    }
    const entries = (await ctx.db.query("journalEntries").collect()).filter(
      (e) => e.orgId === orgId && (e.status === "POSTED" || e.status === "REVERSED")
    );
    const lines = await ctx.db.query("journalLines").collect();
    const totals: Record<string, number> = {};
    for (const entry of entries) {
      for (const l of lines.filter((x) => x.journalEntryId === entry._id)) {
        const key = keyByAccount.get(l.accountId) ?? `type:${typeByAccount.get(l.accountId)}`;
        totals[key] = (totals[key] ?? 0) + l.debitMinor - l.creditMinor;
        const typeKey = `type:${typeByAccount.get(l.accountId)}`;
        if (typeKey !== key) totals[typeKey] = (totals[typeKey] ?? 0) + l.debitMinor - l.creditMinor;
      }
    }
    return totals;
  });
}

function receiptArgs(s: Seeded, recoveryId: Id<"supplierCostRecoveries">, overrides: Record<string, unknown> = {}) {
  return {
    orgId: s.orgId,
    recoveryId,
    amountMinor: 80 * SCALE,
    method: "CASH" as const,
    receivedDate: Date.now() - 1_000,
    idempotencyKey: crypto.randomUUID(),
    ...overrides,
  } as any;
}

function reverseArgs(s: Seeded, receiptId: Id<"supplierCostRecoveryReceipts">, reason: string) {
  return { orgId: s.orgId, receiptId, reason, idempotencyKey: crypto.randomUUID() };
}

describe("who may bear a cost", () => {
  test("SUPPLIER is refused on a vehicle that is not SOURCED", async () => {
    const s = await seed("stock");
    await expect(s.as.mutation(api.expenses.create, expenseArgs(s, { vehicleId: s.stockId }))).rejects.toThrow(
      /Only a sourced \(consigned\) vehicle's cost can be borne by the supplier/
    );
    await expect(s.as.mutation(api.expenses.create, expenseArgs(s, { vehicleId: undefined }))).rejects.toThrow(
      /must be recorded against a vehicle in this organization/
    );
  });

  test("SUPPLIER is refused on a prepaid expense", async () => {
    const s = await seed("prepaid");
    await expect(
      s.as.mutation(api.expenses.create, expenseArgs(s, { isPrepaid: true, amortizationMonths: 6 }))
    ).rejects.toThrow(/A prepaid expense cannot be borne by the supplier/);
  });

  test("SUPPLIER is refused on a taxed expense", async () => {
    const s = await seed("taxed");
    await expect(s.as.mutation(api.expenses.create, expenseArgs(s, { taxAmount: 16 }))).rejects.toThrow(
      /cannot carry VAT/
    );
  });

  test("SUPPLIER is refused on an amount the org currency cannot represent exactly", async () => {
    // Expenses carry no currency of their own — they are in the org currency by
    // construction — so the currency rule is enforced as exact representability
    // in that currency's minor unit (JOD: 3 decimals).
    const s = await seed("fraction");
    await expect(s.as.mutation(api.expenses.create, expenseArgs(s, { amount: 10.0005 }))).rejects.toThrow(
      /finer than the currency allows/
    );
    const recoveries = await s.t.run((ctx) => ctx.db.query("supplierCostRecoveries").collect());
    expect(recoveries).toHaveLength(0);
  });

  test("the bearer cannot be changed once the expense is PAID", async () => {
    const s = await seed("immutable");
    const { expenseId } = await paySupplierCost(s);
    await expect(
      s.as.mutation(api.expenses.update, { orgId: s.orgId, expenseId, costBearer: "SHOWROOM" })
    ).rejects.toThrow(/Who bears a paid expense cannot be changed/);
    const row = await s.t.run((ctx) => ctx.db.get(expenseId));
    expect(row!.costBearer).toBe("SUPPLIER");
  });
});

describe("paying a supplier-borne cost", () => {
  test("posts Dr Receivable from Suppliers / Cr cash — no expense — and opens exactly one recovery", async () => {
    const s = await seed("post");
    const { expenseId, recovery } = await paySupplierCost(s);

    const gl = await ledger(s.t, s.orgId);
    expect(gl[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(SUPPLIER_COST * SCALE);
    expect(gl["type:EXPENSE"] ?? 0).toBe(0);
    expect(gl["type:ASSET"]).toBe(0); // the receivable debit is the cash credit, nothing else

    expect(recovery).toBeTruthy();
    expect(recovery.expenseId).toBe(expenseId);
    expect(recovery.amountDueMinor).toBe(SUPPLIER_COST * SCALE);
    expect(recovery.status).toBe("OPEN");
    expect(recovery.sourcedFromName).toBe("Amman Importer Co");
    const all = await s.t.run((ctx) => ctx.db.query("supplierCostRecoveries").collect());
    expect(all).toHaveLength(1);
  });
});

describe("profit readers exclude a supplier-borne cost", () => {
  async function seedBoth(tag: string) {
    const s = await seed(tag);
    await paySupplierCost(s);
    await s.as.mutation(
      api.expenses.create,
      expenseArgs(s, { costBearer: undefined, amount: SHOWROOM_COST, title: "Showroom detailing", category: "DETAILING" })
    );
    return s;
  }
  const year = new Date().getUTCFullYear();
  const range = { startDate: Date.UTC(year, 0, 1), endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999) };

  test("the P&L carries only the showroom's cost", async () => {
    const s = await seedBoth("pnl");
    const pnl = await s.as.query(api.reports.getProfitAndLoss, { orgId: s.orgId, ...range });
    expect(pnl.costOfGoodsSold).toBe(SHOWROOM_COST);
  });

  test("the expenses report and the per-vehicle total carry only the showroom's cost", async () => {
    const s = await seedBoth("exrep");
    const report = await s.as.query(api.reports.getExpensesReport, { orgId: s.orgId, ...range });
    expect(report.totalExpenses).toBe(SHOWROOM_COST);
    const total = await s.as.query(api.expenses.totalByVehicle, { orgId: s.orgId, vehicleId: s.sourcedId });
    expect(total).toBe(SHOWROOM_COST);
  });

  test("the dashboard keeps it out of Expenses and Profit and shows it as cash out", async () => {
    const s = await seedBoth("dash");
    const stats = await s.as.query(api.dashboard.stats, { orgId: s.orgId, timeRange: "ALL_TIME" });
    const sum = (k: string) => stats.salesTrend.reduce((acc: number, p: any) => acc + (p[k] ?? 0), 0);
    expect(sum("Expenses")).toBe(SHOWROOM_COST);
    expect(sum("Profit")).toBe(-SHOWROOM_COST);
    expect(sum("CashOut")).toBe(SHOWROOM_COST + SUPPLIER_COST);
  });

  test("the deal's dealer-preparation cost excludes it", () => {
    const row = (id: string, costBearer: "SUPPLIER" | undefined): Doc<"expenses"> =>
      ({
        _id: id, _creationTime: 1, orgId: "o", title: id, amount: 100, date: 1,
        category: "REPAIR", status: "PAID", accountingTreatment: "PERIOD_EXPENSE", costBearer,
      }) as unknown as Doc<"expenses">;
    const prep = deriveDealerPreparationExpenses({
      expenses: [row("supplier", "SUPPLIER"), row("showroom", undefined)],
      cutoffCreationTime: null,
      dealCurrency: "JOD",
      orgCurrency: "JOD",
    });
    expect(prep.available).toBe(true);
    if (!prep.available) return;
    expect(prep.totalMinor).toBe(100 * SCALE);
    expect(prep.expenses.map((e) => e.id)).toEqual(["showroom"]);
  });
});

describe("recovery receipts", () => {
  test("a receipt posts Dr cash / Cr receivable and a retry under the same key records one receipt", async () => {
    const s = await seed("receipt");
    const { recovery } = await paySupplierCost(s);
    const args = receiptArgs(s, recovery._id);
    const first = await s.as.mutation(api.supplierCostRecoveries.recordReceipt, args);
    const retry = await s.as.mutation(api.supplierCostRecoveries.recordReceipt, args);
    expect(retry.receiptId).toBe(first.receiptId);

    const receipts = await s.t.run((ctx) => ctx.db.query("supplierCostRecoveryReceipts").collect());
    expect(receipts).toHaveLength(1);
    expect(receipts[0].status).toBe("LIVE");
    const after = await s.t.run((ctx) => ctx.db.get(recovery._id));
    expect(after!.amountRecoveredMinor).toBe(80 * SCALE);
    expect(after!.status).toBe("PARTIALLY_RECOVERED");
    const gl = await ledger(s.t, s.orgId);
    expect(gl[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe((SUPPLIER_COST - 80) * SCALE);
  });

  test("the same key with a different payload is refused and records nothing", async () => {
    const s = await seed("fingerprint");
    const { recovery } = await paySupplierCost(s);
    const args = receiptArgs(s, recovery._id);
    await s.as.mutation(api.supplierCostRecoveries.recordReceipt, args);
    await expect(
      s.as.mutation(api.supplierCostRecoveries.recordReceipt, { ...args, amountMinor: 90 * SCALE })
    ).rejects.toThrow();
    const receipts = await s.t.run((ctx) => ctx.db.query("supplierCostRecoveryReceipts").collect());
    expect(receipts).toHaveLength(1);
    const after = await s.t.run((ctx) => ctx.db.get(recovery._id));
    expect(after!.amountRecoveredMinor).toBe(80 * SCALE);
  });

  test("reversing a receipt restores the receivable and the recovery's balance", async () => {
    const s = await seed("reverse");
    const { recovery } = await paySupplierCost(s);
    const { receiptId } = await s.as.mutation(api.supplierCostRecoveries.recordReceipt, receiptArgs(s, recovery._id));
    const result = await s.as.mutation(
      api.supplierCostRecoveries.reverseReceipt,
      reverseArgs(s, receiptId, "Recorded against the wrong car")
    );
    expect(result.amountRecoveredMinor).toBe(0);
    expect(result.status).toBe("OPEN");
    const receipt = await s.t.run((ctx) => ctx.db.get(receiptId));
    expect(receipt!.status).toBe("REVERSED");
    const gl = await ledger(s.t, s.orgId);
    expect(gl[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(SUPPLIER_COST * SCALE);
  });

  test("a receipt against another organization's recovery is refused as not found", async () => {
    const s = await seed("tenantA");
    const { recovery } = await paySupplierCost(s);
    const other = await addOrg(s.t, "tenantB");
    await expect(
      other.as.mutation(api.supplierCostRecoveries.recordReceipt, {
        ...receiptArgs(s, recovery._id), orgId: other.orgId,
      })
    ).rejects.toThrow(/Supplier cost recovery not found/);
    const receipts = await s.t.run((ctx) => ctx.db.query("supplierCostRecoveryReceipts").collect());
    expect(receipts).toHaveLength(0);
  });

  test("the outstanding summary carries the cost recovery and agrees with the ledger", async () => {
    const s = await seed("summary");
    const { recovery } = await paySupplierCost(s);
    await s.as.mutation(api.supplierCostRecoveries.recordReceipt, receiptArgs(s, recovery._id));
    const summary = await s.as.query(api.supplierReceivables.outstandingSummary, { orgId: s.orgId });
    expect(summary.complete).toBe(true);
    expect(summary.costRecoveryOutstanding).toBe(SUPPLIER_COST - 80);
    const gl = await ledger(s.t, s.orgId);
    expect(Math.round(summary.totalOutstanding * SCALE)).toBe(gl[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]);
  });
});

describe("reversing a supplier-borne expense", () => {
  test("is refused while anything is recovered, and allowed once every receipt is reversed", async () => {
    const s = await seed("expreverse");
    const { expenseId, recovery } = await paySupplierCost(s);
    const { receiptId } = await s.as.mutation(api.supplierCostRecoveries.recordReceipt, receiptArgs(s, recovery._id));

    await expect(
      s.as.mutation(api.expenses.reverseExpense, { orgId: s.orgId, expenseId, reason: "Wrong car" })
    ).rejects.toThrow(/Reverse every recovery receipt before reversing the expense/);

    await s.as.mutation(api.supplierCostRecoveries.reverseReceipt, {
      orgId: s.orgId, receiptId, reason: "Undo", idempotencyKey: crypto.randomUUID(),
    });
    await s.as.mutation(api.expenses.reverseExpense, { orgId: s.orgId, expenseId, reason: "Wrong car" });

    const after = await s.t.run((ctx) => ctx.db.get(recovery._id));
    expect(after!.status).toBe("REVERSED");
    const gl = await ledger(s.t, s.orgId);
    expect(gl[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS] ?? 0).toBe(0);
  });
});

describe("SOURCED → STOCK conversion while a recovery is open", () => {
  test("is refused by the direct vehicle edit", async () => {
    const s = await seed("convdirect");
    await paySupplierCost(s);
    await expect(
      s.as.mutation(api.vehicles.update, {
        orgId: s.orgId, vehicleId: s.sourcedId, sourceType: "STOCK",
        purchasePrice: 9_500, purchasePaymentMethod: "CASH",
      } as any)
    ).rejects.toThrow(/The supplier still owes this vehicle's supplier-borne costs/);
  });

  test("is refused when requested, and again when a request made earlier is approved", async () => {
    const s = await seed("convrequest");
    // Filed BEFORE the recovery opened, so only the approval can catch it.
    const earlierRequestId = await s.t.run((ctx) =>
      ctx.db.insert("vehicleEdits", {
        orgId: s.orgId, vehicleId: s.sourcedId, requestedBy: s.userId, type: "UPDATE",
        payload: { sourceType: "STOCK", purchasePrice: 9_500, purchasePaymentMethod: "CASH" },
        status: "PENDING", createdAt: Date.now(),
      } as any)
    );
    await paySupplierCost(s);

    await expect(
      s.as.mutation(api.vehicleEdits.requestUpdate, {
        orgId: s.orgId, vehicleId: s.sourcedId,
        payload: { sourceType: "STOCK", purchasePrice: 9_500, purchasePaymentMethod: "CASH" },
      } as any)
    ).rejects.toThrow(/The supplier still owes this vehicle's supplier-borne costs/);

    await expect(
      s.as.mutation(api.vehicleEdits.resolve, { orgId: s.orgId, requestId: earlierRequestId, status: "APPROVED" })
    ).rejects.toThrow(/The supplier still owes this vehicle's supplier-borne costs/);
    const vehicle = await s.t.run((ctx) => ctx.db.get(s.sourcedId));
    expect(vehicle!.sourceType).toBe("SOURCED");
  });
});

describe("work orders on a SOURCED vehicle", () => {
  const tasks = [{ id: "t1", description: "Brake pads", partsCost: 60, laborCost: 40, completed: true }];

  test("completing one requires an explicit bearer", async () => {
    const s = await seed("wonone");
    await expect(
      s.as.mutation(api.workOrders.create, {
        orgId: s.orgId, vehicleId: s.sourcedId, title: "Brakes", status: "COMPLETED", tasks,
        idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/Choose who bears the work order's cost/);
  });

  test("SUPPLIER is refused in phase 1; SHOWROOM is recorded as such", async () => {
    const s = await seed("wosupplier");
    await expect(
      s.as.mutation(api.workOrders.create, {
        orgId: s.orgId, vehicleId: s.sourcedId, title: "Brakes", status: "COMPLETED", tasks,
        costBearer: "SUPPLIER", idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/A work order cannot be charged to the supplier yet/);

    await s.as.mutation(api.workOrders.create, {
      orgId: s.orgId, vehicleId: s.sourcedId, title: "Brakes", status: "COMPLETED", tasks,
      costBearer: "SHOWROOM", idempotencyKey: crypto.randomUUID(),
    });
    const expenses = await s.t.run((ctx) => ctx.db.query("expenses").collect());
    expect(expenses).toHaveLength(1);
    expect(expenses[0].costBearer).toBe("SHOWROOM");
    const recoveries = await s.t.run((ctx) => ctx.db.query("supplierCostRecoveries").collect());
    expect(recoveries).toHaveLength(0);
  });
});

describe("receipt chronology, cheque payment and reversal after conversion", () => {
  test("SC-389-01: a receipt on a car converted to owned stock cannot be reversed back into an open claim", async () => {
    const s = await seed("sc01");
    const { recovery } = await paySupplierCost(s);
    const { receiptId } = await s.as.mutation(
      api.supplierCostRecoveries.recordReceipt,
      receiptArgs(s, recovery._id, { amountMinor: SUPPLIER_COST * SCALE })
    );
    // Fully recovered: conversion is legitimately allowed (the dealer buys the car).
    await s.as.mutation(api.vehicles.update, {
      orgId: s.orgId, vehicleId: s.sourcedId, sourceType: "STOCK",
      purchasePrice: 9_500, purchasePaymentMethod: "CASH",
    } as any);
    await expect(
      s.as.mutation(api.supplierCostRecoveries.reverseReceipt, reverseArgs(s, receiptId, "Transfer bounced"))
    ).rejects.toThrow(/no longer a sourced vehicle/);
    const after = await s.t.run((ctx) => ctx.db.get(recovery._id));
    expect(after!.status).toBe("RECOVERED");
    const receipt = await s.t.run((ctx) => ctx.db.get(receiptId));
    expect(receipt!.status).toBe("LIVE");
    const gl = await ledger(s.t, s.orgId);
    expect(gl[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS] ?? 0).toBe(0);
  });

  test("SC-389-02: a supplier-borne cost paid by cheque credits the bank, never Cheques in Hand", async () => {
    const s = await seed("sc02");
    await paySupplierCost(s, { paymentMethod: "CHEQUE" });
    const gl = await ledger(s.t, s.orgId);
    expect(gl[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(SUPPLIER_COST * SCALE);
    expect(gl[SYSTEM_KEYS.CHEQUES_IN_HAND] ?? 0).toBe(0);
    expect(gl[SYSTEM_KEYS.BANK_ACCOUNT]).toBe(-SUPPLIER_COST * SCALE);
  });

  test("SC-389-03: a receipt dated before its cost was posted is refused and records nothing", async () => {
    const s = await seed("sc03");
    const { recovery } = await paySupplierCost(s);
    const source = await s.t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_idempotency", (q) => q.eq("orgId", s.orgId).eq("idempotencyKey", recovery.sourceEventKey))
        .unique()
    );
    await expect(
      s.as.mutation(
        api.supplierCostRecoveries.recordReceipt,
        receiptArgs(s, recovery._id, { receivedDate: source!.accountingDate - 1 })
      )
    ).rejects.toThrow(/before the cost it recovers was posted/);
    const receipts = await s.t.run((ctx) => ctx.db.query("supplierCostRecoveryReceipts").collect());
    expect(receipts).toHaveLength(0);
    // Control: the same receipt dated AT the source date is accepted.
    const ok = await s.as.mutation(
      api.supplierCostRecoveries.recordReceipt,
      receiptArgs(s, recovery._id, { receivedDate: source!.accountingDate })
    );
    expect(ok.status).toBe("PARTIALLY_RECOVERED");
  });
});
