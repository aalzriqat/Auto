import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { QueryCtx, MutationCtx } from "../_generated/server";
import { assertMajorAmountRepresentable, toMinorUnits } from "./money";
import { assertVehicleNotDeleted } from "./vehicleLiveness";

/**
 * Below-minimum-profit approval — the third of the three approval workflows
 * `CLAUDE.md` documents.
 *
 * SCRUM-260. The server decides, from values it owns, whether a price is below
 * the vehicle's minimum profit, and an approval authorizes exactly the priced
 * state the manager saw. The caller's own `desiredProfit` is never authority:
 * the wizard folds an editable base price and that profit into one price, so
 * the two could disagree and the smaller claim used to win.
 *
 * Margin is the LIST-PRICE SPREAD, `salePrice − vehicle.sellingPrice`, which is
 * how every client already measures "profit" for this control. It is a
 * discount-approval measure, not the dealership's accounting margin (SOURCED
 * cars are consignment and use agent-sale economics elsewhere).
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
 * Whether a completing sale is subject to the minimum. A sale is exempt only
 * when it is cash on both counts: its financing type (an omitted type is the
 * legacy direct-sale default, CASH) and, when it came from a quote, that
 * quote's mode — a legacy quote with no mode is financed, whatever type the
 * completion door recorded.
 */
export function saleRequiresMinimumProfit(args: {
  financingType: string | undefined;
  quote: Pick<Doc<"quotes">, "mode"> | null;
}): boolean {
  if ((args.financingType ?? "CASH") !== "CASH") return true;
  return args.quote !== null && quoteModeRequiresMinimumProfit(args.quote.mode);
}

/** The priced state an approval is bound to. Every amount is in minor units. */
export type ProfitTerms = {
  salePriceMinor: number;
  listPriceMinor: number;
  minimumProfitMinor: number;
  currency: string;
};

export type ProfitDecision = ProfitTerms & {
  marginMinor: number;
  /**
   * True when the price is below a configured positive minimum and needs a
   * manager's approval. A minimum of 0 or unset is no minimum — the vehicle
   * form's default, and the rule's meaning before SCRUM-260.
   */
  required: boolean;
};

/**
 * The server's verdict for selling `vehicle` at `salePrice` in `currency`.
 *
 * Fails closed: a price, list price or minimum that is not a finite amount
 * representable in the currency throws rather than rounding into a threshold
 * nobody configured.
 */
export function profitDecision(
  vehicle: Pick<Doc<"vehicles">, "sellingPrice" | "minimumProfit">,
  salePrice: number,
  currency: string
): ProfitDecision {
  const minimumProfit = vehicle.minimumProfit ?? 0;
  assertMajorAmountRepresentable(salePrice, currency, "Sale price");
  assertMajorAmountRepresentable(vehicle.sellingPrice, currency, "Vehicle list price");
  assertMajorAmountRepresentable(minimumProfit, currency, "Vehicle minimum profit");

  const salePriceMinor = toMinorUnits(salePrice, currency);
  const listPriceMinor = toMinorUnits(vehicle.sellingPrice, currency);
  const minimumProfitMinor = toMinorUnits(minimumProfit, currency);
  const marginMinor = salePriceMinor - listPriceMinor;
  return {
    salePriceMinor,
    listPriceMinor,
    minimumProfitMinor,
    currency,
    marginMinor,
    required: minimumProfitMinor > 0 && marginMinor < minimumProfitMinor,
  };
}

/** Whether a request row was recorded for exactly these terms. */
export function requestMatchesTerms(
  request: Doc<"profitApprovalRequests">,
  terms: ProfitTerms
): boolean {
  return (
    request.salePriceMinor === terms.salePriceMinor &&
    request.listPriceMinor === terms.listPriceMinor &&
    request.minimumProfitMinor === terms.minimumProfitMinor &&
    request.currency === terms.currency
  );
}

/**
 * The org's requests on this vehicle recorded for exactly `terms`, newest
 * first. Rows written before SCRUM-260 carry no terms and never match.
 *
 * Matched per vehicle, not per salesperson: the control is "a manager signed
 * off on this car at this price", and tying it to whoever submits would falsely
 * block ordinary desk handovers.
 */
export async function requestsForTerms(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">,
  terms: ProfitTerms
): Promise<Doc<"profitApprovalRequests">[]> {
  const requests = await ctx.db
    .query("profitApprovalRequests")
    .withIndex("by_org_vehicle_salePrice", (q) =>
      q.eq("orgId", orgId).eq("vehicleId", vehicleId).eq("salePriceMinor", terms.salePriceMinor)
    )
    .order("desc")
    .collect();
  return requests.filter((request) => requestMatchesTerms(request, terms));
}

/**
 * Throws unless selling `vehicle` at `salePrice` clears its minimum profit, or
 * a manager APPROVED a request for exactly that price, list price, minimum and
 * currency. Any change to one of them needs a new approval.
 */
export async function assertProfitApproved(
  ctx: QueryCtx | MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicle: Doc<"vehicles">;
    salePrice: number;
    currency: string;
    /** Names the operation in the error, e.g. "quote" or "sale". */
    subject: string;
  }
): Promise<void> {
  if (args.vehicle.orgId !== args.orgId) {
    throw new ConvexError("Vehicle not found in this organization.");
  }
  // SCRUM-641 (D-35): a stale APPROVED row never carries authority for a deleted car.
  assertVehicleNotDeleted(args.vehicle);
  const decision = profitDecision(args.vehicle, args.salePrice, args.currency);
  if (!decision.required) return;

  const matching = await requestsForTerms(ctx, args.orgId, args.vehicle._id, decision);
  if (!matching.some((request) => request.status === "APPROVED")) {
    throw new ConvexError(
      `This ${args.subject} is below the minimum profit set for this vehicle and has not been approved at this price. Request approval before continuing.`
    );
  }
}
