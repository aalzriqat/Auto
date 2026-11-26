import { useState } from "react";
import { toast } from "@/components/ui/sonner";
import { getErrorMessage, getLocalizedErrorMessage } from "@/lib/errors";
import type { DealCockpitViewProps, FinanceDecisionWiring } from "./DealCockpitViewProps";
import { FinanceCompanyDecisionCard, type FinanceDecisionDialog } from "./FinanceCompanyDecisionCard";
import { CustomerFinanceCompanyPaymentCard } from "./CustomerFinanceCompanyPaymentCard";
import { FirstPaymentEvidenceCard, QuoteFirstPaymentNotice } from "./FirstPaymentEvidenceCard";
import { RecordSubmittedQuotationDialog } from "./RecordSubmittedQuotationDialog";
import { RecordAppraisalDialog, type AppraisalProviderType } from "./RecordAppraisalDialog";
import { RecordApprovedPurchaseDialog, type ApprovalSubmission, type DeliveredApprovalCorrection } from "./RecordApprovedPurchaseDialog";
import { ReopenApprovedPurchaseDialog } from "./ReopenApprovedPurchaseDialog";
import { ApplyQuoteFirstPaymentDialog } from "./ApplyQuoteFirstPaymentDialog";
import { approvalReopenedReflected, approvedPurchaseReflected, quotationReflected } from "./recordedFeedback";

