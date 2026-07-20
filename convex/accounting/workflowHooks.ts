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
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";
import { postAccountingEvent, PostCommand } from "./postingEngine";
import { EventType, ReceivableCreditKey, AcquisitionCorrectionType, classifyExpensePosting } from "./postingRules";
import { reverseAccountingEvent } from "./reversals";
import { getOpenPeriodForDate } from "../accountingPeriods";
import { isChartInitialized, ensureGeneralExpenseAccount, ensureSupplierAPAccount, ensureFixedAssetAccounts, ensurePartnerEquityAccounts, ensureClaimAccounts, ensureVatReceivableAccount, ensureMiscIncomeAccount, ensureSaleFiAccounts, ensureExpenseCategoryAccounts, ensurePrepaidExpensesAccount, ensurePayrollAccounts } from "../chartOfAccounts";
import {
  enqueuePendingPost,
  enqueuePendingReversal,
  cancelPendingPostByKey,
  cancelPendingPostsBySource,
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
  /** Only meaningful for DEPOSIT_REFUNDED — forfeiture never moves cash. */
  paymentMethod?: string;
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
        paymentMethod: args.paymentMethod,
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
    /** Documentation/admin fees on top of the vehicle price — added to the AR debit, credited to Dealer Fee Income. */
    dealerFeesMinor?: number;
    /** Warranty/GAP premium collected and the portion owed to the third-party underwriter — see SaleCompletedPayload. */
    warrantySoldMinor?: number;
    warrantyCostMinor?: number;
    gapSoldMinor?: number;
    gapCostMinor?: number;
  }
) {
  // Self-heal for orgs that initialized their chart before dealer-fee/warranty/GAP
  // support existed — only relevant when this specific sale actually uses one
  // of those fields, to avoid the extra lookups on every ordinary sale.
  if (args.dealerFeesMinor || args.warrantySoldMinor || args.gapSoldMinor) {
    if (await isChartInitialized(ctx, args.orgId)) {
      await ensureSaleFiAccounts(ctx, args.orgId, args.actorId);
    }
  }
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
      dealerFeesMinor: args.dealerFeesMinor,
      warrantySoldMinor: args.warrantySoldMinor,
      warrantyCostMinor: args.warrantyCostMinor,
      gapSoldMinor: args.gapSoldMinor,
      gapCostMinor: args.gapCostMinor,
    },
  });
}

/**
 * Phase 41 self-heal, scoped like ensureFixedAssetAccountsIfChartReady: only
 * expense-posting and supplier-payment-settling ever debit VAT_RECEIVABLE, so
 * this isn't added to the shared postOrEnqueue choke point.
 */
async function ensureVatReceivableAccountIfChartReady(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  if (await isChartInitialized(ctx, orgId)) {
    await ensureVatReceivableAccount(ctx, orgId, actorId);
  }
}

export async function hookSupplierPaymentSettled(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    payableId: Id<"vehicleSupplierPayables">;
    sourcedFromName: string;
    amountMinor: number;
    taxMinor?: number;
    currency: string;
    paymentMethod?: string;
    /** See SupplierPaymentSettledPayload — defaults to "COGS" (sale-originated payables). */
    costOrigin?: "COGS" | "VEHICLE_INVENTORY";
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (args.taxMinor && args.taxMinor > 0) {
    await ensureVatReceivableAccountIfChartReady(ctx, args.orgId, args.actorId);
  }
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
      taxMinor: args.taxMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
      costOrigin: args.costOrigin,
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
    taxMinor?: number;
    currency: string;
    category?: string;
    paymentMethod?: string;
    actorId: Id<"users">;
    occurredAt: number;
    vehicleId?: Id<"vehicles">;
    capitalizeToInventory?: boolean;
    isPrepaid?: boolean;
  }
) {
  const { capitalize, prepaid } = classifyExpensePosting(args);
  if (args.taxMinor && args.taxMinor > 0) {
    await ensureVatReceivableAccountIfChartReady(ctx, args.orgId, args.actorId);
  }
  if (!capitalize && await isChartInitialized(ctx, args.orgId)) {
    // A prepaid expense debits the Prepaid Expenses asset now and releases it
    // to a per-category expense account later, so both must exist. A normal
    // expense resolves expenseAccountKeyForCategory, which can point at a
    // dedicated per-category account instead of always GENERAL_EXPENSE — either
    // way, self-heal the category accounts for charts initialized before those
    // additions.
    await ensureExpenseCategoryAccounts(ctx, args.orgId, args.actorId);
    if (prepaid) {
      await ensurePrepaidExpensesAccount(ctx, args.orgId, args.actorId);
    }
  }
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
      taxMinor: args.taxMinor,
      currency: args.currency,
      category: args.category,
      paymentMethod: args.paymentMethod,
      vehicleId: args.vehicleId?.toString(),
      capitalizeToInventory: args.capitalizeToInventory,
      isPrepaid: prepaid,
    },
  });
}

