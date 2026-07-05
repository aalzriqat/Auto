"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { usePermissions } from "@/hooks/use-permissions";
import { toast } from "@/components/ui/sonner";
import { errorMessage, LoadingAccountingState, scaleForCurrency } from "./AccountingTabShared";
import { BankAccountsTable } from "./bankAccounts/BankAccountsTable";
import { CreateBankAccountDialog } from "./bankAccounts/CreateBankAccountDialog";
import { ReconciliationPanel } from "./bankAccounts/ReconciliationPanel";
import { dateInputToMs, defaultCreateBankAccountForm, type CreateBankAccountFormState } from "./bankAccounts/types";

export function BankAccountsTab() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { code: orgCurrency } = useCurrency();
  const formatCurrency = useCurrencyFormatter();
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateBankAccountFormState>(defaultCreateBankAccountForm(orgCurrency));
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const accounts = useQuery(api.bankAccounts.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const bookBalance = useQuery(api.bankAccounts.getBookBalance, activeOrgId ? { orgId: activeOrgId } : "skip");

  const createAccount = useMutation(api.bankAccounts.create);
  const setReconciliationTarget = useMutation(api.bankAccounts.setReconciliationTarget);
  const deactivateAccount = useMutation(api.bankAccounts.deactivate);

  const canManageFinance = !permissionsLoading && hasPermission(PERMISSIONS.MANAGE_FINANCE);

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
          <h2 className="text-lg font-semibold text-slate-900">{t("BankAccounts" as any)}</h2>
          <p className="text-sm text-slate-500">{t("BankAccountsDesc" as any)}</p>
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
        <div className="rounded-md border border-slate-200 bg-slate-50 p-4">
          <p className="text-sm text-slate-500">{t("BookBalanceFor" as any)}: <strong>{bookBalance.name}</strong></p>
          <p className="text-2xl font-semibold text-slate-900">
            {formatCurrency(bookBalance.balanceMinor / Math.pow(10, scaleForCurrency(bookBalance.currency)))}
          </p>
        </div>
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

      {bookBalance && (
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
