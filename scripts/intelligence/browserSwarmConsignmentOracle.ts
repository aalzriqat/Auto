/**
 * SCRUM-350 CONS-1 — the pure judgement of a financed consigned sale's posting.
 *
 * The expected figures are computed here, from the inputs the mission itself
 * chose (price, approved amount, supplier entitlement, dealership contribution),
 * by arithmetic the product's posting code is never consulted for. A consigned
 * (SOURCED) car is the supplier's: the dealership acts as his agent, so the only
 * revenue is what it earns on the placement.
 *
 *   revenue = approved − supplier entitlement − dealership contribution
 *
 * The contribution is contra-revenue (a reduction of the consideration), never
 * an expense that leaves revenue gross. The car's price, the supplier's cost and
 * inventory never reach revenue, COGS or inventory: a rule that fell through to
 * the owned-stock branch reaches the same bottom line while overstating revenue
 * by the entire price of the car.
 *
 * Nothing here is a pass unless the posting was actually read: no lines is
 * unjudged, never clean.
 */
import type { Judgement } from "./browserSwarmBoundaryOracle";

export interface ConsignmentExpectation {
  /** The organization's own currency, read from its settings. */
  currency: string;
  /** The vehicle's selling price, in minor units of `currency`. */
  priceMinor: number;
  /** What the financier approved (and transfers), in minor units. */
  approvedMinor: number;
  /** The supplier's entitlement (`sourceCost`), in minor units. */
  entitlementMinor: number;
  /** The dealership's own contribution toward the deal, in minor units. */
  contributionMinor: number;
  /** Who the financier's transfer reaches: the dealership, or the supplier directly. */
  route: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER";
}

export interface ConsignmentLine {
  /** The account's system key (or code), resolved through the chart. */
  key: string;
  debitMinor: number;
  creditMinor: number;
  currency: string;
  scale: number;
}

/** Revenue-side accounts; the contra account carries the contribution. */
const REVENUE_KEYS = ["CONSIGNMENT_COMMISSION_REVENUE", "SALES_REVENUE", "SALES_CONSIDERATION_REDUCTIONS"] as const;
/** Touching any of these means the car was posted as the dealership's own stock. */
const OWNED_STOCK_KEYS = ["SALES_REVENUE", "COST_OF_VEHICLES_SOLD", "VEHICLE_INVENTORY"] as const;

/**
 * Decimal places of the currencies a dealership can be denominated in. Kept
 * apart from the product's own table so a wrong scale there cannot make the
 * judgement agree with it.
 */
const CURRENCY_DECIMALS: Readonly<Record<string, number>> = {
  JOD: 3,
  KWD: 3,
  BHD: 3,
  OMR: 3,
  USD: 2,
  EUR: 2,
  GBP: 2,
  SAR: 2,
  AED: 2,
  QAR: 2,
  EGP: 2,
  JPY: 0,
};

export function currencyDecimals(currency: string): number | null {
  return CURRENCY_DECIMALS[currency.toUpperCase()] ?? null;
}

/** Major units to minor units; null when the amount is not whole at that scale. */
export function toMinor(major: number, currency: string): number | null {
  const decimals = currencyDecimals(currency);
  if (decimals === null || !Number.isFinite(major)) return null;
  const minor = Math.round(major * 10 ** decimals);
  return Math.abs(minor / 10 ** decimals - major) < 1e-9 ? minor : null;
}

