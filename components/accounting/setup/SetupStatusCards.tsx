import type { ReactNode } from "react";
import { CheckCircle2, Loader2, RotateCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PeriodSummary, Translate } from "./types";
import { periodLabel } from "./types";

type SetupStatusCardsProps = {
  chartInitialized: boolean;
  chartReady: boolean;
  missingSystemAccountKeys: readonly string[];
  currentOpenPeriod: PeriodSummary | null;
  pendingEventCount: number;
  canManageFinance: boolean;
  initializeBusy: boolean;
  redriveBusy: boolean;
  redriveDisabled: boolean;
  periodDialog: ReactNode;
  t: Translate;
  onInitializeChart: () => void;
  onRedrive: () => void;
};

function readinessIcon(isReady: boolean) {
  if (isReady) return <CheckCircle2 className="h-5 w-5 text-emerald-600" />;
  return <XCircle className="h-5 w-5 text-rose-600" />;
}

function SetupCard({
  title,
  description,
  isReady,
  action,
}: Readonly<{
  title: string;
  description: string;
  isReady: boolean;
  action?: ReactNode;
}>) {
  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{title}</CardTitle>
            <CardDescription>{description}</CardDescription>
          </div>
          {readinessIcon(isReady)}
        </div>
      </CardHeader>
      {action && <CardContent>{action}</CardContent>}
    </Card>
  );
}

function ChartAction({
  chartInitialized,
  missingSystemAccountKeys,
  canManageFinance,
  initializeBusy,
  t,
  onInitializeChart,
}: Readonly<{
  chartInitialized: boolean;
  missingSystemAccountKeys: readonly string[];
  canManageFinance: boolean;
  initializeBusy: boolean;
  t: Translate;
  onInitializeChart: () => void;
}>) {
  if (chartInitialized) {
    return (
      <p className="text-sm text-slate-500">
        {missingSystemAccountKeys.length > 0
          ? `${t("MissingSystemAccounts")}: ${missingSystemAccountKeys.join(", ")}`
          : t("SystemAccountsComplete")}
      </p>
    );
  }

  return (
    <Button size="sm" disabled={!canManageFinance || initializeBusy} onClick={onInitializeChart}>
      {initializeBusy && <Loader2 className="h-4 w-4 animate-spin" />}
      {t("InitializeChart")}
    </Button>
  );
}

export function SetupStatusCards({
  chartInitialized,
  chartReady,
  missingSystemAccountKeys,
  currentOpenPeriod,
  pendingEventCount,
  canManageFinance,
  initializeBusy,
  redriveBusy,
  redriveDisabled,
  periodDialog,
  t,
  onInitializeChart,
  onRedrive,
}: Readonly<SetupStatusCardsProps>) {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <SetupCard
        title={t("ChartOfAccounts")}
        description={chartReady ? t("ChartOfAccountsReady") : t("ChartOfAccountsNeedsSetup")}
        isReady={chartReady}
        action={
          <ChartAction
            chartInitialized={chartInitialized}
            missingSystemAccountKeys={missingSystemAccountKeys}
            canManageFinance={canManageFinance}
            initializeBusy={initializeBusy}
            t={t}
            onInitializeChart={onInitializeChart}
          />
        }
      />

      <SetupCard
        title={t("AccountingPeriod")}
        description={
          currentOpenPeriod
            ? `${t("OpenPeriod")}: ${periodLabel(currentOpenPeriod)}`
            : t("NoCurrentOpenPeriod")
        }
        isReady={currentOpenPeriod !== null}
        action={periodDialog}
      />

      <SetupCard
        title={t("PendingAccountingEvents")}
        description={
          pendingEventCount === 0
            ? t("NoPendingAccountingEvents")
            : t("PendingAccountingEventsNeedAttention")
        }
        isReady={pendingEventCount === 0}
        action={
          <Button size="sm" variant="outline" disabled={redriveDisabled || redriveBusy} onClick={onRedrive}>
            {redriveBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
            {t("RedrivePendingEvents")}
          </Button>
        }
      />
    </div>
  );
}
