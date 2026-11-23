import { ensureReceivableDocument } from "../../utils/receivableDocumentWriter";
import { ConvexError } from "convex/values";
import { type MutationCtx, type QueryCtx } from "../../_generated/server";
import { type Doc, type Id } from "../../_generated/dataModel";
import { toMinorUnits, assertSupportedDenomination } from "../../utils/money";
import { manualPayerOf } from "../../utils/manualFinancePayer";
/** Source type for the canonical receivable owed by the finance company. */
export const FINANCE_APP_RECEIVABLE_SOURCE = "finance_application";

/**
 * Opens (or finds) the canonical receivable owed BY the finance company for a
 * finalized deal. Idempotent per application via the by_org_source index.
 */
export async function ensureFinanceCompanyReceivable(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    /** Exactly one of this / `payerNameSnapshot` (SCRUM-27). */
    financeCompanyId?: Id<"financeCompanies">;
    payerNameSnapshot?: string;
    customerId: Id<"customers">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    now: number;
  },
) {
  if (
    (args.financeCompanyId === undefined) ===
    (args.payerNameSnapshot === undefined)
  ) {
    throw new ConvexError(
      "A finance-company receivable needs exactly one payer identity.",
    );
  }
  return await ensureReceivableDocument(ctx, {
    orgId: args.orgId,
    documentType: "INVOICE",
    payerType: args.financeCompanyId
      ? "FINANCE_COMPANY"
      : "MANUAL_FINANCE_COMPANY",
    financeCompanyId: args.financeCompanyId,
    payerNameSnapshot: args.payerNameSnapshot,
    customerId: args.customerId,
    sourceType: FINANCE_APP_RECEIVABLE_SOURCE,
    sourceId: args.applicationId,
    originalAmountMinor: args.amountMinor,
    currency: args.currency,
    issueDate: args.now,
    dueDate: args.now,
    actorId: args.actorId,
  });
}

/**
 * The canonical receivable a finalized financed deal opened for the company's
 * remittance, by its source index. Shared by the receipt authority proof and the
 * receipt-bank picker so both read the same record the same way.
 */
export async function findFinanceReceivable(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
): Promise<Doc<"receivableDocuments"> | null> {
  return await ctx.db
    .query("receivableDocuments")
    .withIndex("by_org_source", (q) =>
      q
        .eq("orgId", app.orgId)
        .eq("sourceType", FINANCE_APP_RECEIVABLE_SOURCE)
        .eq("sourceId", app._id),
    )
    .unique();
}

/**
 * The ONE figure a finance-company receipt may settle, proven from the deal's
 * own records before anything is written (SCRUM-241).
 *
 * Three records describe what the company owes on a finalized deal: the frozen
 * recognition figure on the application, the canonical receivable the
 * finalization opened, and what the caller says arrived. They are read together
 * and must agree — with each other, on the counterparty, and on the fact that
 * nothing of the debt has been settled yet — or the receipt is refused with no
 * cheque, payment, allocation or posting written. Contradiction is never
 * reconciled by taking the smaller number.
 *
 * The denomination comes from the receivable itself. A debt recorded in JOD is
 * settled in JOD; the organisation's current default currency was consulted
 * when the debt was recorded and is not consulted again, so a later change to
 * that setting neither relabels the integer nor decides which currency this
 * money is in. This is same-currency settlement of an existing obligation, not
 * currency conversion.
 */
