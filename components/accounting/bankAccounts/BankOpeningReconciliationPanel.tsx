"use client";

import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AccountingTableFrame } from "../AccountingTabShared";

type OpeningReconciliation = FunctionReturnType<typeof api.bankAccounts.openingReconciliation>;

type Props = {
  reconciliation: OpeningReconciliation;
  /** Formats a minor-unit amount in the given currency. */
  formatMinor: (minor: number, currency: string) => string;
};

/**
 * SCRUM-858 S5 (owner ruling SCRUM-858#c23884): each bank's posted opening beside the balance the dealership
 * stated for it, with any difference shown under the owner's label. Display only: the report is read-only on the
 * server, so nothing here posts a journal or changes a balance.
 */
export function BankOpeningReconciliationPanel({ reconciliation, formatMinor }: Readonly<Props>) {
  const { t, isRtl } = useLanguage();
  if (reconciliation.status === "NO_OPENING") return null;

  if (reconciliation.status === "OPENING_PROOF_UNAVAILABLE") {
    return (
      <p className="rounded-md border border-border bg-muted/50 p-4 text-sm text-foreground" role="status" data-testid="opening-bank-unavailable">
        {t("OpeningBankProofUnavailable" as any)}
      </p>
    );
  }

  const difference = reconciliation.unexplainedOpeningDifference;
  const unattributed = reconciliation.unattributedOpeningMinor ?? 0;
  const openingCurrency = reconciliation.currency ?? "";
  return (
    <section className="space-y-3" data-testid="opening-bank-panel">
      <h3 className="text-base font-semibold text-foreground">{t("OpeningBankPanelTitle" as any)}</h3>
      <AccountingTableFrame>
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>{t("BankAccountName" as any)}</TableHead>
              <TableHead className="text-end">{t("OpeningBankPosted" as any)}</TableHead>
              <TableHead className="text-end">{t("OpeningBankStated" as any)}</TableHead>
              <TableHead className="text-end">{t("OpeningBankDifference" as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {reconciliation.banks.map((bank) => (
              <TableRow key={bank.bankAccountId} data-testid={`opening-bank-row-${bank.bankAccountId}`}>
                <TableCell className="font-medium">{bank.name}</TableCell>
                <TableCell className="text-end tabular-nums">
                  {bank.openingLineMinor === null ? "—" : formatMinor(bank.openingLineMinor, bank.currency)}
                </TableCell>
                <TableCell className="text-end tabular-nums">{formatMinor(bank.referenceOpeningMinor, bank.currency)}</TableCell>
                <TableCell className="text-end tabular-nums">
                  {bank.differenceMinor === null || bank.differenceMinor === 0 ? "—" : formatMinor(bank.differenceMinor, bank.currency)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </AccountingTableFrame>
      {unattributed !== 0 && (
        <p className="text-sm text-amber-700 dark:text-amber-500" role="note" data-testid="opening-bank-unattributed">
          {t("OpeningBankUnattributed" as any)}: {formatMinor(unattributed, openingCurrency)}
        </p>
      )}
      {difference && (
        <div className="rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200" role="note" data-testid="opening-bank-difference">
          <p className="font-semibold">{isRtl ? difference.label.ar : difference.label.en}</p>
          <ul className="mt-1 space-y-0.5">
            {difference.currencies.map((entry) => (
              <li key={entry.currency} className="tabular-nums">
                {t("OpeningBankNet" as any)}: {formatMinor(entry.differenceMinor, entry.currency)} · {t("OpeningBankAbsolute" as any)}:{" "}
                {formatMinor(entry.absoluteDifferenceMinor, entry.currency)}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs">{t("OpeningBankReportOnly" as any)}</p>
        </div>
      )}
    </section>
  );
}
