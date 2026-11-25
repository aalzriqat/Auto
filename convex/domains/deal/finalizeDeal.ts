import { ConvexError } from "convex/values";
import { type MutationCtx } from "../../_generated/server";
import { type Id } from "../../_generated/dataModel";
import { mayReadFinanceEconomics } from "../../utils/financeApplicationProjection";
import { throwAppError } from "../../utils/errors";
import { assertApprovalExcessPostable } from "../../utils/approvalExcessProfit";
import { type DepositTreatment } from "../../utils/depositHelpers";
import { type DepositMethod } from "../../utils/depositRecording";
import { assertNoPendingDepositRequest } from "../../utils/depositRequestGuards";
import { assertOperatedDealMode } from "../../utils/dealModes";
import { assertQuoteEconomicsMatchFrozen } from "../../utils/quoteEconomicsAnchor";
import {
  assertActorMayCompleteConsignedSale,
  completeSale,
} from "../../utils/saleCompletion";
import { isForwardPlan } from "../../utils/financedSalePostingPlan";
import {
  deriveForwardState,
  forwardFinalizeRefusal,
} from "../../utils/financeCompanyForward";
import {
  resolveFinancedSalePlan,
  financedSaleRecognitionDate,
  closingRefusalError,
  dealModeOf,
} from "../../utils/financedSaleRecognition";
import {
  DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED,
  refuseDepositOtherTreatment,
} from "../../utils/depositOtherContainment";
import { redactClosingReason } from "../../../lib/closingReadinessReasonCodes";
import { isConsignedAgentSale } from "../../utils/vehicleOwnership";
import { liveChequesForApplication } from "../../utils/fcCheque";
import { manualPayerOf } from "../../utils/manualFinancePayer";
import { assertDealerEconomicsReady } from "./settlementRouting";
import { QuoteMode } from "./quoteIntake";
import { assertRequiredApplicationDocumentsComplete } from "./applicationStatus";
import { closingReadinessInputsOrRefusal } from "./closingReadiness";
import { settlementPayerForApplication } from "./settlementRouting";
import { recordFinancedClosing } from "./finalizationPosting";
import { type TenantAuthContext } from "../../utils/tenancy";

export async function prepareFinancedClosing(
  ctx: MutationCtx,
  args: FinalizeDealInput,
  auth: TenantAuthContext,
) {
  // The default MANAGER template confirms disbursements WITHOUT view:finance,
  // so a refused finalize is redacted exactly as `getClosingReadiness`
  // redacts for the same caller (SCRUM-414 R1): below the finance tier every
  // readiness refusal is a WITHHELD_* code, no params, generic English.
  const mayReadMoney = mayReadFinanceEconomics(auth.role);

  // SCRUM-886 round 13: finalizing the sale of a SOURCED car needs view:cost_price. The FIRST decision after auth: it depends only
  // on the car's sourceType and the actor's role, so no readiness, plan or deposit refusal below can answer for a caller who may
  // not read vehicle cost. An application that cannot be read here is left to the door's own refusal.
  const applicationForCostAccess = await ctx.db.get(args.applicationId);
  if (
    applicationForCostAccess &&
    applicationForCostAccess.orgId === args.orgId
  ) {
    await assertActorMayCompleteConsignedSale(ctx, {
      orgId: args.orgId,
      actorId: auth.user._id,
      vehicleIds: [applicationForCostAccess.vehicleId],
    });
  }

  // SCRUM-801: OTHER leaves the liability for a manual journal, which the
  // pilot has switched off. Refused after auth and ahead of every read, so no
  // earlier readiness or plan refusal (e.g. FIRST_PAYMENT_UNFUNDED) can answer
  // for it. The shared choke point in resolveReservationDeposits still backs
  // this up for the other completion doors.
  if (
    args.depositResolution?.treatment === "OTHER" &&
    DEPOSIT_OTHER_TREATMENT_PILOT_DISABLED
  ) {
    refuseDepositOtherTreatment();
  }
  return mayReadMoney;
}

export type FinalizeDealInput = {
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  depositResolution?: {
    treatment:
      | "APPLY_TO_DEALER_AMOUNT"
      | "APPLY_TO_TRANSACTION_SETTLEMENT"
      | "REFUND_TO_CUSTOMER"
      | "FORFEITED"
      | "OTHER";
    reason?: string;
    refundMethod?: DepositMethod;
  };
  idempotencyKey: string;
};

