"use client";

/**
 * The «عرض البنود» (view lines) dialog of one General Ledger journal entry.
 *
 * Moved out of GeneralLedgerTab unchanged in behaviour (same query result, same
 * amounts, same test ids) so that SCRUM-1013's localized account names, bank
 * names, transfer legs and period label fit without growing that file further.
 */
import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrencyFormatterInCurrency } from "@/hooks/useCurrencyFormatter";
import { supportedCurrencyScale } from "./AccountingTabShared";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  JournalEntryDescription,
  JournalLineDescription,
  localizedAccountName,
  type LedgerAccountLike,
} from "./journalEntryDisplay";

export type JournalEntryDetails = FunctionReturnType<typeof api.accountingLedger.getJournalEntry>;

export function JournalEntryLinesDialog({ open, onClose, entryDetails, accountsById }: {
  open: boolean;
  onClose: () => void;
  /** undefined while loading; null when the entry is not readable. */
  entryDetails: JournalEntryDetails | undefined;
  accountsById: ReadonlyMap<string, LedgerAccountLike>;
}) {
  const { t, locale } = useLanguage();
  const formatInCurrency = useCurrencyFormatterInCurrency();
  const localeCode = locale === "ar" ? "ar-JO" : "en-US";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("JournalLines")}{" "}
            {entryDetails?.entry?.journalNumber ? (
              <>(<bdi dir="ltr">{entryDetails.entry.journalNumber}</bdi>)</>
            ) : null}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-1">
              {entryDetails?.entry && entryDetails.display && (
                <JournalEntryDescription
                  t={t}
                  entry={{ ...entryDetails.entry, display: entryDetails.display }}
                  locale={locale}
                  hideStoredMemo
                />
              )}
              {entryDetails?.entry?.memo ? (
                <span className="flex min-w-0 gap-1 text-xs text-muted-foreground" data-testid="dialog-entry-memo">
                  <span className="shrink-0">{t("JournalRecordedText")}:</span>
                  <bdi dir="auto" className="min-w-0 break-words">{entryDetails.entry.memo}</bdi>
                </span>
              ) : null}
              {entryDetails?.period && (
                <span className="block text-xs text-muted-foreground" data-testid="dialog-entry-period">
                  {t("JournalPeriod")}:{" "}
                  <bdi dir="ltr" className="font-mono">{entryDetails.period.fiscalYear}-P{entryDetails.period.periodNumber}</bdi>{" "}
                  (<bdi>{new Date(entryDetails.period.startDate).toLocaleDateString(localeCode)}</bdi> –{" "}
                  <bdi>{new Date(entryDetails.period.endDate).toLocaleDateString(localeCode)}</bdi>)
                </span>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>{t("Account")}</TableHead>
                <TableHead>{t("DescriptionLabel")}</TableHead>
                <TableHead className="text-right">{t("Debit")}</TableHead>
                <TableHead className="text-right">{t("Credit")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!entryDetails?.lines ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-4 text-center text-muted-foreground">
                    {t("Loading")}
                  </TableCell>
                </TableRow>
              ) : (
                entryDetails.lines.map((line) => {
                  const effectiveCurrency = line.currency || entryDetails.entry?.currency;
                  const effectiveScale =
                    line.scale !== undefined
                      ? line.scale
                      : effectiveCurrency
                        ? supportedCurrencyScale(effectiveCurrency)
                        : null;
                  const lineFactor = effectiveScale !== null ? Math.pow(10, effectiveScale) : null;
                  const account = accountsById.get(line.accountId as string);

                  const formatLineAmount = (minor: number) => {
                    if (minor <= 0) return "-";
                    if (effectiveCurrency && effectiveScale !== null && lineFactor !== null) {
                      return formatInCurrency(minor / lineFactor, effectiveCurrency, effectiveScale);
                    }
                    return `[Unverified Scale: ${minor} minor]`;
                  };

                  return (
                    <TableRow key={line._id} data-testid="journal-line-row">
                      <TableCell className="text-xs" data-testid="line-account">
                        {account ? (
                          <span>
                            <bdi dir="ltr" className="font-mono font-medium">{account.code}</bdi>{" "}
                            <bdi dir="auto" className="text-muted-foreground">({localizedAccountName(account, locale)})</bdi>
                          </span>
                        ) : (
                          <bdi dir="ltr" className="font-mono text-muted-foreground">{line.accountId}</bdi>
                        )}
                        {line.display?.bankName ? (
                          <span className="block text-muted-foreground" data-testid="line-bank">
                            {t("JournalLineBank")}: <bdi>{line.display.bankName}</bdi>
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell data-testid="line-description">
                        <JournalLineDescription t={t} line={line} />
                      </TableCell>
                      <TableCell className="text-right font-medium text-emerald-600 dark:text-emerald-400" data-testid="line-debit">
                        {formatLineAmount(line.debitMinor)}
                      </TableCell>
                      <TableCell className="text-right font-medium text-rose-600 dark:text-rose-400" data-testid="line-credit">
                        {formatLineAmount(line.creditMinor)}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("Cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
