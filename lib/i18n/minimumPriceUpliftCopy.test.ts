/**
 * SCRUM-260 (#522 review F1/F2). The per-vehicle control measures the sale price
 * against the LIST price, not against cost, so no screen may call that spread
 * "profit"; and its help text must say approval is needed BELOW the minimum
 * (convex/utils/profitApproval.ts: required when margin < minimum).
 */
import { describe, expect, test } from "vitest";
import { dictionaries } from "./dictionaries";

const NO_PROFIT_KEYS = ["RequestedProfit", "AllCaughtUp", "DealerProfit"] as const;

// Per language: the help text says LESS than the minimum above list, and not the old wording.
const HELP_WORDING = {
  en: { present: /final sale price minus the vehicle's list price/, absent: /less than this amount above/ },
  ar: { present: /سعر البيع النهائي مطروحاً منه سعر قائمة المركبة/, absent: /بأقل من هذا المبلغ/ },
} as const;

describe("minimum price uplift copy", () => {
  for (const [name, dict] of Object.entries(dictionaries) as [string, Record<string, string>][]) {
    test(`${name}: the approval card, empty state and quote-setup input do not call the list-price spread profit`, () => {
      for (const key of NO_PROFIT_KEYS) expect(dict[key]).not.toMatch(/profit|ربح/i);
    });
  }

  for (const [lang, { present, absent }] of Object.entries(HELP_WORDING)) {
    test(`${lang}: help text says approval is needed when the price is LESS than the minimum above list`, () => {
      const help = (dictionaries as Record<string, Record<string, unknown>>)[lang].MinimumPriceUpliftHelp as string;
      expect(help).toMatch(present);
      expect(help).not.toMatch(absent);
    });
  }
});
