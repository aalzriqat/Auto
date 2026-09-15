import type { DealProfit } from "./financingEconomics";

/**
 * The operator's financial overview of one FINANCED deal, derived once on the
 * server from figures that already have an authority — never a second reading
 * of any of them.
 *
 * ## What this is, and what it is not
 *
 * A PROJECTION of `applications.dealCockpit`'s `money` payload plus the
 * application's frozen economics into the facts an operator asks about a
 * deal: what the customer pays, what they have already put in, what the
 * finance company funds and still owes, what the dealership has committed and
 * has actually recorded spending, what the supplier is due, and what the
 * dealership makes. Every amount here is read from a served figure and, at
 * most, ADDED to another served figure of the same denomination. Nothing is
 * inferred from the gap between two other numbers, nothing is re-scaled, and
 * nothing is chosen "by what looks populated" without saying which basis was
 * chosen.
 *
 * `null` is a real answer and carries a REASON, because "not recorded", "the
 * route is unknown", "a deposit could not be read" and "this deal has no such
 * party" are four different facts that a zero would flatten into one lie.
 *
 * ## PURCHASED vs SOURCED
 *
 * The profit headline arrives already route-specific (the caller derives it:
 * consignment economics for a SOURCED car, cost-basis economics for the
 * dealership's own STOCK — see `dealOverview.ts`) and is carried through
 * untouched. This module adds the supplier's DIRECTION and ROUTE so the tile
 * can say "the financier pays him directly" or "owed through the dealership"
 * instead of a bare number that reads the same on both routes.
 *
 * ## Planned is not paid
 *
 * The dealership's contribution to the financing is a PLANNED split frozen at
 * approval, not cash that has left. It is served as such, beside the costs
 * actually RECORDED and the configured costs still EXPECTED, and the only
 * total here is "total expected dealer outlay" — never "paid". The same rule
 * holds on the customer's side: the appraisal-gap cash the customer agreed to
 * pay the dealership is an allocation `resolveAppraisalGap` wrote, with no
 * receipt behind it, and it is served as PLANNED beside the held deposits —
 * never inside what the customer "paid".
 *
 * Pure so the formulas are testable without a database.
 */

/**
 * Why the recorded dealer-borne costs are unknown: a dealer-borne line in
 * another currency (a same-currency sum would be partial), or a live line
 * whose amount is not a safe non-negative integer, or lines that overflow
 * between them (the sum would be corrupt).
 */
export type RecordedCostsReason = "MIXED_DENOMINATION" | "UNSAFE_AMOUNT";

/** A party row exactly as `applications.dealCockpit` serves it. */
export type ServedParty = Readonly<{
  party: "CUSTOMER" | "SUPPLIER" | "FINANCIER";
  position: "UNKNOWN" | "DEALERSHIP_HOLDS" | "NOT_INVOLVED" | "SETTLED" | "OWED_TO_DEALERSHIP" | "DEALERSHIP_OWES";
  amountMinor: number;
  currency: string;
}>;

export type DealFinancialSummaryInputs = Readonly<{
  currency: string;
  routeKnown: boolean;
  settlesDirectToSupplier: boolean;
  parties: ReadonlyArray<ServedParty>;
  /**
   * The cockpit's expense summary: `actualTotalMinor` is the DEALER-BORNE
   * recorded actuals (lines paid by the dealership or an employee — the
   * cockpit sums exactly those), and `awaitingActuals` counts live lines with
   * no actual yet, whoever pays them.
   *
   * The cockpit sums only lines in the deal's currency and silently leaves a
   * foreign-denominated one out, so its total is a PARTIAL figure whenever a
   * dealer-borne line is denominated otherwise; and it sums unchecked, so a
   * line carrying NaN or an unsafe value makes it a NON-figure. The caller
   * inspects every live line and says so here: `actualTotalMinor` is `null`
   * with the reason, and every aggregate built on it is withheld rather than
   * understated or corrupt.
   */
  expenses: Readonly<{
    actualTotalMinor: number | null;
    awaitingActuals: number;
    reason: RecordedCostsReason | null;
  }>;
  /** Route-specific, already derived — see the module header. */
  profit: DealProfit;
  /** Whose car this is — SOURCED (consignment) or the dealership's own. */
  vehicleConsigned: boolean | null;
  app: Readonly<{
    legalInvoiceAmountMinor?: number;
    targetSellingAmountMinor?: number;
    submittedQuotationMinor?: number;
    approvedDealerPurchaseAmountMinor?: number;
    financeCompanyFundedPortionMinor?: number;
    dealerContributionMinor?: number;
    customerFirstPaymentMinor?: number;
    customerGapCashToDealerMinor?: number;
    /** What the financier is expected to remit to the dealership, as the economics froze it. */
    expectedDealerRemittanceMinor?: number;
  }>;
  /**
   * The finance company's configured fees that the DEALERSHIP bears, as the
   * handover-cost checklist derives them from the frozen snapshot: the total
   * configured, and the part with no recorded actual yet. Both null when no
   * policy is configured. Customer- and financier-borne templates are NOT in
   * these figures — they are not the dealership's outlay.
   */
  expectedDealerBorne: Readonly<{
    totalMinor: number | null;
    remainingMinor: number | null;
    /** Why both are null, when they are — a missing policy is not the only way. */
    reason: "NO_POLICY" | "MIXED_DENOMINATION" | "UNSAFE_AMOUNT" | null;
  }>;
}>;

