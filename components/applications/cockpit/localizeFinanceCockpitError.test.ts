import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { dictionaries } from "@/lib/i18n/dictionaries";
import type { Locale, TranslationKey } from "@/lib/i18n/dictionaries";
import { localizeFinanceCockpitError } from "./localizeFinanceCockpitError";

const conflict = "Idempotency key reused with different request content. Use a new key for a different operation.";

describe.each(["en", "ar"] as const)("settlement advice errors in %s", (locale: Locale) => {
  const t = (key: string) => dictionaries[locale][key as TranslationKey] ?? key;

  test.each([
    [conflict, "FinanceSettlementAdviceReviewRecorded"],
    ["This command is already being processed. Please retry shortly.", "FinanceSettlementAdviceInProgress"],
    ["Application not found.", "FinanceSettlementAdviceApplicationUnavailable"],
    ["Invalid minor-unit disbursed amount: 9007199254740991000. Must be a non-negative safe integer.", "FinanceSettlementAdviceAmountInvalid"],
    [{ code: "FORBIDDEN", message: "Forbidden: Missing required permissions: finance:manage" }, "FinanceSettlementAdviceAccessUnavailable"],
    [{ code: "UNAUTHENTICATED", message: "Unauthenticated: You must be logged in." }, "FinanceSettlementAdviceSignInRequired"],
    [{ code: "SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED", message: "Pilot refusal" }, "ServerError_SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED"],
  ] as const)("shows the recovery for %j", (payload, key) => {
    const message = localizeFinanceCockpitError(new ConvexError(payload), t, "settlement-advice");
    expect(message).toBe(t(key));
    expect(message).not.toBe(key);
  });

  test("gives unknown advice outcomes recovery guidance without displaying technical text", () => {
    expect(localizeFinanceCockpitError(new Error(conflict), t, "settlement-advice")).toBe(t("FinanceSettlementAdviceOutcomeUnknown"));
    expect(localizeFinanceCockpitError(new Error(conflict), t)).toBe(t("UnexpectedError"));
    expect(localizeFinanceCockpitError(new ConvexError(conflict), t)).toBe(t("UnexpectedError"));
    const adviceCopy = dictionaries.en.FinanceSettlementAdviceOutcomeUnknown;
    expect(localizeFinanceCockpitError(new ConvexError(adviceCopy), t)).toBe(t("UnexpectedError"));
  });
});
