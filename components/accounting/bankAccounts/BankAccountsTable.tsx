"use client";

import { Loader2, Star, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fromMinorUnits, scaleForCurrency } from "@/convex/utils/money";
import { formatInCurrency } from "@/lib/currencyFormat";
import { AccountingEmptyRow, AccountingTableFrame } from "../AccountingTabShared";
import type { BankAccountSummary, BankBookBalance, Translate } from "./types";

type BankAccountsTableProps = {
  accounts: readonly BankAccountSummary[];
  balances: readonly (BankBookBalance | null)[] | undefined;
  locale: string;
  canManageFinance: boolean;
  busyAction: string | null;
  t: Translate;
  onSetReconciliationTarget: (bankAccountId: BankAccountSummary["_id"]) => void;
  onDeactivate: (bankAccountId: BankAccountSummary["_id"]) => void;
};

export function BankAccountsTable({
  accounts,
  balances,
  locale,
  canManageFinance,
  busyAction,
  t,
  onSetReconciliationTarget,
  onDeactivate,
}: Readonly<BankAccountsTableProps>) {
  const balanceById = new Map((balances ?? []).filter((balance): balance is BankBookBalance => balance !== null && balance.bankAccountId !== null)
    .map((balance) => [balance.bankAccountId, balance]));
  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold text-foreground">{t("BankAccounts" as any)}</h3>
      <AccountingTableFrame>
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead>{t("BankAccountName" as any)}</TableHead>
              <TableHead>{t("Iban" as any)}</TableHead>
              <TableHead>{t("Currency" as any)}</TableHead>
              <TableHead className="text-end">{t("BankBookBalance")}</TableHead>
              <TableHead>{t("Status" as any)}</TableHead>
              <TableHead className="text-end">{t("Actions" as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.length === 0 ? (
              <AccountingEmptyRow colSpan={6} label={t("NoBankAccounts" as any)} />
            ) : (
              accounts.map((account) => {
                const settingTarget = busyAction === `setTarget_${account._id}`;
                const deactivating = busyAction === `deactivate_${account._id}`;
                const balance = balanceById.get(account._id);
                return (
                  <TableRow key={account._id}>
                    <TableCell className="font-medium">
                      {account.name}
                      {account.bankName && <span className="text-muted-foreground font-normal"> — {account.bankName}</span>}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{account.iban || "—"}</TableCell>
                    <TableCell>{account.currency}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {!balances ? (
                        <span className="text-muted-foreground">{t("Loading")}</span>
                      ) : balance?.status === "OK" && balance.balanceMinor !== null && balance.currency ? (
                        <span><bdi>{formatInCurrency(locale === "ar" ? "ar" : "en-US", balance.currency,
                          fromMinorUnits(balance.balanceMinor, balance.currency), scaleForCurrency(balance.currency))}</bdi></span>
                      ) : (
                        <span className="text-amber-700 dark:text-amber-300" role="status">
                          {t(!balance || balance.status === "BALANCE_HISTORY_INCOMPLETE"
                            ? "BookBalanceUnavailableHistoryIncomplete"
                            : "BookBalanceUnavailableNoBankAttribution")}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {account.isDeleted ? (
                        <Badge variant="outline" className="bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                          {t("ClosedBankAccount")}
                        </Badge>
                      ) : account.isReconciliationTarget ? (
                        <Badge variant="outline" className="gap-1 border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
                          <Star className="h-3 w-3" />
                          {t("ReconciliationTarget" as any)}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-muted/50 text-muted-foreground border-border">
                          {t("NotReconciliationTarget")}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-end">
                      <div className="flex flex-wrap justify-end gap-2">
                      {canManageFinance && !account.isDeleted && !account.isReconciliationTarget && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={settingTarget}
                          onClick={() => {
                            if (window.confirm(t("ConfirmSetReconciliationTarget" as any))) {
                              onSetReconciliationTarget(account._id);
                            }
                          }}
                        >
                          {settingTarget && <Loader2 className="h-4 w-4 animate-spin" />}
                          {t("MakeReconciliationTarget" as any)}
                        </Button>
                      )}
                      {canManageFinance && !account.isDeleted && (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={t("Deactivate" as any)}
                          className="text-rose-600 hover:text-rose-700 dark:text-rose-400 dark:hover:text-rose-300"
                          disabled={deactivating}
                          onClick={() => {
                            if (window.confirm(t("ConfirmDeactivateBankAccount" as any))) {
                              onDeactivate(account._id);
                            }
                          }}
                        >
                          {deactivating ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                          {t("Deactivate" as any)}
                        </Button>
                      )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </AccountingTableFrame>
    </div>
  );
}
