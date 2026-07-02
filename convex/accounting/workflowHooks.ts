/**
 * workflowHooks.ts
 *
 * Convenience wrappers called from domain mutations to emit accounting events
 * through the central posting engine. Each hook posts a balanced double-entry
 * journal when a chart of accounts and a covering open period exist. When they
 * do NOT, the event is durably enqueued in the accounting outbox instead of
 * being silently dropped — so no sale/payment/expense/disbursement is ever made
 * operationally final without a captured, retryable GL record. The queue is
 * re-driven idempotently when a chart is initialized or a period is opened.
 */
import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { postAccountingEvent, PostCommand } from "./postingEngine";
import { EventType } from "./postingRules";
import { reverseAccountingEvent } from "./reversals";
import { getOpenPeriodForDate } from "../accountingPeriods";
import { isChartInitialized, ensureGeneralExpenseAccount, ensureSupplierAPAccount } from "../chartOfAccounts";
import {
  enqueuePendingPost,
  enqueuePendingReversal,
  cancelPendingPostByKey,
} from "../accountingOutbox";

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

/**
 * Posts the event now if the chart + an open period exist, otherwise enqueues it
 * to the durable outbox for retry. This is the single choke point that replaced
 * the previous "silently return if not postable" behavior.
 */
async function postOrEnqueue(ctx: MutationCtx, cmd: PostCommand): Promise<void> {
  // Self-heal: make sure the GENERAL_EXPENSE system account is mapped for this
  // org before the engine tries to resolve it (older charts lack the key).
  // Centralized here (not just in hookExpensePosted) because other posting
  // paths — e.g. cheque-return bank fees — can also resolve GENERAL_EXPENSE.
  if (await isChartInitialized(ctx, cmd.orgId)) {
    await ensureGeneralExpenseAccount(ctx, cmd.orgId, cmd.actorId);
    await ensureSupplierAPAccount(ctx, cmd.orgId, cmd.actorId);
  }
  if (await shouldPost(ctx, cmd.orgId, cmd.accountingDate)) {
    await postAccountingEvent(ctx, cmd);
  } else {
    await enqueuePendingPost(ctx, cmd, "No chart of accounts or open period at operation time");
  }
}

/**
 * Shared shape for every forward-posting domain hook: version-1 event dated at
 * the operational occurredAt, posted or durably enqueued. Individual hooks
 * only differ by event type, source, idempotency key, and payload.
 */
async function postDomainEvent(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    eventType: EventType;
    sourceType: string;
    sourceId: string;
    idempotencyKey: string;
    currency: string;
    occurredAt: number;
    actorId: Id<"users">;
    payload: Record<string, unknown>;
  }
): Promise<void> {
  await postOrEnqueue(ctx, {
    orgId: args.orgId,
    eventType: args.eventType,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    eventVersion: 1,
    accountingDate: args.occurredAt,
    occurredAt: args.occurredAt,
    currency: args.currency,
    idempotencyKey: args.idempotencyKey,
    payload: args.payload,
    actorId: args.actorId,
  });
}

/**
 * Generic "undo this posted event, or drop it if it never posted" used when
 * voiding an upstream operation (a cancelled sale, a voided finance deal, a
 * deposit recorded in error). Reverses the posted journal inside an open
 * period, defers the reversal to the outbox when no period is open, and
 * cancels a still-unposted outbox entry so the round trip nets to zero.
 */
