import type { Doc, Id } from "../_generated/dataModel";
import { deriveFeeStatus, type FeeAmountsUnreadableReason } from "./feeSummary";
import { isMinorAmount } from "./financingEconomics";
import { exactTemplateLine } from "./settlementDeductions";

/** One configured fee, as the application's frozen rule snapshot carries it. */
type FeeTemplate = NonNullable<
  NonNullable<Doc<"financeApplications">["companyRuleSnapshot"]>["feeTemplates"]
>[number];

/** Display-only identity used to flag duplicate configured rows; never a match key. */
function templateIdentity(template: { feeType: string; description?: string }): string {
  return `${template.feeType}|${(template.description ?? "").trim().toLowerCase()}`;
}

export type ExpectedFeeRow = {
  /** Position in the frozen snapshot — the ONLY stable reference to this template. */
  templateIndex: number;
  feeType: FeeTemplate["feeType"];
  description: string | undefined;
  /**
   * The template's frozen estimate — or `null` with `expectedAmountReason`
   * when the stored value is not a readable minor-unit figure. The snapshot
   * is never rewritten to repair it; the row keeps its identity (type,
   * description, payer, treatment) so the position stays addressable, and
   * only the money is withheld.
   */
  expectedAmountMinor: number | null;
  expectedAmountReason: FeeAmountsUnreadableReason | null;
  paidBy: FeeTemplate["paidBy"];
  paidTo: FeeTemplate["paidTo"];
  includedInQuotation: boolean;
  deductedFromSettlement: boolean;
  refundable: boolean;
  accountingTreatment: FeeTemplate["accountingTreatment"];
  /**
   * Another template in the same snapshot shares this one's feeType and
   * description. Addressing by position keeps the two distinct, so an actual
   * recorded against one never satisfies the other; the flag exists so a
   * screen can label the pair.
   */
  duplicateIdentity: boolean;
  /**
   * The live line that records this fee's actual — the one
   * `recordTemplateFeeActual` wrote against this position, and nothing else.
   */
  actual: {
    feeId: Id<"financeDealFees">;
    actualAmountMinor: number | undefined;
    currency: string;
    status: ReturnType<typeof deriveFeeStatus>;
  } | null;
};

/**
 * The expected side of the handover-cost checklist, derived READ-ONLY from
 * the application's frozen `companyRuleSnapshot.feeTemplates` (owner product
 * correction, #scrum-215 2026-09-12 21:05).
 *
 * The rules a deal was created under are the rules it is costed against. The
 * snapshot is written once at application creation and never re-read from the
 * live company, so editing the company's fees next month changes what FUTURE
 * deals expect and leaves this one exactly as it was — the same property the
 * LTV and tolerance rules already have. Nothing here reads `financeCompanies`.
 *
 * What is NOT invented:
 *   - a deal with no snapshot, or a snapshot with no templates, has no expected
 *     rows and a null expected total — "not configured" is reported as such,
 *     never as zero;
 *   - the expected total sums the configured template estimates only; the
 *     actual total sums recorded actuals only (every live line, template or
 *     unplanned); their difference is a COMPARISON and is never an amount
 *     assumed still payable;
 *   - an unplanned line (no template) leaves the expected total untouched.
 *
 * Denomination: the snapshot carries no currency. Template amounts were
 * entered under the organisation's currency, which the SCRUM-319 lock freezes
 * once any cost or custody row exists, and the deal's lines are kept in that
 * same currency — so the expected figures are stated in the deal currency the
 * caller passes. The comparison is withheld (null) whenever the actual total
 * is, i.e. over mixed-denomination lines.
 *
 * Matching an actual to its template is EXACT or nothing. A line written by
 * `recordTemplateFeeActual` carries the template's POSITION and is the only
 * line a configured row ever shows as its actual, duplicates or not. A
 * COMPANY_TEMPLATE line with no position — from before that writer, or
 * written to the table by anything else — is never attached to a configured
 * row, however well its feeType and description happen to match: attaching it
 * would show the fee as recorded and hide the exact record action while
 * closure (which trusts positions only) still refused, and once the exact
 * line was recorded both would count toward the actual total. Such a line
 * stays visible as an unplanned/history line instead. The same stable
 * reference governs the checklist and the closure gate.
 */
