import { ResolveGapDialog } from "./ResolveGapDialog";
import { ConfirmHandoverDialog, type HandoverEvidence } from "./ConfirmHandoverDialog";
import { ConfirmFinalizeDialog } from "./ConfirmFinalizeDialog";
import { RegisterExpectedPaymentDialog } from "../RegisterExpectedPaymentDialog";
import { CreditDecisionDialog } from "./CreditDecisionDialog";
import type { DealCockpitViewProps } from "./DealCockpitViewProps";
import type { DealCockpitData } from "./DealStagePresentation";

export function DealClosingDialogs({
  deal,
  gapResolution,
  handover,
  expectedPayment,
  finalize,
  creditDecision,
  handoverEvidence,
  handoverManagementProfit,
  factor,
  money,
  t,
}: Pick<DealCockpitViewProps, "gapResolution" | "handover" | "expectedPayment" | "finalize" | "creditDecision"> &
  Readonly<{
    deal: DealCockpitData;
    handoverEvidence: HandoverEvidence | null | undefined;
    handoverManagementProfit: Pick<HandoverEvidence, "managementProfitMinor" | "managementProfitClassification">;
    factor: number;
    money: (minor: number) => string;
    t: (key: string) => string;
  }>) {
  return (
    <>
    {/* Only for a deal that actually has a shortfall the caller can see. The
        gap comes from the server's own money block — this screen never
        derives it, because a locally computed gap could disagree with the one
        the mutation reconciles against and reject the operator's arithmetic
        for being right. */}
    {gapResolution && typeof deal?.money?.shortfall?.totalMinor === "number" && (
      <ResolveGapDialog
        open={gapResolution.resolving}
        submitting={gapResolution.submitting}
        shortfallMinor={deal.money.shortfall.totalMinor}
        breakdown={
          deal.money.shortfall.method === "NET" &&
          typeof deal.money.shortfall.valuationMinor === "number" &&
          typeof deal.money.shortfall.termsMinor === "number"
            ? {
                valuationMinor: deal.money.shortfall.valuationMinor,
                termsMinor: deal.money.shortfall.termsMinor,
              }
            : null
        }
        grossLabel={deal.money.shortfall.method !== "NET"}
        allowFinanceCompany={deal.money.shortfall.method !== "GROSS_MANUAL"}
        submittedQuotationMinor={gapResolution.submittedQuotationMinor}
        approvedPurchaseAmountMinor={gapResolution.approvedPurchaseAmountMinor}
        supplierBasis={gapResolution.supplierBasis}
        economicsStamp={"economicsStamp" in deal ? deal.economicsStamp : undefined}
        factor={factor}
        money={money}
        t={t}
        onOpenChange={gapResolution.onOpenChange}
        onSubmit={gapResolution.onSubmit}
      />
    )}

    {handover && (
      <ConfirmHandoverDialog
        open={handover.confirming}
        submitting={handover.submitting}
        // Read from the SAME facts the decision card renders, so the figures
        // the dialog asks the operator to verify are the ones they have been
        // looking at — not a second derivation that could disagree.
        // The server's one answer, handed over whole. This screen forms no
        // opinion about the figures, the anomaly verdict, or how any of it is
        // denominated — the legacy Review screen consumes the same object.
        evidence={
          handoverEvidence
            ? { ...handoverEvidence, ...handoverManagementProfit }
            : {
                approvedPurchaseAmountMinor: null,
                financeCompanyFundedPortionMinor: null,
                dealerContributionMinor: null,
                approvedAmountIsFarFromEvidence: false,
                currency: null,
                ...handoverManagementProfit,
              }
        }
        // `deal` is a union — the cash variant comes from `sales.dealCockpit`
        // and carries no stamp, because nothing on that path seals financing
        // economics. Narrowed by presence rather than by `dealKind` so a
        // future payload that stops issuing one fails here, at the point that
        // needs it, instead of silently sending `undefined` to the mutation.
        economicsStamp={deal && "economicsStamp" in deal ? deal.economicsStamp : undefined}
        t={t}
        onOpenChange={handover.onOpenChange}
        onSubmit={handover.onSubmit}
      />
    )}

    {/* The form itself is the review dialog's, reused rather than rebuilt:
        one shape for the cheque fields, one schema, one set of rules about
        what a cheque needs. Only its opener differs — here the next-step
        block owns that, so the dialog renders without its own trigger. */}
    {expectedPayment && (
      <RegisterExpectedPaymentDialog
        open={expectedPayment.registering}
        withTrigger={false}
        disabled={expectedPayment.submitting}
        submitting={expectedPayment.submitting}
        error={expectedPayment.error}
        t={t}
        onOpenChange={expectedPayment.onOpenChange}
        onConfirm={expectedPayment.onSubmit}
      />
    )}

    {finalize && (
      <ConfirmFinalizeDialog
        open={finalize.confirming}
        submitting={finalize.submitting}
        error={finalize.error}
        t={t}
        onOpenChange={finalize.onOpenChange}
        onSubmit={finalize.onSubmit}
        profitApproval={finalize.profitApproval}
        readinessHold={finalize.readinessHold}
      />
    )}

    {creditDecision && (
      <CreditDecisionDialog
        open={creditDecision.deciding}
        submitting={creditDecision.submitting}
        error={creditDecision.error}
        canApprove={creditDecision.canApprove}
        canReject={creditDecision.canReject}
        isOwnDeal={creditDecision.isOwnDeal}
        documentsIncomplete={creditDecision.documentsIncomplete}
        t={t}
        onOpenChange={creditDecision.onOpenChange}
        onSubmit={creditDecision.onSubmit}
      />
    )}
    </>
  );
}
