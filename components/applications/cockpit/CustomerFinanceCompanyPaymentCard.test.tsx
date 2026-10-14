/**
 * SCRUM-766 PR-B - the card that shows the customer's payment to the finance
 * company as agreed / confirmed / awaiting, and records or takes back the
 * evidence. The agreement is never shown as money received.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { salesAr, salesEn } from "@/lib/i18n/domains/sales";

// The dialog primitive reads the language for its close-button label.
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: false, locale: "en" }),
}));

import { CustomerFinanceCompanyPaymentCard } from "./CustomerFinanceCompanyPaymentCard";

const tEn = (key: string) => (salesEn as Record<string, string>)[key] ?? key;
const tAr = (key: string) => (salesAr as Record<string, string>)[key] ?? key;
const money = (minor: number) => `${(minor / 1000).toLocaleString("en-US")} JOD`;

afterEach(cleanup);

function card(overrides: Partial<React.ComponentProps<typeof CustomerFinanceCompanyPaymentCard>> = {}) {
  const onConfirm = vi.fn().mockResolvedValue(true);
  const onVoid = vi.fn().mockResolvedValue(true);
  const view = render(
    <CustomerFinanceCompanyPaymentCard
      agreedMinor={400_000}
      confirmedMinor={0}
      payments={[]}
      canRecord
      closed={false}
      factor={1000}
      money={money}
      t={tEn}
      onConfirm={onConfirm}
      onVoid={onVoid}
      {...overrides}
    />
  );
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
    card({ confirmedMinor: 150_000 });
    expect(within(screen.getByTestId("customer-finance-company-awaiting")).getByText("250 JOD")).toBeTruthy();
  });

  test("fully confirmed: nothing awaiting and no confirm button", () => {
    card({ confirmedMinor: 400_000 });
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
      paidAt: new Date("2026-10-01T00:00:00").getTime(),
      reference: "TRF-9",
    });
  });

  test("an amount above what is still unconfirmed cannot be submitted", () => {
    card({ confirmedMinor: 300_000 });
    fireEvent.click(screen.getByRole("button", { name: salesEn.CustFcPayConfirmAction }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByLabelText(salesEn.CustFcPayAmountLabel), { target: { value: "101" } });
    fireEvent.change(dialog.getByLabelText(salesEn.CustFcPayReferenceLabel), { target: { value: "TRF-1" } });
    expect((dialog.getByRole("button", { name: salesEn.CustFcPayConfirmAction }) as HTMLButtonElement).disabled).toBe(true);
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

  test("taking a confirmation back needs a reason and names the payment", async () => {
    const { onVoid } = card({
      confirmedMinor: 400_000,
      payments: [
        { _id: "p1", status: "CONFIRMED", amountMinor: 400_000, paidAt: Date.UTC(2026, 9, 1), reference: "TRF-1" },
        { _id: "p0", status: "VOIDED", amountMinor: 50_000, paidAt: Date.UTC(2026, 8, 1), reference: "TRF-0", voidReason: "typo" },
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
      payments: [{ _id: "p1", status: "CONFIRMED", amountMinor: 100_000, paidAt: Date.UTC(2026, 9, 1), reference: "TRF-1" }],
    });
    expect(screen.getByText(salesEn.CustFcPayNotAllowed)).toBeTruthy();
    expect(screen.queryByRole("button", { name: salesEn.CustFcPayConfirmAction })).toBeNull();
    expect(screen.queryByRole("button", { name: salesEn.CustFcPayVoidAction })).toBeNull();
  });

  test("a closed deal shows the record with no commands and no apology", () => {
    card({
      closed: true,
      confirmedMinor: 400_000,
      payments: [{ _id: "p1", status: "CONFIRMED", amountMinor: 400_000, paidAt: Date.UTC(2026, 9, 1), reference: "TRF-1" }],
    });
    expect(screen.queryByRole("button", { name: salesEn.CustFcPayVoidAction })).toBeNull();
    expect(screen.queryByText(salesEn.CustFcPayNotAllowed)).toBeNull();
  });
});
