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

/** Exact ISO codes only: a non-canonical code is unknown (unjudged), never judged against canonical lines. */
export function currencyDecimals(currency: string): number | null {
  return CURRENCY_DECIMALS[currency] ?? null;
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
 * The net revenue a posting would show if it measured the margin on the car's
 * SALE PRICE instead of on what the dealership is actually paid (approved amount
 * plus the customer's gap): price − entitlement − contribution. This is the wrong
 * figure the scenario must be able to tell from the right one.
 */
export function priceBasisRevenueMinor(expectation: ConsignmentExpectation): number {
  return expectation.priceMinor - expectation.entitlementMinor - expectation.contributionMinor;
}

/**
 * Whether the scenario can tell a margin measured on the financier's approval
 * (plus the customer's gap) from one measured on the car's price: only when the
 * two revenues differ, i.e. approved + gap ≠ price. Approved < price is not
 * enough: a customer gap that fills the whole difference makes both bases post
 * identical figures, and a pass would prove nothing about which was used.
 */
export function discriminatesApprovedFromPrice(expectation: ConsignmentExpectation): boolean {
  return expectedConsignedRevenueMinor(expectation) !== priceBasisRevenueMinor(expectation);
}

/**
 * The scenario's own figures, in major units. Nothing here is read back from the
 * product. The customer's first payment is the held deposit (the one deposit the
 * dealership forwards to the financier).
 */
export interface ConsignmentFigures {
  priceMajor: number;
  entitlementMajor: number;
  /** What the dealership asked the financier to buy the car at. */
  quotationMajor: number;
  approvedMajor: number;
  /** The financier's loan-to-value percentage (a whole number). */
  ltvPercent: number;
  depositMajor: number;
  /** The part of the shortfall the customer agrees to pay the dealership in cash. */
  customerGapMajor: number;
}

/**
 * A 20,000 car the supplier is owed 15,000 for, quoted to an 85% financier at 20,000
 * and approved at 18,000. The net shortfall is 1,700 (not the gross 2,000); the customer
 * pays 1,000 of it to the dealership and the dealership absorbs 700, so approved + gap
 * (19,000) is 1,000 short of the price.
 */
export const CONSIGNMENT_FIGURES: Readonly<ConsignmentFigures> = {
  priceMajor: 20_000,
  entitlementMajor: 15_000,
  quotationMajor: 20_000,
  approvedMajor: 18_000,
  ltvPercent: 85,
  depositMajor: 200,
  customerGapMajor: 1_000,
};

/**
 * What the dealership must put in to complete a purchase the financier lends
 * `ltvPercent` of, after the customer's first payment: purchase − funded − first
 * payment, funded being the lesser of the LTV share and what the first payment
 * leaves. Null when the percentage does not give a whole minor amount.
 */
export function fundingContributionMinor(purchaseMinor: number, ltvPercent: number, firstPaymentMinor: number): number | null {
  const scaled = purchaseMinor * ltvPercent;
  if (!Number.isInteger(ltvPercent) || ltvPercent < 0 || ltvPercent > 100 || !Number.isSafeInteger(scaled) || scaled % 100 !== 0) {
    return null;
  }
  const applied = Math.min(firstPaymentMinor, purchaseMinor);
  const funded = Math.min(scaled / 100, purchaseMinor - applied);
  return purchaseMinor - funded - applied;
}

/**
 * The owner's NET shortfall (SCRUM-407 c21031): what the showroom would have kept
 * of the quotation (quotation − its contribution) less what it keeps of the approval
 * (approved − its contribution), both at the same LTV and first payment. 20,000 → 18,000
 * at 85% with a 200 first payment is 17,200 − 15,500 = 1,700, not the gross 2,000.
 */
export function netShortfallMinor(quotationMinor: number, approvedMinor: number, ltvPercent: number, firstPaymentMinor: number): number | null {
  const quoted = fundingContributionMinor(quotationMinor, ltvPercent, firstPaymentMinor);
  const approved = fundingContributionMinor(approvedMinor, ltvPercent, firstPaymentMinor);
  return quoted === null || approved === null ? null : quotationMinor - quoted - (approvedMinor - approved);
}

/** One concrete scenario, every figure derived here from the major-unit inputs. */
export interface ConsignmentScenario {
  expectation: ConsignmentExpectation;
  quotationMinor: number;
  ltvPercent: number;
  /** The customer's first payment, which is the held deposit. */
  firstPaymentMinor: number;
  depositMinor: number;
  shortfallMinor: number;
  customerShareMinor: number;
  dealerShareMinor: number;
  /** H + D: what the dealership forwards to the financier before the sale is finalized. */
  forwardDueMinor: number;
}

/** The scenario for `currency`, or why it cannot be expressed there; never a partial one. */
export function buildConsignmentScenario(
  currency: string,
  figures: Readonly<ConsignmentFigures> = CONSIGNMENT_FIGURES,
): { ok: true; scenario: ConsignmentScenario } | { ok: false; reason: string } {
  const priceMinor = toMinor(figures.priceMajor, currency);
  const entitlementMinor = toMinor(figures.entitlementMajor, currency);
  const quotationMinor = toMinor(figures.quotationMajor, currency);
  const approvedMinor = toMinor(figures.approvedMajor, currency);
  const depositMinor = toMinor(figures.depositMajor, currency);
  const customerShareMinor = toMinor(figures.customerGapMajor, currency);
  if (
    priceMinor === null ||
    entitlementMinor === null ||
    quotationMinor === null ||
    approvedMinor === null ||
    depositMinor === null ||
    customerShareMinor === null
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
  const expectation: ConsignmentExpectation = {
    currency,
    priceMinor,
    approvedMinor,
    entitlementMinor,
    contributionMinor,
    route: "THROUGH_DEALERSHIP",
    depositForwardMinor: depositMinor,
    customerGapMinor: customerShareMinor,
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
      depositMinor,
      shortfallMinor,
      customerShareMinor,
      dealerShareMinor: shortfallMinor - customerShareMinor,
      forwardDueMinor: depositMinor + contributionMinor,
    },
  };
}

/**
 * Why `expectation` is not a scenario this file can judge, or null when it is. The
 * builder refuses on it before anything is seeded; the oracle checks it again
 * because it is exported and may be handed any expectation.
 */
export function expectationProblem(expectation: ConsignmentExpectation): string | null {
  if (currencyDecimals(expectation.currency) === null) {
    return `the organization's currency ${JSON.stringify(expectation.currency)} has no known minor-unit scale, so no amount can be judged`;
  }
  const gap = expectation.customerGapMinor ?? 0;
  const inputs: [string, number][] = [
    ["price", expectation.priceMinor],
    ["approved amount", expectation.approvedMinor],
    ["supplier entitlement", expectation.entitlementMinor],
    ["contribution", expectation.contributionMinor],
    ["deposit forward", expectation.depositForwardMinor ?? 0],
    ["customer gap", gap],
  ];
  for (const [label, value] of inputs) {
    if (!isWholeMinor(value)) return `the scenario's ${label} (${value}) is not a whole non-negative minor amount`;
  }
  if (expectation.approvedMinor > expectation.priceMinor || expectation.entitlementMinor >= expectation.approvedMinor) {
    return "the scenario is not a placement with a positive margin (entitlement < approved <= price), so it cannot discriminate";
  }
  if (expectation.route !== "THROUGH_DEALERSHIP" && expectation.route !== "DIRECT_TO_SUPPLIER") {
    return `the settlement route ${JSON.stringify(expectation.route)} is not modelled, so no posting can be judged`;
  }
  if (expectation.approvedMinor < expectation.priceMinor && expectation.customerGapMinor === undefined) {
    // The shortfall's resolution (customer gap, deposit) is a fact the scenario must state, never one inferred here.
    return "the financier approved less than the price but the scenario states no customer gap, so the posting cannot be judged";
  }
  if (expectation.approvedMinor + gap > expectation.priceMinor) {
    return "the scenario's customer gap exceeds the shortfall between price and approval";
  }
  if (
    expectation.route === "DIRECT_TO_SUPPLIER" &&
    (expectation.contributionMinor > 0 || (expectation.depositForwardMinor ?? 0) > 0 || gap > 0)
  ) {
    // The funding lines of a direct sale (contribution, deposit, customer gap) are not modelled here, so the posting cannot be proven complete.
    return "a direct-to-supplier sale with a contribution, deposit or customer gap is not modelled, so its posting cannot be judged complete";
  }
  return null;
}

export function unjudgedOnly(reason: string): Judgement {
  return { violations: [], unjudged: [reason] };
}

/**
 * What is wrong with the lines themselves, before any account is judged: a line in
 * another currency or scale, an amount that is not a nonnegative safe integer, a line
 * with both a debit and a credit, and an entry that does not balance.
 */
export function lineStructureViolations(currency: string, lines: readonly ConsignmentLine[]): string[] {
  const decimals = currencyDecimals(currency);
  const violations: string[] = [];
  for (const line of lines) {
    if (line.currency !== currency || line.scale !== decimals) {
      violations.push(`a ${line.key} line is denominated ${line.currency} at scale ${line.scale}, not ${currency} at scale ${decimals}`);
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
  return violations;
}

/** Sum of debits and of credits per account key. */
export function totalsByAccount(lines: readonly ConsignmentLine[]): Map<string, { debit: number; credit: number }> {
  return totalsBy(lines, (line) => line.key);
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
  const problem = expectationProblem(expectation);
  if (problem !== null) return unjudgedOnly(problem);
  if (lines.length === 0) {
    return unjudgedOnly("the sale's posting was not read: no journal line to judge");
  }
  const deposit = expectation.depositForwardMinor ?? 0;
  const gap = expectation.customerGapMinor ?? 0;

  const violations = lineStructureViolations(expectation.currency, lines);

  const byAccount = totalsBy(lines, (line) => line.key);
  /** One account's totals and its net on each side; zero for an account the posting never touched. */
  const net = (key: string) => {
    const { debit, credit } = byAccount.get(key) ?? { debit: 0, credit: 0 };
    return { debit, credit, creditNet: credit - debit, debitNet: debit - credit };
  };

  // Allowlist: a line on any account the route may not touch is a violation, whatever it nets to.
  const allowed: readonly string[] = ROUTE_ACCOUNTS[expectation.route];
  // Forbidden accounts that get their own, more specific violation below; listing them here would report them twice.
  const judgedBelow: readonly string[] = [
    ...OWNED_STOCK_KEYS,
    expectation.route === "THROUGH_DEALERSHIP" ? "RECEIVABLE_FROM_SUPPLIERS" : "ACCOUNTS_PAYABLE_SUPPLIERS",
  ];
  for (const [key, touched] of byAccount) {
    if (allowed.includes(key) || judgedBelow.includes(key)) continue;
    violations.push(
      `${key} (debit ${touched.debit}, credit ${touched.credit}) is not an account a ${ROUTE_LABEL[expectation.route]} consigned sale may post to`,
    );
  }

  const expectedRevenue = expectedConsignedRevenueMinor(expectation);
  const revenue = REVENUE_KEYS.reduce((sum, key) => sum + net(key).creditNet, 0);
  if (revenue !== expectedRevenue) {
    const grossPrice = revenue >= expectation.priceMinor;
    const priceBasis = priceBasisRevenueMinor(expectation);
    violations.push(
      `recognized revenue is ${revenue} minor units, expected ${expectedRevenue} (approved ${expectation.approvedMinor} + customer gap ${gap} − supplier entitlement ${expectation.entitlementMinor} − contribution ${expectation.contributionMinor})` +
        (grossPrice ? "; the car's gross price was recognized as the dealership's revenue" : "") +
        (revenue === priceBasis
          ? `; the margin was measured on the sale price ${expectation.priceMinor} instead of the approved amount plus the customer's gap`
          : ""),
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

/** A `vehicleSupplierPayables` row as `sourcingPayables.list` serves it; amounts are in MAJOR units of `currency`. */
export interface SupplierPayableRow {
  id: string;
  saleId: string | null;
  vehicleId: string;
  currency: string;
  amountDueMajor: number;
  /** Zero when the row records no payment. */
  amountPaidMajor: number;
  status: string;
}

/** The sale and car the payable must belong to. */
export interface SupplierPayableSubject {
  saleId: string;
  vehicleId: string;
}

/** A just-completed sale's payable is still unpaid: any other status means the supplier was paid, disputed or the debt cancelled. */
const UNPAID_PAYABLE_STATUSES: readonly string[] = ["PENDING", "NOT_YET_DUE", "DUE_ON_SALE"];

/**
 * Judges the canonical supplier-subledger record of ONE through-dealership consigned
 * sale. The journal credits the supplier payable, but `vehicleSupplierPayables` is what
 * the dealership settles the supplier from, so a correct journal beside a missing or wrong
 * row is still a defect. `rows` is every payable the organization lists; exactly one must
 * belong to the sale, for this car, in the organization's currency, owing the independently
 * computed entitlement and not yet paid. A payable naming the car under another sale is a
 * violation too, whatever the sale's own row says.
 */
export function evaluateSupplierPayable(
  expectation: ConsignmentExpectation,
  subject: SupplierPayableSubject,
  rows: readonly SupplierPayableRow[],
): Judgement {
  const problem = expectationProblem(expectation);
  if (problem !== null) return unjudgedOnly(problem);
  if (expectation.route !== "THROUGH_DEALERSHIP") {
    return unjudgedOnly("a direct-to-supplier sale's supplier record is not modelled, so its payable row cannot be judged");
  }
  const violations: string[] = [];
  const forSale = rows.filter((row) => row.saleId === subject.saleId);
  for (const stray of rows.filter((row) => row.saleId !== subject.saleId && row.vehicleId === subject.vehicleId)) {
    violations.push(`supplier payable ${stray.id} is for this car but names ${stray.saleId === null ? "no sale" : `sale ${stray.saleId}`}, not sale ${subject.saleId}`);
  }
  if (forSale.length !== 1) {
    violations.push(
      forSale.length === 0
        ? `no supplier payable row exists for sale ${subject.saleId}, although the journal credits the supplier ${expectation.entitlementMinor} minor units`
        : `${forSale.length} supplier payable rows exist for sale ${subject.saleId}, expected exactly one`,
    );
  }
  for (const row of forSale) {
    const label = `supplier payable ${row.id}`;
    if (row.vehicleId !== subject.vehicleId) violations.push(`${label} is for vehicle ${row.vehicleId}, not the sold car ${subject.vehicleId}`);
    if (row.currency !== expectation.currency) violations.push(`${label} is denominated ${row.currency}, not ${expectation.currency}`);
    // At the organization's scale: a row in another currency is already one violation, not two.
    const due = toMinor(row.amountDueMajor, expectation.currency);
    if (due !== expectation.entitlementMinor) {
      violations.push(
        `${label} owes ${due === null ? `an amount (${row.amountDueMajor}) that is not whole in ${expectation.currency}` : `${due} minor units`}, expected the supplier's entitlement ${expectation.entitlementMinor}`,
      );
    }
    if (!UNPAID_PAYABLE_STATUSES.includes(row.status)) {
      violations.push(`${label} has status ${row.status}, expected an unpaid one (${UNPAID_PAYABLE_STATUSES.join(", ")}) on a sale just completed`);
    }
    if (row.amountPaidMajor !== 0) violations.push(`${label} records ${row.amountPaidMajor} already paid on a sale just completed`);
  }
  return { violations, unjudged: [] };
}
