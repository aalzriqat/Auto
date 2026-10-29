/**
 * SCRUM-869 S1 / owner ruling SCRUM-869#c23881 (2026-10-29): supplier payable payment, consignment margin
 * receipt and cost-recovery receipt are IN the pilot; no reversal is indispensable, so every reversal,
 * unwind or correction door for them must REFUSE SERVER-SIDE. These tests exercise the shipped doors
 * (no containment mock). The mutation-surface census lives in scripts/supplierSettlementCensus.test.ts.
 */
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import schema from "./schema";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { refusalDataOf } from "../test-utils/financedDealFixture";
import { commonAr, commonEn } from "../lib/i18n/domains/common";
import { seedBank } from "../test-utils/bankFixture";
import { insertReceivable, ledgerOf, KEYS, openRecovery, seedSupplierDoors, SCALE, type SupplierDoors } from "../test-utils/supplierDoorsFixture";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const CODE = "SUPPLIER_RECEIPT_REVERSAL_PILOT_DISABLED";

async function snapshot(s: SupplierDoors) {
  return {
    tables: await dbSnapshot(s.t, Object.keys(schema.tables)),
    scheduled: await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()),
  };
}

async function recoveryWithReceipt() {
  const s = await seedSupplierDoors("contain");
  const { recoveryId } = await openRecovery(s, 200);
  const { receiptId } = await s.as.mutation(api.supplierCostRecoveries.recordReceipt, {
    orgId: s.orgId, recoveryId, amountMinor: 80 * SCALE, method: "CASH",
    receivedDate: Date.now() - 1_000, idempotencyKey: "receipt-1",
  });
  return { s, recoveryId, receiptId };
}

