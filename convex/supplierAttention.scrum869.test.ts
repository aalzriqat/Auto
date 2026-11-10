/**
 * SCRUM-869 feature 5 - the supplier "needs attention" view (ADR docs/adr/2026-11-10-supplier-attention-port.md).
 * Read-only. Evidence boundary: convex-test only, seeded rows. 9,500 JOD is 9_500_000 minor units.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id, Doc } from "./_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { unlinkedPresence } from "./utils/supplierAttention";
import { attention as attentionQuery } from "./supplierStatement";

const MODULES = import.meta.glob("./**/*.*s");
const DAY = 86_400_000;
const NOW = Date.parse("2026-06-15T09:00:00Z");

afterEach(() => {
  vi.useRealTimers();
});

type SupplierDb = Pick<import("./_generated/server").MutationCtx, "db">;
const insertSupplier = (ctx: SupplierDb, orgId: Id<"organizations">, userId: Id<"users">, displayName: string) =>
  ctx.db.insert("suppliers", {
    orgId, displayName, displayNameKey: displayName.toLowerCase(), status: "ACTIVE", origin: "MANUAL", version: 1,
    createdBy: userId, updatedBy: userId, createdAt: NOW, updatedAt: NOW,
  });

async function seed(tag: string, permissions: string[] = ["view:finance", "view:cost_price"], transactionLimits = false) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const t = convexTestWithComponents(schema, MODULES, { transactionLimits });
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `AT ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "AT User" }));
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
  const supplierId = await t.run((ctx) => insertSupplier(ctx, orgId, userId, "Amman Importer Co"));
  return { t, orgId, userId, asUser, customerId, vehicleId, supplierId };
}
type Seed = Awaited<ReturnType<typeof seed>>;

const addPayable = (s: Seed, fields: Partial<Omit<Extract<Doc<"vehicleSupplierPayables">, { vehicleId: Id<"vehicles"> }>, "_id" | "_creationTime">> = {}) =>
  s.t.run((ctx) =>
    ctx.db.insert("vehicleSupplierPayables", {
      orgId: s.orgId, vehicleId: s.vehicleId, supplierId: s.supplierId, sourcedFromName: "Amman Importer Co", amountDue: 9_500,
      currency: "JOD", status: "DUE_ON_SALE", paymentDueDate: NOW - 10 * DAY, createdBy: s.userId, createdAt: NOW, updatedAt: NOW,
      ...fields,
    })
  );

const addReceivable = async (s: Seed, fields: Partial<Omit<Doc<"vehicleSupplierReceivables">, "_id" | "_creationTime">> = {}) => {
  const saleId = await s.t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId, salespersonId: s.userId,
      salePrice: 12_500, saleDate: NOW - 40 * DAY, status: "COMPLETED",
    })
  );
  return await s.t.run((ctx) =>
    ctx.db.insert("vehicleSupplierReceivables", {
      orgId: s.orgId, vehicleId: s.vehicleId, saleId, supplierId: s.supplierId, sourcedFromName: "Amman Importer Co",
      amountDue: 3_000, currency: "JOD", status: "OPEN", agreedDueDate: NOW + 5 * DAY, createdBy: s.userId,
      createdAt: NOW, updatedAt: NOW, ...fields,
    })
  );
};

const attention = async (s: Seed, extra: Partial<{ supplierId: Id<"suppliers">; orgId: Id<"organizations">; kind: "PAYABLE" | "RECEIVABLE" | "RECOVERY"; nowMs: number; paginationOpts: { numItems: number; cursor: string | null; maximumRowsRead?: number; endCursor?: string } }> = {}) =>
  {
  const result = await s.asUser.query(api.supplierStatement.attention, { orgId: s.orgId, supplierId: s.supplierId, kind: "PAYABLE", nowMs: Date.now(), paginationOpts: { numItems: 25, cursor: null }, ...extra });
  if (result === null) return null;
  return { ...result, unlinked: await s.asUser.query(api.supplierStatement.unlinkedAttention, { orgId: extra.orgId ?? s.orgId, kind: extra.kind ?? "PAYABLE" }) };
};

describe("SCRUM-869 supplier attention port", () => {
  test("page order reuses each completed sale read before starting the next row", async () => {
    const s = await seed("sequential-cache", undefined, true);
    const sale = () => s.t.run(ctx => ctx.db.insert("sales", { orgId: s.orgId, vehicleId: s.vehicleId,
      customerId: s.customerId, salespersonId: s.userId, salePrice: 12500, saleDate: NOW, status: "COMPLETED" }));
    const firstSale = await sale();
    const nextSale = await sale();
    const first = await addPayable(s, { saleId: firstSale });
    const second = await addPayable(s, { saleId: firstSale });
    const third = await addPayable(s, { saleId: nextSale });
    const registered: unknown = attentionQuery;
    if (typeof registered !== "function" || !("_handler" in registered) || typeof registered._handler !== "function") throw new Error("Registered handler unavailable");
    const handler = registered._handler;
    await s.asUser.run(async ctx => {
      const reads = vi.spyOn(ctx.db, "get"); // Call-through: the public handler still performs every harness database read.
      try {
        const response: FunctionReturnType<typeof api.supplierStatement.attention> = await handler(ctx, { orgId: s.orgId, supplierId: s.supplierId, kind: "PAYABLE", nowMs: NOW, paginationOpts: { numItems: 25, cursor: null } });
        expect(response?.page.map(row => row.id)).toEqual([first, second, third]);
        expect(reads.mock.calls.map(([id]) => id).filter(id => id === firstSale || id === nextSale)).toEqual([firstSale, nextSale]);
      } finally { reads.mockRestore(); }
    });
  });

  test("linked payable alerts with its authoritative amount and no aggregate fields", async () => {
    const s = await seed("linked");
    const id = await addPayable(s);
    const result = await attention(s);
    expect(result?.page).toEqual([{ kind: "PAYABLE", id, currency: "JOD", outstandingMinor: 9_500_000, disputedMinor: 0,
      dueDate: "2026-06-05", daysOverdue: 10, status: "ALERTING", step: "OVERDUE_7" }]);
    expect(result).toEqual({ page: result?.page, complete: true, isDone: true, continueCursor: expect.any(String),
      pageStatus: null, splitCursor: null, asOfDate: "2026-06-15", unlinked: "NONE" });
    expect(await s.t.run(ctx => ctx.db.query("notifications").collect())).toEqual([]);
  });

  test("same-name supplier and id-less legacy rows never enter the account", async () => {
    const s = await seed("identity");
    const other = await s.t.run(ctx => insertSupplier(ctx, s.orgId, s.userId, "Amman Importer Co"));
    const linked = await addPayable(s);
    await addPayable(s, { supplierId: other });
    await addPayable(s, { supplierId: undefined });
    const result = await attention(s);
    expect(result?.page.map(row => row.id)).toEqual([linked]);
    expect(result?.unlinked).toBe("PRESENT");
  });

  async function heldObligation(status: Doc<"vehicleSupplierPayables">["status"], paymentDueDate: number | undefined, heldReason: string, disputedMinor: number) {
    const s = await seed(`held-${status}`);
    const id = await addPayable(s, { status, paymentDueDate });
    const result = await attention(s);
    expect(result?.page).toEqual([{ kind: "PAYABLE", id, currency: "JOD", outstandingMinor: 9_500_000, disputedMinor,
      dueDate: paymentDueDate ? "2026-06-14" : null, daysOverdue: paymentDueDate ? 1 : null, status: "HELD", heldReason }]);
  }
  test("disputed obligation is held rather than silently healthy", () => heldObligation("DISPUTED", NOW - DAY, "DISPUTED", 9_500_000));
  test("undated obligation is held rather than silently healthy", () => heldObligation("PENDING", undefined, "NO_DUE_DATE", 0));


  test("supplier receivable is due while a later receivable is not yet eligible", async () => {
    const s = await seed("ar");
    const id = await addReceivable(s, { agreedDueDate: NOW + DAY });
    await addReceivable(s);
    const result = await attention(s, { kind: "RECEIVABLE" });
    expect(result?.page).toEqual([{ kind: "RECEIVABLE", id, currency: "JOD", outstandingMinor: 3_000_000,
      disputedMinor: 0, dueDate: "2026-06-16", daysOverdue: -1, status: "ALERTING", step: "T_MINUS_3" }]);
  });

  test("cost recovery uses the same reminder decision without fabricating a payable", async () => {
    const s = await seed("recovery");
    const expenseId = await s.t.run(ctx => ctx.db.insert("expenses", { orgId: s.orgId, title: "Transport", amount: 200, date: NOW, category: "TRANSPORT", status: "PAID" }));
    const id = await s.t.run(ctx => ctx.db.insert("supplierCostRecoveries", {
      orgId: s.orgId, supplierId: s.supplierId, sourcedFromName: "Amman Importer Co", vehicleId: s.vehicleId,
      expenseId, sourceEventKey: "RECOVERY_1", amountDueMinor: 200_000, amountRecoveredMinor: 50_000,
      currency: "JOD", status: "PARTIALLY_RECOVERED", receiptSeq: 1, agreedDueDate: NOW, createdBy: s.userId, createdAt: NOW, updatedAt: NOW,
    }));
    expect((await attention(s, { kind: "RECOVERY" }))?.page).toEqual([{ kind: "RECOVERY", id, currency: "JOD",
      outstandingMinor: 150_000, disputedMinor: 0, dueDate: "2026-06-15", daysOverdue: 0, status: "ALERTING", step: "DUE_DAY" }]);
    expect((await attention(s))?.page).toEqual([]);
  });

  async function permissionWithheld({ permissions }: { permissions: string[] }) {
    const s = await seed(`gate-${permissions.join()}`, permissions);
    await addPayable(s);
    await addPayable(s, { supplierId: undefined });
    expect(await attention(s)).toBeNull();
  }
  test("no finance or cost permission withholds the whole response", () => permissionWithheld({ permissions: [] }));
  test("finance-only access withholds the whole response", () => permissionWithheld({ permissions: ["view:finance"] }));
  test("cost-only access withholds the whole response", () => permissionWithheld({ permissions: ["view:cost_price"] }));


  test("foreign supplier and foreign organisation refuse without data", async () => {
    const s = await seed("tenant");
    const foreign = await s.t.run(async ctx => {
      const orgId = await ctx.db.insert("organizations", { name: "Other", createdAt: NOW });
      return { orgId, supplierId: await insertSupplier(ctx, orgId, s.userId, "Amman Importer Co") };
    });
    await expect(attention(s, { supplierId: foreign.supplierId })).rejects.toThrow(/SUPPLIER_ATTENTION_UNAVAILABLE/);
    await expect(attention(s, foreign)).rejects.toThrow(/UNAUTHORIZED/);
  });

  test("page boundary is incomplete with no partial count and continuation reaches remaining rows", async () => {
    const s = await seed("page");
    const first = await addPayable(s);
    const second = await addPayable(s);
    const result = await attention(s, { paginationOpts: { numItems: 1, cursor: null } });
    expect(result?.complete).toBe(false);
    expect(result?.isDone).toBe(false);
    expect(result?.page.map(row => row.id)).toEqual([first]);
    const next = await attention(s, { paginationOpts: { numItems: 1, cursor: result?.continueCursor ?? null } });
    expect(next?.page.map(row => row.id)).toEqual([second]);
    expect(next?.complete).toBe(false);
    expect(next?.isDone).toBe(true);
  });

  test("settled-only filtered page stays incomplete until the linked open row is reached", async () => {
    const s = await seed("history");
    await addPayable(s, { status: "CANCELLED" });
    const id = await addPayable(s);
    const first = await attention(s, { paginationOpts: { numItems: 1, cursor: null } });
    expect(first?.page).toEqual([]);
    expect(first?.complete).toBe(false);
    const next = await attention(s, { paginationOpts: { numItems: 1, cursor: first?.continueCursor ?? null } });
    expect(next?.page.map(row => row.id)).toEqual([id]);
  });

  test("Amman midnight changes overdue day using the validated caller time", async () => {
    const s = await seed("midnight");
    const due = Date.parse("2026-06-14T21:00:00Z");
    await addPayable(s, { paymentDueDate: due });
    vi.setSystemTime(Date.parse("2026-06-15T20:59:59Z"));
    expect((await attention(s))?.page[0]).toMatchObject({ daysOverdue: 0, step: "DUE_DAY" });
    vi.setSystemTime(Date.parse("2026-06-15T21:00:00Z"));
    expect((await attention(s))?.page[0]).toMatchObject({ daysOverdue: 1, step: "DUE_DAY" });
    expect((await attention(s))?.asOfDate).toBe("2026-06-16");
  });

  test("validated caller time controls cached eligibility and invalid clocks refuse", async () => {
    const s = await seed("caller-time");
    await addPayable(s, { paymentDueDate: Date.parse("2026-06-14T21:00:00Z") });
    vi.setSystemTime(Date.parse("2026-06-15T21:00:00Z"));
    const result = await attention(s, { nowMs: NOW });
    expect(result?.page[0]).toMatchObject({ daysOverdue: 0, step: "DUE_DAY" });
    expect(result?.asOfDate).toBe("2026-06-15");
    for (const nowMs of [Number.NaN, Infinity, NOW + 0.5, Date.now() - DAY - 1, Date.now() + DAY + 1]) {
      await expect(attention(s, { nowMs })).rejects.toThrow(/SUPPLIER_STATEMENT_INVALID_TIME/);
    }
  });

  test("ordinary id-less opening creditors are excluded from unresolved supplier warnings", async () => {
    const s = await seed("creditor");
    await s.t.run(async ctx => {
      const openingBalanceDraftId = await ctx.db.insert("openingBalanceDrafts", { orgId: s.orgId, status: "PENDING_APPROVAL", lines: [], asOfDate: NOW, createdBy: s.userId, createdAt: NOW });
      await ctx.db.insert("vehicleSupplierPayables", { orgId: s.orgId, sourcedFromName: "Ordinary creditor", amountDue: 20, currency: "JOD",
        status: "PENDING", origin: "OPENING", openingBalanceDraftId, openingRowKey: "OTHER_1", openingKind: "OTHER_PAYABLE", title: "Historical creditor", createdBy: s.userId, createdAt: NOW, updatedAt: NOW });
    });
    expect((await attention(s))?.unlinked).toBe("NONE");
  });

  test("unreadable stored due fact is a coded generic error rather than a silent omission", async () => {
    const s = await seed("bad-fact");
    await addPayable(s, { paymentDueDate: Number.NaN });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(attention(s)).rejects.toThrow(/SUPPLIER_ATTENTION_UNAVAILABLE/);
      expect(log).toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  test("caller cannot widen the fifty-document page bound", async () => {
    const s = await seed("hard-bound");
    for (let i = 0; i < 51; i += 1) await addPayable(s);
    const result = await attention(s, { paginationOpts: { numItems: 1000000, maximumRowsRead: 1000000, cursor: null } });
    expect(result?.page).toEqual([]);
    expect(result?.incompleteReason).toBe("SPLIT_REQUIRED");
    expect(result?.splitCursor).toEqual(expect.any(String));
    expect(result?.complete).toBe(false);
    expect(result?.isDone).toBe(false);
  });

  test("accounting plan denial refuses before reading obligation figures", async () => {
    const s = await seed("plan");
    await addPayable(s);
    await s.t.run(async ctx => {
      const subscription = await ctx.db.query("subscriptions").withIndex("by_org", q => q.eq("orgId", s.orgId)).unique();
      if (!subscription) throw new Error("Fixture subscription missing");
      await ctx.db.patch(subscription._id, { plan: "starter" });
    });
    await expect(attention(s)).rejects.toThrow();
  });

  test("large joined sale documents withhold figures as incomplete without advancing the cursor", async () => {
    const s = await seed("join-budget", undefined, true);
    for (let i = 0; i < 20; i += 1) {
      const saleId = await s.t.run(ctx => ctx.db.insert("sales", { orgId: s.orgId, vehicleId: s.vehicleId,
        customerId: s.customerId, salespersonId: s.userId, salePrice: 12500, saleDate: NOW, status: "COMPLETED", commissionPaymentIdempotencyKey: "k".repeat(900_000) }));
      await addPayable(s, { saleId });
    }
    const result = await attention(s);
    expect(result).toEqual({ page: [], complete: false, isDone: false, continueCursor: "", pageStatus: null,
      splitCursor: null, asOfDate: "2026-06-15", unlinked: "NONE", incompleteReason: "READ_BUDGET" });
  });

  test("malformed recovery money is refused by the backend rather than marked complete", async () => {
    const s = await seed("bad-recovery");
    const expenseId = await s.t.run(ctx => ctx.db.insert("expenses", { orgId: s.orgId, title: "Transport", amount: 200, date: NOW, category: "TRANSPORT", status: "PAID" }));
    const id = await s.t.run(ctx => ctx.db.insert("supplierCostRecoveries", { orgId: s.orgId, supplierId: s.supplierId,
      sourcedFromName: "Supplier", vehicleId: s.vehicleId, expenseId, sourceEventKey: "RECOVERY_1", amountDueMinor: 200_000,
      amountRecoveredMinor: 0, currency: "JOD", status: "OPEN", receiptSeq: 0, agreedDueDate: NOW, createdBy: s.userId, createdAt: NOW, updatedAt: NOW }));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      for (const change of [{ amountDueMinor: Number.NaN }, { amountDueMinor: Infinity }, { amountDueMinor: 200_000.5 },
        { amountDueMinor: Number.MAX_SAFE_INTEGER + 1, amountRecoveredMinor: Number.MAX_SAFE_INTEGER }, { amountDueMinor: 200_000, amountRecoveredMinor: 0, currency: "NOT_CURRENCY" }]) {
        await s.t.run(ctx => ctx.db.patch(id, change));
        await expect(attention(s, { kind: "RECOVERY" })).rejects.toThrow(/SUPPLIER_ATTENTION_UNAVAILABLE/);
      }
    } finally { log.mockRestore(); }
  });

  test("required native page split withholds figures and preserves the current cursor", async () => {
    const s = await seed("split");
    await addPayable(s); await addPayable(s);
    const result = await attention(s, { paginationOpts: { numItems: 25, maximumRowsRead: 1, cursor: null } });
    expect(result?.pageStatus).toBe("SplitRequired");
    expect(result?.page).toEqual([]);
    expect(result?.complete).toBe(false);
    expect(result?.continueCursor).toBe("");
    expect(result?.incompleteReason).toBe("SPLIT_REQUIRED");
  });
});


describe("organisation-wide unlinked attention access", () => {
  test("presence stops reading after the first qualifying document", async () => {
    const s = await seed("presence-io", undefined, true);
    for (let i = 0; i < 51; i += 1) await addPayable(s, { supplierId: undefined });
    const result = await s.t.run(async ctx => {
      const before = await ctx.meta.getTransactionMetrics();
      const presence = await unlinkedPresence(ctx, s.orgId, "PAYABLE");
      const after = await ctx.meta.getTransactionMetrics();
      return { presence, documentsRead: after.documentsRead.used - before.documentsRead.used,
        documentsWritten: after.documentsWritten.used - before.documentsWritten.used };
    });
    expect(result).toEqual({ presence: "PRESENT", documentsRead: 1, documentsWritten: 0 });
  });

  async function presenceWithheld(permissions: string[]) {
    const s = await seed("presence-denied", permissions);
    await addPayable(s, { supplierId: undefined });
    expect(await s.asUser.query(api.supplierStatement.unlinkedAttention, { orgId: s.orgId, kind: "PAYABLE" })).toBeNull();
  }
  test("withholds presence without finance", () => presenceWithheld(["view:cost_price"]));
  test("withholds presence without cost", () => presenceWithheld(["view:finance"]));
  test("refuses presence without accounting plan", async () => {
    const s = await seed("presence-plan");
    await s.t.run(async ctx => {
      const subscription = await ctx.db.query("subscriptions").withIndex("by_org", q => q.eq("orgId", s.orgId)).unique();
      if (!subscription) throw new Error("Fixture subscription missing");
      await ctx.db.patch(subscription._id, { plan: "starter" });
    });
    await expect(s.asUser.query(api.supplierStatement.unlinkedAttention, { orgId: s.orgId, kind: "PAYABLE" })).rejects.toThrow();
  });
  test("refuses foreign organisation presence", async () => {
    const s = await seed("presence-tenant");
    const orgId = await s.t.run(ctx => ctx.db.insert("organizations", { name: "Other", createdAt: NOW }));
    await expect(s.asUser.query(api.supplierStatement.unlinkedAttention, { orgId, kind: "PAYABLE" })).rejects.toThrow(/UNAUTHORIZED/);
  });
  test("attention subscriptions return no organisation-wide presence field", async () => {
    const s = await seed("presence-independent");
    await addPayable(s, { supplierId: undefined });
    const result = await s.asUser.query(api.supplierStatement.attention, { orgId: s.orgId, supplierId: s.supplierId, kind: "PAYABLE", nowMs: NOW, paginationOpts: { numItems: 25, cursor: null } });
    expect(result).not.toHaveProperty("unlinked");
    expect(await s.asUser.query(api.supplierStatement.unlinkedAttention, { orgId: s.orgId, kind: "PAYABLE" })).toBe("PRESENT");
  });
});
