"use client";

import type { FunctionReturnType } from "convex/server";
import { AlertTriangle, CheckCircle2, CircleSlash, HelpCircle, Loader2 } from "lucide-react";
import type { api } from "@/convex/_generated/api";
import type { ClosingReadinessCheckStatus } from "@/convex/utils/financedSaleRecognition";
import { Badge } from "@/components/ui/badge";
import { interpolate } from "@/lib/i18n/interpolate";
import {
  closingReasonMessageKey,
  type ClosingReadinessReasonCode,
  type ClosingReadinessReasonParams,
} from "@/lib/closingReadinessReasonCodes";

/**
 * The deal's automatic closing readiness, as `applications.getClosingReadiness`
 * serves it (SCRUM-407). This replaces the manual "classify deal accounting"
 * step: nothing here is ticked by a person. Every check is re-derived by the
 * server from the deal's own records, and `finalizeDeal` re-runs the SAME
 * evaluator — so this list is a preview of the server's verdict, never a gate
 * the screen enforces.
 */
export type ClosingReadinessView = FunctionReturnType<typeof api.applications.getClosingReadiness>;

const STATE_LABEL: Record<ClosingReadinessView["state"], string> = {
  READY: "ClosingReadinessStateReady",
  BLOCKED: "ClosingReadinessStateBlocked",
  UNAVAILABLE: "ClosingReadinessStateUnavailable",
};

const STATE_TONE: Record<ClosingReadinessView["state"], string> = {
  READY: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  BLOCKED: "border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  UNAVAILABLE: "border-border bg-muted text-muted-foreground",
};

const STATUS_LABEL: Record<ClosingReadinessCheckStatus, string> = {
  READY: "ClosingCheckReady",
  BLOCKED: "ClosingCheckBlocked",
  UNAVAILABLE: "ClosingCheckUnavailable",
  NOT_APPLICABLE: "ClosingCheckNotApplicable",
};

/**
 * The operator-facing text of a readiness reason (SCRUM-414): the server names
 * it by CODE and params, and the screen translates it — here, and in the
 * refused-finalize toast. Only a reason with no code falls back to the
 * server's English diagnostic (the `!code` also covers a server deployed
 * before SCRUM-414, which sends none: the backend deploy is separate from the
 * frontend's), so the reason is never blank and never a raw code.
 */
export function closingReasonText(
  t: (key: string) => string,
  code: ClosingReadinessReasonCode | null,
  params: ClosingReadinessReasonParams | undefined,
  diagnostic: string
): { text: string; translated: boolean } {
  if (!code) return { text: diagnostic, translated: false };
  return { text: interpolate(t(closingReasonMessageKey(code)), params ?? {}), translated: true };
}

function ReasonLine({
  t,
  code,
  params,
  diagnostic,
  testId,
}: Readonly<{
  t: (key: string) => string;
  code: ClosingReadinessReasonCode | null;
  params: ClosingReadinessReasonParams | undefined;
  diagnostic: string;
  testId: string;
}>) {
  const { text, translated } = closingReasonText(t, code, params, diagnostic);
  return (
    // dir="auto": a translated reason follows its script; the English fallback
    // must not be mirrored in RTL. The English stays reachable as a tooltip.
    <p
      className="mt-0.5 break-words text-[11px] leading-snug text-muted-foreground"
      dir="auto"
      title={translated && text !== diagnostic ? diagnostic : undefined}
      data-testid={testId}
    >
      {text}
    </p>
  );
}

function StatusIcon({ status }: Readonly<{ status: ClosingReadinessCheckStatus }>) {
  if (status === "READY") {
    return <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />;
  }
  if (status === "BLOCKED") {
    return <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />;
  }
  if (status === "UNAVAILABLE") {
    return <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />;
  }
  return <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/60" aria-hidden />;
}

export function DealClosingReadinessList({
  readiness,
  t,
}: Readonly<{
  /** `undefined` while the read is in flight. */
  readiness: ClosingReadinessView | undefined;
  t: (key: string) => string;
}>) {
  if (readiness === undefined) {
    return (
      <p className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="closing-readiness-loading">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        {t("ClosingReadinessLoading")}
      </p>
    );
  }
  if (!readiness.open) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="closing-readiness-closed">
        {t("ClosingReadinessClosed")}
      </p>
    );
  }

  // Not-applicable checks (a cash-route deal has no remittance to establish)
  // are listed last and quietly, so what is left to do reads first.
  const applicable = readiness.checks.filter((c) => c.status !== "NOT_APPLICABLE");
  const notApplicable = readiness.checks.filter((c) => c.status === "NOT_APPLICABLE");

  return (
    <div className="space-y-2" data-testid="closing-readiness" data-state={readiness.state}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={`px-2 ${STATE_TONE[readiness.state]}`} data-testid="closing-readiness-state">
          {t(STATE_LABEL[readiness.state])}
        </Badge>
        <span className="text-xs text-muted-foreground">{t("ClosingReadinessAuto")}</span>
      </div>
      {readiness.checks.length === 0 ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{t("ClosingReadinessNoChecks")}</p>
          {readiness.unavailableReason && (
            // Why no verdict could be formed — as finalizing would refuse with it.
            <ReasonLine
              t={t}
              code={readiness.unavailableReasonCode}
              params={readiness.unavailableReasonParams}
              diagnostic={readiness.unavailableReason}
              testId="closing-readiness-unavailable-reason"
            />
          )}
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border">
          {[...applicable, ...notApplicable].map((check) => (
            <li
              key={check.key}
              className="flex items-start gap-2 px-3 py-2"
              data-testid={`closing-check-${check.key}`}
              data-status={check.status}
            >
              <StatusIcon status={check.status} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-3">
                  <span
                    className={
                      check.status === "NOT_APPLICABLE"
                        ? "min-w-0 text-xs text-muted-foreground"
                        : "min-w-0 text-xs font-medium"
                    }
                  >
                    {t(`ClosingCheck_${check.key}`)}
                  </span>
                  <span className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground">
                    {t(STATUS_LABEL[check.status])}
                  </span>
                </div>
                {check.reason && check.status !== "READY" && (
                  // The exact cause, as finalizing would refuse with it.
                  <ReasonLine
                    t={t}
                    code={check.reasonCode}
                    params={check.reasonParams}
                    diagnostic={check.reason}
                    testId={`closing-check-reason-${check.key}`}
                  />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
