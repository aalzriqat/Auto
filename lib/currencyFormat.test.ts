import { describe, expect, test } from "vitest";
import { formatInCurrency } from "./currencyFormat";

describe("formatInCurrency", () => {
  test("formats a positive amount in the given ISO currency code", () => {
    const result = formatInCurrency("en-US", "USD", 1234.5, 2);
    expect(result).toContain("1,234.5");
    expect(result).toContain("$");
  });

  test("respects fractionDigits (e.g. JOD's 3 decimal places)", () => {
    const result = formatInCurrency("en-US", "JOD", 1100, 3);
    expect(result).toContain("1,100.000");
  });

  test("formats correctly for a currency different from the caller's own default — the whole point of the currency-aware variant", () => {
    // A prepaid schedule kept in USD while the org's current currency is JOD:
    // the amount must format as USD, not silently coerce to JOD.
    const result = formatInCurrency("en-US", "USD", 500, 2);
    expect(result).toContain("$");
    expect(result).not.toContain("JOD");
  });

  test("falls back to a plain 'amount CODE' string for an invalid currency code instead of throwing", () => {
    const result = formatInCurrency("en-US", "NOT_A_CURRENCY", 100, 2);
    expect(result).toBe("100 NOT_A_CURRENCY");
  });

  test("zero and negative amounts format without throwing", () => {
    expect(formatInCurrency("en-US", "USD", 0, 2)).toContain("0.00");
    expect(formatInCurrency("en-US", "USD", -50, 2)).toContain("50.00");
  });
});
