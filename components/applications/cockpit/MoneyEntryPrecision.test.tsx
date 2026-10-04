/**
 * SCRUM-605. A money figure the operator types is recorded exactly or not at
 * all: more decimals than the deal currency holds is refused, never rounded
 * into a different — or a conveniently "matching" — amount. The quotation and
 * gap dialogs carry their own cases beside their other tests; these are the two
 * cockpit dialogs that had no suite of their own.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

import { RecordAppraisalDialog } from "./RecordAppraisalDialog";
import { RecordApprovedPurchaseDialog } from "./RecordApprovedPurchaseDialog";

afterEach(() => cleanup());

/** JOD: three decimals, where a rounding bug is visible. */
const JOD = 1_000;
const amountField = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const submitButtons = () =>
  screen.getAllByRole("button").filter((button) => button.textContent !== "Cancel") as HTMLButtonElement[];

describe("the appraisal amount", () => {
  function renderDialog(onSubmit = vi.fn()) {
    render(
      <RecordAppraisalDialog
        open
        submitting={false}
        error={null}
        existingAppraisalMinor={null}
        approvalWouldBeReopened={false}
        factor={JOD}
        money={(minor) => `${minor / JOD} JOD`}
        t={(key) => key}
        onOpenChange={() => {}}
        onSubmit={onSubmit}
      />
    );
    return onSubmit;
  }
  const submit = () => submitButtons().find((button) => button.textContent?.includes("RecordAppraisalAction"))!;

  test("more decimals than the currency holds is refused and named, not rounded", () => {
    const onSubmit = renderDialog();
    fireEvent.change(amountField("AppraisalAmountLabel"), { target: { value: "13000.0004" } });
    expect(submit().disabled).toBe(true);
    fireEvent.click(submit());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("AmountTooPrecise")).toBeTruthy();
  });

  test("an exact figure in fils is recorded exactly", () => {
    const onSubmit = renderDialog();
    fireEvent.change(amountField("AppraisalAmountLabel"), { target: { value: "13000.125" } });
    expect(screen.queryByText("AmountTooPrecise")).toBeNull();
    fireEvent.click(submit());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ appraisalAmountMinor: 13_000_125 });
  });
});

describe("the approved purchase amount (typed basis)", () => {
  function renderDialog(onSubmit = vi.fn()) {
    render(
      <RecordApprovedPurchaseDialog
        open
        submitting={false}
        error={null}
        appraisal={null}
        submittedQuotationMinor={13_000 * JOD}
        appliedLtvPercent={70}
        factor={JOD}
        money={(minor) => `${minor / JOD} JOD`}
        t={(key) => key}
        onOpenChange={() => {}}
        onSubmit={onSubmit}
      />
    );
    fireEvent.change(screen.getByLabelText("BasisManualNotesLabel"), {
      target: { value: "the company's letter" },
    });
    return onSubmit;
  }
  const submit = () =>
    submitButtons().find((button) => button.textContent?.includes("RecordApprovedPurchaseAction"))!;

  test("more decimals than the currency holds is refused and named, not rounded", () => {
    const onSubmit = renderDialog();
    fireEvent.change(amountField("ApprovedAmountLabel"), { target: { value: "13000.0004" } });
    expect(submit().disabled).toBe(true);
    fireEvent.click(submit());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("AmountTooPrecise")).toBeTruthy();
  });

  test("an exact figure is recorded exactly", () => {
    const onSubmit = renderDialog();
    fireEvent.change(amountField("ApprovedAmountLabel"), { target: { value: "13000" } });
    expect(screen.queryByText("AmountTooPrecise")).toBeNull();
    fireEvent.click(submit());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ approvedAmountMinor: 13_000 * JOD, basis: "MANUAL" });
  });
});
