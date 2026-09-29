"use client";

import { ArrowUpLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { STAGE_STATE_KEY, type DealStageState } from "./DealStagePresentation";
import { stageViewCopy, type StageViewMode } from "./dealStepView";

/**
 * A step the operator is LOOKING at that is not the live one (SCRUM-417 UX4, O3).
 *
 * Read-only by construction: it renders no command, only words and -- for a step
 * that already happened -- a link to where the recorded panel lives. It lists no
 * sub-steps: the server reports item-level facts only for the LIVE step, so a
 * finished or upcoming one could only be all-ticked or all-pending, and both
 * would be false. It is drawn as a sibling ABOVE the live step and never
 * replaces it, so the live workbench under it keeps its state.
 *
 *  - past:   what was recorded, and who acted.
 *  - future: what the step will need, and who acts (the same owner wording the
 *            rail and the live card use, resolved by the caller).
 *  - stopped: the deal was rejected or cancelled, so the step will never happen.
 *            No needs and no actor are promised -- only that it stopped.
 */
export function DealStageView({
  mode,
  stageKey,
  path,
  closed,
  label,
  state,
  owner,
  position,
  total,
  hasLiveStep,
  onBack,
  onShowRecord,
  t,
}: Readonly<{
  mode: Exclude<StageViewMode, "live">;
  stageKey: string;
  /** "SALE" (the sale-keyed cockpit) swaps the needs wording for the two stages it means differently. */
  path?: "SALE" | "APPLICATION";
  /** The server reports the deal CLOSED: a pending Settlement then waits on the finance company's payment. */
  closed?: boolean;
  label: string;
  state: DealStageState;
  owner?: string;
  position: number;
  total: number;
  /** False on a finished deal, where there is no "current step" to go back to. */
  hasLiveStep: boolean;
  onBack: () => void;
  /** Absent when the step has no panel of its own to show. */
  onShowRecord?: () => void;
  t: (key: string) => string;
}>) {
  const { noteKey, needsKey } = stageViewCopy(mode, stageKey, { path, closed });
  return (
    <section aria-labelledby="deal-stage-view-title" data-testid="deal-stage-view" data-mode={mode} data-stage={stageKey}>
      <Card className="border-dashed bg-muted/30">
        <CardContent className="space-y-3 p-4 sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="min-w-0 space-y-1">
              <p className="text-xs text-muted-foreground">
                {t("StageOfLabel")}{" "}
                <bdi dir="ltr">
                  {position} / {total}
                </bdi>
              </p>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <h2 id="deal-stage-view-title" className="text-lg font-semibold leading-tight">
                  {label}
                </h2>
                <Badge variant="outline" className="font-normal">
                  {t(STAGE_STATE_KEY[state])}
                </Badge>
              </div>
            </div>
            <button
              type="button"
              data-testid="deal-stage-view-back"
              onClick={onBack}
              className="inline-flex min-h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border bg-card px-3 text-sm font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ArrowUpLeft className="h-3.5 w-3.5 rtl:-scale-x-100" aria-hidden />
              {t(hasLiveStep ? "BackToCurrentStep" : "StageViewBack")}
            </button>
          </div>

          <p className="text-sm text-muted-foreground" data-testid="deal-stage-view-note">
            {t(noteKey)}
          </p>

          {owner && mode !== "stopped" && (
            <p className="text-sm" data-testid="deal-stage-view-owner">
              <span className="text-muted-foreground">{t("StageViewWhoActs")}: </span>
              <bdi className="font-medium">{owner}</bdi>
            </p>
          )}

          {needsKey && (
            <div className="space-y-1" data-testid="deal-stage-view-needs">
              <p className="text-xs font-medium text-muted-foreground">{t("StageViewNeedsHeading")}</p>
              <p className="text-sm">{t(needsKey)}</p>
            </div>
          )}

          {mode === "past" && onShowRecord && (
            <button
              type="button"
              data-testid="deal-stage-view-record"
              onClick={onShowRecord}
              className="inline-flex min-h-9 items-center rounded-sm text-sm font-medium underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("StageViewShowRecord")}
            </button>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
