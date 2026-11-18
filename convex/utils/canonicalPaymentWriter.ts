import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { assertOrgEconomicallyActive } from "./orgLifecycle";
import { assertValidMinorAmount, scaleForCurrency } from "./money";

export async function createCanonicalPayment(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    direction: "IN" | "OUT";
    payerType?: "CUSTOMER" | "FINANCE_COMPANY" | "MANUAL_FINANCE_COMPANY";
    customerId?: Id<"customers">;
    financeCompanyId?: Id<"financeCompanies">;
    payerNameSnapshot?: string;
    method: "CASH" | "BANK_TRANSFER" | "CARD" | "PAYMENT_LINK" | "CHEQUE" | "INTERNAL_TRANSFER" | "TRADE_IN" | "OTHER";
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
    actorId: Id<"users">;
    status?: "DRAFT" | "PENDING_VERIFICATION" | "VERIFIED" | "PENDING_SETTLEMENT" | "SETTLED";
    externalReference?: string;
    provider?: string;
    providerTransactionId?: string;
    receivedAt?: number;
    branchId?: Id<"branches">;
    cashierSessionId?: Id<"cashierReconciliations">;
    accountingEventId?: Id<"accountingEvents">;
  }
): Promise<Id<"canonicalPayments">> {
  await assertOrgEconomicallyActive(ctx, args.orgId);
  assertValidMinorAmount(args.amountMinor, "amountMinor");
  const currency = args.currency.toUpperCase();
  const scale = scaleForCurrency(currency);
  const now = Date.now();

  // Idempotency check
  const existing = await ctx.db
    .query("canonicalPayments")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", args.orgId).eq("idempotencyKey", args.idempotencyKey)
    )
    .unique();
  if (existing) return existing._id;

  return ctx.db.insert("canonicalPayments", {
    orgId: args.orgId,
    branchId: args.branchId,
    direction: args.direction,
    payerType: args.payerType,
    customerId: args.customerId,
    financeCompanyId: args.financeCompanyId,
    payerNameSnapshot: args.payerNameSnapshot,
    method: args.method,
    amountMinor: args.amountMinor,
    currency,
    scale,
    status: args.status ?? "SETTLED",
    idempotencyKey: args.idempotencyKey,
    externalReference: args.externalReference,
    provider: args.provider,
    providerTransactionId: args.providerTransactionId,
    receivedAt: args.receivedAt ?? now,
    cashierSessionId: args.cashierSessionId,
    accountingEventId: args.accountingEventId,
    createdBy: args.actorId,
    createdAt: now,
  });
}
