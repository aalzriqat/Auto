import type { FinanceDecisionFacts } from "./FinanceCompanyDecisionCard";

/** The caller's four capabilities on the card, exactly as the card takes them. */
export type FinanceDecisionCapabilities = Readonly<{
  canRecordQuotation: boolean;
  canRecordApproval: boolean;
  canEstablishLtvPercent: boolean;
  canRecordAppraisal: boolean;
  isOwnDeal: boolean;
}>;

export function canReopenApprovedPurchase(facts: FinanceDecisionFacts, caps: Pick<FinanceDecisionCapabilities, "canRecordApproval" | "isOwnDeal">): boolean {
  return facts.approvedPurchaseRecorded && caps.canRecordApproval && !caps.isOwnDeal && !facts.closed && !facts.handedOver;
}

export function completedFinanceStageCorrections(
  stage: string,
  decision: (FinanceDecisionCapabilities & Readonly<{
    facts: FinanceDecisionFacts;
    deliveredApprovalCorrection?: { economicsStamp: string } | null;
  }>) | undefined,
  actions: Readonly<{
    replaceAppraisal: () => void;
    correctQuotation: () => void;
    reopenApproval: () => void;
    correctDeliveredApproval: () => void;
  }>,
): readonly Readonly<{ labelKey: string; onOpen: () => void }>[] {
  if (!decision) return [];
  const { facts } = decision;
  const canReopen = canReopenApprovedPurchase(facts, decision);
  if (stage === "APPROVED_PURCHASE") {
    if (facts.handedOver && !facts.closed && decision.deliveredApprovalCorrection) {
      return [{ labelKey: "CorrectDeliveredApprovalAction", onOpen: actions.correctDeliveredApproval }];
    }
    return canReopen ? [{ labelKey: "CorrectApprovedPurchaseAction", onOpen: actions.reopenApproval }] : [];
  }
  if (stage !== "APPRAISAL" || facts.closed || facts.handedOver) return [];

  const corrections: { labelKey: string; onOpen: () => void }[] = [];
  if (facts.appraisalAmountMinor !== null && decisionActionAvailability(facts, decision).appraisal.available) {
    corrections.push({ labelKey: "ReplaceAppraisalAction", onOpen: actions.replaceAppraisal });
  }
  const quotation = decisionActionAvailability({ ...facts, approvedPurchaseRecorded: false }, decision).quotation;
  if (facts.submittedQuotationMinor !== null && quotation.available && (!facts.approvedPurchaseRecorded || canReopen)) {
    corrections.push({ labelKey: "CorrectSubmittedQuotationAction", onOpen: actions.correctQuotation });
  }
  return corrections;
}

/**
 * Whether one of the card's first-time actions may be offered and, when it may
 * not, the i18n key of the reason. `reasonKey` is present exactly when the
 * action is not available.
 */
export type DecisionActionAvailability = Readonly<{ available: boolean; reasonKey?: string }>;

/**
 * Whether each of the card's three first-time actions may be offered, and why
 * not.
 *
 * ONE predicate AND one reason per action, shared by the card and by the stage
 * focus row (SCRUM-417), so the one next step the focus row names can never be
 * offered to somebody the card would refuse, withheld from somebody it would
 * serve, or explained with a different sentence than the card writes beside
 * the row. The reasoning behind each term is at the card, where the buttons
 * live. Each reason list is ordered by what the operator can act on.
 */
export function decisionActionAvailability(
  facts: FinanceDecisionFacts,
  caps: FinanceDecisionCapabilities
): Readonly<{
  quotation: DecisionActionAvailability;
  approval: DecisionActionAvailability;
  appraisal: DecisionActionAvailability;
}> {
  const quotationRecorded = facts.submittedQuotationMinor !== null;
  const canRecordMissingRate = caps.canRecordQuotation && caps.canEstablishLtvPercent;

  let quotationReason: string | undefined;
  if (facts.closed) quotationReason = "FinanceDecisionClosed";
  // The missing rate before the plain permission: its sentence names every
  // permission recording it needs, so it is the more precise of the two for a
  // caller who also lacks the create permission (SCRUM-322).
  else if (facts.ltvMissing && !canRecordMissingRate) quotationReason = "DealPurchaseLtvNeedsApprover";
  else if (!caps.canRecordQuotation) quotationReason = "QuotationNeedsPermission";
  // An approval on the record freezes the quotation it was based on — the
  // server refuses to move it and directs the caller to reopen the approval.
  // Only a legacy row reaches this with no quotation, and it is told THAT,
  // not the missing-rate sentence it used to borrow (SCRUM417-R1).
  else if (facts.approvedPurchaseRecorded) quotationReason = "ApprovedPurchaseFreezesQuotation";

  let approvalReason: string | undefined;
  if (facts.closed) approvalReason = "FinanceDecisionClosed";
  else if (!quotationRecorded) approvalReason = "QuotationNeededFirst";
  else if (!caps.canRecordApproval) approvalReason = "ApprovedPurchaseNeedsApprover";
  else if (caps.isOwnDeal) approvalReason = "ApprovedPurchaseNotOwnDeal";

  let appraisalReason: string | undefined;
  if (facts.closed) appraisalReason = "FinanceDecisionClosed";
  else if (facts.handedOver) appraisalReason = "AppraisalClosedByHandover";
  else if (!caps.canRecordAppraisal) appraisalReason = "AppraisalNeedsReviewer";

  return {
    quotation: { available: quotationReason === undefined, reasonKey: quotationReason },
    approval: { available: approvalReason === undefined, reasonKey: approvalReason },
    appraisal: { available: appraisalReason === undefined, reasonKey: appraisalReason },
  };
}

/** Which of the card's dialogs a focus-row step opens. */
export type FinanceDecisionDialog = "RECORD_QUOTATION" | "RECORD_APPRAISAL" | "RECORD_APPROVAL";

/**
 * The ONE next thing the finance company's decision needs, in the order the
 * deal moves: the quotation goes out, the car is valued, the company answers
 * with an amount (SCRUM-417, G3).
 *
 * Returns the action and, when this caller cannot take it, the same reason the
 * card writes beside the row — never a different one. `stage` is the live
 * stage: the appraisal is asked for only while the rail is waiting on it,
 * because on APPROVED_PURCHASE a manually based approval needs none.
 */
export function nextFinanceDecisionStep(
  facts: FinanceDecisionFacts,
  caps: FinanceDecisionCapabilities,
  stage: "APPRAISAL" | "APPROVED_PURCHASE"
): { actionKey: string; opens: FinanceDecisionDialog; unavailableReasonKey?: string } {
  const availability = decisionActionAvailability(facts, caps);
  if (facts.submittedQuotationMinor === null) {
    return {
      actionKey: "RecordQuotationAction",
      opens: "RECORD_QUOTATION",
      unavailableReasonKey: availability.quotation.reasonKey,
    };
  }
  if (stage === "APPRAISAL" && facts.appraisalAmountMinor === null) {
    return {
      actionKey: "RecordAppraisalAction",
      opens: "RECORD_APPRAISAL",
      unavailableReasonKey: availability.appraisal.reasonKey,
    };
  }
  return {
    actionKey: "RecordApprovedPurchaseAction",
    opens: "RECORD_APPROVAL",
    unavailableReasonKey: availability.approval.reasonKey,
  };
}
