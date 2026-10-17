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
  isDeleted?: boolean;
  isReconciliationTarget: boolean;
};

export type BankBookBalance = {
  bankAccountId: Id<"bankAccounts"> | null;
  name: string | null;
  currency: string | null;
  isDeleted: boolean;
  status: "OK" | "UNATTRIBUTED_GL_ACTIVITY" | "BALANCE_HISTORY_INCOMPLETE";
  balanceMinor: number | null;
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
