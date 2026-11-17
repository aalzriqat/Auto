import type { Doc } from "../_generated/dataModel";
import { reasonOf, type ClosingReadinessReason } from "../../lib/closingReadinessReasonCodes";
import { isDealerBorneFee, summarizeFees } from "./feeSummary";
import { treatmentPosting } from "./financedSalePostingPlan";
import { settlementDeductedFees } from "./settlementDeductions";

export function currentCashNoCostApprover(app: Doc<"financeApplications">) {
  const declaration = app.cashNoCostCloseout;
  const approver = declaration?.confirmation?.by;
  return declaration && !declaration.invalidated && declaration.declaredBy === app.salespersonId &&
    approver && approver !== app.salespersonId && approver !== app.plannedCustody?.userId ? approver : undefined;
}

export function confirmedCashNoCostReadback(app: Doc<"financeApplications">, fees: ReadonlyArray<Doc<"financeDealFees">>) {
  if (!app.cashNoCostCloseout || fees.some(isDealerBorneFee)) return undefined;
  return app.status === "CLOSED" && app.finalizedSaleId !== undefined && currentCashNoCostApprover(app) !== undefined;
}

/**
 * What "this deal's costs are closable" means, asked of the live rows at the
 * moment of finalization: at least one live line; every live line in the
 * deal's currency; every live amount a readable figure (the summary's own
 * verdict, which also refuses an overflowing sum); every line carrying an
 * actual; every actual reconciled. An estimate-less line recorded against a
 * configured position passes — it carries a real, reconciled actual — and the
 * configured positions themselves are proven by `assertConfiguredFeesRecorded`.
 */
export function costsClosableRefusal(liveFees: ReadonlyArray<Doc<"financeDealFees">>, currency: string): ClosingReadinessReason | null {
  if (liveFees.length === 0) {
    return reasonOf(
      "COSTS_NONE",
      "No costs are itemized on this deal, so its accounting cannot be finalized. Record them, or a zero-cost line saying the dealership bore none, before finalizing."
    );
  }
  const foreign = liveFees.filter((fee) => fee.currency !== currency);
  if (foreign.length > 0) {
    return reasonOf(
      "COSTS_FOREIGN_CURRENCY",
      `${foreign.length} cost line(s) on this deal are not in ${currency}, so its costs cannot be finalized until the records agree.`,
      { count: foreign.length, currency }
    );
  }
  const summary = summarizeFees([...liveFees]);
  if (summary.amountsUnreadable !== null) {
    return reasonOf(
      "COSTS_AMOUNT_UNREADABLE",
      "A cost amount on this deal is not a readable figure, so its accounting cannot be finalized until the line is corrected."
    );
  }
  if (summary.linesAwaitingActual > 0) {
    return reasonOf(
      "COSTS_AWAITING_ACTUAL",
      `${summary.linesAwaitingActual} cost(s) on this deal have no actual amount recorded, so its accounting cannot be finalized. Record them before finalizing.`,
      { count: summary.linesAwaitingActual }
    );
  }
  if (summary.linesAwaitingReconciliation > 0) {
    return reasonOf(
      "COSTS_AWAITING_RECONCILIATION",
      `${summary.linesAwaitingReconciliation} cost(s) on this deal have an amount nobody has checked, so its accounting cannot be finalized. Reconcile them before finalizing.`,
      { count: summary.linesAwaitingReconciliation }
    );
  }
  if (!summary.fullyReconciled) {
    return reasonOf("COSTS_NOT_RECONCILED", "This deal's costs are not fully reconciled, so its accounting cannot be finalized.");
  }
  // The plan posts every non-zero deducted line to its treatment's account and
  // refuses a treatment that has none (TREATMENT_UNMAPPED) — asked here too, so
  // the screen never reports READY for a deal the plan will refuse (Codex R407-2).
  const unmapped = settlementDeductedFees(liveFees).find(
    (fee) => fee.actualAmountMinor !== undefined && fee.actualAmountMinor !== 0 && treatmentPosting(fee.accountingTreatment) === null
  );
  if (unmapped !== undefined) {
    const feeLabel = unmapped.description?.trim() || humanizeFeeType(unmapped.feeType);
    return reasonOf(
      "COSTS_TREATMENT_UNMAPPED",
      `"${feeLabel}" is classified as ${unmapped.accountingTreatment}, which has no account to post to. Reclassify it before finalizing — it will not be posted to a general account instead.`,
      { feeLabel, treatment: unmapped.accountingTreatment }
    );
  }
  return null;
}

/** "OWNERSHIP_TRANSFER" -> "Ownership transfer". Only for a line with no description. */
export function humanizeFeeType(feeType: string): string {
  const words = feeType.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
