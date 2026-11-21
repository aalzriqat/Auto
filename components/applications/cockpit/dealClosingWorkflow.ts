import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import {
  DISBURSEMENT_DENOMINATION_REASON,
  FINALIZE_DENOMINATION_REASON,
  type disbursementDenominationRefusal,
  type finalizeDenominationRefusal,
} from "@/components/applications/settlementDenomination";
import {
  finalizeUnavailableReasonKey,
  type ClosingReadinessRead,
} from "./useClosingReadiness";
import type { PreFinalizeForward } from "./usePreFinalizeForward";
import type {
  SettlementDenominationDetail,
  WorkflowAction,
} from "./DealWorkflowAction";

/** The step's note when the caller may record the payment: the close waits for it, and the step IS the payment. */
const FORWARD_PAYMENT_STEP_KEY = "FinalizeNeedsForwardPayment";

/**
 * Why the close waits on the payment to the finance company (SCRUM-411 P2-01), or
 * `undefined` when it does not. The server's own verdict, never recomputed here:
 * UNPAID is the payment still to be recorded - by this caller, or by the manager
 * or accountant who may; every other blocking state names who resolves it. A
 * verdict still loading, unavailable or not applicable (`undefined`) blocks
 * nothing on this screen; `finalizeDeal` judges it on the server regardless.
 */
function preFinalizeForwardReasonKey(
  status: PreFinalizeForward | undefined,
): string | undefined {
  switch (status?.state) {
    case "FIRST_PAYMENT_UNFUNDED":
      return "FinalizeFirstPaymentUnfunded";
    case "UNPAID":
      return status.mayRecord
        ? FORWARD_PAYMENT_STEP_KEY
        : "ForwardNeedsPermission";
    case "STALE":
      return "FinalizeForwardPaymentStale";
    case "POSTING_PENDING":
      return "FinalizeForwardPaymentPosting";
    case "POSTING_FAILED":
      return "FinalizeForwardPaymentPostingFailed";
    case "REVERSAL_PENDING":
      return "FinalizeForwardPaymentReversing";
    case "NEEDS_REPAIR":
      return "FinalizeForwardPaymentNeedsReview";
    default:
      return undefined;
  }
}

/**
 * Why a DISBURSEMENT confirmation is not offered: the permission case names a
 * person, the not-applicable case names a fact about the deal. Enumerable
 * rather than a nested ternary, so the three outcomes read one per line.
 */
function disbursementUnavailableReason(
  available: boolean,
  hasPermission: boolean,
  notApplicableKey: string,
): string | undefined {
  if (available) return undefined;
  if (hasPermission) return notApplicableKey;
  return "DisbursementNeedsPermission";
}

