/**
 * SCRUM-869 S1: audit entries, idempotent disputes and completeness flags on the supplier settlement
 * doors. Owner ruling SCRUM-869#c23881. No amount and no posting changes in this slice; the money
 * figures are certified in supplierSettlementCertification.test.ts.
 */
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { insertPayable, insertReceivable, seedSupplierDoors, type SupplierDoors } from "../test-utils/supplierDoorsFixture";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

async function auditFor(s: SupplierDoors, resourceId: Id<"vehicleSupplierPayables"> | Id<"vehicleSupplierReceivables">) {
  const rows = await s.t.run((ctx) => ctx.db.query("financialAuditLog").collect());
  return rows.filter((r) => String(r.resourceId) === String(resourceId));
}

describe("payable payment audit", () => {
  test("markPaid writes one ALLOCATE_PAYMENT entry carrying the key, before and after", async () => {
    const s = await seedSupplierDoors("aud1");
    const payableId = await insertPayable(s, 8000);
    await s.as.mutation(api.sourcingPayables.markPaid, {
      orgId: s.orgId, payableId, paymentMethod: "CASH", idempotencyKey: "pay-full",
    });
    const rows = await auditFor(s, payableId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actionType: "ALLOCATE_PAYMENT", resourceType: "vehicleSupplierPayables", idempotencyKey: "pay-full",
      before: { amountPaid: 0, status: "PENDING" }, after: { amountPaid: 8000, status: "PAID" },
    });
  });

  test("recordPartialPayment writes one entry; a replay under the same key writes no second one", async () => {
    const s = await seedSupplierDoors("aud2");
    const payableId = await insertPayable(s, 8000);
    const args = { orgId: s.orgId, payableId, amount: 3000, paymentMethod: "CASH" as const, idempotencyKey: "pay-part" };
    await s.as.mutation(api.sourcingPayables.recordPartialPayment, args);
    await s.as.mutation(api.sourcingPayables.recordPartialPayment, args);
    const rows = await auditFor(s, payableId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actionType: "ALLOCATE_PAYMENT", idempotencyKey: "pay-part",
      before: { amountPaid: 0, status: "PENDING" }, after: { amountPaid: 3000, status: "PARTIALLY_PAID" },
    });
  });
});

describe("payable dispute", () => {
  test("payable dispute is audited, replays as a no-op, and a changed payload under the same key is refused", async () => {
    const s = await seedSupplierDoors("dis1");
    const payableId = await insertPayable(s, 8000);
    const base = { orgId: s.orgId, payableId };
    await s.as.mutation(api.sourcingPayables.setDisputed, { ...base, disputed: true, reason: "Wrong price", idempotencyKey: "d-1" });
    await s.as.mutation(api.sourcingPayables.setDisputed, { ...base, disputed: false, idempotencyKey: "d-2" });
    expect((await s.t.run((ctx) => ctx.db.get(payableId)))?.status).toBe("DUE_ON_SALE");
    // Replaying the first intent must NOT re-open the dispute that d-2 lifted.
    await s.as.mutation(api.sourcingPayables.setDisputed, { ...base, disputed: true, reason: "Wrong price", idempotencyKey: "d-1" });
    expect((await s.t.run((ctx) => ctx.db.get(payableId)))?.status).toBe("DUE_ON_SALE");
    expect(await auditFor(s, payableId)).toHaveLength(2);
    expect((await auditFor(s, payableId))[0]).toMatchObject({ actionType: "SET_SUPPLIER_DISPUTE" });
    await expect(
      s.as.mutation(api.sourcingPayables.setDisputed, { ...base, disputed: true, reason: "A different reason", idempotencyKey: "d-1" })
    ).rejects.toThrow(/Idempotency key reused with different request content/);
  });

  test("payable dispute: the same key with the opposite direction is refused, not replayed", async () => {
    const s = await seedSupplierDoors("dis5");
    const payableId = await insertPayable(s, 8000);
    await s.as.mutation(api.sourcingPayables.setDisputed, { orgId: s.orgId, payableId, disputed: true, reason: "Wrong price", idempotencyKey: "d-x" });
    await expect(
      s.as.mutation(api.sourcingPayables.setDisputed, { orgId: s.orgId, payableId, disputed: false, reason: "Wrong price", idempotencyKey: "d-x" })
    ).rejects.toThrow(/Idempotency key reused with different request content/);
    expect((await s.t.run((ctx) => ctx.db.get(payableId)))?.status).toBe("DISPUTED");
  });

  test("payable dispute: a request with no idempotency key is rejected", async () => {
    const s = await seedSupplierDoors("dis2");
    const payableId = await insertPayable(s, 8000);
    await expect(
      s.as.mutation(api.sourcingPayables.setDisputed, { orgId: s.orgId, payableId, disputed: true, reason: "x" } as never)
    ).rejects.toThrow();
    expect((await s.t.run((ctx) => ctx.db.get(payableId)))?.status).toBe("PENDING");
  });
});

