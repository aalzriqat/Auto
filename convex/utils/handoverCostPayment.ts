import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { CUSTODY_POSTABLE_TREATMENTS } from "./dealCustodyPosting";
import { isMinorAmount } from "./financingEconomics";

/**
 * "Who paid this handover cost, and is it on the books?" (SCRUM-443).
 *
 * ONE module, read by the mutation guards (`financeDealCosts`), the closing
 * readiness check (`financedSaleRecognition`, `HANDOVER_COSTS_PAID`) and the
 * screen's per-line projection (`listDealCosts`), so the three cannot disagree
 * about which lines the invariant covers or what "paid" means:
 *
 *   On an application-routed deal, every dealer-borne handover cost with a
 *   real actual reaches the general ledger EXACTLY ONCE, from the source of
 *   the cash that paid it — the employee custody that paid it
 *   (`CUSTODY_FEE_PAID`), or a direct dealership payment
 *   (`HANDOVER_COST_PAID_DIRECT`) recorded by somebody who may confirm a
 *   finance disbursement. The deal cannot finalize while a live handover line
 *   has neither.
 *
 * Pure: no database, no Convex function — so the client projection and the
 * server verdict are the same code.
 */

/** The cost types that are handover costs — the ones the dealership pays to hand the car over. */
export const HANDOVER_LINE_FEE_TYPES: ReadonlySet<Doc<"financeDealFees">["feeType"]> = new Set<
  Doc<"financeDealFees">["feeType"]
>([
  "INSURANCE",
  "STAMPS",
  "LICENSING",
  "OWNERSHIP_TRANSFER",
  "LIEN_REGISTRATION",
  "LIEN_RELEASE",
  "INSPECTION",
  "OTHER_CLOSING_EXPENSE",
]);

/**
 * How a direct payment left the dealership. REQUIRED on the command and never
 * defaulted: an absent method read as cash would credit the till for a bank
 * transfer. CHEQUE here means the dealership ISSUED a cheque, which credits the
 * bank (`disbursementAccountKey`), never cheques-in-hand.
 */
export const DIRECT_PAYMENT_METHODS = ["CASH", "BANK_TRANSFER", "CHEQUE", "CARD"] as const;
export type DirectPaymentMethod = (typeof DIRECT_PAYMENT_METHODS)[number];

export const directPaymentMethodValidator = v.union(
  v.literal("CASH"),
  v.literal("BANK_TRANSFER"),
  v.literal("CHEQUE"),
  v.literal("CARD")
);

export function isDirectPaymentMethod(value: unknown): value is DirectPaymentMethod {
  return typeof value === "string" && (DIRECT_PAYMENT_METHODS as ReadonlyArray<string>).includes(value);
}

/** The stored shape of a live direct payment on a cost line (`financeDealFees.directPayment`). */
export const directPaymentValidator = v.object({
  version: v.number(),
  amountMinor: v.number(),
  method: directPaymentMethodValidator,
  paidAt: v.number(),
  reference: v.optional(v.string()),
  recordedBy: v.id("users"),
  recordedAt: v.number(),
});

/** One version's forward posting key. Never matches the custody key family (`custody_*`). */
export const handoverDirectPostKey = (feeId: Id<"financeDealFees">, version: number): string =>
  `handover_direct_paid_${feeId}_v${version}`;
/** The reversal of one version. */
export const handoverDirectReversalKey = (feeId: Id<"financeDealFees">, version: number): string =>
  `handover_direct_reversal_${feeId}_v${version}`;

/** The columns of a cost line the verdicts below read. */
export type HandoverPaymentLine = Pick<
  Doc<"financeDealFees">,
  | "voidedAt"
  | "feeType"
  | "paidBy"
  | "deductedFromSettlement"
  | "accountingTreatment"
  | "actualAmountMinor"
  | "custodyId"
  | "custodyPosted"
  | "directPayment"
>;

/**
 * Whether the line is a handover cost the dealership bears and this invariant
 * covers: live; a handover fee type; borne by the dealership (paid by it, or
 * by an employee on its behalf — the same "dealer-borne" line `summarizeFees`
 * draws; a cost the customer or the finance company paid is nobody's cash
 * here); NOT withheld from the finance company's settlement (the financed-sale
 * plan recognises those); and of a treatment custody can post — the same
 * expense mapping a direct payment debits.
 */
