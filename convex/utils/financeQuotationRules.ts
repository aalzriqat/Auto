import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { computeSubmittedQuotation } from "../../lib/financingEconomics";
import { buildRuleSnapshot, evaluateQuotationException, resolveAppliedLtv, type FinanceCompanyRuleSnapshot } from "./financingEconomics";
import { toMinorSameCurrencyOrUndefined } from "./money";
import { resolveDealCurrency } from "./settlementDeductions";

/**
 * The rule snapshot governing a deal.
 *
 * Reads the copy stored on the application when there is one. Falling back to
 * the live company row is only for applications created before snapshots
 * existed — and it is a fallback, not the normal path, because reading rules
 * live is precisely how editing a company's LTV next month would retroactively
 * change what a closed deal was approved under.
 */
export async function resolveRuleSnapshot(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">
): Promise<FinanceCompanyRuleSnapshot> {
  if (app.companyRuleSnapshot) return app.companyRuleSnapshot;
  if (!app.companyId) {
    throw new ConvexError(
      "This application has no finance company, so it has no dealer-side purchase rules."
    );
  }
  const company = await ctx.db.get(app.companyId);
  if (!company || company.orgId !== app.orgId) {
    throw new ConvexError("Finance company not found in this organization.");
  }
  return buildRuleSnapshot(company);
}

/** Why an exception was refused, phrased for the person who asked for it. */
function quotationExceptionRefusal(
  evaluation: ReturnType<typeof evaluateQuotationException>,
  snapshot: FinanceCompanyRuleSnapshot
): string {
  if (evaluation.reason === "NOT_ALLOWED") {
    return `${snapshot.companyName} does not accept the submitted quotation when the appraisal is lower.`;
  }
  if (evaluation.reason === "NO_SHORTFALL") {
    return "There is no appraisal shortfall, so no exception is needed.";
  }
  return `The appraisal is ${evaluation.shortfallPercent.toFixed(2)}% below the quotation, outside ${snapshot.companyName}'s tolerance of ${snapshot.lowerAppraisalTolerancePercent ?? 0}%.`;
}

/**
 * Enforces the rule belonging to the basis the caller named.
 *
 * Extracted from the approval handler so each basis reads as one rule rather
 * than a branch inside a function that also loads the application, resolves the
 * LTV and the appraisal, writes an audit row and patches three times.
 */
/**
 * Whether the company's LTV rule is applied to an APPRAISAL amount.
 *
 * `resolveLtvBaseMinor` needs the appraisal for these two bases and cannot
 * compute a funding split without one, whatever basis the approval was recorded
 * under — which is why the approval keeps the appraisal as its LTV base even
 * when the decision itself was a manually named figure.
 */
export function ltvRuleNeedsAppraisal(ltvBasis: FinanceCompanyRuleSnapshot["ltvBasis"]): boolean {
  return ltvBasis === "INDEPENDENT_APPRAISAL" || ltvBasis === "LOWER_OF_APPRAISAL_AND_QUOTATION";
}

export function assertApprovalBasisValid(args: {
  basis: "APPRAISAL" | "QUOTATION_EXCEPTION" | "MANUAL";
  approvedAmountMinor: number;
  submittedQuotationMinor: number;
  appraisal: Doc<"financeAppraisals"> | undefined;
  snapshot: FinanceCompanyRuleSnapshot;
  notes?: string;
}): void {
  if (args.basis === "APPRAISAL") {
    const appraised = args.appraisal!.appraisalAmountMinor;
    if (args.approvedAmountMinor !== appraised) {
      throw new ConvexError(
        `An approval based on the appraisal must equal it (${appraised}). Use the exception or manual basis to approve a different amount.`
      );
    }
    return;
  }

  if (args.basis === "QUOTATION_EXCEPTION") {
    if (args.approvedAmountMinor !== args.submittedQuotationMinor) {
      throw new ConvexError(
        "A quotation exception approves at the submitted quotation. Use the manual basis for any other amount."
      );
    }
    const evaluation = evaluateQuotationException({
      submittedQuotationMinor: args.submittedQuotationMinor,
      independentAppraisalMinor: args.appraisal!.appraisalAmountMinor,
      allowsQuotationAboveAppraisal: args.snapshot.allowsQuotationAboveAppraisal ?? false,
      lowerAppraisalTolerancePercent: args.snapshot.lowerAppraisalTolerancePercent ?? 0,
    });
    if (!evaluation.eligible) {
      throw new ConvexError(quotationExceptionRefusal(evaluation, args.snapshot));
    }
    return;
  }

  if (!args.notes?.trim()) {
    throw new ConvexError("A manually approved purchase amount must record why.");
  }
}