export async function proveFinanceReceiptAuthority(
  ctx: MutationCtx,
  args: {
    app: Doc<"financeApplications">;
    quote: Doc<"quotes"> | null;
    callerAmountMinor: number;
  },
): Promise<{
  receivable: Doc<"receivableDocuments">;
  receiptMinor: number;
  currency: string;
}> {
  const { app, quote } = args;
  const receivable = await findFinanceReceivable(ctx, app);
  if (!receivable) {
    throw new ConvexError(
      "No finance-company receivable is recorded for this deal, so there is nothing for this payment to settle. The deal must be finalized, with its receivable opened, before the company's payment can be received.",
    );
  }
  if (app.companyId === undefined && manualPayerOf(app) !== null) {
    // SCRUM-27 (D7): a manual company has no id to compare. Its identity is the
    // receivable's own source (matched by the index above) AND the name frozen
    // on the application at finalize, both server-derived before any write.
    if (
      receivable.payerType !== "MANUAL_FINANCE_COMPANY" ||
      receivable.financeCompanyId !== undefined ||
      receivable.payerNameSnapshot !== manualPayerOf(app)?.name
    ) {
      throw new ConvexError(
        "The receivable recorded for this deal is not owed by this deal's financing company, so this payment cannot settle it.",
      );
    }
  } else if (
    receivable.payerType !== "FINANCE_COMPANY" ||
    receivable.financeCompanyId !== app.companyId
  ) {
    throw new ConvexError(
      "The receivable recorded for this deal is not owed by this deal's financing company, so this payment cannot settle it.",
    );
  }
  assertSupportedDenomination(
    receivable.currency,
    "receiving this disbursement",
  );

  // What the company actually owed when the sale was recognised, frozen at
  // finalization. The customer's financing principal is what THEY borrow; it
  // is not what the company transfers, and the two differ by every deposit the
  // dealership holds and every cost the company withholds. Deals finalized
  // before the plan existed carry only the quote's financed amount, in the
  // currency their receivable was opened in.
  let recognisedMinor: number;
  if (app.financedSaleNetReceivableMinor !== undefined) {
    recognisedMinor = app.financedSaleNetReceivableMinor;
  } else if (quote?.totalFinancedAmount !== undefined) {
    recognisedMinor = toMinorUnits(
      quote.totalFinancedAmount,
      receivable.currency,
    );
  } else {
    throw new ConvexError(
      "This deal carries no recorded figure for what the financing company owes the dealership, so a payment from the company cannot be checked against it and is not received.",
    );
  }
  if (args.callerAmountMinor !== recognisedMinor) {
    throw new ConvexError(
      `The amount received (${args.callerAmountMinor}) is not what this financing company owes the dealership on this deal (${recognisedMinor}).`,
    );
  }
  if (receivable.originalAmountMinor !== recognisedMinor) {
    throw new ConvexError(
      `The receivable recorded for this deal (${receivable.originalAmountMinor}) does not match what the sale recognised as owed by the financing company (${recognisedMinor}). The deal's records disagree with each other and must be corrected before the company's payment is received.`,
    );
  }
  if (receivable.status !== "OPEN") {
    throw new ConvexError(
      `The finance-company receivable for this deal is ${receivable.status}, not open, so this payment cannot settle it.`,
    );
  }
  // This mutation records the single full receipt that settles the deal. A
  // receivable already carrying an allocation is not that deal any more, and
  // applying "whatever is left" to it would be the min() reconciliation this
  // guard exists to refuse.
  const activeAllocations = await getActiveReceivableAllocations(
    ctx,
    receivable._id,
  );
  if (activeAllocations.length > 0) {
    throw new ConvexError(
      "Part of this deal's finance-company receivable has already been settled, so it cannot be received as a single full payment. Review the existing allocation before recording this receipt.",
    );
  }
  return {
    receivable,
    receiptMinor: recognisedMinor,
    currency: receivable.currency,
  };
}

export function receivableStatusForBalance(
  originalAmountMinor: number,
  allocatedMinor: number,
): Doc<"receivableDocuments">["status"] {
  if (originalAmountMinor <= 0 || allocatedMinor >= originalAmountMinor)
    return "PAID";
  return allocatedMinor > 0 ? "PARTIALLY_PAID" : "OPEN";
}

export async function getActiveReceivableAllocations(
  ctx: MutationCtx,
  receivableDocumentId: Id<"receivableDocuments">,
) {
  const allocations = await ctx.db
    .query("paymentAllocations")
    .withIndex("by_receivable", (q) =>
      q.eq("receivableDocumentId", receivableDocumentId),
    )
    .collect();
  return allocations.filter((allocation) => allocation.status === "ACTIVE");
}

export async function transferFinancedAmountFromCustomerReceivable(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    saleAmountMinor: number;
    financedAmountMinor: number;
  },
) {
  const sale = await ctx.db.get(args.saleId);
  if (!sale || sale.orgId !== args.orgId)
    throw new ConvexError("Finalized sale not found.");
  if (!sale.canonicalReceivableDocumentId) {
    throw new ConvexError(
      "Finalized sale is missing its canonical customer receivable.",
    );
  }

  const customerReceivable = await ctx.db.get(
    sale.canonicalReceivableDocumentId,
  );
  if (!customerReceivable || customerReceivable.orgId !== args.orgId) {
    throw new ConvexError("Sale customer receivable not found.");
  }

  const customerPortionMinor = Math.max(
    0,
    args.saleAmountMinor - args.financedAmountMinor,
  );
  if (customerReceivable.originalAmountMinor === customerPortionMinor) return;

  const activeAllocations = await getActiveReceivableAllocations(
    ctx,
    customerReceivable._id,
  );
  const allocatedMinor = activeAllocations.reduce(
    (sum, allocation) => sum + allocation.amountMinor,
    0,
  );
  if (allocatedMinor > customerPortionMinor) {
    throw new ConvexError(
      "Customer receivable allocations exceed the non-financed customer balance. Reconcile the sale before finalizing financing.",
    );
  }

  await ctx.db.patch(customerReceivable._id, {
    originalAmountMinor: customerPortionMinor,
    status: receivableStatusForBalance(customerPortionMinor, allocatedMinor),
  });
}
