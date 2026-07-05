"use client";

import { Loader2, Star, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { AccountingEmptyRow, AccountingTableFrame } from "../AccountingTabShared";
import type { BankAccountSummary, Translate } from "./types";

type BankAccountsTableProps = {
  accounts: readonly BankAccountSummary[];
  canManageFinance: boolean;
  busyAction: string | null;
  t: Translate;
  onSetReconciliationTarget: (bankAccountId: BankAccountSummary["_id"]) => void;
  onDeactivate: (bankAccountId: BankAccountSummary["_id"]) => void;
};

export function BankAccountsTable({
  accounts,
  canManageFinance,
  busyAction,
  t,
  onSetReconciliationTarget,
  onDeactivate,
}: Readonly<BankAccountsTableProps>) {
  return (
    <div className="space-y-3">
      <h3 className="text-base font-semibold text-slate-900">{t("BankAccounts" as any)}</h3>
      <AccountingTableFrame>
        <Table>
          <TableHeader className="bg-slate-50">
            <TableRow>
              <TableHead>{t("BankAccountName" as any)}</TableHead>
              <TableHead>{t("Iban" as any)}</TableHead>
              <TableHead>{t("Currency" as any)}</TableHead>
              <TableHead>{t("Status" as any)}</TableHead>
              <TableHead className="text-right">{t("Actions" as any)}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.length === 0 ? (
              <AccountingEmptyRow colSpan={5} label={t("NoBankAccounts" as any)} />
            ) : (
              accounts.map((account) => {
                const settingTarget = busyAction === `setTarget_${account._id}`;
                const deactivating = busyAction === `deactivate_${account._id}`;
                return (
                  <TableRow key={account._id}>
                    <TableCell className="font-medium">
                      {account.name}
                      {account.bankName && <span className="text-slate-500 font-normal"> — {account.bankName}</span>}
                    </TableCell>
                    <TableCell className="text-slate-500">{account.iban || "—"}</TableCell>
                    <TableCell>{account.currency}</TableCell>
                    <TableCell>
                      {account.isReconciliationTarget ? (
                        <Badge variant="outline" className="bg-emerald-50 text-emerald-700 border-emerald-200 gap-1">
                          <Star className="h-3 w-3" />
                          {t("ReconciliationTarget" as any)}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-slate-50 text-slate-600 border-slate-200">
                          {t("ReferenceOnly" as any)}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right space-x-2">
                      {canManageFinance && !account.isReconciliationTarget && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={settingTarget}
                          onClick={() => onSetReconciliationTarget(account._id)}
                        >
                          {settingTarget && <Loader2 className="h-4 w-4 animate-spin" />}
                          {t("MakeReconciliationTarget" as any)}
                        </Button>
                      )}
                      {canManageFinance && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-rose-600 hover:text-rose-700"
                          disabled={deactivating}
                          onClick={() => onDeactivate(account._id)}
                        >
                          {deactivating ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                          {t("Deactivate" as any)}
                        </Button>
                      )}
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
