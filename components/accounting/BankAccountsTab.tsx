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
import { Button } from "@/components/ui/button";
import { getLocalizedErrorMessage } from "@/lib/errors";
import { LoadingAccountingState } from "./AccountingTabShared";
import { BankAccountsTable } from "./bankAccounts/BankAccountsTable";
import { CreateBankAccountDialog } from "./bankAccounts/CreateBankAccountDialog";
import { ReconciliationPanel } from "./bankAccounts/ReconciliationPanel";
import { defaultCreateBankAccountForm, type CreateBankAccountFormState } from "./bankAccounts/types";

export function BankAccountsTab({ onOpenAccountingSetup }: Readonly<{ onOpenAccountingSetup: () => void }>) {
  const { activeOrgId } = useOrg();
  const { t, locale } = useLanguage();
  const { code: orgCurrency } = useCurrency();
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState<CreateBankAccountFormState>(defaultCreateBankAccountForm(orgCurrency));
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const accounts = useQuery(api.bankAccounts.list, activeOrgId ? { orgId: activeOrgId } : "skip");
  const bankBalances = useQuery(api.bankAccounts.listBookBalances, activeOrgId ? { orgId: activeOrgId } : "skip");

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
      toast.error(getLocalizedErrorMessage(error, t));
    } finally {
      setBusyAction(null);
    }
  }

  async function submitCreate() {
    if (!activeOrgId) return;
    await runAction(
      "create",
      async () => {
        await createAccount({
          orgId: activeOrgId,
          name: form.name.trim(),
          bankName: form.bankName.trim() || undefined,
          iban: form.iban.trim() || undefined,
          accountNumber: form.accountNumber.trim() || undefined,
          currency: form.currency,
          // Both fields remain required on the currently deployed backend.
          // Zero cannot be mistaken for a posted GL opening during rollout.
          openingBalanceMinor: 0,
          openingBalanceDate: Date.now(),
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
  const reconciliationTarget = accounts.find((account) => account.isReconciliationTarget && !account.isDeleted);
  const targetBalance = bankBalances?.find((balance) => balance?.bankAccountId === reconciliationTarget?._id);
  const historicalAccounts = (bankBalances ?? []).flatMap((balance) => {
    if (!balance?.isDeleted || !balance.bankAccountId || !balance.name || !balance.currency) return [];
    return [{
      _id: balance.bankAccountId,
      name: balance.name,
      currency: balance.currency,
      isActive: false,
      isDeleted: true,
      isReconciliationTarget: false,
    }];
  });

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-foreground">{t("BankAccounts" as any)}</h2>
          <p className="text-sm text-muted-foreground">{t("BankAccountsDesc" as any)}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("BankStartingBalanceInSetup")}</p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {canManageFinance && (
            <Button type="button" size="sm" variant="outline" onClick={onOpenAccountingSetup}>
              {t("OpeningBalance")}
            </Button>
          )}
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
      </div>

      <BankAccountsTable
        accounts={[...accounts, ...historicalAccounts]}
        balances={bankBalances}
        locale={locale}
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

      {reconciliationTarget && targetBalance?.bankAccountId && targetBalance.currency && (
        <ReconciliationPanel
          orgId={activeOrgId}
          bankAccountId={reconciliationTarget._id}
          currency={reconciliationTarget.currency}
          canManageFinance={canManageFinance}
        />
      )}
    </div>
  );
}
