import type { ClosingReadinessCheckKey } from "@/lib/closingReadinessReasonCodes";
import type { ActiveAppraisalProvider, DealCockpitViewProps } from "./DealCockpitViewProps";
import type { WorkflowAction } from "./DealWorkflowAction";
import { orderStagesForDisplay } from "./dealStageDisplayOrder";
import { deriveStepChecklist, type ChecklistItem } from "./dealStepChecklist";
import { resolveViewedStage, stageNotApplicableReasonKey, stageViewMode } from "./dealStepView";
import {
  isFinishedStageState,
  isLiveStageState,
  STAGE_LABEL_KEY,
  type DealCockpitData,
} from "./DealStagePresentation";

/**
 * Whose move a stage is — the single question the rail exists to answer.
 *
 * `authority` already travels on every stage: MIRROR means the finance company
 * acts and AutoFlow only records what they decided, DEALER means the dealership
 * acts. Rendering that verbatim is right for every stage but one.
 *
 * ⚠️ `APPRAISAL` is the exception, and getting it wrong is the defect this
 * function was written for. Its authority is MIRROR because the dealership never
 * values the vehicle itself — but the valuation may have been done by an
 * INDEPENDENT appraiser rather than by the finance company. Reading MIRROR as
 * "finance company" told the operator the deal was waiting on a party that was
 * not involved. The provider is therefore taken from RECORDED SERVER
 * PROVENANCE, never inferred from the stage's authority.
 *
 * An authority the client does not recognise names nobody rather than guessing:
 * a new server value must not silently render as "Dealership".
 */
export function stageOwnerLabel(
  stage: Readonly<{ key: string; authority?: string }>,
  activeAppraisalProvider: ActiveAppraisalProvider,
  t: (key: string) => string
): string | undefined {
  if (stage.key === "APPRAISAL") {
    if (activeAppraisalProvider === "FINANCE_COMPANY") return t("AppraisalByFinanceCompany");
    if (activeAppraisalProvider === "INDEPENDENT") return t("AppraisalByIndependent");
    return t("StageOwnerAppraiserNotRecorded");
  }
  if (stage.authority === "MIRROR") return t("StageOwnerFinanceCompany");
  if (stage.authority === "DEALER") return t("StageOwnerDealership");
  return undefined;
}

/**
 * Whether the "this step belongs to the finance company" note is TRUE here.
 *
 * Gated by the same recorded provenance that drives the owner label, because
 * the two surfaces answer the same question and must not answer it from
 * different sources. `APPRAISAL` carries a static `authority: "MIRROR"`, so
 * keying the note on authority alone asserted the finance company owned an
 * appraisal an INDEPENDENT appraiser had performed — one step, two parties,
 * one screen. A `null` provider does not license the note either.
 */
export function stageShowsMirrorNote(
  stage: Readonly<{ key: string; authority?: string }>,
  activeAppraisalProvider: ActiveAppraisalProvider
): boolean {
  if (stage.authority !== "MIRROR") return false;
  if (stage.key === "APPRAISAL") return activeAppraisalProvider === "FINANCE_COMPANY";
  return true;
}