export function isHandoverLine(line: HandoverPaymentLine): boolean {
  return (
    line.voidedAt === undefined &&
    HANDOVER_LINE_FEE_TYPES.has(line.feeType) &&
    (line.paidBy === "DEALER" || line.paidBy === "EMPLOYEE") &&
    line.deductedFromSettlement !== true &&
    CUSTODY_POSTABLE_TREATMENTS.has(line.accountingTreatment)
  );
}

/**
 * What the deal's route does with a dealer-borne cost that is WITHHELD from the
 * finance company's settlement. On a configured financed-sale plan the plan
 * itself recognises it (`settlementDeductedFees` posts each to its treatment's
 * account), so it is nobody's cash here; off the plan nothing posts it at all
 * (SCRUM-443 v6, Sol F1).
 */
export type HandoverScope = { planRecognisesDeductions: boolean };

/** The scope of callers that do not judge a route (payment-family tests, the proof): deductions are the plan's. */
const PLAN_SCOPE: HandoverScope = { planRecognisesDeductions: true };

/**
 * The two states of a REAL cost (dealer-borne, a handover fee type, a positive
 * readable actual) that NO supported payment source can settle, so it would
 * reach no ledger account at all:
 *
 *  - UNSUPPORTED_TREATMENT   — its treatment is not one a payment posts against
 *                              (capitalized to the vehicle, a receivable, ...).
 *  - DEDUCTION_NOT_RECOGNISED — withheld from a settlement no configured plan
 *                              recognises (a cash / off-plan deal).
 */
function unsupportedSourceState(line: HandoverPaymentLine, scope: HandoverScope): "UNSUPPORTED_TREATMENT" | "DEDUCTION_NOT_RECOGNISED" | null {
  if (line.voidedAt !== undefined) return null;
  if (!HANDOVER_LINE_FEE_TYPES.has(line.feeType)) return null;
  if (line.paidBy !== "DEALER" && line.paidBy !== "EMPLOYEE") return null;
  const actual = line.actualAmountMinor;
  if (actual === undefined || !isMinorAmount(actual) || actual <= 0) return null;
  const deducted = line.deductedFromSettlement === true;
  if (deducted && scope.planRecognisesDeductions) return null;
  if (!CUSTODY_POSTABLE_TREATMENTS.has(line.accountingTreatment)) return "UNSUPPORTED_TREATMENT";
  return deducted ? "DEDUCTION_NOT_RECOGNISED" : null;
}

/**
 * The payment state of one line.
 *
 *  - NOT_HANDOVER_LINE — outside the invariant.
 *  - NO_ACTUAL         — a handover line nobody has said the cost of. BLOCKING
 *                        (an unknown is not a zero, on every route).
 *  - ZERO_ACTUAL       — "the dealership was charged nothing": a fact with no
 *                        journal. Exempt.
 *  - PAID_CUSTODY      — charged to the employee custody that paid it, and the
 *                        live custody posting is that custody at that amount.
 *  - PAID_DIRECT       — a live direct payment whose amount is the actual.
 *  - UNPAID            — a real actual with neither. BLOCKING.
 *  - UNSUPPORTED_TREATMENT / DEDUCTION_NOT_RECOGNISED — a real cost no supported
 *                        source can pay (see `unsupportedSourceState`). BLOCKING.
 *  - CONFLICT          — carries BOTH a custody posting and a direct payment,
 *                        which would put the one cost on the books twice.
 *                        BLOCKING; no writer produces it.
 */
export type HandoverPaymentState =
  | "NOT_HANDOVER_LINE"
  | "NO_ACTUAL"
  | "ZERO_ACTUAL"
  | "PAID_CUSTODY"
  | "PAID_DIRECT"
  | "UNPAID"
  | "UNSUPPORTED_TREATMENT"
  | "DEDUCTION_NOT_RECOGNISED"
  | "CONFLICT";

