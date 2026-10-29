/**
 * SCRUM-869 S1b / owner ruling SCRUM-869#c23881 (2026-10-29): no reversal is indispensable for the
 * supplier settlement flows, so every door that rewrites or closes a supplier obligation refuses
 * SERVER-SIDE during the pilot. Two correction paths were found open:
 *   - vehicles.correctAcquisitionCost rewrote an unpaid ON_ACCOUNT supplier payable's amountDue;
 *   - expenses.reverseExpense reversed a supplier-borne expense and closed its cost recovery.
 * These tests use the shipped switches (no containment mock) and compare every application table and
 * the scheduler before and after each refusal. Controls prove the rest of each function still works.
 */
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { refusalDataOf } from "../test-utils/financedDealFixture";
import { commonAr, commonEn } from "../lib/i18n/domains/common";
import {
  KEYS, ledgerOf, openRecovery, SCALE, seedSupplierDoors, type SupplierDoors,
} from "../test-utils/supplierDoorsFixture";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const PAYABLE_CODE = "SUPPLIER_PAYABLE_CORRECTION_PILOT_DISABLED";
const EXPENSE_CODE = "SUPPLIER_COST_EXPENSE_REVERSAL_PILOT_DISABLED";

async function snapshot(s: SupplierDoors) {
  return {
    tables: await dbSnapshot(s.t, Object.keys(schema.tables)),
    scheduled: await s.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()),
  };
}

function expectCodedEnAr(result: { code?: string; message?: string } | undefined, code: string) {
  expect(result?.code, result?.message ?? "the call succeeded instead of refusing").toBe(code);
  expect(result?.message).toMatch(/pilot/i);
  expect(result?.message).toContain("Nothing has been changed.");
  const english: Record<string, string> = commonEn;
  const arabic: Record<string, string> = commonAr;
  expect(english[`ServerError_${code}`]).toBe(result?.message);
  expect(arabic[`ServerError_${code}`]).toMatch(/[؀-ۿ]/);
}

async function onAccountVehicle(s: SupplierDoors, price: number) {
  const vehicleId = (await s.as.mutation(api.vehicles.create, {
    idempotencyKey: crypto.randomUUID(), orgId: s.orgId, vin: "1HGCM82633A000777", make: "Honda", model: "Accord",
    year: 2020, mileage: 10_000, color: "White", fuelType: "Gasoline", transmission: "Automatic",
    sellingPrice: 20_000, status: "AVAILABLE", sourceType: "STOCK", purchasePrice: price,
    purchasePaymentMethod: "ON_ACCOUNT", purchaseSupplierName: "Credit Supplier Co",
  } as never)) as Id<"vehicles">;
  const payable = await s.t.run((ctx) =>
    ctx.db.query("vehicleSupplierPayables").withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicleId)).first()
  );
  return { vehicleId, payableId: payable!._id };
}

