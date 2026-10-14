/**
 * SCRUM-350 CONS-1 — the pure judgement of a financed consigned sale's posting.
 *
 * The expected figures are computed here, from the inputs the mission itself
 * chose (price, approved amount, supplier entitlement, dealership contribution),
 * by arithmetic the product's posting code is never consulted for. A consigned
 * (SOURCED) car is the supplier's: the dealership acts as his agent, so the only
 * revenue is what it earns on the placement.
 *
 *   revenue = approved − supplier entitlement − dealership contribution (+ customer gap)
 *
 * The financier transfers the FULL approved amount A (owner ruling c21031,
 * SCRUM-411). What the dealership holds that belongs onward to the financier —
 * the customer's deposit H and its own contribution D — is forwarded
 * separately and is owed to the financier from the sale: AP-finance = D + H.
 * The contribution is contra-revenue (a reduction of the consideration), never
 * an expense that leaves revenue gross. Through the dealership the sale posts:
 *
 *   Dr AR-finance A · Dr deposit liability H · Dr contra-revenue D · Dr AR-customer R
 *     Cr AP-finance D + H · Cr AP-supplier E · Cr commission A + R − E
 *
 * The car's price, the supplier's cost and inventory never reach revenue, COGS
 * or inventory: a rule that fell through to the owned-stock branch reaches the
 * same bottom line while overstating revenue by the entire price of the car.
 *
 * Fail closed: a route or an extra (deposit, customer gap) this file does not
 * model is unjudged, never clean. Nothing here is a pass unless the posting was
 * actually read: no lines is unjudged too.
 */
import type { Judgement } from "./browserSwarmBoundaryOracle";

export interface ConsignmentExpectation {
  /** The organization's own currency, read from its settings. */
  currency: string;
  /** The vehicle's selling price, in minor units of `currency`. */
  priceMinor: number;
  /** What the financier approved (and transfers in full), in minor units. */
  approvedMinor: number;
  /** The supplier's entitlement (`sourceCost`), in minor units. */
  entitlementMinor: number;
  /** The dealership's own contribution toward the deal, in minor units. */
  contributionMinor: number;
  /** Who the financier's transfer reaches: the dealership, or the supplier directly. */
  route: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER";
  /** The customer's deposit forwarded to the financier (H); zero or absent when none was seeded. */
  depositForwardMinor?: number;
  /**
   * What the customer owes the dealership beyond the financier's approval (R),
   * as the scenario resolved it. Required when approved < price: the oracle never
   * derives a gap from the difference of two other figures.
   */
  customerGapMinor?: number;
}

export interface ConsignmentLine {
  /** The account's system key (or code), resolved through the chart. */
  key: string;
  debitMinor: number;
  creditMinor: number;
  currency: string;
  scale: number;
  /** The journal entry the line belongs to; balance is judged per entry when given. */
  entryId?: string;
  /** The chart account the line posted to, kept for evidence. */
  accountId?: string;
}

/** Revenue-side accounts; the contra account carries the contribution. */
const REVENUE_KEYS = ["CONSIGNMENT_COMMISSION_REVENUE", "SALES_REVENUE", "SALES_CONSIDERATION_REDUCTIONS"] as const;
/** Touching any of these means the car was posted as the dealership's own stock. */
const OWNED_STOCK_KEYS = ["SALES_REVENUE", "COST_OF_VEHICLES_SOLD", "VEHICLE_INVENTORY"] as const;
/**
 * The only accounts a financed consigned sale may post to, per route. Anything
 * else is a violation: a denylist lets a balanced pair on an account nobody
 * listed carry any amount. The contra account is allowed on both routes, but is
 * held to exactly the contribution (zero when there is none).
 */
const ROUTE_ACCOUNTS = {
  THROUGH_DEALERSHIP: [
    "ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES",
    "ACCOUNTS_PAYABLE_FINANCE_COMPANIES",
    "ACCOUNTS_PAYABLE_SUPPLIERS",
    "ACCOUNTS_RECEIVABLE_CUSTOMERS",
    "CUSTOMER_DEPOSITS_LIABILITY",
    "CONSIGNMENT_COMMISSION_REVENUE",
    "SALES_CONSIDERATION_REDUCTIONS",
  ],
  DIRECT_TO_SUPPLIER: ["RECEIVABLE_FROM_SUPPLIERS", "CONSIGNMENT_COMMISSION_REVENUE", "SALES_CONSIDERATION_REDUCTIONS"],
} as const;
const ROUTE_LABEL = { THROUGH_DEALERSHIP: "through-dealership", DIRECT_TO_SUPPLIER: "direct-to-supplier" } as const;

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