function isWholeMinor(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function net(lines: readonly ConsignmentLine[], key: string): { debit: number; credit: number; creditNet: number } {
  const matching = lines.filter((line) => line.key === key);
  const debit = matching.reduce((sum, line) => sum + line.debitMinor, 0);
  const credit = matching.reduce((sum, line) => sum + line.creditMinor, 0);
  return { debit, credit, creditNet: credit - debit };
}

export function expectedConsignedRevenueMinor(expectation: ConsignmentExpectation): number {
  return expectation.approvedMinor - expectation.entitlementMinor - expectation.contributionMinor;
}

/**
 * Judges the lines of ONE financed consigned sale's posting against the
 * independently computed expectation. `lines` must be every line of the sale's
 * posting; they are summed per account.
 */
export function evaluateConsignmentEconomics(
  expectation: ConsignmentExpectation,
  lines: readonly ConsignmentLine[],
): Judgement {
  const violations: string[] = [];
  const unjudged: string[] = [];

  const decimals = currencyDecimals(expectation.currency);
  if (decimals === null) {
    return {
      violations,
      unjudged: [`the organization's currency ${JSON.stringify(expectation.currency)} has no known minor-unit scale, so no amount can be judged`],
    };
  }
  const inputs: [string, number][] = [
    ["price", expectation.priceMinor],
    ["approved amount", expectation.approvedMinor],
    ["supplier entitlement", expectation.entitlementMinor],
    ["contribution", expectation.contributionMinor],
  ];
  for (const [label, value] of inputs) {
    if (!isWholeMinor(value)) {
      return { violations, unjudged: [`the scenario's ${label} (${value}) is not a whole non-negative minor amount`] };
    }
  }
  if (expectation.approvedMinor > expectation.priceMinor || expectation.entitlementMinor >= expectation.approvedMinor) {
    return {
      violations,
      unjudged: ["the scenario is not a placement with a positive margin (entitlement < approved <= price), so it cannot discriminate"],
    };
  }
  if (lines.length === 0) {
    return { violations, unjudged: ["the sale's posting was not read: no journal line to judge"] };
  }

  for (const line of lines) {
    if (line.currency !== expectation.currency || line.scale !== decimals) {
      violations.push(
        `a ${line.key} line is denominated ${line.currency} at scale ${line.scale}, not ${expectation.currency} at scale ${decimals}`,
      );
    }
  }

  const expectedRevenue = expectedConsignedRevenueMinor(expectation);
  const revenue = REVENUE_KEYS.reduce((sum, key) => sum + net(lines, key).creditNet, 0);
  if (revenue !== expectedRevenue) {
    const grossPrice = revenue >= expectation.priceMinor;
    violations.push(
      `recognized revenue is ${revenue} minor units, expected ${expectedRevenue} (approved ${expectation.approvedMinor} − supplier entitlement ${expectation.entitlementMinor} − contribution ${expectation.contributionMinor})` +
        (grossPrice ? "; the car's gross price was recognized as the dealership's revenue" : ""),
    );
  }

  const commission = net(lines, "CONSIGNMENT_COMMISSION_REVENUE");
  if (expectation.contributionMinor === 0 && commission.creditNet !== expectedRevenue) {
    violations.push(
      `commission revenue is ${commission.creditNet} minor units, expected the margin ${expectedRevenue}`,
    );
  }
  const contra = net(lines, "SALES_CONSIDERATION_REDUCTIONS");
  if (expectation.contributionMinor > 0 && contra.debit - contra.credit !== expectation.contributionMinor) {
    violations.push(
      `the dealership contribution ${expectation.contributionMinor} was not posted as contra-revenue (reduction ${contra.debit - contra.credit})`,
    );
  }

  for (const key of OWNED_STOCK_KEYS) {
    const touched = net(lines, key);
    if (touched.debit !== 0 || touched.credit !== 0) {
      violations.push(
        `${key} was touched (debit ${touched.debit}, credit ${touched.credit}) on a consigned sale; the car was posted as dealership stock`,
      );
    }
  }

  const payable = net(lines, "ACCOUNTS_PAYABLE_SUPPLIERS");
  const claim = net(lines, "RECEIVABLE_FROM_SUPPLIERS");
  if (expectation.route === "THROUGH_DEALERSHIP") {
    // The financier pays the dealership the whole approval; it owes the supplier his entitlement.
    if (payable.creditNet !== expectation.entitlementMinor) {
      violations.push(
        `the supplier payable is ${payable.creditNet} minor units, expected his entitlement ${expectation.entitlementMinor}`,
      );
    }
    if (claim.debit !== 0 || claim.credit !== 0) {
      violations.push("a receivable from the supplier was posted on a through-dealership sale");
    }
  } else {
    // The financier paid the supplier directly, so he holds the excess over his entitlement
    // and owes it to the dealership. The contribution never moves that debt.
    const owed = expectation.approvedMinor - expectation.entitlementMinor;
    if (claim.debit - claim.credit !== owed) {
      violations.push(`the receivable from the supplier is ${claim.debit - claim.credit} minor units, expected ${owed}`);
    }
    if (payable.debit !== 0 || payable.credit !== 0) {
      violations.push("a supplier payable was posted on a direct-to-supplier sale");
    }
  }

  return { violations, unjudged };
}