/** The solver inputs a caller may override; anything omitted comes off the deal. */
interface QuotationSolverOverrides {
  targetSellingAmountMinor?: number;
  estimatedDealerBorneExpensesMinor?: number;
  quotationBufferMinor?: number;
  customerFirstPaymentMinor?: number;
  ltvPercent?: number;
}

type CustomerFirstPaymentSource = "EXPLICIT" | "STORED" | "QUOTE_SEED";

/**
 * The customer first payment a quotation is solved with, and where it came
 * from (SCRUM-373).
 *
 * An absent first payment is UNKNOWN, never zero. This replaced
 * `override ?? stored ?? 0`, which persisted a confident zero onto every
 * application created before `createFromQuote` seeded the field — seven of ten
 * production deals, one of them showing 0 beside a quote that said 700.
 *
 * Order: an explicit argument; else the value already on the application (a
 * stored zero included — refusing to trust it is the historical correction's
 * job, not this resolver's); else the originating quote's down payment, the
 * same seed `createFromQuote` writes, read only from a quote owned by the
 * deal's own org. Undefined when none exists: the caller refuses rather than
 * solving with a substitute.
 */
async function resolveCustomerFirstPayment(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">,
  override: number | undefined
): Promise<{ minor: number; source: CustomerFirstPaymentSource } | undefined> {
  if (override !== undefined) return { minor: override, source: "EXPLICIT" };
  if (app.customerFirstPaymentMinor !== undefined) {
    return { minor: app.customerFirstPaymentMinor, source: "STORED" };
  }
  const minor = await quoteDownPaymentMinor(ctx, app, await ctx.db.get(app.quoteId));
  return minor === undefined ? undefined : { minor, source: "QUOTE_SEED" };
}

/**
 * The originating quote's down payment in the deal's minor units — the seed
 * `createFromQuote` writes — read only from a quote owned by the deal's org.
 * Undefined when there is no readable one.
 */
export async function quoteDownPaymentMinor(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">,
  quote: Doc<"quotes"> | null
): Promise<number | undefined> {
  if (!quote || quote._id !== app.quoteId || quote.orgId !== app.orgId) return undefined;
  if (typeof quote.downPayment !== "number" || !Number.isFinite(quote.downPayment)) {
    return undefined;
  }
  const currency = await resolveDealCurrency(ctx, app, "seeding the customer's first payment");
  // The non-throwing conversion: `toMinorUnits` throws on overflow, which
  // would surface its own text instead of CUSTOMER_FIRST_PAYMENT_UNKNOWN. A
  // quote saved today cannot hold such an amount; a legacy or hand-edited one can.
  const minor = toMinorSameCurrencyOrUndefined(quote.downPayment, currency, currency);
  if (minor === undefined || minor < 0) return undefined;
  return minor;
}

/**
 * Stable, figure-free: safe for a caller who may not read finance economics
 * (the query forwards ConvexError text only to finance readers anyway).
 */
const CUSTOMER_FIRST_PAYMENT_UNKNOWN =
  "The customer's first payment is not recorded on this deal and its originating quote does not carry one. Record it before the quotation.";

/**
 * The solver itself, once the rules, the applied LTV and every input are
 * resolved: the company's minimum-first-payment rule, then the engine.
 *
 * Pure, and shared by `solveQuotationForApplication` (an existing deal) and
 * `previewCreationQuotation` (a deal about to be created from a quote), so the
 * figure the wizard shows is computed by the same code the recorder will
 * demand equality with (SCRUM-404). The LTV is resolved by each caller BEFORE
 * its own first-payment resolution, which keeps the existing refusal order.
 *
 * Throws a `ConvexError` for the minimum-first-payment rule and lets the
 * engine's `FinancingEconomicsError` through (e.g. an amount that overflows at
 * a tiny LTV). `undefined` when no target exists.
 */
