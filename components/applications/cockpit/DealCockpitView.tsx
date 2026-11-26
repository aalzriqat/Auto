import { buildDealRecordPanels } from "./buildDealRecordPanels";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Id } from "@/convex/_generated/dataModel";
import { useLanguage } from "@/components/providers/LanguageProvider";
import { useCurrency } from "@/hooks/useCurrency";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/sonner";
import { formatLocalized } from "@/lib/dateLocale";
import { DealResponsiveStageRail } from "./DealStageRail";
import { buildDealCockpitStageView, stageOwnerLabel } from "./dealCockpitStageView";
import { useDealStageNavigation } from "./useDealStageNavigation";
import { arrangeWorkbenchPanels, type WorkbenchPanel } from "./dealWorkbenchPanels";
import { buildDealStageCards } from "./buildDealStageCards";
import { DealRecordedFeedback } from "./DealRecordedFeedback";
import type { WorkflowAction } from "./DealWorkflowAction";
import type { DealCockpitViewProps } from "./DealCockpitViewProps";
import { nextOutstandingDocument, type RecordedFeedback } from "./recordedFeedback";
import { useSupplierReceiptAction } from "./useSupplierReceiptAction";
import { DealPreRailNotices } from "./DealPreRailNotices";
import { DealQuoteDepositReceipts } from "./DealQuoteDepositReceipts";
import { useDealAdviceCorrection } from "./useDealAdviceCorrection";
import { CancelApplicationDialog } from "./CancelApplicationDialog";
import { UnwindDealDialog } from "./UnwindDealDialog";
import { DealRecordTabs } from "./DealRecordTabs";
import { DealClosingDialogs } from "./DealClosingDialogs";
import { DealTransferConfirmations, DealTransferCorrections } from "./DealTransferDialogs";
import { DealIdentityStrip } from "./DealIdentityStrip";
import { DealCockpitHeader } from "./DealCockpitHeader";
import { DealWorkbenchGrid } from "./DealWorkbenchGrid";
import { useDealMoneyPresentation } from "./useDealMoneyPresentation";
import { useDealFinanceDecision } from "./useDealFinanceDecision";
import { DealMoneyRecord } from "./DealMoneyRecord";
import { isRenderableMoment, renderMoment } from "./dealCockpitDate";

