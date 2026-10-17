/**
 * SCRUM-350 ACC-1 — the pure judgement of a financed sale of DEALERSHIP-OWNED stock.
 *
 * ACC-1 says a posted event must produce a balanced AND semantically correct entry:
 * balancing alone is insufficient, because wrong accounts or amounts can offset each
 * other. The expected figures are computed here, from the inputs the mission itself
 * chose, by arithmetic the product's posting code is never consulted for.
 *
 * The scenario (JOD-shaped, in major units): a 20,000 car the dealership bought for
 * 15,000, quoted to an 85% financier at 20,000 which approves only A = 18,000; the
 * customer's first payment is a 200 deposit H, the net shortfall is 1,700 of which the
 * customer agrees to pay R = 1,000 in cash, and the dealership records a 300 admin fee
 * it pays itself (not deducted from the financier's transfer).
 *
 *   contribution D = A − funded − H = 18,000 − min(85% × 18,000, A − H) − 200 = 2,500
 *   consideration K = A + R = 19,000          (never the price 20,000)
 *   forward due     = H + D = 2,700           (owed onward to the financier)
 *
 * The financier transfers the FULL approval, so a sale of owned stock posts:
 *
 *   Dr AR-finance A 18,000 · Dr AR-customer R 1,000 · Dr deposit liability H 200
 *   Dr contra-revenue D 2,500 · Dr cost of vehicles sold 15,000
 *     Cr sales revenue K 19,000 · Cr AP-finance H + D 2,700 · Cr vehicle inventory 15,000
 *
 * (debits 36,700 = credits 36,700). The admin fee is a cost of the deal: it never reduces
 * the financier's receivable, the revenue or the contra account, and it is not income.
 *
 * Why this scenario can certify: each plausible wrong basis posts a DIFFERENT figure.
 *   price basis   revenue 20,000 instead of 19,000, with the customer receivable raised by
 *                 the same 1,000 so the entry still balances;
 *   fee netting   the financier receivable 17,700 instead of 18,000;
 *   agent basis   a commission instead of sales revenue and cost of sale, which reaches the
 *                 same bottom line (revenue − D − cost = 1,500) and is caught only by account;
 *   cash deposit  cash debited for H instead of the deposit liability released.
 * `undiscriminatedBases` names any basis the chosen figures could not tell from the correct
 * one; the mission is then UNAVAILABLE, never a pass.
 *
 * Fail closed: nothing here is a pass unless the posting was actually read. No lines, an
 * unknown currency, or a scenario the oracle cannot model is unjudged, never clean.
 */
import type { Judgement } from "./browserSwarmBoundaryOracle";
import {
  currencyDecimals,
  fundingContributionMinor,
  lineStructureViolations,
  netShortfallMinor,
  toMinor,
  totalsByAccount,
  unjudgedOnly,
  type ConsignmentLine,
} from "./browserSwarmConsignmentOracle";

export interface MoneyBoundaryExpectation {
  /** The organization's own currency, read from its settings. */
  currency: string;
  /** The vehicle's selling price, in minor units. */
  priceMinor: number;
  /** What the dealership paid for the car (its purchase price), in minor units. */
  costMinor: number;
  /** What the financier approved (and transfers in full), in minor units. */
  approvedMinor: number;
  /** The dealership's own contribution toward the deal, in minor units. */
  contributionMinor: number;
  /** The customer's first payment, held as a deposit (H) the sale releases, in minor units. */
  depositMinor: number;
  /** What the customer owes the dealership beyond the approval (R), in minor units. */
  customerGapMinor: number;
  /** A cost the dealership pays itself and records on the deal; never deducted from the transfer. */
  adminFeeMinor: number;
}

/** The scenario's own figures, in major units. Nothing here is read back from the product. */
export interface MoneyBoundaryFigures {
  priceMajor: number;
  costMajor: number;
  quotationMajor: number;
  approvedMajor: number;
  ltvPercent: number;
  depositMajor: number;
  customerGapMajor: number;
  adminFeeMajor: number;
}

export const MONEY_BOUNDARY_FIGURES: Readonly<MoneyBoundaryFigures> = {
  priceMajor: 20_000,
  costMajor: 15_000,
  quotationMajor: 20_000,
  approvedMajor: 18_000,
  ltvPercent: 85,
  depositMajor: 200,
  customerGapMajor: 1_000,
  adminFeeMajor: 300,
};

/** K: the consideration is the financier's approval plus what the customer owes beyond it. */
export function considerationMinor(expectation: MoneyBoundaryExpectation): number {
  return expectation.approvedMinor + expectation.customerGapMinor;
}

/** The revenue the entry must net: K less the contribution (contra-revenue). */
export function expectedNetRevenueMinor(expectation: MoneyBoundaryExpectation): number {
  return considerationMinor(expectation) - expectation.contributionMinor;
}

