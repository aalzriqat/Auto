"use client";
import { DealCockpitView as DealCockpitPresentation } from "./DealCockpitView";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { buildFinancedDealMoney } from "./financedDealMoneyPresentation";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { buildFinancedDealWorkflow } from "./financedDealWorkflow";
import type { DealCockpitViewProps } from "./DealCockpitViewProps";
export type {
  WorkflowAction,
  WorkflowActionTarget,
} from "./DealWorkflowAction";
export type {
  ActiveAppraisalProvider,
  FinanceDecisionWiring,
} from "./DealCockpitViewProps";
export {
  StageFocusRow,
  SettlementDenominationLine,
  type SettlementDenominationDetail,
} from "./DealStageFocusRow";
import { useRecordedFeedback, type RecordedModel } from "./recordedFeedback";
import { STAGE_PARAM, type StageDeepLink } from "./dealStepView";
import { useFinancedDealDecision } from "./useFinancedDealDecision";
import { usePermissions } from "@/hooks/use-permissions";
import { PERMISSIONS } from "@/convex/utils/permissions";
import { formatDealNumber } from "@/convex/utils/dealNumberFormat";
import { isRt11DoorDisabled } from "@/convex/utils/rt11DoorContainment";
import { SETTLED_FINANCE_STATUSES } from "@/convex/utils/financeStatuses";
import { useFinancedCreditDecision } from "./useFinancedCreditDecision";
import { useDealExitActions } from "./useDealExitActions";
import {
  useDealSupplierSettlementActions,
  useRecordDealSupplierReceipt,
} from "./useDealSupplierSettlementActions";
import { useDealDocumentActions } from "./useDealDocumentActions";
import { buildDealDocuments } from "./dealDocumentWorkflow";
export {
  documentsOutstanding,
  documentsStepUnavailableReason,
} from "./dealDocumentWorkflow";
import { useFinancedHandoverActions } from "./useFinancedHandoverActions";
import { useExpectedPaymentActions } from "./useExpectedPaymentActions";
import {
  buildDealDisbursementPresentation,
  useDealDisbursementActions,
} from "./useDealDisbursementActions";
import { useDealForwardActions } from "./useDealForwardActions";
import { useCommandIdentity } from "@/hooks/useCommandIdentity";
import { useStoppedDealDepositActions } from "./useStoppedDealDepositActions";
import { useDealCostPresentation } from "./useDealCostPresentation";
import { useDealClosingRecords } from "./useDealClosingRecords";
import { CashNoCostCloseout } from "./CashNoCostCloseout";
import { MoneySurfaceErrorBoundary } from "@/components/accounting/MoneySurfaceErrorBoundary";
import { useFinancedClosingReadiness } from "./useClosingReadiness";
import { useFinancedCockpitReads } from "./useFinancedCockpitReads";
import { useDealFinalization } from "./useDealFinalization";
import { DealCommissionsRow } from "@/components/commissions/DealCommissionsRow";

/** Shared presentation with the existing deal-number and advice rollout settings. */
export function DealCockpitView(props: DealCockpitViewProps) {
  return (
    <DealCockpitPresentation
      {...props}
      dealNumberLabel={formatDealNumber(props.deal?.dealNumber)}
      supplierAdviceDisabled={isRt11DoorDisabled(
        "SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED",
      )}
    />
  );
}

export function useSaleDealPermissions() {
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();
  return {
    permissionsLoading,
    // Cash and financed deals settle suppliers through the same finance mutation.
    canSettleSupplier:
      !permissionsLoading && hasPermission(PERMISSIONS.MANAGE_FINANCE),
    canWriteSale:
      !permissionsLoading &&
      hasPermission(PERMISSIONS.CREATE_SALES) &&
      hasPermission(PERMISSIONS.EDIT_SALES),
    canReadSaleForm:
      !permissionsLoading &&
      hasPermission(PERMISSIONS.VIEW_CUSTOMERS) &&
      hasPermission(PERMISSIONS.VIEW_VEHICLES) &&
      hasPermission(PERMISSIONS.VIEW_USERS),
    canViewSales: hasPermission(PERMISSIONS.VIEW_SALES),
    canViewFinance: hasPermission(PERMISSIONS.VIEW_FINANCE),
  };
}

