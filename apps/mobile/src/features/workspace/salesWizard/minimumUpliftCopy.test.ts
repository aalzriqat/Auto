import {
  upliftApprovedText,
  upliftBelowMinimumBody,
  upliftFieldLabel,
  upliftRejectedText,
  upliftRequestActionText,
} from "./minimumUpliftCopy";

describe("SCRUM-260 mobile minimum price uplift copy", () => {
  const locales = ["en", "ar"] as const;

  test.each(locales)("%s: no string calls the list-price spread profit", (locale) => {
    const all = [
      upliftFieldLabel(locale),
      upliftBelowMinimumBody(locale, "100", "500"),
      upliftRejectedText(locale),
      upliftRequestActionText(locale),
      upliftApprovedText(locale),
    ].join("\n");
    expect(all).not.toMatch(/profit|ربح/i);
  });

  test("en: body names the figures and discloses it does not prevent a loss-making sale", () => {
    const body = upliftBelowMinimumBody("en", "100", "500");
    expect(body).toContain("(100)");
    expect(body).toContain("(500)");
    expect(body).toContain("does not prevent a loss-making sale");
  });

  test("ar: body names the figures and discloses it does not prevent a loss-making sale", () => {
    const body = upliftBelowMinimumBody("ar", "100", "500");
    expect(body).toContain("(100)");
    expect(body).toContain("(500)");
    expect(body).toContain("لا يمنع بيعاً بخسارة");
  });
});