export function buildDealCockpitStageView({
  deal,
  activeAppraisalProvider,
  requestedStageKey,
  closingReadiness,
  routeRecorded,
  workflowAction,
  t,
}: Readonly<{
  deal: DealCockpitData;
  activeAppraisalProvider: ActiveAppraisalProvider;
  requestedStageKey: string | null;
  closingReadiness: NonNullable<DealCockpitViewProps["closingChecklist"]>["readiness"];
  routeRecorded: boolean | undefined;
  workflowAction: WorkflowAction | undefined;
  t: (key: string) => string;
}>) {
  // The rail's DISPLAY order (S1): payment confirmation last, because it can
  // only be confirmed after handover and close. The same stage objects, keyed
  // re-sequenced; every "which step is this" number below reads this order.
  const stages = orderStagesForDisplay(deal.stages);
  const live = stages.find((s) => isLiveStageState(s.state));
  // A finished deal gets one calm completion line instead of a rail of ticks;
  // the rail itself stays one click away. Every other deal — live, or stopped
  // with nothing left to do — shows the rail as-is, because on a stopped deal
  // WHERE it stopped is the information.
  // A stage the server proved NOT_APPLICABLE is not outstanding work: it counts
  // as finished here, though never as COMPLETE (SCRUM-446).
  const allComplete = stages.length > 0 && stages.every((s) => isFinishedStageState(s.state));
  const liveIndex = live ? stages.findIndex((s) => s.key === live.key) : -1;
  // Settlement is shown ahead of a payment step that is live: every closed
  // financed deal sits there until the finance company pays, so the node says
  // what it is waiting on rather than reading as an unexplained PENDING.
  const paymentIsLive = stages.some((s) => s.key === "DISBURSEMENT" && isLiveStageState(s.state));
  const railStages = stages.map((stage) => ({
    key: stage.key,
    state: stage.state,
    label: t(STAGE_LABEL_KEY[stage.key] ?? stage.key),
    // The same provenance-gated resolution the focus panel uses, so a node
    // and the panel can never name different parties for one step.
    // A stage that is not needed has nobody acting on it, so no owner is drawn.
    owner: stage.state === "NOT_APPLICABLE" ? undefined : stageOwnerLabel(stage, activeAppraisalProvider, t),
    // ...and its "blocker" slot carries WHY it is not needed (rail tooltip and
    // accessible name), never a wait.
    blocker:
      stage.state === "NOT_APPLICABLE"
        ? t(stageNotApplicableReasonKey(stage.key))
        : stage.key === "DISBURSEMENT" && stage.state === "PENDING"
          ? t("BlockerDisbursementAfterHandover")
          : stage.key === "SETTLEMENT" && stage.state === "PENDING" && paymentIsLive
            ? t("BlockerSettlementAfterFinancePayment")
            : stage.blocker
              ? t(`Blocker${stage.blocker}`)
              : undefined,
  }));
  // SCRUM-417 UX4 (O2/O3). The sub-steps of any stage, from facts this view
  // already holds -- never a new read. Readiness counts only while it is open
  // and answered: a closed or unreadable verdict names no sub-step it cannot see.
  const stageStates = Object.fromEntries(stages.map((stage) => [stage.key, stage.state]));
  const openReadiness =
    closingReadiness?.open ? closingReadiness : undefined;
  // An answered list -- even an empty one (UNAVAILABLE with `checks: []`, a
  // currency mismatch) -- is `{}`, never `undefined`: the cost items then stay
  // on the list, not done, instead of vanishing with the verdict.
  const readinessChecks: Partial<Record<ClosingReadinessCheckKey, string>> | undefined = openReadiness
    ? Object.fromEntries(openReadiness.checks.map((check) => [check.key, check.status]))
    : undefined;
  // The identity of THIS cockpit, by `applicationId` (as the title below does),
  // never by `dealKind`: an applicationless FINANCED/LEASE sale is `dealKind:
  // "FINANCED"` and has the sale's steps, not the financed chain.
  const dealPath: "SALE" | "APPLICATION" = deal.applicationId === null ? "SALE" : "APPLICATION";
  // The server reports a closed deal positively: `status === "CLOSED"`.
  const dealClosed = deal.status === "CLOSED";
  // Only the LIVE step has a checklist (`deriveStepChecklist` is null for any
  // other state): the server has no item-level facts for a finished or upcoming one.
  const checklistOf = (stage: (typeof stages)[number]): ChecklistItem[] | null =>
    deriveStepChecklist({
        stageKey: stage.key,
        stageState: stage.state,
        path: dealPath,
        closed: dealClosed,
        blocker: stage.blocker,
        stageStates,
        documents: deal.documents,
        checks: readinessChecks,
        readinessState: openReadiness?.state,
        expectedPaymentRegistered:
          "expectedPaymentRegistered" in deal ? deal.expectedPaymentRegistered : undefined,
        routeRequired:
          "supplierSettlementRouteRequired" in deal ? deal.supplierSettlementRouteRequired : undefined,
        routeRecorded,
        // The control THIS stage offers right now, so the current item can
        // never disagree with it.
        liveAction:
          workflowAction && workflowAction.stageKey === stage.key
            ? {
                actionKey: workflowAction.actionKey,
                unavailableReasonKey: workflowAction.unavailableReasonKey,
              }
            : undefined,
      });
  // Which step is being LOOKED at. A key the deal does not have, or the live
  // step's own, is no choice at all: the live step is shown, as always.
  const viewedStage = resolveViewedStage(requestedStageKey, stages);
  const viewedMode = viewedStage ? stageViewMode(viewedStage.state) : "live";
  const otherStage = viewedStage && viewedMode !== "live" ? viewedStage : undefined;
  // Whether the close is being refused for want of the settlement route — the
  // one case where the route control belongs on the live step itself.
  const routeBlocksClose =
    live?.key === "SETTLEMENT" &&
    workflowAction?.stageKey === "SETTLEMENT" &&
    (workflowAction.unavailableReasonKey === "FinalizeNeedsSettlementRoute" ||
      workflowAction.unavailableReasonKey === "FinalizeNeedsRouteAndPermission");

  return {
    stages,
    live,
    allComplete,
    liveIndex,
    railStages,
    dealPath,
    dealClosed,
    checklistOf,
    viewedMode,
    otherStage,
    routeBlocksClose,
  };
}
