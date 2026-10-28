/// <reference types="jest" />

/**
 * SCRUM-85 / SCRUM-760 c23812 ruling 9: the mobile money formatter never guesses a
 * currency or a minor-unit scale. With no stored currency it prints "currency not
 * configured" instead of a number.
 */
import { currencyNotConfiguredLabel, money, setActiveOrgCurrency } from "./moduleShared";

afterEach(() => setActiveOrgCurrency(null));

describe("mobile money()", () => {
  test("with no stored currency and none passed, it prints the not-configured text in both languages", () => {
    setActiveOrgCurrency(null);
    expect(money(5000, "en")).toBe("Currency not configured");
    expect(money(5000, "ar")).toBe(currencyNotConfiguredLabel("ar"));
    expect(currencyNotConfiguredLabel("ar")).not.toBe(currencyNotConfiguredLabel("en"));
  });

  test("a blank stored code is not a currency", () => {
    setActiveOrgCurrency("   ");
    expect(money(5000, "en")).toBe("Currency not configured");
  });

  test("a record's own currency is used even when the organization has none", () => {
    setActiveOrgCurrency(null);
    expect(money(12.5, "en", "USD")).toBe("$12.50");
  });

  test("the organization's stored currency is used when the caller passes none", () => {
    setActiveOrgCurrency("USD");
    expect(money(12.5, "en")).toBe("$12.50");
    expect(money(12.5, "en", null)).toBe("$12.50");
  });

  test("a code with no known minor-unit scale prints no figure rather than a two-decimal guess", () => {
    expect(money(12.5, "en", "XYZ")).toBe("Currency not configured");
    setActiveOrgCurrency("XYZ");
    expect(money(12.5, "en")).toBe("Currency not configured");
  });

  test("a three-decimal currency keeps its full scale", () => {
    expect(money(5.5, "en", "KWD")).toContain("5.500");
  });
});