export function deriveExpectedFees(args: {
  snapshot: Doc<"financeApplications">["companyRuleSnapshot"];
  /** Live (non-void) lines on the deal. */
  fees: Array<Doc<"financeDealFees">>;
  /** The deal's currency, as `listDealCosts` resolves it. */
  currency: string;
  /** Null when the recorded actuals cannot be summed (mixed denomination). */
  actualTotalMinor: number | null;
}): {
  source: "COMPANY_RULE_SNAPSHOT" | "NO_SNAPSHOT" | "NO_TEMPLATES";
  currency: string;
  rows: ExpectedFeeRow[];
  /**
   * Sum of the configured template estimates; null when nothing is
   * configured, and null with `expectedTotalReason` when any configured
   * estimate is unreadable or the sum leaves the safe range.
   */
  expectedTotalMinor: number | null;
  expectedTotalReason: FeeAmountsUnreadableReason | null;
  /** Sum of recorded actuals over every live line, template or unplanned; null over mixed denomination. */
  actualTotalMinor: number | null;
  /** expected − actual, a comparison only; null whenever either side is. */
  differenceMinor: number | null;
  /** Live lines outside the checklist: unplanned costs, and template lines that carry no position (legacy or otherwise). */
  unplannedLineIds: Id<"financeDealFees">[];
} {
  const templates = args.snapshot?.feeTemplates;
  const source =
    args.snapshot === undefined
      ? ("NO_SNAPSHOT" as const)
      : !templates || templates.length === 0
        ? ("NO_TEMPLATES" as const)
        : ("COMPANY_RULE_SNAPSHOT" as const);
  const configured = source === "COMPANY_RULE_SNAPSHOT" && templates ? templates : [];

  const identityCounts = new Map<string, number>();
  for (const template of configured) {
    const key = templateIdentity(template);
    identityCounts.set(key, (identityCounts.get(key) ?? 0) + 1);
  }

  const claimed = new Set<Id<"financeDealFees">>();
  const rows: ExpectedFeeRow[] = configured.map((template, templateIndex) => {
    const duplicateIdentity = (identityCounts.get(templateIdentity(template)) ?? 0) > 1;

    // The line that names this position, or nothing — the same matcher the
    // closure gates use, so the checklist cannot show a row as recorded that
    // classification or finalization would refuse.
    const matched = exactTemplateLine(args.fees, templateIndex);
    if (matched) claimed.add(matched._id);

    // Validated positively on the way OUT of the frozen snapshot: the writers
    // assert this rule, the schema does not, and a legacy or raw-edited
    // template carries whatever it carries. The money is withheld per row
    // with the reason; nothing about the snapshot is changed.
    const expectedReadable = isMinorAmount(template.estimatedAmountMinor);

    return {
      templateIndex,
      feeType: template.feeType,
      description: template.description,
      expectedAmountMinor: expectedReadable ? template.estimatedAmountMinor : null,
      expectedAmountReason: expectedReadable ? null : "UNSAFE_AMOUNT",
      paidBy: template.paidBy,
      paidTo: template.paidTo,
      includedInQuotation: template.includedInQuotation,
      deductedFromSettlement: template.deductedFromSettlement,
      refundable: template.refundable,
      accountingTreatment: template.accountingTreatment,
      duplicateIdentity,
      actual: matched
        ? {
            feeId: matched._id,
            actualAmountMinor: matched.actualAmountMinor,
            currency: matched.currency,
            status: deriveFeeStatus(matched),
          }
        : null,
    };
  });

  // One unreadable row, or a sum that leaves the safe range, withholds the
  // total and everything compared against it — never a partial or corrupt
  // figure wearing a total's name.
  const expectedSum =
    source === "COMPANY_RULE_SNAPSHOT" && rows.every((row) => row.expectedAmountMinor !== null)
      ? rows.reduce((total, row) => total + (row.expectedAmountMinor ?? 0), 0)
      : null;
  const expectedTotalReason: FeeAmountsUnreadableReason | null =
    source === "COMPANY_RULE_SNAPSHOT" && (expectedSum === null || !Number.isSafeInteger(expectedSum))
      ? "UNSAFE_AMOUNT"
      : null;
  const expectedTotalMinor = expectedTotalReason === null ? expectedSum : null;
  const differenceMinor =
    expectedTotalMinor !== null && args.actualTotalMinor !== null
      ? expectedTotalMinor - args.actualTotalMinor
      : null;

  return {
    source,
    currency: args.currency,
    rows,
    expectedTotalMinor,
    expectedTotalReason,
    actualTotalMinor: args.actualTotalMinor,
    differenceMinor,
    unplannedLineIds: args.fees.filter((fee) => !claimed.has(fee._id)).map((fee) => fee._id),
  };
}
