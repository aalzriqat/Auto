/**
 * SCRUM-766 PR-B - the card that shows the customer's payment to the finance
 * company as agreed / confirmed / awaiting, and records or takes back the
 * evidence. The agreement is never shown as money received.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { salesAr, salesEn } from "@/lib/i18n/domains/sales";

const language = vi.hoisted(() => ({ isRtl: false }));

// The dialog primitive reads the language for its close-button label and direction.
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: language.isRtl, locale: language.isRtl ? "ar" : "en" }),
}));

import { CustomerFinanceCompanyPaymentCard } from "./CustomerFinanceCompanyPaymentCard";

const tEn = (key: string) => (salesEn as Record<string, string>)[key] ?? key;
const tAr = (key: string) => (salesAr as Record<string, string>)[key] ?? key;
const money = (minor: number) => `${(minor / 1000).toLocaleString("en-US")} JOD`;

afterEach(() => {
  cleanup();
  language.isRtl = false;
});

type CardProps = React.ComponentProps<typeof CustomerFinanceCompanyPaymentCard>;
type StandardCardProps = Extract<CardProps, { firstPayment?: undefined }>;

function card(overrides: Partial<Omit<StandardCardProps, "firstPayment">> & { firstPayment?: CardProps["firstPayment"] } = {}) {
  const { firstPayment, ...values } = overrides;
  const onConfirm = vi.fn().mockResolvedValue(true);
  const onVoid = vi.fn().mockResolvedValue(true);
  const props = {
    agreedMinor: 400_000, confirmedMinor: 0, awaitingMinor: 400_000, payments: [], canRecord: true,
    closed: false, factor: 1000, money, t: tEn, onConfirm, onVoid, ...values,
  };
  const view = render(firstPayment
    ? <CustomerFinanceCompanyPaymentCard {...props} firstPayment={firstPayment} />
    : <CustomerFinanceCompanyPaymentCard {...props} />);
  return { ...view, onConfirm, onVoid };
}

describe("CustomerFinanceCompanyPaymentCard", () => {
  test("nothing agreed renders nothing", () => {
    const { container } = card({ agreedMinor: 0 });
    expect(container.firstChild).toBeNull();
  });

  test.each([tEn, tAr])("an agreement alone reads as awaiting confirmation, not as money received - %#", (t) => {
    const dictionary = t === tEn ? salesEn : salesAr;
    card({ t });
    expect(screen.getByText(dictionary.CustFcPayAwaiting)).toBeTruthy();
    expect(within(screen.getByTestId("customer-finance-company-awaiting")).getByText("400 JOD")).toBeTruthy();
    expect(screen.getByText(dictionary.CustFcPayAwaitingNote)).toBeTruthy();
    expect(screen.getByRole("button", { name: dictionary.CustFcPayConfirmAction })).toBeTruthy();
  });

  test("a partly confirmed agreement shows only the rest as awaiting", () => {
    card({ confirmedMinor: 150_000, awaitingMinor: 250_000 });
    expect(within(screen.getByTestId("customer-finance-company-awaiting")).getByText("250 JOD")).toBeTruthy();
  });

  test("fully confirmed: nothing awaiting and no confirm button", () => {
    card({ confirmedMinor: 400_000, awaitingMinor: 0 });
    expect(within(screen.getByTestId("customer-finance-company-awaiting")).getByText("0 JOD")).toBeTruthy();
    expect(screen.queryByRole("button", { name: salesEn.CustFcPayConfirmAction })).toBeNull();
  });

  test("confirming sends the minor amount, the day and the trimmed reference, and needs a reference", async () => {
    const { onConfirm } = card();
    fireEvent.click(screen.getByRole("button", { name: salesEn.CustFcPayConfirmAction }));
    const dialog = within(screen.getByRole("dialog"));
    const submit = dialog.getByRole("button", { name: salesEn.CustFcPayConfirmAction });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText(salesEn.CustFcPayAmountLabel), { target: { value: "150" } });
    fireEvent.change(dialog.getByLabelText(salesEn.CustFcPayDateLabel), { target: { value: "2026-10-01" } });
    fireEvent.change(dialog.getByLabelText(salesEn.CustFcPayReferenceLabel), { target: { value: "  TRF-9  " } });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm).toHaveBeenCalledWith({
      amountMinor: 150_000,
      paidAt: Date.UTC(2026, 9, 1),
      reference: "TRF-9",
    });
  });

  test("an amount above what is still unconfirmed cannot be submitted", () => {
    card({ confirmedMinor: 300_000, awaitingMinor: 100_000 });
    fireEvent.click(screen.getByRole("button", { name: salesEn.CustFcPayConfirmAction }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText(salesEn.CustFcPayAmountLabel), { target: { value: "101" } });
    fireEvent.change(dialog.getByLabelText(salesEn.CustFcPayReferenceLabel), { target: { value: "TRF-1" } });
    expect((dialog.getByRole("button", { name: salesEn.CustFcPayConfirmAction }) as HTMLButtonElement).disabled).toBe(true);
  });

  test.each([tEn, tAr])("a split first payment records only the finance-company confirmation - %#", async (t) => {
    const dictionary = t === tEn ? salesEn : salesAr;
    const { onConfirm } = card({
      t, agreedMinor: 550_000, awaitingMinor: 350_000, firstPayment: { heldMinor: 200_000, canConfirm: true },
    });
    const evidence = within(screen.getByTestId("first-payment-evidence-card"));
    expect(evidence.getByText(dictionary.FirstPaymentProofDealerReceived)).toBeTruthy();
    expect(evidence.getByText("200 JOD")).toBeTruthy();
    fireEvent.click(evidence.getByRole("button", { name: dictionary.CustFcPayConfirmAction }));
    fireEvent.click(screen.getByRole("button", { name: dictionary.FirstPaymentPaidFinanceCompany }));
    const dialog = within(screen.getByRole("dialog", { name: dictionary.CustFcPayDialogTitle }));
    fireEvent.change(dialog.getByLabelText(dictionary.FirstPaymentProofSource), { target: { value: "CONFIRMATION" } });
    fireEvent.change(dialog.getByLabelText(dictionary.CustFcPayDateLabel), { target: { value: "2026-10-01" } });
    fireEvent.change(dialog.getByLabelText(dictionary.CustFcPayReferenceLabel), { target: { value: "FC-350" } });
    fireEvent.click(dialog.getByRole("button", { name: dictionary.CustFcPayConfirmAction }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({
      kind: "CONFIRMATION", amountMinor: 350_000, paidAt: Date.UTC(2026, 9, 1), reference: "FC-350",
    }));
  });

  test("a refused confirmation leaves the dialog open", async () => {
    const refused = vi.fn().mockResolvedValue(false);
    card({ onConfirm: refused });
    fireEvent.click(screen.getByRole("button", { name: salesEn.CustFcPayConfirmAction }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText(salesEn.CustFcPayReferenceLabel), { target: { value: "TRF-1" } });
    fireEvent.click(dialog.getByRole("button", { name: salesEn.CustFcPayConfirmAction }));
    await waitFor(() => expect(refused).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  test("first-payment history remains available before approval is restored, with no invented balances", () => {
    card({
      firstPayment: { canConfirm: false }, agreedMinor: 0, awaitingMinor: 0,
      payments: [{ _id: "earlier", status: "CONFIRMED", agreement: "PRIOR", kind: "RECEIPT", amountMinor: 200_000, paidAt: Date.UTC(2026, 9, 1), reference: "Earlier receipt" }],
    });
    expect(screen.getByText("Earlier receipt")).toBeTruthy();
    expect(screen.queryByText(salesEn.FirstPaymentProofDealerReceived)).toBeNull();
    expect(screen.queryByRole("button", { name: salesEn.CustFcPayConfirmAction })).toBeNull();
    expect(screen.getByRole("button", { name: salesEn.CustFcPayVoidAction })).toBeTruthy();
  });

  test("taking a confirmation back needs a reason and names the payment", async () => {
    const { onVoid } = card({
      confirmedMinor: 400_000,
      awaitingMinor: 0,
      payments: [
        { _id: "p1", status: "CONFIRMED", agreement: "CURRENT", amountMinor: 400_000, paidAt: Date.UTC(2026, 9, 1), reference: "TRF-1" },
        { _id: "p0", status: "VOIDED", agreement: "CURRENT", amountMinor: 50_000, paidAt: Date.UTC(2026, 8, 1), reference: "TRF-0", voidReason: "typo" },
      ],
    });
    // The voided row is shown as taken back and offers no second take-back.
    expect(screen.getAllByRole("button", { name: salesEn.CustFcPayVoidAction })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: salesEn.CustFcPayVoidAction }));
    const dialog = within(screen.getByRole("dialog"));
    const submit = dialog.getByRole("button", { name: salesEn.CustFcPayVoidAction });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(dialog.getByLabelText(salesEn.CustFcPayVoidReasonLabel), { target: { value: " bounced " } });
    fireEvent.click(submit);
    await waitFor(() => expect(onVoid).toHaveBeenCalledWith({ paymentId: "p1", reason: "bounced" }));
  });

  test("a caller who may not record sees the figures and why, but no commands", () => {
    card({
      canRecord: false,
      confirmedMinor: 100_000,
      awaitingMinor: 300_000,
      payments: [{ _id: "p1", status: "CONFIRMED", agreement: "CURRENT", amountMinor: 100_000, paidAt: Date.UTC(2026, 9, 1), reference: "TRF-1" }],
    });
    expect(screen.getByText(salesEn.CustFcPayNotAllowed)).toBeTruthy();
    expect(screen.queryByRole("button", { name: salesEn.CustFcPayConfirmAction })).toBeNull();
    expect(screen.queryByRole("button", { name: salesEn.CustFcPayVoidAction })).toBeNull();
  });

  test("a closed deal shows the record with no commands and no apology", () => {
    card({
      closed: true,
      confirmedMinor: 400_000,
      awaitingMinor: 0,
      payments: [{ _id: "p1", status: "CONFIRMED", agreement: "CURRENT", amountMinor: 400_000, paidAt: Date.UTC(2026, 9, 1), reference: "TRF-1" }],
    });
    expect(screen.queryByRole("button", { name: salesEn.CustFcPayVoidAction })).toBeNull();
    expect(screen.queryByText(salesEn.CustFcPayNotAllowed)).toBeNull();
  });

  test("the awaiting figure is the server balance, not agreed minus confirmed", () => {
    // Agreed 400 but only 325 is creditable on a sealed deal: 0 confirmed, 325 awaiting.
    card({ agreedMinor: 400_000, confirmedMinor: 0, awaitingMinor: 325_000 });
    expect(within(screen.getByTestId("customer-finance-company-awaiting")).getByText("325 JOD")).toBeTruthy();
  });

  // The ledger calendar is UTC. At 01:30 on 10 Aug in Amman it is still 9 Aug
  // 22:30 UTC: the default day, the ceiling and the instant sent must all be
  // the UTC day, not the browser-local one.
  describe("economic dates in the Jordan zone", () => {
    const zone = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = "Asia/Amman";
    });
    afterAll(() => {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
      vi.useRealTimers();
    });

    test("default, ceiling and submitted instant are the UTC day", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-08-09T22:30:00Z"));
      const { onConfirm } = card();
      fireEvent.click(screen.getByRole("button", { name: salesEn.CustFcPayConfirmAction }));
      const dialog = within(screen.getByRole("dialog"));
      const date = dialog.getByLabelText(salesEn.CustFcPayDateLabel) as HTMLInputElement;
      expect(date.value).toBe("2026-08-09");
      expect(date.max).toBe("2026-08-09");
      fireEvent.change(dialog.getByLabelText(salesEn.CustFcPayReferenceLabel), { target: { value: "TRF-J" } });
      fireEvent.click(dialog.getByRole("button", { name: salesEn.CustFcPayConfirmAction }));
      await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
      expect(onConfirm).toHaveBeenCalledWith({ amountMinor: 400_000, paidAt: Date.UTC(2026, 7, 9), reference: "TRF-J" });
    });

    test("a recorded payment shows the UTC calendar day it was stored as", () => {
      // 23:30 UTC on 30 Sep is 02:30 on 1 Oct in Amman: the stored day is 30 Sep.
      card({
        confirmedMinor: 400_000,
        awaitingMinor: 0,
        payments: [
          { _id: "p1", status: "CONFIRMED", agreement: "CURRENT", amountMinor: 400_000, paidAt: Date.UTC(2026, 8, 30, 23, 30), reference: "TRF-1" },
        ],
      });
      expect(screen.getByText("2026-09-30")).toBeTruthy();
    });
  });

  describe("evidence from an earlier agreement", () => {
    const prior = {
      _id: "old",
      status: "CONFIRMED" as const,
      agreement: "PRIOR" as const,
      amountMinor: 400_000,
      paidAt: Date.UTC(2026, 9, 1),
      reference: "TRF-OLD",
    };

    test.each([tEn, tAr])("is listed, marked as not counted and can be taken back even with nothing agreed now - %#", (t) => {
      const dictionary = t === tEn ? salesEn : salesAr;
      card({ t, agreedMinor: 0, confirmedMinor: 0, awaitingMinor: 0, payments: [prior] });
      expect(screen.getByText("TRF-OLD")).toBeTruthy();
      expect(screen.getByText(dictionary.CustFcPayPriorAgreement)).toBeTruthy();
      expect(screen.getByText(dictionary.CustFcPayPriorNote)).toBeTruthy();
      expect(screen.getAllByRole("button", { name: dictionary.CustFcPayVoidAction })).toHaveLength(1);
      // Nothing is agreed now, so there is nothing to confirm against.
      expect(screen.queryByRole("button", { name: dictionary.CustFcPayConfirmAction })).toBeNull();
    });

    test("a voided earlier row is history: no mark, no second take-back", () => {
      card({ agreedMinor: 0, awaitingMinor: 0, payments: [{ ...prior, status: "VOIDED", voidReason: "withdrawn" }] });
      expect(screen.queryByText(salesEn.CustFcPayPriorAgreement)).toBeNull();
      expect(screen.queryByRole("button", { name: salesEn.CustFcPayVoidAction })).toBeNull();
    });

    test("with nothing agreed and no evidence the card still renders nothing", () => {
      const { container } = card({ agreedMinor: 0, awaitingMinor: 0, payments: [] });
      expect(container.firstChild).toBeNull();
    });
  });

  // SCRUM-1018: money paid at the showroom is a deposit receipt; the evidence form
  // records only a payment made to the finance company. The button asks first.
  describe("first payment: where the customer paid", () => {
    function firstPaymentCard(t: (key: string) => string, onRecordShowroomPayment?: () => void) {
      const onConfirm = vi.fn().mockResolvedValue(true);
      render(
        <CustomerFinanceCompanyPaymentCard
          agreedMinor={550_000} confirmedMinor={0} awaitingMinor={350_000} payments={[]} canRecord closed={false}
          factor={1000} money={money} t={t} onVoid={vi.fn().mockResolvedValue(true)} onConfirm={onConfirm}
          firstPayment={{ heldMinor: 200_000, canConfirm: true }} onRecordShowroomPayment={onRecordShowroomPayment}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: t("CustFcPayConfirmAction") }));
      return { onConfirm };
    }
    const description = (element: HTMLElement) =>
      (element.getAttribute("aria-describedby") ?? "").split(" ").map((id) => document.getElementById(id)?.textContent ?? "").join(" ");

    test.each([tEn, tAr])("pressing confirm asks where the customer paid, with what each choice records - %#", async (t) => {
      const dictionary = t === tEn ? salesEn : salesAr;
      firstPaymentCard(t, vi.fn());
      const choice = screen.getByRole("dialog", { name: dictionary.FirstPaymentWherePaidTitle });
      expect(within(choice).queryByLabelText(dictionary.CustFcPayAmountLabel)).toBeNull();
      const showroom = within(choice).getByRole("button", { name: dictionary.FirstPaymentPaidShowroom });
      const financeCompany = within(choice).getByRole("button", { name: dictionary.FirstPaymentPaidFinanceCompany });
      expect(description(showroom)).toContain(dictionary.FirstPaymentPaidShowroomHelp);
      expect(description(financeCompany)).toContain(dictionary.FirstPaymentPaidFinanceCompanyHelp);
      // Focus moves into the choice.
      await waitFor(() => expect(choice.contains(document.activeElement)).toBe(true));
    });

    test("the Arabic choice is drawn right to left", () => {
      language.isRtl = true;
      firstPaymentCard(tAr, vi.fn());
      expect(screen.getByRole("dialog", { name: salesAr.FirstPaymentWherePaidTitle }).getAttribute("dir")).toBe("rtl");
    });

    test("to the showroom starts the deposit flow and never opens the finance-company form", () => {
      const onRecordShowroomPayment = vi.fn();
      const { onConfirm } = firstPaymentCard(tEn, onRecordShowroomPayment);
      fireEvent.click(screen.getByRole("button", { name: salesEn.FirstPaymentPaidShowroom }));
      expect(onRecordShowroomPayment).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("dialog", { name: salesEn.CustFcPayDialogTitle })).toBeNull();
      expect(screen.queryByRole("dialog", { name: salesEn.FirstPaymentWherePaidTitle })).toBeNull();
      expect(onConfirm).not.toHaveBeenCalled();
    });

    test("to the finance company opens the existing evidence form with its fields", () => {
      const onRecordShowroomPayment = vi.fn();
      firstPaymentCard(tEn, onRecordShowroomPayment);
      fireEvent.click(screen.getByRole("button", { name: salesEn.FirstPaymentPaidFinanceCompany }));
      const form = within(screen.getByRole("dialog", { name: salesEn.CustFcPayDialogTitle }));
      expect(form.getByText(salesEn.FirstPaymentProofDialogDescription)).toBeTruthy();
      expect(form.getByLabelText(salesEn.FirstPaymentProofSource)).toBeTruthy();
      expect((form.getByLabelText(salesEn.CustFcPayAmountLabel) as HTMLInputElement).value).toBe("350");
      expect(form.getByLabelText(salesEn.CustFcPayDateLabel)).toBeTruthy();
      expect(form.getByLabelText(salesEn.CustFcPayReferenceLabel)).toBeTruthy();
      expect(screen.queryByRole("dialog", { name: salesEn.FirstPaymentWherePaidTitle })).toBeNull();
      expect(onRecordShowroomPayment).not.toHaveBeenCalled();
    });

    test.each([tEn, tAr])("without the deposit action the showroom choice is unavailable and says why - %#", (t) => {
      const dictionary = t === tEn ? salesEn : salesAr;
      firstPaymentCard(t);
      const showroom = screen.getByRole("button", { name: dictionary.FirstPaymentPaidShowroom }) as HTMLButtonElement;
      expect(showroom.disabled).toBe(true);
      expect(description(showroom)).toContain(dictionary.FirstPaymentPaidShowroomUnavailable);
      expect((screen.getByRole("button", { name: dictionary.FirstPaymentPaidFinanceCompany }) as HTMLButtonElement).disabled).toBe(false);
    });

    test("Escape closes the choice without opening anything", () => {
      const onRecordShowroomPayment = vi.fn();
      firstPaymentCard(tEn, onRecordShowroomPayment);
      fireEvent.keyDown(screen.getByRole("dialog", { name: salesEn.FirstPaymentWherePaidTitle }), { key: "Escape" });
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(onRecordShowroomPayment).not.toHaveBeenCalled();
    });

    test("the finance-company payment card (not the first payment) still opens its form directly", () => {
      card();
      fireEvent.click(screen.getByRole("button", { name: salesEn.CustFcPayConfirmAction }));
      expect(screen.getByRole("dialog", { name: salesEn.CustFcPayDialogTitle })).toBeTruthy();
      expect(screen.queryByRole("dialog", { name: salesEn.FirstPaymentWherePaidTitle })).toBeNull();
    });
  });
});
