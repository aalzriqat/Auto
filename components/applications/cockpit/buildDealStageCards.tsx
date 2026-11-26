import type { ReactNode } from "react";
import { DealStageView } from "./DealStageView";
import { StageFocusRow } from "./DealStageFocusRow";
import { SettlementRouteControl } from "./SettlementRouteControl";
import { STAGE_LABEL_KEY, type DealCockpitData } from "./DealStagePresentation";
import { panelsForStage, type WorkbenchPanel } from "./dealWorkbenchPanels";
import { completedFinanceStageCorrections } from "./FinanceCompanyDecisionCard";
import { stageOwnerLabel, stageShowsMirrorNote, type buildDealCockpitStageView } from "./dealCockpitStageView";
import type { ActiveAppraisalProvider, DealCockpitViewProps } from "./DealCockpitViewProps";
import type { WorkflowAction } from "./DealWorkflowAction";
import type { ChecklistItem } from "./dealStepChecklist";
import type { useDealFinanceDecision } from "./useDealFinanceDecision";

type FinanceActions = Pick<
  ReturnType<typeof useDealFinanceDecision>,
  "openRecordAppraisal" | "openQuotationCorrection" | "openReopenApproval" | "openDeliveredApprovalCorrection"
>;

export function buildDealStageCards({
  stage,
  navigation,
  documents,
  documentsActionable,
  panelNodes,
  liveAction,
  stageCorrection,
  financeDecision,
  financeActions,
  checklistItems,
  settlementRoute,
  activeAppraisalProvider,
  t,
}: Pick<DealCockpitViewProps, "stageCorrection" | "settlementRoute" | "financeDecision"> &
  Readonly<{
    stage: ReturnType<typeof buildDealCockpitStageView>;
    navigation: {
      railOpen: boolean;
      requestStage: (key: string | null) => void;
      hasDocumentsPane: boolean;
      goToDocuments: () => void;
      goToFlowPanel: (panel: WorkbenchPanel) => void;
      goToCosts: (() => void) | undefined;
    };
    documents: DealCockpitData["documents"];
    documentsActionable: boolean;
    panelNodes: Readonly<Record<WorkbenchPanel, ReactNode>>;
    liveAction: WorkflowAction | undefined;
    financeActions: FinanceActions;
    checklistItems: ReadonlyArray<ChecklistItem> | null;
    activeAppraisalProvider: ActiveAppraisalProvider;
    t: (key: string) => string;
  }>) {
  const { stages, live, liveIndex, viewedMode, otherStage, dealPath, dealClosed, routeBlocksClose, allComplete } = stage;
  const { railOpen, requestStage, hasDocumentsPane, goToDocuments, goToFlowPanel, goToCosts } = navigation;
  // The step being looked at, when it is not the live one: a record card
  // ABOVE the live step. It is one more keyed sibling in the flow, so it comes
  // and goes without ever remounting a panel.
  const recordPanel = otherStage
    ? panelsForStage(otherStage.key).find((panel) => panelNodes[panel] != null)
    : undefined;
  const stageViewNode: ReactNode = otherStage ? (
    <DealStageView
      mode={viewedMode === "live" ? "future" : viewedMode}
      stageKey={otherStage.key}
      path={dealPath}
      closed={dealClosed}
      label={t(STAGE_LABEL_KEY[otherStage.key] ?? otherStage.key)}
      state={otherStage.state}
      owner={otherStage.state === "NOT_APPLICABLE" ? undefined : stageOwnerLabel(otherStage, activeAppraisalProvider, t)}
      position={stages.findIndex((candidate) => candidate.key === otherStage.key) + 1}
      total={stages.length}
      hasLiveStep={live !== undefined}
      onBack={() => {
        // The back control unmounts with the card, taking focus with it: put
        // it on the rail node first (the live step's, or -- on a finished
        // deal with no live step -- the one that was being viewed), so a
        // keyboard user is never dropped onto the page.
        // A finished deal keeps its rail collapsed behind the persistent
        // "show stages" toggle: with no node on screen, focus goes there.
        // On a phone the rail is folded behind its bar (O4): its nodes are not
        // on screen, so focus goes to the bar that opens them.
        const railHidden = !railOpen && window.matchMedia?.("(max-width: 767px)").matches === true;
        const target =
          (railHidden ? document.querySelector<HTMLElement>('[data-testid="deal-mobile-rail-toggle"]') : null) ??
          document.querySelector<HTMLElement>(
            `[data-testid="deal-stage-node-${live?.key ?? otherStage.key}"]`
          ) ??
          document.querySelector<HTMLElement>('[data-testid="deal-stages-toggle"]');
        target?.focus({ preventScroll: true });
        requestStage(null);
      }}
      // The documents live in the controlled lower tabs, which may be on
      // Activity: the existing documents transition switches them first.
      onShowRecord={
        recordPanel ? (recordPanel === "documents" ? goToDocuments : () => goToFlowPanel(recordPanel)) : undefined
      }
      corrections={stageCorrection?.stageKey === otherStage.key
        ? [stageCorrection]
        : completedFinanceStageCorrections(otherStage.key, financeDecision, {
          replaceAppraisal: financeActions.openRecordAppraisal,
          correctQuotation: financeActions.openQuotationCorrection,
          reopenApproval: financeActions.openReopenApproval,
          correctDeliveredApproval: financeActions.openDeliveredApprovalCorrection,
        })}
      t={t}
    />
  ) : null;
  // The next-step card (or, for a stopped deal, the muted fact that it stopped).
  const stepNode: ReactNode = live ? (
    <StageFocusRow
      state={live.state}
      label={t(STAGE_LABEL_KEY[live.key] ?? live.key)}
      position={liveIndex + 1}
      total={stages.length}
      owner={stageOwnerLabel(live, activeAppraisalProvider, t)}
      mirrorNote={stageShowsMirrorNote(live, activeAppraisalProvider)}
      blocker={live.blocker ? t(`Blocker${live.blocker}`) : undefined}
      action={liveAction}
      outstandingDocuments={
        live.blocker === "DocumentsIncomplete"
          ? documents.filter(
              (doc) => doc.required && doc.status !== "VERIFIED" && doc.status !== "WAIVED"
            )
          : []
      }
      onGoToDocuments={hasDocumentsPane ? goToDocuments : undefined}
      documentsActionable={documentsActionable}
      checklist={
        checklistItems
          ? {
              items: checklistItems,
              // Only destinations the cockpit already has, and only for a
              // caller who can act there: the same gates as the blocker links.
              go: (destination) => {
                if (destination === "documents") {
                  return hasDocumentsPane && documentsActionable ? goToDocuments : undefined;
                }
                if (destination === "handoverCosts") return goToCosts;
                // Recording the approved amount is the approver's act: a caller
                // without that authority is told who acts, not sent to a form.
                if (destination === "financeDecision") {
                  return financeDecision?.canRecordApproval && panelNodes.financeDecision != null
                    ? () => goToFlowPanel("financeDecision")
                    : undefined;
                }
                if (destination === "closing") {
                  return panelNodes.closing != null ? () => goToFlowPanel("closing") : undefined;
                }
                return undefined;
              },
            }
          : undefined
      }
      t={t}
    >
      {/* The route IS the blocker on this step, so the control is on the
          step — an operator told "record who the finance company pays"
          must not have to hunt for where. Rendered here INSTEAD of beside
          the vehicle, never in both places. */}
      {routeBlocksClose && settlementRoute && (
        <SettlementRouteControl
          route={settlementRoute.route}
          canSettleDirectToSupplier={settlementRoute.canSettleDirectToSupplier}
          directRouteRefusal={settlementRoute.directRouteRefusal}
          supplierName={settlementRoute.supplierName}
          disabled={settlementRoute.locked}
          t={t}
          onChoose={settlementRoute.onChoose}
        />
      )}
    </StageFocusRow>
  ) : !allComplete ? (
      /* No live stage and not finished: the deal stopped. Said in the
         muted register — a stopped deal is a fact, not an alarm; the
         held-deposit strip above carries the alarm when there is one. */
      <p className="text-sm text-muted-foreground" data-testid="deal-stopped">
        {t("DealStopped")}
      </p>
  ) : null;

  return { stageViewNode, stepNode };
}
