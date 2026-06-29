/**
 * workflowHooks.ts
 *
 * Convenience wrappers called from domain mutations to emit accounting events
 * through the central posting engine. Each hook is fire-and-store — it posts
 * a double-entry journal if (and only if) a covering open period exists for the
 * accounting date. If no period exists the operational workflow still succeeds
 * so existing orgs without periods set up are not broken. Once periods exist
 * every event posts atomically.
 */
import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { postAccountingEvent } from "./postingEngine";
import { reverseAccountingEvent } from "./reversals";
import { getOpenPeriodForDate } from "../accountingPeriods";
import { isChartInitialized } from "../chartOfAccounts";
import { toMinorUnits } from "../utils/money";

export async function getOrgCurrency(ctx: MutationCtx, orgId: Id<"organizations">): Promise<string> {
  const settings = await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", orgId))
    .unique();
  return settings?.currency ?? "JOD";
}

async function shouldPost(ctx: MutationCtx, orgId: Id<"organizations">, date: number): Promise<boolean> {
  const [chartReady, period] = await Promise.all([
    isChartInitialized(ctx, orgId),
    getOpenPeriodForDate(ctx, orgId, date),
  ]);
  return chartReady && period !== null;
}

export async function hookDepositReceived(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    depositId: Id<"deposits">;
    customerId: Id<"customers">;
    amountMinor: number;
    currency: string;
    paymentMethod: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (!(await shouldPost(ctx, args.orgId, args.occurredAt))) return;
  await postAccountingEvent(ctx, {
    orgId: args.orgId,
    eventType: "DEPOSIT_RECEIVED",
    sourceType: "deposits",
    sourceId: args.depositId.toString(),
    eventVersion: 1,
    accountingDate: args.occurredAt,
    occurredAt: args.occurredAt,
    currency: args.currency,
    idempotencyKey: `deposit_received_${args.depositId}`,
    payload: {
      depositId: args.depositId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
      customerId: args.customerId.toString(),
    },
    actorId: args.actorId,
  });
}

export async function hookDepositApplied(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    depositId: Id<"deposits">;
    customerId: Id<"customers">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
    saleId?: Id<"sales">;
  }
) {
  if (!(await shouldPost(ctx, args.orgId, args.occurredAt))) return;
  await postAccountingEvent(ctx, {
    orgId: args.orgId,
    eventType: "DEPOSIT_APPLIED",
    sourceType: "deposits",
    sourceId: args.depositId.toString(),
    eventVersion: 1,
    accountingDate: args.occurredAt,
    occurredAt: args.occurredAt,
    currency: args.currency,
    idempotencyKey: `deposit_applied_${args.depositId}`,
    payload: {
      depositId: args.depositId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
      saleId: args.saleId?.toString(),
    },
    actorId: args.actorId,
  });
}

export async function hookDepositRefunded(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    depositId: Id<"deposits">;
    customerId: Id<"customers">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (!(await shouldPost(ctx, args.orgId, args.occurredAt))) return;
  await postAccountingEvent(ctx, {
    orgId: args.orgId,
    eventType: "DEPOSIT_REFUNDED",
    sourceType: "deposits",
    sourceId: args.depositId.toString(),
    eventVersion: 1,
    accountingDate: args.occurredAt,
    occurredAt: args.occurredAt,
    currency: args.currency,
    idempotencyKey: `deposit_refunded_${args.depositId}`,
    payload: {
      depositId: args.depositId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
    },
    actorId: args.actorId,
  });
}

export async function hookSaleCompleted(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    customerId: Id<"customers">;
    vehicleId: Id<"vehicles">;
    salespersonId: Id<"users">;
    saleAmountMinor: number;
    costMinor: number | undefined;
    currency: string;
    taxMinor: number | undefined;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (!(await shouldPost(ctx, args.orgId, args.occurredAt))) return;
  await postAccountingEvent(ctx, {
    orgId: args.orgId,
    eventType: "SALE_COMPLETED",
    sourceType: "sales",
    sourceId: args.saleId.toString(),
    eventVersion: 1,
    accountingDate: args.occurredAt,
    occurredAt: args.occurredAt,
    currency: args.currency,
    idempotencyKey: `sale_completed_${args.saleId}`,
    payload: {
      saleId: args.saleId.toString(),
      saleAmountMinor: args.saleAmountMinor,
      costMinor: args.costMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
      vehicleId: args.vehicleId.toString(),
      salespersonId: args.salespersonId.toString(),
      taxMinor: args.taxMinor,
    },
    actorId: args.actorId,
  });
}

export async function hookCollectionPayment(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    paymentId: Id<"collectionPayments">;
    customerId: Id<"customers">;
    amountMinor: number;
    currency: string;
    paymentMethod: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (!(await shouldPost(ctx, args.orgId, args.occurredAt))) return;
  await postAccountingEvent(ctx, {
    orgId: args.orgId,
    eventType: "COLLECTION_PAYMENT",
    sourceType: "collectionPayments",
    sourceId: args.paymentId.toString(),
    eventVersion: 1,
    accountingDate: args.occurredAt,
    occurredAt: args.occurredAt,
    currency: args.currency,
    idempotencyKey: `collection_payment_${args.paymentId}`,
    payload: {
      paymentId: args.paymentId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
      paymentMethod: args.paymentMethod,
    },
    actorId: args.actorId,
  });
}