/**
 * Which document the customer's price is read from, strongest first: the
 * legal invoice (the only figure revenue is ever posted from), then the
 * quotation actually SUBMITTED to the financier (a customer-facing document
 * the sales floor prefills from), then the dealership's internal target.
 */
export type CustomerSalePriceBasis =
  | "LEGAL_INVOICE"
  | "SUBMITTED_QUOTATION"
  | "TARGET_SELLING_AMOUNT";

export type FinancierOutstanding =
  /** A canonical receivable exists; the balance is its outstanding, from the subledger. */
  | Readonly<{ state: "OUTSTANDING" | "COLLECTED"; amountMinor: number; basis: "RECEIVABLE" }>
  /**
   * No receivable yet (it opens at finalization), so the figure is the
   * remittance the frozen economics EXPECT — an estimate, labelled as one.
   */
  | Readonly<{ state: "ESTIMATED_PRE_RECEIVABLE"; amountMinor: number; basis: "EXPECTED_DEALER_REMITTANCE" }>
  | Readonly<{ state: "NONE_DIRECT_ROUTE" | "NOT_YET_RECEIVABLE" | "UNKNOWN"; amountMinor: null; basis: null }>;

export type DealFinancialSummary = Readonly<{
  currency: string;
  customerSalePrice: Readonly<{ amountMinor: number; basis: CustomerSalePriceBasis }> | null;
  /** The approved purchase amount — the deal's value as the financier bought it. */
  approvedPurchaseAmountMinor: number | null;
  /**
   * What the customer has put in with the DEALERSHIP: the deposits it holds,
   * as the cockpit's custody authority serves them — receipt-backed money and
   * nothing else. `null` when the held deposits cannot be totalled (an
   * unreadable row, or an unknown route), because a partial total reads as a
   * complete one.
   */
  customerPaidToDealer: Readonly<{
    heldDepositMinor: number;
    totalMinor: number;
  }> | null;
  /**
   * The appraisal-gap cash the customer AGREED to pay the dealership directly
   * — `resolveAppraisalGap`'s allocation, a negotiated PLAN with no receipt,
   * cashbook, payment or journal behind it. Served on its own, never inside
   * a paid total: resolving a gap moves no money. `null` when no gap
   * allocation has been recorded.
   */
  customerGapCashPlannedMinor: number | null;
  /** The customer's first payment as the economics froze it, whoever receives it. */
  customerFirstPaymentMinor: number | null;
  financier: Readonly<{
    fundedPortionMinor: number | null;
    outstanding: FinancierOutstanding;
  }>;
  /**
   * The dealership's side, kept as separate facts — none of them "paid".
   *
   * `plannedContribution` is the frozen financing split, a commitment, not
   * cash that has left. `recordedCosts` is what has actually been recorded as
   * dealer-borne, and null with `recordedCostsReason` when a dealer-borne
   * line is denominated in another currency — the same-currency sum would be
   * a partial figure wearing a total's name — or when a line's amount cannot
   * be read, where the sum would be corrupt. `knownCommitted` is those two
   * added, and null while either is unknown — "0 + costs" would report the
   * outlay of a deal whose split has not been computed as if it were known.
   * `expectedCostsRemaining` is the dealer-borne policy not yet recorded, and
   * null when NO policy is configured. `totalExpected` adds it to the known
   * figure and is null whenever either side is unknown: a missing policy is
   * unknown, not zero, and a total over an unknown is not a total. Either
   * addition that leaves the safe range is withheld too, with
   * `aggregateReason` saying so — safe operands do not guarantee a safe sum.
   */
  dealerOutlay: Readonly<{
    plannedContributionMinor: number | null;
    recordedCostsMinor: number | null;
    /** Why the recorded figure is unknown, when it is. */
    recordedCostsReason: RecordedCostsReason | null;
    /** Live lines still without an actual — the recorded figure is not the whole cost yet. */
    awaitingActuals: number;
    knownCommittedMinor: number | null;
    expectedCostsRemainingMinor: number | null;
    /** Why the expected side is unknown, when it is. */
    expectedCostsReason: "NO_POLICY" | "MIXED_DENOMINATION" | "UNSAFE_AMOUNT" | null;
    totalExpectedMinor: number | null;
    /** Why `knownCommitted`/`totalExpected` are withheld although their operands are known: the sum is not a safe integer. */
    aggregateReason: "UNSAFE_AMOUNT" | null;
  }>;
  supplier: Readonly<{
    consigned: boolean | null;
    /** Owed TO or BY the dealership, as the obligation authority says. */
    direction: "DEALERSHIP_OWES" | "OWED_TO_DEALERSHIP" | "SETTLED" | "NOT_INVOLVED" | "UNKNOWN";
    amountMinor: number | null;
    route: "DIRECT_TO_SUPPLIER" | "THROUGH_DEALERSHIP" | "UNKNOWN";
  }>;
  /** The headline, served through — see `DealProfit` for why it is a union. */
  profit: DealProfit;
}>;

