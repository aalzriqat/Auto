/**
 * SCRUM-54 - the payment to the finance company names the physical bank it left.
 *
 * A bank-account method (transfer, card, cheque) requires a chosen bank; cash
 * credits the drawer and names none. A lost response freezes every field so the
 * retry replays the SAME command. The screen only collects the choice - the
 * server judges it (same org, active, deal currency) before any write.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { commonAr, commonEn } from "@/lib/i18n/domains/common";
import { salesAr, salesEn } from "@/lib/i18n/domains/sales";
import type { Id } from "@/convex/_generated/dataModel";
import type { DirectPaymentBankOptions } from "./cockpit/HandoverCostsPanel";
import {
  RecordForwardToFinanceCompanyDialog,
  type ForwardConfirmOutcome,
  type ForwardPaymentValues,
} from "./RecordForwardToFinanceCompanyDialog";

// The shared Dialog primitive reads the language context (close label, direction). The repository's pattern is to stub the
// provider hook; the component under test is rendered for real and receives its own `t` as a prop.
const language = vi.hoisted(() => ({ locale: "en", isRtl: false }));
vi.mock("@/components/providers/LanguageProvider", () => ({
  useLanguage: () => ({ t: (key: string) => key, isRtl: language.isRtl, locale: language.locale }),
}));

const en = { ...(commonEn as Record<string, string>), ...(salesEn as Record<string, string>) };
const ar = { ...(commonAr as Record<string, string>), ...(salesAr as Record<string, string>) };
const tEn = (key: string) => en[key] ?? key;
const tAr = (key: string) => ar[key] ?? key;

const BANK_A = "bankA" as Id<"bankAccounts">;
const BANK_B = "bankB" as Id<"bankAccounts">;
const BANKS: NonNullable<DirectPaymentBankOptions> = {
  banks: [
    { _id: BANK_A, name: "Bank A", currency: "JOD" },
    { _id: BANK_B, name: "Bank B", currency: "JOD" },
  ],
  truncated: false,
};

type Confirm = (values: ForwardPaymentValues) => Promise<ForwardConfirmOutcome>;

function renderDialog(over: { bankOptions?: DirectPaymentBankOptions; t?: (key: string) => string; onConfirm?: Confirm } = {}) {
  const onConfirm = vi.fn<Confirm>(over.onConfirm ?? (async () => undefined));
  const t = over.t ?? tEn;
  const element = (dueMinor: number, label: string) => (
    <RecordForwardToFinanceCompanyDialog
      open
      submitting={false}
      dueMinor={dueMinor}
      totalLabel={label}
      depositLabel="200 JOD"
      contributionLabel="1,375 JOD"
      bankOptions={"bankOptions" in over ? over.bankOptions : BANKS}
      t={t}
      onOpenChange={() => {}}
      onConfirm={onConfirm}
    />
  );
  const view = render(element(1_575_000, "1,575 JOD"));
  /** The live due moves (the deal re-priced while the dialog stays open). */
  const moveDue = (dueMinor: number, label: string) => view.rerender(element(dueMinor, label));
  return { onConfirm, t, moveDue };
}

const methodSelect = (t: (key: string) => string) => screen.getByLabelText(t("DirectPaymentMethodLabel")) as HTMLSelectElement;
const bankSelect = (t: (key: string) => string) => screen.getByLabelText(t("DirectPaymentBankLabel")) as HTMLSelectElement;
const confirmButton = (t: (key: string) => string) => screen.getByRole("button", { name: t("RecordForwardConfirm") });
const choose = (select: HTMLSelectElement, value: string) => fireEvent.change(select, { target: { value } });

afterEach(() => {
  cleanup();
  language.locale = "en";
  language.isRtl = false;
});

