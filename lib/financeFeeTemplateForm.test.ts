/**
 * The major↔minor conversion behind the finance company's fee templates.
 *
 * Every figure here becomes `estimatedAmountMinor`, the integer each new deal
 * freezes as its expected handover cost, so the conversion is held to exact
 * decimal-string arithmetic — the cases below are the ones a float multiply
 * gets wrong or a rounding hides.
 */
import { describe, expect, test } from "vitest";
import {
  feeAccountingTreatmentValidator,
  feePartyValidator,
  financeFeeTypeValidator,
} from "@/convex/utils/financingEconomics";
import {
  FEE_ACCOUNTING_TREATMENTS,
  FEE_PARTIES,
  FINANCE_FEE_TYPES,
  defaultsForFeeType,
  feeFormRowsToTemplates,
  feeTemplateToFormRow,
  formatMinorAsMajor,
  newFeeTemplateFormRow,
  parseMajorToMinor,
  type FinanceFeeTemplate,
} from "./financeFeeTemplateForm";

describe("parseMajorToMinor", () => {
  test("scales a plain decimal exactly at the currency's scale", () => {
    expect(parseMajorToMinor("25", 3)).toEqual({ ok: true, minor: 25_000 });
    expect(parseMajorToMinor("12.5", 3)).toEqual({ ok: true, minor: 12_500 });
    expect(parseMajorToMinor("12.345", 3)).toEqual({ ok: true, minor: 12_345 });
    expect(parseMajorToMinor("0.001", 3)).toEqual({ ok: true, minor: 1 });
    expect(parseMajorToMinor("19.99", 2)).toEqual({ ok: true, minor: 1_999 });
    expect(parseMajorToMinor("700", 0)).toEqual({ ok: true, minor: 700 });
  });

  test("is not a float multiply: the classic binary-fraction cases land on the typed digits", () => {
    // 1.005 * 1000 is 1004.9999999999999 in IEEE-754; 0.07 * 100 is 7.000000000000001;
    // 1.15 * 100 is 114.99999999999999. The string path never sees any of that.
    expect(parseMajorToMinor("1.005", 3)).toEqual({ ok: true, minor: 1_005 });
    expect(parseMajorToMinor("0.07", 2)).toEqual({ ok: true, minor: 7 });
    expect(parseMajorToMinor("1.15", 2)).toEqual({ ok: true, minor: 115 });
    expect(parseMajorToMinor("4.35", 2)).toEqual({ ok: true, minor: 435 });
  });

  test("tolerates whitespace, a leading dot, a trailing dot and trailing zeros past the scale", () => {
    expect(parseMajorToMinor(" 3 ", 3)).toEqual({ ok: true, minor: 3_000 });
    expect(parseMajorToMinor(".5", 3)).toEqual({ ok: true, minor: 500 });
    expect(parseMajorToMinor("5.", 3)).toEqual({ ok: true, minor: 5_000 });
    expect(parseMajorToMinor("1.50000", 3)).toEqual({ ok: true, minor: 1_500 });
    expect(parseMajorToMinor("007", 2)).toEqual({ ok: true, minor: 700 });
  });

  test("refuses rather than rounds a digit the currency cannot hold", () => {
    expect(parseMajorToMinor("1.2345", 3)).toEqual({ ok: false, problem: "TOO_PRECISE" });
    expect(parseMajorToMinor("1.005", 2)).toEqual({ ok: false, problem: "TOO_PRECISE" });
    expect(parseMajorToMinor("1.5", 0)).toEqual({ ok: false, problem: "TOO_PRECISE" });
  });

  test("refuses anything that is not a plain non-negative decimal", () => {
    expect(parseMajorToMinor("", 3)).toEqual({ ok: false, problem: "EMPTY" });
    expect(parseMajorToMinor("   ", 3)).toEqual({ ok: false, problem: "EMPTY" });
    for (const bad of ["-5", "1e3", "1,000", "abc", ".", "+5", "0x10", "١٢"]) {
      expect(parseMajorToMinor(bad, 3), bad).toEqual({ ok: false, problem: "NOT_A_NUMBER" });
    }
  });

  test("refuses an amount past the safe-integer range instead of storing a corrupted one", () => {
    expect(parseMajorToMinor("9007199254740.992", 3)).toEqual({ ok: false, problem: "TOO_LARGE" });
    expect(parseMajorToMinor("9007199254740.991", 3)).toEqual({ ok: true, minor: 9_007_199_254_740_991 });
  });
});

