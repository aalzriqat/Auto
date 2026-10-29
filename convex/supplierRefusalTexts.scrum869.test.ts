/**
 * SCRUM-869 S1 review round 2: a refusal must never send the user to an action that does not exist.
 *
 * Payable correction is blocked (SUPPLIER_PAYABLE_CORRECTION_PILOT_DISABLED), no public mutation adjusts a
 * supplier payable, and manual journals are disabled for the pilot (convex/utils/manualJournalContainment.ts,
 * SCRUM-795). So a refusal on a supplier settlement door may name only an action the user can take now:
 * reduce the amount, or leave the record as it stands.
 */
import { describe, expect, test, vi } from "vitest";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";
import { commonAr, commonEn } from "../lib/i18n/domains/common";
import { getLocalizedErrorMessage } from "../lib/errors";
import { refusalDataOf } from "../test-utils/financedDealFixture";
import { insertPayable, insertReceivable, seedSupplierDoors } from "../test-utils/supplierDoorsFixture";
import { assertNoSupplierReceiptsForSale } from "./supplierReceivables";
import { SUPPLIER_PAYABLE_PAID_CANCEL_MESSAGE } from "./utils/saleCancellation";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const english: Record<string, string> = commonEn;
const arabic: Record<string, string> = commonAr;
const translate = (table: Record<string, string>) => (key: string) => table[key] ?? key;

/** Actions that do not exist for a pilot user: a correction door, an adjustment door, a manual journal. */
const PROMISES_AN_UNAVAILABLE_DOOR = [
  /manual (accounting )?(correction|journal)/i,
  /adjust the supplier payable/i,
  /correct the (entitlement|claim|payable)/i,
  /accountant for a manual/i,
];
const ARABIC_UNAVAILABLE_DOOR = [/تصحيح محاسبي يدوي/, /قيد يدوي/, /قيود يدوية/, /عدّل ذمة المورد/, /عدّل ذمة المورّد/];

function expectNoUnavailableDoor(text: string | undefined, patterns: RegExp[], what: string) {
  expect(text, `${what} is missing`).toBeTruthy();
  for (const pattern of patterns) expect(text, `${what} must not promise ${pattern}`).not.toMatch(pattern);
}

describe("recordPartialPayment over-application", () => {
  const CODE = "SUPPLIER_PAYMENT_EXCEEDS_BALANCE";

  test("is refused with a coded EN/AR error that names an available action, never a correction", async () => {
    const s = await seedSupplierDoors("txt-over");
    const payableId = await insertPayable(s, 8000);
    await s.as.mutation(api.sourcingPayables.recordPartialPayment, {
      orgId: s.orgId, payableId, amount: 3000, paymentMethod: "CASH", idempotencyKey: "txt-over-1",
    });
    const refusal = await refusalDataOf(
      s.as.mutation(api.sourcingPayables.recordPartialPayment, {
        orgId: s.orgId, payableId, amount: 5000.001, paymentMethod: "CASH", idempotencyKey: "txt-over-2",
      })
    );
    expect(refusal?.code, refusal?.message).toBe(CODE);
    expect(refusal?.message).toMatch(/That would pay 8000\.001 against 8000 owed/);
    expect(refusal?.message).toContain("Reduce the amount to the balance still owed.");
    expectNoUnavailableDoor(refusal?.message, PROMISES_AN_UNAVAILABLE_DOOR, "the server text");
    expect(refusal?.message).not.toMatch(/entitlement/i);
  });

  test("has English and Arabic dictionary entries that fill the server's figures", async () => {
    const enEntry = english[`ServerError_${CODE}`];
    const arEntry = arabic[`ServerError_${CODE}`];
    expect(enEntry).toContain("{projected}");
    expect(enEntry).toContain("{due}");
    expect(arEntry).toMatch(/[؀-ۿ]/);
    expect(arEntry).toContain("{projected}");
    expect(arEntry).toContain("{due}");
    expectNoUnavailableDoor(enEntry, PROMISES_AN_UNAVAILABLE_DOOR, "the English entry");
    expectNoUnavailableDoor(arEntry, ARABIC_UNAVAILABLE_DOOR, "the Arabic entry");
    const error = new ConvexError({ code: CODE, message: "server text", projected: 8000.001, due: 8000 });
    expect(getLocalizedErrorMessage(error, translate(english))).toBe(
      "That would pay 8000.001 against 8000 owed. Reduce the amount to the balance still owed."
    );
    const localized = getLocalizedErrorMessage(error, translate(arabic));
    expect(localized).toMatch(/[؀-ۿ]/);
    expect(localized).toContain("8000.001");
    expect(localized).not.toMatch(/\{\w+\}/);
  });
});

