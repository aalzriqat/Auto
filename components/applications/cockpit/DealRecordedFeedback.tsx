import { Check } from "lucide-react";
import { StageViewAnnouncer } from "./StageViewAnnouncer";
import { STAGE_LABEL_KEY, STAGE_STATE_KEY, type DealCockpitData } from "./DealStagePresentation";
import type { ChecklistItem } from "./dealStepChecklist";

type Stage = DealCockpitData["stages"][number];

export function DealRecordedFeedback({
  recorded,
  checklistItems,
  live,
  otherStage,
  allComplete,
  onDismiss,
  t,
}: Readonly<{
  recorded: boolean;
  checklistItems: ReadonlyArray<ChecklistItem> | null;
  live: Pick<Stage, "key"> | undefined;
  otherStage: Pick<Stage, "key" | "state"> | undefined;
  allComplete: boolean;
  onDismiss: (() => void) | undefined;
  t: (key: string) => string;
}>) {
  // S7: what comes next, read from the SAME facts the card below is built from
  // -- the current sub-step when the live step has one, else the live step.
  const recordedNextLabel = recorded
    ? (() => {
        const item =
          checklistItems?.find((entry) => entry.status === "current") ??
          checklistItems?.find((entry) => entry.status === "pending");
        if (item) return t(item.labelKey);
        return live ? t(STAGE_LABEL_KEY[live.key] ?? live.key) : null;
      })()
    : null;
  // "Nothing left to do" is a claim about a FINISHED deal only. A stopped deal has
  // no live step either, but work can remain on it (a held deposit still to be
  // released or forfeited), so there it says only that it was recorded.
  const recordedTail = recordedNextLabel
    ? `${t("RecordedNextPrefix")} ${recordedNextLabel}`
    : allComplete
      ? t("RecordedAllDone")
      : null;
  const recordedMessage = recorded ? [t("RecordedLead"), recordedTail].filter(Boolean).join(" ") : null;
  // Dismissing removes the very button that had focus, which would drop it on
  // <body>. It goes to the step's heading instead (the step being looked at, or
  // the live one) -- and nothing is announced for it: the announcer speaks
  // transitions of the view, not the removal of a line. With no step on screen (a
  // finished or stopped deal) it goes to what IS there: the stopped notice, else
  // the toggle that opens the completed stages, else the deal header.
  const dismissRecorded = () => {
    onDismiss?.();
    const target =
      document.querySelector<HTMLElement>(
        '[data-testid="deal-stage-view"] h2, [data-testid="deal-next-step"] h2'
      ) ??
      document.querySelector<HTMLElement>('[data-testid="deal-stopped"]') ??
      document.querySelector<HTMLElement>('[data-testid="deal-stages-toggle"]') ??
      document.querySelector<HTMLElement>('[data-testid="deal-header"]');
    if (!target) return;
    // A button is already focusable; a heading, a paragraph or the header is not.
    if (target.tabIndex < 0 && !target.matches("button, a[href], input, select, textarea")) target.tabIndex = -1;
    target.focus();
  };
  return (
    <>
      <StageViewAnnouncer
        recordedMessage={recordedMessage}
        viewKey={otherStage?.key ?? null}
        message={
          otherStage
            ? `${t("StageViewAnnounceShowing")}: ${t(STAGE_LABEL_KEY[otherStage.key] ?? otherStage.key)}, ${t(STAGE_STATE_KEY[otherStage.state])}`
            : null
        }
        restoreMessage={
          live
            ? `${t("StageViewAnnounceBack")}: ${t(STAGE_LABEL_KEY[live.key] ?? live.key)}`
            : t("StageViewAnnounceBackDone")
        }
      />
      {recordedMessage !== null && (
        <div
          data-testid="deal-recorded-feedback"
          className="flex items-start gap-3 rounded-lg border border-emerald-700/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-950 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-50"
        >
          <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p className="min-w-0 flex-1">
            <span className="font-semibold">{t("RecordedLead")}</span>{" "}
            {recordedNextLabel ? (
              <>
                {t("RecordedNextPrefix")} <bdi className="font-medium">{recordedNextLabel}</bdi>
              </>
            ) : allComplete ? (
              t("RecordedAllDone")
            ) : null}
          </p>
          <button
            type="button"
            data-testid="deal-recorded-feedback-dismiss"
            onClick={dismissRecorded}
            className="min-h-9 shrink-0 cursor-pointer rounded-md px-2 text-xs font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("DismissRecorded")}
          </button>
        </div>
      )}
    </>
  );
}
