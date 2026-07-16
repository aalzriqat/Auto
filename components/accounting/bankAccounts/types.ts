import type { Id } from "@/convex/_generated/dataModel";
import { dateInputToUtcMs, todayDateInput } from "@/lib/dateInput";

export type Translate = (key: string) => string;

export type BankAccountSummary = {
  _id: Id<"bankAccounts">;
  name: string;
  bankName?: string;
  iban?: string;
  accountNumber?: string;
  currency: string;
  openingBalanceMinor: number;
  openingBalanceDate: number;
  isActive: boolean;
  isReconciliationTarget: boolean;
};

export type CreateBankAccountFormState = {
  name: string;
  bankName: string;
  iban: string;
  accountNumber: string;
  currency: string;
  openingBalance: string;
  openingBalanceDate: string;
  isReconciliationTarget: boolean;
  notes: string;
};

export function defaultCreateBankAccountForm(currency: string): CreateBankAccountFormState {
  return {
    name: "",
    bankName: "",
    iban: "",
    accountNumber: "",
    currency,
    openingBalance: "0",
    openingBalanceDate: todayDateInput(),
    isReconciliationTarget: false,
    notes: "",
  };
}

export function dateInputToMs(value: string): number {
  // Shared UTC parser (lib/dateInput.ts); the specific message is kept because
  // this feeds the opening-balance date.
  const ms = dateInputToUtcMs(value);
  if (Number.isNaN(ms)) {
    throw new Error("A valid opening balance date is required.");
  }
  return ms;
}
