import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { computeExpectedRemittance } from "../../lib/financingEconomics";
import {
  buildFinancedSalePostingPlan,
  type FinancedSalePostingPlan,
  type SettlementComponentInput,
} from "./financedSalePostingPlan";
import {
  settlementDeductedActualMinor,
  settlementDeductedFees,
} from "./settlementDeductions";
import { heldDepositRowsForVehicle } from "./saleCompletion";
import { liveAppliedMinorForDeposit } from "./depositApplications";
import { toMinorUnits } from "./money";

/**
 * Turns one finance application into the plan its sale will post from, or
 * refuses.
 *
 * Everything here is read from the record. No figure is supplied by a caller,
 * none is inferred from the gap between two others, and there is no partial
 * result: either the whole plan is derivable or finalization stops before it has
 * written anything.
 */

/** Deals this model covers. Everything else posts the way it always did. */
export function financedSaleRecognitionApplies(
  app: Doc<"financeApplications">,
  opts: { settlesDirect: boolean }
): boolean {
  // On the direct route the financing company pays the supplier, so no
  // dealership-side finance receivable exists to recognise. Without a configured
  // company there is no counterparty to owe one.
  if (opts.settlesDirect) return false;
  return app.companyId !== undefined;
}

export async function resolveFinancedSalePlan(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">,
  opts: {
    settlesDirect: boolean;
    currency: string;
    /**
     * What the operator said happens to any held deposit.
     *
     * Only an application to THIS purchase becomes `H`. A refund, forfeiture or
     * offset against something the customer separately owes leaves the money in
     * the deposit liability where its receipt put it, and the financing company
     * still owes the whole settlement.
     */
    depositTreatment?: string;
  }
): Promise<FinancedSalePostingPlan | undefined> {
  if (!financedSaleRecognitionApplies(app, opts)) return undefined;

  const fees = await settlementDeductedFees(ctx, app._id);
  const feeDeductionsMinor = settlementDeductedActualMinor(fees);

  const snapshot = app.companyRuleSnapshot;
  const dealerContributionSettlement =
    app.dealerContributionSettlement ??
    snapshot?.dealerContributionSettlement ??
    "PAID_SEPARATELY";
  const customerContributionSettlement =
    app.customerContributionSettlement ??
    snapshot?.customerContributionSettlement ??
    "PASSED_THROUGH";
  const dealerContributionMinor = app.dealerContributionMinor ?? 0;

  // A contribution the company nets out of the settlement is part of what it
  // withholds, so it has to appear in the journal as its own classified line.
  // Nothing on the record says WHICH line: the twelve accounting treatments are
  // recorded per cost row, and a contribution is not a cost row. Guessing one —
  // a concession, an expense, a discount — would post real money to an account
  // nobody chose, and the three plausible answers land in different places on
  // the P&L.
  //
  // So this refuses, and says what is missing. It is the same rule the plan
  // builder applies to a fee whose treatment has no mapping; the only difference
  // is that here the treatment does not exist to be mapped.
  if (
    dealerContributionSettlement === "NETTED_FROM_REMITTANCE" &&
    dealerContributionMinor > 0
  ) {
    throw new ConvexError(
      "This financing company keeps the dealership's contribution out of what it transfers, and nothing on this deal records how that amount should be accounted for. Record it as a settlement-deducted cost with its own accounting treatment before finalizing."
    );
  }

  const grossDealerSettlementMinor =
    app.approvedDealerPurchaseAmountMinor === undefined
      ? undefined
      : computeExpectedRemittance({
          approvedDealerPurchaseAmountMinor: app.approvedDealerPurchaseAmountMinor,
          dealerContributionMinor,
          dealerContributionSettlement,
          customerContributionToFinanceCompanyMinor:
            app.customerContributionToFinanceCompanyMinor ?? 0,
          customerContributionSettlement,
          feeDeductionsMinor,
        }).grossRemittanceMinor;

  const components: SettlementComponentInput[] = fees
    .filter((fee) => fee.actualAmountMinor !== undefined)
    .map((fee) => ({
      sourceKind: "FEE" as const,
      sourceId: fee._id,
      label: fee.description?.trim() || humanizeFeeType(fee.feeType),
      amountMinor: fee.actualAmountMinor as number,
      treatment: fee.accountingTreatment,
    }));

  // What the customer independently owes the dealership on this deal — the gap
  // they are paying directly, in cash or by instalment. It is NOT the vehicle
  // consideration, which the financing company owes as the legal buyer.
  const customerReceivableMinor =
    (app.customerGapCashToDealerMinor ?? 0) +
    (app.customerGapInstallmentToDealerMinor ?? 0);

  // H — the deposit slice this sale actually consumes, read from the deposit
  // rows holding THIS car. Not `quote.downPayment`, which is an intention
  // recorded on a quote and may never have been paid; not
  // `customerFirstPaymentMinor`, which says what the customer owes toward the
  // purchase without saying who received it. A held deposit row is money that
  // moved, and it names the car it is holding — which is what makes this correct
  // on a quote covering several vehicles, where each sale must take its own
  // slice and no other.
  // H — the deposit slice this sale consumes, proved row by row.
  //
  // The quote index scopes the query to this deal, and the reader filters to the
  // rows still holding THIS vehicle. Everything else about a row is a separate
  // fact that has to be checked rather than assumed: a deposit belonging to
  // another organization, another customer, or denominated in another currency
  // is somebody else's money, and one already consumed by a live application
  // would be spent twice.
  const depositRows = await heldDepositRowsForVehicle(
    ctx as MutationCtx,
    app.quoteId,
    app.vehicleId
  );

  let depositHeldMajor = 0;
  for (const row of depositRows) {
    if (row.orgId !== app.orgId) {
      throw new ConvexError(
        "A deposit recorded against this deal belongs to a different organization. It cannot be applied to this sale."
      );
    }
    if (row.customerId !== app.customerId) {
      throw new ConvexError(
        "A deposit held on this vehicle was paid by a different customer, so it cannot be applied to this purchase. Resolve it separately before finalizing."
      );
    }
    if (row.currency !== undefined && row.currency !== opts.currency) {
      throw new ConvexError(
        "A deposit held on this vehicle is recorded in a different currency from the deal. Resolve it before finalizing rather than converting it here."
      );
    }
    const alreadyApplied = await liveAppliedMinorForDeposit(ctx, row.depositId);
    if (alreadyApplied > 0) {
      throw new ConvexError(
        "A deposit held on this vehicle has already been applied to a sale that still stands. It cannot be applied again."
      );
    }
    depositHeldMajor += row.amount;
  }

  // Only an application to THIS purchase becomes H. A refund, a forfeiture or an
  // offset against a separate customer obligation leaves the money where its
  // receipt put it — in the deposit liability — and the company still owes the
  // whole settlement.
  const depositIsApplied =
    opts.depositTreatment === undefined ||
    opts.depositTreatment === "APPLY_TO_TRANSACTION_SETTLEMENT";

  // `deposits.amount` is MAJOR units, stored the way an operator types it.
  // Passing it through unconverted made a 3,000 deposit reduce the settlement by
  // 3 — arithmetically balanced, and wrong by the whole currency scale.
  const depositLiabilityAppliedMinor =
    depositIsApplied && depositHeldMajor > 0
      ? toMinorUnits(depositHeldMajor, opts.currency)
      : 0;

  // The same customer money cannot be counted twice — once as a contribution the
  // financing company received and netted out of its transfer, and again as a
  // deposit the dealership holds. Whichever it actually was, it happened once.
  if (
    depositLiabilityAppliedMinor > 0 &&
    (app.customerContributionToFinanceCompanyMinor ?? 0) > 0
  ) {
    throw new ConvexError(
      "This deal records the customer's money both as a deposit held by the dealership and as a contribution paid to the financing company. Record which of the two actually happened before finalizing."
    );
  }

  const result = buildFinancedSalePostingPlan({
    currency: opts.currency,
    legalInvoiceConsiderationMinor: app.legalInvoiceAmountMinor,
    legalInvoiceIssuedTo: app.legalInvoiceIssuedTo,
    financierIsConfiguredExternal: true,
    grossDealerSettlementMinor,
    storedExpectedDealerRemittanceMinor: app.expectedDealerRemittanceMinor,
    components,
    customerReceivableMinor,
    depositLiabilityAppliedMinor,
  });

  // A net payable has a general-ledger account but no canonical subledger, and
  // c16206 requires the two to tie exactly. Reusing the receivable document with
  // a negative amount, or Supplier AP, or a generic account, are each the kind of
  // near-enough answer this whole change exists to remove — so a deal that owes
  // the financing company money refuses here rather than being posted half-
  // tracked. The ledger rule below it is complete and stays that way: the gap is
  // the subledger, not the accounting.
  if (result.ok && result.plan.financeCompanyPayableMinor > 0) {
    throw new ConvexError(
      "On this deal the costs the financing company withholds come to more than it owes the dealership, so the dealership owes the company the difference. Recording that is not supported yet — resolve the settlement costs with the company before finalizing."
    );
  }

  if (!result.ok) {
    // The refusal message is written for the operator and names what to do.
    // Thrown rather than returned so a caller cannot accidentally continue with
    // no plan and post the deal the old way.
    throw new ConvexError(result.refusal.message);
  }
  return result.plan;
}

/** "OWNERSHIP_TRANSFER" -> "Ownership transfer". Only for a line with no description. */
function humanizeFeeType(feeType: string): string {
  const words = feeType.toLowerCase().replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