function customerSalePriceFor(
  app: DealFinancialSummaryInputs["app"]
): DealFinancialSummary["customerSalePrice"] {
  if (app.legalInvoiceAmountMinor !== undefined) {
    return { amountMinor: app.legalInvoiceAmountMinor, basis: "LEGAL_INVOICE" };
  }
  if (app.submittedQuotationMinor !== undefined) {
    return { amountMinor: app.submittedQuotationMinor, basis: "SUBMITTED_QUOTATION" };
  }
  if (app.targetSellingAmountMinor !== undefined) {
    return { amountMinor: app.targetSellingAmountMinor, basis: "TARGET_SELLING_AMOUNT" };
  }
  return null;
}

function financierOutstandingFor(args: {
  routeKnown: boolean;
  settlesDirect: boolean;
  financier: ServedParty | undefined;
  expectedDealerRemittanceMinor: number | undefined;
}): FinancierOutstanding {
  if (!args.routeKnown) return { state: "UNKNOWN", amountMinor: null, basis: null };
  if (args.settlesDirect) return { state: "NONE_DIRECT_ROUTE", amountMinor: null, basis: null };
  const row = args.financier;
  if (row === undefined || row.position === "NOT_INVOLVED") {
    // Nothing canonical yet. The frozen economics say what the financier is
    // expected to remit; that is served as an ESTIMATE, never as a balance.
    return args.expectedDealerRemittanceMinor !== undefined
      ? {
          state: "ESTIMATED_PRE_RECEIVABLE",
          amountMinor: args.expectedDealerRemittanceMinor,
          basis: "EXPECTED_DEALER_REMITTANCE",
        }
      : { state: "NOT_YET_RECEIVABLE", amountMinor: null, basis: null };
  }
  if (row.position === "UNKNOWN") return { state: "UNKNOWN", amountMinor: null, basis: null };
  // SETTLED serves a zero; OWED_TO_DEALERSHIP serves the balance. Both are the
  // party row's own figure — the receivable's outstanding — never re-derived.
  return row.position === "SETTLED"
    ? { state: "COLLECTED", amountMinor: row.amountMinor, basis: "RECEIVABLE" }
    : { state: "OUTSTANDING", amountMinor: row.amountMinor, basis: "RECEIVABLE" };
}

