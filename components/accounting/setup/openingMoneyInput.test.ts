import { expect, test } from "vitest";
import { parseOpeningMoneyMinor } from "./openingMoneyInput";

test("opening money parses English and Arabic-Indic input exactly at the currency scale", () => {
  expect(parseOpeningMoneyMinor("12.345", "JOD")).toBe(12_345);
  expect(parseOpeningMoneyMinor("١٢٫٣٤٥", "JOD")).toBe(12_345);
  expect(parseOpeningMoneyMinor("12.34", "USD")).toBe(1_234);
  expect(parseOpeningMoneyMinor("0", "JOD")).toBe(0);
});

test.each(["12.3456", "1e3", "1,000", "-1", "9007199254740992", "١٢٫٣٤٥٦"])(
  "opening money refuses ambiguous, rounded or unsafe amount %s", (value) => {
    expect(parseOpeningMoneyMinor(value, "JOD")).toBeNull();
  },
);
