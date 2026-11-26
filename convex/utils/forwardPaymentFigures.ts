import { v } from "convex/values";

/**
 * The figures of the payment to the finance company, as the deal screen is served them BEFORE the sale
 * (`preFinalizeForwardStatus.money`). The cockpit's `money.forward` carries the same names after the sale.
 *
 * SCRUM-998 #17: `approvalExcessMinor` is E, the part of the held deposit H that the dealership keeps as income.
 * `depositMinor` is H - E (what is forwarded), so `depositMinor + approvalExcessMinor` is the held deposit H.
 * Read-only presentation of the plan's own figures; nothing here is posted or validated.
 */
export const forwardPaymentFiguresValidator = v.object({
  dueMinor: v.number(),
  depositMinor: v.number(),
  approvalExcessMinor: v.number(),
  contributionMinor: v.number(),
  onBooksMinor: v.number(),
});

export type ForwardPlanFigures = {
  forwardDueMinor: number;
  forwardDepositMinor: number;
  forwardContributionMinor: number;
  approvalExcessMinor?: number;
  /** H as the plan itself reports it; when given, the split must add up to it. */
  depositLiabilityAppliedMinor?: number;
};

/**
 * THE one place the deposit split is formed, for every reader (pre-sale status and cockpit):
 * held deposit H = deposit forwarded (H - E) + excess kept as dealer income (E). When the caller knows H
 * independently (`expectedHeldMinor`, the plan's own figure) the sum is asserted against it, so a figure that
 * does not add up is refused instead of shown.
 */
export function forwardDepositSplit(args: {
  forwardDepositMinor: number;
  approvalExcessMinor?: number;
  expectedHeldMinor?: number;
}) {
  const approvalExcessMinor = args.approvalExcessMinor ?? 0;
  const heldDepositMinor = args.forwardDepositMinor + approvalExcessMinor;
  if (args.expectedHeldMinor !== undefined && args.expectedHeldMinor !== heldDepositMinor) {
    throw new Error("The deposit forwarded plus the excess does not equal the held deposit.");
  }
  return { heldDepositMinor, depositForwardedMinor: args.forwardDepositMinor, approvalExcessMinor };
}

export function forwardPaymentFigures(plan: ForwardPlanFigures, onBooksMinor: number) {
  const split = forwardDepositSplit({
    forwardDepositMinor: plan.forwardDepositMinor,
    approvalExcessMinor: plan.approvalExcessMinor,
    expectedHeldMinor: plan.depositLiabilityAppliedMinor,
  });
  return {
    dueMinor: plan.forwardDueMinor,
    depositMinor: split.depositForwardedMinor,
    approvalExcessMinor: split.approvalExcessMinor,
    contributionMinor: plan.forwardContributionMinor,
    onBooksMinor,
  };
}
