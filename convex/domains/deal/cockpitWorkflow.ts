import type { QueryCtx } from "../../_generated/server";
import type { Doc } from "../../_generated/dataModel";
import { cancelAuthorityFor, isSystemOwnerRole } from "../../utils/permissions";
import {
  isForwardPlanVersion,
  planVersionOf,
} from "../../utils/financedSalePostingPlan";
import {
  deriveForwardState,
  forwardCancelRefusal,
} from "../../utils/financeCompanyForward";
import { deriveDealStages } from "../../utils/financingEconomics";
import { readActiveApplicationDocuments } from "../../utils/activeApplicationDocuments";
import {
  chequesForApplication,
  isLiveFcCheque,
  clearedDisbursementCheque,
} from "../../utils/fcCheque";
import { resolveSettlement } from "./cockpitSettlement";

export async function readCockpitWorkflow(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  quote: Doc<"quotes"> | null,
  role: Doc<"roles">,
) {
  // SCRUM-447 D0/D6: the LIVE finance-company cheque(s) for this deal. A cheque
  // registered as the payment method counts as "registered" only while a live
  // row exists — a retired (returned/cancelled/replaced) one does not.
  const linkedCheques = await chequesForApplication(ctx, app._id);
  const liveFcCheques = linkedCheques.filter(isLiveFcCheque);
  const chequeMethodRegistered = app.expectedPaymentMethod === "CHEQUE";
  const chequeFaceUnrecorded =
    chequeMethodRegistered &&
    liveFcCheques.some((row) => row.amountMinor === undefined);

  // --- documents, which drive both the checklist and the delivery stage ----
  const rules = await ctx.db
    .query("companyDocumentRules")
    .withIndex("by_org", (q) => q.eq("orgId", app.orgId))
    .collect();
  // Same filter `assertRequiredApplicationDocumentsComplete` applies before
  // approval: an org-wide rule, or one for this deal's company. A screen that
  // counted rules the approval gate ignores would show a checklist the
  // dealership can never finish.
  const applicableRules = rules.filter(
    (rule) => !rule.companyId || rule.companyId === quote?.companyId,
  );
  const docRows = await readActiveApplicationDocuments(ctx, app);
  const docByRule = new Map(docRows.map((doc) => [doc.ruleId, doc]));

  const documents = applicableRules.map((rule) => {
    const doc = docByRule.get(rule._id);
    return {
      ruleId: rule._id,
      name: rule.documentName,
      required: rule.isRequired === true,
      // A rule with no row yet is MISSING, not absent — the checklist exists
      // to name what has not been done.
      status: doc?.status ?? ("MISSING" as const),
      uploadedAt: doc?.uploadedAt,
    };
  });
  const requiredDocs = documents.filter((doc) => doc.required);
  const requiredDocumentsComplete = requiredDocs.every(
    (doc) => doc.status === "VERIFIED" || doc.status === "WAIVED",
  );

  // --- the stage rail --------------------------------------------------
  // Resolved once, and shared with the money panel below, so the rail and the
  // figures can never disagree about which way the deal settles or whether it
  // is finished. The rail is qualitative — stage names and blocker keys, no
  // amounts — so it is safe to show a caller who cannot see the money.
  const settlementFacts = await resolveSettlement(ctx, app);
  // SCRUM-447 x SCRUM-446: the SAME resolved leg `confirmDisbursement` reads. When it is
  // NONE no finance company pays the dealership, so the cheque / disbursement flags below
  // must not offer a step the server will refuse (attest, re-register, correct-a-returned-
  // cheque). `expectedPaymentCorrectable` deliberately stays: clearing a legacy registered
  // method is the documented exit from that state.
  const disbursementApplies = settlementFacts.financierLeg !== "NONE";
  // SCRUM-435: the ONE forward proof feeds the rail, the cockpit view and the
  // gates; nothing here derives it a second time.
  const forwardProof = await deriveForwardState(ctx, app);
  const planVersion = planVersionOf(app);
  const cancelPermitted =
    isSystemOwnerRole(role) ||
    cancelAuthorityFor(app.status, planVersion).every((tier) =>
      tier.every((permission) => role.permissions.includes(permission)),
    );
  const cancelForwardOk =
    app.status !== "CLOSED" ||
    !isForwardPlanVersion(planVersion) ||
    forwardCancelRefusal(forwardProof) === null;
  const disbursementCheque = clearedDisbursementCheque(linkedCheques, app);
  const stages = deriveDealStages({
    forwardState: forwardProof.state,
    forwardExceptionOpen: forwardProof.returnedExceptionOpen,
    settlementComplete: settlementFacts.moneySettled,
    financierLeg: settlementFacts.financierLeg,
    dealCancelled: settlementFacts.saleCancelled,
    status: app.status,
    vehicleHandoverAt: app.vehicleHandoverAt,
    finalizedSaleId: app.finalizedSaleId,
    disbursedAt: app.disbursedAt,
    creditDecision: app.creditDecision,
    appraisalStatus: app.appraisalStatus,
    gapResolution: app.gapResolution,
    settlementStatus: app.settlementStatus,
    handoverStatus: app.handoverStatus,
    rawAppraisalGapMinor: app.rawAppraisalGapMinor,
    netShortfallMethod: app.netShortfallMethod,
    netShortfallMinor: app.netShortfallMinor,
    approvedDealerPurchaseAmountMinor: app.approvedDealerPurchaseAmountMinor,
    // Without the BASIS the rail cannot tell an approval that rests on
    // appraisal evidence from one the company named directly — and went on
    // demanding an appraisal that would never be recorded for the second.
    approvedPurchaseBasis: app.approvedPurchaseBasis,
    // Whether the split actually came out. A MANUAL approval only makes the
    // appraisal moot when the economics could be computed without one.
    fundingSplitComputed: app.financeCompanyFundedPortionMinor !== undefined,
    requiredDocumentsComplete,
    // Whether this deal has a paperwork gate at all: only a REQUIRED rule
    // makes one (SCRUM-629 F-07). Without any, the stage is NOT_APPLICABLE
    // rather than complete over an empty checklist.
    documentRulesApply: requiredDocs.length > 0,
    // The direct route's own disbursement evidence. Without it the stage
    // stays blocked forever on a deal whose money has entirely moved,
    // because the financier paid the supplier and never paid the dealership.
    supplierDisbursementConfirmedAt: app.supplierDisbursementConfirmedAt,
  });

  return {
    linkedCheques,
    liveFcCheques,
    chequeMethodRegistered,
    chequeFaceUnrecorded,
    documents,
    settlementFacts,
    disbursementApplies,
    forwardProof,
    planVersion,
    cancelPermitted,
    cancelForwardOk,
    disbursementCheque,
    stages,
  };
}
