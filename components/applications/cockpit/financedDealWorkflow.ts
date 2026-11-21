import {
  buildDisbursementStep,
  buildSettlementStep,
} from "./dealClosingWorkflow";
import { buildEarlyDealStep, NO_EARLY_STEP } from "./dealEarlyWorkflow";
import type { buildDealDocuments } from "./dealDocumentWorkflow";
import type { buildFinancedDealMoney } from "./financedDealMoneyPresentation";
import type { FinanceDecisionWiring } from "./DealCockpitViewProps";
import type { WorkflowAction } from "./DealWorkflowAction";
import type { useFinancedClosingReadiness } from "./useClosingReadiness";
import type { useDealClosingRecords } from "./useDealClosingRecords";
import type { useDealDisbursementActions } from "./useDealDisbursementActions";
import type { useDealFinalization } from "./useDealFinalization";
import type { useDealForwardActions } from "./useDealForwardActions";
import type { useExpectedPaymentActions } from "./useExpectedPaymentActions";
import type { useFinancedCockpitReads } from "./useFinancedCockpitReads";
import type { useFinancedCreditDecision } from "./useFinancedCreditDecision";
import type { useFinancedHandoverActions } from "./useFinancedHandoverActions";

export function buildFinancedDealWorkflow({
  deal,
  app,
  permissionsLoading,
  isOwnDeal,
  access,
  documentWorkflow,
  financeDecision,
  money,
  closingRead,
  creditActions,
  deliveryActions,
  expectedPaymentActions,
  forwardActions,
  disbursementActions,
  finalization,
  closingRecords,
}: Readonly<{
  deal: ReturnType<typeof useFinancedCockpitReads>["deal"];
  app: ReturnType<typeof useFinancedCockpitReads>["app"];
  permissionsLoading: boolean;
  isOwnDeal: boolean;
  access: Readonly<{
    canApproveApplication: boolean;
    canReviewApplication: boolean;
    canViewApplications: boolean;
    canRecordSupplierRoute: boolean;
    canConfirmFinanceDisbursement: boolean;
    canRegisterHandover: boolean;
    canRegisterExpectedPayment: boolean;
  }>;
  documentWorkflow: ReturnType<typeof buildDealDocuments>;
  financeDecision?: FinanceDecisionWiring;
  money: ReturnType<typeof buildFinancedDealMoney>;
  closingRead: ReturnType<typeof useFinancedClosingReadiness>;
  creditActions: ReturnType<typeof useFinancedCreditDecision>;
  deliveryActions: ReturnType<typeof useFinancedHandoverActions>;
  expectedPaymentActions: ReturnType<typeof useExpectedPaymentActions>;
  forwardActions: ReturnType<typeof useDealForwardActions>;
  disbursementActions: ReturnType<typeof useDealDisbursementActions>;
  finalization: ReturnType<typeof useDealFinalization>;
  closingRecords: ReturnType<typeof useDealClosingRecords>;
}>): WorkflowAction | undefined {
  if (permissionsLoading || !deal) return undefined;

  const {
    canApproveApplication,
    canReviewApplication,
    canViewApplications,
    canRecordSupplierRoute,
    canConfirmFinanceDisbursement,
    canRegisterHandover,
    canRegisterExpectedPayment,
  } = access;
  const { documentsIncomplete, documentsStepReason } = documentWorkflow;
  const {
    settlesDirectToSupplier,
    canConfirmSupplierDisbursement,
    chequeDisbursementBlockKey,
    disbursementDenominationBlock,
    disbursementDenominationDetail,
    canConfirmDisbursement,
    finalizeDenominationBlock,
    finalizeDenominationDetail,
  } = money;
  const {
    closingReadiness,
    closingReadinessServiceUnavailable,
    finalizeAllowedByReadiness,
    preFinalizeForward,
  } = closingRead;
  /**
   * The action for the stage the rail is currently naming.
   *
   * ONE action at a time, keyed to a stage, because the tail is strictly ordered
   * on the server and each step refuses a second attempt: handover requires an
   * APPROVED application, the expected payment requires the handover, and
   * `finalizeDeal` requires both. Offering all three at once would put two
   * guaranteed refusals on screen beside the one step that can actually be
   * taken.
   *
   * Each step is gated on its OWN permission — `register:vehicle_handover`,
   * `register:expected_payment`, `confirm:finance_disbursement` are three separate
   * strings on customizable roles, so a caller may hold one and not the next.
   * A single flag over the whole tail would hide a step somebody is entitled to
   * take, and would show one they are not.
   *
   * The last two hang off SETTLEMENT rather than off stages of their own. The
   * rail's stages are the ones `deriveDealStages` emits, and inventing client
   * stages it does not know about would give the screen a second opinion about
   * the deal's shape. SETTLEMENT is where the deal actually sits while these two
   * are outstanding, and it is the stage whose blocker the operator is trying to
   * clear.
   */
  const handoverStage = deal?.stages.find((stage) => stage.key === "HANDOVER");
  const settlementStage = deal?.stages.find(
    (stage) => stage.key === "SETTLEMENT",
  );
  /**
   * Whether the payment fact `finalizeDeal` requires is on file — from the
   * SERVER, never inferred from the rail. No stage completes on the expected
   * payment, so the rail cannot answer this, and guessing from SETTLEMENT's
   * blocker would have offered finalize on a deal that has no payment recorded.
   */
  const expectedPaymentRegistered =
    deal && "expectedPaymentRegistered" in deal
      ? deal.expectedPaymentRegistered
      : false;
  /**
   * Whether `finalizeDeal` will refuse for want of a settlement route — the
   * server's own answer, computed from the same inputs the mutation refuses on.
   * Nothing on this side reconstructs it; `money.routeKnown` is a different
   * question and reports this deal as fine.
   */
  const settlementRouteRequired =
    deal && "supplierSettlementRouteRequired" in deal
      ? deal.supplierSettlementRouteRequired
      : false;

  /**
   * The stage the rail is actually naming — the same one the view calls `live`.
   *
   * Read here rather than left implicit, because one branch below has to answer
   * for a stage that has no action at all, and "return the handover entry and
   * let the view filter it out" cannot express that.
   *
   * A NOT_APPLICABLE stage is never this one (SCRUM-446): the server does not
   * choose it as live, so a deal whose finance company pays nobody offers no
   * "confirm payment" action and no `DisbursementUnavailable` sentence to
   * contradict a rail that says the step is not needed. The step's own words
   * live in `DealStageView` (see `stageNotApplicableReasonKey`).
   */
  const liveStage = deal?.stages.find(
    (stage) => stage.state === "CURRENT" || stage.state === "BLOCKED",
  );

  const earlyStep = buildEarlyDealStep({
    deal,
    app,
    liveStage,
    handoverStage,
    isOwnDeal,
    canApproveApplication,
    canReviewApplication,
    canViewApplications,
    documentsIncomplete,
    documentsStepReason,
    financeDecision,
    openGap: () => deliveryActions.gap.onOpenChange(true),
    recordCreditStatus: creditActions.recordCreditStatus,
    openCredit: creditActions.open,
  });
  if (earlyStep !== NO_EARLY_STEP) return earlyStep;

  /**
   * The money actually moving — confirmed from the evidence, on the route the
   * deal recorded. Direct route: the finance company paid the SUPPLIER, and
   * the advice is recorded (no journal, no dealership cash). Through the
   * dealership: the receipt is confirmed and posts DR Bank. Two different
   * claims, so two different actions rather than one button meaning two
   * things depending on a field elsewhere.
   *
   * `app` carries the facts these gates need; until it arrives the stage
   * keeps its blocker and offers nothing, which is honest rather than early.
   */
  if (liveStage?.key === "DISBURSEMENT") {
    if (!app) return undefined;
    return buildDisbursementStep({
      disbursedAt: app.disbursedAt,
      settlesDirectToSupplier,
      canConfirmSupplierDisbursement,
      canConfirmFinanceDisbursement,
      chequeDisbursementBlockKey,
      forwardBlocksTransfer: forwardActions.blocksTransfer,
      forward: deal.forward,
      disbursementDenominationBlock,
      disbursementDenominationDetail,
      canConfirmDisbursement,
      openSupplierReceipt: () =>
        disbursementActions.supplier.onOpenChange(true),
      openFinanceReceipt: () =>
        disbursementActions.financeCompany.onOpenChange(true),
      openForward: forwardActions.openRecord,
    });
  }

  // Handover first: the step the rail names on a deal whose economics are
  // recorded, and the one the product could not perform at all.
  if (handoverStage && handoverStage.state !== "COMPLETE") {
    return {
      stageKey: "HANDOVER",
      actionKey: "RegisterHandoverAction",
      onStart: () => {
        deliveryActions.handover.onOpenChange(true);
      },
      // The server's own precondition, surfaced instead of discovered as a
      // failed submit: `registerVehicleHandover` requires an APPROVED
      // application. A blocked stage keeps its blocker text, which the block
      // already renders, so only the permission gap is added here.
      //
      // SCRUM-417 UX1 (S2): a BLOCKED handover is the server's own verdict
      // (`HandoverBlocked`) that the vehicle cannot be handed over yet, so no
      // register action is offered at all. The prerequisite is named before
      // the permission, as the close's reason does: telling a caller to ask
      // for a permission that would not help is a dead end too.
      //
      // Only while the application is NOT approved: the rail reads the STORED
      // handover status, which re-appraisal and reopen-approval write as
      // BLOCKED, while the server's `registerVehicleHandover` checks only
      // `status === "APPROVED"`. An APPROVED deal with a stale BLOCKED keeps
      // its door, subject to the permission below.
      unavailableReasonKey:
        handoverStage.blocker === "HandoverBlocked" &&
        deal.status !== "APPROVED"
          ? "HandoverBlockedNeedsApproval"
          : canRegisterHandover
            ? undefined
            : "HandoverNeedsPermission",
    };
  }

  return buildSettlementStep({
    settlementStage,
    deal,
    app,
    expectedPaymentRegistered,
    canRegisterExpectedPayment,
    canCloseDeal: canConfirmFinanceDisbursement,
    finalizeDenominationBlock,
    settlementRouteRequired,
    canRecordSupplierRoute,
    closingReadiness,
    closingReadinessServiceUnavailable,
    preFinalizeForward,
    canViewApplications,
    finalizeAllowedByReadiness,
    finalizeDenominationDetail,
    openExpectedPayment: () =>
      expectedPaymentActions.payment.onOpenChange(true),
    openReconciliation: closingRecords.openReconciliation,
    openForward: forwardActions.openRecord,
    openFinalization: finalization.onStart,
  });
}
