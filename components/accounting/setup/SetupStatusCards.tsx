import type { ReactNode } from "react";
import { CheckCircle2, Loader2, RotateCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { PeriodSummary, Translate } from "./types";
import { periodLabel } from "./types";

export type SetupStatusCardsVariant = "all" | "chart" | "operations";

type SetupStatusCardsProps = {
  variant?: SetupStatusCardsVariant;
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
  onRepairChart: () => void;
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
  description: ReactNode;
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
  onRepairChart,
}: Readonly<{
  chartInitialized: boolean;
  missingSystemAccountKeys: readonly string[];
  canManageFinance: boolean;
  initializeBusy: boolean;
  t: Translate;
  onInitializeChart: () => void;
  onRepairChart: () => void;
}>) {
  if (chartInitialized) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {missingSystemAccountKeys.length > 0
            ? `${t("MissingSystemAccounts")}: ${missingSystemAccountKeys.join(", ")}`
            : t("SystemAccountsComplete")}
        </p>
        {missingSystemAccountKeys.length > 0 && (
          <Button size="sm" disabled={!canManageFinance || initializeBusy} onClick={onRepairChart}>
            {initializeBusy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("RepairMissingSystemAccounts")}
          </Button>
        )}
      </div>
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
  variant = "all",
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
  onRepairChart,
  onRedrive,
}: Readonly<SetupStatusCardsProps>) {
  const showChart = variant !== "operations";
  const showOperations = variant !== "chart";
  const gridClassName =
    variant === "all" ? "md:grid-cols-3" : variant === "operations" ? "md:grid-cols-2" : "";

  return (
    <div className={`grid gap-4 ${gridClassName}`}>
      {showChart && (
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
            onRepairChart={onRepairChart}
          />
        }
      />
      )}

      {showOperations && (
      <SetupCard
        title={t("AccountingPeriod")}
        description={
          currentOpenPeriod ? (
            // The label is Latin digits inside Arabic prose; isolated so the
            // bidi algorithm does not read "2026-09" as "09-2026".
            <>
              {t("OpenPeriod")}: <bdi dir="ltr">{periodLabel(currentOpenPeriod)}</bdi>
            </>
          ) : (
            t("NoCurrentOpenPeriod")
          )
        }
        isReady={currentOpenPeriod !== null}
        action={periodDialog}
      />
      )}

      {showOperations && (
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
      )}
    </div>
  );
}
