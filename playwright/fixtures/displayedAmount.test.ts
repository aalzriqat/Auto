import { describe, expect, it } from "vitest";
import { displayedAmount } from "./displayedAmount";

// What a money cell shows (lib/moneyDisplay): the whole figure, a space, the currency marker.
describe("displayedAmount: a displayed amount is the whole figure and its currency marker", () => {
  it.each(["3,000 JOD", "3,000 USD", "3,000 د.أ", "3,000 ر.س", " 3,000 JOD "])("accepts %j", (shown) => {
    expect(displayedAmount("3,000").test(shown)).toBe(true);
  });

  it.each([
    "-3,000 JOD", // a negative amount
    "3,000.01 JOD", // a decimal near miss
    "3,000.5 JOD",
    "13,000 JOD", // a longer figure that ends the same way
    "3,0000 JOD",
    "3,000,000 JOD",
    "23,000 JOD",
    "3,000", // no currency marker
    "3,000 ", // no currency marker
    "3,000 5 JOD", // a second figure
    "3,000 -5", // a marker that is not a currency
    "3,000 JOD 5",
    "1,300 JOD",
  ])("rejects %j", (shown) => {
    expect(displayedAmount("3,000").test(shown)).toBe(false);
  });
});