// ─── Vehicle inventory capitalization ─────────────────────────────────────────

export async function hookVehicleAcquired(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    costMinor: number;
    currency: string;
    paymentMethod?: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "VEHICLE_ACQUIRED",
    sourceType: "vehicles",
    sourceId: args.vehicleId.toString(),
    idempotencyKey: `vehicle_acquired_${args.vehicleId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      vehicleId: args.vehicleId.toString(),
      costMinor: args.costMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
    },
  });
}

export async function hookTradeInAccepted(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    saleId: Id<"sales">;
    customerId: Id<"customers">;
    tradeInValueMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "TRADE_IN_ACCEPTED",
    sourceType: "vehicles",
    sourceId: args.vehicleId.toString(),
    idempotencyKey: `trade_in_accepted_${args.saleId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      vehicleId: args.vehicleId.toString(),
      saleId: args.saleId.toString(),
      customerId: args.customerId.toString(),
      tradeInValueMinor: args.tradeInValueMinor,
      currency: args.currency,
    },
  });
}

/**
 * Reverses the TRADE_IN_ACCEPTED entry when the sale it was part of is
 * cancelled. reversalKey includes saleId, not just vehicleId — the same
 * vehicle can be traded in again on a later sale once its purchasePrice is
 * cleared, and a vehicle-only key would collide with an earlier trade-in's
 * reversal, causing reverseAccountingEvent's own idempotency check to report
 * "already reversed" without ever reversing the second sale's entry.
 */
export const hookTradeInReversed = makeReversalHook<{ vehicleId: Id<"vehicles">; saleId: Id<"sales"> }>({
  eventType: "TRADE_IN_ACCEPTED",
  sourceType: "vehicles",
  sourceId: (a) => a.vehicleId.toString(),
  reversalKey: (a) => `trade_in_reversed_${a.vehicleId}_${a.saleId}`,
  pendingPostKey: (a) => `trade_in_accepted_${a.saleId}`,
});

/**
 * Each landed-cost edit is its own economic event (upsertLandedCosts replaces
 * the whole items list every save), so the idempotency/source key includes
 * `editToken` — a caller-supplied per-edit discriminator (the landed-cost
 * row's updatedAt after the patch) rather than being derived from vehicleId
 * alone, which would collide across edits.
 */
export async function hookVehicleLandedCostCapitalized(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    editToken: string;
    /** Per-account signed deltas — see VehicleLandedCostCapitalizedPayload. */
    accountDeltas: Array<{ paymentMethod?: string; deltaMinor: number }>;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "VEHICLE_LANDED_COST_CAPITALIZED",
    sourceType: "vehicleLandedCosts",
    sourceId: `${args.vehicleId}_${args.editToken}`,
    idempotencyKey: `landed_cost_${args.vehicleId}_${args.editToken}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      vehicleId: args.vehicleId.toString(),
      // Net total kept at the top level too — accountingMigration.ts's
      // backfill reads this scalar to exclude already-posted landed-cost
      // amounts from its opening-balance calculation without needing to
      // know about the per-account breakdown.
      deltaMinor: args.accountDeltas.reduce((sum, d) => sum + d.deltaMinor, 0),
      accountDeltas: args.accountDeltas,
      currency: args.currency,
    },
  });
}

export async function hookVehicleAcquisitionCostCorrected(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    correctionToken: string;
    deltaMinor: number;
    currency: string;
    correctionType?: AcquisitionCorrectionType;
    paymentMethod?: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "VEHICLE_ACQUISITION_COST_CORRECTED",
    sourceType: "vehicleCostCorrections",
    sourceId: `${args.vehicleId}_${args.correctionToken}`,
    idempotencyKey: `vehicle_cost_corrected_${args.vehicleId}_${args.correctionToken}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      vehicleId: args.vehicleId.toString(),
      deltaMinor: args.deltaMinor,
      currency: args.currency,
      correctionType: args.correctionType,
      paymentMethod: args.paymentMethod,
    },
  });
}

