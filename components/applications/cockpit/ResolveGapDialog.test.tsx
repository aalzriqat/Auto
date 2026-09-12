/**
 * The appraisal-gap dialog on its own (SCRUM-83).
 *
 * What these pin, and why each matters to the money:
 *
 *  - a BLANK destination is not a zero — the screen never invents a decision
 *    the operator did not make about where the customer's part is paid;
 *  - the readiness message and the Confirm button are driven by ONE verdict,
 *    so a dead button is always explained and never contradicted by a calm
 *    "all placed" line;
 *  - the SPLIT endpoints are named as the OTHER options rather than accepted as
 *    a split that is not one;
 *  - the dealership absorbing everything is an ordinary choice with nothing to
 *    type — zeros by arithmetic, not by default;
 *  - the stamp submitted is the one the dialog OPENED against, so a deal
 *    moving underneath an open dialog cannot be allocated against by accident;
 *  - the recorded quotation, the approved amount and the gap are shown from
 *    the server's figures, or withheld with a dash when the caller cannot see
 *    them.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// The shadcn dialog primitives read the language provider for direction.
const language = vi.hoisted(() => ({ rtl: false }));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: language.rtl, locale: language.rtl ? "ar" : "en" }),
}));

import { ResolveGapDialog } from "./ResolveGapDialog";

afterEach(() => cleanup());

/** JOD: three minor units per major, which is where a scale bug would show. */
const FACTOR = 1_000;
const GAP_MAJOR = 1_000;
const GAP_MINOR = GAP_MAJOR * FACTOR;

type Props = React.ComponentProps<typeof ResolveGapDialog>;
type Submitted = Parameters<Props["onSubmit"]>[0];

function props(overrides: Partial<Props> = {}): Props {
  return {
    open: true,
    submitting: false,
    rawAppraisalGapMinor: GAP_MINOR,
    submittedQuotationMinor: 12_500 * FACTOR,
    approvedPurchaseAmountMinor: 11_500 * FACTOR,
    economicsStamp: "v2|3",
    factor: FACTOR,
    money: (minor: number) => `${(minor / FACTOR).toLocaleString("en-US")} JOD`,
    t: (key: string) => key,
    onOpenChange: () => {},
    onSubmit: async () => {},
    ...overrides,
  };
}

function renderDialog(overrides: Partial<Props> = {}) {
  return render(<ResolveGapDialog {...props(overrides)} />);
}

const input = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const radio = (name: RegExp) => screen.getByRole("radio", { name });
const confirmButton = () =>
  screen.getByRole("button", { name: "ResolveGapAction" }) as HTMLButtonElement;
const readiness = () => screen.getByTestId("gap-readiness").textContent;

describe("the figures the agreement is about", () => {
  test("shows the recorded quotation, the approved amount and the exact gap from the server's figures", () => {
    renderDialog();
    const figures = screen.getByTestId("gap-figures").textContent ?? "";
    expect(figures).toContain("GapRecordedQuotation");
    expect(figures).toContain("12,500 JOD");
    expect(figures).toContain("GapApprovedAmount");
    expect(figures).toContain("11,500 JOD");
    expect(screen.getByTestId("gap-amount").textContent).toBe("1,000 JOD");
  });

  test("withholds the context figures with a dash when the caller cannot see them — the gap itself still shows", () => {
    renderDialog({ submittedQuotationMinor: null, approvedPurchaseAmountMinor: null });
    const figures = screen.getByTestId("gap-figures").textContent ?? "";
    expect(figures).toContain("—");
    expect(figures).not.toContain("12,500");
    expect(screen.getByTestId("gap-amount").textContent).toBe("1,000 JOD");
  });
});

