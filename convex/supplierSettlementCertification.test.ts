/**
 * SCRUM-869 S1 certification evidence (owner ruling SCRUM-869#c23881): supplier payable payment,
 * consignment margin receipt and cost-recovery receipt are IN the pilot.
 *
 * Every expected figure below is computed by hand from the requirement, in JOD (3 decimals, so
 * 1 JOD = 1,000 minor units), never read back from a run of the code. Control accounts: 2400
 * Accounts Payable - Suppliers (ACCOUNTS_PAYABLE_SUPPLIERS) is credit-normal, so a payment shows as a
 * NET DEBIT; 1240 Receivable from Suppliers (RECEIVABLE_FROM_SUPPLIERS) is debit-normal, so a
 * receipt shows as a NET CREDIT.
 *
 * `convex-test` serializes everything, so concurrency/OCC is NOT proved here; replay idempotency is.
 */
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { seedBank } from "../test-utils/bankFixture";
import { refusalDataOf } from "../test-utils/financedDealFixture";
import {
  insertPayable, insertReceivable, KEYS, ledgerOf, openRecovery, SCALE, seedSupplierDoors, type SupplierDoors,
} from "../test-utils/supplierDoorsFixture";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

async function snapshot(s: SupplierDoors) {
  return dbSnapshot(s.t, Object.keys(schema.tables));
}

/** The call is refused with the given message and leaves the database exactly as it was. */
async function refusesWithoutWrites(s: SupplierDoors, call: () => Promise<unknown>, message: RegExp) {
  const before = await snapshot(s);
  await expect(call()).rejects.toThrow(message);
  expect(await snapshot(s)).toEqual(before);
}

const payArgs = (s: SupplierDoors, payableId: never, over: Record<string, unknown> = {}) =>
  ({ orgId: s.orgId, payableId, amount: 1000, paymentMethod: "CASH", idempotencyKey: crypto.randomUUID(), ...over }) as never;

