/** SCRUM-1012: every late bank opening refusal resolves in the user's language and keeps the server text in English. */
import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import { getLocalizedErrorMessage } from "./errors";

describe("getLocalizedErrorMessage - late bank opening refusals", () => {
  it("resolves to Arabic in ar and keeps the server text in en", async () => {
    const { dictionaries } = await import("./i18n/dictionaries");
    const ar = (key: string) => (dictionaries.ar as Record<string, string>)[key] ?? key;
    const en = (key: string) => (dictionaries.en as Record<string, string>)[key] ?? key;
    const { LATE_BANK_OPENING_MESSAGES } = await import("../convex/accounting/lateBankOpening");
    const { AppErrorCode } = await import("../convex/utils/errors");
    const codes = Object.keys(LATE_BANK_OPENING_MESSAGES);
    expect([...codes].sort()).toEqual([
      "LATE_BANK_OPENING_ALREADY_POSTED",
      "LATE_BANK_OPENING_BANK_UNAVAILABLE",
      "LATE_BANK_OPENING_BEFORE_CUTOVER",
      "LATE_BANK_OPENING_EDIT_REFUSED",
      "LATE_BANK_OPENING_EDIT_UNPROVABLE",
      "LATE_BANK_OPENING_FIGURES_CHANGED",
      "LATE_BANK_OPENING_INVALID_BALANCE",
      "LATE_BANK_OPENING_NOT_REVERSIBLE",
      "LATE_BANK_OPENING_NO_ORG_OPENING",
      "LATE_BANK_OPENING_OPENING_UNPROVABLE",
      "LATE_BANK_OPENING_OWNER_ONLY",
      "LATE_BANK_OPENING_PERIOD_UNAVAILABLE",
    ]);
    for (const code of codes) {
      expect(Object.values(AppErrorCode)).toContain(code);
      const serverText = (LATE_BANK_OPENING_MESSAGES as Record<string, string>)[code];
      const error = new ConvexError({ code, message: serverText });
      const arText = getLocalizedErrorMessage(error, ar);
      expect(arText).toMatch(/[؀-ۿ]/);
      expect(arText).not.toBe(serverText);
      expect(arText).toBe((dictionaries.ar as Record<string, string>)[`ServerError_${code}`]);
      expect(getLocalizedErrorMessage(error, en)).toBe(serverText);
    }
  });
});