export async function hookVehiclePrepExpenseReclassified(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    expenseId: Id<"expenses">;
    vehicleId: Id<"vehicles">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "VEHICLE_PREP_EXPENSE_RECLASSIFIED",
    sourceType: "expenses",
    sourceId: args.expenseId.toString(),
    idempotencyKey: `vehicle_prep_expense_reclassified_${args.expenseId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      vehicleId: args.vehicleId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
    },
  });
}

// ─── Manual receivables ────────────────────────────────────────────────────────

export async function hookReceivableCreated(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    receivableId: Id<"receivables">;
    customerId: Id<"customers">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
    creditSystemKey: ReceivableCreditKey;
  }
) {
  if (args.creditSystemKey === "MISCELLANEOUS_INCOME" && (await isChartInitialized(ctx, args.orgId))) {
    await ensureMiscIncomeAccount(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "RECEIVABLE_CREATED",
    sourceType: "receivables",
    sourceId: args.receivableId.toString(),
    idempotencyKey: `receivable_created_${args.receivableId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      receivableId: args.receivableId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
      creditSystemKey: args.creditSystemKey,
    },
  });
}

type CommissionHookArgs = {
  orgId: Id<"organizations">;
  saleId: Id<"sales">;
  salespersonId: Id<"users">;
  amountMinor: number;
  currency: string;
  paymentMethod?: string;
  actorId: Id<"users">;
  occurredAt: number;
};

function makeCommissionHook(
  eventType: "COMMISSION_ACCRUED" | "COMMISSION_PAID",
  sourceIdPrefix: string,
  keyPrefix: string
) {
  return async (ctx: MutationCtx, args: CommissionHookArgs) => {
    const payload: Record<string, unknown> = {
      saleId: args.saleId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      salespersonId: args.salespersonId.toString(),
    };
    if (args.paymentMethod) payload.paymentMethod = args.paymentMethod;
    await postDomainEvent(ctx, {
      orgId: args.orgId,
      eventType,
      sourceType: "sales",
      sourceId: `${sourceIdPrefix}_${args.saleId}`,
      idempotencyKey: `${keyPrefix}_${args.saleId}`,
      currency: args.currency,
      occurredAt: args.occurredAt,
      actorId: args.actorId,
      payload,
    });
  };
}

export const hookCommissionAccrued = makeCommissionHook("COMMISSION_ACCRUED", "commission", "commission_accrued");
export const hookCommissionPaid = makeCommissionHook("COMMISSION_PAID", "commission_paid", "commission_paid");

// ─── Payroll hooks ─────────────────────────────────────────────────────────────
// Scoped self-heal (like ensureVatReceivableAccountIfChartReady): only payroll
// events touch the salaries/employee-advance accounts, so don't add them to the
// shared postOrEnqueue choke point.
async function ensurePayrollAccountsIfChartReady(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  actorId: Id<"users">
): Promise<void> {
  if (await isChartInitialized(ctx, orgId)) {
    await ensurePayrollAccounts(ctx, orgId, actorId);
  }
}

/** Advance issued to an employee: Dr Employee Advances (asset) / Cr cash. */
export async function hookEmployeeAdvancePaid(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    advanceId: Id<"employeeAdvances">;
    userId: Id<"users">;
    amountMinor: number;
    currency: string;
    paymentMethod?: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await ensurePayrollAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "EMPLOYEE_ADVANCE_PAID",
    sourceType: "employeeAdvances",
    sourceId: args.advanceId.toString(),
    idempotencyKey: `employee_advance_paid_${args.advanceId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      advanceId: args.advanceId.toString(),
      userId: args.userId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
    },
  });
}

/** Advance repaid directly (outside payroll): Dr cash / Cr Employee Advances. */
export async function hookEmployeeAdvanceRecovered(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    advanceId: Id<"employeeAdvances">;
    userId: Id<"users">;
    amountMinor: number;
    currency: string;
    paymentMethod?: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await ensurePayrollAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "EMPLOYEE_ADVANCE_RECOVERED",
    sourceType: "employeeAdvances",
    sourceId: `recovery_${args.advanceId}`,
    idempotencyKey: `employee_advance_recovered_${args.advanceId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      advanceId: args.advanceId.toString(),
      userId: args.userId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
    },
  });
}