/** Sum of debits and of credits per group of lines. */
function totalsBy(
  lines: readonly ConsignmentLine[],
  groupOf: (line: ConsignmentLine) => string,
): Map<string, { debit: number; credit: number }> {
  const totals = new Map<string, { debit: number; credit: number }>();
  for (const line of lines) {
    const group = groupOf(line);
    const sums = totals.get(group) ?? { debit: 0, credit: 0 };
    sums.debit += line.debitMinor;
    sums.credit += line.creditMinor;
    totals.set(group, sums);
  }
  return totals;
}

/** The dealership's consideration for the car: what the financier transfers plus what the customer owes beyond it. */
function considerationMinor(expectation: ConsignmentExpectation): number {
  return expectation.approvedMinor + (expectation.customerGapMinor ?? 0);
}

export function expectedConsignedRevenueMinor(expectation: ConsignmentExpectation): number {
  return considerationMinor(expectation) - expectation.entitlementMinor - expectation.contributionMinor;
}

/**
 * Whether the scenario can tell a margin measured on the financier's approval
 * from one measured on the car's price: only when the two differ. Equal, both
 * bases give the same figures, so a pass proves nothing about which was used.
 */
export function discriminatesApprovedFromPrice(expectation: ConsignmentExpectation): boolean {
  return expectation.approvedMinor < expectation.priceMinor;
}

