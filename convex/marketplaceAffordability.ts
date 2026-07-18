import { v } from "convex/values";
import { query, QueryCtx } from "./_generated/server";
import { calculateMaximumAffordableVehiclePrice } from "../lib/financing";
import { listOptedInDealerProfiles } from "./marketplaceDealers";
import { hasPlanFeature } from "./subscriptions";
import { getPublishedSnapshotData } from "./websites";

/**
 * Reverse finance: "what price can I afford?" Given a buyer's monthly ceiling +
 * down payment + term, returns the RANGE of maximum affordable vehicle prices
 * across the finance terms marketplace dealers actually publish — the number
 * that lets the request wizard show value ("مداك التقريبي: 15,800–18,200 دينار")
 * BEFORE asking who the buyer is (house design rule: value before identity).
 *
 * A lower profit rate buys more car for the same installment, so different
 * finance companies yield different ceilings; [min, max] is that real spread.
 * Public + anonymous, like browse/matching — bounded by MAX_CANDIDATES.
 */

const DEFAULT_TERM_MONTHS = 60;
const MAX_CANDIDATES = 60;

type FinanceTerms = {
  profitRate: number;
  maxTermMonths: number;
  gracePeriodMonths?: number;
  insuranceRate?: number;
  adminFees?: number;
  commission?: number;
  includesCommissionInDebt?: boolean;
};

export interface AffordabilityInputs {
  maximumMonthlyPayment: number;
  downPayment: number;
  termMonths: number;
}

export interface AffordabilityRange {
  minPriceJod: number;
  maxPriceJod: number;
  companiesConsidered: number;
  downPayment: number;
  termMonths: number;
}

/** Stable key so two dealers sharing one finance company count once. */
function termsSignature(terms: FinanceTerms): string {
  return [
    terms.profitRate,
    terms.maxTermMonths,
    terms.gracePeriodMonths ?? 0,
    terms.insuranceRate ?? 0,
    terms.adminFees ?? 0,
    terms.commission ?? 0,
    terms.includesCommissionInDebt ?? false,
  ].join("|");
}

/**
 * Pure ranging over a set of finance terms — kept separate from the DB scan so
 * the affordability math is unit-testable without seeding a whole marketplace.
 * Each company's term is capped at its own maxTermMonths; a company that can't
 * finance anything at this budget (price 0) is dropped, not shown as "0 JOD".
 */
export function computeAffordabilityRange(
  termsList: readonly FinanceTerms[],
  inputs: AffordabilityInputs
): AffordabilityRange | null {
  if (!(inputs.maximumMonthlyPayment > 0) || inputs.termMonths <= 0 || inputs.downPayment < 0) {
    return null;
  }

  const prices: number[] = [];
  const seen = new Set<string>();
  for (const terms of termsList) {
    const signature = termsSignature(terms);
    if (seen.has(signature)) continue;
    seen.add(signature);

    const termMonths = Math.min(inputs.termMonths, terms.maxTermMonths);
    if (termMonths <= 0) continue;

    const price = calculateMaximumAffordableVehiclePrice({
      maximumMonthlyPayment: inputs.maximumMonthlyPayment,
      downPayment: inputs.downPayment,
      termMonths,
      financeTerms: {
        annualProfitRate: terms.profitRate,
        annualInsuranceRate: terms.insuranceRate ?? 0,
        commission: terms.commission ?? 0,
        processingFees: terms.adminFees ?? 0,
        gracePeriodMonths: terms.gracePeriodMonths ?? 0,
        includesCommissionInDebt: terms.includesCommissionInDebt ?? false,
      },
    });
    if (price > 0) prices.push(price);
  }

  if (prices.length === 0) return null;
  return {
    minPriceJod: Math.min(...prices),
    maxPriceJod: Math.max(...prices),
    companiesConsidered: prices.length,
    downPayment: inputs.downPayment,
    termMonths: inputs.termMonths,
  };
}

/** Gathers the finance terms published by opted-in dealers with a live site. */
async function collectMarketplaceFinanceTerms(ctx: QueryCtx): Promise<FinanceTerms[]> {
  const profiles = await listOptedInDealerProfiles(ctx, MAX_CANDIDATES);
  const termsList: FinanceTerms[] = [];
  for (const profile of profiles) {
    if (!(await hasPlanFeature(ctx, profile.orgId, "websiteBuilder"))) continue;
    const snapshot = await getPublishedSnapshotData(ctx, profile.orgId);
    const terms = (snapshot?.financeCompany as FinanceTerms | null | undefined) ?? null;
    if (terms && typeof terms.profitRate === "number" && typeof terms.maxTermMonths === "number") {
      termsList.push(terms);
    }
  }
  return termsList;
}

export const getAffordabilityRange = query({
  args: {
    maximumMonthlyPayment: v.number(),
    downPayment: v.optional(v.number()),
    termMonths: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<AffordabilityRange | null> => {
    const inputs: AffordabilityInputs = {
      maximumMonthlyPayment: args.maximumMonthlyPayment,
      downPayment: Math.max(args.downPayment ?? 0, 0),
      termMonths: args.termMonths ?? DEFAULT_TERM_MONTHS,
    };
    if (!(inputs.maximumMonthlyPayment > 0)) return null;

    const termsList = await collectMarketplaceFinanceTerms(ctx);
    return computeAffordabilityRange(termsList, inputs);
  },
});
