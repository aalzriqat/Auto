import { useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { CommandIdentity } from "@/hooks/useCommandIdentity";
import { toast } from "@/components/ui/sonner";
import { getErrorMessage, isConvexError } from "@/lib/errors";
import type { FinanceDecisionFacts } from "./FinanceCompanyDecisionCard";
import type { AppraisalProviderType } from "./RecordAppraisalDialog";
import type { ApprovalSubmission } from "./RecordApprovedPurchaseDialog";
import { toQuotationCalculation } from "./RecordSubmittedQuotationDialog";

export function useFinancedDealDecision({
  orgId,
  applicationId,
  deal,
  operatorId,
  canViewApplications,
  permissionsLoading,
  access,
  commandId,
  t,
}: Readonly<{
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  deal:
    | FunctionReturnType<typeof api.dealWorkspace.financedDealCockpit>
    | undefined;
  operatorId?: Id<"users">;
  canViewApplications: boolean;
  permissionsLoading: boolean;
  access: Readonly<{
    viewFinance: boolean;
    viewCostPrice: boolean;
    createApplication: boolean;
    approveApplication: boolean;
    reviewApplication: boolean;
    confirmDisbursement: boolean;
  }>;
  commandId: CommandIdentity;
  t: (key: string) => string;
}>) {
  const recordSubmittedQuotation = useMutation(
    api.financingEconomics.recordSubmittedQuotation,
  );
  const reopenApproval = useMutation(api.financingEconomics.reopenApproval);
  const applyQuoteFirstPayment = useMutation(
    api.financingEconomics.applyQuoteFirstPayment,
  );
  const approveDealerPurchaseAmount = useMutation(
    api.financingEconomics.approveDealerPurchaseAmount,
  );
  const recordAppraisal = useMutation(api.financingEconomics.recordAppraisal);

  /**
   * The economics read, and why it is a SEPARATE query from the cockpit's.
   *
   * `applications.dealCockpit` gates its whole money block behind `view:finance`,
   * which the default MANAGER template does not hold — and MANAGER is precisely
   * the role holding `approve:finance_application`. Reading these figures out of
   * the money block would therefore have hidden the recorder from the only role
   * allowed to use it. `getEconomics` authorizes on `view:finance_applications`,
   * applies its own redaction, and is the query that already owns these fields,
   * so nothing here becomes a second source of truth for them.
   *
   * Skipped rather than called-and-caught when the caller lacks that permission
   * or the deal is not readable: `getEconomics` THROWS for an application it
   * will not serve, and an uncaught throw from `useQuery` during render loses
   * the whole screen — a caller with `view:sales` on a custom role would have
   * white-screened the cockpit instead of merely not seeing this card.
   */
  const economics = useQuery(
    api.financingEconomics.getEconomics,
    canViewApplications && deal ? { orgId, applicationId } : "skip",
  );
  const economicsApp = economics?.application ?? null;
  /**
   * The supplier concession basis (SCRUM-766 PR-C), asked for ONLY when there is
   * a shortfall the caller can see and the caller holds both permissions the
   * query demands: it THROWS for anyone else, and an uncaught throw from
   * `useQuery` during render would white-screen the cockpit. `eligible: false`
   * (stock car, several vehicles, no supplier on record) maps to no field.
   */
  const supplierConcessionBasis = useQuery(
    api.financingEconomics.supplierConcessionBasis,
    canViewApplications &&
      !permissionsLoading &&
      access.viewFinance &&
      access.viewCostPrice &&
      deal &&
      typeof deal.money?.shortfall?.totalMinor === "number"
      ? { orgId, applicationId }
      : "skip",
  );
  // Stable identity: the dialog lists this in an effect's dependencies.
  const concessionEntitlementMinor = supplierConcessionBasis?.eligible
    ? supplierConcessionBasis.entitlementMinor
    : null;
  const concessionCurrency = supplierConcessionBasis?.eligible
    ? supplierConcessionBasis.currency
    : null;
  const concessionSupplierName = supplierConcessionBasis?.eligible
    ? supplierConcessionBasis.supplierName
    : null;
  const concessionSupplierId = supplierConcessionBasis?.eligible
    ? supplierConcessionBasis.supplierId
    : null;
  const supplierBasis = useMemo(
    () =>
      concessionEntitlementMinor !== null &&
      concessionCurrency !== null &&
      concessionSupplierName !== null &&
      concessionSupplierId !== null
        ? {
            entitlementMinor: concessionEntitlementMinor,
            currency: concessionCurrency,
            supplierName: concessionSupplierName,
            supplierId: concessionSupplierId,
          }
        : null,
    [
      concessionEntitlementMinor,
      concessionCurrency,
      concessionSupplierName,
      concessionSupplierId,
    ],
  );

  /**
   * The calculator, mounted wherever the quotation action can actually be
   * offered — which includes RE-recording one that already exists.
   *
   * Not narrowed to "no quotation yet". A re-record with the calculator absent
   * is labelled `MANUAL_ENTRY` whatever the operator types, so skipping the
   * query on the second visit would quietly downgrade the provenance of a
   * figure the solver could have confirmed.
   *
   * Still skipped for a caller who cannot record and for a deal nobody can
   * change: it is a real query with real reads, and running it for every role
   * on every view would be paying for a suggestion nobody was going to see.
   */
  /**
   * Whether the approved amount is on the record — from the STAGE RAIL, which
   * the server derives from the unredacted row.
   *
   * Read here as well as in the card, and for the same reason: the amount field
   * is blank both when nothing was recorded and when this caller may not see
   * it, so testing the field would have mounted the calculator for a
   * salesperson on a deal that is already approved.
   */
  const approvedPurchaseRecorded =
    deal?.stages.find((stage) => stage.key === "APPROVED_PURCHASE")?.state ===
    "COMPLETE";

  const canOfferQuotation =
    economicsApp !== null &&
    economicsApp.status !== "CLOSED" &&
    economicsApp.status !== "CANCELLED" &&
    // Once an approval exists the server refuses to move the figure it was
    // based on, so the action is not offered and the calculator is not needed.
    !approvedPurchaseRecorded &&
    access.createApplication;

  /**
   * The company's purchase LTV is KNOWN to be missing — as opposed to merely
   * unknown here.
   *
   * `recordSubmittedQuotation` throws without one, so the action is certain to
   * be refused and the card says which setting to fix instead of offering it.
   * A legacy application carries no rule snapshot at all and the server falls
   * back to the live company row for those, so "no snapshot" must not be read
   * as "no LTV" and block an action that would have worked.
   *
   * This is about the MUTATION. The query no longer throws for it — see
   * `suggestQuotationForApplication`, which now reports an unresolvable rule as
   * an unavailable calculation, because a Convex throw reaching `useQuery`
   * during render loses the whole screen. That is how this was found: rendering
   * against a company created through the settings form, which never asked for
   * the field.
   */
  /**
   * ASKED, not derived (SCRUM-117).
   *
   * This read `companyRuleSnapshot` and `appliedLtvPercent` off the economics
   * row and compared them here. Both are finance-gated now, so a caller without
   * `view:finance` computed "the rate is present" from two blanks and was shown
   * no rate field and no guidance — then the server refused the quotation. The
   * server answers the question it already owns and publishes a boolean that
   * names no rate; the screen stops holding a second opinion.
   */
  const ltvMissing = economics?.requiresLtvPercent === true;
  const suggestion = useQuery(
    api.financingEconomics.suggestQuotationForApplication,
    canOfferQuotation ? { orgId, applicationId } : "skip",
  );

  // SCRUM-766 PR-B: the evidence list is read for every deal a caller the server would let read it
  // can see, NOT only while an agreement is held: a payment confirmed against an earlier agreement
  // (reopen / reapproval to a zero-to-finance-company split) must stay visible and correctable.
  const agreedToFinanceCompanyMinor =
    economicsApp?.customerGapToFinanceCompanyMinor ?? 0;
  const customerPayments = useQuery(
    api.customerFinanceCompanyPayments.listPayments,
    economicsApp !== null && !permissionsLoading && access.viewFinance
      ? { orgId, applicationId }
      : "skip",
  );
  const confirmCustomerFinanceCompanyPayment = useMutation(
    api.customerFinanceCompanyPayments.confirmPayment,
  );
  const voidCustomerFinanceCompanyPayment = useMutation(
    api.customerFinanceCompanyPayments.voidPayment,
  );

  /**
   * The appraisal an approval may actually be based on.
   *
   * The same filter `approveDealerPurchaseAmount` applies when no appraisal is
   * named explicitly: a SUPERSEDED or REJECTED one has been replaced by the
   * finance company and a DEALER_ESTIMATE is the dealership's own opinion, so
   * offering either would put an option on the screen the server exists to
   * refuse.
   */
  const usableAppraisal =
    economics?.appraisals
      .filter(
        (row) =>
          (row.status === "RECORDED" || row.status === "APPROVED") &&
          row.providerType !== "DEALER_ESTIMATE",
      )
      .sort((a, b) => b.appraisedAt - a.appraisedAt)[0] ?? null;

  const purchaseStage = deal?.stages.find(
    (stage) => stage.key === "APPROVED_PURCHASE",
  );
  const financeDecision =
    deal && economicsApp
      ? {
          facts: {
            // A gap blocker still means the server has a recorded approval.
            // The amount can be withheld from this role.
            approvedPurchaseRecorded:
              purchaseStage?.state === "COMPLETE" ||
              purchaseStage?.blocker === "GapUnresolved" ||
              purchaseStage?.blocker === "GapNegotiationFailed",
            submittedQuotationMinor:
              economicsApp.submittedQuotationMinor ?? null,
            approvedPurchaseAmountMinor:
              economicsApp.approvedDealerPurchaseAmountMinor ?? null,
            financeCompanyFundedPortionMinor:
              economicsApp.financeCompanyFundedPortionMinor ?? null,
            unfinancedPortionMinor: economicsApp.unfinancedPortionMinor ?? null,
            approvedFinancingAmountMinor: economicsApp.approvedFinancingAmountMinor ?? null,
            approvalExcessMinor: economicsApp.approvalExcessMinor ?? null,
            customerFirstPaymentMinor: economicsApp.customerFirstPaymentMinor ?? null,
            dealerContributionMinor:
              economicsApp.dealerContributionMinor ?? null,
            customerGapToFinanceCompanyAppliedMinor:
              economicsApp.customerGapToFinanceCompanyAppliedMinor ?? null,
            appliedLtvPercent: economicsApp.appliedLtvPercent ?? null,
            closed:
              economicsApp.status === "CLOSED" ||
              economicsApp.status === "CANCELLED" ||
              economicsApp.status === "REJECTED" ||
              economicsApp.finalizedSaleId !== undefined,
            ltvMissing,
            // From the stage rail, like the approval fact above it: once the
            // vehicle has gone out `recordAppraisal` refuses rather than
            // superseding, so the action is withdrawn instead of promising
            // something the server will decline.
            handedOver:
              deal.stages.find((stage) => stage.key === "HANDOVER")?.state ===
              "COMPLETE",
            // The same live appraisal the approval bases are offered against,
            // so the row and those options can never disagree about whether one
            // exists.
            appraisalAmountMinor: usableAppraisal?.appraisalAmountMinor ?? null,
          } satisfies FinanceDecisionFacts,
          currency: economicsApp.economicsCurrency ?? null,
          canRecordQuotation: access.createApplication,
          canRecordApproval: access.approveApplication,
          // SCRUM-117: explicit LTV entry requires approval and finance visibility to protect hidden inputs.
          // Managers can still approve a purchase amount at an established rate.
          canEstablishLtvPercent:
            access.approveApplication && access.viewFinance,
          approvedAmountIsFarFromEvidence:
            economics?.approvedAmountIsFarFromEvidence ?? false,
          // What `recordAppraisal` itself requires for a finance-company or
          // independent appraisal. The dealer-estimate branch takes a different
          // permission and is not offered here.
          canRecordAppraisal: access.reviewApplication,
          // The server refuses the application's own salesperson outright. Said
          // here so it reads as a rule rather than as a failure.
          isOwnDeal: operatorId === economicsApp.salespersonId,
          // Three states, never two. "Still loading" collapsed into "no
          // calculation exists" would let the dialog label a figure
          // MANUAL_ENTRY — a claim about provenance — during the window before
          // the suggestion arrives.
          calculation: toQuotationCalculation(canOfferQuotation, suggestion),
          appraisal: usableAppraisal
            ? {
                id: usableAppraisal._id as string,
                amountMinor: usableAppraisal.appraisalAmountMinor,
              }
            : null,
          onRecordAppraisal: async (values: {
            appraisalAmountMinor: number;
            providerType: AppraisalProviderType;
            providerName?: string;
            appraisedAt: number;
            reappraisalReason?: string;
            expectedEconomicsStamp?: string;
          }) => {
            await recordAppraisal({
              orgId,
              applicationId,
              ...values,
              expectedEconomicsStamp: values.expectedEconomicsStamp,
            });
          },
          onRecordQuotation: async (values: {
            submittedQuotationMinor: number;
            source:
              | "SYSTEM_CALCULATED"
              | "MANUAL_ENTRY"
              | "CALCULATED_WITH_OVERRIDE";
            overrideReason?: string;
            ltvPercent?: number;
            expectedEconomicsStamp?: string;
          }) => {
            await recordSubmittedQuotation({
              orgId,
              applicationId,
              ...values,
              expectedEconomicsStamp: values.expectedEconomicsStamp,
            });
          },
          deliveredApprovalCorrection: economics?.deliveredApprovalCorrection,
          onRecordApproved: async (
            values: ApprovalSubmission,
            expectedEconomicsStamp?: string,
          ) => {
            await approveDealerPurchaseAmount({
              orgId,
              applicationId,
              approvedAmountMinor: values.approvedAmountMinor,
              approvedFinancingAmountMinor: values.approvedFinancingAmountMinor,
              basis: values.basis,
              appraisalId: values.appraisalId as
                | Id<"financeAppraisals">
                | undefined,
              notes: values.notes,
              outlierAcknowledged: values.outlierAcknowledged,
              deliveredDealCorrection: values.deliveredDealCorrection,
              expectedEconomicsStamp,
            });
          },
          onReopenApproved: async (values: {
            reason: string;
            economicsStamp?: string;
          }) => {
            const result = await reopenApproval({
              orgId,
              applicationId,
              reason: values.reason,
              economicsStamp: values.economicsStamp,
            });
            if (typeof result === "object" && result !== null)
              return result.economicsStamp;
          },
          // SCRUM-373 D2: offered only on the server's own verdict.
          firstPaymentCorrection:
            deal.firstPaymentCorrection?.block === null &&
            deal.firstPaymentCorrection.quoteDownPaymentMinor !== null
              ? {
                  quoteDownPaymentMinor:
                    deal.firstPaymentCorrection.quoteDownPaymentMinor,
                  economicsStamp: deal.economicsStamp,
                  onApply: async (values: { reason: string; economicsStamp: string }) => {
                    await applyQuoteFirstPayment({
                      orgId,
                      applicationId,
                      economicsStamp: values.economicsStamp,
                      reason: values.reason,
                    });
                  },
                }
              : null,
          firstPaymentEvidence: access.viewFinance
            ? { orgId, applicationId }
            : undefined,
          customerPayment:
            agreedToFinanceCompanyMinor > 0 ||
            (customerPayments ?? []).length > 0
              ? {
                  agreedMinor: agreedToFinanceCompanyMinor,
                  confirmedMinor:
                    economicsApp.customerGapToFinanceCompanyAppliedMinor ?? 0,
                  // The server's one stored balance; absent with an agreement held means nothing is confirmed yet.
                  awaitingMinor:
                    economicsApp.customerGapToFinanceCompanyUnconfirmedMinor ??
                    agreedToFinanceCompanyMinor,
                  payments: customerPayments,
                  // The same authority and the same own-deal refusal the server applies.
                  canRecord:
                    access.confirmDisbursement &&
                    access.viewFinance &&
                    operatorId !== economicsApp.salespersonId,
                  closed:
                    economicsApp.status !== "APPROVED" ||
                    economicsApp.finalizedSaleId !== undefined,
                  onConfirm: async (values: {
                    amountMinor: number;
                    paidAt: number;
                    reference: string;
                  }) => {
                    // A retry with the same payment details keeps the command key.
                    const intent = `confirm-customer-fc-payment:${applicationId}:${values.amountMinor}:${values.paidAt}:${values.reference}`;
                    try {
                      await confirmCustomerFinanceCompanyPayment({
                        orgId,
                        applicationId,
                        ...values,
                        idempotencyKey: commandId.for(intent),
                      });
                      commandId.retire(intent);
                      toast.success(t("CustFcPayConfirmedSuccess"));
                      return true;
                    } catch (error) {
                      if (isConvexError(error)) commandId.retire(intent);
                      toast.error(getErrorMessage(error));
                      return false;
                    }
                  },
                  onVoid: async (values: {
                    paymentId: string;
                    reason: string;
                  }) => {
                    try {
                      await voidCustomerFinanceCompanyPayment({
                        orgId,
                        applicationId,
                        paymentId:
                          values.paymentId as Id<"customerFinanceCompanyPayments">,
                        reason: values.reason,
                      });
                      toast.success(t("CustFcPayVoidedSuccess"));
                      return true;
                    } catch (error) {
                      toast.error(getErrorMessage(error));
                      return false;
                    }
                  },
                }
              : null,
        }
      : undefined;

  return { economics, economicsApp, supplierBasis, financeDecision };
}
