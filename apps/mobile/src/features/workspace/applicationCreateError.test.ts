/// <reference types="jest" />

import { quotePricingMismatchAlert } from "./applicationCreateError";

const refusal = (code: string) =>
  Object.assign(new Error("[CONVEX M(applications:createFromQuote)] Server Error"), {
    name: "ConvexError",
    data: { code, message: "server text" },
  });

describe("quotePricingMismatchAlert (SCRUM-533)", () => {
  test("the pricing-snapshot refusal maps to an English recovery message that names the new quotation", () => {
    const alert = quotePricingMismatchAlert(refusal("QUOTE_PRICING_SNAPSHOT_MISMATCH"), "en");
    expect(alert?.message).toMatch(/Create a new quotation/);
  });

  test("the same refusal maps to the Arabic recovery message", () => {
    const alert = quotePricingMismatchAlert(refusal("QUOTE_PRICING_SNAPSHOT_MISMATCH"), "ar");
    expect(alert?.message).toMatch(/أنشئ عرض سعر جديداً/);
  });

  test("any other code, a plain error or a non-error stays on the generic path", () => {
    expect(quotePricingMismatchAlert(refusal("SOMETHING_ELSE"), "en")).toBeNull();
    expect(quotePricingMismatchAlert(new Error("boom"), "en")).toBeNull();
    expect(quotePricingMismatchAlert(undefined, "ar")).toBeNull();
  });
});