describe("supplier payable payment (control account 2400)", () => {
  test("8,000 payable: 3,000 then the remaining 5,000 posts Dr 2400 / Cr cash, balanced, status PARTIALLY_PAID then PAID", async () => {
    const s = await seedSupplierDoors("pay1");
    const payableId = await insertPayable(s, 8000);

    await s.as.mutation(api.sourcingPayables.recordPartialPayment, payArgs(s, payableId as never, { amount: 3000 }));
    let row = await s.t.run((ctx) => ctx.db.get(payableId));
    expect(row).toMatchObject({ status: "PARTIALLY_PAID", amountPaid: 3000 });
    let gl = await ledgerOf(s.t, s.orgId);
    expect(gl.net[KEYS.ACCOUNTS_PAYABLE_SUPPLIERS]).toBe(3000 * SCALE); // 3,000.000 JOD debited
    expect(gl.net[KEYS.CASH_ON_HAND]).toBe(-3000 * SCALE);
    expect(gl.unbalancedEntries).toBe(0);

    // remaining = 8,000 - 3,000 = 5,000
    await s.as.mutation(api.sourcingPayables.markPaid, {
      orgId: s.orgId, payableId, paymentMethod: "CASH", idempotencyKey: crypto.randomUUID(),
    });
    row = await s.t.run((ctx) => ctx.db.get(payableId));
    expect(row).toMatchObject({ status: "PAID", amountPaid: 8000 });
    gl = await ledgerOf(s.t, s.orgId);
    expect(gl.net[KEYS.ACCOUNTS_PAYABLE_SUPPLIERS]).toBe(8000 * SCALE);
    expect(gl.net[KEYS.CASH_ON_HAND]).toBe(-8000 * SCALE);
    expect(gl.entryCount).toBe(2);
    expect(gl.unbalancedEntries).toBe(0);
  });

  test("over-application, fractions and a second settlement are refused with nothing written", async () => {
    const s = await seedSupplierDoors("pay2");
    const payableId = await insertPayable(s, 8000);
    await s.as.mutation(api.sourcingPayables.recordPartialPayment, payArgs(s, payableId as never, { amount: 3000 }));
    // 3,000 paid, 5,000 owed: 5,000.001 is 0.001 too much.
    await refusesWithoutWrites(s, () =>
      s.as.mutation(api.sourcingPayables.recordPartialPayment, payArgs(s, payableId as never, { amount: 5000.001 })),
      /That would pay 8000.001 against 8000 owed/);
    // 0.0005 is not representable in JOD (3 decimals); SCRUM-880 refuses it with the coded SUPPLIER_AMOUNT_PRECISION.
    await refusesWithoutWrites(s, () =>
      s.as.mutation(api.sourcingPayables.recordPartialPayment, payArgs(s, payableId as never, { amount: 0.0005 })),
      /SUPPLIER_AMOUNT_PRECISION/);
    await refusesWithoutWrites(s, () =>
      s.as.mutation(api.sourcingPayables.recordPartialPayment, payArgs(s, payableId as never, { amount: 0 })),
      /greater than zero/);
    // Pay the exact remainder, then 0.001 more is refused as already settled.
    await s.as.mutation(api.sourcingPayables.recordPartialPayment, payArgs(s, payableId as never, { amount: 5000 }));
    expect((await s.t.run((ctx) => ctx.db.get(payableId)))?.status).toBe("PAID");
    await refusesWithoutWrites(s, () =>
      s.as.mutation(api.sourcingPayables.recordPartialPayment, payArgs(s, payableId as never, { amount: 0.001 })),
      /already settled in full/);
    await refusesWithoutWrites(s, () =>
      s.as.mutation(api.sourcingPayables.markPaid, {
        orgId: s.orgId, payableId, paymentMethod: "CASH", idempotencyKey: crypto.randomUUID(),
      }),
      /already been marked as paid/);
  });

  test("a bank-funded payment needs an active JOD bank of this organization", async () => {
    const s = await seedSupplierDoors("pay3");
    const payableId = await insertPayable(s, 8000);
    const bank = (over: Record<string, unknown>) =>
      s.as.mutation(api.sourcingPayables.markPaid, {
        orgId: s.orgId, payableId, paymentMethod: "BANK_TRANSFER", idempotencyKey: crypto.randomUUID(), ...over,
      } as never);
    await refusesWithoutWrites(s, () => bank({}), /Choose the bank account/);
    const usdBank = await seedBank(s.t, s.orgId, "USD");
    await refusesWithoutWrites(s, () => bank({ bankAccountId: usdBank }), /./);
    const foreignBank = await seedBank(s.t, s.other.orgId);
    await refusesWithoutWrites(s, () => bank({ bankAccountId: foreignBank }), /not found in this organization/i);
    await refusesWithoutWrites(s, () =>
      s.as.mutation(api.sourcingPayables.markPaid, {
        orgId: s.orgId, payableId, paymentMethod: "CASH", bankAccountId: usdBank, idempotencyKey: crypto.randomUUID(),
      } as never), /only valid for a bank-funded/);
    const bankId = await seedBank(s.t, s.orgId);
    await bank({ bankAccountId: bankId });
    const gl = await ledgerOf(s.t, s.orgId);
    expect(gl.net[KEYS.ACCOUNTS_PAYABLE_SUPPLIERS]).toBe(8000 * SCALE);
    expect(gl.net[KEYS.BANK_ACCOUNT]).toBe(-8000 * SCALE);
    expect(gl.net[KEYS.CASH_ON_HAND] ?? 0).toBe(0);
    expect(gl.unbalancedEntries).toBe(0);
  });

  test("a replay under the same key posts once and audits once", async () => {
    const s = await seedSupplierDoors("pay4");
    const payableId = await insertPayable(s, 8000);
    const args = payArgs(s, payableId as never, { amount: 3000, idempotencyKey: "pay-replay" });
    const first = await s.as.mutation(api.sourcingPayables.recordPartialPayment, args);
    const again = await s.as.mutation(api.sourcingPayables.recordPartialPayment, args);
    expect(again).toEqual(first);
    const gl = await ledgerOf(s.t, s.orgId);
    expect(gl.entryCount).toBe(1);
    expect(gl.net[KEYS.ACCOUNTS_PAYABLE_SUPPLIERS]).toBe(3000 * SCALE);
    expect((await s.t.run((ctx) => ctx.db.get(payableId)))?.amountPaid).toBe(3000);
  });

  test("MANAGE_FINANCE is required; another organization sees the payable as not found", async () => {
    const s = await seedSupplierDoors("pay5");
    const payableId = await insertPayable(s, 8000);
    const before = await snapshot(s);
    for (const call of [
      () => s.viewer.mutation(api.sourcingPayables.recordPartialPayment, payArgs(s, payableId as never)),
      () => s.viewer.mutation(api.sourcingPayables.markPaid, { orgId: s.orgId, payableId, paymentMethod: "CASH", idempotencyKey: "k1" }),
      () => s.viewer.mutation(api.sourcingPayables.setDisputed, { orgId: s.orgId, payableId, disputed: true, reason: "x", idempotencyKey: "k2" }),
    ]) {
      expect((await refusalDataOf(call()))?.code).toBe("FORBIDDEN");
    }
    // The other organization's owner: naming its own org with our payable id, and naming our org.
    await expect(
      s.other.as.mutation(api.sourcingPayables.recordPartialPayment, payArgs(s, payableId as never, { orgId: s.other.orgId }))
    ).rejects.toThrow(/not found/i);
    await expect(
      s.other.as.mutation(api.sourcingPayables.recordPartialPayment, payArgs(s, payableId as never))
    ).rejects.toThrow();
    expect(await snapshot(s)).toEqual(before);
  });

  test("payable payment: a closed period: the subledger moves, the event is QUEUED, and the GL stays empty until the period reopens", async () => {
    // Characterization, not endorsement: the payment is recorded and the posting waits in
    // pendingAccountingEvents (status PENDING). The period-close check refuses to close while the
    // supplier-payables subledger disagrees with the GL, which is the control over this window.
    const s = await seedSupplierDoors("pay6");
    const payableId = await insertPayable(s, 8000);
    await s.t.run((ctx) => ctx.db.patch(s.periodId, { status: "CLOSED" }));
    await s.as.mutation(api.sourcingPayables.recordPartialPayment, payArgs(s, payableId as never, { amount: 3000 }));
    expect(await s.t.run((ctx) => ctx.db.get(payableId))).toMatchObject({ status: "PARTIALLY_PAID", amountPaid: 3000 });
    const queued = await s.t.run((ctx) => ctx.db.query("pendingAccountingEvents").take(10));
    expect(queued.map((q) => [q.eventType, q.status])).toEqual([["SUPPLIER_PAYMENT_SETTLED", "PENDING"]]);
    expect((await ledgerOf(s.t, s.orgId)).entryCount).toBe(0);
  });
});