function unjudgedOnly(reason: string): Judgement {
  return { violations: [], unjudged: [reason] };
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
  const decimals = currencyDecimals(expectation.currency);
  if (decimals === null) {
    return unjudgedOnly(`the organization's currency ${JSON.stringify(expectation.currency)} has no known minor-unit scale, so no amount can be judged`);
  }
  const deposit = expectation.depositForwardMinor ?? 0;
  const gap = expectation.customerGapMinor ?? 0;
  const inputs: [string, number][] = [
    ["price", expectation.priceMinor],
    ["approved amount", expectation.approvedMinor],
    ["supplier entitlement", expectation.entitlementMinor],
    ["contribution", expectation.contributionMinor],
    ["deposit forward", deposit],
    ["customer gap", gap],
  ];
  for (const [label, value] of inputs) {
    if (!isWholeMinor(value)) {
      return unjudgedOnly(`the scenario's ${label} (${value}) is not a whole non-negative minor amount`);
    }
  }
  if (expectation.approvedMinor > expectation.priceMinor || expectation.entitlementMinor >= expectation.approvedMinor) {
    return unjudgedOnly("the scenario is not a placement with a positive margin (entitlement < approved <= price), so it cannot discriminate");
  }
  if (expectation.route !== "THROUGH_DEALERSHIP" && expectation.route !== "DIRECT_TO_SUPPLIER") {
    return unjudgedOnly(`the settlement route ${JSON.stringify(expectation.route)} is not modelled, so no posting can be judged`);
  }
  if (expectation.approvedMinor < expectation.priceMinor && expectation.customerGapMinor === undefined) {
    // The shortfall's resolution (customer gap, deposit) is a fact the scenario must state, never one inferred here.
    return unjudgedOnly("the financier approved less than the price but the scenario states no customer gap, so the posting cannot be judged");
  }
  if (expectation.approvedMinor + gap > expectation.priceMinor) {
    return unjudgedOnly("the scenario's customer gap exceeds the shortfall between price and approval");
  }
  if (expectation.route === "DIRECT_TO_SUPPLIER" && (expectation.contributionMinor > 0 || deposit > 0 || gap > 0)) {
    // The funding lines of a direct sale (contribution, deposit, customer gap) are not modelled here, so the posting cannot be proven complete.
    return unjudgedOnly("a direct-to-supplier sale with a contribution, deposit or customer gap is not modelled, so its posting cannot be judged complete");
  }
  if (lines.length === 0) {
    return unjudgedOnly("the sale's posting was not read: no journal line to judge");
  }

  const violations: string[] = [];
  for (const line of lines) {
    if (line.currency !== expectation.currency || line.scale !== decimals) {
      violations.push(
        `a ${line.key} line is denominated ${line.currency} at scale ${line.scale}, not ${expectation.currency} at scale ${decimals}`,
      );
    }
    if (!isWholeMinor(line.debitMinor) || !isWholeMinor(line.creditMinor)) {
      violations.push(
        `a ${line.key} line has an amount (debit ${line.debitMinor}, credit ${line.creditMinor}) that is not a nonnegative safe integer`,
      );
    } else if (line.debitMinor !== 0 && line.creditMinor !== 0) {
      violations.push(`a ${line.key} line carries both a debit and a credit (${line.debitMinor} / ${line.creditMinor})`);
    }
  }

  for (const [entryId, totals] of totalsBy(lines, (line) => line.entryId ?? "")) {
    if (totals.debit !== totals.credit) {
      violations.push(
        `${entryId === "" ? "journal" : `journal ${entryId}`} does not balance: debits ${totals.debit}, credits ${totals.credit}`,
      );
    }
  }

  const byAccount = totalsBy(lines, (line) => line.key);
  /** One account's totals and its net on each side; zero for an account the posting never touched. */
  const net = (key: string) => {
    const { debit, credit } = byAccount.get(key) ?? { debit: 0, credit: 0 };
    return { debit, credit, creditNet: credit - debit, debitNet: debit - credit };
  };

  // Allowlist: a line on any account the route may not touch is a violation, whatever it nets to.
  const allowed: readonly string[] = ROUTE_ACCOUNTS[expectation.route];
  const ownMessage: readonly string[] = [
    ...OWNED_STOCK_KEYS,
    expectation.route === "THROUGH_DEALERSHIP" ? "RECEIVABLE_FROM_SUPPLIERS" : "ACCOUNTS_PAYABLE_SUPPLIERS",
  ];
  for (const [key, touched] of byAccount) {
    if (allowed.includes(key) || ownMessage.includes(key)) continue;
    violations.push(
      `${key} (debit ${touched.debit}, credit ${touched.credit}) is not an account a ${ROUTE_LABEL[expectation.route]} consigned sale may post to`,
    );
  }

  const expectedRevenue = expectedConsignedRevenueMinor(expectation);
  const revenue = REVENUE_KEYS.reduce((sum, key) => sum + net(key).creditNet, 0);
  if (revenue !== expectedRevenue) {
    const grossPrice = revenue >= expectation.priceMinor;
    violations.push(
      `recognized revenue is ${revenue} minor units, expected ${expectedRevenue} (approved ${expectation.approvedMinor} + customer gap ${gap} − supplier entitlement ${expectation.entitlementMinor} − contribution ${expectation.contributionMinor})` +
        (grossPrice ? "; the car's gross price was recognized as the dealership's revenue" : ""),
    );
  }

  // The commission is the gross spread; the contribution is taken off it through the contra account.
  const grossSpread = considerationMinor(expectation) - expectation.entitlementMinor;
  const commission = net("CONSIGNMENT_COMMISSION_REVENUE");
  if (commission.creditNet !== grossSpread) {
    violations.push(`commission revenue is ${commission.creditNet} minor units, expected the margin ${grossSpread}`);
  }
  const reduction = net("SALES_CONSIDERATION_REDUCTIONS").debitNet;
  if (reduction !== expectation.contributionMinor) {
    violations.push(
      expectation.contributionMinor > 0
        ? `the dealership contribution ${expectation.contributionMinor} was not posted as contra-revenue (reduction ${reduction})`
        : `the contra-revenue reduction is ${reduction} minor units, expected 0: no contribution was made`,
    );
  }

  for (const key of OWNED_STOCK_KEYS) {
    const touched = net(key);
    if (touched.debit !== 0 || touched.credit !== 0) {
      violations.push(
        `${key} was touched (debit ${touched.debit}, credit ${touched.credit}) on a consigned sale; the car was posted as dealership stock`,
      );
    }
  }

  const payable = net("ACCOUNTS_PAYABLE_SUPPLIERS");
  const claim = net("RECEIVABLE_FROM_SUPPLIERS");
  if (expectation.route === "THROUGH_DEALERSHIP") {
    // The financier transfers the FULL approval, so it owes the dealership all of it; what is owed
    // onward to it (the contribution and the customer's deposit) is a payable, never netted off the
    // receivable. The dealership owes the supplier his entitlement.
    const financier = net("ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES");
    if (financier.debitNet !== expectation.approvedMinor) {
      violations.push(
        `the receivable from the financing company is ${financier.debitNet} minor units, expected the full approval ${expectation.approvedMinor}`,
      );
    }
    const forwarded = net("ACCOUNTS_PAYABLE_FINANCE_COMPANIES");
    const owedOnward = expectation.contributionMinor + deposit;
    if (forwarded.creditNet !== owedOnward) {
      violations.push(
        `the payable to the financing company is ${forwarded.creditNet} minor units, expected ${owedOnward} (contribution ${expectation.contributionMinor} + deposit ${deposit})`,
      );
    }
    const released = net("CUSTOMER_DEPOSITS_LIABILITY");
    if (released.debitNet !== deposit) {
      violations.push(`the customer deposit released is ${released.debitNet} minor units, expected ${deposit}`);
    }
    const customer = net("ACCOUNTS_RECEIVABLE_CUSTOMERS");
    if (customer.debitNet !== gap) {
      violations.push(`the receivable from the customer is ${customer.debitNet} minor units, expected the gap ${gap}`);
    }
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
    if (claim.debitNet !== owed) {
      violations.push(`the receivable from the supplier is ${claim.debitNet} minor units, expected ${owed}`);
    }
    if (payable.debit !== 0 || payable.credit !== 0) {
      violations.push("a supplier payable was posted on a direct-to-supplier sale");
    }
  }

  return { violations, unjudged: [] };
}