describe("receivable dispute", () => {
  test("receivable dispute is audited, replays as a no-op, and a changed payload under the same key is refused", async () => {
    const s = await seedSupplierDoors("dis3");
    const receivableId = await insertReceivable(s, 500);
    const base = { orgId: s.orgId, receivableId };
    await s.as.mutation(api.supplierReceivables.setDisputed, { ...base, disputed: true, reason: "Margin disagreed", idempotencyKey: "r-1" });
    await s.as.mutation(api.supplierReceivables.setDisputed, { ...base, disputed: false, idempotencyKey: "r-2" });
    expect((await s.t.run((ctx) => ctx.db.get(receivableId)))?.status).toBe("OPEN");
    await s.as.mutation(api.supplierReceivables.setDisputed, { ...base, disputed: true, reason: "Margin disagreed", idempotencyKey: "r-1" });
    expect((await s.t.run((ctx) => ctx.db.get(receivableId)))?.status).toBe("OPEN");
    const rows = await auditFor(s, receivableId);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ actionType: "SET_SUPPLIER_DISPUTE", resourceType: "vehicleSupplierReceivables" });
    await expect(
      s.as.mutation(api.supplierReceivables.setDisputed, { ...base, disputed: true, reason: "Another reason", idempotencyKey: "r-1" })
    ).rejects.toThrow(/Idempotency key reused with different request content/);
  });

  test("receivable dispute: the same key with the opposite direction is refused, not replayed", async () => {
    const s = await seedSupplierDoors("dis6");
    const receivableId = await insertReceivable(s, 500);
    await s.as.mutation(api.supplierReceivables.setDisputed, { orgId: s.orgId, receivableId, disputed: true, reason: "Margin disagreed", idempotencyKey: "r-x" });
    await expect(
      s.as.mutation(api.supplierReceivables.setDisputed, { orgId: s.orgId, receivableId, disputed: false, reason: "Margin disagreed", idempotencyKey: "r-x" })
    ).rejects.toThrow(/Idempotency key reused with different request content/);
    expect((await s.t.run((ctx) => ctx.db.get(receivableId)))?.status).toBe("DISPUTED");
  });

  test("receivable dispute: a request with no idempotency key is rejected", async () => {
    const s = await seedSupplierDoors("dis4");
    const receivableId = await insertReceivable(s, 500);
    await expect(
      s.as.mutation(api.supplierReceivables.setDisputed, { orgId: s.orgId, receivableId, disputed: true, reason: "x" } as never)
    ).rejects.toThrow();
    expect((await s.t.run((ctx) => ctx.db.get(receivableId)))?.status).toBe("OPEN");
  });
});

describe("completeness flags", () => {
  test("supplierReceivables.list says whether it returned every row", async () => {
    const s = await seedSupplierDoors("cmp1");
    for (let i = 0; i < 3; i++) await insertReceivable(s, 100 + i);
    const small = await s.as.query(api.supplierReceivables.list, { orgId: s.orgId });
    expect(small).toMatchObject({ complete: true });
    expect(small.items).toHaveLength(3);
    for (let i = 0; i < 497; i++) await insertReceivable(s, 1);
    const exact = await s.as.query(api.supplierReceivables.list, { orgId: s.orgId });
    expect(exact.items).toHaveLength(500); // exactly 500 rows exist: all returned, complete
    expect(exact.complete).toBe(true);
    await insertReceivable(s, 1);
    const over = await s.as.query(api.supplierReceivables.list, { orgId: s.orgId });
    expect(over.items).toHaveLength(500);
    expect(over.complete).toBe(false);
  }, 60_000);

  test("sourcingPayables.listBounded says whether it returned every row; list keeps its array shape", async () => {
    const s = await seedSupplierDoors("cmp2");
    for (let i = 0; i < 3; i++) await insertPayable(s, 100 + i);
    const small = await s.as.query(api.sourcingPayables.listBounded, { orgId: s.orgId });
    expect(small.complete).toBe(true);
    expect(small.items).toHaveLength(3);
    expect(Array.isArray(await s.as.query(api.sourcingPayables.list, { orgId: s.orgId }))).toBe(true);
    for (let i = 0; i < 497; i++) await insertPayable(s, 1);
    expect((await s.as.query(api.sourcingPayables.listBounded, { orgId: s.orgId })).complete).toBe(true);
    await insertPayable(s, 1);
    const over = await s.as.query(api.sourcingPayables.listBounded, { orgId: s.orgId });
    expect(over.items).toHaveLength(500);
    expect(over.complete).toBe(false);
  }, 60_000);

  test("listBounded needs view:finance and stays inside the tenant", async () => {
    const s = await seedSupplierDoors("cmp3");
    await insertPayable(s, 100);
    expect((await s.viewer.query(api.sourcingPayables.listBounded, { orgId: s.orgId })).items).toHaveLength(1);
    await expect(s.other.as.query(api.sourcingPayables.listBounded, { orgId: s.orgId })).rejects.toThrow();
    expect((await s.other.as.query(api.sourcingPayables.listBounded, { orgId: s.other.orgId })).items).toHaveLength(0);
  });
});