/** Salary accrued for one employee on a run: Dr Salaries Expense / Cr Salaries Payable. */
export async function hookPayrollAccrued(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    itemId: Id<"payrollItems">;
    runId: Id<"payrollRuns">;
    userId: Id<"users">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await ensurePayrollAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "PAYROLL_ACCRUED",
    sourceType: "payrollItems",
    sourceId: `accrued_${args.itemId}`,
    idempotencyKey: `payroll_accrued_${args.itemId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      runId: args.runId.toString(),
      userId: args.userId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
    },
  });
}

/** One employee's payslip payment (clears salary + commission payables, recovers advance, pays net). */
export async function hookPayrollPaid(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    itemId: Id<"payrollItems">;
    userId: Id<"users">;
    salaryMinor: number;
    commissionMinor: number;
    advanceRecoveredMinor: number;
    netMinor: number;
    currency: string;
    paymentMethod?: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await ensurePayrollAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "PAYROLL_PAID",
    sourceType: "payrollItems",
    sourceId: `paid_${args.itemId}`,
    idempotencyKey: `payroll_paid_${args.itemId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      itemId: args.itemId.toString(),
      userId: args.userId.toString(),
      salaryMinor: args.salaryMinor,
      commissionMinor: args.commissionMinor,
      advanceRecoveredMinor: args.advanceRecoveredMinor,
      netMinor: args.netMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
    },
  });
}

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

/**
 * Reverses the RECEIVABLE_CREATED entry when a manual receivable is
 * cancelled before any payment is collected. Safe to call for sale-linked
 * receivables too — those never had a RECEIVABLE_CREATED event posted (their
 * AR is recognized by SALE_COMPLETED instead), so this is a no-op for them.
 */
