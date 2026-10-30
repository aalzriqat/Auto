/**
 * SCRUM-858 S1 (owner ruling SCRUM-858#c23884): what an accountant and an operator SEE for a named
 * opening deposit. jsdom renders only; these tests do not show pixels, wrapping or real RTL layout.
 * The refusal that actually blocks a refund is server-side (convex/openingNamedDeposits.scrum858.test.ts).
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const language = { locale: "en" as "en" | "ar" };
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: language.locale === "ar", locale: language.locale }),
}));
vi.mock("@/components/accounting/AccountingTabShared", () => ({
  scaleForCurrency: (code: string) => (["JOD", "KWD", "BHD", "OMR"].includes(code) ? 3 : 2),
  errorMessage: (error: unknown) => String(error),
}));

import { OpeningBalanceApprovalView, type PendingOpeningBalanceDraft } from "./OpeningBalanceApprovalPanel";
import { OpeningDepositActionsDisabled, OpeningDepositBadge, isOpeningOriginDeposit } from "@/components/deposits/OpeningDepositMarkers";

const SCALE = 1_000;
function draftWith(allocation: Record<string, unknown>): PendingOpeningBalanceDraft {
  return {
    _id: "obd_1", asOfDate: Date.UTC(2026, 6, 1), memo: "Cutover", createdBy: "user_accountant",
    preparedByName: "Layla Haddad", currency: "JOD", denominationKnown: true,
    lines: [
      { accountId: "acc_bank", accountCode: "1010", accountName: "Bank", debitMinor: 1_000 * SCALE, creditMinor: 0 },
      { accountId: "acc_dep", accountCode: "2100", accountName: "Customer deposits", debitMinor: 0, creditMinor: 1_000 * SCALE },
    ],
    allocationDetails: [allocation as never],
  };
}
const deposit = { rowKey: "dep-1", kind: "CUSTOMER_DEPOSIT" as const, accountId: "acc_dep", accountCode: "2100",
  accountName: "Customer deposits", partyId: "customer_1", partyName: "Synthetic customer", partyDetail: "•••4567",
  partyAvailable: true, amountMinor: 500 * SCALE, title: "Reservation taken before launch" };

afterEach(() => { cleanup(); language.locale = "en"; });

describe("approval panel shows a named opening deposit", () => {
  test.each(["en", "ar"] as const)("the reviewer sees the customer, the deposit type, the named car and the amount (%s)", (locale) => {
    language.locale = locale;
    render(<OpeningBalanceApprovalView isOwnDraft={false} busy={false} onApprove={vi.fn()} onReject={vi.fn()}
      draft={draftWith({ ...deposit, depositKind: "RESERVATION", depositVehicleLabel: "VIN123 2024 Example Car" })} />);
    expect(screen.getByText("OpeningAllocationKind_CUSTOMER_DEPOSIT")).toBeTruthy();
    expect(screen.getByText("Synthetic customer")).toBeTruthy();
    expect(screen.getByText(/OpeningDepositType_RESERVATION/)).toBeTruthy();
    expect(screen.getByText("VIN123 2024 Example Car")).toBeTruthy();
    expect(screen.getByText("Reservation taken before launch")).toBeTruthy();
    expect(screen.getByTestId("opening-balance-approve").hasAttribute("disabled")).toBe(false);
  });

  test("a reservation without a car reads as customer credit; a security deposit shows no car line", () => {
    const { rerender } = render(<OpeningBalanceApprovalView isOwnDraft={false} busy={false} onApprove={vi.fn()} onReject={vi.fn()}
      draft={draftWith({ ...deposit, depositKind: "RESERVATION" })} />);
    expect(screen.getByText("OpeningDepositNoVehicle")).toBeTruthy();
    rerender(<OpeningBalanceApprovalView isOwnDraft={false} busy={false} onApprove={vi.fn()} onReject={vi.fn()}
      draft={draftWith({ ...deposit, depositKind: "SECURITY" })} />);
    expect(screen.getByText(/OpeningDepositType_SECURITY/)).toBeTruthy();
    expect(screen.queryByText("OpeningDepositNoVehicle")).toBeNull();
  });

  test("a named car from another organisation reads as unavailable and a missing customer blocks approval", () => {
    const { rerender } = render(<OpeningBalanceApprovalView isOwnDraft={false} busy={false} onApprove={vi.fn()} onReject={vi.fn()}
      draft={draftWith({ ...deposit, depositKind: "RESERVATION", depositVehicleLabel: null })} />);
    expect(screen.getByText("OpeningAllocationPartyUnavailable")).toBeTruthy();
    rerender(<OpeningBalanceApprovalView isOwnDraft={false} busy={false} onApprove={vi.fn()} onReject={vi.fn()}
      draft={draftWith({ ...deposit, depositKind: "SECURITY", partyName: null, partyAvailable: false })} />);
    expect(screen.getByTestId("opening-balance-approve").hasAttribute("disabled")).toBe(true);
  });
});

describe("deposits list markers", () => {
  test("only an opening-origin deposit is treated as opening", () => {
    expect(isOpeningOriginDeposit({ origin: "OPENING" })).toBe(true);
    expect(isOpeningOriginDeposit({})).toBe(false);
    expect(isOpeningOriginDeposit({ origin: null })).toBe(false);
  });

  test.each(["en", "ar"] as const)("the badge and the disabled refund controls carry the localized pilot reason (%s)", (locale) => {
    language.locale = locale;
    render(<><OpeningDepositBadge /><OpeningDepositActionsDisabled /></>);
    expect(screen.getByTestId("opening-deposit-badge").textContent).toBe("OpeningDepositBadge");
    const refund = screen.getByRole("button", { name: "Refund" });
    const forfeit = screen.getByRole("button", { name: "Forfeit" });
    expect(refund.hasAttribute("disabled")).toBe(true);
    expect(forfeit.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("note").textContent).toBe("OpeningDepositActionsUnavailable");
  });
});