export { dealStatusBadgeKey } from "./DealCockpitHeader";

export type { DealCockpitData } from "./DealStagePresentation";

/** Coordinates the financed route, its live reads, and domain actions. */
export function DealCockpit({
  orgId,
  applicationId,
  canonicalizeUrl = true,
  stageDeepLink,
}: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  /** The `?stage=` deep link, owned by the route (SCRUM-417 UX4, O3). View selection only. */
  stageDeepLink?: StageDeepLink;
  /** The application route redirects when the server publishes the canonical sale. */
  canonicalizeUrl?: boolean;
}>) {
  const { t, locale } = useLanguage();
  const recordSupplierReceipt = useRecordDealSupplierReceipt(orgId);
  const {
    hasPermission,
    isLoading: permissionsLoading,
    membership,
  } = usePermissions();
  const router = useRouter();

  const commandId = useCommandIdentity();
  const canViewApplications =
    !permissionsLoading && hasPermission(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
  const canViewDealCosts =
    canViewApplications && hasPermission(PERMISSIONS.VIEW_COST_PRICE);
  const { deal, app, documents, documentHistory, dealCosts, overview } =
    useFinancedCockpitReads({
      orgId,
      applicationId,
      canViewApplications,
      canViewDealCosts,
    });
  const { economics, economicsApp, supplierBasis, financeDecision } =
    useFinancedDealDecision({
      orgId,
      applicationId,
      deal,
      operatorId: membership?.userId,
      canViewApplications,
      permissionsLoading,
      access: {
        viewFinance: hasPermission(PERMISSIONS.VIEW_FINANCE),
        viewCostPrice: hasPermission(PERMISSIONS.VIEW_COST_PRICE),
        createApplication: hasPermission(
          PERMISSIONS.CREATE_FINANCE_APPLICATION,
        ),
        approveApplication: hasPermission(
          PERMISSIONS.APPROVE_FINANCE_APPLICATION,
        ),
        reviewApplication: hasPermission(
          PERMISSIONS.REVIEW_FINANCE_APPLICATION,
        ),
        confirmDisbursement: hasPermission(
          PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
        ),
      },
      commandId,
      t,
    });

  // The server publishes only a readable canonical sale.
  const finalizedSaleId = canonicalizeUrl
    ? (deal?.canonicalSaleId ?? null)
    : null;
  // The step being looked at travels with the redirect: a `?stage=` deep link
  // opened on the application URL must not be dropped on its way to the sale.
  const carriedStage = stageDeepLink?.value ?? null;
  useEffect(() => {
    if (finalizedSaleId) {
      const query = carriedStage
        ? `?${STAGE_PARAM}=${encodeURIComponent(carriedStage)}`
        : "";
      router.replace(`/${orgId}/sales/${finalizedSaleId}/deal${query}`);
    }
  }, [finalizedSaleId, orgId, router, carriedStage]);

  const canManageFinance =
    !permissionsLoading && hasPermission(PERMISSIONS.MANAGE_FINANCE);
  // SCRUM-447 B2: registering the payment is a separate permission the server
  // also accepts on a closed, undisbursed deal alongside MANAGE_FINANCE.
  const canRegisterPayment =
    !permissionsLoading && hasPermission(PERMISSIONS.REGISTER_EXPECTED_PAYMENT);

  // Announce recorded steps when the live read model reflects the write.
  const recordedModel: RecordedModel | null = deal
    ? {
        deal,
        documents,
        application: app,
        economics: economicsApp,
        costs: dealCosts,
      }
    : null;
  const {
    recorded: recordedFeedback,
    track: trackRecorded,
    clear: clearRecorded,
  } = useRecordedFeedback(
    recordedModel,
    (fallbackKey) => toast.success(t(fallbackKey)),
    String(applicationId),
  );
  const documentActions = useDealDocumentActions({
    orgId,
    applicationId,
    documents,
    trackRecorded,
  });
  const closingRead = useFinancedClosingReadiness({
    orgId,
    applicationId,
    deal,
    canViewApplications,
  });
  const {
    closingReadiness,
    closingReadinessServiceUnavailable,
    finalizeReadinessHoldKey,
    preFinalizeForward,
  } = closingRead;
  const orgCurrency = useCurrency();

  const canReviewApplication =
    !permissionsLoading &&
    hasPermission(PERMISSIONS.REVIEW_FINANCE_APPLICATION);
  const canApproveApplication =
    !permissionsLoading &&
    hasPermission(PERMISSIONS.APPROVE_FINANCE_APPLICATION);
  const canCreateApplication =
    !permissionsLoading &&
    hasPermission(PERMISSIONS.CREATE_FINANCE_APPLICATION);
  // Settlement routing and closed-deal cancellation have separate grants.
  const canRecordSupplierRoute =
    !permissionsLoading &&
    hasPermission(PERMISSIONS.MANAGE_SUPPLIER_SETTLEMENT);
  const canCancelClosedDeal =
    !permissionsLoading && hasPermission(PERMISSIONS.CANCEL_CLOSED_DEAL);
  const canVerifyDocuments =
    !permissionsLoading && hasPermission(PERMISSIONS.VERIFY_FINANCE_DOCUMENTS);
  const documentsSettled =
    deal != null && SETTLED_FINANCE_STATUSES.includes(deal.status);
  const canConfirmFinanceDisbursement =
    !permissionsLoading &&
    hasPermission(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
  const canResolveDeposits =
    !permissionsLoading && hasPermission(PERMISSIONS.APPROVE_REQUESTS);
  // SCRUM-407 owner ruling: finalizing a financed deal is for accountants only.
  // Mirrors `finalizeDeal`, which requires `confirm:finance_disbursement`.
  const canCloseDeal = canConfirmFinanceDisbursement;

  const creditActions = useFinancedCreditDecision({
    orgId,
    applicationId,
    trackRecorded,
    t,
  });
  const isOwnDeal =
    membership?.userId != null && membership.userId === app?.salespersonId;
  const exitActions = useDealExitActions({
    orgId,
    applicationId,
    app,
    deal,
    preFinalizeForward,
    canApproveApplication,
    canCreateApplication,
    canCancelClosedDeal,
    canConfirmFinanceDisbursement,
    t,
  });
  const { unwindBars } = exitActions;
  const disbursementActions = useDealDisbursementActions({
    orgId,
    applicationId,
    version: app != null ? (app.disbursementVersion ?? 1) : undefined,
    canConfirmFinanceDisbursement,
    trackRecorded,
    t,
  });

  const money = buildFinancedDealMoney({
    app,
    deal,
    orgCurrency,
    locale,
    canRecordSupplierRoute,
    canConfirmFinanceDisbursement,
    t,
  });
  const {
    economicsCurrencyCode,
    economicsFactor,
    currencyMarker,
    formatEconomics,
    isConsignedDeal,
    supplierName,
    financingPlan,
    formatPlanMajor,
    expectedDisbursementLabel,
    expectedDisbursementMinor,
    canChooseSettlementRoute,
  } = money;
  const { handoverCosts, custody, custodyMoney } = useDealCostPresentation({
    orgId,
    applicationId,
    app,
    deal,
    dealCosts,
    permissionsLoading,
    canViewDealCosts,
    canCreateApplication,
    canConfirmFinanceDisbursement,
    economicsCurrencyCode,
    orgCurrencyCode: orgCurrency.code,
    currencyMarker,
    closingReadiness,
    unwindBars,
    commandId,
    locale,
    t,
  });
  const forwardActions = useDealForwardActions({
    orgId,
    applicationId,
    commandId,
    deal,
    preFinalizeForward,
    costCurrency: dealCosts?.currency,
    economicsCurrencyCode,
    canConfirmFinanceDisbursement,
    canViewFinance: hasPermission(PERMISSIONS.VIEW_FINANCE),
    unwindBars,
    formatEconomics,
    t,
  });
  const deposits = useStoppedDealDepositActions({
    orgId,
    commandId,
    app,
    canResolveDeposits,
    trackRecorded,
  });

  const deliveryActions = useFinancedHandoverActions({
    orgId,
    applicationId,
    trackRecorded,
  });
  const expectedPaymentActions = useExpectedPaymentActions({
    orgId,
    applicationId,
    deal,
    trackRecorded,
    t,
  });

  const documentWorkflow = buildDealDocuments({
    deal,
    documents,
    documentHistory,
    documentActions,
    canCreateApplication,
    canViewApplications,
    canVerifyDocuments,
    documentsSettled,
    locale,
  });

  const supplierSettlement = useDealSupplierSettlementActions({
    orgId,
    applicationId,
    deal,
    app,
    supplierName,
    canChooseSettlementRoute,
  });
  const finalization = useDealFinalization({
    orgId,
    applicationId,
    vehicleId: app?.vehicleId,
    quote: app?.quote,
    canCloseDeal,
    canViewVehicles: hasPermission(PERMISSIONS.VIEW_VEHICLES),
    loading: permissionsLoading || app === undefined,
    finalizeReadinessHoldKey,
    trackRecorded,
    t,
  });

  const closingRecords = useDealClosingRecords({
    orgId,
    applicationId,
    applicationStatus: app?.status,
    hasFinalizedSale: app?.finalizedSaleId !== undefined,
    canConfirmFinanceDisbursement,
    dealCosts,
    economicsStamp: deal?.economicsStamp,
    orgCurrencyCode: orgCurrency.code,
    isConsignedDeal,
    reconciliationRequired: app?.needsFinancingReconciliation === true,
    reconciliationReason: app?.financingReconciliationReason,
    trackRecorded,
    t,
  });
  const { legalInvoice } = closingRecords;

  // Keep the redirect fallback below all hooks.
  if (finalizedSaleId) return <Skeleton className="h-64 w-full" />;

  const disbursementPresentation = buildDealDisbursementPresentation({
    deal,
    app,
    disbursementActions,
    forward: forwardActions.record,
    economicsFactor,
    expectedDisbursementLabel,
    expectedDisbursementMinor,
    formatEconomics,
    supplierName,
    t,
  });
  const workflowAction = buildFinancedDealWorkflow({
    deal,
    app,
    permissionsLoading,
    isOwnDeal,
    access: {
      canApproveApplication,
      canReviewApplication,
      canViewApplications,
      canRecordSupplierRoute,
      canConfirmFinanceDisbursement,
      canRegisterHandover: hasPermission(PERMISSIONS.REGISTER_VEHICLE_HANDOVER),
      canRegisterExpectedPayment: hasPermission(
        PERMISSIONS.REGISTER_EXPECTED_PAYMENT,
      ),
    },
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
  });

  return (
    <>
      <DealCockpitView
        orgId={orgId}
        renderCommissions={({ profitMinor, money, t }) => (
          <DealCommissionsRow
            orgId={orgId}
            saleId={deal?.canonicalSaleId}
            profitMinor={profitMinor}
            money={money}
            t={t}
          />
        )}
        deal={deal}
        stageDeepLink={stageDeepLink}
        backHref={`/${orgId}/deals`}
        financeDecision={financeDecision}
        workbenchPending={
          permissionsLoading ||
          app === undefined ||
          (canViewApplications && economics === undefined)
        }
        financingPlan={
          financingPlan
            ? { facts: financingPlan, formatMajor: formatPlanMajor }
            : undefined
        }
        handoverCosts={handoverCosts}
        financialOverview={
          deal
            ? { data: overview ?? undefined, loading: overview === undefined }
            : undefined
        }
        custody={custody}
        custodyMoney={custodyMoney}
        workflowAction={workflowAction}
        stageCorrection={
          legalInvoice?.onRecord && legalInvoice.recorded
            ? {
                stageKey: "HANDOVER",
                labelKey: "CorrectRecordedLegalInvoiceAction",
                onOpen: legalInvoice.onRecord,
              }
            : undefined
        }
        activeAppraisalProvider={deal?.activeAppraisalProvider ?? null}
        depositAwaitingResolution={deal?.pendingDepositResolution ?? false}
        depositRequests={
          deal && "pendingDepositRequests" in deal
            ? { orgId, requests: deal.pendingDepositRequests }
            : undefined
        }
        quoteDepositReceipts={
          app && (app.deposits?.length || app.depositReceiptQuoteId)
            ? {
                orgId,
                receiptQuoteId: permissionsLoading ? undefined : app.depositReceiptQuoteId,
                deposits: app.deposits ?? [],
                canRecord: hasPermission(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT),
                hasPendingRequest: (deal?.pendingDepositRequests?.length ?? 0) > 0,
              }
            : undefined
        }
        creditDecision={{
          ...creditActions.dialog,
          canApprove: canApproveApplication,
          canReject: canReviewApplication,
          isOwnDeal,
          documentsIncomplete: documentWorkflow.documentsIncomplete,
        }}
        cancel={exitActions.cancel}
        unwind={
          exitActions.unwind
            ? {
                ...exitActions.unwind,
                formatMinor: (minor) =>
                  custodyMoney(minor, economicsCurrencyCode),
              }
            : undefined
        }
        forwardCorrection={forwardActions.correction}
        chequeReturn={disbursementPresentation.chequeReturn}
        cancelHint={exitActions.cancelHint}
        settlementRoute={supplierSettlement.settlementRoute}
        documents={documentWorkflow.presentation}
        deposits={deposits}
        disbursement={disbursementPresentation.disbursement}
        gapResolution={{
          ...deliveryActions.gap,
          submittedQuotationMinor:
            economicsApp?.submittedQuotationMinor ?? null,
          approvedPurchaseAmountMinor:
            economicsApp?.approvedDealerPurchaseAmountMinor ?? null,
          supplierBasis,
        }}
        handover={deliveryActions.handover}
        expectedPayment={expectedPaymentActions.payment}
        finalize={finalization.confirmation}
        canCorrectAdvice={canManageFinance}
        canRegisterPayment={canRegisterPayment}
        fcCheque={expectedPaymentActions.cheque}
        canSettleSupplier={canManageFinance}
        documentsActionable={
          !permissionsLoading &&
          documentWorkflow.documentsStepReason === undefined
        }
        recordedFeedback={{
          recorded: recordedFeedback,
          track: trackRecorded,
          onDismiss: clearRecorded,
        }}
        onCorrectSettlementAdvice={supplierSettlement.correctAdvice}
        onRecordSupplierReceipt={recordSupplierReceipt}
        noCostCloseout={
          deal && (canCreateApplication || canResolveDeposits) ? (
            <MoneySurfaceErrorBoundary
              key={applicationId}
              fallback={<p role="status">{t("CashNoCostUnavailable")}</p>}
            >
              <CashNoCostCloseout
                orgId={orgId}
                applicationId={applicationId}
                t={t}
              />
            </MoneySurfaceErrorBoundary>
          ) : undefined
        }
        closingChecklist={
          canViewApplications && deal
            ? {
                readiness: closingReadiness,
                serviceUnavailable: closingReadinessServiceUnavailable,
                legalInvoice,
              }
            : undefined
        }
      />
      {closingRecords.dialogs}
    </>
  );
}