export const hookReceivableCancelled = makeReversalHook<{ receivableId: Id<"receivables"> }>({
  eventType: "RECEIVABLE_CREATED",
  sourceType: "receivables",
  sourceId: (a) => a.receivableId.toString(),
  reversalKey: (a) => `receivable_cancelled_${a.receivableId}`,
  pendingPostKey: (a) => `receivable_created_${a.receivableId}`,
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

interface FixedAssetHookBaseArgs {
  orgId: Id<"organizations">;
  assetId: Id<"fixedAssets">;
  currency: string;
  actorId: Id<"users">;
  occurredAt: number;
}

async function postFixedAssetEvent(
  ctx: MutationCtx,
  eventType: Extract<
    EventType,
    "ASSET_CAPITALIZED" | "DEPRECIATION_POSTED" | "ASSET_IMPAIRED" | "ASSET_DISPOSED"
  >,
  args: FixedAssetHookBaseArgs,
  details: {
    sourceId?: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }
) {
  await ensureFixedAssetAccountsIfChartReady(ctx, args.orgId, args.actorId);
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType,
    sourceType: "fixedAssets",
    sourceId: details.sourceId ?? args.assetId.toString(),
    idempotencyKey: details.idempotencyKey,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      assetId: args.assetId.toString(),
      ...details.payload,
      currency: args.currency,
    },
  });
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
  await postFixedAssetEvent(ctx, "ASSET_CAPITALIZED", args, {
    idempotencyKey: `asset_capitalized_${args.assetId}`,
    payload: {
      costMinor: args.costMinor,
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
  await postFixedAssetEvent(ctx, "DEPRECIATION_POSTED", args, {
    sourceId: `depr_${args.assetId}_${args.yearMonth}`,
    idempotencyKey: `depr_${args.assetId}_${args.yearMonth}`,
    payload: {
      amountMinor: args.amountMinor,
    },
  });
}

export async function hookFiCommissionRecognized(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    deferralId: Id<"dealerProductDeferrals">;
    yearMonth: string; // "YYYY-MM", used only for the idempotency key
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensureSaleFiAccounts(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "FI_COMMISSION_RECOGNIZED",
    sourceType: "dealerProductDeferrals",
    sourceId: args.deferralId.toString(),
    idempotencyKey: `fi_commission_${args.deferralId}_${args.yearMonth}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      deferralId: args.deferralId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
    },
  });
}

/**
 * Monthly release of one term-month of a prepaid expense from the Prepaid
 * Expenses asset into its operating-expense account. Exact same shape as
 * hookFiCommissionRecognized — idempotent per (schedule, yearMonth) — see
 * prepaidExpenses.amortizePrepaidExpenseForMonth.
 */
export async function hookPrepaidExpenseAmortized(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    scheduleId: Id<"prepaidExpenseSchedules">;
    yearMonth: string; // "YYYY-MM", used only for the idempotency key
    amountMinor: number;
    currency: string;
    expenseSystemKey: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensurePrepaidExpensesAccount(ctx, args.orgId, args.actorId);
    await ensureExpenseCategoryAccounts(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "PREPAID_EXPENSE_AMORTIZED",
    sourceType: "prepaidExpenseSchedules",
    // Per-month sourceId (same idiom as the monthly depreciation posting): each
    // recognition is a distinct GL event on the source-identity dedup index, so
    // month 2+ can't be mistaken for a duplicate of month 1. The reversal
    // clawback below finds all of a schedule's months via payload.scheduleId.
    sourceId: `prepaid_amort_${args.scheduleId}_${args.yearMonth}`,
    idempotencyKey: `prepaid_amort_${args.scheduleId}_${args.yearMonth}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      scheduleId: args.scheduleId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      expenseSystemKey: args.expenseSystemKey,
      // Explicit recognition month for the report's event-derived bucketing
      // (utils/prepaidRecognitionEvents.ts) — previously only encoded in the
      // sourceId suffix, which the report parses as a fallback for events
      // posted before this field existed.
      yearMonth: args.yearMonth,
    },
  });
}

/**
 * Posts the cash-in entry for a partial refund of a prepaid schedule's unused
 * portion — called from prepaidExpenses.correctSchedule. `correctionId` (the
 * prepaidScheduleCorrections row) makes the idempotency key unique per
 * correction, distinct from the per-month keys hookPrepaidExpenseAmortized uses.
 */
export async function hookPrepaidExpenseRefunded(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    scheduleId: Id<"prepaidExpenseSchedules">;
    correctionId: Id<"prepaidScheduleCorrections">;
    amountMinor: number;
    taxMinor?: number;
    currency: string;
    paymentMethod?: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensurePrepaidExpensesAccount(ctx, args.orgId, args.actorId);
  }
  if (args.taxMinor && args.taxMinor > 0) {
    await ensureVatReceivableAccountIfChartReady(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "PREPAID_EXPENSE_REFUNDED",
    sourceType: "prepaidExpenseSchedules",
    sourceId: `prepaid_refund_${args.correctionId}`,
    idempotencyKey: `prepaid_refund_${args.correctionId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      scheduleId: args.scheduleId.toString(),
      amountMinor: args.amountMinor,
      taxMinor: args.taxMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
    },
  });
}

/**
 * Posts the accelerated write-off of a prepaid schedule's non-refundable
 * unused portion — same GL shape as hookPrepaidExpenseAmortized (release the
 * asset into its expense account) but as a distinct eventType and a one-off
 * per-correction idempotency key rather than a per-month one.
 */
export async function hookPrepaidExpenseWrittenOff(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    scheduleId: Id<"prepaidExpenseSchedules">;
    correctionId: Id<"prepaidScheduleCorrections">;
    amountMinor: number;
    currency: string;
    expenseSystemKey: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (await isChartInitialized(ctx, args.orgId)) {
    await ensurePrepaidExpensesAccount(ctx, args.orgId, args.actorId);
    await ensureExpenseCategoryAccounts(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "PREPAID_EXPENSE_WRITTEN_OFF",
    sourceType: "prepaidExpenseSchedules",
    sourceId: `prepaid_writeoff_${args.correctionId}`,
    idempotencyKey: `prepaid_writeoff_${args.correctionId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      scheduleId: args.scheduleId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
      expenseSystemKey: args.expenseSystemKey,
    },
  });
}

