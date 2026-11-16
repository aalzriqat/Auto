// @vitest-environment jsdom
/** SCRUM-956 c25206: component behavior only. Rendered browser proof is still required. */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import type { Id } from "@/convex/_generated/dataModel";
import { LanguageProvider } from "@/components/providers/LanguageProvider";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { OPENING_REFUND_BANK_PILOT_DISABLED_MESSAGE } from "@/convex/utils/openingDepositContainment";
import { OpeningDepositRefundDialog } from "./OpeningDepositRefundDialog";
import { OpeningRefundReturnDialog } from "@/components/accounting/bankAccounts/OpeningRefundReturnDialog";

const state = vi.hoisted(() => ({
  reserve: vi.fn(), record: vi.fn(), cancel: vi.fn(), recover: vi.fn(), bankReturn: vi.fn(),
  reservation: undefined as { reservationKey: string; method: "CASH" | "BANK_TRANSFER"; bankAccountName?: string } | null | undefined,
}));
// Convex transport is the boundary; actual language, dictionaries, form and pilot switch are shipped code.
vi.mock("convex/react", () => ({
  useMutation: (reference: Parameters<typeof getFunctionName>[0]) => {
    switch (getFunctionName(reference)) {
      case "openingDepositRefunds:reserveOpeningRefund": return state.reserve;
      case "openingDepositRefunds:recordOpeningRefund": return state.record;
      case "openingDepositRefunds:cancelOpeningRefundReservation": return state.cancel;
      case "openingRefundCustody:recoverOpeningRefundCustody": return state.recover;
      case "openingRefundReturns:recordBankReturn": return state.bankReturn;
      default: throw new Error("Unexpected mutation");
    }
  },
  useQuery: (reference: Parameters<typeof getFunctionName>[0], args: unknown) =>
    args !== "skip" && getFunctionName(reference) === "openingRefundCustody:openingRefundReservation" ? state.reservation : undefined,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  state.reservation = undefined;
});

const REFUSAL = {
  en: "Opening deposit refunds are cash only during the pilot. Bank reservations, payouts and returns are unavailable. Nothing has been changed.",
  ar: "استرداد العربون الافتتاحي نقداً فقط خلال الطيار. الحجز والصرف والإرجاع عبر البنك غير متاحة. لم يتم تغيير أي شيء.",
};
const orgId = "synthetic-org" as Id<"organizations">;
const depositId = "synthetic-deposit" as Id<"deposits">;

describe.each(["en", "ar"] as const)("956 cash-only web convenience in %s", locale => {
  const text = dictionaries[locale];
  function show(reserved = false) {
    vi.stubGlobal("localStorage", { getItem: () => locale, setItem: () => {} });
    return render(<LanguageProvider><OpeningDepositRefundDialog orgId={orgId} depositId={depositId}
      amountLabel="100.00 USD" currency="USD" reserved={reserved} onClose={() => {}} /></LanguageProvider>);
  }

  test("offers cash only and localizes the server coded refusal", async () => {
    state.reserve.mockRejectedValueOnce(new ConvexError({ code: "OPENING_REFUND_BANK_PILOT_DISABLED", message: OPENING_REFUND_BANK_PILOT_DISABLED_MESSAGE }));
    show();
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(screen.getByRole("radio", { name: text.Cash })).toBeTruthy();
    expect(screen.queryByRole("radio", { name: text.OpeningDepositRefundBankTransfer })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: text.OpeningDepositReserveRefund }));
    expect((await screen.findByRole("alert")).textContent).toBe(REFUSAL[locale]);
    expect(state.reserve.mock.calls[0]?.[0]).toMatchObject({ method: "CASH", bankAccountId: undefined });
    expect(dictionaries.en.ServerError_OPENING_REFUND_BANK_PILOT_DISABLED).toBe(OPENING_REFUND_BANK_PILOT_DISABLED_MESSAGE);
  });

  test("keeps the old bank reservation cancellable while payout stays disabled", async () => {
    state.reservation = { reservationKey: "old-bank", method: "BANK_TRANSFER", bankAccountName: "Synthetic bank" };
    state.cancel.mockResolvedValueOnce(null);
    show(true);
    expect(screen.getByRole("alert").textContent).toBe(REFUSAL[locale]);
    expect(screen.getByRole("button", { name: text.OpeningDepositRecordRefund }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: text.OpeningDepositRefundCancelReservation }));
    fireEvent.change(screen.getByLabelText(text.OpeningDepositRefundCancelReason), { target: { value: "Synthetic unpaid cancellation" } });
    fireEvent.click(screen.getByRole("button", { name: text.OpeningDepositRefundConfirmUnpaid }));
    expect(state.cancel.mock.calls[0]?.[0]).toMatchObject({ reservationKey: "old-bank", confirmedUnpaid: true });
    expect(state.record).not.toHaveBeenCalled();
  });

  test("bank return shows the pilot refusal and cannot submit even after evidence entry", () => {
    vi.stubGlobal("localStorage", { getItem: () => locale, setItem: () => {} });
    render(<LanguageProvider><OpeningRefundReturnDialog orgId={orgId}
      line={{ id: "synthetic-statement" as Id<"bankStatementLines">, description: "Synthetic credit", amountLabel: "100.00 USD" }}
      onClose={() => {}} /></LanguageProvider>);
    expect(screen.getByRole("alert").textContent).toBe(REFUSAL[locale]);
    fireEvent.change(screen.getByLabelText(text.OpeningRefundOriginalTransferReference), { target: { value: "PAY-956" } });
    fireEvent.change(screen.getByLabelText(text.OpeningRefundBankReturnReference), { target: { value: "RETURN-956" } });
    fireEvent.change(screen.getByLabelText(text.OpeningRefundIndependentEvidenceReference), { target: { value: "BANK-FILE" } });
    fireEvent.click(screen.getByLabelText(text.OpeningRefundIndependentEvidenceConfirmed));
    const submit = screen.getByRole("button", { name: text.OpeningRefundRecordBankReturn });
    expect(submit.hasAttribute("disabled")).toBe(true);
    fireEvent.click(submit);
    expect(state.bankReturn).not.toHaveBeenCalled();
  });
});