export function buildDisbursementStep({
  disbursedAt,
  settlesDirectToSupplier,
  canConfirmSupplierDisbursement,
  canConfirmFinanceDisbursement,
  chequeDisbursementBlockKey,
  forwardBlocksTransfer,
  forward,
  disbursementDenominationBlock,
  disbursementDenominationDetail,
  canConfirmDisbursement,
  openSupplierReceipt,
  openFinanceReceipt,
  openForward,
}: Readonly<{
  disbursedAt?: number;
  settlesDirectToSupplier: boolean;
  canConfirmSupplierDisbursement: boolean;
  canConfirmFinanceDisbursement: boolean;
  chequeDisbursementBlockKey?: string;
  forwardBlocksTransfer: boolean;
  forward?: Readonly<{
    state: string;
    mayRecord?: boolean;
    transferConfirmed?: boolean;
  }> | null;
  disbursementDenominationBlock: ReturnType<
    typeof disbursementDenominationRefusal
  >;
  disbursementDenominationDetail?: SettlementDenominationDetail;
  canConfirmDisbursement: boolean;
  openSupplierReceipt: () => void;
  openFinanceReceipt: () => void;
  openForward: () => void;
}>): WorkflowAction {
  if (settlesDirectToSupplier) {
    return {
      stageKey: "DISBURSEMENT",
      actionKey: "ConfirmSupplierDisbursement",
      onStart: openSupplierReceipt,
      unavailableReasonKey: disbursementUnavailableReason(
        canConfirmSupplierDisbursement,
        canConfirmFinanceDisbursement,
        "SupplierDisbursementUnavailable",
      ),
    };
  }
  // A cheque state the server refuses is a fact about the deal, named
  // before permission: the way forward is on the cheque panel above.
  if (chequeDisbursementBlockKey && !disbursedAt) {
    return {
      stageKey: "DISBURSEMENT",
      actionKey: "ConfirmDisbursement",
      onStart: openFinanceReceipt,
      unavailableReasonKey: chequeDisbursementBlockKey,
    };
  }
  // SCRUM-435: the finance company sends the FULL approved amount, and the
  // dealership pays back the deposit and its contribution first. Until that
  // is settled on the books the transfer is not offered (the server refuses
  // it too); the step names who acts and, when the caller may, offers the
  // recording instead of a dead end.
  // After the transfer the same step reopens ONLY for a returned payment
  // (the stage stays live then); a deal whose forward is settled is never here.
  if (forwardBlocksTransfer) {
    if (forward?.state === "DUE") {
      return {
        stageKey: "DISBURSEMENT",
        actionKey: "RecordForwardToFinanceCompany",
        onStart: openForward,
        unavailableReasonKey: forward.mayRecord
          ? undefined
          : "ForwardNeedsPermission",
      };
    }
    return {
      stageKey: "DISBURSEMENT",
      actionKey: "RecordForwardToFinanceCompany",
      onStart: () => undefined,
      // After the transfer only a reported return lands here: the copy must not
      // talk about confirming a transfer that is already confirmed.
      unavailableReasonKey: forward?.transferConfirmed
        ? "ForwardReturnedNotSettledReason"
        : "ForwardNotSettledReason",
    };
  }
  // The currency boundary is named before permission or applicability:
  // it is a fact about the deal that no caller can act on from here.
  if (disbursementDenominationBlock && !disbursedAt) {
    return {
      stageKey: "DISBURSEMENT",
      actionKey: "ConfirmDisbursement",
      onStart: openFinanceReceipt,
      unavailableReasonKey:
        DISBURSEMENT_DENOMINATION_REASON[disbursementDenominationBlock],
      unavailableDetail: disbursementDenominationDetail,
    };
  }
  return {
    stageKey: "DISBURSEMENT",
    actionKey: "ConfirmDisbursement",
    onStart: openFinanceReceipt,
    unavailableReasonKey: disbursementUnavailableReason(
      canConfirmDisbursement,
      canConfirmFinanceDisbursement,
      "DisbursementUnavailable",
    ),
  };
}

