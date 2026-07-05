import type { Id } from "@/convex/_generated/dataModel";

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
    openingBalanceDate: new Date().toISOString().slice(0, 10),
    isReconciliationTarget: false,
    notes: "",
  };
}

export function dateInputToMs(value: string): number {
  return new Date(`${value}T00:00:00`).getTime();
}