describe("SCRUM-54 - the forward dialog requires a bank for a bank method", () => {
  test.each(["BANK_TRANSFER", "CARD", "CHEQUE"] as const)("%s without a bank shows the translated refusal and sends nothing", async (method) => {
    const { onConfirm, t } = renderDialog();
    choose(methodSelect(t), method);
    fireEvent.click(confirmButton(t));
    expect((await screen.findByRole("alert")).textContent).toBe(commonEn.DirectPaymentBankRequired);
    expect(bankSelect(t).getAttribute("aria-invalid")).toBe("true");
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("the chosen bank is sent with the method; choosing it clears the refusal", async () => {
    const { onConfirm, t } = renderDialog();
    choose(methodSelect(t), "BANK_TRANSFER");
    fireEvent.click(confirmButton(t));
    await screen.findByRole("alert");
    choose(bankSelect(t), BANK_B);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(confirmButton(t));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    expect(onConfirm.mock.calls[0][0]).toMatchObject({ method: "BANK_TRANSFER", bankAccountId: BANK_B });
  });

  test("switching to another method forgets the chosen bank, so a stale bank is never sent", async () => {
    const { onConfirm, t } = renderDialog();
    choose(methodSelect(t), "BANK_TRANSFER");
    choose(bankSelect(t), BANK_A);
    choose(methodSelect(t), "CARD");
    expect(bankSelect(t).value).toBe("");
    fireEvent.click(confirmButton(t));
    expect((await screen.findByRole("alert")).textContent).toBe(commonEn.DirectPaymentBankRequired);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("CASH shows no bank picker and sends no bank, even after a bank was chosen for another method", async () => {
    const { onConfirm, t } = renderDialog();
    choose(methodSelect(t), "BANK_TRANSFER");
    choose(bankSelect(t), BANK_A);
    choose(methodSelect(t), "CASH");
    expect(screen.queryByLabelText(t("DirectPaymentBankLabel"))).toBeNull();
    fireEvent.click(confirmButton(t));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    const sent = onConfirm.mock.calls[0][0];
    expect(sent.method).toBe("CASH");
    expect("bankAccountId" in sent).toBe(false);
  });

  test("no eligible bank: the picker is unusable, says why, and nothing can be sent", async () => {
    const { onConfirm, t } = renderDialog({ bankOptions: { banks: [], truncated: false } });
    choose(methodSelect(t), "BANK_TRANSFER");
    expect((await screen.findByRole("alert")).textContent).toBe(commonEn.DirectPaymentNoBank);
    expect(bankSelect(t).disabled).toBe(true);
    fireEvent.click(confirmButton(t));
    await waitFor(() => expect(screen.getAllByRole("alert").map((node) => node.textContent)).toContain(commonEn.DirectPaymentBankRequired));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("a truncated bank list is not a choice the screen can honour: it says so and sends nothing", async () => {
    const { onConfirm, t } = renderDialog({ bankOptions: { banks: BANKS.banks, truncated: true } });
    choose(methodSelect(t), "CHEQUE");
    expect((await screen.findByRole("alert")).textContent).toBe(commonEn.DirectPaymentTooManyBanks);
    expect(bankSelect(t).disabled).toBe(true);
    fireEvent.click(confirmButton(t));
    await waitFor(() => expect(screen.getAllByRole("alert").map((node) => node.textContent)).toContain(commonEn.DirectPaymentBankRequired));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("while the bank list loads the picker is disabled and a bank method cannot be sent", async () => {
    const { onConfirm, t } = renderDialog({ bankOptions: undefined });
    choose(methodSelect(t), "CARD");
    expect(bankSelect(t).disabled).toBe(true);
    fireEvent.click(confirmButton(t));
    expect((await screen.findByRole("alert")).textContent).toBe(commonEn.DirectPaymentBankRequired);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("a lost response freezes every field and the retry replays the SAME command, bank included", async () => {
    const outcomes: ForwardConfirmOutcome[] = ["UNKNOWN", undefined];
    const { onConfirm, t } = renderDialog({ onConfirm: async () => outcomes.shift() });
    choose(methodSelect(t), "BANK_TRANSFER");
    choose(bankSelect(t), BANK_A);
    fireEvent.click(confirmButton(t));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));

    // Frozen: nothing the command was built from can change, the bank least of all.
    await waitFor(() => expect(bankSelect(t).disabled).toBe(true));
    expect(methodSelect(t).disabled).toBe(true);
    expect((screen.getByLabelText(t("CostPaidOnLabel")) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(t("ReceiptReferenceLabel")) as HTMLInputElement).disabled).toBe(true);
    expect(confirmButton(t).hasAttribute("disabled")).toBe(false);

    fireEvent.click(confirmButton(t));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
    expect(onConfirm.mock.calls[1][0]).toEqual(onConfirm.mock.calls[0][0]);
    expect(onConfirm.mock.calls[1][0]).toMatchObject({ method: "BANK_TRANSFER", bankAccountId: BANK_A });

    // A settled answer ends the freeze.
    await waitFor(() => expect(methodSelect(t).disabled).toBe(false));
  });

  test("a lost response pins the amount: the retry re-sends the first figure and the breakdown keeps showing it", async () => {
    const outcomes: ForwardConfirmOutcome[] = ["UNKNOWN", undefined];
    const { onConfirm, t, moveDue } = renderDialog({ onConfirm: async () => outcomes.shift() });
    choose(methodSelect(t), "BANK_TRANSFER");
    choose(bankSelect(t), BANK_A);
    fireEvent.click(confirmButton(t));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(bankSelect(t).disabled).toBe(true));
    expect(onConfirm.mock.calls[0][0].expectedAmountMinor).toBe(1_575_000);

    moveDue(1_600_000, "1,600 JOD");
    const breakdown = screen.getByTestId("forward-breakdown").textContent ?? "";
    expect(breakdown).toContain("1,575 JOD");
    expect(breakdown).not.toContain("1,600 JOD");

    fireEvent.click(confirmButton(t));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
    expect(onConfirm.mock.calls[1][0]).toEqual(onConfirm.mock.calls[0][0]);
    expect(onConfirm.mock.calls[1][0].expectedAmountMinor).toBe(1_575_000);

    // The settled answer releases the pin: the live figure shows again and a new attempt is a deliberate one.
    await waitFor(() => expect(screen.getByTestId("forward-breakdown").textContent).toContain("1,600 JOD"));
    fireEvent.click(confirmButton(t));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(3));
    expect(onConfirm.mock.calls[2][0].expectedAmountMinor).toBe(1_600_000);
  });

  test("a definite answer (not a lost response) leaves the form editable", async () => {
    const { onConfirm, t } = renderDialog({ onConfirm: async () => undefined });
    choose(methodSelect(t), "CARD");
    choose(bankSelect(t), BANK_B);
    fireEvent.click(confirmButton(t));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(bankSelect(t).disabled).toBe(false));
    expect(methodSelect(t).disabled).toBe(false);
  });
});

describe("SCRUM-54 - the forward bank copy exists in both languages", () => {
  test("every key the picker renders is translated in English and Arabic", () => {
    for (const key of ["DirectPaymentBankLabel", "DirectPaymentBankChoose", "DirectPaymentBankRequired", "DirectPaymentNoBank", "DirectPaymentTooManyBanks", "CashDrawerLoadingBanks"] as const) {
      expect(commonEn[key], `${key} EN`).toBeTruthy();
      expect(commonAr[key], `${key} AR`).toBeTruthy();
      expect(commonAr[key]).not.toBe(commonEn[key]);
    }
  });

  test("Arabic: the label, the options and the required refusal render in Arabic", async () => {
    language.locale = "ar";
    language.isRtl = true;
    const { onConfirm, t } = renderDialog({ t: tAr });
    choose(methodSelect(t), "BANK_TRANSFER");
    expect(bankSelect(t).getAttribute("id")).toBe("record-forward-bank");
    expect(screen.getByText(commonAr.DirectPaymentBankChoose)).toBeTruthy();
    fireEvent.click(confirmButton(t));
    expect((await screen.findByRole("alert")).textContent).toBe(commonAr.DirectPaymentBankRequired);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
