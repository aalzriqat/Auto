import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isMinorAmount } from "./financingEconomics";
import { MAX_DIRECT_PAYMENT_REFERENCE_CHARS } from "./feeDocLimits";
import { manualPayerOf } from "./manualFinancePayer";

/**
 * SCRUM-766 PR-B: the evidence that the customer paid the finance company
 * directly. Only CONFIRMED rows of the CURRENT agreement count;
 * `recomputeAndPatchEconomics` reads the total from here, so the stored
 * contribution cannot drift from the rows.
 *
 * Bounded: a row is recorded only while fewer than this many exist on a deal
 * (voided rows included - they are history, not deleted), so the one read below
 * is complete by construction.
 */
export const MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS = 50;

export async function loadCustomerFinanceCompanyPayments(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  applicationId: Id<"financeApplications">
): Promise<Array<Doc<"customerFinanceCompanyPayments">>> {
  return await ctx.db
    .query("customerFinanceCompanyPayments")
    .withIndex("by_org_application", (q) => q.eq("orgId", orgId).eq("applicationId", applicationId))
    .take(MAX_CUSTOMER_FINANCE_COMPANY_PAYMENT_ROWS + 1);
}

/**
 * Whether a payment was confirmed against the agreement the deal holds NOW. A
 * deal with no agreement has no current rows: whatever is on file was confirmed
 * against one that has since been withdrawn.
 */
export function isCurrentAgreementPayment(
  row: Pick<Doc<"customerFinanceCompanyPayments">, "agreementResolvedAt">,
  app: Pick<Doc<"financeApplications">, "gapResolvedAt">
): boolean {
  return app.gapResolvedAt !== undefined && row.agreementResolvedAt === app.gapResolvedAt;
}

export interface CustomerPaymentEvidence {
  /** Confirmed against the current agreement: the only part that credits the contribution. */
  currentConfirmedMinor: number;
  /** Confirmed against an agreement that has since been withdrawn: on file, credits nothing, blocks closing. */
  priorConfirmedMinor: number;
}

/**
 * The confirmed totals, in the deal's currency, split by agreement. A row that
 * cannot be read as an amount in that currency fails the recompute rather than
 * being skipped: a skipped row would silently under-credit, a guessed one
 * over-credit.
 */
export function customerPaymentEvidenceOf(
  rows: ReadonlyArray<Doc<"customerFinanceCompanyPayments">>,
  app: Pick<Doc<"financeApplications">, "gapResolvedAt">,
  currency: string
): CustomerPaymentEvidence {
  let currentConfirmedMinor = 0;
  let priorConfirmedMinor = 0;
  for (const row of rows) {
    if (row.status !== "CONFIRMED" || row.firstPayment !== undefined) continue;
    if (!isMinorAmount(row.amountMinor) || row.currency !== currency) {
      throw new ConvexError(
        "A recorded payment from the customer to the finance company on this deal cannot be read in the deal's currency, so its economics cannot be recomputed. An accountant reviews the payment record."
      );
    }
    if (isCurrentAgreementPayment(row, app)) currentConfirmedMinor += row.amountMinor;
    else priorConfirmedMinor += row.amountMinor;
  }
  if (!isMinorAmount(currentConfirmedMinor) || !isMinorAmount(priorConfirmedMinor)) {
    throw new ConvexError(
      "The customer's recorded payments to the finance company on this deal add up to an unreadable amount, so its economics cannot be recomputed. An accountant reviews the payment record."
    );
  }
  return { currentConfirmedMinor, priorConfirmedMinor };
}

/**
 * A transfer reference compared as the bank prints it, not as it was typed:
 * surrounding and repeated spaces and letter case do not make a second transfer.
 */
export function normalizedPaymentReference(reference: string): string {
  return reference.trim().replace(/\s+/g, " ").toUpperCase();
}

const MAX_LEGACY_REFERENCES = 256;

export function financeCompanyReceiptIssuer(app: Doc<"financeApplications">): string | null {
  if (app.companyId) return `company:${app.companyId}`;
  const payer = manualPayerOf(app);
  return payer ? `manual:${normalizedPaymentReference(payer.name)}` : null;
}

export function financeCompanyReceiptIdentity(app: Doc<"financeApplications">, reference: string): string {
  return JSON.stringify([financeCompanyReceiptIssuer(app), normalizedPaymentReference(reference)]);
}

export function validatedReference(args: { amountMinor: number; paidAt: number; reference: string }): string {
  if (!isMinorAmount(args.amountMinor) || args.amountMinor === 0) {
    throw new ConvexError("The amount must be a positive whole number of minor units. Nothing has been recorded.");
  }
  if (!Number.isSafeInteger(args.paidAt) || args.paidAt < 0 || args.paidAt > Date.now()) {
    throw new ConvexError("The payment date must be a real date that is not in the future. Nothing has been recorded.");
  }
  const reference = args.reference.trim();
  if (!reference) {
    throw new ConvexError("The payment's reference is required: it is the evidence that the customer paid. Nothing has been recorded.");
  }
  if (reference.length > MAX_DIRECT_PAYMENT_REFERENCE_CHARS) {
    throw new ConvexError(`The payment reference is too long (the most is ${MAX_DIRECT_PAYMENT_REFERENCE_CHARS} characters). Shorten it and try again. Nothing has been recorded.`);
  }
  return reference;
}

export async function reserveReceiptIdentity(ctx: MutationCtx, app: Doc<"financeApplications">, reference: string): Promise<string> {
  const identity = financeCompanyReceiptIdentity(app, reference);
  const duplicate = "A payment with that reference is already recorded as confirmed. If the earlier record is wrong, take it back with a reason first. Nothing has been recorded.";
  const bySource = (source: string | undefined) =>
    ctx.db.query("customerFinanceCompanyPayments").withIndex("by_org_sourceIdentity_status", (q) =>
      q.eq("orgId", app.orgId).eq("sourceIdentity", source).eq("status", "CONFIRMED")
    );
  const confirmed = await bySource(identity).first();
  if (confirmed) throw new ConvexError(duplicate);

  // Existing appraisal-gap records predate the normalized source index.
  const legacy = await bySource(undefined).take(MAX_LEGACY_REFERENCES + 1);
  if (legacy.length > MAX_LEGACY_REFERENCES) {
    throw new ConvexError("The finance team must review the existing payment references before confirming another.");
  }
  for (const row of legacy) {
    if (normalizedPaymentReference(row.reference) !== normalizedPaymentReference(reference)) continue;
    const previousDeal = await ctx.db.get(row.applicationId);
    if (!previousDeal || previousDeal.orgId !== app.orgId || financeCompanyReceiptIdentity(previousDeal, row.reference) === identity) {
      throw new ConvexError(duplicate);
    }
  }
  return identity;
}
