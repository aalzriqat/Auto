/**
 * Settling the shortfall a finance company left when it approved below the
 * quotation — specifically, what the screen is allowed to send on the
 * operator's behalf.
 *
 * The destinations are the whole reason this dialog exists rather than a "who
 * pays" toggle: money the customer pays the DEALERSHIP becomes dealer proceeds,
 * and money paid to the FINANCE COMPANY must not. So "nothing was paid to the
 * financier" and "nobody said what was paid to the financier" are different
 * facts with different accounting consequences, and the owner's rule for this
 * workflow is that there are no defaults from absence.
 *
 * An earlier revision mapped a blank destination box to numeric zero. On a
 * 1,000 shortfall an operator could type 1,000 into cash-to-dealer, leave the
 * other two blank, and the dialog would submit three figures of which one was
 * decided and two were invented — reconciling precisely because the invented
 * ones were zero. Found by an independent review of the exact head; these tests
 * fail against that revision.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

import { ResolveGapDialog } from "./ResolveGapDialog";

afterEach(() => cleanup());

/** JOD: three minor units per major, which is where a scale bug would show. */
const FACTOR = 1_000;
const GAP_MAJOR = 1_000;
const GAP_MINOR = GAP_MAJOR * FACTOR;

type Submitted = Parameters<
  React.ComponentProps<typeof ResolveGapDialog>["onSubmit"]
>[0];

function renderDialog(onSubmit: (values: Submitted) => Promise<void>) {
  return render(
    <ResolveGapDialog
      open
      submitting={false}
      rawAppraisalGapMinor={GAP_MINOR}
      economicsStamp="v2|3"
      factor={FACTOR}
      money={(minor: number) => `${minor / FACTOR} JOD`}
      t={(key: string) => key}
      onOpenChange={() => {}}
      onSubmit={onSubmit}
    />
  );
}

/** The three destination boxes, in the order the screen presents them. */
function destinationInputs(): HTMLInputElement[] {
  const boxes = screen
    .getAllByRole("textbox")
    .filter((el): el is HTMLInputElement => el.tagName === "INPUT");
  // The customer-share box only exists in SPLIT mode; on CUSTOMER_ABSORBS the
  // three destinations are the only inputs besides the notes textarea.
  return boxes.slice(-3);
}

/**
 * Selected by its own label key, not by position. The dialog also renders a
 * Cancel button and an absolutely-positioned close control, and picking "the
 * last button" silently selected the wrong one.
 */
function confirmButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "ResolveGapAction" }) as HTMLButtonElement;
}

