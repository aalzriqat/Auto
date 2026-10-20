import { describe, expect, test } from "vitest";
import {
  DEAL_COMMISSION_LINES_PILOT_DISABLED,
  parseCommissionAmountMinor,
  netProfitAfterCommissionsMinor,
  sumCommissionMinor,
} from "./dealCommissionLines";

describe("sumCommissionMinor", () => {
  test("adds the owner's example: purchase 50, sale 50, execution 25 JOD = 125 JOD", () => {
    // JOD has 3 decimals, so 50 JOD is 50_000 fils.
    expect(sumCommissionMinor([{ amountMinor: 50_000 }, { amountMinor: 50_000 }, { amountMinor: 25_000 }])).toBe(125_000);
  });
  test("no lines is zero", () => {
    expect(sumCommissionMinor([])).toBe(0);
  });
  test.each([[-1], [1.5], [Number.NaN], [Number.MAX_SAFE_INTEGER + 2]])(
    "an unreadable amount (%s) makes the total unknown, never smaller",
    (bad) => {
      expect(sumCommissionMinor([{ amountMinor: 100 }, { amountMinor: bad }])).toBeNull();
    }
  );
  test("an overflowing sum is unknown", () => {
    expect(sumCommissionMinor([{ amountMinor: Number.MAX_SAFE_INTEGER }, { amountMinor: 1 }])).toBeNull();
  });
});

describe("netProfitAfterCommissionsMinor", () => {
  test("deducts commissions from profit (SCRUM-434: 1,000 less 250 is 750)", () => {
    expect(netProfitAfterCommissionsMinor(1_000_000, 250_000)).toBe(750_000);
  });
  test("a commission larger than profit gives a signed loss, not zero", () => {
    expect(netProfitAfterCommissionsMinor(100, 250)).toBe(-150);
  });
  test("an unknown operand is unknown, never a profit", () => {
    expect(netProfitAfterCommissionsMinor(null, 250)).toBeNull();
    expect(netProfitAfterCommissionsMinor(1000, null)).toBeNull();
  });
});

test("the pilot switch is OFF in this build: commission lines are enabled", () => {
  expect(DEAL_COMMISSION_LINES_PILOT_DISABLED).toBe(false);
});

describe("parseCommissionAmountMinor", () => {
  test.each([
    [50, 3, 50_000],
    [0.1, 3, 100],
    [0.07, 2, 7],
    [12.34, 2, 1234],
    [1.005, 3, 1005],
    [1_000_000_000, 3, 1_000_000_000_000],
    [0.001, 3, 1],
  ])("accepts %s at scale %s as %s minor units", (amount, scale, minor) => {
    expect(parseCommissionAmountMinor(amount, scale)).toEqual({ ok: true, minor });
  });

  test.each([
    [1.005, 2, "decimals"],
    [50.0000000001, 3, "decimals"],
    [49.9999999999, 3, "decimals"],
    [10.0001, 3, "decimals"],
    [0.1 + 0.2, 2, "decimals"],
    [1e-7, 3, "decimals"],
    [8796093022208.001, 3, "range"],
    [1_000_000_000.001, 3, "range"],
    [1e21, 3, "range"],
    [0, 3, "nonpositive"],
    [-5, 3, "nonpositive"],
    [Number.NaN, 3, "invalid"],
    [Number.POSITIVE_INFINITY, 3, "invalid"],
  ])("refuses %s at scale %s (%s)", (amount, scale, reason) => {
    expect(parseCommissionAmountMinor(amount, scale)).toEqual({ ok: false, reason });
  });
});