async function reverseEventIfPosted(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    sourceType: string;
    sourceId: string;
    eventType: string;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
    reversalIdempotencyKey: string;
    pendingPostIdempotencyKey: string;
  }
): Promise<void> {
  const originalEvent = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", args.orgId).eq("sourceType", args.sourceType).eq("sourceId", args.sourceId)
    )
    .filter((q) => q.eq(q.field("eventType"), args.eventType))
    .filter((q) => q.eq(q.field("status"), "POSTED"))
    .first();

  if (originalEvent) {
    const period = await getOpenPeriodForDate(ctx, args.orgId, args.reversalDate);
    if (period) {
      await reverseAccountingEvent(ctx, {
        orgId: args.orgId,
        originalEventId: originalEvent._id,
        reversalDate: args.reversalDate,
        reason: args.reason,
        actorId: args.actorId,
        idempotencyKey: args.reversalIdempotencyKey,
      });
    } else {
      // No open period — defer the reversal to the outbox instead of skipping it.
      await enqueuePendingReversal(ctx, {
        orgId: args.orgId,
        originalEventId: originalEvent._id,
        reversalDate: args.reversalDate,
        reason: args.reason,
        actorId: args.actorId,
        idempotencyKey: args.reversalIdempotencyKey,
        sourceType: args.sourceType,
        sourceId: args.sourceId,
      });
    }
    return;
  }

  // No posted GL entry. If it's still sitting unposted in the outbox, cancel
  // it so it never posts (net GL effect of the round trip is zero).
  await cancelPendingPostByKey(ctx, args.orgId, args.pendingPostIdempotencyKey);
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
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "DEPOSIT_RECEIVED",
    sourceType: "deposits",
    sourceId: args.depositId.toString(),
    idempotencyKey: `deposit_received_${args.depositId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      depositId: args.depositId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
      customerId: args.customerId.toString(),
    },
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
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "DEPOSIT_APPLIED",
    sourceType: "deposits",
    sourceId: args.depositId.toString(),
    idempotencyKey: `deposit_applied_${args.depositId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      depositId: args.depositId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
      saleId: args.saleId?.toString(),
    },
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
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "DEPOSIT_REFUNDED",
    sourceType: "deposits",
    sourceId: args.depositId.toString(),
    idempotencyKey: `deposit_refunded_${args.depositId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      depositId: args.depositId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
    },
  });
}

export async function hookDepositForfeited(
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
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "DEPOSIT_FORFEITED",
    sourceType: "deposits",
    sourceId: args.depositId.toString(),
    idempotencyKey: `deposit_forfeited_${args.depositId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      depositId: args.depositId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
    },
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
    /** Pass true for drop-shipped vehicles — credits AP-Suppliers instead of Vehicle Inventory for COGS. */
    isSourced?: boolean;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "SALE_COMPLETED",
    sourceType: "sales",
    sourceId: args.saleId.toString(),
    idempotencyKey: `sale_completed_${args.saleId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      saleId: args.saleId.toString(),
      saleAmountMinor: args.saleAmountMinor,
      costMinor: args.costMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
      vehicleId: args.vehicleId.toString(),
      salespersonId: args.salespersonId.toString(),
      taxMinor: args.taxMinor,
      isSourced: args.isSourced ?? false,
    },
  });
}

export async function hookSupplierPaymentSettled(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    payableId: Id<"vehicleSupplierPayables">;
    sourcedFromName: string;
    amountMinor: number;
    currency: string;
    paymentMethod?: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "SUPPLIER_PAYMENT_SETTLED",
    sourceType: "vehicleSupplierPayables",
    sourceId: args.payableId.toString(),
    idempotencyKey: `supplier_payment_settled_${args.payableId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      payableId: args.payableId.toString(),
      sourcedFromName: args.sourcedFromName,
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
    },
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
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "COLLECTION_PAYMENT",
    sourceType: "collectionPayments",
    sourceId: args.paymentId.toString(),
    idempotencyKey: `collection_payment_${args.paymentId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      paymentId: args.paymentId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
      paymentMethod: args.paymentMethod,
    },
  });
}

/**
 * Posts the cash-out + AR-reopening entry for an approved collection refund:
 * DR Accounts Receivable — Customers / CR Cash. The refund's operational side
 * (OUT collectionPayment + canonical payment + allocation reversal) is handled
 * by the caller; this hook only records the GL impact.
 */
export async function hookCollectionRefund(
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
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "COLLECTION_REFUND",
    sourceType: "collectionPayments",
    sourceId: args.paymentId.toString(),
    idempotencyKey: `collection_refund_${args.paymentId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      paymentId: args.paymentId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
      paymentMethod: args.paymentMethod,
    },
  });
}

export async function hookExpensePosted(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    expenseId: Id<"expenses">;
    amountMinor: number;
    currency: string;
    category?: string;
    paymentMethod?: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "EXPENSE_POSTED",
    sourceType: "expenses",
    sourceId: args.expenseId.toString(),
    idempotencyKey: `expense_posted_${args.expenseId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      expenseId: args.expenseId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      category: args.category,
      paymentMethod: args.paymentMethod,
    },
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
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "COMMISSION_ACCRUED",
    sourceType: "sales",
    sourceId: `commission_${args.saleId}`,
    idempotencyKey: `commission_accrued_${args.saleId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      saleId: args.saleId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      salespersonId: args.salespersonId.toString(),
    },
  });
}

