import type { Doc } from "../_generated/dataModel";
import { pricingSnapshotsEqual } from "./financingEconomics";
import { throwAppError, AppErrorCode } from "./errors";
import { isManualFinanceApplication } from "./manualFinancePayer";

/** SCRUM-528. Must equal `ServerError_QUOTE_ECONOMICS_DRIFTED` (en) in lib/i18n/domains/sales.ts. No figures: it names the way out. */
export const QUOTE_ECONOMICS_DRIFTED_MESSAGE =
  "The quotation's pricing no longer matches the pricing frozen on this finance application, so the deal cannot be finalized. Cancel the finance application and start again from a new quotation.";

/**
 * SCRUM-533. Must equal `ServerError_QUOTE_PRICING_SNAPSHOT_MISMATCH` (en) in lib/i18n/domains/sales.ts.
 * Raised by `createFromQuote` when the quote disagrees with its own saved pricing snapshot (or a
 * financed quote has none). A quotation is never edited (`saveQuote` only inserts), so the way out is a new one.
 */
export const QUOTE_PRICING_SNAPSHOT_MISMATCH_MESSAGE =
  "This quotation's pricing does not match its saved pricing details, so a finance application cannot be started from it. Create a new quotation and start the application from that.";

type AnchorApp = Pick<
  Doc<"financeApplications">,
  "customerQuotePricingSnapshot" | "companyId" | "quoteModeAtSubmission"
>;
type AnchorQuote = Pick<
  Doc<"quotes">,
  "vehiclePrice" | "downPayment" | "totalFinancedAmount" | "termMonths" | "customerQuotePricingSnapshot"
>;
type AnchorSnapshot = NonNullable<Doc<"financeApplications">["customerQuotePricingSnapshot"]>;

/**
 * SCRUM-533. The one definition of "the quote's top-level figures equal the frozen snapshot", shared by
 * `createFromQuote` (admit) and `assertQuoteEconomicsMatchFrozen` (finalize) so they cannot drift apart.
 * Strict equality: `saveQuote` fills both from the same variables.
 */
export function quoteAgreesWithSnapshot(
  quote: Pick<AnchorQuote, "vehiclePrice" | "downPayment" | "totalFinancedAmount" | "termMonths">,
  snap: Pick<AnchorSnapshot, "vehiclePrice" | "downPayment" | "totalFinancedAmount" | "termMonths">
): boolean {
  return (
    quote.vehiclePrice === snap.vehiclePrice &&
    quote.downPayment === snap.downPayment &&
    quote.totalFinancedAmount === snap.totalFinancedAmount &&
    quote.termMonths === snap.termMonths
  );
}

/**
 * SCRUM-533. Whether a deal finalizes as financed, from the quote mode and company only. Shared by
 * `createFromQuote` (refuse a financed quote with no snapshot) and `assertQuoteEconomicsMatchFrozen`.
 * A manual application (no company, MANUAL_FINANCE_COMPANY) is covered by the mode test.
 */
export function isFinancedDeal(mode: string | undefined, companyId: unknown): boolean {
  return mode === "CONFIGURED_FINANCE_COMPANY" || mode === "MANUAL_FINANCE_COMPANY" || !!companyId;
}

/**
 * SCRUM-528. Once a finance application exists, the sale `finalizeDeal` builds (price, down payment,
 * loan amount, term) comes only from quote economics that still agree with the economics frozen on
 * the application at `createFromQuote`. Any disagreement refuses, before the first write.
 *
 * - Snapshot present: the quote's top-level figures AND its own snapshot must equal it exactly
 *   (`saveQuote` fills both from the same variables, so strict equality is correct).
 * - Snapshot absent on a deal that finalizes as financed (finance-company mode, a company, or a manual
 *   application): nothing to anchor to, so it fails closed. A cash deal has no finance application
 *   economics and is not compared.
 */
export function assertQuoteEconomicsMatchFrozen(
  app: AnchorApp,
  quote: AnchorQuote,
  mode: string | undefined
): void {
  const snap = app.customerQuotePricingSnapshot;
  if (snap) {
    const agrees = quoteAgreesWithSnapshot(quote, snap) && pricingSnapshotsEqual(snap, quote.customerQuotePricingSnapshot);
    if (!agrees) throwAppError(AppErrorCode.QUOTE_ECONOMICS_DRIFTED, QUOTE_ECONOMICS_DRIFTED_MESSAGE);
    return;
  }
  if (isFinancedDeal(mode, app.companyId) || isManualFinanceApplication(app)) throwAppError(AppErrorCode.QUOTE_ECONOMICS_DRIFTED, QUOTE_ECONOMICS_DRIFTED_MESSAGE);
}
