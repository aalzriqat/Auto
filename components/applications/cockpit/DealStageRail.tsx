"use client";

import { Check } from "lucide-react";
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
 */
export function DealStageRail({
  stages,
  t,
}: Readonly<{ stages: ReadonlyArray<RailStage>; t: (key: string) => string }>) {
  return (
    <ol className="flex flex-wrap gap-y-3" data-testid="deal-stage-rail">
      {stages.map((stage, index) => {
        const live = isLiveStageState(stage.state);
        // The accessible NAME of the node — label, state, owner, blocker, in
        // that order — and the tooltip says the same thing.
        const name = [stage.label, t(STAGE_STATE_KEY[stage.state]), stage.owner, stage.blocker]
          .filter(Boolean)
          .join(" · ");
        return (
          <li
            key={stage.key}
            className="relative flex min-w-0 basis-1/4 flex-col items-center gap-1 px-1 text-center sm:flex-1"
            aria-current={live ? "step" : undefined}
            aria-label={name}
            title={name}
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
            <span
              className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold ${STAGE_NODE_CLASS[stage.state]}`}
            >
              {stageNodeContent(stage.state, index)}
            </span>
            <span
              className={`min-w-0 max-w-full break-words text-xs leading-snug ${
                live ? "font-semibold text-foreground" : "text-muted-foreground"
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
  expanded,
  onToggle,
  t,
}: Readonly<{
  count: number;
  expanded: boolean;
  onToggle: () => void;
  t: (key: string) => string;
}>) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-emerald-700 bg-emerald-500/15 text-emerald-800 dark:border-emerald-400 dark:bg-emerald-400/15 dark:text-emerald-200">
        <Check className="h-4 w-4" aria-hidden />
      </span>
      <p className="min-w-0 flex-1 text-sm font-medium">
        {t("DealAllStagesComplete")}{" "}
        <span className="text-muted-foreground">
          (<bdi dir="ltr">{count}</bdi>)
        </span>
      </p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-9"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        {t(expanded ? "HideStages" : "ShowStages")}
      </Button>
    </div>
  );
}