/** Reverses the SALE_COMPLETED entry (or cancels its pending post) when a sale is cancelled. */
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
  await reverseEventIfPosted(ctx, {
    orgId: args.orgId,
    sourceType: "sales",
    sourceId: args.saleId.toString(),
    eventType: "SALE_COMPLETED",
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
    reversalIdempotencyKey: `sale_cancelled_${args.saleId}`,
    pendingPostIdempotencyKey: `sale_completed_${args.saleId}`,
  });
}

/** Reverses the FINANCE_DISBURSED entry created at finalizeDeal, when voiding a closed application that was never actually disbursed. */
export async function hookFinanceDisbursementCancelled(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
) {
  await reverseEventIfPosted(ctx, {
    orgId: args.orgId,
    sourceType: "financeApplications",
    sourceId: args.applicationId.toString(),
    eventType: "FINANCE_DISBURSED",
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
    reversalIdempotencyKey: `finance_disbursement_cancelled_${args.applicationId}`,
    pendingPostIdempotencyKey: `finance_disbursed_${args.applicationId}`,
  });
}

/** Reverses a COMMISSION_ACCRUED entry when the underlying sale is voided. */
export async function hookCommissionReversed(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
) {
  await reverseEventIfPosted(ctx, {
    orgId: args.orgId,
    sourceType: "sales",
    sourceId: `commission_${args.saleId}`,
    eventType: "COMMISSION_ACCRUED",
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
    reversalIdempotencyKey: `commission_reversed_${args.saleId}`,
    pendingPostIdempotencyKey: `commission_accrued_${args.saleId}`,
  });
}

/** Reverses a DEPOSIT_APPLIED entry when an applied deposit is reinstated as an active hold (e.g. the sale it was applied to gets voided). */
export async function hookDepositApplicationReversed(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    depositId: Id<"deposits">;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
) {
  await reverseEventIfPosted(ctx, {
    orgId: args.orgId,
    sourceType: "deposits",
    sourceId: args.depositId.toString(),
    eventType: "DEPOSIT_APPLIED",
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
    reversalIdempotencyKey: `deposit_applied_reversed_${args.depositId}`,
    pendingPostIdempotencyKey: `deposit_applied_${args.depositId}`,
  });
}

/**
 * Reverses the DEPOSIT_RECEIVED entry when a HELD deposit is voided as
 * recorded-in-error (as opposed to refunded/forfeited, which post their own
 * dedicated resolution entries). If the original entry never posted (still in
 * the outbox), it is cancelled so the round trip nets to zero.
 */
export async function hookDepositVoided(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    depositId: Id<"deposits">;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
) {
  await reverseEventIfPosted(ctx, {
    orgId: args.orgId,
    sourceType: "deposits",
    sourceId: args.depositId.toString(),
    eventType: "DEPOSIT_RECEIVED",
    reason: args.reason,
    actorId: args.actorId,
    reversalDate: args.reversalDate,
    reversalIdempotencyKey: `deposit_voided_${args.depositId}`,
    pendingPostIdempotencyKey: `deposit_received_${args.depositId}`,
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
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "FINANCE_DISBURSED",
    sourceType: "financeApplications",
    sourceId: args.applicationId.toString(),
    idempotencyKey: `finance_disbursed_${args.applicationId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      applicationId: args.applicationId.toString(),
      saleId: args.saleId.toString(),
      financeCompanyId: args.financeCompanyId.toString(),
      amountMinor: args.loanAmountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
    },
  });
}

export async function hookFinanceCashReceived(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    financeCompanyId: Id<"financeCompanies">;
    customerId?: Id<"customers">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "FINANCE_CASH_RECEIVED",
    sourceType: "financeApplications",
    sourceId: `disbursement_${args.applicationId}`,
    idempotencyKey: `finance_cash_received_${args.applicationId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      applicationId: args.applicationId.toString(),
      financeCompanyId: args.financeCompanyId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId?.toString(),
    },
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
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "PAYMENT_LINK_RECEIVED",
    sourceType: "paymentIntents",
    sourceId: args.intentId.toString(),
    idempotencyKey: `payment_link_received_${args.intentId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      intentId: args.intentId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
      provider: args.provider,
    },
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
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "COMMISSION_PAID",
    sourceType: "sales",
    sourceId: `commission_paid_${args.saleId}`,
    idempotencyKey: `commission_paid_${args.saleId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      saleId: args.saleId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      salespersonId: args.salespersonId.toString(),
    },
  });
}
