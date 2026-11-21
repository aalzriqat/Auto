"use client";

import { useRef } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUpRight, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { SettlementDenominationDetail, WorkflowAction } from "./DealWorkflowAction";
export type { SettlementDenominationDetail } from "./DealWorkflowAction";
import { STAGE_ICON, type DealStageState } from "./DealStagePresentation";
import { DealStepChecklist } from "./DealStepChecklistList";
import type { ChecklistDestination, ChecklistItem } from "./dealStepChecklist";
import { StagePosition } from "./StagePosition";

/**
 * "Recorded settlement: 15,625 USD · Organisation currency: JOD", with each
 * money run isolated LTR so an RTL paragraph cannot reorder "15,625 USD" into
 * "USD 15,625".
 */
export function SettlementDenominationLine({
  detail,
}: Readonly<{ detail: SettlementDenominationDetail }>) {
  return (
    <p className="text-sm" data-testid="settlement-denomination-detail">
      {detail.recordedLabel}: <bdi dir="ltr">{detail.recordedAmount}</bdi> · {detail.orgLabel}:{" "}
      <bdi dir="ltr">{detail.orgCurrency}</bdi>
    </p>
  );
}

/**
 * The stage the deal is on — the primary surface of the screen.
 *
 * Everything the operator needs for the current step lives here: what it is,
 * whose move it is, the one thing being waited on, and the ONE action. The
 * compact rail above it is a progress readout, never a second working panel;
 * both are rendered from the same `live` stage, so the two cannot announce
 * different steps — the defect the previous "next step" card had.
 *
 * It keeps `data-testid="deal-next-step"` deliberately. The id names the block
 * that carries the action, which is exactly what this is; a spec scoped to this
 * block cannot pass against a stage name rendered somewhere else.
 */
/**
 * The sentence above a step with nothing blocking it. A cash sale still in
 * draft is not "nothing outstanding" — it is the thing outstanding (W3).
 */
function stageReadyKey(actionKey: string | undefined): string {
  if (actionKey === "RegisterHandoverAction" || actionKey === "ActionConfirmHandover") {
    return "StageReadyForHandoverAction";
  }
  if (actionKey === "CompleteCashSaleAction") return "StageCashSaleIsDraft";
  return "StageReadyToProceed";
}

