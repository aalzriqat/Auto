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
import { ClosePeriodReviewDialog } from "./setup/ClosePeriodReviewDialog";
import { PendingAccountingEventsTable } from "./setup/PendingAccountingEventsTable";
import { SetupStatusCards } from "./setup/SetupStatusCards";
import { OpeningBalanceCard } from "./setup/OpeningBalanceCard";
import { OpeningBalanceApprovalPanel } from "./setup/OpeningBalanceApprovalPanel";
import { SystemAccountConflictsPanel } from "./setup/SystemAccountConflictsPanel";
import {
  dateInputToEndOfDayMs,
  dateInputToStartOfDayMs,
  defaultPeriodForm,
  type PeriodFormState,
  type PeriodSummary,
} from "./setup/types";

type SetupActionMessage<T> = (outcome: T) => string;

export type AccountingSetupView = "all" | "settings" | "close";

export function AccountingSetupTab({ view = "all" }: Readonly<{ view?: AccountingSetupView }> = {}) {
  const { activeOrgId } = useOrg();
  const { t } = useLanguage();
  const { hasPermission, isOwner, isLoading: permissionsLoading } = usePermissions();
  const [periodDialogOpen, setPeriodDialogOpen] = useState(false);
  const [periodForm, setPeriodForm] = useState<PeriodFormState>(defaultPeriodForm);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [closeReviewPeriod, setCloseReviewPeriod] = useState<PeriodSummary | null>(null);

  const setupStatus = useQuery(
    api.accountingSetup.status,
    activeOrgId ? { orgId: activeOrgId } : "skip"
  );
  const initializeChart = useMutation(api.chartOfAccounts.initialize);
  const repairChart = useMutation(api.chartOfAccounts.repairMissingSystemAccounts);
  const createPeriod = useMutation(api.accountingPeriods.create);
  const openPeriod = useMutation(api.accountingPeriods.open);
  const lockPeriod = useMutation(api.accountingPeriods.lock);
  const reopenPeriod = useMutation(api.accountingPeriods.reopen);
  const redriveOutbox = useMutation(api.accountingOutbox.redrive);
  const retryFailed = useMutation(api.accountingOutbox.retryFailed);

  const canManageFinance = !permissionsLoading && hasPermission(PERMISSIONS.MANAGE_FINANCE);
  // Locking a period can never be undone in-product, so it needs the same
  // narrow grant reopening does rather than plain finance management.
  const canLockPeriod = canManageFinance && hasPermission(PERMISSIONS.REOPEN_PERIODS);

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
    action: "open" | "close" | "lock" | "reopen",
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
  const showSettings = view !== "close";
  const showClose = view !== "settings";

  return (
    <div className="p-6 space-y-6">
      {view === "all" && (
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t("AccountingSetup")}</h2>
          <p className="text-sm text-muted-foreground">{t("AccountingSetupDesc")}</p>
        </div>
      )}

      <div className={view === "settings" ? "grid gap-6 lg:items-start lg:[grid-template-columns:repeat(auto-fit,minmax(22rem,1fr))]" : "contents"}>
      <SetupStatusCards
        variant={view === "all" ? "all" : view === "settings" ? "chart" : "operations"}
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
        onRepairChart={() => {
          void runSetupAction(
            "initializeChart",
            () => repairChart({ orgId: activeOrgId }),
            (outcome) =>
              t("SystemAccountsRepaired").replace("{count}", String(outcome.repaired.length))
          );
        }}
        onRedrive={() => {
          void runSetupAction(
            "redrive",
            () => redriveOutbox({ orgId: activeOrgId }),
            // Queued, never posted. Posting is asynchronous (SCRUM-222), so
            // this transaction cannot know a posted/failed split — reporting
            // one would put back, one layer up, the false success the outbox
            // itself stopped making.
            //
            // Three states, every one of them read from the backend's own
            // counts (owner ruling c17375): queued now, already in flight, or
            // genuinely nothing left. "Already posting" is NOT an empty result,
            // and collapsing it into one would be the same false claim again.
            (outcome) => {
              if (outcome.scheduled > 0) {
                return t("AccountingOutboxRedrivenResult" as any)
                  .replace("{scheduled}", String(outcome.scheduled));
              }
              if (outcome.alreadyInFlight > 0) {
                return t("AccountingOutboxRedriveInFlight" as any)
                  .replace("{inFlight}", String(outcome.alreadyInFlight));
              }
              return t("AccountingOutboxRedriveNothing" as any);
            }
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

      {/* After the chart and periods, because an opening balance needs both:
          accounts to post into, and an open period covering its date. */}
      {showSettings && <OpeningBalanceCard />}
      </div>

      {/* Directly beneath the card, because when a draft is pending the card
          deliberately hides its own button (it must not create a second draft)
          — so this panel is the only thing on screen that can move the
          organization's opening balance forward. It renders nothing when
          nothing is pending. */}
      {showSettings && (
        <OpeningBalanceApprovalPanel orgId={activeOrgId} canManageFinance={canManageFinance} />
      )}

      {!canManageFinance && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t("AccountingSetupManageFinanceRequired")}</span>
        </div>
      )}

      {showSettings && (
        <SystemAccountConflictsPanel orgId={activeOrgId} canManageFinance={canManageFinance} t={t} />
      )}

      {showSettings && view === "settings" && (
        <p className="text-sm text-muted-foreground">{t("AccountingPeriodsElsewhere")}</p>
      )}

      {showClose && (
      <AccountingPeriodsTable
        periods={setupStatus.recentPeriods}
        canManageFinance={canManageFinance}
        canLockPeriod={canLockPeriod}
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
        onClose={(periodId) => {
          const period = setupStatus.recentPeriods.find((p) => p._id === periodId);
          if (period) setCloseReviewPeriod(period);
        }}
        onLock={(periodId) =>
          periodAction(
            periodId,
            "lock",
            () => lockPeriod({ orgId: activeOrgId, periodId }),
            "AccountingPeriodLocked"
          )
        }
        onReopen={(periodId, reason) =>
          periodAction(
            periodId,
            "reopen",
            () => reopenPeriod({ orgId: activeOrgId, periodId, reason }),
            "AccountingPeriodReopened"
          )
        }
      />
      )}

      {showClose && (
      <PendingAccountingEventsTable
        events={setupStatus.pendingEvents}
        hasMore={setupStatus.hasMorePendingEvents}
        canManageFinance={canManageFinance}
        busyAction={busyAction}
        t={t}
        onRetry={(eventId) => {
          void runSetupAction(
            `retry_${eventId}`,
            () => retryFailed({ orgId: activeOrgId, pendingEventId: eventId }),
            () => t("EventRetried" as any)
          );
        }}
      />
      )}

      {showClose && (
      <ClosePeriodReviewDialog
        orgId={activeOrgId}
        period={closeReviewPeriod}
        open={closeReviewPeriod !== null}
        isOwner={isOwner}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setCloseReviewPeriod(null);
        }}
        onClosed={() => setCloseReviewPeriod(null)}
        t={t}
      />
      )}
    </div>
  );
}
