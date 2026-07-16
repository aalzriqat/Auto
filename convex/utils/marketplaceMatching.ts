import { makesMatch, modelsMatch } from "../../lib/vehicleCatalog";

/**
 * Pure buyer↔vehicle match scoring for the two-tier marketplace fan-out.
 * Kept dependency-free (no ctx, no db) so the ranking is unit-testable in
 * isolation and can't silently drift when the mutation around it changes.
 *
 * Weights encode the plan's priority order:
 *   model exact > year in range > within budget/monthly > finance fit.
 * A make-matched (or make-unspecified) vehicle is already worth listing, so it
 * carries a base weight that keeps any inventory match above a Tier-B ELIGIBLE
 * (sourcing-only) row, which scores zero.
 */
export const MATCH_WEIGHTS = {
  MAKE: 20,
  MODEL_EXACT: 100,
  YEAR_IN_RANGE: 40,
  PRICE_IN_RANGE: 30,
  WITHIN_MONTHLY_BUDGET: 30,
  FINANCE_AVAILABLE: 10,
} as const;

export type MatchRequestCriteria = {
  make?: string;
  model?: string;
  yearMin?: number;
  yearMax?: number;
  priceMin?: number;
  priceMax?: number;
  paymentType: "CASH" | "FINANCE" | "EITHER";
  monthlyBudget?: number;
};

export type CandidateVehicle = {
  make: string;
  model: string;
  year?: number | null;
  price?: number | null;
};

export type VehicleMatchScore = { score: number; reasons: string[] };

function withinRange(value: number, min: number | undefined, max: number | undefined): boolean {
  if (min === undefined && max === undefined) return false;
  if (min !== undefined && value < min) return false;
  if (max !== undefined && value > max) return false;
  return true;
}

/**
 * Scores one candidate vehicle against a request. Returns null when the buyer
 * named a make and this vehicle isn't that make (canonical/aliased compare) —
 * i.e. not a candidate at all. Otherwise returns an additive score plus the
 * reason codes that earned it, for the buyer-facing "why this matched" list.
 */
export function scoreVehicleAgainstRequest(
  req: MatchRequestCriteria,
  vehicle: CandidateVehicle,
  opts: { monthlyEstimate?: number | null; financeAvailable: boolean }
): VehicleMatchScore | null {
  if (req.make && !makesMatch(req.make, vehicle.make)) return null;

  const reasons: string[] = [];
  let score = MATCH_WEIGHTS.MAKE;
  reasons.push("make_match");

  if (req.model && modelsMatch(req.model, vehicle.model)) {
    score += MATCH_WEIGHTS.MODEL_EXACT;
    reasons.push("model_exact");
  }
  if (vehicle.year != null && withinRange(vehicle.year, req.yearMin, req.yearMax)) {
    score += MATCH_WEIGHTS.YEAR_IN_RANGE;
    reasons.push("year_in_range");
  }
  if (vehicle.price != null && withinRange(vehicle.price, req.priceMin, req.priceMax)) {
    score += MATCH_WEIGHTS.PRICE_IN_RANGE;
    reasons.push("price_in_range");
  }
  if (opts.monthlyEstimate != null && req.monthlyBudget != null && opts.monthlyEstimate <= req.monthlyBudget) {
    score += MATCH_WEIGHTS.WITHIN_MONTHLY_BUDGET;
    reasons.push("within_monthly_budget");
  }
  if ((req.paymentType === "FINANCE" || req.paymentType === "EITHER") && opts.financeAvailable) {
    score += MATCH_WEIGHTS.FINANCE_AVAILABLE;
    reasons.push("finance_available");
  }

  return { score, reasons };
}
