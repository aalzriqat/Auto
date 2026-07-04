"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useOrg } from "@/components/providers/OrgProvider";
import { usePermissions } from "@/hooks/use-permissions";
import { toast } from "@/components/ui/sonner";
import { errorMessage, LoadingAccountingState } from "./AccountingTabShared";
import { AccountingPeriodsTable, accountingPeriodActionKey } from "./setup/AccountingPeriodsTable";
import { CreateAccountingPeriodDialog } from "./setup/CreateAccountingPeriodDialog";
import { PendingAccountingEventsTable } from "./setup/PendingAccountingEventsTable";
import { SetupStatusCards } from "./setup/SetupStatusCards";
import {
  dateInputToEndOfDayMs,
  dateInputToStartOfDayMs,
  defaultPeriodForm,
  type PeriodFormState,
} from "./setup/types";

type SetupActionMessage<T> = (outcome: T) => string;

export function AccountingSetupTab() {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();
  const [periodDialogOpen, setPeriodDialogOpen] = useState(false);
  const [periodForm, setPeriodForm] = useState<PeriodFormState>(defaultPeriodForm);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const setupStatus = useQuery(
    api.accountingSetup.status,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
  const initializeChart = useMutation(api.chartOfAccounts.initialize);
  const createPeriod = useMutation(api.accountingPeriods.create);
  const openPeriod = useMutation(api.accountingPeriods.open);
  const closePeriod = useMutation(api.accountingPeriods.close);
  const lockPeriod = useMutation(api.accountingPeriods.lock);
  const redriveOutbox = useMutation(api.accountingOutbox.redrive);

  const canManageFinance = !permissionsLoading && hasPermission(PERMISSIONS.MANAGE_FINANCE);

  async function runSetupAction<T>(
    actionName: string,
    action: () => Promise<T>,
    successMessage: SetupActionMessage<T>
  ): Promise<T | null> {
    setBusyAction(actionName);
    try {
      const outcome = await action();
      toast.success(successMessage(outcome));
      return outcome;
    } catch (error) {
      toast.error(errorMessage(error));
      return null;
    } finally {
      setBusyAction(null);
    }
  }

  async function submitPeriod() {
    if (!activeOrgId) return;
    const createdPeriodId = await runSetupAction(
      "createPeriod",
      () => createPeriod({
        orgId: activeOrgId,
        fiscalYear: Number(periodForm.fiscalYear),
        periodNumber: Number(periodForm.periodNumber),
        startDate: dateInputToStartOfDayMs(periodForm.startDate),
        endDate: dateInputToEndOfDayMs(periodForm.endDate),
        openImmediately: periodForm.openImmediately,
      }),
      () => t("AccountingPeriodCreated")
    );
    if (!createdPeriodId) return;
    setPeriodDialogOpen(false);
    setPeriodForm(defaultPeriodForm());
  }

  function periodAction(
    periodId: Id<"accountingPeriods">,
    action: "open" | "close" | "lock",
    mutation: () => Promise<Id<"accountingPeriods">>,
    successKey: string
  ) {
    void runSetupAction(accountingPeriodActionKey(periodId, action), mutation, () => t(successKey));
  }

  if (!activeOrgId) return null;
  if (setupStatus === undefined) return <LoadingAccountingState label={t("Loading")} />;

  const chartReady = setupStatus.chartInitialized && setupStatus.systemAccountsValid;
  const postingReady = chartReady && setupStatus.currentOpenPeriod !== null;
  const redriveDisabled = !canManageFinance || !postingReady || setupStatus.pendingEvents.length === 0;

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">{t("AccountingSetup")}</h2>
        <p className="text-sm text-slate-500">{t("AccountingSetupDesc")}</p>
      </div>

      <SetupStatusCards
        chartInitialized={setupStatus.chartInitialized}
        chartReady={chartReady}
        missingSystemAccountKeys={setupStatus.missingSystemAccountKeys}
        currentOpenPeriod={setupStatus.currentOpenPeriod}
        pendingEventCount={setupStatus.pendingEvents.length}
        canManageFinance={canManageFinance}
        initializeBusy={busyAction === "initializeChart"}
        redriveBusy={busyAction === "redrive"}
        redriveDisabled={redriveDisabled}
        t={t}
        onInitializeChart={() => {
          void runSetupAction(
            "initializeChart",
            () => initializeChart({ orgId: activeOrgId }),
            () => t("ChartOfAccountsInitialized")
          );
        }}
        onRedrive={() => {
          void runSetupAction(
            "redrive",
            () => redriveOutbox({ orgId: activeOrgId }),
            (outcome) =>
              t("AccountingOutboxRedrivenResult" as any)
                .replace("{posted}", String(outcome.posted))
                .replace("{failed}", String(outcome.failed))
          );
        }}
        periodDialog={
          <CreateAccountingPeriodDialog
            open={periodDialogOpen}
            periodForm={periodForm}
            submitting={busyAction === "createPeriod"}
            disabled={!canManageFinance}
            t={t}
            onOpenChange={setPeriodDialogOpen}
            onFormChange={setPeriodForm}
            onSubmit={submitPeriod}
          />
        }
      />

      {!canManageFinance && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("AccountingSetupManageFinanceRequired")}</span>
        </div>
      )}

      <AccountingPeriodsTable
        periods={setupStatus.recentPeriods}
        canManageFinance={canManageFinance}
        busyAction={busyAction}
        t={t}
        onOpen={(periodId) =>
          periodAction(
            periodId,
            "open",
            () => openPeriod({ orgId: activeOrgId, periodId }),
            "AccountingPeriodOpened"
          )
        }
        onClose={(periodId) =>
          periodAction(
            periodId,
            "close",
            () => closePeriod({ orgId: activeOrgId, periodId }),
            "AccountingPeriodClosed"
          )
        }
        onLock={(periodId) =>
          periodAction(
            periodId,
            "lock",
            () => lockPeriod({ orgId: activeOrgId, periodId }),
            "AccountingPeriodLocked"
          )
        }
      />

      <PendingAccountingEventsTable
        events={setupStatus.pendingEvents}
        hasMore={setupStatus.hasMorePendingEvents}
        t={t}
      />
    </div>
  );
}
