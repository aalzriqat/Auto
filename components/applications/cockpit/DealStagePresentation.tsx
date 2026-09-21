import { AlertTriangle, Ban, Check, CircleDot, Minus } from "lucide-react";
import type { api } from "@/convex/_generated/api";

// SCRUM-350 controlled trusted-swarm validation marker.
// Intentionally no runtime behavior change; this path deterministically maps to UI-1.
/**
 * The cockpit's server-shaped read model, whichever query produced it.
 *
 * Pinned to the queries' return types rather than transcribed, so a field the
 * server adds or renames reaches the screen through the compiler. Defined here,
 * beside the stage presentation, because the stage STATE below is derived from
 * it: the rail and the focus row must read the same union the server emits.
 */
export type DealCockpitData =
  | NonNullable<(typeof api.dealWorkspace.financedDealCockpit)["_returnType"]>
  | NonNullable<(typeof api.sales.dealCockpit)["_returnType"]>;

/**
 * A stage's state, exactly as the server classifies it — inferred from the
 * read model, never restated here. `DealCockpit` and `DealStageRail` used to
 * carry their own copies of this union and their own `default:` branches; a
 * state the server added would have compiled cleanly and painted as PENDING in
 * one and as "something neutral" in the other. Every table below is a
 * `Record<DealStageState, …>`: a new server state is a compile error at each
 * of them until somebody decides how it looks and what it is called.
 */
export type DealStageState = DealCockpitData["stages"][number]["state"];

/** The i18n key that states each state to assistive technology. */
export const STAGE_STATE_KEY: Record<DealStageState, string> = {
  COMPLETE: "StageStateComplete",
  CURRENT: "StageStateCurrent",
  BLOCKED: "StageStateBlocked",
  PENDING: "StageStatePending",
  STOPPED: "StageStateStopped",
};

/**
 * The rail node's paired background/foreground per state. Semantic tokens
 * only, and paired ones: completed and pending stages are neutral (eight green
 * ticks on a closed deal were competing with each other and with the one
 * action that mattered), only CURRENT is filled, and only BLOCKED carries the
 * amber that means "somebody is waiting on something" — a light tint under a
 * dark index rather than white on filled amber, which measured 3.19:1.
 */
export const STAGE_NODE_CLASS: Record<DealStageState, string> = {
  CURRENT: "border-primary bg-primary text-primary-foreground",
  BLOCKED:
    "border-amber-700 bg-amber-500/15 text-amber-900 dark:border-amber-400 dark:bg-amber-400/15 dark:text-amber-200",
  COMPLETE: "border-border bg-card text-muted-foreground",
  PENDING: "border-border bg-card text-muted-foreground",
  STOPPED: "border-dashed border-border bg-card text-muted-foreground",
};

const LIVE_STAGE_STATE: Record<DealStageState, boolean> = {
  CURRENT: true,
  BLOCKED: true,
  COMPLETE: false,
  PENDING: false,
  STOPPED: false,
};

/** Whether the state is the one the deal is ON — the node the eye must land on. */
export function isLiveStageState(state: DealStageState): boolean {
  return LIVE_STAGE_STATE[state];
}

const STAGE_NODE_GLYPH: Record<DealStageState, React.ReactNode | null> = {
  COMPLETE: <Check className="h-3.5 w-3.5" aria-hidden />,
  STOPPED: <Minus className="h-3.5 w-3.5" aria-hidden />,
  CURRENT: null,
  BLOCKED: null,
  PENDING: null,
};

/**
 * What the rail node shows inside its circle: a glyph for the states that are
 * over, the stage's 1-based number for the ones that are not.
 */
export function stageNodeContent(state: DealStageState, index: number): React.ReactNode {
  return STAGE_NODE_GLYPH[state] ?? <bdi dir="ltr">{index + 1}</bdi>;
}

/**
 * The focus row's icon per state. Keyed rather than tested with a ternary
 * chain: the chain drew three SonarCloud findings, and its final `else`
 * silently absorbed any state it did not name.
 */
export const STAGE_ICON: Record<DealStageState, React.ReactNode> = {
  COMPLETE: <Check className="h-4 w-4 text-emerald-600" />,
  STOPPED: <Ban className="h-4 w-4 text-muted-foreground" />,
  BLOCKED: <AlertTriangle className="h-4 w-4 text-amber-600" />,
  CURRENT: <CircleDot className="h-4 w-4 text-primary" />,
  PENDING: <Minus className="h-4 w-4 text-muted-foreground/60" />,
};
