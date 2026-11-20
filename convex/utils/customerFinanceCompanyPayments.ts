import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { isMinorAmount } from "./financingEconomics";
import { MAX_DIRECT_PAYMENT_REFERENCE_CHARS } from "./feeDocLimits";
import { manualPayerOf } from "./manualFinancePayer";
import { PERMISSIONS, type Permission } from "./permissions";

export const CUSTOMER_FINANCE_APPLICATION_NOT_FOUND = "Finance application not found in this organization.";
export const CUSTOMER_FINANCE_PAYMENT_PERMISSIONS: Permission[] = [
  PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
  PERMISSIONS.VIEW_FINANCE,
];
export const MAX_CUSTOMER_FINANCE_PAYMENT_REASON_CHARS = 500;
export const firstPaymentKind = v.union(v.literal("RECEIPT"), v.literal("CONFIRMATION"));

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

const MAX_MATCHING_REFERENCES = 256;
const MAX_CONFIGURED_ISSUERS = 256;

export function receiptIssuerAliasesAfterRename(
  company: Pick<Doc<"financeCompanies">, "name" | "receiptIssuerAliases">,
  name: string,
): string[] | undefined {
  const previousName = normalizedPaymentReference(company.name);
  if (previousName === normalizedPaymentReference(name)) return company.receiptIssuerAliases;
  return [...new Set([...(company.receiptIssuerAliases ?? []), previousName])];
}

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

type Company = Doc<"financeCompanies">;

function companyIssuerNames(company: Company): string[] {
  return [normalizedPaymentReference(company.name), ...(company.receiptIssuerAliases ?? [])];
}

async function issuerNames(
  ctx: MutationCtx, orgId: Id<"organizations">, issuer: string | null,
  readCompanies: () => Promise<Company[]>,
): Promise<string[] | null> {
  if (issuer?.startsWith("manual:")) {
    const name = issuer.slice("manual:".length);
    const companies = await readCompanies();
    if (companies.length > MAX_CONFIGURED_ISSUERS) return null;
    const known = companies.map(companyIssuerNames).filter((names) => names.includes(name));
    if (known.length > 1) return null;
    return known[0] ?? [name];
  }
  if (!issuer?.startsWith("company:")) return null;
  const companyId = ctx.db.normalizeId("financeCompanies", issuer.slice("company:".length));
  const company = companyId && await ctx.db.get(companyId);
  if (!company || company.orgId !== orgId) return null;
  return companyIssuerNames(company);
}

type ReceiptRecord = Doc<"customerFinanceCompanyPayments">;

async function issuerOfRecordedReceipt(ctx: MutationCtx, row: ReceiptRecord): Promise<string | null> {
  if (row.sourceIdentity !== undefined) {
    try {
      const identity: unknown = JSON.parse(row.sourceIdentity);
      if (Array.isArray(identity) && identity.length === 2 && typeof identity[0] === "string" && identity[1] === row.normalizedReference) {
        return identity[0];
      }
    } catch {
      return null;
    }
    return null;
  }
  const deal = await ctx.db.get(row.applicationId);
  return deal?.orgId === row.orgId ? financeCompanyReceiptIssuer(deal) : null;
}

type ReceiptUse =
  | { kind: "FIRST_PAYMENT" }
  | { kind: "APPRAISAL_GAP"; existing: readonly ReceiptRecord[] };

export async function hasUnindexedConfirmedReceipts(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">): Promise<boolean> {
  const pending = await ctx.db.query("customerFinanceCompanyPayments")
    .withIndex("by_org_normalized_reference_status", (q) =>
      q.eq("orgId", orgId).eq("normalizedReference", undefined).eq("status", "CONFIRMED"))
    .first();
  return pending !== null;
}

export async function reserveReceiptIdentity(
  ctx: MutationCtx,
  app: Doc<"financeApplications">,
  reference: string,
  use: ReceiptUse,
): Promise<{ normalizedReference: string; sourceIdentity: string }> {
  const normalizedReference = normalizedPaymentReference(reference);
  const issuer = financeCompanyReceiptIssuer(app);
  const duplicate = "A payment with that reference is already recorded as confirmed. If the earlier record is wrong, take it back with a reason first. Nothing has been recorded.";
  const byReference = (normalized: string | undefined) =>
    ctx.db.query("customerFinanceCompanyPayments").withIndex("by_org_normalized_reference_status", (q) =>
      q.eq("orgId", app.orgId).eq("normalizedReference", normalized).eq("status", "CONFIRMED")
    );
  // The protected rollout indexes historical receipts before promoting the new UI.
  // Keep the existing appraisal-gap duplicate check on the same deal during that walk.
  if (use.kind === "FIRST_PAYMENT" && await hasUnindexedConfirmedReceipts(ctx, app.orgId)) {
    throw new ConvexError("First-payment confirmation is unavailable while existing payment references are being indexed. Try again after the release completes.");
  }
  if (use.kind === "APPRAISAL_GAP" && use.existing.some((row) =>
    row.status === "CONFIRMED" && normalizedPaymentReference(row.reference) === normalizedReference
  )) throw new ConvexError(duplicate);

  const matching = await byReference(normalizedReference).take(MAX_MATCHING_REFERENCES + 1);
  if (matching.length > MAX_MATCHING_REFERENCES) {
    throw new ConvexError("The finance team must review the records with that payment reference before it can be confirmed.");
  }
  let companies: Promise<Company[]> | undefined;
  const readCompanies = () => companies ??= ctx.db.query("financeCompanies")
    .withIndex("by_org", (q) => q.eq("orgId", app.orgId)).take(MAX_CONFIGURED_ISSUERS + 1);
  const names = matching.length > 0 ? await issuerNames(ctx, app.orgId, issuer, readCompanies) : null;
  for (const row of matching) {
    const priorIssuer = await issuerOfRecordedReceipt(ctx, row);
    if (row.applicationId === app._id || !names || priorIssuer === issuer) throw new ConvexError(duplicate);
    const priorNames = await issuerNames(ctx, app.orgId, priorIssuer, readCompanies);
    if (!priorNames || priorNames.some((name) => names.includes(name))) {
      throw new ConvexError(duplicate);
    }
  }
  return { normalizedReference, sourceIdentity: JSON.stringify([issuer, normalizedReference]) };
}