/**
 * Claws back every month of F&I commission already recognized for a
 * deferral whose sale was cancelled — unlike makeReversalHook's single-event
 * lookup, a deferral can have one FI_COMMISSION_RECOGNIZED event per
 * recognized month, so each is reversed individually. reverseAccountingEvent
 * is a no-op (returns alreadyReversed) on an event it's already reversed, so
 * this is safe to call more than once for the same deferral. Also drops any
 * month that was enqueued but never posted, so it never posts later.
 */
export async function hookFiCommissionRecognitionsReversed(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    deferralId: Id<"dealerProductDeferrals">;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
): Promise<void> {
  const postedEvents = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", args.orgId).eq("sourceType", "dealerProductDeferrals").eq("sourceId", args.deferralId.toString())
    )
    .filter((q) => q.eq(q.field("eventType"), "FI_COMMISSION_RECOGNIZED"))
    .filter((q) => q.eq(q.field("status"), "POSTED"))
    .collect();

  const period = await getOpenPeriodForDate(ctx, args.orgId, args.reversalDate);
  for (const event of postedEvents) {
    const reversalIdempotencyKey = `fi_commission_reversed_${event._id}`;
    if (period) {
      await reverseAccountingEvent(ctx, {
        orgId: args.orgId,
        originalEventId: event._id,
        reversalDate: args.reversalDate,
        reason: args.reason,
        actorId: args.actorId,
        idempotencyKey: reversalIdempotencyKey,
      });
    } else {
      await enqueuePendingReversal(ctx, {
        orgId: args.orgId,
        originalEventId: event._id,
        reversalDate: args.reversalDate,
        reason: args.reason,
        actorId: args.actorId,
        idempotencyKey: reversalIdempotencyKey,
        sourceType: "dealerProductDeferrals",
        sourceId: args.deferralId.toString(),
      });
    }
  }

  // Drops every not-yet-posted queued month, PENDING or FAILED — a recognition
  // attempt that failed 10 times (accountingOutbox.ts's MAX_ATTEMPTS) moves to
  // FAILED but stays retryable by a finance user, so a status: "PENDING"-only
  // sweep here would leave it behind: a later manual retry could then post F&I
  // revenue for a deferral whose sale was already cancelled.
  await cancelPendingPostsBySource(ctx, args.orgId, "dealerProductDeferrals", args.deferralId.toString());
}

/**
 * Reverses every prepaid GL event already posted for a schedule whose expense
 * is being reversed — every monthly amortization release AND every correction
 * (partial refund, accelerated write-off), same per-event clawback shape as
 * hookFiCommissionRecognitionsReversed. Together with reversing the original
 * EXPENSE_POSTED entry (which reverseExpense already does), this unwinds the
 * whole prepaid lifecycle to zero: the asset debit, the cash credit, every
 * asset→expense release, and any correction's cash refund or accelerated
 * write-off. Without covering the correction event types too, a schedule that
 * had a refund or write-off posted before its expense was reversed would keep
 * that correction's postings live in the GL — orphaned cash/prepaid/VAT
 * balances with no corresponding expense. Idempotent (reverseAccountingEvent
 * no-ops on an already-reversed event) and also drops any not-yet-posted
 * queued event (amortization or correction alike).
 *
 * Returns how many already-POSTED events it reversed, which is how a caller
 * tells real ledger history apart from a schedule that never reached the GL.
 * Note this is NOT implied by the source expense having posted: amortization
 * refuses to run until EXPENSE_POSTED lands (prepaidExpenses.ts's
 * "source_expense_not_posted" — it won't release an asset that was never
 * booked), but a correction won't. correctSchedule can post an accelerated
 * write-off against a schedule whose EXPENSE_POSTED is still queued behind a
 * month that has no open period, so a count > 0 with no posted EXPENSE_POSTED
 * is a reachable state, not a contradiction. A count of 0 means this schedule
 * left no footprint in the ledger.
 */