describe("the dialog never invents a destination the operator left blank", () => {
  test("a blank destination cannot be submitted, even when the arithmetic would reconcile", () => {
    const onSubmit = vi.fn<(values: Submitted) => Promise<void>>(async () => {});
    renderDialog({ onSubmit });
    // The whole share into cash, the other two left blank: the sum "works",
    // and the submission is still refused.
    fireEvent.change(input("GapCashToDealer"), { target: { value: String(GAP_MAJOR) } });
    expect(confirmButton().disabled).toBe(true);
    expect(readiness()).toBe("GapDestinationsIncomplete");
    fireEvent.click(confirmButton());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("an explicitly typed 0 IS a decision and submits", () => {
    const onSubmit = vi.fn<(values: Submitted) => Promise<void>>(async () => {});
    renderDialog({ onSubmit });
    fireEvent.change(input("GapCashToDealer"), { target: { value: String(GAP_MAJOR) } });
    fireEvent.change(input("GapInstallmentsToDealer"), { target: { value: "0" } });
    fireEvent.change(input("GapToFinanceCompany"), { target: { value: "0" } });
    expect(readiness()).toBe("GapAllocationComplete");
    fireEvent.click(confirmButton());
    expect(onSubmit).toHaveBeenCalledWith({
      customerGapShareMinor: GAP_MINOR,
      dealerGapShareMinor: 0,
      customerGapCashToDealerMinor: GAP_MINOR,
      customerGapInstallmentToDealerMinor: 0,
      customerGapToFinanceCompanyMinor: 0,
      notes: "",
      economicsStamp: "v2|3",
    });
  });

  test("the whole share paid to the financier is recorded as exactly that — never as dealer money", () => {
    const onSubmit = vi.fn<(values: Submitted) => Promise<void>>(async () => {});
    renderDialog({ onSubmit });
    fireEvent.change(input("GapCashToDealer"), { target: { value: "0" } });
    fireEvent.change(input("GapInstallmentsToDealer"), { target: { value: "0" } });
    fireEvent.change(input("GapToFinanceCompany"), { target: { value: String(GAP_MAJOR) } });
    fireEvent.click(confirmButton());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      customerGapCashToDealerMinor: 0,
      customerGapInstallmentToDealerMinor: 0,
      customerGapToFinanceCompanyMinor: GAP_MINOR,
    });
  });

  test("destinations that do not add up to the customer's part are named, not silently blocked", () => {
    renderDialog();
    fireEvent.change(input("GapCashToDealer"), { target: { value: "600" } });
    fireEvent.change(input("GapInstallmentsToDealer"), { target: { value: "0" } });
    fireEvent.change(input("GapToFinanceCompany"), { target: { value: "300" } });
    expect(confirmButton().disabled).toBe(true);
    expect(readiness()).toBe("GapAllocationMismatch");
  });
});

describe("who covers it", () => {
  test("a SPLIT holding the whole gap says to pick customer-absorbs instead of showing a calm zero", () => {
    renderDialog();
    fireEvent.click(radio(/^GapSplit/));
    fireEvent.change(input("GapCustomerShare"), { target: { value: String(GAP_MAJOR) } });
    expect(confirmButton().disabled).toBe(true);
    expect(readiness()).toBe("GapSplitIsWholeGap");
  });

  test("a SPLIT leaving the customer nothing says to pick dealer-absorbs instead", () => {
    renderDialog();
    fireEvent.click(radio(/^GapSplit/));
    fireEvent.change(input("GapCustomerShare"), { target: { value: "0" } });
    expect(confirmButton().disabled).toBe(true);
    expect(readiness()).toBe("GapSplitLeavesCustomerNothing");
  });

  test("a real SPLIT derives the dealership's part and submits both", () => {
    const onSubmit = vi.fn<(values: Submitted) => Promise<void>>(async () => {});
    renderDialog({ onSubmit });
    fireEvent.click(radio(/^GapSplit/));
    fireEvent.change(input("GapCustomerShare"), { target: { value: "600" } });
    expect(screen.getByText("GapDealerShare").parentElement?.textContent).toContain("400 JOD");
    fireEvent.change(input("GapCashToDealer"), { target: { value: "600" } });
    fireEvent.change(input("GapInstallmentsToDealer"), { target: { value: "0" } });
    fireEvent.change(input("GapToFinanceCompany"), { target: { value: "0" } });
    fireEvent.click(confirmButton());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      customerGapShareMinor: 600 * FACTOR,
      dealerGapShareMinor: 400 * FACTOR,
    });
  });

  test("the dealership absorbing everything needs nothing typed: no destinations, zeros by arithmetic", () => {
    const onSubmit = vi.fn<(values: Submitted) => Promise<void>>(async () => {});
    renderDialog({ onSubmit });
    fireEvent.click(radio(/GapDealerAbsorbs/));
    expect(screen.queryByLabelText("GapCashToDealer")).toBeNull();
    expect(readiness()).toBe("GapAllocationComplete");
    expect(confirmButton().disabled).toBe(false);
    fireEvent.click(confirmButton());
    expect(onSubmit).toHaveBeenCalledWith({
      customerGapShareMinor: 0,
      dealerGapShareMinor: GAP_MINOR,
      customerGapCashToDealerMinor: 0,
      customerGapInstallmentToDealerMinor: 0,
      customerGapToFinanceCompanyMinor: 0,
      notes: "",
      economicsStamp: "v2|3",
    });
  });

  test("switching from dealer-absorbs back to customer-absorbs reinstates blank-is-not-zero", () => {
    renderDialog();
    fireEvent.click(radio(/GapDealerAbsorbs/));
    expect(confirmButton().disabled).toBe(false);
    fireEvent.click(radio(/GapCustomerAbsorbs/));
    expect(confirmButton().disabled).toBe(true);
    expect(readiness()).toBe("GapDestinationsIncomplete");
  });
});

