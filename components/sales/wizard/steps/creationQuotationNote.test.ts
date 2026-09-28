import { describe, expect, test } from "vitest";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { creationQuotationNoteKey } from "./creationQuotationNote";

describe("the unconfirmed-offset-rule note's promise (Codex SCRUM-428-1)", () => {
  // A confirmed No is OFFSET_RULE_DOES_NOT_APPLY (convex T13): only Yes makes
  // later quotes calculable, so the note must say Yes — never just "confirmed".
  test.each([
    ["en", "Yes"],
    ["ar", "نعم"],
  ] as const)("%s names the Yes answer as the condition for automatic calculation", (locale, yes) => {
    const note = (getDictionary(locale) as Record<string, string>).CreationQuotationOffsetRuleUnknown;
    const settingsYes = (getDictionary(locale) as Record<string, string>).FirstPaymentOffsetYes;
    expect(settingsYes).toBe(yes);
    expect(note).toContain(yes);
  });
});

describe("the note under an uncalculated creation quotation", () => {
  test("a manually entered company says AutoFlow does not calculate it", () => {
    expect(creationQuotationNoteKey({ available: false, reason: "NOT_CONFIGURED_COMPANY" })).toBe(
      "CreationQuotationManualCompany"
    );
  });

  test("an unconfirmed offset rule names the setting instead of a generic refusal (SCRUM-428)", () => {
    expect(creationQuotationNoteKey({ available: false, reason: "OFFSET_RULE_UNKNOWN" })).toBe(
      "CreationQuotationOffsetRuleUnknown"
    );
  });

  test("every other refusal keeps the generic note", () => {
    for (const reason of ["OFFSET_RULE_DOES_NOT_APPLY", "NO_TARGET_RECORDED", "NOT_AUTHORIZED"]) {
      expect(creationQuotationNoteKey({ available: false, reason })).toBe("CreationQuotationNotRecorded");
    }
    expect(creationQuotationNoteKey({ available: true })).toBe("CreationQuotationNotRecorded");
  });
});
