/**
 * SCRUM-945: the stated opening balance of an existing bank account is editable from the bank accounts screen.
 * The figure is reference metadata only; the dialog says so, parses the typed amount exactly (no floating point)
 * at the bank's own currency scale, and never calls the handler for an invalid amount.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { dictionaries } from "@/lib/i18n/dictionaries";
import { BankAccountsTable } from "./BankAccountsTable";
import { EditBankOpeningDialog } from "./EditBankOpeningDialog";
import { minorToAmountInput, parseSignedOpeningMoneyMinor } from "./editBankOpeningInput";
import type { BankAccountSummary } from "./types";

afterEach(cleanup);

const tFor = (locale: "en" | "ar") => (key: string) =>
  (dictionaries as Record<string, Record<string, string>>)[locale][key] ?? key;

const JAN_1_2026 = Date.UTC(2026, 0, 1);

function account(overrides: Partial<BankAccountSummary> = {}): BankAccountSummary {
  return {
    _id: "bank1" as BankAccountSummary["_id"],
    name: "Operating JOD",
    currency: "JOD",
    openingBalanceMinor: 1_234_567,
    openingBalanceDate: JAN_1_2026,
    isActive: true,
    isReconciliationTarget: false,
    ...overrides,
  };
}

describe("editBankOpeningInput helpers", () => {
  test("parses exactly at the currency scale, with an optional leading minus", () => {
    expect(parseSignedOpeningMoneyMinor("1234.567", "JOD")).toBe(1_234_567);
    expect(parseSignedOpeningMoneyMinor("-1234.567", "JOD")).toBe(-1_234_567);
    expect(parseSignedOpeningMoneyMinor("12.5", "USD")).toBe(1250);
    expect(parseSignedOpeningMoneyMinor("0", "JOD")).toBe(0);
    expect(Object.is(parseSignedOpeningMoneyMinor("-0", "JOD"), 0)).toBe(true);
    // 0.1 + 0.2 style float traps: the digits are read, never multiplied.
    expect(parseSignedOpeningMoneyMinor("1.005", "JOD")).toBe(1005);
  });

  test("refuses too many decimals, non-numbers, double signs, out-of-range and unknown currencies", () => {
    expect(parseSignedOpeningMoneyMinor("1.2345", "JOD")).toBeNull();
    expect(parseSignedOpeningMoneyMinor("abc", "JOD")).toBeNull();
    expect(parseSignedOpeningMoneyMinor("", "JOD")).toBeNull();
    expect(parseSignedOpeningMoneyMinor("--5", "JOD")).toBeNull();
    expect(parseSignedOpeningMoneyMinor("+5", "JOD")).toBeNull();
    expect(parseSignedOpeningMoneyMinor("-", "JOD")).toBeNull();
    expect(parseSignedOpeningMoneyMinor("9007199254740.992", "JOD")).toBeNull();
    expect(parseSignedOpeningMoneyMinor("-9007199254740.992", "JOD")).toBeNull();
    expect(parseSignedOpeningMoneyMinor("1", "ZZZ")).toBeNull();
  });

  test("formats a stored minor value exactly at the bank's own scale", () => {
    expect(minorToAmountInput(1_234_567, "JOD")).toBe("1234.567");
    expect(minorToAmountInput(-1_234_567, "JOD")).toBe("-1234.567");
    expect(minorToAmountInput(5, "JOD")).toBe("0.005");
    expect(minorToAmountInput(0, "JOD")).toBe("0.000");
    expect(minorToAmountInput(1250, "USD")).toBe("12.50");
    expect(minorToAmountInput(1, "ZZZ")).toBeNull();
  });
});

describe("BankAccountsTable edit control", () => {
  const baseProps = {
    accounts: [account()],
    busyAction: null,
    t: tFor("en"),
    onSetReconciliationTarget: vi.fn(),
    onDeactivate: vi.fn(),
  };

  test("is absent without canManageFinance", () => {
    render(<BankAccountsTable {...baseProps} canManageFinance={false} onEditOpening={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /opening/i })).toBeNull();
  });

  test("is present with canManageFinance and hands the account to the handler", () => {
    const onEditOpening = vi.fn();
    render(<BankAccountsTable {...baseProps} canManageFinance onEditOpening={onEditOpening} />);
    fireEvent.click(screen.getByRole("button", { name: tFor("en")("EditBankOpening") }));
    expect(onEditOpening).toHaveBeenCalledWith(expect.objectContaining({ _id: "bank1" }));
  });

  test("the row button has an Arabic accessible name", () => {
    render(<BankAccountsTable {...baseProps} t={tFor("ar")} canManageFinance onEditOpening={vi.fn()} />);
    expect(screen.getByRole("button", { name: tFor("ar")("EditBankOpening") })).toBeTruthy();
    expect(tFor("ar")("EditBankOpening")).not.toBe("EditBankOpening");
    expect(tFor("ar")("EditBankOpening")).not.toBe(tFor("en")("EditBankOpening"));
  });
});

describe("EditBankOpeningDialog", () => {
  function renderDialog(overrides: Partial<Parameters<typeof EditBankOpeningDialog>[0]> = {}) {
    const onSave = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <EditBankOpeningDialog
        account={account()}
        saving={false}
        t={tFor("en")}
        onOpenChange={onOpenChange}
        onSave={onSave}
        {...overrides}
      />,
    );
    return { onSave, onOpenChange };
  }

  const amountInput = () => screen.getByLabelText(tFor("en")("StatedOpeningBalance")) as HTMLInputElement;
  const dateInput = () => screen.getByLabelText(tFor("en")("OpeningBalanceDate")) as HTMLInputElement;

  test("shows the bank name and currency read-only and prefills amount and date", () => {
    renderDialog();
    expect(screen.getByText("Operating JOD")).toBeTruthy();
    expect(screen.getByText("JOD")).toBeTruthy();
    expect(amountInput().value).toBe("1234.567");
    expect(dateInput().value).toBe("2026-01-01");
    expect(amountInput().getAttribute("dir")).toBe("ltr");
    expect(amountInput().getAttribute("inputmode")).toBe("decimal");
    expect(screen.getByText(tFor("en")("StatedOpeningHelp"))).toBeTruthy();
  });

  test("a valid save hands the exact minor integer and the UTC-midnight date to the handler", () => {
    const { onSave } = renderDialog();
    fireEvent.change(amountInput(), { target: { value: "2000.001" } });
    fireEvent.change(dateInput(), { target: { value: "2026-03-15" } });
    fireEvent.click(screen.getByRole("button", { name: tFor("en")("Save") }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      bankAccountId: "bank1",
      openingBalanceMinor: 2_000_001,
      openingBalanceDate: Date.UTC(2026, 2, 15),
    });
  });

  test("an overdrawn (negative) stated opening is accepted", () => {
    const { onSave } = renderDialog();
    fireEvent.change(amountInput(), { target: { value: "-1234.567" } });
    fireEvent.click(screen.getByRole("button", { name: tFor("en")("Save") }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ openingBalanceMinor: -1_234_567 }));
  });

  test("an over-precise amount shows the error and never calls the handler", () => {
    const { onSave } = renderDialog();
    fireEvent.change(amountInput(), { target: { value: "1.2345" } });
    expect(screen.getByRole("alert").textContent).toContain(tFor("en")("StatedOpeningInvalidAmount"));
    const save = screen.getByRole("button", { name: tFor("en")("Save") }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  test("an empty date shows the date error and never calls the handler", () => {
    const { onSave } = renderDialog();
    fireEvent.change(dateInput(), { target: { value: "" } });
    expect(screen.getByRole("alert").textContent).toContain(tFor("en")("StatedOpeningInvalidDate"));
    fireEvent.click(screen.getByRole("button", { name: tFor("en")("Save") }));
    expect(onSave).not.toHaveBeenCalled();
  });

  test("while saving the Save button is disabled", () => {
    renderDialog({ saving: true });
    expect((screen.getByRole("button", { name: new RegExp(tFor("en")("Save")) }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("renders nothing when no account is being edited", () => {
    renderDialog({ account: null });
    expect(screen.queryByLabelText(tFor("en")("StatedOpeningBalance"))).toBeNull();
  });

  test("the Arabic locale renders the Arabic labels, help text and errors", () => {
    const t = tFor("ar");
    renderDialog({ t });
    for (const key of ["StatedOpeningBalance", "OpeningBalanceDate", "StatedOpeningHelp", "Save", "Cancel"]) {
      expect(t(key)).not.toBe(key);
      expect(t(key)).not.toBe(tFor("en")(key));
    }
    const amount = screen.getByLabelText(t("StatedOpeningBalance")) as HTMLInputElement;
    expect(screen.getByText(t("StatedOpeningHelp"))).toBeTruthy();
    fireEvent.change(amount, { target: { value: "1.2345" } });
    expect(screen.getByRole("alert").textContent).toContain(t("StatedOpeningInvalidAmount"));
    expect(t("StatedOpeningInvalidAmount")).not.toBe(tFor("en")("StatedOpeningInvalidAmount"));
  });
});