export function deriveDealFinancialSummary(input: DealFinancialSummaryInputs): DealFinancialSummary {
  const { app, currency } = input;
  const byParty = new Map(input.parties.map((row) => [row.party, row]));
  const customer = byParty.get("CUSTOMER");
  const supplier = byParty.get("SUPPLIER");
  const financier = byParty.get("FINANCIER");

  // A CUSTOMER row in the query currency with a readable total. UNKNOWN is the
  // cockpit saying a deposit could not be read or the route is unknown — a
  // partial figure, so the tile is withheld rather than understated. The
  // held deposit is the ONLY operand: it is the one figure here with a
  // receipt behind it.
  const customerPaidToDealer =
    customer !== undefined && customer.position !== "UNKNOWN" && customer.currency === currency
      ? { heldDepositMinor: customer.amountMinor, totalMinor: customer.amountMinor }
      : null;

  const plannedContributionMinor = app.dealerContributionMinor ?? null;
  // The readable-total contract, enforced here as well as by the caller: a
  // served total that is not a safe non-negative integer is not a figure,
  // whatever reason (or none) travelled with it. Checked positively — NaN
  // passes every negative comparison.
  const safe = (amount: number): boolean => Number.isSafeInteger(amount) && amount >= 0;
  const recordedUnreadable =
    input.expenses.actualTotalMinor !== null && !safe(input.expenses.actualTotalMinor);
  const recordedCostsMinor = recordedUnreadable ? null : input.expenses.actualTotalMinor;
  const recordedCostsReason: RecordedCostsReason | null = recordedUnreadable
    ? "UNSAFE_AMOUNT"
    : input.expenses.reason;
  const expectedCostsRemainingMinor = input.expectedDealerBorne.remainingMinor;
  // Two safe operands can still add to an unsafe sum; a sum that is not a
  // safe integer is withheld rather than published, with its own reason —
  // the operands themselves are known and are still served.
  const knownCommittedSum =
    plannedContributionMinor === null || recordedCostsMinor === null
      ? null
      : plannedContributionMinor + recordedCostsMinor;
  const knownCommittedOverflow = knownCommittedSum !== null && !Number.isSafeInteger(knownCommittedSum);
  const knownCommittedMinor = knownCommittedOverflow ? null : knownCommittedSum;
  const totalExpectedSum =
    knownCommittedMinor === null || expectedCostsRemainingMinor === null
      ? null
      : knownCommittedMinor + expectedCostsRemainingMinor;
  const totalExpectedOverflow = totalExpectedSum !== null && !Number.isSafeInteger(totalExpectedSum);
  const totalExpectedMinor = totalExpectedOverflow ? null : totalExpectedSum;
  const aggregateReason = knownCommittedOverflow || totalExpectedOverflow ? ("UNSAFE_AMOUNT" as const) : null;

  const route: DealFinancialSummary["supplier"]["route"] = !input.routeKnown
    ? "UNKNOWN"
    : input.settlesDirectToSupplier
      ? "DIRECT_TO_SUPPLIER"
      : "THROUGH_DEALERSHIP";

  return {
    currency,
    customerSalePrice: customerSalePriceFor(app),
    approvedPurchaseAmountMinor: app.approvedDealerPurchaseAmountMinor ?? null,
    customerPaidToDealer,
    customerGapCashPlannedMinor: app.customerGapCashToDealerMinor ?? null,
    customerFirstPaymentMinor: app.customerFirstPaymentMinor ?? null,
    financier: {
      fundedPortionMinor: app.financeCompanyFundedPortionMinor ?? null,
      outstanding: financierOutstandingFor({
        routeKnown: input.routeKnown,
        settlesDirect: input.settlesDirectToSupplier,
        financier,
        expectedDealerRemittanceMinor: app.expectedDealerRemittanceMinor,
      }),
    },
    dealerOutlay: {
      plannedContributionMinor,
      recordedCostsMinor,
      recordedCostsReason,
      awaitingActuals: input.expenses.awaitingActuals,
      knownCommittedMinor,
      expectedCostsRemainingMinor,
      expectedCostsReason: input.expectedDealerBorne.reason,
      totalExpectedMinor,
      aggregateReason,
    },
    supplier: {
      consigned: input.vehicleConsigned,
      // The party row is the obligation authority's own verdict; a deal with
      // no supplier row at all (never possible from the cockpit, but the type
      // allows it) is reported UNKNOWN rather than as "nothing owed".
      direction:
        supplier === undefined || supplier.position === "DEALERSHIP_HOLDS"
          ? "UNKNOWN"
          : supplier.position,
      amountMinor:
        supplier === undefined || supplier.position === "UNKNOWN" || supplier.currency !== currency
          ? null
          : supplier.amountMinor,
      route,
    },
    profit: input.profit,
  };
}