describe("cost-recovery receipt reversal", () => {
  test("refuses with a coded, truthful EN/AR error and changes nothing", async () => {
    const { s, receiptId } = await recoveryWithReceipt();
    const before = await snapshot(s);
    const call = () =>
      s.as.mutation(api.supplierCostRecoveries.reverseReceipt, {
        orgId: s.orgId, receiptId, reason: "Recorded against the wrong car", idempotencyKey: "reverse-1",
      });
    const result = await refusalDataOf(call());
    expect(result?.code, result?.message ?? "reverseReceipt succeeded instead of refusing").toBe(CODE);
    expect(result?.message).toMatch(/pilot/i);
    expect(result?.message).toContain("Nothing has been changed.");
    const english: Record<string, string> = commonEn;
    const arabic: Record<string, string> = commonAr;
    expect(english[`ServerError_${CODE}`]).toBe(result?.message);
    expect(arabic[`ServerError_${CODE}`]).toMatch(/[؀-ۿ]/);
    expect(await snapshot(s)).toEqual(before);
    // A replay of the same intent is refused the same way: the idempotency claim was never written.
    expect((await refusalDataOf(call()))?.code).toBe(CODE);
    expect(await snapshot(s)).toEqual(before);
  });

  test("the receipt stays LIVE and the receivable stays debited after the refusal", async () => {
    const { s, recoveryId, receiptId } = await recoveryWithReceipt();
    await refusalDataOf(
      s.as.mutation(api.supplierCostRecoveries.reverseReceipt, {
        orgId: s.orgId, receiptId, reason: "Undo", idempotencyKey: "reverse-2",
      })
    );
    expect((await s.t.run((ctx) => ctx.db.get(receiptId)))?.status).toBe("LIVE");
    expect((await s.t.run((ctx) => ctx.db.get(recoveryId)))?.amountRecoveredMinor).toBe(80 * SCALE);
    // Hand computed: 200.000 JOD paid out, 80.000 received back => 120.000 JOD still owed by the supplier.
    const gl = await ledgerOf(s.t, s.orgId);
    expect(gl.net[KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(120 * SCALE);
  });

  test("a caller without MANAGE_FINANCE is still FORBIDDEN, not told about the pilot", async () => {
    const { s, receiptId } = await recoveryWithReceipt();
    const result = await refusalDataOf(
      s.viewer.mutation(api.supplierCostRecoveries.reverseReceipt, {
        orgId: s.orgId, receiptId, reason: "Undo", idempotencyKey: "reverse-3",
      })
    );
    expect(result?.code).toBe("FORBIDDEN");
  });

  test("recording a receipt is unaffected by the containment", async () => {
    const { s, recoveryId } = await recoveryWithReceipt();
    await s.as.mutation(api.supplierCostRecoveries.recordReceipt, {
      orgId: s.orgId, recoveryId, amountMinor: 120 * SCALE, method: "CASH",
      receivedDate: Date.now() - 500, idempotencyKey: "receipt-2",
    });
    expect((await s.t.run((ctx) => ctx.db.get(recoveryId)))?.status).toBe("RECOVERED");
  });
});

// SCRUM-869 review finding F1: a cheque posts Dr cheques-in-hand / Cr 1240 but this door creates no
// `postDatedCheques` custody row, so the instrument has no deposit, clearance or bounce lifecycle (ACC-3).
// The pilot accepts CASH and BANK_TRANSFER only, as the cost-recovery door does.
describe("consignment margin receipt method", () => {
  const METHOD_CODE = "SUPPLIER_RECEIPT_METHOD_PILOT_UNSUPPORTED";
  const margin = (s: SupplierDoors, receivableId: unknown, over: Record<string, unknown> = {}) =>
    ({ orgId: s.orgId, receivableId, amount: 200, idempotencyKey: crypto.randomUUID(), ...over }) as never;

  test.each(["CHEQUE", "CARD"] as const)("%s is refused with a coded, truthful EN/AR error and nothing is written", async (receiptMethod) => {
    const s = await seedSupplierDoors(`mm-${receiptMethod}`);
    const receivableId = await insertReceivable(s, 500);
    const bankAccountId = await seedBank(s.t, s.orgId);
    const before = await snapshot(s);
    const call = () =>
      s.as.mutation(api.supplierReceivables.recordReceipt, margin(s, receivableId, {
        receiptMethod, receiptReference: "CHQ-1", idempotencyKey: `margin-${receiptMethod}`,
        ...(receiptMethod === "CARD" ? { bankAccountId } : {}),
      }));
    const result = await refusalDataOf(call());
    expect(result?.code, result?.message ?? `${receiptMethod} receipt succeeded instead of refusing`).toBe(METHOD_CODE);
    expect(result?.message).toMatch(/cash or by bank transfer/i);
    expect(result?.message).toContain("Nothing has been recorded.");
    const english: Record<string, string> = commonEn;
    const arabic: Record<string, string> = commonAr;
    expect(english[`ServerError_${METHOD_CODE}`]).toBe(result?.message);
    expect(arabic[`ServerError_${METHOD_CODE}`]).toMatch(/[؀-ۿ]/);
    // No receipt, no journal, no queued event, no cheque row, and the claim is untouched.
    expect(await snapshot(s)).toEqual(before);
    expect(await s.t.run((ctx) => ctx.db.query("postDatedCheques").take(1))).toEqual([]);
    expect((await ledgerOf(s.t, s.orgId)).entryCount).toBe(0);
    // A replay of the same intent is refused the same way: the idempotency claim was never written.
    expect((await refusalDataOf(call()))?.code).toBe(METHOD_CODE);
    expect(await snapshot(s)).toEqual(before);
  });

  test("CASH, BANK_TRANSFER and an omitted method (CASH) still record the receipt", async () => {
    const s = await seedSupplierDoors("mm-ok");
    const receivableId = await insertReceivable(s, 600);
    const bankAccountId = await seedBank(s.t, s.orgId);
    await s.as.mutation(api.supplierReceivables.recordReceipt, margin(s, receivableId, { receiptMethod: "CASH" }));
    await s.as.mutation(api.supplierReceivables.recordReceipt, margin(s, receivableId, { receiptMethod: "BANK_TRANSFER", bankAccountId }));
    await s.as.mutation(api.supplierReceivables.recordReceipt, margin(s, receivableId));
    // Hand computed: 600 owed, 200 + 200 + 200 received => PAID, 1240 credited 600.000 JOD.
    expect((await s.t.run((ctx) => ctx.db.get(receivableId)))?.status).toBe("PAID");
    const gl = await ledgerOf(s.t, s.orgId);
    expect(gl.net[KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(-600 * SCALE);
    expect(gl.net[KEYS.CHEQUES_IN_HAND] ?? 0).toBe(0);
  });

  test("a caller without MANAGE_FINANCE is FORBIDDEN, not told about the method rule", async () => {
    const s = await seedSupplierDoors("mm-perm");
    const receivableId = await insertReceivable(s, 500);
    const result = await refusalDataOf(
      s.viewer.mutation(api.supplierReceivables.recordReceipt, margin(s, receivableId, { receiptMethod: "CHEQUE" }))
    );
    expect(result?.code).toBe("FORBIDDEN");
  });
});