export function buildSettlementStep({
  settlementStage,
  deal,
  app,
  expectedPaymentRegistered,
  canRegisterExpectedPayment,
  canCloseDeal,
  finalizeDenominationBlock,
  settlementRouteRequired,
  canRecordSupplierRoute,
  closingReadiness,
  closingReadinessServiceUnavailable,
  preFinalizeForward,
  canViewApplications,
  finalizeAllowedByReadiness,
  finalizeDenominationDetail,
  openExpectedPayment,
  openReconciliation,
  openForward,
  openFinalization,
}: Readonly<{
  settlementStage?: Readonly<{ state: string }>;
  deal: NonNullable<
    FunctionReturnType<typeof api.dealWorkspace.financedDealCockpit>
  >;
  app: FunctionReturnType<typeof api.applications.get> | undefined;
  expectedPaymentRegistered: boolean;
  canRegisterExpectedPayment: boolean;
  canCloseDeal: boolean;
  finalizeDenominationBlock: ReturnType<typeof finalizeDenominationRefusal>;
  settlementRouteRequired: boolean;
  canRecordSupplierRoute: boolean;
  closingReadiness: ClosingReadinessRead["readiness"];
  closingReadinessServiceUnavailable: boolean;
  preFinalizeForward: PreFinalizeForward | undefined;
  canViewApplications: boolean;
  finalizeAllowedByReadiness: boolean;
  finalizeDenominationDetail?: SettlementDenominationDetail;
  openExpectedPayment: () => void;
  openReconciliation: () => void;
  openForward: () => void;
  openFinalization: () => void;
}>): WorkflowAction | undefined {
  // Everything below is only reachable while the application is still
  // APPROVED, because all three of these mutations refuse anything else.
  //
  // A CLOSED deal's money arriving is the DISBURSEMENT stage above, which
  // now carries its own confirmations; SETTLEMENT below is the dealership's
  // own closing steps while the application is still APPROVED.
  if (!settlementStage || settlementStage.state === "COMPLETE")
    return undefined;
  if (deal.status !== "APPROVED") return undefined;

  // SCRUM-447 B2: a returned/cancelled cheque leaves the payment REGISTERED
  // (as a cheque) with nothing live behind it. Registering again would be
  // refused; the way forward is Correct, offered by the cheque panel above.
  if ("chequeNeedsCorrection" in deal && deal.chequeNeedsCorrection === true)
    return undefined;
  // SCRUM-447 F6: a CLEARED cheque with no confirmed disbursement is for
  // accounting to review; the panel above says so and the rail offers nothing.
  if (
    "chequeNeedsAccountingReview" in deal &&
    deal.chequeNeedsAccountingReview === true
  )
    return undefined;

  if (!expectedPaymentRegistered) {
    return {
      stageKey: "SETTLEMENT",
      actionKey: "RegisterExpectedPaymentAction",
      onStart: openExpectedPayment,
      unavailableReasonKey: canRegisterExpectedPayment
        ? undefined
        : "ExpectedPaymentNeedsPermission",
    };
  }

  // The close's refusal reason and the route control it points at are
  // derived from two independent queries (`deal` and `app`). Naming the
  // refusal before `app` has arrived would show "choose it here" with
  // nothing to choose from for a render or two, so the step keeps only its
  // blocker until both facts are on hand.
  if (app === undefined) return undefined;

  /**
   * A deal flagged for financing reconciliation (SCRUM-417, G7) — a figure on
   * it could not be trusted when it was derived. `finalizeDeal` refuses on
   * the flag (SCRUM-420, the FINANCING_RECONCILED closing check), and it is
   * the one review the product records; closing posts journals from those
   * figures — so the review comes first. It takes the same permission as the
   * close (`confirm:finance_disbursement`), so it never strands the closer.
   */
  if (app?.needsFinancingReconciliation === true) {
    return {
      stageKey: "SETTLEMENT",
      actionKey: "ResolveReconciliationAction",
      onStart: openReconciliation,
      noteKey: "ReconciliationBeforeClose",
      unavailableReasonKey: canCloseDeal
        ? undefined
        : "ReconciliationNeedsPermission",
    };
  }

  // `finalizeDeal` refuses FIRST on a waiting deposit request (SCRUM-444
  // DA-03), so it outranks every other reason. Only a payload that carries the
  // field asserts it; an absent field keeps the behaviour below.
  const hasPendingDepositRequest =
    "pendingDepositRequests" in deal && deal.pendingDepositRequests.length > 0;
  const finalizeReasonKey = hasPendingDepositRequest
    ? "FinalizeNeedsPendingDepositRequestResolved"
    : finalizeDenominationBlock
      ? FINALIZE_DENOMINATION_REASON[finalizeDenominationBlock]
      : finalizeUnavailableReasonKey({
          routeRequired: settlementRouteRequired,
          canRecordRoute: canRecordSupplierRoute,
          readinessBlocksClose:
            closingReadiness !== undefined &&
            closingReadiness.open &&
            closingReadiness.state !== "READY",
          readinessUnreadable: closingReadinessServiceUnavailable,
          forwardReasonKey: preFinalizeForwardReasonKey(preFinalizeForward),
          canClose: canCloseDeal,
          canReadReadiness: canViewApplications,
        });
  // SCRUM-411 P2-01: the deposit and the contribution go to the finance company
  // BEFORE the close. For the caller who may record that payment the step IS the
  // payment (the existing dialog, with the server's pinned amount); everyone else
  // is told who does, by the reason above. Nothing here forms its own opinion of
  // what is owed: the status is the server's.
  if (finalizeReasonKey === FORWARD_PAYMENT_STEP_KEY) {
    return {
      stageKey: "SETTLEMENT",
      actionKey: "RecordForwardToFinanceCompany",
      onStart: openForward,
      noteKey: FORWARD_PAYMENT_STEP_KEY,
    };
  }
  // The same wait as `app` above, for the readiness verdict (S414-R2-SKEW-1,
  // S414-R3-1): the close is offered only under `finalizeAllowedByReadiness`.
  // With no reason to name — a read still in flight, or a verdict that says
  // the deal is no longer open — the step keeps only its blocker meanwhile;
  // a reason that withholds it anyway (a missing route) is shown instead.
  if (finalizeReasonKey === undefined && !finalizeAllowedByReadiness)
    return undefined;

  return {
    stageKey: "SETTLEMENT",
    actionKey: "FinalizeDealAction",
    onStart: openFinalization,
    /**
     * Two different reasons the close cannot be taken, and the PREREQUISITE
     * is named before the permission.
     *
     * The route is the one that would otherwise have been discovered as a
     * refusal: on a consigned car with an external financier and no route
     * recorded — the ordinary shape of a consigned financed deal —
     * `finalizeDeal` is certain to reject, and the operator only reaches it
     * after handover has already sealed the approved amount. Telling a caller
     * who cannot close anyway that they lack the permission would be true and
     * useless; the deal is not closeable by anyone yet.
     *
     * Recording the route is still done in the review dialog. Saying so is the
     * issue's own minimum bar — a pointer is not as good as the action, but it
     * is not a dead end — and bringing that control across is filed separately
     * rather than folded into this change.
     */
    unavailableReasonKey: finalizeReasonKey,
    unavailableDetail: finalizeDenominationDetail,
  };
}
