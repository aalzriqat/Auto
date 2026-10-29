"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { usePermissions } from "@/hooks/use-permissions";
import { toast } from "@/components/ui/sonner";
import { errorMessage, LoadingAccountingState, scaleForCurrency } from "./AccountingTabShared";
import { BankAccountsTable } from "./bankAccounts/BankAccountsTable";
import { BankOpeningReconciliationPanel } from "./bankAccounts/BankOpeningReconciliationPanel";
import { CreateBankAccountDialog } from "./bankAccounts/CreateBankAccountDialog";
import { ReconciliationPanel } from "./bankAccounts/ReconciliationPanel";
import { formatMinorAmount } from "./reports/FinancialReportShared";
import { dateInputToMs, defaultCreateBankAccountForm, type CreateBankAccountFormState } from "./bankAccounts/types";

export function BankAccountsTab() {
  const { activeOrgId } = useOrg();
  const { t, locale } = useLanguage();
  const { code: orgCurrency } = useCurrency();
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateBankAccountFormState>(defaultCreateBankAccountForm(orgCurrency));
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const accounts = useQuery(api.bankAccounts.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const bookBalance = useQuery(api.bankAccounts.getBookBalance, activeOrgId ? { orgId: activeOrgId } : "skip");
  const openingReconciliation = useQuery(api.bankAccounts.openingReconciliation, activeOrgId ? { orgId: activeOrgId } : "skip");

  const createAccount = useMutation(api.bankAccounts.create);
  const setReconciliationTarget = useMutation(api.bankAccounts.setReconciliationTarget);
  const deactivateAccount = useMutation(api.bankAccounts.deactivate);

  // Each bank states its own currency, so an amount is formatted with that currency and its own minor-unit precision
  // (ISO 4217: JOD 3, USD 2), through the repo's minor-unit formatter. The numbering system is pinned to latn
  // (ECMA-402 `-u-nu-latn`) so Arabic keeps Western digits. A currency whose scale AutoFlow cannot vouch for shows a
  // dash, never a guessed scale.
  const moneyLocale = locale === "ar" ? "ar-u-nu-latn" : "en-US";
  const formatBankMinor = (minor: number, currency: string) => {
    try {
      return formatMinorAmount(minor, currency, moneyLocale);
    } catch {
      return "—";
    }
  };

  const canManageFinance =!permissionsLoading && hasPermission(PERMISSIONS.MANAGE_FINANCE);

  async function runAction(actionName: string, action: () => Promise<unknown>, successMessage: string) {
    setBusyAction(actionName);
    try {
      await action();
      toast.success(successMessage);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }

  async function submitCreate() {
    if (!activeOrgId) return;
    await runAction(
      "create",
      async () => {
        const scale = scaleForCurrency(form.currency);
        const factor = Math.pow(10, scale);
        await createAccount({
          orgId: activeOrgId,
          name: form.name.trim(),
          bankName: form.bankName.trim() || undefined,
          iban: form.iban.trim() || undefined,
          accountNumber: form.accountNumber.trim() || undefined,
          currency: form.currency,
          openingBalanceMinor: Math.round(Number(form.openingBalance || "0") * factor),
          openingBalanceDate: dateInputToMs(form.openingBalanceDate),
          isReconciliationTarget: form.isReconciliationTarget,
          notes: form.notes.trim() || undefined,
        });
        setCreateOpen(false);
        setForm(defaultCreateBankAccountForm(orgCurrency));
      },
      t("BankAccountCreated" as any)
    );
  }

  if (!activeOrgId) return null;
  if (accounts === undefined) return <LoadingAccountingState label={t("Loading")} />;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t("BankAccounts" as any)}</h2>
          <p className="text-sm text-muted-foreground">{t("BankAccountsDesc" as any)}</p>
        </div>
        <CreateBankAccountDialog
          open={createOpen}
          form={form}
          submitting={busyAction === "create"}
          disabled={!canManageFinance}
          t={t as any}
          onOpenChange={setCreateOpen}
          onFormChange={setForm}
          onSubmit={submitCreate}
        />
      </div>

      {bookBalance && (
        <div className="rounded-md border border-border bg-muted/50 p-4">
          <p className="text-sm text-muted-foreground">{t("BookBalanceFor" as any)}: <strong>{bookBalance.name ?? ""}</strong></p>
          {bookBalance.balanceMinor === null || bookBalance.currency === null ? (
            <p className="text-sm text-foreground" role="status">
              {t(
                bookBalance.status === "BALANCE_HISTORY_INCOMPLETE"
                  ? "BookBalanceUnavailableHistoryIncomplete"
                  : "BookBalanceUnavailableNoBankAttribution"
              )}
            </p>
          ) : (
            <p className="text-2xl font-semibold text-foreground">
              {formatBankMinor(bookBalance.balanceMinor, bookBalance.currency)}
            </p>
          )}
        </div>
      )}

      {openingReconciliation && (
        <BankOpeningReconciliationPanel
          reconciliation={openingReconciliation}
          formatMinor={formatBankMinor}
        />
      )}

      <BankAccountsTable
        accounts={accounts}
        canManageFinance={canManageFinance}
        busyAction={busyAction}
        t={t as any}
        onSetReconciliationTarget={(bankAccountId) =>
          void runAction(
            `setTarget_${bankAccountId}`,
            () => setReconciliationTarget({ orgId: activeOrgId, bankAccountId }),
            t("ReconciliationTargetUpdated" as any)
          )
        }
        onDeactivate={(bankAccountId: Id<"bankAccounts">) =>
          void runAction(
            `deactivate_${bankAccountId}`,
            () => deactivateAccount({ orgId: activeOrgId, bankAccountId }),
            t("BankAccountDeactivated" as any)
          )
        }
      />

      {bookBalance && bookBalance.bankAccountId && bookBalance.currency && (
        <ReconciliationPanel
          orgId={activeOrgId}
          bankAccountId={bookBalance.bankAccountId}
          currency={bookBalance.currency}
          canManageFinance={canManageFinance}
        />
      )}
    </div>
  );
}
