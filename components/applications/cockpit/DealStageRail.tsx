"use client";

import { Check, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";

export type RailStageState = "COMPLETE" | "CURRENT" | "BLOCKED" | "PENDING" | "STOPPED";

export type RailStage = Readonly<{
  key: string;
  state: RailStageState;
  label: string;
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
 * carries the amber that means "somebody is waiting on something".
 *
 * Semantic colours only. `aria-current="step"` marks the live node so the
 * emphasis is not purely visual.
 */
function stageNodeClass(state: RailStageState): string {
  switch (state) {
    case "CURRENT":
      return "border-primary bg-primary text-primary-foreground";
    case "BLOCKED":
      return "border-amber-600 bg-amber-600 text-white dark:border-amber-500 dark:bg-amber-500 dark:text-black";
    case "COMPLETE":
      return "border-border bg-card text-muted-foreground";
    case "STOPPED":
      return "border-dashed border-border bg-card text-muted-foreground";
    default:
      return "border-border bg-card text-muted-foreground";
  }
}

function stageNodeContent(state: RailStageState, index: number): React.ReactNode {
  if (state === "COMPLETE") return <Check className="h-3.5 w-3.5" aria-hidden />;
  if (state === "STOPPED") return <Minus className="h-3.5 w-3.5" aria-hidden />;
  return <bdi dir="ltr">{index + 1}</bdi>;
}

export function DealStageRail({ stages }: Readonly<{ stages: ReadonlyArray<RailStage> }>) {
  return (
    <ol className="flex flex-wrap gap-y-3" data-testid="deal-stage-rail">
      {stages.map((stage, index) => {
        const live = stage.state === "CURRENT" || stage.state === "BLOCKED";
        return (
          <li
            key={stage.key}
            className="relative flex min-w-0 basis-1/4 flex-col items-center gap-1.5 px-1 text-center sm:flex-1"
            aria-current={live ? "step" : undefined}
            title={stage.blocker}
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
              className={`relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-xs font-semibold ${stageNodeClass(stage.state)}`}
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
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white dark:bg-emerald-500 dark:text-black">
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