export async function hookPrepaidExpenseAmortizationsReversed(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    scheduleId: Id<"prepaidExpenseSchedules">;
    reason: string;
    actorId: Id<"users">;
    reversalDate: number;
  }
): Promise<number> {
  const scheduleIdStr = args.scheduleId.toString();
  const REVERSIBLE_EVENT_TYPES = [
    "PREPAID_EXPENSE_AMORTIZED",
    "PREPAID_EXPENSE_REFUNDED",
    "PREPAID_EXPENSE_WRITTEN_OFF",
  ] as const;
  // Each event type uses a per-event (per-month, or per-correction) sourceId,
  // so they're gathered by their (stable) payload.scheduleId rather than an
  // exact sourceId match.
  const postedEvents: Doc<"accountingEvents">[] = [];
  for (const eventType of REVERSIBLE_EVENT_TYPES) {
    const events = await ctx.db
      .query("accountingEvents")
      .withIndex("by_org_eventType", (q) => q.eq("orgId", args.orgId).eq("eventType", eventType))
      .filter((q) => q.eq(q.field("status"), "POSTED"))
      .collect();
    postedEvents.push(...events.filter((e) => (e.payload as { scheduleId?: string })?.scheduleId === scheduleIdStr));
  }

  const period = await getOpenPeriodForDate(ctx, args.orgId, args.reversalDate);
  for (const event of postedEvents) {
    const reversalIdempotencyKey = `prepaid_reversed_${event._id}`;
    if (period) {
      await reverseAccountingEvent(ctx, {
        orgId: args.orgId,
        originalEventId: event._id,
        reversalDate: args.reversalDate,
        reason: args.reason,
        actorId: args.actorId,
        idempotencyKey: reversalIdempotencyKey,
      });
    } else {
      await enqueuePendingReversal(ctx, {
        orgId: args.orgId,
        originalEventId: event._id,
        reversalDate: args.reversalDate,
        reason: args.reason,
        actorId: args.actorId,
        idempotencyKey: reversalIdempotencyKey,
        sourceType: "prepaidExpenseSchedules",
        sourceId: event.sourceId,
      });
    }
  }

  // Drop any not-yet-posted queued amortization months for this schedule
  // (PENDING or FAILED), so a later retry can't post a month for a reversed
  // prepayment — same reasoning as the F&I clawback.
  for (const status of ["PENDING", "FAILED"] as const) {
    const queued = (
      await ctx.db
        .query("pendingAccountingEvents")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
        .collect()
    ).filter(
      (p) =>
        p.sourceType === "prepaidExpenseSchedules" &&
        (p.payload as { scheduleId?: string })?.scheduleId === scheduleIdStr
    );
    for (const entry of queued) {
      if (entry.kind === "POST") await ctx.db.delete(entry._id);
    }
  }

  return postedEvents.length;
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
  await postFixedAssetEvent(ctx, "ASSET_IMPAIRED", args, {
    // No timestamp suffix: an asset can only transition ACTIVE -> IMPAIRED
    // once (impair() gates on status === "ACTIVE"), so the key must stay
    // stable across retries rather than vary with wall-clock occurredAt.
    idempotencyKey: `asset_impaired_${args.assetId}`,
    payload: {
      amountMinor: args.amountMinor,
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

// ─── GL Phase 15: cash-drawer bank deposit ────────────────────────────────────

/**
 * No scoped self-heal here: unlike the fixed-asset/partner-equity/claim
 * accounts, BANK_ACCOUNT and CASH_ON_HAND are foundational accounts already
 * ensured by chartOfAccounts.initialize for every org.
 */
export async function hookCashDrawerDeposited(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    sessionId: Id<"cashDrawerSessions">;
    amountMinor: number;
    currency: string;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "CASH_DRAWER_DEPOSITED",
    sourceType: "cashDrawerSessions",
    sourceId: args.sessionId.toString(),
    idempotencyKey: `cash_drawer_deposited_${args.sessionId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      sessionId: args.sessionId.toString(),
      amountMinor: args.amountMinor,
      currency: args.currency,
    },
  });
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
  await postFixedAssetEvent(ctx, "ASSET_DISPOSED", args, {
    idempotencyKey: `asset_disposed_${args.assetId}`,
    payload: {
      costMinor: args.costMinor,
      accumulatedDepreciationMinor: args.accumulatedDepreciationMinor,
      proceedsMinor: args.proceedsMinor,
    },
  });
}

