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

  test.each([
    ["en", "does not prevent a loss-making sale"],
    ["ar", "لا يمنع بيعاً بخسارة"],
  ] as const)("%s: body names the figures and discloses it does not prevent a loss-making sale", (locale, disclosure) => {
    const body = upliftBelowMinimumBody(locale, "100", "500");
    expect(body).toContain("(100)");
    expect(body).toContain("(500)");
    expect(body).toContain(disclosure);
  });

  test.each([
    ["en", "Markup added to base price"],
    ["ar", "الإضافة على السعر الأساسي"],
  ] as const)("%s: the input is labelled for what it is, not as a price uplift or profit", (locale, label) => {
    expect(upliftFieldLabel(locale)).toBe(label);
  });
});
