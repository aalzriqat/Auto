import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { nextFinanceDecisionStep } from "./FinanceCompanyDecisionCard";
import type { FinanceDecisionWiring } from "./DealCockpitViewProps";
import type { WorkflowAction } from "./DealWorkflowAction";
import type { FinancedCreditStatus } from "./useFinancedCreditDecision";

type FinancedDeal = NonNullable<
  FunctionReturnType<typeof api.dealWorkspace.financedDealCockpit>
>;

// A selected early stage can deliberately offer no action. Keep that outcome distinct from fallthrough.
export const NO_EARLY_STEP = Symbol("No early workflow stage selected");

export function buildEarlyDealStep({
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
  openGap,
  recordCreditStatus,
  openCredit,
}: Readonly<{
  deal: FinancedDeal;
  app: FunctionReturnType<typeof api.applications.get> | undefined;
  liveStage?: FinancedDeal["stages"][number];
  handoverStage?: FinancedDeal["stages"][number];
  isOwnDeal: boolean;
  canApproveApplication: boolean;
  canReviewApplication: boolean;
  canViewApplications: boolean;
  documentsIncomplete: boolean;
  documentsStepReason?: string;
  financeDecision?: FinanceDecisionWiring;
  openGap: () => void;
  recordCreditStatus: (status: FinancedCreditStatus) => Promise<void>;
  openCredit: () => void;
}>): WorkflowAction | undefined | typeof NO_EARLY_STEP {
  /**
   * The stage that used to have no exit (SCRUM-83).
   *
   * A finance company approving BELOW the submitted quotation is the ordinary
   * case; it is the whole reason an appraisal gap exists.
   * `approveDealerPurchaseAmount` writes `PENDING_NEGOTIATION`, which
   * `deriveDealStages` does not count as resolved, and because the rail is
   * strictly sequential the stage hid handover, settlement and every action
   * after it. `resolveAppraisalGap` is the writer that was missing; this is
   * its one entry point. The blocked state itself is NOT softened — it is true
   * until somebody records who covers the shortfall.
   *
   * Three obstacles, told apart rather than merged, lifecycle FIRST because it
   * outranks both: the server refuses anything not APPROVED, anything already
   * handed over and anything closed (handover seals the figures; finalization
   * writes the sale against them), so offering the action there would promise
   * a step guaranteed to fail. One exception, the server's own (SCRUM-116):
   * handover now refuses an unsettled gap, so a gap still open after the
   * vehicle went out came from an approval recorded no earlier than handover
   * — the approval's timestamp says so; an equal timestamp is ambiguous and
   * admitted on purpose — and settling it is exactly what finalization is
   * waiting on. The rail shows this stage again in that case and the action
   * must be there, keyed on the same two timestamps the mutation compares.
   * Then authority — the same permission that set
   * the approved amount, and never the deal's own salesperson (the server
   * refuses both). Then visibility: a caller who HOLDS the authority but whose
   * money is withheld cannot be asked to allocate a figure the screen does not
   * show them, and telling them to find an approver would name a problem they
   * do not have.
   *
   * The gap is read from the MONEY block, not the rail: the rail is
   * deliberately qualitative so it can be shown to a caller who cannot see
   * amounts, and a locally derived gap could disagree with the one the
   * mutation reconciles against.
   */
  // SCRUM-417 (G4): a FAILED negotiation on a live deal is settled through
  // the same writer — `resolveAppraisalGap` refuses only a gap already
  // CUSTOMER_ABSORBS / DEALER_ABSORBS / SPLIT / SUPPLIER_ABSORBS, and the rail hands both
  // blockers to the dealership for exactly this action.
  if (
    liveStage?.blocker === "GapUnresolved" ||
    liveStage?.blocker === "GapNegotiationFailed"
  ) {
    // The amount to settle is the server's NET shortfall (SCRUM-766). An
    // UNAVAILABLE one has no amount to settle: say so instead of offering a
    // dialog that would allocate nothing.
    const shortfallUnavailable =
      deal.money?.shortfall?.method === "UNAVAILABLE";
    const gapVisible = typeof deal.money?.shortfall?.totalMinor === "number";
    const handedOverAt = app?.vehicleHandoverAt;
    // `>=`, as the mutation compares: equal timestamps are ambiguous (two
    // writes can share a millisecond) and are deliberately admitted.
    const approvalNotBeforeHandover =
      handedOverAt !== undefined &&
      app?.approvedPurchaseCorrectedAfterHandoverAt === undefined &&
      app?.approvedPurchaseApprovedAt !== undefined &&
      app.approvedPurchaseApprovedAt >= handedOverAt;
    const lifecycleSealed =
      deal.status !== "APPROVED" ||
      ((handoverStage?.state === "COMPLETE" || handedOverAt !== undefined) &&
        !approvalNotBeforeHandover);
    return {
      stageKey: liveStage.key,
      actionKey: "ResolveGapAction",
      onStart: openGap,
      unavailableReasonKey: lifecycleSealed
        ? "GapResolutionSealed"
        : !canApproveApplication
          ? "GapResolutionNeedsPermission"
          : isOwnDeal
            ? "GapResolutionSelfDeal"
            : shortfallUnavailable
              ? "GapShortfallUnavailable"
              : gapVisible
                ? undefined
                : "GapResolutionNeedsDealFigures",
    };
  }

  /**
   * A DRAFT application (SCRUM-417, G1). The one legal move out of it is
   * `updateStatus` DRAFT → PENDING_DOCS (`VALID_STATUS_TRANSITIONS`), which
   * the server gates on `view:finance_applications` alone — so that is the
   * gate here too, not a stricter one the server does not apply.
   */
  if (liveStage?.key === "APPLICATION" && deal.status === "DRAFT") {
    return {
      stageKey: "APPLICATION",
      actionKey: "SubmitApplicationAction",
      onStart: () => {
        void recordCreditStatus("PENDING_DOCS");
      },
      unavailableReasonKey: canViewApplications
        ? undefined
        : "SubmitApplicationNeedsPermission",
    };
  }

  /**
   * The finance company's credit decision — RECORDED here, never made.
   *
   * Two dealership moves on this stage, matching `updateStatus`'s legal
   * transitions exactly: PENDING_DOCS → UNDER_REVIEW says the application is
   * with the finance company; UNDER_REVIEW → APPROVED | REJECTED writes down
   * what they decided. APPROVED needs `approve:finance_application`,
   * UNDER_REVIEW and REJECTED need `review:finance_application`; a caller
   * holding neither is told so rather than shown nothing.
   */
  if (liveStage?.key === "CREDIT_DECISION") {
    if (deal.status === "PENDING_DOCS") {
      return {
        stageKey: "CREDIT_DECISION",
        actionKey: "MarkUnderReview",
        onStart: () => {
          void recordCreditStatus("UNDER_REVIEW");
        },
        unavailableReasonKey: canReviewApplication
          ? undefined
          : "CreditDecisionNeedsPermission",
      };
    }
    if (deal.status === "UNDER_REVIEW") {
      const openCreditDialog = {
        actionKey: "RecordCreditDecisionAction",
        onStart: openCredit,
      };
      // SCRUM-417 (G6): the server refuses the APPROVAL while a required
      // document is outstanding, so the next step is the documents — not a
      // dialog whose main option is certain to be refused. A rejection does
      // not need them, so recording it stays one quiet click away — also for
      // an approver who cannot touch the documents themselves (W1), who is
      // told who does instead of being sent to a pane with no control.
      if (
        (canApproveApplication || canReviewApplication) &&
        documentsIncomplete
      ) {
        return {
          stageKey: "CREDIT_DECISION",
          actionKey: "CompleteDocumentsFirstAction",
          opens: "DOCUMENTS",
          noteKey: "CreditApprovalNeedsDocuments",
          secondary: openCreditDialog,
          unavailableReasonKey: documentsStepReason,
        };
      }
      return {
        stageKey: "CREDIT_DECISION",
        ...openCreditDialog,
        unavailableReasonKey:
          canApproveApplication || canReviewApplication
            ? undefined
            : "CreditDecisionNeedsPermission",
      };
    }
    return undefined;
  }

  /**
   * What the finance company told the dealership (SCRUM-417, G3): the
   * quotation, then the appraisal, then the approved amount — one at a time,
   * through the SAME dialogs and the SAME availability predicates the
   * decision card uses (`nextFinanceDecisionStep`).
   */
  if (
    liveStage?.key === "APPRAISAL" ||
    (liveStage?.key === "APPROVED_PURCHASE" &&
      liveStage.blocker === "NoApprovedPurchaseAmount")
  ) {
    if (financeDecision) {
      return {
        stageKey: liveStage.key,
        ...nextFinanceDecisionStep(
          financeDecision.facts,
          financeDecision,
          liveStage.key,
        ),
      };
    }
    // The economics read is skipped for a caller without the permission it
    // authorizes on; the card is absent for them too, so say who acts.
    if (!canViewApplications) {
      return {
        stageKey: liveStage.key,
        actionKey: "RecordApprovedPurchaseAction",
        unavailableReasonKey: "FinanceDecisionNeedsAccess",
      };
    }
    return undefined;
  }

  /**
   * The paperwork (SCRUM-417, G5): an ACTION that opens the Documents tab and
   * focuses it, rather than a passive pointer — offered only when this caller
   * can advance an outstanding document (W1): an uploader facing documents
   * that only await verification is told so, not sent to a pane with nothing
   * for them to press.
   */
  if (liveStage?.key === "DELIVERY_ACTIONS") {
    return {
      stageKey: "DELIVERY_ACTIONS",
      actionKey: "CompleteDocumentsAction",
      opens: "DOCUMENTS",
      unavailableReasonKey: documentsStepReason,
    };
  }

  return NO_EARLY_STEP;
}
