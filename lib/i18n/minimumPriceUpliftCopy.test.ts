/**
 * SCRUM-260 (#522 review F1/F2). The per-vehicle control measures the sale price
 * against the LIST price, not against cost, so no screen may call that spread
 * "profit"; and its help text must say approval is needed BELOW the minimum
 * (convex/utils/profitApproval.ts: required when margin < minimum).
 */
import { describe, expect, test } from "vitest";
import { dictionaries } from "./dictionaries";

describe("minimum price uplift copy", () => {
  for (const [name, dict] of Object.entries(dictionaries) as [string, Record<string, string>][]) {
    test(`${name}: the approval card and empty state do not call the list-price spread profit`, () => {
      expect(dict.RequestedProfit).not.toMatch(/profit|ربح/i);
      expect(dict.AllCaughtUp).not.toMatch(/profit|ربح/i);
    });
  }

  test("en: help text says approval is needed when the price is LESS than the minimum above list", () => {
    const help = dictionaries.en.MinimumPriceUpliftHelp as string;
    expect(help).toMatch(/less than this amount above/);
    expect(help).not.toMatch(/before it needs/);
  });

  test("ar: help text says approval is needed when the price is LESS than the minimum above list", () => {
    const help = dictionaries.ar.MinimumPriceUpliftHelp as string;
    expect(help).toMatch(/بأقل من هذا المبلغ/);
    expect(help).not.toMatch(/قبل أن يحتاج/);
  });
});
