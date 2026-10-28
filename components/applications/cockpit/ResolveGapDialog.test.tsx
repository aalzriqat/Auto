/**
 * The shortfall dialog on its own (SCRUM-83, reframed by SCRUM-766: the amount
 * settled is the NET shortfall, 850 on the 12,500 -> 11,500 at 85% worked case,
 * never the gross 1,000).
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
import { salesAr, salesEn } from "@/lib/i18n/domains/sales";

afterEach(() => cleanup());

/** JOD: three minor units per major, which is where a scale bug would show. */
const FACTOR = 1_000;
const GAP_MAJOR = 850;
const GAP_MINOR = GAP_MAJOR * FACTOR;

type Props = React.ComponentProps<typeof ResolveGapDialog>;
type Submitted = Parameters<Props["onSubmit"]>[0];

function props(overrides: Partial<Props> = {}): Props {
  return {
    open: true,
    submitting: false,
    shortfallMinor: GAP_MINOR,
    breakdown: { valuationMinor: GAP_MINOR, termsMinor: 0 },
    grossLabel: false,
    allowFinanceCompany: true,
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
    expect(screen.getByTestId("gap-amount").textContent).toBe("850 JOD");
  });

  test("a NET shortfall shows its two causes, which add up to the total; a zero cause is left out", () => {
    renderDialog({ shortfallMinor: 1_425 * FACTOR, breakdown: { valuationMinor: 850 * FACTOR, termsMinor: 575 * FACTOR } });
    expect(screen.getByTestId("gap-amount").textContent).toBe("1,425 JOD");
    expect(screen.getByTestId("gap-valuation").textContent).toBe("850 JOD");
    expect(screen.getByTestId("gap-terms").textContent).toBe("575 JOD");
    expect(screen.queryByTestId("gap-gross-note")).toBeNull();
    cleanup();
    renderDialog();
    expect(screen.getByTestId("gap-valuation").textContent).toBe("850 JOD");
    expect(screen.queryByTestId("gap-terms")).toBeNull();
  });

  test("a manual approval's gross figure carries no breakdown and says it is gross", () => {
    renderDialog({ shortfallMinor: 1_000 * FACTOR, breakdown: null, grossLabel: true });
    expect(screen.getByTestId("gap-amount").textContent).toBe("1,000 JOD");
    expect(screen.queryByTestId("gap-valuation")).toBeNull();
    expect(screen.getByTestId("gap-gross-note").textContent).toBe("GapShortfallGrossManual");
  });

  test("the customer's part can be recorded as paid to the finance company (SCRUM-766 PR-B)", () => {
    renderDialog();
    expect(screen.getByLabelText("GapToFinanceCompany")).toBeTruthy();
  });

  test("withholds the context figures with a dash when the caller cannot see them — the gap itself still shows", () => {
    renderDialog({ submittedQuotationMinor: null, approvedPurchaseAmountMinor: null });
    const figures = screen.getByTestId("gap-figures").textContent ?? "";
    expect(figures).toContain("—");
    expect(figures).not.toContain("12,500");
    expect(screen.getByTestId("gap-amount").textContent).toBe("850 JOD");
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

  test("money placed nowhere does not reconcile: 0 + 0 + 0 is a mismatch, not a submission", () => {
    const onSubmit = vi.fn<(values: Submitted) => Promise<void>>(async () => {});
    renderDialog({ onSubmit });
    fireEvent.change(input("GapCashToDealer"), { target: { value: "0" } });
    fireEvent.change(input("GapInstallmentsToDealer"), { target: { value: "0" } });
    fireEvent.change(input("GapToFinanceCompany"), { target: { value: "0" } });
    expect(readiness()).toBe("GapAllocationMismatch");
    fireEvent.click(confirmButton());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("a destination with more decimals than the currency holds is not a decision — never rounded into a reconciling figure (SCRUM-605)", () => {
    const onSubmit = vi.fn<(values: Submitted) => Promise<void>>(async () => {});
    renderDialog({ onSubmit });
    // Rounded to fils this is exactly the gap, and used to submit as such.
    fireEvent.change(input("GapCashToDealer"), { target: { value: `${GAP_MAJOR}.0004` } });
    fireEvent.change(input("GapInstallmentsToDealer"), { target: { value: "0" } });
    fireEvent.change(input("GapToFinanceCompany"), { target: { value: "0" } });
    expect(confirmButton().disabled).toBe(true);
    // Every box is filled, so "incomplete" would send the operator hunting for
    // a blank that is not there; the message names the actual problem.
    expect(readiness()).toBe("AmountTooPrecise");
    fireEvent.click(confirmButton());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("a blank destination beside a too-precise one is still reported as too precise, not hidden behind 'incomplete'", () => {
    renderDialog();
    fireEvent.change(input("GapCashToDealer"), { target: { value: `${GAP_MAJOR}.0004` } });
    expect(confirmButton().disabled).toBe(true);
    expect(readiness()).toBe("AmountTooPrecise");
  });

  test("destinations that do not add up to the customer's part are named, not silently blocked", () => {
    renderDialog();
    fireEvent.change(input("GapCashToDealer"), { target: { value: "600" } });
    fireEvent.change(input("GapInstallmentsToDealer"), { target: { value: "0" } });
    fireEvent.change(input("GapToFinanceCompany"), { target: { value: "0" } });
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

  test("a SPLIT customer share finer than the currency is named as too precise, not as missing (SCRUM-605)", () => {
    renderDialog();
    fireEvent.click(radio(/^GapSplit/));
    fireEvent.change(input("GapCustomerShare"), { target: { value: "600.0004" } });
    expect(confirmButton().disabled).toBe(true);
    expect(readiness()).toBe("AmountTooPrecise");
  });

  test("a customer part paid to the finance company submits as that destination: 400 of an 850 shortfall, the dealership covering 450", () => {
    const onSubmit = vi.fn<(values: Submitted) => Promise<void>>(async () => {});
    renderDialog({ onSubmit });
    fireEvent.click(radio(/^GapSplit/));
    fireEvent.change(input("GapCustomerShare"), { target: { value: "400" } });
    fireEvent.change(input("GapCashToDealer"), { target: { value: "0" } });
    fireEvent.change(input("GapInstallmentsToDealer"), { target: { value: "0" } });
    fireEvent.change(input("GapToFinanceCompany"), { target: { value: "400" } });
    expect(readiness()).toBe("GapAllocationComplete");
    fireEvent.click(confirmButton());
    expect(onSubmit).toHaveBeenCalledWith({
      customerGapShareMinor: 400 * FACTOR,
      dealerGapShareMinor: 450 * FACTOR,
      customerGapCashToDealerMinor: 0,
      customerGapInstallmentToDealerMinor: 0,
      customerGapToFinanceCompanyMinor: 400 * FACTOR,
      notes: "",
      economicsStamp: "v2|3",
    });
  });

  test("a manually recorded approval is not offered the finance-company box and needs no zero typed for it", () => {
    const onSubmit = vi.fn<(values: Submitted) => Promise<void>>(async () => {});
    renderDialog({ onSubmit, allowFinanceCompany: false, grossLabel: true, breakdown: null });
    expect(screen.queryByLabelText("GapToFinanceCompany")).toBeNull();
    expect(document.body.textContent).toContain("GapWhereCustomerPaysManualHint");
    fireEvent.change(input("GapCashToDealer"), { target: { value: String(GAP_MAJOR) } });
    fireEvent.change(input("GapInstallmentsToDealer"), { target: { value: "0" } });
    expect(readiness()).toBe("GapAllocationComplete");
    fireEvent.click(confirmButton());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ customerGapToFinanceCompanyMinor: 0 });
  });

  test("a finance-company amount with more decimals than the currency holds is too precise, not rounded", () => {
    renderDialog();
    fireEvent.click(radio(/^GapSplit/));
    fireEvent.change(input("GapCustomerShare"), { target: { value: "400" } });
    fireEvent.change(input("GapCashToDealer"), { target: { value: "0" } });
    fireEvent.change(input("GapInstallmentsToDealer"), { target: { value: "0" } });
    fireEvent.change(input("GapToFinanceCompany"), { target: { value: "400.0004" } });
    expect(readiness()).toBe("AmountTooPrecise");
    expect(confirmButton().disabled).toBe(true);
  });

  test("a real SPLIT derives the dealership's part and submits both", () => {
    const onSubmit = vi.fn<(values: Submitted) => Promise<void>>(async () => {});
    renderDialog({ onSubmit });
    fireEvent.click(radio(/^GapSplit/));
    fireEvent.change(input("GapCustomerShare"), { target: { value: "450" } });
    expect(screen.getByText("GapDealerShare").parentElement?.textContent).toContain("400 JOD");
    fireEvent.change(input("GapCashToDealer"), { target: { value: "450" } });
    fireEvent.change(input("GapInstallmentsToDealer"), { target: { value: "0" } });
    fireEvent.change(input("GapToFinanceCompany"), { target: { value: "0" } });
    fireEvent.click(confirmButton());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      customerGapShareMinor: 450 * FACTOR,
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
        {...props({ onSubmit, shortfallMinor: GAP_MINOR * 2, economicsStamp: "v2|4" })}
      />
    );
    expect(screen.getByTestId("gap-amount").textContent).toBe("850 JOD");
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
      <ResolveGapDialog {...props({ shortfallMinor: 1_500 * FACTOR, economicsStamp: "v2|5" })} />
    );
    expect(screen.getByTestId("gap-amount").textContent).toBe("1,500 JOD");
    expect(input("GapCashToDealer").value).toBe("");
  });

  test("the server's refusal is shown in the dialog and the entry is kept", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("Customer share (1000000) plus dealer share (0) is 1000000, which must equal the shortfall of 1500000.");
    });
    renderDialog({ onSubmit });
    fireEvent.click(radio(/GapDealerAbsorbs/));
    fireEvent.click(confirmButton());
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("must equal the shortfall");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("the supplier's concession on a SOURCED vehicle (SCRUM-766 PR-C)", () => {
  const BASIS = { entitlementMinor: 9_500 * FACTOR, currency: "JOD", supplierName: "Al Noor Motors" };
  const supplierBox = () => screen.getByLabelText(/GapSupplierConcession/) as HTMLInputElement;

  test("no basis from the server: no supplier field at all, in any mode (stock cars stay refused)", () => {
    renderDialog({ supplierBasis: null });
    expect(screen.queryByTestId("gap-supplier")).toBeNull();
    fireEvent.click(radio(/^GapSplit/));
    expect(screen.queryByTestId("gap-supplier")).toBeNull();
    fireEvent.click(radio(/GapDealerAbsorbs/));
    expect(screen.queryByTestId("gap-supplier")).toBeNull();
  });

  test("with a basis the field is offered when the dealership bears some of it, never when the customer covers it all", () => {
    renderDialog({ supplierBasis: BASIS });
    expect(screen.queryByTestId("gap-supplier")).toBeNull();
    fireEvent.click(radio(/^GapSplit/));
    expect(screen.getByTestId("gap-supplier")).toBeTruthy();
    expect(screen.getByTestId("gap-supplier-entitlement").textContent).toBe("9,500 JOD");
    fireEvent.click(radio(/GapDealerAbsorbs/));
    expect(screen.getByTestId("gap-supplier")).toBeTruthy();
    fireEvent.click(radio(/GapCustomerAbsorbs/));
    expect(screen.queryByTestId("gap-supplier")).toBeNull();
  });

  test("blank is no concession: the request carries no supplier keys at all", () => {
    const onSubmit = vi.fn<(values: Submitted) => Promise<void>>(async () => {});
    renderDialog({ onSubmit, supplierBasis: BASIS });
    fireEvent.click(radio(/GapDealerAbsorbs/));
    expect(readiness()).toBe("GapAllocationComplete");
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

  test("dealer-absorbs with a 300 concession on an 850 shortfall: the dealership covers 550 and the observed basis rides along", () => {
    const onSubmit = vi.fn<(values: Submitted) => Promise<void>>(async () => {});
    renderDialog({ onSubmit, supplierBasis: BASIS });
    fireEvent.click(radio(/GapDealerAbsorbs/));
    fireEvent.change(supplierBox(), { target: { value: "300" } });
    expect(screen.getByTestId("gap-dealer-remainder").textContent).toBe("550 JOD");
    expect(readiness()).toBe("GapAllocationComplete");
    fireEvent.click(confirmButton());
    expect(onSubmit).toHaveBeenCalledWith({
      customerGapShareMinor: 0,
      dealerGapShareMinor: 550 * FACTOR,
      customerGapCashToDealerMinor: 0,
      customerGapInstallmentToDealerMinor: 0,
      customerGapToFinanceCompanyMinor: 0,
      supplierGapShareMinor: 300 * FACTOR,
      observedSupplierEntitlementMinor: 9_500 * FACTOR,
      observedSupplierName: "Al Noor Motors",
      notes: "",
      economicsStamp: "v2|3",
    });
  });

  test("a split takes three parts: customer 400 + supplier 300 + dealership 150 = 850", () => {
    const onSubmit = vi.fn<(values: Submitted) => Promise<void>>(async () => {});
    renderDialog({ onSubmit, supplierBasis: BASIS });
    fireEvent.click(radio(/^GapSplit/));
    fireEvent.change(input("GapCustomerShare"), { target: { value: "400" } });
    fireEvent.change(supplierBox(), { target: { value: "300" } });
    expect(screen.getByText("GapDealerShare").parentElement?.textContent).toContain("150 JOD");
    fireEvent.change(input("GapCashToDealer"), { target: { value: "400" } });
    fireEvent.change(input("GapInstallmentsToDealer"), { target: { value: "0" } });
    fireEvent.change(input("GapToFinanceCompany"), { target: { value: "0" } });
    expect(readiness()).toBe("GapAllocationComplete");
    fireEvent.click(confirmButton());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      customerGapShareMinor: 400 * FACTOR,
      dealerGapShareMinor: 150 * FACTOR,
      supplierGapShareMinor: 300 * FACTOR,
    });
  });

  test("shares that overshoot the shortfall are a mismatch, not a submission", () => {
    const onSubmit = vi.fn<(values: Submitted) => Promise<void>>(async () => {});
    renderDialog({ onSubmit, supplierBasis: BASIS });
    fireEvent.click(radio(/GapDealerAbsorbs/));
    fireEvent.change(supplierBox(), { target: { value: "900" } });
    expect(confirmButton().disabled).toBe(true);
    expect(readiness()).toBe("GapAllocationMismatch");
    fireEvent.click(confirmButton());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  test("a concession that is not a usable figure, or is finer than the currency, is named and blocks", () => {
    renderDialog({ supplierBasis: BASIS });
    fireEvent.click(radio(/GapDealerAbsorbs/));
    fireEvent.change(supplierBox(), { target: { value: "abc" } });
    expect(confirmButton().disabled).toBe(true);
    expect(readiness()).toBe("GapSupplierInvalid");
    fireEvent.change(supplierBox(), { target: { value: "300.0004" } });
    expect(confirmButton().disabled).toBe(true);
    expect(readiness()).toBe("AmountTooPrecise");
  });

  test("a concession that is not smaller than the entitlement is refused before the server is asked", () => {
    renderDialog({ supplierBasis: { ...BASIS, entitlementMinor: 200 * FACTOR } });
    fireEvent.click(radio(/GapDealerAbsorbs/));
    fireEvent.change(supplierBox(), { target: { value: "200" } });
    expect(confirmButton().disabled).toBe(true);
    expect(readiness()).toBe("GapSupplierTooLarge");
  });

  test("the observed basis is the one the dialog OPENED against, not a later rerender's", () => {
    const onSubmit = vi.fn<(values: Submitted) => Promise<void>>(async () => {});
    const view = renderDialog({ onSubmit, supplierBasis: BASIS });
    view.rerender(
      <ResolveGapDialog
        {...props({ onSubmit, supplierBasis: { ...BASIS, entitlementMinor: 8_000 * FACTOR } })}
      />
    );
    fireEvent.click(radio(/GapDealerAbsorbs/));
    fireEvent.change(supplierBox(), { target: { value: "300" } });
    fireEvent.click(confirmButton());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ observedSupplierEntitlementMinor: 9_500 * FACTOR });
  });

  test("switching back to customer-absorbs drops a typed concession from the request", () => {
    renderDialog({ supplierBasis: BASIS });
    fireEvent.click(radio(/GapDealerAbsorbs/));
    fireEvent.change(supplierBox(), { target: { value: "300" } });
    fireEvent.click(radio(/GapCustomerAbsorbs/));
    // Back in customer-absorbs the gap is the customer's alone; the readiness
    // is about the destinations, not about a hidden supplier box.
    expect(readiness()).toBe("GapDestinationsIncomplete");
  });
});

/**
 * Both seats (PR #697 review): with "the dealership covers it" selected and a supplier
 * concession of 850 on an 850 shortfall, the server records SUPPLIER_ABSORBS and the
 * dealership share is 0, yet the option still said the dealership covers the whole
 * difference. The option's text must follow the allocation actually being submitted, in
 * English and in Arabic. These use the REAL dictionaries, not key echoes, because the
 * defect was in the sentence, not in the key.
 */
describe.each([
  ["English", salesEn],
  ["Arabic", salesAr],
] as const)("the no-customer-part option tells the truth about who covers the shortfall (%s)", (_name, dict) => {
  const BASIS = { entitlementMinor: 9_500 * FACTOR, currency: "JOD", supplierName: "Al Noor Motors" };
  const words = dict as Record<string, string>;
  const t = (key: string) => words[key] ?? key;
  const optionText = () => document.getElementById("gap-mode-DEALER_ABSORBS")?.textContent ?? "";
  const supplierBox = () => screen.getByTestId("gap-supplier").querySelector("input") as HTMLInputElement;
  const open = () => {
    renderDialog({ supplierBasis: BASIS, t });
    fireEvent.click(document.getElementById("gap-mode-DEALER_ABSORBS") as HTMLElement);
  };

  test("no supplier share: the dealership covers the whole difference, and the option says so", () => {
    open();
    expect(optionText()).toContain(words.GapDealerAbsorbs);
    expect(optionText()).toContain(words.GapDealerAbsorbsHint);
  });

  test("a partial supplier share (300 of 850): the option no longer claims the dealership covers the whole difference", () => {
    open();
    fireEvent.change(supplierBox(), { target: { value: "300" } });
    expect(screen.getByTestId("gap-dealer-remainder").textContent).toBe("550 JOD");
    expect(optionText()).not.toContain(words.GapDealerAbsorbs);
    expect(optionText()).not.toContain(words.GapDealerAbsorbsHint);
    expect(optionText()).toContain(words.GapNoCustomerPart);
    expect(optionText()).toContain(words.GapNoCustomerPartHintShared);
  });

  test("the supplier covers the whole shortfall (850 of 850): the option says the dealership covers nothing", () => {
    open();
    fireEvent.change(supplierBox(), { target: { value: String(GAP_MAJOR) } });
    expect(screen.getByTestId("gap-dealer-remainder").textContent).toBe("0 JOD");
    expect(optionText()).not.toContain(words.GapDealerAbsorbs);
    expect(optionText()).not.toContain(words.GapDealerAbsorbsHint);
    expect(optionText()).toContain(words.GapNoCustomerPart);
    expect(optionText()).toContain(words.GapNoCustomerPartHintSupplier);
  });

  test("clearing the supplier share restores the dealership-covers-it wording", () => {
    open();
    fireEvent.change(supplierBox(), { target: { value: "300" } });
    fireEvent.change(supplierBox(), { target: { value: "" } });
    expect(optionText()).toContain(words.GapDealerAbsorbsHint);
  });

  test("the wording keys exist and differ, so the test above cannot pass on identical or missing text", () => {
    for (const key of ["GapNoCustomerPart", "GapNoCustomerPartHintShared", "GapNoCustomerPartHintSupplier"]) {
      expect(words[key]).toBeTruthy();
    }
    expect(new Set([words.GapDealerAbsorbsHint, words.GapNoCustomerPartHintShared, words.GapNoCustomerPartHintSupplier]).size).toBe(3);
  });
});

describe("Arabic, right-to-left", () => {
  /**
   * The direction asserted is the one the COMPONENT derives: `DialogContent`
   * reads `useLanguage().isRtl` and sets `dir` on the dialog element itself.
   * An earlier version of this test assigned `document.documentElement.dir`
   * and then read it back — an assertion that could not fail whatever the
   * dialog did (Codex-high LOW on 229608039). The LTR control below is what
   * makes the RTL assertion falsifiable.
   */
  test("renders every control with the Arabic keys, and the dialog itself is laid out right-to-left", () => {
    language.rtl = true;
    try {
      renderDialog({ t: (key: string) => `ع:${key}` });
      const dialog = screen.getByRole("dialog");
      expect(dialog.getAttribute("dir")).toBe("rtl");
      expect(screen.getByRole("radio", { name: /ع:GapDealerAbsorbs/ })).toBeTruthy();
      expect(screen.getByLabelText("ع:GapCashToDealer")).toBeTruthy();
      // Figures stay isolated from the surrounding direction: the amount is a
      // <bdi>, so "850 JOD" reads the same way in either.
      const amount = screen.getByTestId("gap-amount");
      expect(amount.tagName).toBe("BDI");
      expect(amount.textContent).toBe("850 JOD");
    } finally {
      language.rtl = false;
    }
  });

  test("the same dialog is laid out left-to-right in English (control)", () => {
    language.rtl = false;
    renderDialog();
    expect(screen.getByRole("dialog").getAttribute("dir")).toBe("ltr");
  });
});
