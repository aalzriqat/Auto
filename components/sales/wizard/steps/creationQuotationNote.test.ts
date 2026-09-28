import { describe, expect, test } from "vitest";
import { creationQuotationNoteKey } from "./creationQuotationNote";

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
