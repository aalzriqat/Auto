import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { assertFeeTemplatesWithinLimit } from "./dealCostLimits";
import { buildRuleSnapshot, type FinanceCompanyRuleSnapshot } from "./financingEconomics";
import { assertValidMinorAmount, toMinorUnits } from "./money";

/**
 * The dealer-side economics a financed deal is CREATED with, resolved from its
 * quote — shared by `applications.createFromQuote`, which writes them, and
 * `financingEconomics.previewCreationQuotation`, which shows the quotation they
 * produce before the deal exists (SCRUM-404).
 *
 * One copy on purpose. The wizard sends back the previewed figure as a
 * confirmation and the recorder demands exact equality with its own solver, so
 * a second hand-written resolution would turn every drift between the two into
 * a creation that always refuses.
 *
 * Lives in `utils/` rather than in `applications.ts` so the preview can import
 * it without `financingEconomics.ts` importing `applications.ts`, which already
 * imports it — a module-init cycle is the failure this placement avoids.
 */

/**
 * Canonical resolver for a deal's expected execution-fee authority.
 * Enforces the route-wide single-authority invariants across createFromQuote
 * and repairQuoteEconomicsLineage:
 * - CONFIGURED_FINANCE_COMPANY requires companyRuleSnapshot.adminFees (or legacy feeTemplates)
 * - MANUAL_FINANCE_COMPANY requires quote.manualAdminFees
 * - Ambiguous quotes (e.g. companyId with missing/invalid mode) fail closed
 * - Explicit 0 is valid and resolves to 0
 * - Absent authority rejects and NEVER silently converts to 0
 *
 * Moved here unchanged from `applications.ts`, which re-exports it.
 */
export function resolveExpectedExecutionFeesMinor(args: {
  quote: {
    mode?: string;
    companyId?: Id<"financeCompanies">;
    manualAdminFees?: number;
  };
  companyRuleSnapshot?: FinanceCompanyRuleSnapshot;
  currency: string;
}): number {
  const { quote, companyRuleSnapshot, currency } = args;

  // Ambiguous quote: company is attached but mode is not CONFIGURED_FINANCE_COMPANY
  if (quote.companyId !== undefined && quote.mode !== "CONFIGURED_FINANCE_COMPANY") {
    throw new ConvexError(
      "Finance company can only be set for configured finance company quotes."
    );
  }

  if (quote.mode === "CONFIGURED_FINANCE_COMPANY") {
    if (!quote.companyId || !companyRuleSnapshot) {
      throw new ConvexError(
        "The application's frozen finance-company policy is missing. Reconcile the policy snapshot before repairing quotation economics."
      );
    }
    if (companyRuleSnapshot.adminFees !== undefined) {
      const minor = toMinorUnits(companyRuleSnapshot.adminFees, currency);
      assertValidMinorAmount(minor, "frozen admin fee total");
      return minor;
    }
    // Historical legacy fallback: snapshot preserved feeTemplates from before single fee authority
    if (companyRuleSnapshot.feeTemplates && companyRuleSnapshot.feeTemplates.length > 0) {
      return companyRuleSnapshot.feeTemplates
        .filter(
          (template) =>
            template.includedInQuotation &&
            (template.paidBy === "DEALER" || template.paidBy === "EMPLOYEE")
        )
        .reduce((total, template) => {
          assertValidMinorAmount(template.estimatedAmountMinor, "included fee estimate");
          const next = total + template.estimatedAmountMinor;
          assertValidMinorAmount(next, "included dealer-borne fee total");
          return next;
        }, 0);
    }
    throw new ConvexError(
      "Execution Fees are not configured for this finance company. Enter the expected execution fee amount, or enter 0 if none are charged."
    );
  }

  if (quote.mode === "MANUAL_FINANCE_COMPANY") {
    if (quote.manualAdminFees === undefined) {
      throw new ConvexError(
        "Execution Fees are not configured for this manual finance company quote. Enter the expected execution fee amount, or enter 0 if none are charged."
      );
    }
    const minor = toMinorUnits(quote.manualAdminFees, currency);
    assertValidMinorAmount(minor, "manual admin fee total");
    return minor;
  }

  return 0;
}

/**
 * The finance company's dealer-purchase rules a deal created from this quote
 * is governed by.
 *
 * When the quote froze its rule snapshot at creation, that frozen authority is
 * preserved so subsequent edits to the finance company cannot silently
 * reinterpret the financial basis (installment, financed amount, DBR, LTV).
 * Only a CONFIGURED quote has one; `undefined` for every other mode, and for a
 * configured quote that has neither a frozen snapshot nor a company row.
 *
 * `company` is the quote's own finance company, already read and
 * tenant-checked by the caller — this reads nothing.
 */
export function resolveCreationRuleSnapshot(
  quote: Pick<Doc<"quotes">, "mode" | "companyRuleSnapshot">,
  company: Doc<"financeCompanies"> | null
): FinanceCompanyRuleSnapshot | undefined {
  if (quote.mode !== "CONFIGURED_FINANCE_COMPANY") return undefined;
  let snapshot: FinanceCompanyRuleSnapshot | undefined;
  if (quote.companyRuleSnapshot) {
    snapshot = quote.companyRuleSnapshot;
  } else if (company) {
    snapshot = buildRuleSnapshot(company);
  }
  if (snapshot?.feeTemplates && snapshot.adminFees === undefined) {
    assertFeeTemplatesWithinLimit(
      snapshot.feeTemplates,
      `Creating an application under ${company?.name ?? snapshot.companyName}`
    );
  }
  return snapshot;
}

/**
 * The commercial facts the operator already stated on the quote, in the deal's
 * minor units.
 *
 * The quote stores major units; application economics are always minor units
 * in an explicit denomination. The caller resolves and validates that
 * denomination; this converts once at the lineage boundary. A corrupt
 * NaN/negative legacy quote fails closed rather than seeding unusable economics
 * (Convex's v.number() accepts NaN).
 *
 * Only costs the frozen policy explicitly says are included in the quotation
 * belong in the solver input — see `resolveExpectedExecutionFeesMinor`.
 */
export function resolveCreationEconomicsInputs(args: {
  quote: Pick<
    Doc<"quotes">,
    "vehiclePrice" | "downPayment" | "mode" | "companyId" | "manualAdminFees"
  >;
  companyRuleSnapshot: FinanceCompanyRuleSnapshot | undefined;
  currency: string;
}): {
  targetSellingAmountMinor: number;
  customerFirstPaymentMinor: number;
  dealerBorneExpensesMinor: number;
} {
  const { quote, companyRuleSnapshot, currency } = args;
  const targetSellingAmountMinor = toMinorUnits(quote.vehiclePrice, currency);
  const customerFirstPaymentMinor = toMinorUnits(quote.downPayment, currency);
  assertValidMinorAmount(targetSellingAmountMinor, "quoted vehicle price");
  assertValidMinorAmount(customerFirstPaymentMinor, "quoted customer first payment");
  const dealerBorneExpensesMinor = resolveExpectedExecutionFeesMinor({
    quote,
    companyRuleSnapshot,
    currency,
  });
  return { targetSellingAmountMinor, customerFirstPaymentMinor, dealerBorneExpensesMinor };
}
