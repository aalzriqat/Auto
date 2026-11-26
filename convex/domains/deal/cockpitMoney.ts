import { FINANCE_APP_RECEIVABLE_SOURCE } from "./financeReceivables";
import {
  cockpitFeeSummary,
  cockpitManagementProfit,
  resolveSupplierSettlementMinor,
} from "../../utils/dealSettlementFigures";
import type { QueryCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { canReadVehicleCost } from "../../utils/vehicleCostVisibility";
import { displayableDepositReference } from "../../utils/depositRecording";
import { deriveForwardState } from "../../utils/financeCompanyForward";
import { getOrgCurrency } from "../../accounting/workflowHooks";
import {
  toMinorSameCurrencyOrUndefined,
  outstandingMinorFromMajor,
} from "../../utils/money";
import {
  shortfallState,
  positionForObligation,
  supplierReceiptActionability,
} from "../../utils/financingEconomics";
import {
  firstPaymentCorrectionBlock,
  mayCorrectFirstPayment,
} from "../../utils/firstPaymentCorrection";
import { manualPayerLabel } from "../../utils/manualFinancePayer";
import { quoteDownPaymentMinor } from "../../utils/financeQuotationRules";
import type { resolveSettlement } from "./cockpitSettlement";
import { getQuoteDeposits } from "./dealDeposits";

export type ReadReceivableOutstanding = (
  ctx: QueryCtx,
  receivableId: Id<"receivableDocuments">,
) => Promise<number>;

/**
 * The money half of the cockpit: `أطراف الصفقة` and the headline figure.
 *
 * Every row arrives already classified — who holds the money, which way it is
 * owed, and whether an action is available — rather than as a raw balance the
 * screen has to interpret. A client deciding for itself that a positive balance
 * on one table means "owed to us" and on another means "we owe" is how the same
 * deal ends up described two different ways on two different screens.
 */

/**
 * `المصاريف الفعلية` — the deal's fee lines and what they total. Extracted from
 * `buildCockpitMoney` unchanged.
 *
 * `actualAmountMinor` unset means unpaid or unrecorded — NOT zero. Only lines
 * with a real actual are summed, and the count of those without one is reported
 * so the screen can say the total is still incomplete rather than presenting a
 * partial sum as the final cost.
 *
 * The dealership's PROFIT is reduced by what the dealership itself bore, which
 * is not the total of every fee on the deal: `paidBy` names who actually paid,
 * and a transfer fee the customer paid or a commission the finance company
 * deducted is not a cost to the dealership. `summarizeFees` already draws that
 * line and is reused rather than reimplemented — a second copy of a money
 * computation is a second answer waiting to disagree.
 */
async function summarizeCockpitExpenses(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  currency: string,
) {
  const fees = await ctx.db
    .query("financeDealFees")
    .withIndex("by_application", (q) => q.eq("applicationId", app._id))
    .collect();
  const liveFees = fees.filter((fee) => fee.voidedAt === undefined);

  return cockpitFeeSummary(app, liveFees, currency);
}

/**
 * What the customer has put in and is still holding. Extracted unchanged.
 *
 * `amountMinor` is OPTIONAL — `amount`, in major units, is the required field,
 * and deposits taken before minor units existed carry only that. Falling back to
 * zero made the screen assert the customer had put nothing in while the AR aging
 * report showed the money.
 *
 * Every amount goes through the query's one guarded conversion. A raw
 * `toMinorUnits` survived here once, and a legacy deposit carrying only a
 * non-representable `amount` would have thrown and taken the whole cockpit down
 * on the single row the guard was not applied to. A deposit that cannot be read
 * is left out of the total AND counted, so the screen can say the figure is
 * incomplete rather than quietly understating what the customer has paid.
 */
async function resolveCustomerDeposits(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  opts: { quote: Doc<"quotes"> | null; currency: string },
) {
  const { quote, currency } = opts;
  const deposits = quote ? await getQuoteDeposits(ctx, app.quoteId) : [];
  const heldDeposits = deposits.filter((deposit) => deposit.status === "HELD");

  let unreadableDeposits = 0;
  const heldDepositMinor = heldDeposits.reduce((total, deposit) => {
    const depositCurrency = deposit.currency ?? currency;
    // The currency is checked BEFORE choosing which field supplies the amount.
    // Written as `amountMinor ?? convert(...)` the check lived only inside the
    // fallback, so a foreign-currency deposit that happened to carry
    // `amountMinor` was added to the total unconverted — 500 USD cents counted
    // as 500 JOD fils. The stored minor amount is denominated too; it is not a
    // currency-free number.
    const minor =
      depositCurrency !== currency
        ? undefined
        : (deposit.amountMinor ??
          toMinorSameCurrencyOrUndefined(
            deposit.amount,
            depositCurrency,
            currency,
          ));
    if (minor === undefined) {
      // Counted whatever the reason — unreadable amount OR another currency.
      unreadableDeposits += 1;
      return total;
    }
    return total + minor;
  }, 0);

  // The mockup shows a receipt number against the customer row. It lives on the
  // canonical payment, not the deposit.
  const depositPaymentId = heldDeposits.find(
    (deposit) => deposit.canonicalPaymentId,
  )?.canonicalPaymentId;
  const depositPayment = depositPaymentId
    ? await ctx.db.get(depositPaymentId)
    : null;

  return { heldDepositMinor, unreadableDeposits, depositPayment };
}

/** `amountDue` is stored in MAJOR units on both supplier tables, unlike every
 *  `*Minor` field on the application. Converting at the ROW's own currency, and
 *  refusing to mix currencies, is what keeps a 3-decimal JOD figure from being
 *  read as a 2-decimal one. Both callers subtract AFTER conversion: taking the
 *  difference in major units first leaves a float residue that the row then
 *  displays as a balance still outstanding. */
function customerPosition(args: {
  routeKnown: boolean;
  unreadableDeposits: number;
  heldDepositMinor: number;
}) {
  if (!args.routeKnown) return "UNKNOWN" as const;
  // A deposit whose amount could not be read makes this row's total a partial
  // one. Reporting NOT_INVOLVED would tell the dealership the customer had put
  // nothing in.
  if (args.unreadableDeposits > 0) return "UNKNOWN" as const;
  return args.heldDepositMinor > 0
    ? ("DEALERSHIP_HOLDS" as const)
    : ("NOT_INVOLVED" as const);
}

function financierPosition(args: {
  routeKnown: boolean;
  settlesDirect: boolean;
  hasReceivable: boolean;
  outstandingMinor: number | undefined;
}) {
  if (!args.routeKnown) return "UNKNOWN" as const;
  // It paid the supplier directly, so it never owed the dealership anything on
  // this deal. Reporting a zero receivable would suggest a debt that was
  // settled; there was never one to settle.
  if (args.settlesDirect) return "NOT_INVOLVED" as const;
  if (!args.hasReceivable) return "NOT_INVOLVED" as const;
  // A balance in another currency is a balance nobody here can state. Rendering
  // "owes 0" would report a real debt as settled.
  if (args.outstandingMinor === undefined) return "UNKNOWN" as const;
  return args.outstandingMinor === 0
    ? ("SETTLED" as const)
    : ("OWED_TO_DEALERSHIP" as const);
}

async function buildCockpitMoney(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  quote: Doc<"quotes"> | null,
  settlementFacts: Awaited<ReturnType<typeof resolveSettlement>>,
  getReceivableOutstandingMinor: ReadReceivableOutstanding,
) {
  const currency =
    app.economicsCurrency ?? (await getOrgCurrency(ctx, app.orgId));
  const { vehicle, routeKnown, settlesDirect, moneySettled } = settlementFacts;
  const supplierName = vehicle?.sourcedFromName ?? "";

  const expenses = await summarizeCockpitExpenses(ctx, app, currency);
  const {
    feeLines,
    actualExpensesMinor,
    feesAwaitingActuals,
    expensesFullyReconciled,
    executionFee,
  } = expenses;

  // --- the supplier's position -----------------------------------------
  const payables = app.finalizedSaleId
    ? await ctx.db
        .query("vehicleSupplierPayables")
        .withIndex("by_sale", (q) => q.eq("saleId", app.finalizedSaleId))
        .collect()
    : await ctx.db
        .query("vehicleSupplierPayables")
        .withIndex("by_vehicle", (q) => q.eq("vehicleId", app.vehicleId))
        .collect();
  const payable = payables.find(
    (row) => row.orgId === app.orgId && row.status !== "CANCELLED",
  );
  // Converted before subtracting, as above.
  const payableOutstandingMinor = payable
    ? outstandingMinorFromMajor(
        payable.amountDue,
        payable.amountPaid ?? 0,
        payable.currency,
        currency,
      )
    : undefined;

  const supplierClaim = settlementFacts.supplierClaim;
  // Two different figures, and conflating them was a CRITICAL defect.
  //
  // OUTSTANDING is what the supplier still owes — the party row and the
  // collection action. ORIGINAL is what the dealership earned on the deal, and
  // it never moves: `recordReceipt` patches `amountReceived` and leaves
  // `amountDue` alone. Deriving the headline from the outstanding figure made
  // every dinar collected reduce reported profit one-for-one, so a fully
  // collected deal reported a loss equal to its expenses — and it was already
  // wrong on day one, because `openSupplierReceivable` seeds `amountReceived`
  // with any customer deposit applied at sale time.
  //
  // ORIGINAL is no longer computed here at all. The headline reads the margin
  // from `settlementFacts.margin`, which resolves it once from immutable
  // sale-time records; a second local reading of `amountDue` was how the party
  // row and the headline came to disagree in the first place.
  const supplierClaimOutstandingMinor = supplierClaim
    ? outstandingMinorFromMajor(
        supplierClaim.amountDue,
        supplierClaim.amountReceived ?? 0,
        supplierClaim.currency,
        currency,
      )
    : undefined;

  // --- the finance company's position ----------------------------------
  const financeReceivables = await ctx.db
    .query("receivableDocuments")
    .withIndex("by_org_source", (q) =>
      q
        .eq("orgId", app.orgId)
        .eq("sourceType", FINANCE_APP_RECEIVABLE_SOURCE)
        .eq("sourceId", app._id),
    )
    .collect();
  // CANCELLED is not the only status that means "nothing is owed". A written-off
  // or reversed receivable would otherwise render at its full outstanding
  // balance, asserting the finance company still owes money the dealership has
  // already given up on.
  const financeReceivable = financeReceivables.find(
    (row) =>
      row.status !== "CANCELLED" &&
      row.status !== "WRITTEN_OFF" &&
      row.status !== "REVERSED",
  );
  // Through the shared subledger helper rather than a second summation here.
  // The balance is not stored on the document — a copy of a figure derivable
  // from the allocations is a figure that can disagree with them — and this
  // helper is what the mutation side already trusts, including its handling of
  // reversed allocations, which must not count as paid.
  const financeOutstandingMinor =
    financeReceivable && financeReceivable.currency === currency
      ? await getReceivableOutstandingMinor(ctx, financeReceivable._id)
      : undefined;

  const { heldDepositMinor, unreadableDeposits, depositPayment } =
    await resolveCustomerDeposits(ctx, app, { quote, currency });

  const parties = [
    {
      party: "CUSTOMER" as const,
      name: "",
      position: customerPosition({
        routeKnown,
        unreadableDeposits,
        heldDepositMinor,
      }),
      amountMinor: heldDepositMinor,
      currency,
      // Never the machine key `Deposit <id>` (SCRUM-629 F-23).
      reference: displayableDepositReference(depositPayment?.externalReference),
    },
    settlesDirect && routeKnown
      ? {
          party: "SUPPLIER" as const,
          name: supplierName,
          // On the direct route the financier pays the supplier, so nothing is
          // owed TO him — what remains is the dealership's agency margin, owed
          // BY him. Same row, opposite direction, which is exactly why the
          // screen cannot hard-code the mockup's THROUGH_DEALERSHIP layout.
          //
          // Read from the OBLIGATION, not re-derived from the claim. Deriving it
          // here independently made one response contradict itself: a
          // zero-margin deal has no claim, so this said UNKNOWN while the
          // obligation said NONE and the stage rail said COMPLETE — the screen
          // announcing the deal was finished and that it could not tell, at the
          // same time. There is one authority on who still owes what.
          position: positionForObligation(
            settlementFacts.obligations.supplier,
            "OWED_TO_DEALERSHIP",
          ),
          amountMinor: supplierClaimOutstandingMinor ?? 0,
          currency,
          reference: supplierClaim?.receiptReference,
          // The collection action is keyed to THIS claim. Returning the id the
          // server already resolved means the client never names a receivable
          // of its own choosing — `recordReceipt` re-checks the org anyway, but
          // a screen that can only act on the claim it was shown is a smaller
          // surface than one that can post against any id it can guess.
          receivableId: supplierClaim?._id,
        }
      : {
          party: "SUPPLIER" as const,
          name: supplierName,
          // What is LEFT on the payable, not what it started at. `amountPaid`
          // exists and was previously ignored, so a part-paid payable overstated
          // the debt and a settled one still displayed a full balance — three
          // rows on one panel following two different conventions.
          // Same authority as the direct row above: the obligation, not a second
          // reading of the payable.
          position: positionForObligation(
            settlementFacts.obligations.supplier,
            "DEALERSHIP_OWES",
          ),
          amountMinor: payableOutstandingMinor ?? 0,
          currency,
          reference: undefined,
        },
    {
      party: "FINANCIER" as const,
      name: manualPayerLabel(app) ?? "",
      position: financierPosition({
        routeKnown,
        settlesDirect,
        hasReceivable: Boolean(financeReceivable),
        outstandingMinor: financeOutstandingMinor,
      }),
      amountMinor: settlesDirect ? 0 : (financeOutstandingMinor ?? 0),
      currency,
    },
  ];

  // What the supplier ends up with, which is what the headline subtracts.
  // THROUGH_DEALERSHIP: the payable the dealership owes him. DIRECT: the
  // approved amount minus the dealership's margin claim, because the financier
  // pays him the gross and he owes the margin back. Both reduce to the same
  // economics — margin less expenses — which is the point of computing it here
  // once rather than twice on the client.
  const supplierSettlementMinor = resolveSupplierSettlementMinor({
    routeKnown,
    settlesDirect,
    supplierEntitlement: settlementFacts.supplierEntitlement,
    margin: settlementFacts.margin,
    payable,
    currency,
  });

  // A DIRECT deal can never reach FULLY_SETTLED through the status field: the
  // only writer of it is `confirmDisbursement`, which refuses the direct route
  // outright, and `confirmSupplierDisbursement` deliberately writes EXPECTED.
  // Reading settlement off that field alone left the direct route's terminal
  // stage permanently blocked and its qualifier permanently "estimated" — on
  // deals that were completely finished.
  const fullySettled = moneySettled && expensesFullyReconciled;

  const managementProfit = cockpitManagementProfit({
    app,
    saleCancelled: settlementFacts.saleCancelled,
    supplierSettlementMinor,
    actualExpensesMinor,
    executionFee,
    currency,
    fullySettled,
  });
  const cockpitShortfall = shortfallState(app);

  return {
    currency,
    settlesDirectToSupplier: settlesDirect,
    routeKnown,
    /**
     * The canonical headline field, shared with the cash deal screen and typed
     * as the `DealProfit` union so a renderer must branch on `basis`.
     */
    profit: managementProfit,
    /**
     * ⚠️ TRANSITIONAL DUPLICATE — remove once the frontend carrying `profit` is
     * deployed. Tracked as a SCRUM-29 follow-up.
     *
     * This is not indecision about the field name. The Convex backend deploys
     * BEFORE the frontend (merging auto-deploys Vercel, so the order is forced),
     * which means that between the two there is a live frontend reading
     * `money.managementProfit`. Renaming outright would have made that read
     * `undefined` and `undefined.available` throws — white-screening the
     * financed cockpit, a production accounting surface, for the length of the
     * deploy. Emitting both keys costs one line and removes the window entirely.
     */
    managementProfit,
    expenses: {
      lines: feeLines,
      actualTotalMinor: actualExpensesMinor,
      /** Non-zero means the total above is not the whole cost yet. */
      awaitingActuals: feesAwaitingActuals,
    },
    parties,
    /**
     * SCRUM-571 (D-48): what the customer still owes on the deal's canonical
     * invoice, SEPARATE from the CUSTOMER party row above (which states the held
     * deposit position). The state is the one the settlement obligation was judged
     * on and the amount comes from the same read, so the two cannot diverge.
     * `outstandingMinor` is null unless the invoice is proven (OPEN or CLOSED).
     */
    customerInvoice: settlementFacts.customerInvoice,
    /**
     * Whether "Settle supplier" may be recorded NOW, decided here from the same
     * claim `recordReceipt` will refuse on. The supplier row above keeps saying
     * what is owed; this says what may be done about it — a DISPUTED claim is
     * still OWED_TO_DEALERSHIP and still not collectable.
     */
    supplierReceipt: supplierReceiptActionability({
      routeKnown,
      settlesDirect,
      claim: supplierClaim
        ? { id: supplierClaim._id, status: supplierClaim.status }
        : undefined,
      obligation: settlementFacts.obligations.supplier,
    }),
    /** `فرق تخمين` — a read of what was recorded, never a fresh computation. */
    appraisalGapMinor: app.rawAppraisalGapMinor,
    /**
     * SCRUM-766: the amount customer, showroom and supplier actually split - the
     * NET shortfall, never the gross figure above. `totalMinor` is undefined for
     * an UNAVAILABLE shortfall, which the screen must say instead of showing 0.
     */
    shortfall: {
      method: cockpitShortfall.method,
      totalMinor: cockpitShortfall.totalMinor,
      valuationMinor: app.valuationShortfallMinor,
      termsMinor: app.financingTermsShortfallMinor,
    },
  };
}

/**
 * What the supplier ends up with, which is what the headline subtracts.
 * Extracted from `buildCockpitMoney` unchanged.
 *
 * THROUGH_DEALERSHIP: the payable the dealership owes him. DIRECT: what the
 * financier actually paid him, less the margin he owes back.
 */

/**
 * The two records of one supplier payment when they disagree, plus the rest of
 * what the advice says, for the screen that has to state the discrepancy and
 * the form that corrects it.
 *
 * Declared rather than inferred so the cockpit's two return arms carry the same
 * shape: the gated arm supplies it, the ungated arm supplies `null`, and a
 * caller cannot end up with a type that says the field is always absent.
 */
export type SettlementAdviceEvidence = {
  recordedMinor: number | null;
  approvedMinor: number | null;
  currency: string | null;
  recordedReference: string | null;
  recordedAt: number | null;
};

export async function projectCockpitMoney(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  quote: Doc<"quotes"> | null,
  settlementFacts: Awaited<ReturnType<typeof resolveSettlement>>,
  forwardProof: Awaited<ReturnType<typeof deriveForwardState>>,
  user: Doc<"users">,
  role: Doc<"roles">,
  settlementAdviceEvidence: SettlementAdviceEvidence | null,
  getReceivableOutstandingMinor: ReadReceivableOutstanding,
) {
  // SCRUM-373 D2. Money-gated with the rest: it carries the quote's figure.
  // A deal in an unusable denomination cannot state that figure; the cockpit
  // must still render (it withholds money spelling there itself), so the
  // figure reads as unknown and the action is not offered. The mutation
  // refuses the same deal with the denomination's own message.
  //
  // The quote is read only once every cheaper condition passes — the
  // predicate's first answer is then "no quote figure" — so the hot path for
  // ordinary deals pays nothing for it.
  const firstPaymentInput = {
    app,
    actorId: user._id,
    // Exactly the permissions the mutation requires.
    mayApprove: mayCorrectFirstPayment(role),
    quoteDownPaymentMinor: undefined as number | undefined,
  };
  let firstPaymentBlock = firstPaymentCorrectionBlock(firstPaymentInput);
  if (firstPaymentBlock === "NO_QUOTE_DOWN_PAYMENT") {
    try {
      firstPaymentInput.quoteDownPaymentMinor = await quoteDownPaymentMinor(
        ctx,
        app,
        quote,
      );
    } catch {
      firstPaymentInput.quoteDownPaymentMinor = undefined;
    }
    firstPaymentBlock = firstPaymentCorrectionBlock(firstPaymentInput);
  }

  // SCRUM-902: both profit aliases and the supplier balance disclose the cost basis.
  const mayReadCost = canReadVehicleCost(role);
  const costWithheld = {
    available: false,
    reason: "CostAccessRequired",
  } as const;
  const cockpitMoney = await buildCockpitMoney(
    ctx,
    app,
    quote,
    settlementFacts,
    getReceivableOutstandingMinor,
  );

  return {
    settlementAdviceDiscrepancy: settlementAdviceEvidence,
    money: {
      ...cockpitMoney,
      ...(mayReadCost
        ? {}
        : {
            profit: costWithheld,
            managementProfit: costWithheld,
            // The supplier balance is the purchase cost (or the margin it leaves): absent, not zero.
            parties: cockpitMoney.parties.map((party) =>
              party.party === "SUPPLIER"
                ? { ...party, amountMinor: null }
                : party,
            ),
          }),
      // SCRUM-435 FINANCE tier: what is owed onward, and what it is made of.
      forward: {
        dueMinor: forwardProof.dueMinor,
        depositMinor: app.forwardDepositPortionMinor ?? 0,
        // SCRUM-998 #17 (read-only): E, the part of the held deposit kept as dealer income. depositMinor is H - E,
        // so depositMinor + approvalExcessMinor = H (the same pairing recordFinanceCompanyForward uses).
        approvalExcessMinor: app.approvalExcessMinor ?? 0,
        contributionMinor: app.forwardContributionPortionMinor ?? 0,
        onBooksMinor: forwardProof.versions.reduce(
          (sum, version) =>
            version.state === "ON_BOOKS" ? sum + version.amountMinor : sum,
          0,
        ),
      },
    },
    firstPaymentCorrection: {
      /** null when the server would accept the correction. */
      block: firstPaymentBlock,
      quoteDownPaymentMinor: firstPaymentInput.quoteDownPaymentMinor ?? null,
    },
  };
}
