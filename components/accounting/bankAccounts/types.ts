import type { Id } from "@/convex/_generated/dataModel";

export type Translate = (key: string) => string;

export type BankAccountSummary = {
  _id: Id<"bankAccounts">;
  name: string;
  bankName?: string;
  iban?: string;
  accountNumber?: string;
  currency: string;
  isActive: boolean;
  isReconciliationTarget: boolean;
};

export type CreateBankAccountFormState = {
  name: string;
  bankName: string;
  iban: string;
  accountNumber: string;
  currency: string;
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
    isReconciliationTarget: false,
    notes: "",
  };
}
