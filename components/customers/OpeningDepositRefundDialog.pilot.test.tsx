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
  reservation: undefined as { reservationKey: unknown; method: "CASH" | "BANK_TRANSFER"; bankAccountName?: string; canRecover?: boolean } | null | undefined,
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
  ar: "استرداد العربون الافتتاحي نقداً فقط خلال المرحلة التجريبية. الحجز والصرف والإرجاع عبر البنك غير متاحة. لم يتم تغيير أي شيء.",
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

  test.each([
    [undefined, "Loading"], [null, "OpeningDepositRefundHeldByApprover"],
  ] as const)("preserves the unnamed live status for reservation %s", (reservation, key) => {
    state.reservation = reservation;
    show(true);
    const status = screen.getByRole("status", { name: "" });
    expect(status.textContent).toBe(text[key]);
    expect(screen.getByRole("button", { name: text.OpeningDepositRecordRefund }).hasAttribute("disabled")).toBe(true);
  });

  test("recovery takes priority over cancellation and saving takes priority over recovery", async () => {
    state.reservation = { reservationKey: "old-bank", method: "BANK_TRANSFER" };
    const view = show(true);
    fireEvent.click(screen.getByRole("button", { name: text.OpeningDepositRefundCancelReservation }));
    state.reservation = { ...state.reservation, canRecover: true };
    view.rerender(<LanguageProvider><OpeningDepositRefundDialog orgId={orgId} depositId={depositId}
      amountLabel="100.00 USD" currency="USD" reserved onClose={() => {}} /></LanguageProvider>);
    fireEvent.change(screen.getByLabelText(text.OpeningDepositRefundRecoveryReason), { target: { value: "Synthetic control transfer" } });
    let finishRecovery: (() => void) | undefined;
    state.recover.mockImplementationOnce(() => new Promise<void>(resolve => { finishRecovery = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: text.OpeningDepositRefundConfirmCustody }));
    expect(screen.getByRole("button", { name: text.Saving }).hasAttribute("disabled")).toBe(true);
    expect(state.recover.mock.calls[0]?.[0]).toMatchObject({ expectedReservationKey: "old-bank", reason: "Synthetic control transfer" });
    expect(state.cancel).not.toHaveBeenCalled();
    expect(state.record).not.toHaveBeenCalled();
    finishRecovery?.();
    await screen.findByRole("button", { name: text.OpeningDepositRefundConfirmCustody });
  });

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

  test("shows the localized payout time refusal and retains the operator's entry", async () => {
    state.reservation = { reservationKey: "held-cash", method: "CASH" };
    state.record.mockRejectedValueOnce(new ConvexError({
      code: "OPENING_REFUND_PAYOUT_TIME_INVALID",
      message: "The payout time cannot be before the refund was reserved.",
    }));
    show(true);
    const paidAt = screen.getByLabelText<HTMLInputElement>(text.OpeningDepositRefundPaidDate);
    fireEvent.change(paidAt, { target: { value: "2026-06-10T11:59" } });
    fireEvent.change(screen.getByLabelText(text.OpeningDepositRefundReference), { target: { value: "SYNTHETIC-RECEIPT" } });
    fireEvent.click(screen.getByRole("button", { name: text.OpeningDepositRecordRefund }));
    expect((await screen.findByRole("alert")).textContent).toBe(text.ServerError_OPENING_REFUND_PAYOUT_TIME_INVALID);
    expect(paidAt.value).toBe("2026-06-10T11:59");
  });

  test.each([
    ["recovery", "OpeningDepositRefundConfirmCustody"],
    ["cancellation", "OpeningDepositRefundConfirmUnpaid"],
    ["payout", "OpeningDepositRecordRefund"],
  ] as const)("refuses %s when the reservation response contains a non-string key", (action, submitLabel) => {
    state.reservation = { reservationKey: 956, method: "CASH", canRecover: action === "recovery" };
    show(true);
    if (action === "cancellation") {
      fireEvent.click(screen.getByRole("button", { name: text.OpeningDepositRefundCancelReservation }));
      fireEvent.change(screen.getByLabelText(text.OpeningDepositRefundCancelReason), { target: { value: "Synthetic unpaid cancellation" } });
    } else if (action === "recovery") {
      fireEvent.change(screen.getByLabelText(text.OpeningDepositRefundRecoveryReason), { target: { value: "Synthetic control transfer" } });
    } else {
      fireEvent.change(screen.getByLabelText(text.OpeningDepositRefundPaidDate), { target: { value: "2026-06-10T11:59" } });
      fireEvent.change(screen.getByLabelText(text.OpeningDepositRefundReference), { target: { value: "SYNTHETIC-RECEIPT" } });
    }
    fireEvent.click(screen.getByRole("button", { name: text[submitLabel] }));
    expect(state.recover).not.toHaveBeenCalled();
    expect(state.cancel).not.toHaveBeenCalled();
    expect(state.record).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(text.OpeningDepositRefundUnconfirmed);
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