describe("the figures are a snapshot", () => {
  test("the stamp and the gap submitted are the ones the dialog OPENED against, not a later rerender's", () => {
    // A re-approval while the dialog is open moves the shortfall and issues a
    // new stamp. If the submission carried the NEW stamp, the server would be
    // told the operator had seen a revision they never saw and would accept an
    // allocation agreed against different figures.
    const onSubmit = vi.fn<(values: Submitted) => Promise<void>>(async () => {});
    const view = renderDialog({ onSubmit });
    view.rerender(
      <ResolveGapDialog
        {...props({ onSubmit, rawAppraisalGapMinor: GAP_MINOR * 2, economicsStamp: "v2|4" })}
      />
    );
    expect(screen.getByTestId("gap-amount").textContent).toBe("1,000 JOD");
    fireEvent.change(input("GapCashToDealer"), { target: { value: String(GAP_MAJOR) } });
    fireEvent.change(input("GapInstallmentsToDealer"), { target: { value: "0" } });
    fireEvent.change(input("GapToFinanceCompany"), { target: { value: "0" } });
    fireEvent.click(confirmButton());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      economicsStamp: "v2|3",
      customerGapShareMinor: GAP_MINOR,
    });
  });

  test("reopening takes a fresh snapshot and clears the previous entry", () => {
    const view = renderDialog();
    fireEvent.change(input("GapCashToDealer"), { target: { value: "700" } });
    view.rerender(<ResolveGapDialog {...props({ open: false })} />);
    view.rerender(
      <ResolveGapDialog {...props({ rawAppraisalGapMinor: 1_500 * FACTOR, economicsStamp: "v2|5" })} />
    );
    expect(screen.getByTestId("gap-amount").textContent).toBe("1,500 JOD");
    expect(input("GapCashToDealer").value).toBe("");
  });

  test("the server's refusal is shown in the dialog and the entry is kept", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("Customer share (1000000) plus dealer share (0) is 1000000, which must equal the raw appraisal gap of 1500000.");
    });
    renderDialog({ onSubmit });
    fireEvent.click(radio(/GapDealerAbsorbs/));
    fireEvent.click(confirmButton());
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("must equal the raw appraisal gap");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("Arabic, right-to-left", () => {
  test("renders every control with the Arabic keys under a RTL document direction", () => {
    document.documentElement.dir = "rtl";
    language.rtl = true;
    try {
      renderDialog({ t: (key: string) => `ع:${key}` });
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(screen.getByRole("radio", { name: /ع:GapDealerAbsorbs/ })).toBeTruthy();
      expect(screen.getByLabelText("ع:GapCashToDealer")).toBeTruthy();
      expect(screen.getByTestId("gap-amount").textContent).toBe("1,000 JOD");
      expect(document.documentElement.dir).toBe("rtl");
    } finally {
      language.rtl = false;
      document.documentElement.dir = "";
    }
  });
});