export function solveQuotationFromResolvedInputs(inputs: {
  snapshot: FinanceCompanyRuleSnapshot;
  appliedLtvPercent: number;
  customerFirstPaymentMinor: number;
  targetForSolver: number | undefined;
  expensesForSolver: number | undefined;
  bufferForSolver: number | undefined;
}): ReturnType<typeof computeSubmittedQuotation> | undefined {
  const { snapshot, customerFirstPaymentMinor, targetForSolver } = inputs;
  if (
    snapshot.minimumCustomerFirstPaymentMinor !== undefined &&
    customerFirstPaymentMinor < snapshot.minimumCustomerFirstPaymentMinor
  ) {
    throw new ConvexError(
      `${snapshot.companyName} requires a customer first payment of at least ${snapshot.minimumCustomerFirstPaymentMinor} minor units.`
    );
  }
  if (targetForSolver === undefined) return undefined;
  return computeSubmittedQuotation({
    targetNetProceedsMinor: targetForSolver,
    // Never back-solved from the quotation: with nothing itemized this is
    // zero and the suggestion is correspondingly lower, which is the
    // honest figure rather than a fabricated allowance.
    estimatedDealerBorneExpensesMinor: inputs.expensesForSolver ?? 0,
    quotationBufferMinor: inputs.bufferForSolver,
    customerFirstPaymentMinor,
    appliedLtvPercent: inputs.appliedLtvPercent,
    customerFirstPaymentOffsetsUnfinancedShare:
      snapshot.customerFirstPaymentOffsetsUnfinancedShare,
  });
}

/**
 * Runs the solver for an EXISTING application, under the rules that govern it.
 *
 * One function, two callers — `suggestQuotationForApplication` and
 * `recordSubmittedQuotation` — because the mutation now demands exact equality
 * with the solver's figure, and the only query that solved anything took a
 * `companyId` and built its snapshot from the LIVE company row. A deal created
 * under v1 whose company was since edited to v2 would therefore be shown a v2
 * figure and have it rejected against v1, with the error naming a number the
 * screen never displayed. Sharing the resolution makes "what you were shown is
 * what will be accepted" structural rather than a coincidence maintained by
 * hand in two places.
 *
 * Returns `result: undefined` when no target is recorded anywhere, which is a
 * different state from the solver running and being unavailable.
 */
export async function solveQuotationForApplication(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">,
  overrides: QuotationSolverOverrides
): Promise<{
  snapshot: FinanceCompanyRuleSnapshot;
  appliedLtvPercent: number;
  customerFirstPaymentMinor: number;
  customerFirstPaymentSource: CustomerFirstPaymentSource;
  targetForSolver: number | undefined;
  expensesForSolver: number | undefined;
  bufferForSolver: number | undefined;
  result: ReturnType<typeof computeSubmittedQuotation> | undefined;
}> {
  const snapshot = await resolveRuleSnapshot(ctx, app);
  const appliedLtvPercent = resolveAppliedLtv(
    snapshot,
    overrides.ltvPercent ?? app.appliedLtvPercent
  );

  const firstPayment = await resolveCustomerFirstPayment(
    ctx,
    app,
    overrides.customerFirstPaymentMinor
  );
  if (firstPayment === undefined) {
    throw new ConvexError(CUSTOMER_FIRST_PAYMENT_UNKNOWN);
  }
  const customerFirstPaymentMinor = firstPayment.minor;
  if (app.approvedLenderCorrectionId !== undefined && customerFirstPaymentMinor !== 0) {
    throw new ConvexError("This lender correction is for an agreement without a first payment.");
  }

  const targetForSolver = overrides.targetSellingAmountMinor ?? app.targetNetProceedsMinor;
  const expensesForSolver =
    overrides.estimatedDealerBorneExpensesMinor ?? app.estimatedDealerBorneExpensesMinor;
  const bufferForSolver = overrides.quotationBufferMinor ?? app.quotationBufferMinor;

  const result = solveQuotationFromResolvedInputs({
    snapshot,
    appliedLtvPercent,
    customerFirstPaymentMinor,
    targetForSolver,
    expensesForSolver,
    bufferForSolver,
  });

  return {
    snapshot,
    appliedLtvPercent,
    customerFirstPaymentMinor,
    customerFirstPaymentSource: firstPayment.source,
    targetForSolver,
    expensesForSolver,
    bufferForSolver,
    result,
  };
}