export function StageFocusRow({
  state,
  label,
  position,
  total,
  owner,
  mirrorNote,
  blocker,
  action,
  outstandingDocuments,
  onGoToDocuments,
  documentsActionable = true,
  checklist,
  t,
  children,
}: Readonly<{
  state: DealStageState;
  label: string;
  /** 1-based place on the rail, for the "Step 3 of 8" kicker. */
  position: number;
  total: number;
  /** Whose move it is, resolved from server authority AND recorded provenance. */
  owner?: string;
  /** A control that belongs ON this step because it is what the step waits on. */
  children?: React.ReactNode;
  /** Whether the "AutoFlow only records their decision" sentence is TRUE here. */
  mirrorNote: boolean;
  blocker?: string;
  /** Already resolved by the view: a present `onStart` is a button that works. */
  action?: Omit<WorkflowAction, "stageKey">;
  outstandingDocuments: ReadonlyArray<{ ruleId: string; name: string }>;
  /** Absent when the screen has no documents tab to go to. */
  onGoToDocuments?: () => void;
  /**
   * False when the caller can neither upload nor verify (the container's own
   * verdict): the passive link is then withheld, since the checklist it leads
   * to has nothing this caller can press (SCRUM-417 UX1, S3).
   */
  documentsActionable?: boolean;
  /**
   * The sub-steps of this stage (SCRUM-417 UX4, O2) and where the current one
   * is acted on. `go` returns a handler only for a destination this caller has.
   */
  checklist?: {
    items: ReadonlyArray<ChecklistItem>;
    go: (destination: Exclude<ChecklistDestination, "primaryAction">) => (() => void) | undefined;
  };
  t: (key: string) => string;
}>) {
  const icon = STAGE_ICON[state];
  const primaryButtonRef = useRef<HTMLButtonElement>(null);
  const primary =
    action && action.unavailableReasonKey === undefined
      ? action.opens === "DOCUMENTS"
        ? onGoToDocuments
        : action.onStart
      : undefined;

  return (
    <Card
      className={state === "BLOCKED" ? "border-amber-500/50" : "border-primary/40"}
      data-testid="deal-next-step"
    >
      <CardContent className="space-y-3 p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="mt-1 shrink-0">{icon}</span>
          <div className="min-w-0 flex-1 space-y-3">
            <div className="min-w-0 space-y-1">
              <p className="text-xs text-muted-foreground">
                <StagePosition t={t} position={position} total={total} />
              </p>
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                <h2 className="text-lg font-semibold leading-tight">{label}</h2>
                {/* Whose move it is, said before anything else on the step. An
                    operator who reads "finance company" stops looking for a
                    button that must never exist. `bdi` because the owner can
                    be an Arabic party name beside Latin text. */}
                {owner && (
                  <Badge variant="outline" className="font-normal">
                    <bdi>{owner}</bdi>
                  </Badge>
                )}
              </div>
            </div>

            {/* What is being waited on — the one genuine blocker on this
                step, with the documents it names under it. A stage with
                nothing outstanding says so rather than going silent, but in
                the MUTED colour: amber on "nothing is outstanding" painted a
                warning over the absence of a problem. */}
            {blocker ? (
              <div className="rounded-md border-s-2 border-amber-600 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:border-amber-500 dark:text-amber-200">
                <p>{blocker}</p>
                {outstandingDocuments.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {outstandingDocuments.map((doc) => (
                      <li key={doc.ruleId} className="flex items-center gap-2">
                        <Minus className="h-3.5 w-3.5 shrink-0" aria-hidden />
                        <bdi className="min-w-0">{doc.name}</bdi>
                      </li>
                    ))}
                  </ul>
                )}
                {/* The documents are uploaded in the tab at the foot of the
                    page — far below this step on a phone. Offered only where
                    that tab exists, and only when the step has no button of
                    its own: the button already goes there, and a second
                    pointer to the same place would be two ways to do one
                    thing. The documents themselves do not move. */}
                {outstandingDocuments.length > 0 && onGoToDocuments && documentsActionable && !primary && (
                  <button
                    type="button"
                    className="mt-1.5 inline-flex min-h-9 items-center gap-1 rounded-sm font-medium underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid="deal-go-to-documents"
                    onClick={onGoToDocuments}
                  >
                    {t("GoToDocuments")}
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                  </button>
                )}
              </div>
            ) : action?.unavailableReasonKey ? null : (
              // Not said above a refusal: "nothing is outstanding" over "this
              // sale is still a draft" contradicts itself (SCRUM-417 visual gate).
              <p className="text-sm text-muted-foreground">
                {t(stageReadyKey(action?.actionKey))}
              </p>
            )}

            {checklist && (
              <DealStepChecklist
                items={checklist.items}
                t={t}
                go={(destination) =>
                  destination === "primaryAction"
                    ? primary
                      ? () => {
                          const button = primaryButtonRef.current;
                          button?.scrollIntoView?.({ block: "center" });
                          button?.focus({ preventScroll: true });
                        }
                      : undefined
                    : checklist.go(destination)
                }
              />
            )}

            {/* The action for the step this block NAMES. A step worth naming
                is a step worth doing here — the one recommended action, and
                exactly one. */}
            {/* Why THIS is the next step, when that is not obvious from the
                stage — said once, right above the button it explains. */}
            {(primary || (action?.unavailableReasonKey && action.secondary)) && action?.noteKey && (
              <p className="text-sm text-muted-foreground" data-testid="deal-next-step-note">
                {t(action.noteKey)}
              </p>
            )}
            {primary && action && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 pt-1">
                <Button
                  ref={primaryButtonRef}
                  size="lg"
                  className="w-full sm:w-auto"
                  data-testid="deal-next-step-action"
                  onClick={primary}
                >
                  {t(action.actionKey)}
                </Button>
                {/* The quieter alternative the step must keep (a rejection
                    that needs no documents). Weighted as a link so the eye
                    lands on the one recommended action first. */}
                {action.secondary && (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-9 px-0 text-muted-foreground"
                    data-testid="deal-next-step-secondary"
                    onClick={action.secondary.onStart}
                  >
                    {t(action.secondary.actionKey)}
                  </Button>
                )}
              </div>
            )}

          {/* Why the named step is not actionable BY THIS CALLER. Silence here
              is the dead end this screen exists to remove. */}
          {action?.unavailableReasonKey && (
            <p className="text-sm text-muted-foreground">{t(action.unavailableReasonKey)}</p>
          )}
          {/* SCRUM-417 UX1 (S4): the blocker is resolved on another page. The
              container links it only for a caller who can act there; every
              other caller is told who does. Never both, never a bare refusal. */}
          {action?.unavailableReasonKey && action.unavailableLink && (
            <Link
              href={action.unavailableLink.href}
              className="inline-flex min-h-9 items-center gap-1 rounded-sm text-sm font-medium underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="deal-next-step-link"
            >
              {t(action.unavailableLink.labelKey)}
              <ArrowUpRight className="h-3.5 w-3.5 rtl:-scale-x-100" aria-hidden />
            </Link>
          )}
          {action?.unavailableReasonKey && !action.unavailableLink && action.unavailableNoteKey && (
            <p className="text-sm text-muted-foreground" data-testid="deal-next-step-link-note">
              {t(action.unavailableNoteKey)}
            </p>
          )}
          {/* The quieter alternative survives a withheld main step: an
              approver who cannot touch the documents can still record the
              rejection, which needs none (SCRUM-417 W1). */}
          {action?.unavailableReasonKey && action.secondary && (
            <Button
              variant="link"
              size="sm"
              className="h-9 px-0"
              data-testid="deal-next-step-secondary"
              onClick={action.secondary.onStart}
            >
              {t(action.secondary.actionKey)}
            </Button>
          )}
          {/* The figure the refusal is about, in the currency it is recorded
              in. Each money run is its own LTR isolate, or under an RTL base
              the amount and its code swap places. */}
          {action?.unavailableReasonKey && action.unavailableDetail && (
            <SettlementDenominationLine detail={action.unavailableDetail} />
          )}

          {children}

          {/* Only where it is TRUE — gated by recorded provenance, the same
              source as the badge above, so the two can never name different
              parties for one step. On a DEALER stage the badge has already
              said whose move it is; a second line restating it would push the
              real content down. */}
          {mirrorNote && <p className="text-xs text-muted-foreground">{t("StageMirrorNote")}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
