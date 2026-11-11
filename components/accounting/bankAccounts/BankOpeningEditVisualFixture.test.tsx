/**
 * SCRUM-945 static visual fixture. Mounts the REAL BankOpeningReconciliationPanel, BankAccountsTable and
 * EditBankOpeningDialog under the real LanguageProvider with synthetic rows (no Convex, no Clerk), and writes the
 * rendered HTML of three states per locale for playwright/visual/bank-opening-edit.visual.spec.ts to paint:
 *   table  - bank table with the edit control, dialog closed
 *   dialog - dialog open, prefilled from the stored values
 *   error  - dialog open with an over-precise amount showing the inline error
 * The Radix dialog portals into document.body, so body.innerHTML captures the dialog as it is rendered.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LanguageProvider, useLanguage } from "@/components/providers/LanguageProvider";
import { formatMinorAmount } from "../reports/FinancialReportShared";
import { BankAccountsTable } from "./BankAccountsTable";
import { BankOpeningReconciliationPanel } from "./BankOpeningReconciliationPanel";
import { EditBankOpeningDialog } from "./EditBankOpeningDialog";
import type { BankAccountSummary } from "./types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Reconciliation = Parameters<typeof BankOpeningReconciliationPanel>[0]["reconciliation"];

const ACCOUNTS: BankAccountSummary[] = [
  {
    _id: "bank-a" as BankAccountSummary["_id"], name: "Synthetic operating account", bankName: "Synthetic Bank One",
    iban: "JO00SYNT0000000000000000000001", currency: "JOD", openingBalanceMinor: 4_100_000,
    openingBalanceDate: Date.UTC(2026, 0, 1), isActive: true, isReconciliationTarget: true,
  },
  {
    _id: "bank-b" as BankAccountSummary["_id"], name: "Synthetic savings account", bankName: "Synthetic Bank Two",
    iban: "JO00SYNT0000000000000000000002", currency: "JOD", openingBalanceMinor: 3_000_000,
    openingBalanceDate: Date.UTC(2026, 0, 1), isActive: true, isReconciliationTarget: false,
  },
];

const RECONCILIATION = {
  status: "OK",
  currency: "JOD",
  asOfDate: Date.UTC(2026, 0, 1),
  controlOpeningMinor: 7_000_000,
  bankLinesTotalMinor: 7_000_000,
  unattributedOpeningMinor: 0,
  banks: [
    { bankAccountId: "bank-a", name: "Synthetic operating account", currency: "JOD", openingLineMinor: 4_000_000, referenceOpeningMinor: 4_100_000, differenceMinor: 100_000 },
    { bankAccountId: "bank-b", name: "Synthetic savings account", currency: "JOD", openingLineMinor: 3_000_000, referenceOpeningMinor: 3_000_000, differenceMinor: 0 },
  ],
  unexplainedOpeningDifference: {
    label: {
      en: "Unexplained opening-balance reconciliation difference",
      ar: "فرق أرصدة افتتاحية غير مفسر قيد المطابقة",
    },
    currencies: [{ currency: "JOD", differenceMinor: 100_000, absoluteDifferenceMinor: 100_000 }],
  },
} as unknown as Reconciliation;

function Screen({ editing }: Readonly<{ editing: BankAccountSummary | null }>) {
  const { t, locale } = useLanguage();
  const moneyLocale = locale === "ar" ? "ar-u-nu-latn" : "en-US";
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <BankOpeningReconciliationPanel
        reconciliation={RECONCILIATION}
        formatMinor={(minor, currency) => formatMinorAmount(minor, currency, moneyLocale)}
      />
      <BankAccountsTable
        accounts={ACCOUNTS}
        canManageFinance
        busyAction={null}
        t={t as (key: string) => string}
        onSetReconciliationTarget={() => {}}
        onDeactivate={() => {}}
        onEditOpening={() => {}}
      />
      <EditBankOpeningDialog account={editing} saving={false} t={t as (key: string) => string} onOpenChange={() => {}} onSave={() => {}} />
    </main>
  );
}

function write(name: string) {
  const directory = process.env.BANK_OPENING_EDIT_VISUAL_FIXTURE_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, name), document.body.innerHTML);
}

test.each(["en", "ar"] as const)("bank opening edit visual fixture %s", (locale) => {
  vi.stubGlobal("localStorage", { getItem: () => locale, setItem: () => {} });

  // 1. table with the edit control, dialog closed
  render(<LanguageProvider><Screen editing={null} /></LanguageProvider>);
  expect(screen.getAllByRole("button").length).toBeGreaterThan(0);
  expect(screen.queryByRole("dialog")).toBeNull();
  write(`bank-opening-${locale}-table.html`);
  cleanup();

  // 2. dialog open, prefilled
  render(<LanguageProvider><Screen editing={ACCOUNTS[0]} /></LanguageProvider>);
  expect(screen.getByRole("dialog")).toBeTruthy();
  const amount = document.getElementById("stated-opening-amount") as HTMLInputElement;
  expect(amount.value).toBe("4100.000");
  write(`bank-opening-${locale}-dialog.html`);

  // 3. over-precise amount: inline error
  fireEvent.change(amount, { target: { value: "1.2345" } });
  expect(screen.getByRole("alert")).toBeTruthy();
  write(`bank-opening-${locale}-error.html`);
});