export async function hookExpensePosted(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    expenseId: Id<"expenses">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (!(await shouldPost(ctx, args.orgId, args.occurredAt))) return;
  await postAccountingEvent(ctx, {
    orgId: args.orgId,
    eventType: "EXPENSE_POSTED",
    sourceType: "expenses",
    sourceId: args.expenseId.toString(),
    eventVersion: 1,
    accountingDate: args.occurredAt,
    occurredAt: args.occurredAt,
    currency: args.currency,
    idempotencyKey: `expense_posted_${args.expenseId}`,
    payload: {
      expenseId: args.expenseId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
    },
    actorId: args.actorId,
  });
}

export async function hookCommissionAccrued(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    salespersonId: Id<"users">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (!(await shouldPost(ctx, args.orgId, args.occurredAt))) return;
  await postAccountingEvent(ctx, {
    orgId: args.orgId,
    eventType: "COMMISSION_ACCRUED",
    sourceType: "sales",
    sourceId: `commission_${args.saleId}`,
    eventVersion: 1,
    accountingDate: args.occurredAt,
    occurredAt: args.occurredAt,
    currency: args.currency,
    idempotencyKey: `commission_accrued_${args.saleId}`,
    payload: {
      saleId: args.saleId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      salespersonId: args.salespersonId.toString(),
    },
    actorId: args.actorId,
  });
}

export async function hookSaleCancelled(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
) {
  // Find the original SALE_COMPLETED event for this sale
  const originalEvent = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", args.orgId).eq("sourceType", "sales").eq("sourceId", args.saleId.toString())
    )
    .filter((q) => q.eq(q.field("eventType"), "SALE_COMPLETED"))
    .filter((q) => q.eq(q.field("status"), "POSTED"))
    .first();

  if (!originalEvent) return; // No GL entry to reverse — sale never posted

  const period = await getOpenPeriodForDate(ctx, args.orgId, args.reversalDate);
  if (!period) return; // No open period; skip silently

  await reverseAccountingEvent(ctx, {
    orgId: args.orgId,
    originalEventId: originalEvent._id,
    reversalDate: args.reversalDate,
    reason: args.reason,
    actorId: args.actorId,
    idempotencyKey: `sale_cancelled_${args.saleId}`,
  });
}

export async function hookFinanceDisbursed(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    saleId: Id<"sales">;
    financeCompanyId: Id<"financeCompanies">;
    customerId: Id<"customers">;
    loanAmountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (!(await shouldPost(ctx, args.orgId, args.occurredAt))) return;
  await postAccountingEvent(ctx, {
    orgId: args.orgId,
    eventType: "FINANCE_DISBURSED",
    sourceType: "financeApplications",
    sourceId: args.applicationId.toString(),
    eventVersion: 1,
    accountingDate: args.occurredAt,
    occurredAt: args.occurredAt,
    currency: args.currency,
    idempotencyKey: `finance_disbursed_${args.applicationId}`,
    payload: {
      applicationId: args.applicationId.toString(),
      saleId: args.saleId.toString(),
      financeCompanyId: args.financeCompanyId.toString(),
      amountMinor: args.loanAmountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
    },
    actorId: args.actorId,
  });
}

export async function hookPaymentLinkReceived(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    intentId: Id<"paymentIntents">;
    customerId: Id<"customers">;
    amountMinor: number;
    currency: string;
    provider: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (!(await shouldPost(ctx, args.orgId, args.occurredAt))) return;
  await postAccountingEvent(ctx, {
    orgId: args.orgId,
    eventType: "PAYMENT_LINK_RECEIVED",
    sourceType: "paymentIntents",
    sourceId: args.intentId.toString(),
    eventVersion: 1,
    accountingDate: args.occurredAt,
    occurredAt: args.occurredAt,
    currency: args.currency,
    idempotencyKey: `payment_link_received_${args.intentId}`,
    payload: {
      intentId: args.intentId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
      provider: args.provider,
    },
    actorId: args.actorId,
  });
}

export async function hookCommissionPaid(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    salespersonId: Id<"users">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (!(await shouldPost(ctx, args.orgId, args.occurredAt))) return;
  await postAccountingEvent(ctx, {
    orgId: args.orgId,
    eventType: "COMMISSION_PAID",
    sourceType: "sales",
    sourceId: `commission_paid_${args.saleId}`,
    eventVersion: 1,
    accountingDate: args.occurredAt,
    occurredAt: args.occurredAt,
    currency: args.currency,
    idempotencyKey: `commission_paid_${args.saleId}`,
    payload: {
      saleId: args.saleId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      salespersonId: args.salespersonId.toString(),
    },
    actorId: args.actorId,
  });
}
