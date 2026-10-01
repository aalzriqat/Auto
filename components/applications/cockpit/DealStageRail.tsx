"use client";

import { Check, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  isLiveStageState,
  STAGE_NODE_CLASS,
  STAGE_STATE_KEY,
  stageNodeContent,
  type DealStageState,
} from "./DealStagePresentation";

export type RailStage = Readonly<{
  key: string;
  /** The server's classification, unchanged — see `DealStagePresentation`. */
  state: DealStageState;
  label: string;
  /**
   * Whose move the step is, already resolved to display text. Carried on
   * every node as muted type under the label (and in the accessible name),
   * never as a pill, so ownership of the non-live steps survives the compact
   * rail without eight badges competing with the one that matters.
   */
  owner?: string;
  blocker?: string;
}>;

/**
 * The compact stage rail: one node per stage, in order.
 *
 * Presentation only — the stages arrive already derived and already
 * classified from the server, and the rail never decides what state a stage
 * is in. Its one job is to make the CURRENT stage the thing the eye lands on:
 * completed stages are neutral (a muted tick, not a green one — eight green
 * markers on a closed deal were competing with each other and with the one
 * action that mattered), future stages are quiet, and only a BLOCKED stage
 * carries the amber that means "somebody is waiting on something". The
 * per-state colours, glyphs and state names live in `DealStagePresentation`,
 * shared with the focus row, so the two cannot describe one state differently.
 *
 * `aria-current="step"` marks the live node and each node's accessible name
 * carries its label, state, owner and blocker, so none of this is colour alone.
 *
 * SCRUM-417 UX4 (O3): each node is a real button. Pressing it only chooses
 * which step is SHOWN (`onSelect`); the live node clears that choice. It never
 * changes what the deal is waiting on.
 */
export function DealStageRail({
  stages,
  t,
  viewedKey = null,
  onSelect,
}: Readonly<{
  stages: ReadonlyArray<RailStage>;
  t: (key: string) => string;
  /** The non-live step being looked at (SCRUM-417 UX4, O3), if any. */
  viewedKey?: string | null;
  /** Shows that step in the view above the working surface (`null` = back to the live one). */
  onSelect: (key: string | null) => void;
}>) {
  return (
    <ol className="flex flex-wrap gap-y-3" data-testid="deal-stage-rail">
      {stages.map((stage, index) => {
        const live = isLiveStageState(stage.state);
        const viewed = !live && stage.key === viewedKey;
        // The accessible NAME of the node — label, state, owner, blocker, in
        // that order — and the tooltip says the same thing. The step being
        // looked at says so in words too, so it is never colour alone.
        const name = [
          stage.label,
          t(STAGE_STATE_KEY[stage.state]),
          stage.owner,
          stage.blocker,
          viewed ? t("StageViewing") : undefined,
        ]
          .filter(Boolean)
          .join(" · ");
        const content = (
          <>
            <span
              className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold ${STAGE_NODE_CLASS[stage.state]} ${
                viewed ? "ring-2 ring-primary ring-offset-2 ring-offset-background" : ""
              }`}
            >
              {stageNodeContent(stage.state, index)}
            </span>
            <span
              className={`min-w-0 max-w-full break-words text-xs leading-snug ${
                live || viewed ? "font-semibold text-foreground" : "text-muted-foreground"
              }`}
            >
              {stage.label}
            </span>
            {/* Whose move it is, VISIBLE on every node in the quietest register
                — a tooltip alone is invisible to keyboard and touch users. The
                live node's panel below repeats it as a badge; here it is only
                type, so eight owners do not compete with the one action. */}
            {stage.owner && (
              <span
                className="min-w-0 max-w-full break-words text-[11px] leading-snug text-muted-foreground"
                data-testid="deal-stage-owner"
              >
                <bdi>{stage.owner}</bdi>
              </span>
            )}
          </>
        );
        return (
          <li
            key={stage.key}
            className="relative flex min-w-0 basis-1/4 flex-col items-center px-1 sm:flex-1"
          >
            {/* The connector, drawn behind the node from the previous one.
                Hidden on the first node and on phones, where the rail wraps
                four to a row and a line across a row break would connect
                the wrong stages. */}
            {index > 0 && (
              <span
                aria-hidden
                className="absolute top-[13px] hidden h-0.5 w-full bg-border sm:block ltr:-left-1/2 rtl:-right-1/2"
              />
            )}
            {/* A real button: keyboard-reachable, Enter and Space activate it,
                and it names its step. The live node clears the view. */}
            <button
              type="button"
              data-testid={`deal-stage-node-${stage.key}`}
              className="flex w-full min-w-0 cursor-pointer flex-col items-center gap-1 rounded-md py-1 text-center hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-current={live ? "step" : undefined}
              aria-label={name}
              title={name}
              onClick={() => onSelect(live ? null : stage.key)}
            >
              {content}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The calm state a finished deal gets instead of a rail of eight ticks.
 *
 * The rail is still one click away, because "which stage did X happen at" is
 * a question an operator still asks about a closed deal — it is just not the
 * FIRST thing they need to see.
 */
export function DealStagesComplete({
  count,
  notNeeded = 0,
  expanded,
  onToggle,
  t,
}: Readonly<{
  /** Stages that are COMPLETE. */
  count: number;
  /** Stages the server proved are not needed. They are finished, never "complete". */
  notNeeded?: number;
  expanded: boolean;
  onToggle: () => void;
  t: (key: string) => string;
}>) {
  // A not-needed stage is finished but was never completed, so the summary
  // makes no completion claim and wears no success tick: a quiet dash and the
  // two counts apart. An all-COMPLETE deal keeps its tick, copy and count.
  const mixed = notNeeded > 0;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {mixed ? (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-dotted border-border bg-transparent text-muted-foreground">
          <Minus className="h-4 w-4" aria-hidden />
        </span>
      ) : (
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-emerald-700 bg-emerald-500/15 text-emerald-800 dark:border-emerald-400 dark:bg-emerald-400/15 dark:text-emerald-200">
          <Check className="h-4 w-4" aria-hidden />
        </span>
      )}
      <p className="min-w-0 flex-1 text-sm font-medium">
        {mixed ? (
          <>
            {t("DealStagesFinished")}{" "}
            <span className="text-muted-foreground">
              (<span className="whitespace-nowrap"><bdi dir="ltr">{count}</bdi> {t("DealStagesCompleteCount")}</span> ·{" "}
              <span className="whitespace-nowrap"><bdi dir="ltr">{notNeeded}</bdi> {t("DealStagesNotNeededCount")}</span>)
            </span>
          </>
        ) : (
          <>
            {t("DealAllStagesComplete")}{" "}
            <span className="text-muted-foreground">
              (<bdi dir="ltr">{count}</bdi>)
            </span>
          </>
        )}
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-9"
        data-testid="deal-stages-toggle"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {t(expanded ? "HideStages" : "ShowStages")}
      </Button>
    </div>
  );
}