describe("the gap dialog never invents a destination the operator left blank", () => {
  test("a blank destination cannot be submitted, even when the arithmetic would reconcile", async () => {
    // The exact shape the review reproduced: the whole shortfall typed into
    // cash-to-dealer, the other two destinations untouched. Their blanks would
    // reconcile as zeros, and that is precisely what must not happen.
    const onSubmit = vi.fn(async (_values: Submitted) => {});
    renderDialog(onSubmit);

    const [cash] = destinationInputs();
    fireEvent.change(cash, { target: { value: String(GAP_MAJOR) } });

    const confirm = confirmButton();
    expect(confirm.disabled).toBe(true);

    fireEvent.click(confirm);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("the running total does not claim the allocation is complete while a box is blank", async () => {
    // The defect the FIRST fix introduced, and the reason the previous suite
    // could not see it: those tests asserted only that Confirm was disabled.
    //
    // Making a blank box null brought a previously dead `?? 0` in the DISPLAY
    // sum to life, where it meant something the submit path does not accept —
    // a blank counted as nothing allocated. So the natural entry (whole gap in
    // one box) rendered "still to allocate: 0", the calm everything-agrees
    // state, next to a dead Confirm button with nothing explaining why. The
    // one figure whose job is to say whether the operator is finished told
    // them they were.
    const onSubmit = vi.fn(async (_values: Submitted) => {});
    renderDialog(onSubmit);

    const [cash] = destinationInputs();
    fireEvent.change(cash, { target: { value: String(GAP_MAJOR) } });

    expect(confirmButton().disabled).toBe(true);
    // No total is claimed, and the remedy is named.
    expect(screen.queryByText("GapStillToAllocate")).toBeNull();
    expect(screen.getByText("GapDestinationsIncomplete")).toBeTruthy();
  });

  test("the running total reappears once every destination is decided", async () => {
    // The control: the incomplete message must not become permanent furniture.
    const onSubmit = vi.fn(async (_values: Submitted) => {});
    renderDialog(onSubmit);

    const [cash, installments, toFinanceCompany] = destinationInputs();
    fireEvent.change(cash, { target: { value: String(GAP_MAJOR) } });
    fireEvent.change(installments, { target: { value: "0" } });
    fireEvent.change(toFinanceCompany, { target: { value: "0" } });

    expect(screen.queryByText("GapDestinationsIncomplete")).toBeNull();
    expect(screen.getByText("GapStillToAllocate")).toBeTruthy();
  });

  test("a SPLIT holding the whole gap explains itself instead of showing a calm zero", async () => {
    // Both SPLIT endpoints reconcile perfectly, which is exactly why they were
    // invisible: 1,000 of a 1,000 gap allocated 1,000/0/0 leaves nothing over,
    // so the screen showed "still to account for 0" while Confirm stayed dead
    // and silent. The remedy here is the OTHER radio, not a different number,
    // so the message has to say that.
    const onSubmit = vi.fn(async (_values: Submitted) => {});
    renderDialog(onSubmit);

    fireEvent.click(screen.getByText("GapSplit"));
    const share = screen.getAllByRole("textbox")[0] as HTMLInputElement;
    fireEvent.change(share, { target: { value: String(GAP_MAJOR) } });
    const [cash, installments, toFinanceCompany] = destinationInputs();
    fireEvent.change(cash, { target: { value: String(GAP_MAJOR) } });
    fireEvent.change(installments, { target: { value: "0" } });
    fireEvent.change(toFinanceCompany, { target: { value: "0" } });

    expect(confirmButton().disabled).toBe(true);
    expect(screen.queryByText("GapStillToAllocate")).toBeNull();
    expect(screen.getByText("GapSplitIsWholeGap")).toBeTruthy();
  });

  test("a SPLIT leaving the customer nothing names the forbidden outcome", async () => {
    // The inverse endpoint, and the one the server refuses outright: a split
    // giving the customer zero IS the dealer-only outcome under another name.
    // 0/0/0 also reconciles, so it too showed a calm zero.
    const onSubmit = vi.fn(async (_values: Submitted) => {});
    renderDialog(onSubmit);

    fireEvent.click(screen.getByText("GapSplit"));
    const share = screen.getAllByRole("textbox")[0] as HTMLInputElement;
    fireEvent.change(share, { target: { value: "0" } });
    const [cash, installments, toFinanceCompany] = destinationInputs();
    fireEvent.change(cash, { target: { value: "0" } });
    fireEvent.change(installments, { target: { value: "0" } });
    fireEvent.change(toFinanceCompany, { target: { value: "0" } });

    expect(confirmButton().disabled).toBe(true);
    expect(screen.queryByText("GapStillToAllocate")).toBeNull();
    expect(screen.getByText("GapSplitLeavesCustomerNothing")).toBeTruthy();
    fireEvent.click(confirmButton());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("a partially filled allocation is still refused", async () => {
    // Two of three decided. The remaining blank is not "zero by implication".
    const onSubmit = vi.fn(async (_values: Submitted) => {});
    renderDialog(onSubmit);

    const [cash, installments] = destinationInputs();
    fireEvent.change(cash, { target: { value: "600" } });
    fireEvent.change(installments, { target: { value: "400" } });

    expect(confirmButton().disabled).toBe(true);
    fireEvent.click(confirmButton());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("an explicitly typed 0 IS a decision and submits", async () => {
    // The positive control. Without it the fix could have been "require a
    // non-zero in every box", which would make a genuine all-to-cash
    // settlement unrecordable — a different defect.
    const onSubmit = vi.fn(async (_values: Submitted) => {});
    renderDialog(onSubmit);

    const [cash, installments, toFinanceCompany] = destinationInputs();
    fireEvent.change(cash, { target: { value: String(GAP_MAJOR) } });
    fireEvent.change(installments, { target: { value: "0" } });
    fireEvent.change(toFinanceCompany, { target: { value: "0" } });

    const confirm = confirmButton();
    expect(confirm.disabled).toBe(false);

    fireEvent.click(confirm);
    expect(onSubmit).toHaveBeenCalledTimes(1);

    const values = onSubmit.mock.calls[0][0];
    expect(values.customerGapCashToDealerMinor).toBe(GAP_MINOR);
    expect(values.customerGapInstallmentToDealerMinor).toBe(0);
    expect(values.customerGapToFinanceCompanyMinor).toBe(0);
    // The customer absorbs the whole shortfall, so nothing falls to the dealer.
    expect(values.customerGapShareMinor).toBe(GAP_MINOR);
    expect(values.dealerGapShareMinor).toBe(0);
  });

  test("an explicit 0 to the dealership and the whole share to the financier submits", async () => {
    // The accounting-significant direction: the customer settles the shortfall
    // with the finance company, so NO dealer proceeds arise. This must be
    // recordable, and it must be distinguishable from nobody having said.
    const onSubmit = vi.fn(async (_values: Submitted) => {});
    renderDialog(onSubmit);

    const [cash, installments, toFinanceCompany] = destinationInputs();
    fireEvent.change(cash, { target: { value: "0" } });
    fireEvent.change(installments, { target: { value: "0" } });
    fireEvent.change(toFinanceCompany, { target: { value: String(GAP_MAJOR) } });

    fireEvent.click(confirmButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);

    const values = onSubmit.mock.calls[0][0];
    expect(values.customerGapCashToDealerMinor).toBe(0);
    expect(values.customerGapInstallmentToDealerMinor).toBe(0);
    expect(values.customerGapToFinanceCompanyMinor).toBe(GAP_MINOR);
  });
});
