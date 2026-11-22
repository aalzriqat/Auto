import { ConvexError } from "convex/values";
import type { MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { assertOrgEconomicallyActive } from "./orgLifecycle";
import { assertValidMinorAmount, scaleForCurrency } from "./money";

/**
 * ⚠️ SCRUM-302 — the organization-lifecycle refusal lives on the writers in
 * this file rather than at their callers, so an internal caller that has never
 * heard of suspension — the payment webhook is the reproduced one — inherits it
 * without knowing about it.
 *
 * Each of these writers calls `assertOrgEconomicallyActive` before inserting.
 *
 * These throw. Anything reached from a cross-org cron batch must classify the
 * refusal with `orgEconomicLifecycleBlock` BEFORE calling in, since an uncaught
 * throw inside such a batch is a cross-tenant outage, not a single-tenant one.
 */
export async function createReceivableDocument(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    documentType:
      | "INVOICE"
      | "INSTALLMENT"
      | "DEBIT_ADJUSTMENT"
      | "CREDIT_ADJUSTMENT"
      | "WRITE_OFF"
      | "REFUND_PAYABLE";
    payerType: "CUSTOMER" | "FINANCE_COMPANY" | "MANUAL_FINANCE_COMPANY";
    customerId?: Id<"customers">;
    financeCompanyId?: Id<"financeCompanies">;
    /** SCRUM-27: the manual finance company's name off its approval letter (MANUAL_FINANCE_COMPANY only). */
    payerNameSnapshot?: string;
    sourceType: string;
    sourceId: string;
    originalAmountMinor: number;
    currency: string;
    issueDate: number;
    dueDate: number;
    /** A domain-generated number, e.g. the unique once-per-org opening row. */
    documentNumber?: string;
    actorId: Id<"users">;
    accountingEventId?: Id<"accountingEvents">;
    branchId?: Id<"branches">;
  },
): Promise<Id<"receivableDocuments">> {
  await assertOrgEconomicallyActive(ctx, args.orgId);
  assertValidMinorAmount(args.originalAmountMinor, "originalAmountMinor");
  const currency = args.currency.toUpperCase();
  const scale = scaleForCurrency(currency);
  const now = Date.now();
  if (
    args.documentNumber !== undefined &&
    (!args.documentNumber.trim() || args.documentNumber.length > 160)
  ) {
    throw new ConvexError("The receivable reference is invalid.");
  }

  // Generate document number
  const docNumber =
    args.documentNumber ??
    `REC-${new Date(now).getFullYear()}-${String(Date.now()).slice(-6)}`;

  return ctx.db.insert("receivableDocuments", {
    orgId: args.orgId,
    branchId: args.branchId,
    documentType: args.documentType,
    documentNumber: docNumber,
    payerType: args.payerType,
    customerId: args.customerId,
    financeCompanyId: args.financeCompanyId,
    payerNameSnapshot: args.payerNameSnapshot,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    originalAmountMinor: args.originalAmountMinor,
    currency,
    scale,
    issueDate: args.issueDate,
    dueDate: args.dueDate,
    status: "OPEN",
    accountingEventId: args.accountingEventId,
    createdAt: now,
    createdBy: args.actorId,
  });
}

export async function ensureReceivableDocument(
  ctx: MutationCtx,
  args: Parameters<typeof createReceivableDocument>[1],
): Promise<Id<"receivableDocuments">> {
  const existing = await ctx.db
    .query("receivableDocuments")
    .withIndex("by_org_source", (q) =>
      q
        .eq("orgId", args.orgId)
        .eq("sourceType", args.sourceType)
        .eq("sourceId", args.sourceId),
    )
    .unique();
  if (existing) return existing._id;
  return await createReceivableDocument(ctx, args);
}
