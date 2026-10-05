import { describe, expect, test } from "vitest";
import { disbursementVersionOf, financeDisbursementKeys } from "./financeDisbursementKeys";

describe("financeDisbursementKeys", () => {
  const id = "k17abc123";

  test("version 1 reproduces today's literals byte-for-byte", () => {
    expect(financeDisbursementKeys(id, 1)).toEqual({
      paymentKey: `finance_disbursement_${id}`,
      cashReceivedPostKey: `finance_cash_received_${id}`,
      sourceId: `disbursement_${id}`,
      eventVersion: 1,
      reversalKey: `finance_cash_received_reversed_${id}`,
      pendingPostKey: `finance_cash_received_${id}`,
    });
  });

  test("an omitted version is version 1", () => {
    expect(financeDisbursementKeys(id)).toEqual(financeDisbursementKeys(id, 1));
  });

  test("version n >= 2 appends _v<n> to every key and sets eventVersion", () => {
    expect(financeDisbursementKeys(id, 2)).toEqual({
      paymentKey: `finance_disbursement_${id}_v2`,
      cashReceivedPostKey: `finance_cash_received_${id}_v2`,
      sourceId: `disbursement_${id}_v2`,
      eventVersion: 2,
      reversalKey: `finance_cash_received_reversed_${id}_v2`,
      pendingPostKey: `finance_cash_received_${id}_v2`,
    });
  });

  test("no two versions share any key", () => {
    const seen = new Set<string>();
    for (const version of [1, 2, 3, 10, 11]) {
      const k = financeDisbursementKeys(id, version);
      for (const value of [k.paymentKey, k.cashReceivedPostKey, k.sourceId, k.reversalKey]) {
        expect(seen.has(value)).toBe(false);
        seen.add(value);
      }
    }
  });

  test("a forward key never equals a reversal key", () => {
    const k = financeDisbursementKeys(id, 2);
    expect(k.reversalKey).not.toBe(k.cashReceivedPostKey);
  });

  test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses version %s", (bad) => {
    expect(() => financeDisbursementKeys(id, bad)).toThrow();
  });

  test("an absent stored version means 1", () => {
    expect(disbursementVersionOf({})).toBe(1);
    expect(disbursementVersionOf({ disbursementVersion: 3 })).toBe(3);
  });
});
