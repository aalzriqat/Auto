import { ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { QueryCtx, MutationCtx } from "../_generated/server";

/**
 * Below-minimum-profit approval — the third of the three approval workflows
 * `CLAUDE.md` documents, and the only one that used to live entirely in the UI.
 *
 * `components/sales/wizard/steps/Step1QuoteSetup.tsx` and the mobile sales
 * wizard both block a financed quote whose dealer profit is under the vehicle's
 * `minimumProfit` unless the salesperson holds an APPROVED
 * `profitApprovalRequests` row. Nothing on the backend enforced that, so any
 * caller hitting `quotes.saveQuote` directly — or an older client — wrote the
 * quote anyway and it flowed through to a completed sale with no approval
 * record. Violates the project's own rule: never trust the frontend to enforce
 * business logic.
 *
 * Applies to financed deals only: a CASH quote carries no dealer margin field
 * and is not subject to the minimum, matching the UI's `!isCash` condition.
 */

/**
 * True for every quote mode that carries a dealer margin subject to the
 * vehicle's minimum profit.
 *
 * Deliberately "anything that is not explicitly CASH", including a missing
 * mode: the legacy quick-quote dialog sends no mode and builds financed quotes,
 * and treating unknown as exempt would leave exactly the bypass this guard
 * exists to close.
 */
export function quoteModeRequiresMinimumProfit(mode: string | undefined): boolean {
  return mode !== "CASH";
}

/**
 * Throws unless `desiredProfit` clears the vehicle's `minimumProfit`, or a
 * manager has already approved selling this vehicle at that profit or lower.
 *
 * The approval is matched per vehicle rather than per salesperson: the control
 * being enforced is "someone holding APPROVE_REQUESTS signed off on this
 * vehicle at this margin", and tying it to whoever happens to submit the quote
 * would falsely block ordinary desk handovers. `requestedProfit <=
 * desiredProfit` mirrors the client's own `profit >= approval.requestedProfit`
 * check, so an approval can never authorise a *deeper* discount than the one
 * the manager saw.
 */
export async function assertProfitApproved(
  ctx: QueryCtx | MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    desiredProfit: number;
    /** Names the operation in the error, e.g. "quote" or "deal". */
    subject: string;
  }
): Promise<void> {
  const vehicle = await ctx.db.get(args.vehicleId);
  if (!vehicle || vehicle.orgId !== args.orgId) {
    throw new ConvexError("Vehicle not found in this organization.");
  }

  const minimumProfit = vehicle.minimumProfit ?? 0;
  // NaN fails every comparison, so test for "clears the minimum" positively —
  // `desiredProfit < minimumProfit` would read false for NaN and let it through.
  if (!(minimumProfit > 0) || (Number.isFinite(args.desiredProfit) && args.desiredProfit >= minimumProfit)) {
    return;
  }

  const approvals = await ctx.db
    .query("profitApprovalRequests")
    .withIndex("by_vehicle", (q) => q.eq("vehicleId", args.vehicleId))
    .collect();

  const approved = approvals.some(
    (request) =>
      request.orgId === args.orgId &&
      request.status === "APPROVED" &&
      Number.isFinite(args.desiredProfit) &&
      request.requestedProfit <= args.desiredProfit
  );

  if (!approved) {
    throw new ConvexError(
      `This ${args.subject} is below the minimum profit set for this vehicle and has not been approved. Request approval before continuing.`
    );
  }
}