/** The net revenue a posting measured on the SALE PRICE would show. */
export function priceBasisNetRevenueMinor(expectation: MoneyBoundaryExpectation): number {
  return expectation.priceMinor - expectation.contributionMinor;
}

type Key =
  | "ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES"
  | "ACCOUNTS_RECEIVABLE_CUSTOMERS"
  | "CUSTOMER_DEPOSITS_LIABILITY"
  | "SALES_CONSIDERATION_REDUCTIONS"
  | "COST_OF_VEHICLES_SOLD"
  | "ACCOUNTS_PAYABLE_FINANCE_COMPANIES"
  | "SALES_REVENUE"
  | "VEHICLE_INVENTORY";

interface Sides {
  debit: number;
  credit: number;
}

/**
 * The accounts a financed sale of owned stock may post to, with the debit and credit total
 * each must carry (zero when the side must be untouched). Anything not listed is a violation:
 * a denylist lets a balanced pair on an account nobody listed carry any amount.
 */
function expectedPosting(e: MoneyBoundaryExpectation): Record<Key, Sides> {
  return {
    ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES: { debit: e.approvedMinor, credit: 0 },
    ACCOUNTS_RECEIVABLE_CUSTOMERS: { debit: e.customerGapMinor, credit: 0 },
    CUSTOMER_DEPOSITS_LIABILITY: { debit: e.depositMinor, credit: 0 },
    SALES_CONSIDERATION_REDUCTIONS: { debit: e.contributionMinor, credit: 0 },
    COST_OF_VEHICLES_SOLD: { debit: e.costMinor, credit: 0 },
    ACCOUNTS_PAYABLE_FINANCE_COMPANIES: { debit: 0, credit: e.depositMinor + e.contributionMinor },
    SALES_REVENUE: { debit: 0, credit: considerationMinor(e) },
    VEHICLE_INVENTORY: { debit: 0, credit: e.costMinor },
  };
}

/**
 * The wrong bases this scenario cannot tell from the right one, by name. Empty when it can
 * tell them all apart; a pass is then a statement about every basis, not only some of them.
 */
export function undiscriminatedBases(e: MoneyBoundaryExpectation): string[] {
  const bases: string[] = [];
  if (considerationMinor(e) === e.priceMinor) bases.push("APPROVED_VS_PRICE_BASIS");
  if (e.adminFeeMinor === 0) bases.push("SETTLEMENT_FEE_NETTING");
  if (e.depositMinor === 0) bases.push("DEPOSIT_RELEASE");
  if (e.contributionMinor === 0) bases.push("CONTRIBUTION_CONTRA_REVENUE");
  if (e.costMinor === 0) bases.push("COST_OF_SALE");
  return bases;
}

/** One concrete scenario, every figure derived here from the major-unit inputs. */
export interface MoneyBoundaryScenario {
  expectation: MoneyBoundaryExpectation;
  quotationMinor: number;
  ltvPercent: number;
  /** The customer's first payment, which is the held deposit. */
  firstPaymentMinor: number;
  shortfallMinor: number;
  customerShareMinor: number;
  dealerShareMinor: number;
  /** H + D: what the dealership forwards to the financier before the sale is finalized. */
  forwardDueMinor: number;
}

/** Why `expectation` is not a scenario this file can judge, or null when it is. */
export function expectationProblem(e: MoneyBoundaryExpectation): string | null {
  if (currencyDecimals(e.currency) === null) {
    return `the organization's currency ${JSON.stringify(e.currency)} has no known minor-unit scale, so no amount can be judged`;
  }
  const inputs: [string, number][] = [
    ["price", e.priceMinor],
    ["cost", e.costMinor],
    ["approved amount", e.approvedMinor],
    ["contribution", e.contributionMinor],
    ["deposit", e.depositMinor],
    ["customer gap", e.customerGapMinor],
    ["admin fee", e.adminFeeMinor],
  ];
  for (const [label, value] of inputs) {
    if (!Number.isSafeInteger(value) || value < 0) return `the scenario's ${label} (${value}) is not a whole non-negative minor amount`;
  }
  if (e.approvedMinor > e.priceMinor || e.approvedMinor + e.customerGapMinor > e.priceMinor) {
    return "the scenario's approval plus the customer's gap exceeds the price, so it is not a deal the financier shortfall describes";
  }
  if (e.depositMinor > e.approvedMinor || e.contributionMinor > considerationMinor(e)) {
    return "the scenario's deposit or contribution exceeds what it is paid from, so the posting cannot be judged";
  }
  return null;
}

