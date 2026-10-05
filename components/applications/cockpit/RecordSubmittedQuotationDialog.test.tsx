/**
 * SCRUM-681 (F-18): when AutoFlow cannot calculate the quotation, the dialog
 * says WHY when the reason is one the operator can act on — the company's
 * first-payment rule, or a missing target — instead of one generic line.
 * Provenance is unchanged: with no calculation the figure is still MANUAL_ENTRY.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { salesAr, salesEn } from "@/lib/i18n/domains/sales";
import {
  RecordSubmittedQuotationDialog,
  toQuotationCalculation,
  type QuotationCalculation,
} from "./RecordSubmittedQuotationDialog";

// The dialog shell reads the locale for its close label; the copy under test
// comes through the `t` prop.
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

const JOD = 1000;

afterEach(cleanup);

function renderDialog(calculation: QuotationCalculation, onSubmit = vi.fn()) {
  render(
    <RecordSubmittedQuotationDialog
      open
      submitting={false}
      error={null}
      calculation={calculation}
      requiresLtvPercent={false}
      canSetLtvPercent
      factor={JOD}
      money={(minor) => `${minor / JOD} JOD`}
      t={(key) => key}
      onOpenChange={() => {}}
      onSubmit={onSubmit}
    />
  );
  return onSubmit;
}

describe("SCRUM-681: the unavailable calculation names its reason", () => {
  test.each([
    ["OFFSET_RULE_UNKNOWN", "QuotationUnavailableOffsetRuleUnknown"],
    ["OFFSET_RULE_DOES_NOT_APPLY", "QuotationUnavailableOffsetRuleDoesNotApply"],
    ["NO_TARGET_RECORDED", "QuotationUnavailableNoTarget"],
  ])("%s shows its own note instead of the generic line", (reason, key) => {
    renderDialog({ state: "UNAVAILABLE", reason });
    expect(screen.getByText(key)).toBeTruthy();
    expect(screen.queryByText("QuotationCalculatorUnavailable")).toBeNull();
  });

  test.each([[undefined], ["NOT_AUTHORIZED"], ["RULES_UNAVAILABLE"], ["Some engine message"]])(
    "reason %s keeps the generic line",
    (reason) => {
      renderDialog({ state: "UNAVAILABLE", reason });
      expect(screen.getByText("QuotationCalculatorUnavailable")).toBeTruthy();
    }
  );

  test("a reasoned unavailable figure is still recorded as a manual entry", () => {
    const onSubmit = renderDialog({ state: "UNAVAILABLE", reason: "OFFSET_RULE_UNKNOWN" });
    fireEvent.change(screen.getByLabelText("QuotationAmountLabel"), {
      target: { value: "11500" },
    });
    fireEvent.click(screen.getByRole("button", { name: "RecordQuotationAction" }));
    expect(onSubmit).toHaveBeenCalledWith({
      submittedQuotationMinor: 11_500 * JOD,
      source: "MANUAL_ENTRY",
      overrideReason: undefined,
    });
  });

  test.each([
    "QuotationUnavailableOffsetRuleUnknown",
    "QuotationUnavailableOffsetRuleDoesNotApply",
    "QuotationUnavailableNoTarget",
  ] as const)("%s has English and Arabic copy", (key) => {
    expect(salesEn[key]).toMatch(/[A-Za-z]/);
    expect(salesAr[key]).toMatch(/[؀-ۿ]/);
    expect(salesAr[key]).not.toMatch(/[A-Za-z]{3,}/);
  });
});

describe("SCRUM-681: the cockpit carries the server's reason into the dialog", () => {
  test("an unavailable suggestion keeps its reason", () => {
    expect(
      toQuotationCalculation(true, { available: false, reason: "OFFSET_RULE_UNKNOWN" })
    ).toEqual({ state: "UNAVAILABLE", reason: "OFFSET_RULE_UNKNOWN" });
  });

  test("loading, unavailable-to-this-caller and available are unchanged", () => {
    expect(toQuotationCalculation(true, undefined)).toEqual({ state: "LOADING" });
    expect(toQuotationCalculation(false, undefined)).toEqual({ state: "UNAVAILABLE" });
    expect(
      toQuotationCalculation(true, { available: true, submittedQuotationMinor: 12_500 * JOD })
    ).toEqual({ state: "AVAILABLE", minor: 12_500 * JOD });
  });
});
