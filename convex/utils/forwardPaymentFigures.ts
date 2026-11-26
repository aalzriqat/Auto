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
};

export function forwardPaymentFigures(plan: ForwardPlanFigures, onBooksMinor: number) {
  return {
    dueMinor: plan.forwardDueMinor,
    depositMinor: plan.forwardDepositMinor,
    approvalExcessMinor: plan.approvalExcessMinor ?? 0,
    contributionMinor: plan.forwardContributionMinor,
    onBooksMinor,
  };
}
