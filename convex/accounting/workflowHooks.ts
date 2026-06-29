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