export function handoverPaymentState(line: HandoverPaymentLine, scope: HandoverScope = PLAN_SCOPE): HandoverPaymentState {
  if (!isHandoverLine(line)) return unsupportedSourceState(line, scope) ?? "NOT_HANDOVER_LINE";
  const actual = line.actualAmountMinor;
  if (actual === undefined) return "NO_ACTUAL";
  // Checked positively: NaN, a fraction or a negative is not a figure anybody
  // paid, and none of them satisfies "paid" below.
  if (!isMinorAmount(actual)) return "UNPAID";
  if (actual === 0) return "ZERO_ACTUAL";
  if (line.custodyPosted !== undefined && line.directPayment !== undefined) return "CONFLICT";
  const custodyPaid =
    line.custodyId !== undefined &&
    line.custodyPosted !== undefined &&
    line.custodyPosted.custodyId === line.custodyId &&
    line.custodyPosted.amountMinor === actual;
  if (custodyPaid) return "PAID_CUSTODY";
  if (line.directPayment !== undefined && line.directPayment.amountMinor === actual) return "PAID_DIRECT";
  return "UNPAID";
}

/** Whether a line in this state stops the deal from finalizing. */
export function handoverStateBlocks(state: HandoverPaymentState): boolean {
  return (
    state === "NO_ACTUAL" ||
    state === "UNPAID" ||
    state === "CONFLICT" ||
    state === "UNSUPPORTED_TREATMENT" ||
    state === "DEDUCTION_NOT_RECOGNISED"
  );
}

/** The live handover lines that are neither custody-paid nor direct-paid (nor zero). */
export function blockingHandoverLines<T extends HandoverPaymentLine & { _id: Id<"financeDealFees"> }>(
  liveFees: ReadonlyArray<T>,
  scope: HandoverScope = PLAN_SCOPE
): T[] {
  return liveFees.filter((fee) => handoverStateBlocks(handoverPaymentState(fee, scope)));
}

/**
 * Why a direct payment cannot be recorded on this line right now, or `null`
 * when it may — worded as the next step, because the screen shows it (R6, no
 * dead ends). The mutation refuses on exactly this and `listDealCosts` serves
 * `directPaymentEligible` from the same call.
 *
 * A line is directly payable only when the DEALERSHIP paid it and nothing else
 * has: no custody link, no custody posting and no direct payment already
 * standing. There is no writer that changes `paidBy`, so a line can never carry
 * both.
 */
export function directPaymentRefusal(line: HandoverPaymentLine): string | null {
  if (line.voidedAt !== undefined) {
    return "This cost has been removed, so no payment can be recorded against it. Add the cost again if it was paid.";
  }
  // A real dealer-borne cost whose treatment no payment posts against: say so,
  // and name the door — this deal cannot pay it from any source as recorded.
  if (
    !isHandoverLine(line) &&
    line.deductedFromSettlement !== true &&
    unsupportedSourceState(line, { planRecognisesDeductions: false }) === "UNSUPPORTED_TREATMENT"
  ) {
    return `This cost is treated as ${line.accountingTreatment}, which no payment can be recorded against, so it would never reach the ledger. Remove the cost and record it again with a treatment that posts (appraisal, insurance, ownership transfer, finance-company commission or selling expense). Nothing has been recorded.`;
  }
  if (!isHandoverLine(line)) {
    return "Only a handover cost the dealership bears (not deducted from the finance company's settlement) is paid this way. Nothing has been recorded.";
  }
  if (line.paidBy !== "DEALER") {
    return "This cost was recorded as paid by an employee, so it is settled from that employee's custody cash: open custody for them and charge this cost to it. Nothing has been recorded.";
  }
  if (line.custodyId !== undefined || line.custodyPosted !== undefined) {
    return "This cost is already charged to an employee's custody, so it cannot also be paid directly. Release it from custody first if the dealership paid it. Nothing has been recorded.";
  }
  if (line.directPayment !== undefined) {
    return "A direct payment is already recorded for this cost. Change the cost's amount or remove it if that payment was wrong. Nothing has been recorded.";
  }
  const actual = line.actualAmountMinor;
  if (actual === undefined || !isMinorAmount(actual) || actual <= 0) {
    return "Record what this cost actually came to (more than zero) before recording its payment. Nothing has been recorded.";
  }
  return null;
}