describe("consignment margin receipt (control account 1240)", () => {
  const receipt = (s: SupplierDoors, receivableId: unknown, over: Record<string, unknown> = {}) =>
    ({ orgId: s.orgId, receivableId, amount: 200, receiptMethod: "CASH", idempotencyKey: crypto.randomUUID(), ...over }) as never;

  test("500 commission: 200 then 300 posts Dr cash / Cr 1240, balanced, PARTIALLY_PAID then PAID; 350 is refused", async () => {
    const s = await seedSupplierDoors("rec1");
    const receivableId = await insertReceivable(s, 500);

    const first = await s.as.mutation(api.supplierReceivables.recordReceipt, receipt(s, receivableId));
    expect(first).toEqual({ amountReceived: 200, remainingAmount: 300, status: "PARTIALLY_PAID" });
    let gl = await ledgerOf(s.t, s.orgId);
    expect(gl.net[KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(-200 * SCALE);
    expect(gl.net[KEYS.CASH_ON_HAND]).toBe(200 * SCALE);

    // 200 + 350 = 550 > 500
    await refusesWithoutWrites(s, () =>
      s.as.mutation(api.supplierReceivables.recordReceipt, receipt(s, receivableId, { amount: 350 })),
      /That would record 550 against 500 owed/);
    await refusesWithoutWrites(s, () =>
      s.as.mutation(api.supplierReceivables.recordReceipt, receipt(s, receivableId, { amount: 0.0005 })),
      /finer than the currency allows/);

    const last = await s.as.mutation(api.supplierReceivables.recordReceipt, receipt(s, receivableId, { amount: 300 }));
    expect(last).toEqual({ amountReceived: 500, remainingAmount: 0, status: "PAID" });
    gl = await ledgerOf(s.t, s.orgId);
    expect(gl.net[KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(-500 * SCALE);
    expect(gl.net[KEYS.CASH_ON_HAND]).toBe(500 * SCALE);
    expect(gl.entryCount).toBe(2);
    expect(gl.unbalancedEntries).toBe(0);
    await refusesWithoutWrites(s, () =>
      s.as.mutation(api.supplierReceivables.recordReceipt, receipt(s, receivableId, { amount: 0.001 })),
      /already settled in full/);
  });

  test("margin receipt: a bank receipt needs an active JOD bank of this organization", async () => {
    const s = await seedSupplierDoors("rec2");
    const receivableId = await insertReceivable(s, 500);
    const bank = (over: Record<string, unknown>) =>
      s.as.mutation(api.supplierReceivables.recordReceipt, receipt(s, receivableId, { amount: 500, receiptMethod: "BANK_TRANSFER", ...over }));
    await refusesWithoutWrites(s, () => bank({}), /Choose the physical bank account/);
    const usdBank = await seedBank(s.t, s.orgId, "USD");
    await refusesWithoutWrites(s, () => bank({ bankAccountId: usdBank }), /./);
    const foreignBank = await seedBank(s.t, s.other.orgId);
    await refusesWithoutWrites(s, () => bank({ bankAccountId: foreignBank }), /not found in this organization/i);
    await bank({ bankAccountId: await seedBank(s.t, s.orgId) });
    const gl = await ledgerOf(s.t, s.orgId);
    expect(gl.net[KEYS.BANK_ACCOUNT]).toBe(500 * SCALE);
    expect(gl.net[KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(-500 * SCALE);
    expect(gl.unbalancedEntries).toBe(0);
  });

  test("margin receipt: a replay under the same key posts once; MANAGE_FINANCE and tenancy are enforced", async () => {
    const s = await seedSupplierDoors("rec3");
    const receivableId = await insertReceivable(s, 500);
    const args = receipt(s, receivableId, { idempotencyKey: "rec-replay" });
    const first = await s.as.mutation(api.supplierReceivables.recordReceipt, args);
    expect(await s.as.mutation(api.supplierReceivables.recordReceipt, args)).toEqual(first);
    const gl = await ledgerOf(s.t, s.orgId);
    expect(gl.entryCount).toBe(1);
    expect(gl.net[KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(-200 * SCALE);

    const before = await snapshot(s);
    expect((await refusalDataOf(s.viewer.mutation(api.supplierReceivables.recordReceipt, receipt(s, receivableId))))?.code).toBe("FORBIDDEN");
    await expect(
      s.other.as.mutation(api.supplierReceivables.recordReceipt, receipt(s, receivableId, { orgId: s.other.orgId }))
    ).rejects.toThrow(/not found/i);
    await expect(s.other.as.mutation(api.supplierReceivables.recordReceipt, receipt(s, receivableId))).rejects.toThrow();
    expect(await snapshot(s)).toEqual(before);
  });

  test("margin receipt: a closed period: the claim moves, the event is QUEUED, and the GL stays empty until the period reopens", async () => {
    const s = await seedSupplierDoors("rec4");
    const receivableId = await insertReceivable(s, 500);
    await s.t.run((ctx) => ctx.db.patch(s.periodId, { status: "CLOSED" }));
    await s.as.mutation(api.supplierReceivables.recordReceipt, receipt(s, receivableId));
    expect((await s.t.run((ctx) => ctx.db.get(receivableId)))?.status).toBe("PARTIALLY_PAID");
    const queued = await s.t.run((ctx) => ctx.db.query("pendingAccountingEvents").take(10));
    expect(queued).toHaveLength(1);
    expect(queued[0].status).toBe("PENDING");
    expect((await ledgerOf(s.t, s.orgId)).entryCount).toBe(0);
  });
});

describe("supplier cost-recovery receipt (control account 1240)", () => {
  const receipt = (s: SupplierDoors, recoveryId: unknown, over: Record<string, unknown> = {}) =>
    ({
      orgId: s.orgId, recoveryId, amountMinor: 80 * SCALE, method: "CASH", receivedDate: Date.now() - 1_000,
      idempotencyKey: crypto.randomUUID(), ...over,
    }) as never;

  test("200 cost: 80 then 120 recovers it; 130 is refused; the receivable ends at zero and every entry balances", async () => {
    const s = await seedSupplierDoors("cr1");
    const { recoveryId } = await openRecovery(s, 200);
    // Paying the 200.000 supplier-borne cost debits 1240 by 200,000 minor.
    expect((await ledgerOf(s.t, s.orgId)).net[KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(200 * SCALE);

    await s.as.mutation(api.supplierCostRecoveries.recordReceipt, receipt(s, recoveryId));
    expect(await s.t.run((ctx) => ctx.db.get(recoveryId))).toMatchObject({ amountRecoveredMinor: 80 * SCALE, status: "PARTIALLY_RECOVERED" });
    expect((await ledgerOf(s.t, s.orgId)).net[KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(120 * SCALE);

    // 80 + 130 = 210 > 200
    await refusesWithoutWrites(s, () =>
      s.as.mutation(api.supplierCostRecoveries.recordReceipt, receipt(s, recoveryId, { amountMinor: 130 * SCALE })),
      /more than the supplier still owes/);

    await s.as.mutation(api.supplierCostRecoveries.recordReceipt, receipt(s, recoveryId, { amountMinor: 120 * SCALE }));
    expect(await s.t.run((ctx) => ctx.db.get(recoveryId))).toMatchObject({ amountRecoveredMinor: 200 * SCALE, status: "RECOVERED" });
    const gl = await ledgerOf(s.t, s.orgId);
    expect(gl.net[KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(0);
    expect(gl.unbalancedEntries).toBe(0);
    await refusesWithoutWrites(s, () =>
      s.as.mutation(api.supplierCostRecoveries.recordReceipt, receipt(s, recoveryId, { amountMinor: 1 })),
      /more than the supplier still owes/);
  });

  test("recovery receipt: a bank receipt needs an active JOD bank of this organization", async () => {
    const s = await seedSupplierDoors("cr2");
    const { recoveryId } = await openRecovery(s, 200);
    const bank = (over: Record<string, unknown>) =>
      s.as.mutation(api.supplierCostRecoveries.recordReceipt, receipt(s, recoveryId, { method: "BANK_TRANSFER", ...over }));
    await refusesWithoutWrites(s, () => bank({}), /bank account/i);
    const usdBank = await seedBank(s.t, s.orgId, "USD");
    await refusesWithoutWrites(s, () => bank({ bankAccountId: usdBank }), /./);
    const foreignBank = await seedBank(s.t, s.other.orgId);
    await refusesWithoutWrites(s, () => bank({ bankAccountId: foreignBank }), /not found in this organization/i);
    await bank({ bankAccountId: await seedBank(s.t, s.orgId) });
    const gl = await ledgerOf(s.t, s.orgId);
    expect(gl.net[KEYS.BANK_ACCOUNT]).toBe(80 * SCALE);
    expect(gl.net[KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(120 * SCALE);
  });

  test("recovery receipt: a replay posts once; MANAGE_FINANCE and tenancy are enforced", async () => {
    const s = await seedSupplierDoors("cr3");
    const { recoveryId } = await openRecovery(s, 200);
    const args = receipt(s, recoveryId, { idempotencyKey: "cr-replay" });
    const first = await s.as.mutation(api.supplierCostRecoveries.recordReceipt, args);
    expect(await s.as.mutation(api.supplierCostRecoveries.recordReceipt, args)).toEqual(first);
    expect((await ledgerOf(s.t, s.orgId)).net[KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(120 * SCALE);

    const before = await snapshot(s);
    expect((await refusalDataOf(s.viewer.mutation(api.supplierCostRecoveries.recordReceipt, receipt(s, recoveryId))))?.code).toBe("FORBIDDEN");
    await expect(
      s.other.as.mutation(api.supplierCostRecoveries.recordReceipt, receipt(s, recoveryId, { orgId: s.other.orgId }))
    ).rejects.toThrow(/not found/i);
    expect(await snapshot(s)).toEqual(before);
  });
});