describe("vehicles.correctAcquisitionCost on a sourced vehicle", () => {
  test("refuses with COST_CORRECTION_SOURCED and does not point at an adjustment that does not exist", async () => {
    const s = await seedSupplierDoors("txt-src");
    const refusal = await refusalDataOf(
      s.as.mutation(api.vehicles.correctAcquisitionCost, {
        orgId: s.orgId, vehicleId: s.vehicleId, newCost: 9800, reason: "wrong", correctionType: "PRIOR_PERIOD_RESTATEMENT",
      })
    );
    expect(refusal?.code, refusal?.message).toBe("COST_CORRECTION_SOURCED");
    expectNoUnavailableDoor(refusal?.message, PROMISES_AN_UNAVAILABLE_DOOR, "the server text");
    expect(refusal?.message).toBe(english.ServerError_COST_CORRECTION_SOURCED);
    expect(refusal?.message).toContain("Nothing has been changed.");
    expectNoUnavailableDoor(english.ServerError_COST_CORRECTION_SOURCED, PROMISES_AN_UNAVAILABLE_DOOR, "the English entry");
    expectNoUnavailableDoor(arabic.ServerError_COST_CORRECTION_SOURCED, ARABIC_UNAVAILABLE_DOOR, "the Arabic entry");
    expect(arabic.ServerError_COST_CORRECTION_SOURCED).toMatch(/[؀-ۿ]/);
  });
});

describe("cancelling a sale after the supplier side has moved money", () => {
  test("the payable refusal leaves the record as it stands and offers no manual correction", () => {
    const entry = "ServerError_SUPPLIER_PAYABLE_PAID_CANCEL_REFUSED";
    expect(english[entry]).toBe(SUPPLIER_PAYABLE_PAID_CANCEL_MESSAGE);
    expectNoUnavailableDoor(english[entry], PROMISES_AN_UNAVAILABLE_DOOR, "the English entry");
    expectNoUnavailableDoor(arabic[entry], ARABIC_UNAVAILABLE_DOOR, "the Arabic entry");
    expect(english[entry]).toContain("Nothing has been changed.");
    expect(arabic[entry]).toMatch(/[؀-ۿ]/);
  });

  test("the margin-claim refusal leaves the record as it stands and offers no manual correction", async () => {
    const s = await seedSupplierDoors("txt-claim");
    const receivableId = await insertReceivable(s, 500);
    await s.t.run((ctx) => ctx.db.patch(receivableId, { receiptSeq: 1, amountReceived: 100, status: "PARTIALLY_PAID" } as never));
    const refusal = await s.t
      .run((ctx) => assertNoSupplierReceiptsForSale(ctx, s.orgId, s.saleId))
      .then(() => undefined, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(Error);
    const message = String((refusal as { data?: unknown; message?: string }).data ?? (refusal as Error).message);
    expect(message).toMatch(/supplier has paid against its commission claim/i);
    expectNoUnavailableDoor(message, PROMISES_AN_UNAVAILABLE_DOOR, "the server text");
    expect(message).toContain("Nothing has been changed.");
  });
});