// Only consulted when the deal's vehicle is consigned AND the buyer paid
// the supplier directly — the one case where what the customer owes the
// dealership does not imply what its reservation deposit is applied to.
// Closing a financed deal is an ACCOUNTANT's act (owner ruling, SCRUM-407):
// it recognizes the sale, opens the receivables and posts the journal, so it
// takes the disbursement authority the accountant templates hold.
// Which application is being finalized, and how any held deposit is
// treated as part of finalizing it.
export async function executeFinalizeDeal(
  ctx: MutationCtx,
  args: FinalizeDealInput,
  auth: TenantAuthContext,
  mayReadMoney: boolean,
) {
  const app = await ctx.db.get(args.applicationId);
  if (!app || app.orgId !== args.orgId)
    throw new ConvexError("Application not found");
  if (app.status === "CLOSED" && app.finalizedSaleId)
    return app.finalizedSaleId;
  if (app.status !== "APPROVED")
    throw new ConvexError("Application must be APPROVED before finalizing");
  // SCRUM-613: the posting plan has no excess leg yet (it forwards the whole
  // deposit), so an excess is refused rather than posted wrongly. Fails closed.
  assertApprovalExcessPostable(app);
  // SCRUM-495: readiness mirrors this for the screen.
  assertOperatedDealMode(
    app.quoteModeAtSubmission ?? (await dealModeOf(ctx, app)),
  );
  // SCRUM-444 DA-03: a waiting deposit request would be orphaned by the
  // deal closing. Refused up front so the message is this one, not a
  // later readiness refusal.
  await assertNoPendingDepositRequest(ctx, {
    orgId: args.orgId,
    quoteId: app.quoteId,
    action: "finalize the deal",
  });
  if (!app.vehicleHandoverAt) {
    throw new ConvexError(
      "Register the vehicle handover to the customer before finalizing the deal.",
    );
  }
  if (!app.expectedPaymentMethod || !app.expectedPaymentDate) {
    throw new ConvexError(
      "Register how and when the payment is expected before finalizing the deal.",
    );
  }
  // SCRUM-447 D3e: a registered CHEQUE method needs exactly one LIVE
  // finance-company cheque behind it — a retired (returned / cancelled /
  // replaced) row does not count, and two live rows are ambiguous.
  if (app.expectedPaymentMethod === "CHEQUE") {
    const liveCheques = await liveChequesForApplication(
      ctx,
      args.applicationId,
    );
    if (liveCheques.length !== 1) {
      throw new ConvexError(
        liveCheques.length === 0
          ? "The registered cheque is no longer live. Correct the expected payment and register the cheque again before finalizing the deal."
          : "This deal has more than one live finance-company cheque. Resolve the duplicate before finalizing the deal.",
      );
    }
  }
  // Same guard as registerVehicleHandover: an approval cleared by a
  // reappraisal leaves status APPROVED, so this is the only thing
  // stopping a sale being completed on economics nothing supports.
  assertDealerEconomicsReady(app, { phase: "FINALIZATION" });

  // The last step in the ordering Codex traced, and the one that creates
  // a SALE. A deal whose denomination cannot be established must not be
  // turned into money here either — otherwise every guard upstream is
  // just a longer road to the same wrong figure.
  //
  // The same derivation the deal screen's readiness query uses, so the two
  // cannot disagree about the denomination: an unsupported one, or a pin
  // that has drifted from the org's current currency, is refused here,
  // before the sale exists (SCRUM-241).
  const inputs = await closingReadinessInputsOrRefusal(
    ctx,
    app,
    "finalizing this deal",
  );
  if (!inputs.ok)
    throw closingRefusalError(
      redactClosingReason(inputs.refusal, mayReadMoney, "WITHHELD_UNAVAILABLE"),
    );
  const readinessInputs = inputs.inputs;

  // On a consigned car financed by an external company, the route decides
  // opposite balance sheets from the same sale — a payable to the supplier
  // for his whole entitlement, or a claim on him for the margin. An absent
  // route reads as THROUGH_DEALERSHIP, which is the right reading for
  // history but a dangerous default for a NEW deal: forgetting to choose
  // posts one of the two silently.
  //
  // Scoped to the population where the question is both meaningful and
  // new — consigned vehicle, external financier. Dealer-owned stock has no
  // supplier, and a deal with no finance company cannot take the direct
  // route at all. Nothing already CLOSED is touched, so no history is
  // restated; an in-flight deal is asked the question once.
  //
  // "External financier" is the quote MODE, not `companyId`. A
  // MANUAL_FINANCE_COMPANY deal structurally cannot carry a `companyId`
  // (`convex/quotes.ts` rejects one on every mode but CONFIGURED), so
  // gating on it meant an ordinary "other finance option" deal was never
  // asked the question and defaulted through the dealership — booking a
  // customer receivable and a supplier payable on a deal where the
  // financier paid the supplier directly.
  //
  // LEASE is asked too, even though it cannot answer DIRECT: being unable
  // to record the right answer is not a reason to silently post the wrong
  // one, and the refusal names why.
  {
    const vehicle = await ctx.db.get(app.vehicleId);
    const payer = await settlementPayerForApplication(ctx, app);
    if (
      vehicle &&
      isConsignedAgentSale(vehicle) &&
      payer.external &&
      app.supplierSettlementRoute === undefined
    ) {
      throw new ConvexError(
        `This car belongs to ${vehicle.sourcedFromName ?? "the supplier"} and the deal is financed, so who the finance company pays decides whether the dealership owes him his entitlement or holds a claim on him for its margin. Record the settlement route before finalizing.`,
      );
    }

    // On the direct route the approved amount IS the settlement, so it is
    // not optional here.
    //
    // `assertDealerEconomicsReady` lets a deal with no recorded
    // quotation through untouched, which is right for a legacy deal
    // settling through the dealership and wrong for this one: the direct
    // route is only ever reachable with an external financier paying the
    // supplier (`setSupplierSettlementRoute` refuses otherwise), and the
    // amount they pay him is the approval. Without it `completeSale` would
    // fall back to the sale price and open a supplier debt for money that
    // never reached him — the exact defect this redesign closes, reached
    // through a legacy door. A guard whose evidence is missing refuses.
    if (
      app.supplierSettlementRoute === "DIRECT_TO_SUPPLIER" &&
      app.approvedDealerPurchaseAmountMinor === undefined
    ) {
      throw new ConvexError(
        `On this deal the finance company pays ${vehicle?.sourcedFromName ?? "the supplier"} directly, so what it approved is the amount he actually receives — and the dealership's claim on him is measured from it. That approved purchase amount is not recorded on this deal. Record it before finalizing.`,
      );
    }
  }

  const quote = await ctx.db.get(app.quoteId);
  if (!quote || quote.orgId !== args.orgId)
    throw new ConvexError("Quote not found");
  if (
    quote.customerId !== app.customerId ||
    quote.vehicleId !== app.vehicleId
  ) {
    throw new ConvexError(
      "Application quote does not match the application customer and vehicle.",
    );
  }
  if (quote.companyId && quote.companyId !== app.companyId) {
    throw new ConvexError(
      "Application finance company does not match the quote.",
    );
  }
  // SCRUM-528. The sale below is built from the quote's economics, so they must still agree
  // with the pricing frozen on this application (before any write).
  const quoteMode: QuoteMode | undefined =
    app.quoteModeAtSubmission ?? quote.mode;
  assertQuoteEconomicsMatchFrozen(app, quote, quoteMode);
  await assertRequiredApplicationDocumentsComplete(ctx, app, quote);

  // SCRUM-195 M3, DOOR 4. COMPLETION-TIME OWNERSHIP IS NOT REDUNDANT
  // HERE, AND IT IS NOT THIS FUNCTION'S TO IMPLEMENT.
  //
  // An APPROVED application is not proof that its car is still this
  // deal's. The deal can be closed through a different door and then
  // cancelled: the root goes CONSUMED and STAYS CONSUMED, while nothing
  // touches `financeApplications`, so the application stays APPROVED
  // with every finalizeDeal precondition satisfied. Another customer
  // then legitimately acquires the car, and only a completion-time check
  // stops the stale application selling it out from under them.
  //
  // That check — and the root's consumption — live in `completeSale`'s
  // shared boundary in utils/saleCompletion.ts, which this door reaches
  // below. Four doors, one guard.

  // The minimum-profit approval is re-proved at the commit point by
  // `completeSale`'s shared boundary (SCRUM-260), against the price this
  // sale persists — `quote.vehiclePrice` below.

  const financingType =
    quoteMode === "LEASE"
      ? "LEASE"
      : quoteMode === "CONFIGURED_FINANCE_COMPANY" ||
          quoteMode === "MANUAL_FINANCE_COMPANY" ||
          quoteMode === "INTERNAL_INSTALLMENT"
        ? "FINANCED"
        : "CASH";

  // The last refusals before the first write. Everything above has had its
  // say, and nothing below can be undone by throwing: no sale row, no
  // application patch, no receivable, no journal, no outbox entry.
  //
  // `resolveFinancedSalePlan` first re-runs the automatic closing-readiness
  // evaluator (`evaluateClosingReadiness`, SCRUM-407) — the same one the
  // deal screen shows — and refuses on the first unmet accounting
  // condition: a known remittance, configured fees recorded, the custody
  // family on the books and settled, reconciled costs, the legal invoice,
  // and a financing reconciliation flag that has been reviewed
  // (FINANCING_RECONCILED, SCRUM-420).
  // The retired `CLASSIFIED` stamp is never read.
  //
  // How this financed sale will be recognised, frozen before anything is
  // written and derived entirely from the record: the legal invoice the car
  // was sold under, what the company will actually remit, and each cost it
  // withholds at the account that cost's own treatment names.
  //
  // `undefined` for every deal this model does not cover — a cash sale, a
  // deal with no named financier — and those post exactly as they always
  // have. The direct route IS covered, by plan v3 only (no finance
  // receivable opens: the company pays the supplier). When it DOES cover a deal and the plan cannot be
  // derived, it throws here rather than returning nothing, so there is no
  // path where a missing plan quietly falls back to the old posting.
  const financedSalePlan = await resolveFinancedSalePlan(ctx, app, {
    ...readinessInputs,
    // The same disposition completion will act on, so the plan and the
    // deposits it consumes cannot disagree about whether the money was
    // applied to this purchase at all.
    depositTreatment: args.depositResolution?.treatment,
    mayReadMoney,
  });

  // SCRUM-411 P2-01. The deposit and the contribution are paid to the finance
  // company BEFORE the sale, so the CURRENT amount must already be on the books
  // against the exact plan about to be frozen. A payment recorded against other
  // figures (the contribution, the deposit or the approved amount moved since)
  // does not count. Refused here, before the first write.
  if (financedSalePlan !== undefined && isForwardPlan(financedSalePlan)) {
    const forwardRefusal = forwardFinalizeRefusal(
      await deriveForwardState(ctx, app, {
        dueMinor: financedSalePlan.forwardDueMinor,
        fingerprint: financedSalePlan.fingerprint,
      }),
    );
    if (forwardRefusal !== null)
      throwAppError(forwardRefusal.code, forwardRefusal.message);
  }

  // The sale row's financingType; the settlementStatus below keys on it too.
  const saleFinancingType =
    quoteMode === undefined && app.companyId ? "FINANCED" : financingType;

  const saleId = await completeSale(
    ctx,
    {
      orgId: args.orgId,
      vehicleId: app.vehicleId,
      customerId: app.customerId,
      salespersonId: app.salespersonId,
      salePrice: quote.vehiclePrice,
      // The ONE recognition date, shared with the period the plan's journal
      // is dated into; see `financedSaleRecognitionDate`. A v3 plan (every
      // new financed deal) is recognised on the evidenced handover date; a
      // deal the plan does not cover keeps its invoice-date rule.
      saleDate: financedSaleRecognitionDate(
        app,
        Date.now(),
        financedSalePlan?.version ?? 2,
      ),
      status: "COMPLETED",
      downPayment: quote.downPayment,
      financingType: saleFinancingType,
      loanAmount: quote.totalFinancedAmount,
      termMonths: quote.termMonths,
      applicationId: args.applicationId,
      quoteId: app.quoteId,
      // Absent on every deal this model does not cover, which is what keeps
      // cash and consigned completion byte-identical.
      financedSalePlan: financedSalePlan
        ? {
            version: financedSalePlan.version,
            fingerprint: financedSalePlan.fingerprint,
            // Exactly one of the two identities (SCRUM-27): a configured
            // company's id, or the manual company's letter name.
            ...(app.companyId
              ? { financeCompanyId: app.companyId as string }
              : { payerNameSnapshot: manualPayerOf(app)?.name }),
            // v3 carries its server-derived consideration; v1/v2 their invoice's.
            ...(financedSalePlan.version === 3
              ? { considerationMinor: financedSalePlan.considerationMinor }
              : {
                  legalInvoiceConsiderationMinor:
                    financedSalePlan.legalInvoiceConsiderationMinor,
                }),
            financeCompanyReceivableMinor:
              financedSalePlan.financeCompanyReceivableMinor,
            financeCompanyPayableMinor:
              financedSalePlan.financeCompanyPayableMinor,
            customerReceivableMinor: financedSalePlan.customerReceivableMinor,
            depositLiabilityAppliedMinor:
              financedSalePlan.depositLiabilityAppliedMinor,
            // v2/v3 (SCRUM-435): H and C are owed onward to the company.
            ...(isForwardPlan(financedSalePlan)
              ? {
                  forwardDepositMinor: financedSalePlan.forwardDepositMinor,
                  forwardContributionMinor:
                    financedSalePlan.forwardContributionMinor,
                }
              : {}),
            components: financedSalePlan.components.map((component) => ({
              sourceKind: component.sourceKind,
              sourceId: component.sourceId,
              label: component.label,
              amountMinor: component.amountMinor,
              treatment: component.treatment,
              systemKey: component.systemKey,
              side: component.side,
            })),
          }
        : undefined,
      // SCRUM-390 (OR-5): G and C for the "Commissionable vehicle margin", plans
      // v2/v3. `completeSale` applies it to a dealer-owned car alone and
      // freezes it onto the sale row.
      commissionBase: isForwardPlan(financedSalePlan)
        ? {
            // G in full under v2, A under v3. Not `financeCompanyReceivableMinor`,
            // which the direct route zeroes: the company still approved A there.
            approvedMinor: financedSalePlan.grossDealerSettlementMinor,
            // C (v2) / D (v3) before the customer's direct payment to the company (SCRUM-766 PR-B).
            contributionMinor: financedSalePlan.commissionContributionMinor,
            currency: financedSalePlan.currency,
          }
        : undefined,
      // Carried from the application onto the sale. Without this every
      // financed consigned deal posted THROUGH_DEALERSHIP no matter what
      // was agreed, because an absent route reads as that — so a deal whose
      // buyer's financier paid the supplier booked a payable to him and a
      // receivable at the gross, both inverted.
      supplierSettlementRoute: app.supplierSettlementRoute,
      // What the finance company actually pays the supplier on this deal.
      //
      // Only on the direct route, and only from the FROZEN approval — the
      // one amount contractually committed to before any money moves. On
      // the through route the dealership collects the gross and this must
      // stay absent, or the sale would measure its margin against an amount
      // nobody paid the supplier.
      //
      // Without it, `completeSale` fell back to `quote.vehiclePrice` and
      // opened a supplier debt for `salePrice − entitlement`. Where the
      // company approved BELOW the quotation, `salePrice − approved` of that
      // debt had never reached the supplier: with a 20,000 sale, a 15,000
      // entitlement and an 18,000 approval, he was made debtor for 5,000
      // while holding 3,000 of the dealership's money. The rest is either
      // paid to the dealership directly by the customer or collected by
      // nobody — and per SCRUM-23 it is a management figure on no invoice,
      // so it may not appear in anybody's subledger.
      supplierGrossReceiptMinor:
        app.supplierSettlementRoute === "DIRECT_TO_SUPPLIER"
          ? app.approvedDealerPurchaseAmountMinor
          : undefined,
      // Carried WITH the amount, never assumed. The approval is stored in
      // minor units of the application's pinned `economicsCurrency`, and
      // `completeSale` resolves the sale's currency from the org — which can
      // have changed since the deal was priced. Completion compares the two
      // and refuses on a mismatch instead of subtracting cents from fils.
      supplierGrossReceiptCurrency:
        app.supplierSettlementRoute === "DIRECT_TO_SUPPLIER"
          ? (app.economicsCurrency ?? undefined)
          : undefined,
      depositResolution: args.depositResolution as
        | {
            treatment: DepositTreatment;
            reason?: string;
            refundMethod?: DepositMethod;
          }
        | undefined,
      idempotencyKey: args.idempotencyKey,
      actorId: auth.user._id,
    },
    // SCRUM-69: the finance door for this application.
    { kind: "FINANCE_FINALIZATION", applicationId: args.applicationId },
  );
  return recordFinancedClosing(
    ctx,
    args,
    app,
    quote,
    saleId,
    saleFinancingType,
    quoteMode,
    financedSalePlan,
    auth.user._id,
  );
}