describe("vehicles.correctAcquisitionCost on an unpaid ON_ACCOUNT supplier payable", () => {
  test("refuses to rewrite the supplier payable, coded EN/AR, and changes nothing", async () => {
    const s = await seedSupplierDoors("corr1");
    const { vehicleId, payableId } = await onAccountVehicle(s, 12_500);
    const before = await snapshot(s);
    for (const correctionType of ["SUPPLIER_INVOICE_ERROR", "VENDOR_CREDIT"] as const) {
      const result = await refusalDataOf(
        s.as.mutation(api.vehicles.correctAcquisitionCost, {
          orgId: s.orgId, vehicleId, newCost: 9_800, reason: "Supplier invoice was wrong", correctionType,
        })
      );
      expectCodedEnAr(result, PAYABLE_CODE);
    }
    expect((await s.t.run((ctx) => ctx.db.get(payableId)))?.amountDue).toBe(12_500);
    expect(await snapshot(s)).toEqual(before);
    // Hand computed: the 12,500.000 JOD credit to 2400 is untouched.
    expect((await ledgerOf(s.t, s.orgId)).net[KEYS.ACCOUNTS_PAYABLE_SUPPLIERS]).toBe(-12_500 * SCALE);
  });

  test("the correction dialog is not offered the refused types for an unpaid ON_ACCOUNT car", async () => {
    const s = await seedSupplierDoors("corr3");
    const { vehicleId, payableId } = await onAccountVehicle(s, 12_500);
    const unpaid = await s.as.query(api.vehicles.getAcquisitionCostCorrectionContext, { orgId: s.orgId, vehicleId });
    expect(unpaid).toMatchObject({ blockedReason: null, originalPaymentMethod: "ON_ACCOUNT", allowedTypes: [] });
    await s.as.mutation(api.sourcingPayables.markPaid, {
      orgId: s.orgId, payableId, paymentMethod: "CASH", idempotencyKey: crypto.randomUUID(),
    });
    const paid = await s.as.query(api.vehicles.getAcquisitionCostCorrectionContext, { orgId: s.orgId, vehicleId });
    expect(paid.allowedTypes).toContain("CASH_REFUND");
  });

  test("control: a CASH_REFUND on a PAID ON_ACCOUNT car still corrects the cost and leaves the payable alone", async () => {
    const s = await seedSupplierDoors("corr2");
    const { vehicleId, payableId } = await onAccountVehicle(s, 12_500);
    await s.as.mutation(api.sourcingPayables.markPaid, {
      orgId: s.orgId, payableId, paymentMethod: "CASH", idempotencyKey: crypto.randomUUID(),
    });
    await s.as.mutation(api.vehicles.correctAcquisitionCost, {
      orgId: s.orgId, vehicleId, newCost: 9_800, reason: "Supplier refunded the difference",
      correctionType: "CASH_REFUND", paymentMethod: "CASH",
    });
    expect((await s.t.run((ctx) => ctx.db.get(vehicleId)))?.purchasePrice).toBe(9_800);
    expect((await s.t.run((ctx) => ctx.db.get(payableId)))?.amountDue).toBe(12_500);
  });
});

describe("expenses.reverseExpense on a supplier-borne cost", () => {
  test("refuses while the cost recovery is open, coded EN/AR, and changes nothing", async () => {
    const s = await seedSupplierDoors("rev1");
    const { expenseId, recoveryId } = await openRecovery(s, 200);
    const before = await snapshot(s);
    const result = await refusalDataOf(
      s.as.mutation(api.expenses.reverseExpense, { orgId: s.orgId, expenseId, reason: "Wrong car" })
    );
    expectCodedEnAr(result, EXPENSE_CODE);
    expect((await s.t.run((ctx) => ctx.db.get(recoveryId)))?.status).toBe("OPEN");
    expect(await snapshot(s)).toEqual(before);
    // Hand computed: the 200.000 JOD receivable from the supplier is still on the books.
    expect((await ledgerOf(s.t, s.orgId)).net[KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(200 * SCALE);
  });

  test("refuses with the same code once the supplier has paid part of it", async () => {
    const s = await seedSupplierDoors("rev2");
    const { expenseId, recoveryId } = await openRecovery(s, 200);
    await s.as.mutation(api.supplierCostRecoveries.recordReceipt, {
      orgId: s.orgId, recoveryId, amountMinor: 80 * SCALE, method: "CASH", receivedDate: Date.now() - 1_000,
      idempotencyKey: "rev2-receipt",
    });
    const before = await snapshot(s);
    expectCodedEnAr(
      await refusalDataOf(s.as.mutation(api.expenses.reverseExpense, { orgId: s.orgId, expenseId, reason: "Wrong car" })),
      EXPENSE_CODE
    );
    expect(await snapshot(s)).toEqual(before);
  });

  test("control: an ordinary expense with no supplier obligation is still reversed", async () => {
    const s = await seedSupplierDoors("rev3");
    const expenseId = (await s.as.mutation(api.expenses.create, {
      orgId: s.orgId, vehicleId: s.vehicleId, title: "Showroom detailing", amount: 50, date: Date.now() - 60_000,
      category: "DETAILING", status: "PAID", paymentMethod: "CASH", idempotencyKey: crypto.randomUUID(),
    } as never)) as Id<"expenses">;
    await s.as.mutation(api.expenses.reverseExpense, { orgId: s.orgId, expenseId, reason: "Entered twice" });
    const gl = await ledgerOf(s.t, s.orgId);
    expect(gl.net[KEYS.CASH_ON_HAND] ?? 0).toBe(0);
    expect(gl.unbalancedEntries).toBe(0);
  });
});