/** The scenario for `currency`, or why it cannot be expressed there; never a partial one. */
export function buildMoneyBoundaryScenario(
  currency: string,
  figures: Readonly<MoneyBoundaryFigures> = MONEY_BOUNDARY_FIGURES,
): { ok: true; scenario: MoneyBoundaryScenario } | { ok: false; reason: string } {
  const priceMinor = toMinor(figures.priceMajor, currency);
  const costMinor = toMinor(figures.costMajor, currency);
  const quotationMinor = toMinor(figures.quotationMajor, currency);
  const approvedMinor = toMinor(figures.approvedMajor, currency);
  const depositMinor = toMinor(figures.depositMajor, currency);
  const customerShareMinor = toMinor(figures.customerGapMajor, currency);
  const adminFeeMinor = toMinor(figures.adminFeeMajor, currency);
  if (
    priceMinor === null ||
    costMinor === null ||
    quotationMinor === null ||
    approvedMinor === null ||
    depositMinor === null ||
    customerShareMinor === null ||
    adminFeeMinor === null
  ) {
    return {
      ok: false,
      reason:
        currencyDecimals(currency) === null
          ? `the organization's currency ${JSON.stringify(currency)} has no known minor-unit scale, so no amount of the scenario can be expressed or judged`
          : `an amount of the scenario cannot be expressed in whole minor units of ${JSON.stringify(currency)}`,
    };
  }
  const contributionMinor = fundingContributionMinor(approvedMinor, figures.ltvPercent, depositMinor);
  const shortfallMinor = netShortfallMinor(quotationMinor, approvedMinor, figures.ltvPercent, depositMinor);
  if (contributionMinor === null || shortfallMinor === null) {
    return { ok: false, reason: `an LTV of ${figures.ltvPercent}% does not give whole minor amounts for this scenario` };
  }
  if (shortfallMinor <= 0 || customerShareMinor > shortfallMinor) {
    return {
      ok: false,
      reason: `the net shortfall (${shortfallMinor}) must be positive and cover the customer's share (${customerShareMinor})`,
    };
  }
  const expectation: MoneyBoundaryExpectation = {
    currency,
    priceMinor,
    costMinor,
    approvedMinor,
    contributionMinor,
    depositMinor,
    customerGapMinor: customerShareMinor,
    adminFeeMinor,
  };
  // A scenario the oracle could never judge is refused here, before the mission seeds anything for it.
  const problem = expectationProblem(expectation);
  if (problem !== null) return { ok: false, reason: problem };
  return {
    ok: true,
    scenario: {
      expectation,
      quotationMinor,
      ltvPercent: figures.ltvPercent,
      firstPaymentMinor: depositMinor,
      shortfallMinor,
      customerShareMinor,
      dealerShareMinor: shortfallMinor - customerShareMinor,
      forwardDueMinor: depositMinor + contributionMinor,
    },
  };
}

/**
 * Judges the lines of ONE financed owned-stock sale's posting against the independently
 * computed expectation. `lines` must be every line of the sale's posting; they are summed
 * per account, debit and credit separately, so an offsetting pair cannot hide in a net.
 */
export function evaluateMoneyBoundary(
  expectation: MoneyBoundaryExpectation,
  lines: readonly ConsignmentLine[],
): Judgement {
  const problem = expectationProblem(expectation);
  if (problem !== null) return unjudgedOnly(problem);
  if (lines.length === 0) return unjudgedOnly("the sale's posting was not read: no journal line to judge");

  const violations = lineStructureViolations(expectation.currency, lines);
  const expected = expectedPosting(expectation);
  const touched = totalsByAccount(lines);

  for (const [key, sides] of touched) {
    if (key in expected) continue;
    violations.push(
      key === "CONSIGNMENT_COMMISSION_REVENUE"
        ? `a commission was posted (debit ${sides.debit}, credit ${sides.credit}) on a car the dealership owns; it was recognized on agent basis`
        : `${key} (debit ${sides.debit}, credit ${sides.credit}) is not an account a financed sale of dealership stock may post to`,
    );
  }

  for (const [key, want] of Object.entries(expected) as [Key, Sides][]) {
    const got = touched.get(key) ?? { debit: 0, credit: 0 };
    if (got.debit !== want.debit) violations.push(`${key} debits ${got.debit} minor units, expected ${want.debit}`);
    if (got.credit !== want.credit) violations.push(`${key} credits ${got.credit} minor units, expected ${want.credit}`);
  }

  // Named wrong bases: the per-account violations above already prove the breach; these say which mistake it was.
  const revenue = touched.get("SALES_REVENUE")?.credit ?? 0;
  if (revenue === expectation.priceMinor && revenue !== considerationMinor(expectation)) {
    violations.push(
      `revenue was measured on the sale price ${expectation.priceMinor} instead of the approved amount plus the customer's gap ${considerationMinor(expectation)}`,
    );
  }
  const financier = touched.get("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES")?.debit ?? 0;
  if (expectation.adminFeeMinor > 0 && financier === expectation.approvedMinor - expectation.adminFeeMinor) {
    violations.push(
      `the receivable from the financing company is net of the dealership's own admin fee ${expectation.adminFeeMinor}; the financier transfers the full approval`,
    );
  }
  return { violations, unjudged: [] };
}
