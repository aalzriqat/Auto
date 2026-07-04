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
import { MutationCtx, QueryCtx } from "../_generated/server";
import { postAccountingEvent, PostCommand } from "./postingEngine";
import { EventType } from "./postingRules";
import { reverseAccountingEvent } from "./reversals";
import { getOpenPeriodForDate } from "../accountingPeriods";
import { isChartInitialized, ensureGeneralExpenseAccount, ensureSupplierAPAccount, ensureFixedAssetAccounts, ensurePartnerEquityAccounts, ensureClaimAccounts } from "../chartOfAccounts";
import {
  enqueuePendingPost,
  enqueuePendingReversal,
  cancelPendingPostByKey,
} from "../accountingOutbox";

export async function getOrgCurrency(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">): Promise<string> {
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
    eventType: EventType;
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

type DepositResolutionHookArgs = {
  orgId: Id<"organizations">;
  depositId: Id<"deposits">;
  customerId: Id<"customers">;
  amountMinor: number;
  currency: string;
  actorId: Id<"users">;
  occurredAt: number;
};

/** Refund and forfeiture post identical event shapes — only the event type (and thus the posting rule) differs. */
function makeDepositResolutionHook(eventType: "DEPOSIT_REFUNDED" | "DEPOSIT_FORFEITED", keyPrefix: string) {
  return async (ctx: MutationCtx, args: DepositResolutionHookArgs) =>
    postDomainEvent(ctx, {
      orgId: args.orgId,
      eventType,
      sourceType: "deposits",
      sourceId: args.depositId.toString(),
      idempotencyKey: `${keyPrefix}_${args.depositId}`,
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

export const hookDepositRefunded = makeDepositResolutionHook("DEPOSIT_REFUNDED", "deposit_refunded");
export const hookDepositForfeited = makeDepositResolutionHook("DEPOSIT_FORFEITED", "deposit_forfeited");

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

type CollectionHookArgs = {
  orgId: Id<"organizations">;
  paymentId: Id<"collectionPayments">;
  customerId: Id<"customers">;
  amountMinor: number;
  currency: string;
  paymentMethod: string;
  actorId: Id<"users">;
  occurredAt: number;
};

function makeCollectionHook(eventType: "COLLECTION_PAYMENT" | "COLLECTION_REFUND", keyPrefix: string) {
  return async (ctx: MutationCtx, args: CollectionHookArgs) =>
    postDomainEvent(ctx, {
      orgId: args.orgId,
      eventType,
      sourceType: "collectionPayments",
      sourceId: args.paymentId.toString(),
      idempotencyKey: `${keyPrefix}_${args.paymentId}`,
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

export const hookCollectionPayment = makeCollectionHook("COLLECTION_PAYMENT", "collection_payment");

/**
 * Posts the cash-out + AR-reopening entry for an approved collection refund:
 * DR Accounts Receivable — Customers / CR Cash. The refund's operational side
 * (OUT collectionPayment + canonical payment + allocation reversal) is handled
 * by the caller; this hook only records the GL impact.
 */
export const hookCollectionRefund = makeCollectionHook("COLLECTION_REFUND", "collection_refund");

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

type CommissionHookArgs = {
  orgId: Id<"organizations">;
  saleId: Id<"sales">;
  salespersonId: Id<"users">;
  amountMinor: number;
  currency: string;
  actorId: Id<"users">;
  occurredAt: number;
};

function makeCommissionHook(
  eventType: "COMMISSION_ACCRUED" | "COMMISSION_PAID",
  sourceIdPrefix: string,
  keyPrefix: string
) {
  return async (ctx: MutationCtx, args: CommissionHookArgs) =>
    postDomainEvent(ctx, {
      orgId: args.orgId,
      eventType,
      sourceType: "sales",
      sourceId: `${sourceIdPrefix}_${args.saleId}`,
      idempotencyKey: `${keyPrefix}_${args.saleId}`,
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

export const hookCommissionAccrued = makeCommissionHook("COMMISSION_ACCRUED", "commission", "commission_accrued");
export const hookCommissionPaid = makeCommissionHook("COMMISSION_PAID", "commission_paid", "commission_paid");

type ReversalHookArgs<TSourceId> = {
  orgId: Id<"organizations">;
  reason: string;
  actorId: Id<"users">;
  reversalDate: number;
} & TSourceId;

/**
 * All void/cancel hooks share reverseEventIfPosted semantics and differ only
 * in which original event they target and how their idempotency keys are
 * derived from the source id.
 */
function makeReversalHook<TSourceId extends Record<string, unknown>>(cfg: {
  eventType: EventType;
  sourceType: string;
  sourceId: (args: TSourceId) => string;
  reversalKey: (args: TSourceId) => string;
  pendingPostKey: (args: TSourceId) => string;
}) {
  return async (ctx: MutationCtx, args: ReversalHookArgs<TSourceId>) =>
    reverseEventIfPosted(ctx, {
      orgId: args.orgId,
      sourceType: cfg.sourceType,
      sourceId: cfg.sourceId(args),
      eventType: cfg.eventType,
      reason: args.reason,
      actorId: args.actorId,
      reversalDate: args.reversalDate,
      reversalIdempotencyKey: cfg.reversalKey(args),
      pendingPostIdempotencyKey: cfg.pendingPostKey(args),
    });
}

/** Reverses the SALE_COMPLETED entry (or cancels its pending post) when a sale is cancelled. */
export const hookSaleCancelled = makeReversalHook<{ saleId: Id<"sales"> }>({
  eventType: "SALE_COMPLETED",
  sourceType: "sales",
  sourceId: (a) => a.saleId.toString(),
  reversalKey: (a) => `sale_cancelled_${a.saleId}`,
  pendingPostKey: (a) => `sale_completed_${a.saleId}`,
});

/** Reverses the FINANCE_DISBURSED entry created at finalizeDeal, when voiding a closed application that was never actually disbursed. */
export const hookFinanceDisbursementCancelled = makeReversalHook<{ applicationId: Id<"financeApplications"> }>({
  eventType: "FINANCE_DISBURSED",
  sourceType: "financeApplications",
  sourceId: (a) => a.applicationId.toString(),
  reversalKey: (a) => `finance_disbursement_cancelled_${a.applicationId}`,
  pendingPostKey: (a) => `finance_disbursed_${a.applicationId}`,
});

/** Reverses a COMMISSION_ACCRUED entry when the underlying sale is voided. */
export const hookCommissionReversed = makeReversalHook<{ saleId: Id<"sales"> }>({
  eventType: "COMMISSION_ACCRUED",
  sourceType: "sales",
  sourceId: (a) => `commission_${a.saleId}`,
  reversalKey: (a) => `commission_reversed_${a.saleId}`,
  pendingPostKey: (a) => `commission_accrued_${a.saleId}`,
});

/** Reverses a DEPOSIT_APPLIED entry when an applied deposit is reinstated as an active hold (e.g. the sale it was applied to gets voided). */
export const hookDepositApplicationReversed = makeReversalHook<{ depositId: Id<"deposits"> }>({
  eventType: "DEPOSIT_APPLIED",
  sourceType: "deposits",
  sourceId: (a) => a.depositId.toString(),
  reversalKey: (a) => `deposit_applied_reversed_${a.depositId}`,
  pendingPostKey: (a) => `deposit_applied_${a.depositId}`,
});

/**
 * Reverses the DEPOSIT_RECEIVED entry when a HELD deposit is voided as
 * recorded-in-error (as opposed to refunded/forfeited, which post their own
 * dedicated resolution entries). If the original entry never posted (still in
 * the outbox), it is cancelled so the round trip nets to zero.
 */
export const hookDepositVoided = makeReversalHook<{ depositId: Id<"deposits"> }>({
  eventType: "DEPOSIT_RECEIVED",
  sourceType: "deposits",
  sourceId: (a) => a.depositId.toString(),
  reversalKey: (a) => `deposit_voided_${a.depositId}`,
  pendingPostKey: (a) => `deposit_received_${a.depositId}`,
});

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

// ─── GL Phase 11: fixed-asset lifecycle ───────────────────────────────────────

/**
 * Unlike GENERAL_EXPENSE/AP-Suppliers (self-healed unconditionally in
 * postOrEnqueue since many event types can resolve them), the 6 fixed-asset
 * accounts are only ever needed by these 4 hooks — so the self-heal is scoped
 * here instead of added to the shared choke point, to avoid the extra lookup
 * on every unrelated posting event.
 */
async function ensureFixedAssetAccountsIfChartReady(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  if (await isChartInitialized(ctx, orgId)) {
    await ensureFixedAssetAccounts(ctx, orgId, actorId);
  }
}

export async function hookAssetCapitalized(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    assetId: Id<"fixedAssets">;
    costMinor: number;
    currency: string;
    paymentMethod?: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await ensureFixedAssetAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "ASSET_CAPITALIZED",
    sourceType: "fixedAssets",
    sourceId: args.assetId.toString(),
    idempotencyKey: `asset_capitalized_${args.assetId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      assetId: args.assetId.toString(),
      costMinor: args.costMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
    },
  });
}

export async function hookDepreciationPosted(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    assetId: Id<"fixedAssets">;
    yearMonth: string; // "YYYY-MM", used only for the idempotency key
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await ensureFixedAssetAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "DEPRECIATION_POSTED",
    sourceType: "fixedAssets",
    sourceId: `depr_${args.assetId}_${args.yearMonth}`,
    idempotencyKey: `depr_${args.assetId}_${args.yearMonth}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      assetId: args.assetId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
    },
  });
}

export async function hookAssetImpaired(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    assetId: Id<"fixedAssets">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await ensureFixedAssetAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "ASSET_IMPAIRED",
    sourceType: "fixedAssets",
    sourceId: args.assetId.toString(),
    idempotencyKey: `asset_impaired_${args.assetId}_${args.occurredAt}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      assetId: args.assetId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
    },
  });
}

// ─── GL Phase 12: partner equity movements ────────────────────────────────────

/** Same scoped-self-heal reasoning as ensureFixedAssetAccountsIfChartReady: only these three hooks ever resolve the partner-equity accounts. */
async function ensurePartnerEquityAccountsIfChartReady(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  if (await isChartInitialized(ctx, orgId)) {
    await ensurePartnerEquityAccounts(ctx, orgId, actorId);
  }
}

export interface PartnerEquityHookArgs {
  orgId: Id<"organizations">;
  transactionId: Id<"partnerEquityTransactions">;
  partnerId: Id<"partnerEquity">;
  amountMinor: number;
  currency: string;
  paymentMethod?: string;
  actorId: Id<"users">;
  occurredAt: number;
}

async function postPartnerEquityEvent(
  ctx: MutationCtx,
  eventType: Extract<EventType, "CAPITAL_CONTRIBUTED" | "PARTNER_DREW" | "PROFIT_DISTRIBUTED">,
  args: PartnerEquityHookArgs
) {
  await ensurePartnerEquityAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType,
    sourceType: "partnerEquityTransactions",
    sourceId: args.transactionId.toString(),
    idempotencyKey: `${eventType.toLowerCase()}_${args.transactionId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      partnerId: args.partnerId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
    },
  });
}

export async function hookCapitalContributed(ctx: MutationCtx, args: PartnerEquityHookArgs) {
  await postPartnerEquityEvent(ctx, "CAPITAL_CONTRIBUTED", args);
}

// ─── GL Phase 13: claim receivables ───────────────────────────────────────────

export interface ClaimHookArgs {
  orgId: Id<"organizations">;
  claimId: Id<"claims">;
  amountMinor: number;
  currency: string;
  paymentMethod?: string;
  actorId: Id<"users">;
  occurredAt: number;
}

async function postClaimEvent(
  ctx: MutationCtx,
  eventType: Extract<EventType, "CLAIM_SETTLED" | "CLAIM_WRITTEN_OFF">,
  args: ClaimHookArgs
) {
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensureClaimAccounts(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType,
    sourceType: "claims",
    sourceId: args.claimId.toString(),
    idempotencyKey: `${eventType.toLowerCase()}_${args.claimId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      claimId: args.claimId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
    },
  });
}

export async function hookClaimSettled(ctx: MutationCtx, args: ClaimHookArgs) {
  await postClaimEvent(ctx, "CLAIM_SETTLED", args);
}

export async function hookClaimWrittenOff(ctx: MutationCtx, args: ClaimHookArgs) {
  await postClaimEvent(ctx, "CLAIM_WRITTEN_OFF", args);
}

export async function hookPartnerDrew(ctx: MutationCtx, args: PartnerEquityHookArgs) {
  await postPartnerEquityEvent(ctx, "PARTNER_DREW", args);
}

export async function hookProfitDistributed(ctx: MutationCtx, args: PartnerEquityHookArgs) {
  await postPartnerEquityEvent(ctx, "PROFIT_DISTRIBUTED", args);
}

export async function hookAssetDisposed(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    assetId: Id<"fixedAssets">;
    costMinor: number;
    accumulatedDepreciationMinor: number;
    proceedsMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await ensureFixedAssetAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "ASSET_DISPOSED",
    sourceType: "fixedAssets",
    sourceId: args.assetId.toString(),
    idempotencyKey: `asset_disposed_${args.assetId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      assetId: args.assetId.toString(),
      costMinor: args.costMinor,
      accumulatedDepreciationMinor: args.accumulatedDepreciationMinor,
      proceedsMinor: args.proceedsMinor,
      currency: args.currency,
    },
  });
}