/** Owns finance-decision dialogs shared by the decision card and the stage actions. */
export function useDealFinanceDecision({
  financeDecision,
  currentEconomicsStamp,
  decisionFactor,
  decisionMoney,
  trackStep,
  t,
  onRecordShowroomPayment,
}: Readonly<{
  financeDecision?: FinanceDecisionWiring;
  currentEconomicsStamp?: string;
  decisionFactor: number;
  decisionMoney: (minor: number) => string;
  trackStep: NonNullable<DealCockpitViewProps["recordedFeedback"]>["track"];
  t: (key: string) => string;
  /** SCRUM-1018: opens the deal's deposit dialog; absent when "Record deposit" is not offered. */
  onRecordShowroomPayment?: () => void;
}>) {
  const [recordingQuotation, setRecordingQuotation] = useState(false);
  const [quotationEconomicsStamp, setQuotationEconomicsStamp] = useState<string>();
  const [recordingApproval, setRecordingApproval] = useState(false);
  const [approvalEconomicsStamp, setApprovalEconomicsStamp] = useState<string>();
  const [deliveredApproval, setDeliveredApproval] = useState<DeliveredApprovalCorrection | null>(null);
  const [approvalCorrection, setApprovalCorrection] = useState<{
    next: "approval" | "quotation";
    economicsStamp?: string;
  } | null>(null);
  const [recordingAppraisal, setRecordingAppraisal] = useState(false);
  const [appraisalEconomicsStamp, setAppraisalEconomicsStamp] = useState<string>();
  const [appraisalSubmitting, setAppraisalSubmitting] = useState(false);
  const [appraisalError, setAppraisalError] = useState<string | null>(null);
  // One flag per dialog. A single shared one made an in-flight quotation write
  // render the approval dialog's button as busy too, which reads as the wrong
  // action having been taken.
  const [quotationSubmitting, setQuotationSubmitting] = useState(false);
  const [approvalSubmitting, setApprovalSubmitting] = useState(false);
  // One error per dialog, not one shared: a refusal from the quotation write
  // must not still be sitting in the approval form the next time it opens.
  const [quotationError, setQuotationError] = useState<string | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [reopenSubmitting, setReopenSubmitting] = useState(false);
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [applyingFirstPayment, setApplyingFirstPayment] = useState(false);
  const [firstPaymentSubmitting, setFirstPaymentSubmitting] = useState(false);
  const [firstPaymentError, setFirstPaymentError] = useState<string | null>(null);

  // The ONE opener per finance-decision dialog, shared by the decision card and
  // the focus row (SCRUM-417): both clear the dialog's last refusal and open
  // the same dialog, so the two entry points cannot drift apart.
  const openQuotationForm = (stamp: string | undefined) => {
    setQuotationError(null);
    setQuotationEconomicsStamp(stamp);
    setRecordingQuotation(true);
  };
  const openRecordQuotation = () => openQuotationForm(currentEconomicsStamp);
  const openRecordAppraisal = () => {
    setAppraisalError(null);
    setAppraisalEconomicsStamp(currentEconomicsStamp);
    setRecordingAppraisal(true);
  };
  const openApprovalForm = (stamp: string | undefined) => {
    setApprovalError(null);
    setDeliveredApproval(null);
    setApprovalEconomicsStamp(stamp);
    setRecordingApproval(true);
  };
  const openRecordApproval = () => openApprovalForm(currentEconomicsStamp);
  const openDeliveredApprovalCorrection = () => {
    const correction = financeDecision?.deliveredApprovalCorrection;
    if (!correction) return;
    setApprovalError(null);
    setApprovalEconomicsStamp(undefined);
    setDeliveredApproval(correction);
    setRecordingApproval(true);
  };
  const openApprovalCorrection = (next: "approval" | "quotation") => {
    setReopenError(null);
    setApprovalCorrection({ next, economicsStamp: currentEconomicsStamp });
  };
  const openReopenApproval = () => openApprovalCorrection("approval");
  const openQuotationCorrection = () => {
    if (financeDecision?.facts.approvedPurchaseRecorded) openApprovalCorrection("quotation");
    else openRecordQuotation();
  };
  const openFinanceDecisionDialog: Record<FinanceDecisionDialog, () => void> = {
    RECORD_QUOTATION: openRecordQuotation,
    RECORD_APPRAISAL: openRecordAppraisal,
    RECORD_APPROVAL: openRecordApproval,
  };

  function openFirstPaymentCorrection() {
    setFirstPaymentError(null);
    setApplyingFirstPayment(true);
  }

  /**
   * Both recorders share one shape: submit, and on refusal keep the dialog open
   * with the server's own words in it.
   *
   * The refusals here are the whole point — "record the quotation before
   * recording what it approved", "you cannot approve your own application", "the
   * calculator produced 12,500, not 13,000". Replacing them with a generic
   * message would leave an operator holding a document they cannot enter, which
   * is the dead end this screen was built to end.
   */
  const handleRecordQuotation = async (values: {
    submittedQuotationMinor: number;
    source: "SYSTEM_CALCULATED" | "MANUAL_ENTRY" | "CALCULATED_WITH_OVERRIDE";
    overrideReason?: string;
    ltvPercent?: number;
  }) => {
    if (!financeDecision) return;
    setQuotationSubmitting(true);
    setQuotationError(null);
    try {
      await trackStep(() => financeDecision.onRecordQuotation({
        ...values, expectedEconomicsStamp: quotationEconomicsStamp,
      }), "QuotationRecorded", {
        reflectedWhen: quotationReflected(values.submittedQuotationMinor, values.source),
      });
      setRecordingQuotation(false);
    } catch (error) {
      const message = getLocalizedErrorMessage(error, t);
      setQuotationError(message);
      toast.error(message);
    } finally {
      setQuotationSubmitting(false);
    }
  };

  const handleRecordAppraisal = async (values: {
    appraisalAmountMinor: number;
    providerType: AppraisalProviderType;
    providerName?: string;
    appraisedAt: number;
    reappraisalReason?: string;
  }) => {
    if (!financeDecision) return;
    setAppraisalSubmitting(true);
    setAppraisalError(null);
    try {
      await trackStep(() => financeDecision.onRecordAppraisal({
        ...values, expectedEconomicsStamp: appraisalEconomicsStamp,
      }), "AppraisalRecorded");
      setRecordingAppraisal(false);
    } catch (error) {
      const message = getLocalizedErrorMessage(error, t);
      setAppraisalError(message);
      toast.error(message);
    } finally {
      setAppraisalSubmitting(false);
    }
  };

  const handleRecordApproved = async (values: ApprovalSubmission) => {
    if (!financeDecision) return;
    setApprovalSubmitting(true);
    setApprovalError(null);
    try {
      await trackStep(() => financeDecision.onRecordApproved(values, approvalEconomicsStamp), "ApprovedPurchaseRecorded", {
        reflectedWhen: approvedPurchaseReflected(values.approvedAmountMinor, values.basis),
      });
      setRecordingApproval(false);
      setDeliveredApproval(null);
    } catch (error) {
      const message = getLocalizedErrorMessage(error, t);
      setApprovalError(message);
      toast.error(message);
    } finally {
      setApprovalSubmitting(false);
    }
  };

  const handleApplyQuoteFirstPayment = async (values: { reason: string; economicsStamp: string }) => {
    const correction = financeDecision?.firstPaymentCorrection;
    if (!correction) return;
    setFirstPaymentSubmitting(true);
    setFirstPaymentError(null);
    try {
      await trackStep(
        () => correction.onApply(values),
        "ApplyQuoteFirstPaymentApplied"
      );
      setApplyingFirstPayment(false);
    } catch (error) {
      const message = getErrorMessage(error);
      setFirstPaymentError(message);
      toast.error(message);
    } finally {
      setFirstPaymentSubmitting(false);
    }
  };

  const handleReopenApproved = async (values: { reason: string }) => {
    if (!financeDecision || !approvalCorrection) return;
    setReopenSubmitting(true);
    setReopenError(null);
    try {
      const stamp = await trackStep(() => financeDecision.onReopenApproved({
        reason: values.reason, economicsStamp: approvalCorrection.economicsStamp,
      }), "ApprovedPurchaseReopened", {
        reflectedWhen: approvalReopenedReflected,
      });
      setApprovalCorrection(null);
      if (typeof stamp !== "string") return;
      if (approvalCorrection.next === "quotation") openQuotationForm(stamp);
      else openApprovalForm(stamp);
    } catch (error) {
      const message = getLocalizedErrorMessage(error, t);
      setReopenError(message);
      toast.error(message);
    } finally {
      setReopenSubmitting(false);
    }
  };

  const panel = financeDecision ? (
    <>
        <FinanceCompanyDecisionCard
          facts={financeDecision.facts}
          canRecordQuotation={financeDecision.canRecordQuotation}
          canRecordApproval={financeDecision.canRecordApproval}
          canEstablishLtvPercent={financeDecision.canEstablishLtvPercent}
          canRecordAppraisal={financeDecision.canRecordAppraisal}
          isOwnDeal={financeDecision.isOwnDeal}
          money={decisionMoney}
          t={t}
          onRecordQuotation={openRecordQuotation}
          onRecordAppraisal={openRecordAppraisal}
          onRecordApproved={openRecordApproval}
          onCorrectApproved={openReopenApproval}
        />
      {financeDecision.customerPayment && (
        <CustomerFinanceCompanyPaymentCard
          key={JSON.stringify(financeDecision.firstPaymentEvidence)}
          {...financeDecision.customerPayment}
          factor={decisionFactor}
          money={decisionMoney}
          t={t}
        />
      )}
      {financeDecision.firstPaymentEvidence && (
        <FirstPaymentEvidenceCard {...financeDecision.firstPaymentEvidence} factor={decisionFactor} money={decisionMoney} t={t}
          onRecordShowroomPayment={onRecordShowroomPayment} />
      )}
      {financeDecision.firstPaymentCorrection && (
        <QuoteFirstPaymentNotice amount={financeDecision.firstPaymentCorrection.quoteDownPaymentMinor} money={decisionMoney} t={t} onApply={openFirstPaymentCorrection} />
      )}
    </>
  ) : null;

  const dialogs = financeDecision && (
    <>
      <RecordSubmittedQuotationDialog
        open={recordingQuotation}
        submitting={quotationSubmitting}
        error={quotationError}
        calculation={financeDecision.calculation}
        requiresLtvPercent={financeDecision.facts.ltvMissing}
        // The permission the SERVER checks for the rate — deliberately not
        // `canRecordQuotation`, which the SALES template also holds.
        canSetLtvPercent={financeDecision.canEstablishLtvPercent}
        factor={decisionFactor}
        money={decisionMoney}
        t={t}
        onOpenChange={setRecordingQuotation}
        onSubmit={handleRecordQuotation}
      />
      <RecordAppraisalDialog
        open={recordingAppraisal}
        submitting={appraisalSubmitting}
        error={appraisalError}
        existingAppraisalMinor={financeDecision.facts.appraisalAmountMinor}
        approvalWouldBeReopened={financeDecision.facts.approvedPurchaseRecorded}
        factor={decisionFactor}
        money={decisionMoney}
        t={t}
        onOpenChange={setRecordingAppraisal}
        onSubmit={handleRecordAppraisal}
      />
      <RecordApprovedPurchaseDialog
        open={recordingApproval}
        submitting={approvalSubmitting}
        error={approvalError}
        deliveredApproval={deliveredApproval}
        appraisal={financeDecision.appraisal}
        submittedQuotationMinor={financeDecision.facts.submittedQuotationMinor}
        appliedLtvPercent={financeDecision.facts.appliedLtvPercent}
        factor={decisionFactor}
        money={decisionMoney}
        t={t}
        onOpenChange={(open) => {
          setRecordingApproval(open);
          if (!open) setDeliveredApproval(null);
        }}
        onSubmit={handleRecordApproved}
      />
      <ReopenApprovedPurchaseDialog
        open={approvalCorrection !== null}
        forQuotation={approvalCorrection?.next === "quotation"}
        submitting={reopenSubmitting}
        error={reopenError}
        currentAmountMinor={financeDecision.facts.approvedPurchaseAmountMinor}
        money={decisionMoney}
        t={t}
        onOpenChange={(open) => { if (!open) setApprovalCorrection(null); }}
        onSubmit={handleReopenApproved}
      />
      {financeDecision.firstPaymentCorrection && (
        <ApplyQuoteFirstPaymentDialog
          open={applyingFirstPayment}
          submitting={firstPaymentSubmitting}
          error={firstPaymentError}
          quoteDownPaymentMinor={financeDecision.firstPaymentCorrection.quoteDownPaymentMinor}
          economicsStamp={financeDecision.firstPaymentCorrection.economicsStamp}
          money={decisionMoney}
          t={t}
          onOpenChange={setApplyingFirstPayment}
          onSubmit={handleApplyQuoteFirstPayment}
        />
      )}
    </>
  );

  return {
    panel,
    dialogs,
    openDialog: openFinanceDecisionDialog,
    openRecordAppraisal,
    openQuotationCorrection,
    openReopenApproval,
    openDeliveredApprovalCorrection,
  };
}