describe("formatMinorAsMajor", () => {
  test("spells stored fils as the major figure the operator typed", () => {
    expect(formatMinorAsMajor(25_000, 3)).toBe("25");
    expect(formatMinorAsMajor(12_500, 3)).toBe("12.5");
    expect(formatMinorAsMajor(12_345, 3)).toBe("12.345");
    expect(formatMinorAsMajor(1, 3)).toBe("0.001");
    expect(formatMinorAsMajor(0, 3)).toBe("0");
    expect(formatMinorAsMajor(1_999, 2)).toBe("19.99");
    expect(formatMinorAsMajor(5, 2)).toBe("0.05");
    expect(formatMinorAsMajor(700, 0)).toBe("700");
  });

  test("round-trips every minor amount through the parser unchanged", () => {
    for (const scale of [0, 2, 3]) {
      for (const minor of [0, 1, 7, 99, 100, 1_005, 12_345, 250_000, 9_007_199_254_740_991]) {
        const parsed = parseMajorToMinor(formatMinorAsMajor(minor, scale), scale);
        expect(parsed, `${minor} @ ${scale}`).toEqual({ ok: true, minor });
      }
    }
  });

  test("renders nothing for a value the server would never have stored", () => {
    expect(formatMinorAsMajor(-1, 3)).toBe("");
    expect(formatMinorAsMajor(1.5, 3)).toBe("");
    expect(formatMinorAsMajor(Number.NaN, 3)).toBe("");
  });
});

describe("the option lists", () => {
  test("are exactly the literals the backend validators admit, in order", () => {
    const literals = (validator: { members: ReadonlyArray<{ value: string }> }) =>
      validator.members.map((member) => member.value);
    expect([...FINANCE_FEE_TYPES]).toEqual(literals(financeFeeTypeValidator));
    expect([...FEE_PARTIES]).toEqual(literals(feePartyValidator));
    expect([...FEE_ACCOUNTING_TREATMENTS]).toEqual(literals(feeAccountingTreatmentValidator));
    expect(FINANCE_FEE_TYPES.length).toBe(12);
    expect(FEE_PARTIES.length).toBe(8);
    expect(FEE_ACCOUNTING_TREATMENTS.length).toBe(12);
  });

  test("every fee type has a counterparty and treatment default the validators accept", () => {
    for (const feeType of FINANCE_FEE_TYPES) {
      const defaults = defaultsForFeeType(feeType);
      expect(FEE_PARTIES).toContain(defaults.paidTo);
      expect(FEE_ACCOUNTING_TREATMENTS).toContain(defaults.accountingTreatment);
    }
  });
});

const stored: FinanceFeeTemplate = {
  feeType: "LIEN_REGISTRATION",
  description: "Traffic department lien",
  estimatedAmountMinor: 37_500,
  paidBy: "CUSTOMER",
  paidTo: "GOVERNMENT",
  includedInQuotation: true,
  deductedFromSettlement: false,
  refundable: true,
  accountingTreatment: "CUSTOMER_RECEIVABLE",
};

describe("edit load and payload conversion", () => {
  test("a stored template loads with every field carried and none defaulted", () => {
    expect(feeTemplateToFormRow(stored, 3, "k1")).toEqual({
      key: "k1",
      feeType: "LIEN_REGISTRATION",
      description: "Traffic department lien",
      estimatedAmount: "37.5",
      paidBy: "CUSTOMER",
      paidTo: "GOVERNMENT",
      includedInQuotation: true,
      deductedFromSettlement: false,
      refundable: true,
      accountingTreatment: "CUSTOMER_RECEIVABLE",
    });
  });

  test("a template loaded and converted back untouched is byte-identical", () => {
    const row = feeTemplateToFormRow(stored, 3, "k1");
    expect(feeFormRowsToTemplates([row], 3)).toEqual({ templates: [stored], problems: {} });
  });

  test("a blank description is omitted, not sent as an empty string", () => {
    const row = { ...feeTemplateToFormRow(stored, 3, "k1"), description: "   " };
    const { templates } = feeFormRowsToTemplates([row], 3);
    expect(templates[0]).not.toHaveProperty("description");
    expect(templates[0].estimatedAmountMinor).toBe(37_500);
  });

  test("a new row carries safe defaults for every required field", () => {
    const row = newFeeTemplateFormRow("n1");
    expect(row).toMatchObject({
      feeType: "OWNERSHIP_TRANSFER",
      paidBy: "DEALER",
      paidTo: "GOVERNMENT",
      accountingTreatment: "OWNERSHIP_TRANSFER_EXPENSE",
      includedInQuotation: false,
      deductedFromSettlement: false,
      refundable: false,
      estimatedAmount: "",
    });
    // Blank until an amount is typed — never a silent zero.
    expect(feeFormRowsToTemplates([row], 3).problems).toEqual({ n1: "EMPTY" });
  });

  test("a row that fails to convert is reported by key and never dropped from a partial payload", () => {
    const good = feeTemplateToFormRow(stored, 3, "good");
    const bad = { ...newFeeTemplateFormRow("bad"), estimatedAmount: "1.2345" };
    const result = feeFormRowsToTemplates([good, bad], 3);
    expect(result.problems).toEqual({ bad: "TOO_PRECISE" });
    // The caller must refuse to submit while problems exist; what converted is
    // reported so the UI can mark rows, not so it can be sent as-is.
    expect(result.templates).toHaveLength(1);
  });
});