export function DealCockpitView({
  orgId,
  deal,
  stageDeepLink,
  backHref,
  financeDecision,
  workbenchPending = false,
  financingPlan,
  handoverCosts,
  financialOverview,
  custody,
  custodyMoney,
  workflowAction,
  stageCorrection,
  gapResolution,
  handover,
  expectedPayment,
  finalize,
  canCorrectAdvice = false,
  canRegisterPayment = false,
  fcCheque,
  canSettleSupplier: callerMaySettleSupplier = false,
  supplierSettlementHref,
  documentsActionable = true,
  recordedFeedback,
  onCorrectSettlementAdvice,
  onRecordSupplierReceipt,
  activeAppraisalProvider = null,
  depositAwaitingResolution = false,
  depositRequests,
  quoteDepositReceipts,
  creditDecision,
  cancel,
  cancelHint,
  unwind,
  forwardCorrection,
  chequeReturn,
  settlementRoute,
  documents,
  deposits,
  disbursement,
  closingChecklist,
  noCostCloseout,
  renderCommissions,
  dealNumberLabel,
  supplierAdviceDisabled,
}: DealCockpitViewProps & Readonly<{ dealNumberLabel: string | null; supplierAdviceDisabled: boolean }>) {
  const { t, locale } = useLanguage();
  const currency = useCurrency();

  // S7: with no container feedback (a plain view), a step's success is said at once.
  const trackStep: NonNullable<typeof recordedFeedback>["track"] =
    recordedFeedback?.track ??
    (async <T,>(run: () => Promise<T>, fallbackKey: string) => {
      const value = await run();
      toast.success(t(fallbackKey));
      return value;
    });
  // After a document upload or verify, focus goes to the NEXT outstanding
  // document row -- once per recorded step, and only when one is left.
  const recordedStep = recordedFeedback?.recorded ?? null;
  const focusedForRef = useRef<RecordedFeedback | null>(null);
  const nextDocumentRuleId =
    recordedStep?.isDocumentAction && deal
      ? nextOutstandingDocument(deal.documents, recordedStep.documentRuleId)
      : undefined;
  useEffect(() => {
    if (recordedStep === null || nextDocumentRuleId === undefined) return;
    if (focusedForRef.current === recordedStep) return;
    // Matched by attribute value, not a selector string: a rule id is data.
    const row = Array.from(document.querySelectorAll<HTMLElement>("[data-rule-id]")).find(
      (element) => element.getAttribute("data-rule-id") === nextDocumentRuleId
    );
    if (!row) return;
    focusedForRef.current = recordedStep;
    row.focus();
  }, [recordedStep, nextDocumentRuleId]);

  const adviceCorrection = useDealAdviceCorrection(onCorrectSettlementAdvice, t);
  const lowerTabsRef = useRef<HTMLDivElement>(null);
  const documentsTriggerRef = useRef<HTMLButtonElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  // Moving a keyed panel may drop focus without a blur event. Remember it so
  // navigation can restore focus as the live stage changes.
  const flowFocusRef = useRef<HTMLElement | null>(null);
  const stageNavigation = useDealStageNavigation({
    deal,
    stageDeepLink,
    lowerTabsRef,
    documentsTriggerRef,
    flowRef,
    flowFocusRef,
  });
  const { requestedStageKey, requestStage, goToPanel, goToFlowPanel } = stageNavigation;
  const { goTo: goToDocuments } = stageNavigation.documents;
  const hasDocumentsPane = documents !== undefined || (deal?.documents.length ?? 0) > 0;

  const supplierReceiptAction = useSupplierReceiptAction({
    deal,
    orgId,
    callerMaySettleSupplier,
    supplierSettlementHref,
    onRecordSupplierReceipt,
    trackStep,
    t,
  });

  const {
    denominationUnusable,
    dealCurrency,
    factor,
    money,
    discrepancy,
    discrepancyFactor,
    decisionFactor,
    decisionMoney,
    servedMoney,
    adviceRecordedLabel,
    adviceApprovedLabel,
    adviceDifferenceLabel,
  } = useDealMoneyPresentation({
    deal,
    currency,
    locale,
    pinnedDecisionCurrency: financeDecision?.currency,
    t,
  });
  /**
   * What the handover confirmation shows — from the COCKPIT's own payload, not
   * from `getEconomics`.
   *
   * The cockpit only mounts `getEconomics` for `view:finance_applications`. A
   * role holding `confirm:finance_disbursement` without it is entitled to the
   * approved amount, and the legacy Review screen shows it — but here the
   * confirmation rendered blank while the handover still sealed. Both screens
   * now read the same server-side redaction, so the same caller sees the same
   * deal whichever door they open.
   */
  const handoverEvidence =
    deal && "handoverEvidence" in deal ? deal.handoverEvidence : undefined;

  // SCRUM-1018: the deposit dialog, opened by "Deposit receipts" and by the
  // first-payment "paid at the showroom" choice. The choice is offered exactly
  // when that section shows "Record deposit" enabled: a receipt quote, the
  // recording permission (not request-only) and no deposit request waiting.
  const [depositDialogQuoteId, setDepositDialogQuoteId] = useState<Id<"quotes">>();
  const showroomDepositQuoteId = quoteDepositReceipts?.canRecord && !quoteDepositReceipts.hasPendingRequest
    ? quoteDepositReceipts.receiptQuoteId
    : undefined;

  const financeActions = useDealFinanceDecision({
    financeDecision,
    currentEconomicsStamp: deal && "economicsStamp" in deal ? deal.economicsStamp : undefined,
    decisionFactor,
    decisionMoney,
    trackStep,
    t,
    onRecordShowroomPayment: showroomDepositQuoteId ? () => setDepositDialogQuoteId(showroomDepositQuoteId) : undefined,
  });

  if (deal === undefined) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (deal === null) {
    return (
      <Card>
        {/* The query returns null both for a deal that does not exist and for
            one belonging to another org — deliberately indistinguishable, so a
            probe cannot use this screen to discover which ids are real. */}
        <CardContent className="py-10 text-center text-muted-foreground">
          {t("SaleRecordNotFound")}
        </CardContent>
      </Card>
    );
  }

  const stageView = buildDealCockpitStageView({
    deal,
    activeAppraisalProvider,
    requestedStageKey,
    closingReadiness: closingChecklist?.readiness,
    routeRecorded: settlementRoute ? settlementRoute.route !== undefined : undefined,
    workflowAction,
    t,
  });
  const { live, allComplete, railStages, checklistOf, otherStage, routeBlocksClose } = stageView;

  /**
   * The live step's action with any VIEW-owned target resolved to the view's
   * own handler (SCRUM-417) — the same setter the decision card, the
   * documents tab and the money panel use, so the focus row opens THE dialog,
   * not a copy of it. A target the view cannot honour becomes a reason, never
   * a button that does nothing.
   */
  const resolveFocusAction = (action: WorkflowAction): WorkflowAction => {
    if (action.unavailableReasonKey || !action.opens) return action;
    switch (action.opens) {
      case "RECORD_QUOTATION":
      case "RECORD_APPRAISAL":
      case "RECORD_APPROVAL":
        return { ...action, onStart: financeActions.openDialog[action.opens] };
      case "DOCUMENTS":
        return hasDocumentsPane
          ? // Wired in the row to its own `onGoToDocuments`: a handler that
            // reads the tab ref must not be bound while rendering
            // (react-hooks/refs refuses binding it in this render-time call).
            action
          : { ...action, unavailableReasonKey: "DocumentsNeedUploader" };
      case "SETTLE_SUPPLIER":
        return supplierReceiptAction.resolveAction(action);
    }
  };

  const overviewProfit = financialOverview?.data?.financialSummary?.profit;
  const handoverManagementProfit = {
    managementProfitMinor: overviewProfit?.available ? overviewProfit.amountMinor : null,
    managementProfitClassification:
      overviewProfit?.available && overviewProfit.basis === "MANAGEMENT_ESTIMATE"
        ? overviewProfit.classification
        : null,
  };

  // SCRUM-417 UX3 (O1): every panel of the working surface, built ONCE. Which of
  // them the live step works from (the workbench) and which are kept in the
  // collapsed Deal details record is decided below; none is built twice.
  const moneyNode = (
    <DealMoneyRecord
      deal={deal}
      denominationUnusable={denominationUnusable}
      handoverEvidence={handoverEvidence}
      hasHandoverCosts={Boolean(handoverCosts)}
      money={money}
      summaryMoney={servedMoney}
      overview={
        financialOverview && custodyMoney
          ? {
              ...financialOverview,
              // Use the deal's marker for its currency and an explicit code otherwise.
              moneyIn: (minor: number, currency: string) =>
                currency === dealCurrency ? money(minor) : custodyMoney(minor, currency),
              formatDate: (ms: number) => renderMoment(ms, "d MMM yyyy", locale),
            }
          : undefined
      }
      onSettleSupplier={supplierReceiptAction.open}
      supplierGuidance={supplierReceiptAction.guidance}
      renderCommissions={renderCommissions}
      t={t}
    />
  );
  const { vehicleNode, planNode, handoverCostsNode, closingNode, custodyNode, goToCosts } =
    buildDealRecordPanels({
      deal,
      routeBlocksClose,
      settlementRoute,
      financingPlan,
      handoverCosts,
      closingChecklist,
      noCostCloseout,
      custody,
      custodyMoney,
      goToPanel,
      money,
      locale,
      t,
    });
  const documentsNode = (
    <DealRecordTabs
      deal={deal}
      documents={documents}
      hasDocumentsPane={hasDocumentsPane}
      tab={stageNavigation.documents.tab}
      onTabChange={stageNavigation.documents.onChange}
      lowerTabsRef={lowerTabsRef}
      documentsTriggerRef={documentsTriggerRef}
      formatMoment={(moment) =>
        isRenderableMoment(moment) ? formatLocalized(moment, "d MMM yyyy HH:mm", locale) : null
      }
      t={t}
    />
  );
  const panelNodes: Record<WorkbenchPanel, ReactNode> = {
    documents: documentsNode,
    financeDecision: financeActions.panel,
    handoverCosts: handoverCostsNode,
    custody: custodyNode,
    closing: closingNode,
    money: moneyNode,
  };
  const { detailsOpen, workbenchItems, recordItems } = arrangeWorkbenchPanels({
    stageKey: live?.key,
    panels: panelNodes,
    vehicle: vehicleNode,
    plan: planNode,
    workbenchPending,
    detailsChoice: stageNavigation.details.choice,
  });
  const checklistItems = live ? checklistOf(live) : null;
  const { stageViewNode, stepNode } = buildDealStageCards({
    stage: stageView,
    navigation: {
      railOpen: stageNavigation.rail.open,
      requestStage,
      hasDocumentsPane,
      goToDocuments,
      goToFlowPanel,
      goToCosts,
    },
    documents: deal.documents,
    documentsActionable,
    panelNodes,
    liveAction: live && workflowAction?.stageKey === live.key ? resolveFocusAction(workflowAction) : undefined,
    stageCorrection,
    financeDecision,
    financeActions,
    checklistItems,
    settlementRoute,
    activeAppraisalProvider,
    t,
  });

  // The identity strip (SCRUM-372): what kind of deal, which record, and the
  // people on it -- customer, finance company, salesperson. Each cell is absent
  // rather than empty: a cash deal has no finance company.
  // Drawn TWICE, one copy per breakpoint, and never both: `hidden` is display:none,
  // which removes a copy from the tab order and the accessibility tree. The desktop
  // copy sits in the DOM right under the header (where md and up paint it); the
  // phone copy is the last node of the document (where a phone paints it, after
  // the step). So Tab and a screen reader meet it in the order it is drawn, at
  // either width, with no CSS `order` to make the two disagree (SCRUM-417 UX5 R2-2).
  // SCRUM-808: null for a deal the backfill has not reached yet.
  const identity = {
    deal,
    dealNumberLabel,
    createdLabel: renderMoment(deal.createdAt, "d MMM yyyy", locale),
    updatedLabel: renderMoment(deal.updatedAt ?? deal.createdAt, "d MMM yyyy HH:mm", locale),
    t,
  };

  return (
    <div className="flex flex-col gap-6">
      <DealCockpitHeader
        deal={deal}
        dealNumberLabel={dealNumberLabel}
        backHref={backHref}
        ownerLabel={live ? stageOwnerLabel(live, activeAppraisalProvider, t) : undefined}
        updatedLabel={identity.updatedLabel}
        cancel={cancel}
        cancelHint={cancelHint}
        chequeReturn={chequeReturn}
        forwardCorrection={forwardCorrection}
        unwind={unwind}
        t={t}
      />

      <DealIdentityStrip {...identity} placement="desktop" />

      <DealPreRailNotices
        deal={deal}
        advice={deal.settlementAdviceRequiresReconciliation ? {
          figures: discrepancy ? {
            recorded: adviceRecordedLabel,
            approved: adviceApprovedLabel,
            difference: adviceDifferenceLabel,
          } : null,
          onCorrectAdvice: canCorrectAdvice ? adviceCorrection.open : undefined,
          pilotDisabled: supplierAdviceDisabled,
        } : undefined}
        depositRequests={depositRequests}
        depositAwaitingResolution={depositAwaitingResolution}
        deposits={deposits}
        orgId={orgId}
        formatDepositAmount={(amount) => currency.format(amount)}
        fcCheque={fcCheque}
        canCorrectAdvice={canCorrectAdvice}
        canRegisterPayment={canRegisterPayment}
        onRegisterCheque={() => expectedPayment?.onOpenChange(true)}
        t={t}
      />

      {quoteDepositReceipts && (
        <DealQuoteDepositReceipts
          {...quoteDepositReceipts}
          dialogQuoteId={depositDialogQuoteId}
          onDialogQuoteIdChange={setDepositDialogQuoteId}
        />
      )}

      <DealResponsiveStageRail
        stages={railStages}
        liveKey={live?.key ?? null}
        viewedKey={otherStage?.key ?? null}
        allComplete={allComplete}
        showCompleted={stageNavigation.rail.showCompleted}
        railOpen={stageNavigation.rail.open}
        onToggleRail={stageNavigation.rail.toggle}
        onToggleCompleted={stageNavigation.rail.toggleCompleted}
        onSelect={requestStage}
        t={t}
      />

      {/* --- the step, its panel, and the rest of the deal ---------------- */}
      {/* The card carries `deal-next-step`; the live step's own panel follows it
          directly; the rest of the deal sits behind the Deal-details toggle,
          whole. Nothing is removed and nothing is drawn twice. */}
      <DealRecordedFeedback
        recorded={recordedStep !== null}
        checklistItems={checklistItems}
        live={live}
        otherStage={otherStage}
        allComplete={allComplete}
        onDismiss={recordedFeedback?.onDismiss}
        t={t}
      />
      <DealWorkbenchGrid
        stageViewNode={stageViewNode}
        stepNode={stepNode}
        workbenchItems={workbenchItems}
        recordItems={recordItems}
        detailsOpen={detailsOpen}
        onDetailsOpenChange={stageNavigation.details.onChange}
        flowRef={flowRef}
        flowFocusRef={flowFocusRef}
        t={t}
      />

      {/* --- essentials, phone copy ---------------------------------------- */}
      {/* Last in the document: on a phone it is drawn after the step. The copy
          for md and up is right under the header (see `identityStrip`). */}
      <DealIdentityStrip {...identity} placement="phone" />


      {supplierReceiptAction.renderDialog(factor, money)}

      {financeActions.dialogs}

      <DealClosingDialogs
        deal={deal}
        gapResolution={gapResolution}
        handover={handover}
        expectedPayment={expectedPayment}
        finalize={finalize}
        creditDecision={creditDecision}
        handoverEvidence={handoverEvidence}
        handoverManagementProfit={handoverManagementProfit}
        factor={factor}
        money={money}
        t={t}
      />

      <DealTransferCorrections
        forwardCorrection={forwardCorrection}
        chequeReturn={chequeReturn}
        t={t}
      />
      {unwind?.offered && orgId && (
        <UnwindDealDialog
          orgId={orgId}
          open={unwind.open}
          status={unwind.status}
          submitting={unwind.submitting}
          error={unwind.error}
          formatMinor={unwind.formatMinor}
          notBefore={unwind.notBefore}
          t={t}
          onOpenChange={unwind.onOpenChange}
          onStart={unwind.onStart}
          onForwardReturn={unwind.onForwardReturn}
          onFinish={unwind.onFinish}
          onAbandon={unwind.onAbandon}
        />
      )}
      {cancel && (
        <CancelApplicationDialog
          open={cancel.confirming}
          submitting={cancel.submitting}
          error={cancel.error}
          isClosed={cancel.isClosed}
          t={t}
          onOpenChange={cancel.onOpenChange}
          onSubmit={cancel.onSubmit}
        />
      )}

      <DealTransferConfirmations disbursement={disbursement} t={t} />

      {adviceCorrection.renderDialog(
        { discrepancy, discrepancyFactor, adviceRecordedLabel, adviceApprovedLabel },
        Boolean(discrepancy && canCorrectAdvice && !supplierAdviceDisabled),
      )}
    </div>
  );
}
