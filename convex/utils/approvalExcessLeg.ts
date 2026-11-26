import { type Doc } from "../_generated/dataModel";
import { type MutationCtx, type QueryCtx } from "../_generated/server";
import { reasonOf, type ClosingReadinessReason } from "../../lib/closingReadinessReasonCodes";
import { readDeliveredFirstPaymentEvidence } from "./firstPaymentEvidence";
import { isManualFinanceApplication } from "./manualFinancePayer";
import { toMinorUnits } from "./money";
import { heldDepositRowsForVehicle } from "./saleCompletion";
import { isConsignedAgentSale } from "./vehicleOwnership";

/**
 * SCRUM-613, the approval excess posting leg.
 *
 * When the finance company's approved financing F plus the customer's first payment P exceeds the approved
 * value A, the part above A is the excess E = F + P - A. Owner rulings (SCRUM-613 comments 25968 and 25987):
 * the finance company transfers A, the excess is dealer income by default, and a deal has a contribution D or
 * an excess E, never both. The finance company is then owed what the dealership still holds for it:
 *
 *     forward = A - F - direct = H - E       (H = held deposit rows, direct = P - H paid to the company)
 *
 * and the sale credits revenue 4100 with A + R + E. This module is the one place that decides whether a deal
 * with an excess is a shape the posting plan supports; the plan builder stays the arithmetic backstop.
 *
 * Every refusal here is a coded closing-readiness reason, returned (never thrown) so the readiness read can
 * serve the specific code, and `finalizeDeal` and the payment to the finance company can throw the same one
 * through `closingRefusalError` before any write.
 */

const SHAPE_UNSUPPORTED = reasonOf(
  "EXCESS_SHAPE_UNSUPPORTED",
  "This approval pays the dealership more than the approved purchase amount. Posting that excess is supported only for a dealership-owned car financed by a configured finance company with the approved financing amount recorded; this deal's car, settlement route or finance company is outside that, so it cannot be finalized or paid forward until accounting reviews it.",
);

const FIRST_PAYMENT_UNPROVEN = reasonOf(
  "EXCESS_FIRST_PAYMENT_UNPROVEN",
  "The customer's first payment is larger than the deposit the dealership holds, and no payment to the finance company is confirmed for the rest. Confirm the customer's payment to the finance company, or correct the first payment, before finalizing or paying the finance company.",
);

const EXCEEDS_HELD_DEPOSIT = reasonOf(
  "EXCESS_EXCEEDS_HELD_DEPOSIT",
  "The excess on this approval is larger than the deposit the dealership holds, so it cannot be kept out of what the dealership owes the finance company. Correct the approved financing amount or the first payment before finalizing.",
);

const DIRECT_EXCEEDS_UNFUNDED = reasonOf(
  "EXCESS_DIRECT_EXCEEDS_UNFUNDED",
  "The customer's payment to the finance company is more than the part of the approved value the company does not fund, so the company would owe money back. Correct the approved financing amount or the confirmed payment before finalizing.",
);

/**
 * Why a deal whose approval carries an excess cannot be posted or paid forward, or `null` when it can (and
 * always `null` for a deal with no excess, so every other deal is untouched). Reads only; call it before any
 * write. The held rows and the first-payment proof are read the way `resolveFinancedSalePlan` reads them.
 */
export async function approvalExcessRefusal(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">,
  opts: { settlesDirect: boolean; currency: string },
): Promise<ClosingReadinessReason | null> {
  const excessMinor = app.approvalExcessMinor ?? 0;
  if (excessMinor <= 0) return null;
  const approvedMinor = app.approvedDealerPurchaseAmountMinor;
  const financingMinor = app.approvedFinancingAmountMinor;
  const firstPaymentMinor = app.customerFirstPaymentMinor;
  if (
    opts.settlesDirect ||
    isManualFinanceApplication(app) ||
    app.companyId === undefined ||
    approvedMinor === undefined ||
    financingMinor === undefined ||
    firstPaymentMinor === undefined
  ) {
    return SHAPE_UNSUPPORTED;
  }
  const vehicle = await ctx.db.get(app.vehicleId);
  if (vehicle === null || isConsignedAgentSale(vehicle)) return SHAPE_UNSUPPORTED;

  const rows = await heldDepositRowsForVehicle(ctx as MutationCtx, app.quoteId, app.vehicleId);
  const heldMajor = rows.reduce((total, row) => total + row.amount, 0);
  const heldMinor = heldMajor > 0 ? toMinorUnits(heldMajor, opts.currency) : 0;

  // The part of P that is not in the dealership's hands must be proven as paid to the finance company. A deal
  // that records the evidence (every deal handed over since the evidence rule) states it; an older row states
  // none, so for it P must be wholly held.
  const proof = await readDeliveredFirstPaymentEvidence(ctx, app, opts);
  if (proof !== undefined && proof.status !== "READY") return FIRST_PAYMENT_UNPROVEN;
  const provenDirectMinor = proof?.status === "READY" ? proof.directMinor : 0;
  if (heldMinor + provenDirectMinor < firstPaymentMinor) return FIRST_PAYMENT_UNPROVEN;

  if (heldMinor < excessMinor) return EXCEEDS_HELD_DEPOSIT;
  // direct = P - H; the company is owed A - F in all, so what it still gets from the dealership is
  // A - F - direct, which must not be negative.
  if (firstPaymentMinor - heldMinor > approvedMinor - financingMinor) return DIRECT_EXCEEDS_UNFUNDED;
  return null;
}
