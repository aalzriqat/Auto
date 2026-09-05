import { paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import { internalQuery, query, QueryCtx, MutationCtx } from "./_generated/server";
import { internalMutation, mutation } from "./functions";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { getActorName, notifyManagers, notifyUser } from "./utils/notifications";
import { runWithIdempotency } from "./utils/idempotency";
import { assertDifferentActors } from "./utils/financialGuards";
import { postReceiptOccurrence, hookCollectionRefund, hookExpensePosted, hookReceivableCreated, hookReceivableCancelled, hookReceiptCreditApplied, findPostedReceiptOccurrence, getOrgCurrency } from "./accounting/workflowHooks";
import { directCollectionReceipt, rehydrateReceiptOccurrence } from "./accounting/receiptOccurrence";
import {
  sealReceiptMovement,
  loadRetainedPosition,
  requirePostedReceiptForMovement,
  computeApplicableMinor,
  recordRetainedApplication,
  receiptApplicationSourceId,
  RETAINED_CREDIT_SYSTEM_KEY,
} from "./accounting/receiptMovement";
import { ReceivableCreditKey } from "./accounting/postingRules";
import { reverseAccountingEvent } from "./accounting/reversals";
import { getOpenPeriodForDate, assertValidAccountingDate } from "./accountingPeriods";
import { enqueuePendingReversal, cancelPendingPostByKey } from "./accountingOutbox";
import { toMinorUnits, fromMinorUnits, scaleForCurrency } from "./utils/money";
import {
  allocatePaymentToReceivable,
  createCanonicalPayment,
  ensureReceivableDocument,
  getReceivableOutstandingMinor,
  reverseAllocation,
} from "./subledger";

const receivableStatusValidator = v.union(
  v.literal("OPEN"),
  v.literal("PARTIALLY_PAID"),
  v.literal("PAID"),
  v.literal("OVERDUE"),
  v.literal("RESCHEDULED"),
  v.literal("CANCELLED"),
  v.literal("REFUNDED")
);

const receivableSourceValidator = v.union(
  v.literal("CUSTOMER_DEPOSIT"),
  v.literal("RESERVATION_PAYMENT"),
  v.literal("INTERNAL_INSTALLMENT"),
  v.literal("BANK_FINANCED_BALANCE"),
  v.literal("BANK_TRANSFER"),
  v.literal("PAYMENT_LINK"),
  v.literal("CHEQUE"),
  v.literal("OTHER")
);

const paymentMethodValidator = v.union(
  v.literal("CASH"),
  v.literal("BANK_TRANSFER"),
  v.literal("CHEQUE"),
  v.literal("PAYMENT_LINK"),
  v.literal("CARD"),
  v.literal("DEPOSIT_APPLIED"),
  v.literal("REFUND"),
  v.literal("OTHER")
);

const receivableCreditKeyValidator = v.union(
  v.literal("MISCELLANEOUS_INCOME"),
  v.literal("CUSTOMER_DEPOSITS_LIABILITY"),
  v.literal("GENERAL_EXPENSE")
);

/**
 * A manual receivable isn't automatically "other income" — it could just as
 * easily be an unearned customer deposit/reservation hold (a liability, not
 * revenue) or a reimbursement that offsets a cost already expensed. The two
 * sourceTypes that are unambiguous get derived automatically; everything else
 * (INTERNAL_INSTALLMENT, BANK_FINANCED_BALANCE, BANK_TRANSFER, PAYMENT_LINK,
 * CHEQUE, OTHER) requires the caller to pick explicitly rather than silently
 * defaulting to income.
 */
function resolveReceivableCreditKey(
  sourceType: Doc<"receivables">["sourceType"],
  explicit: ReceivableCreditKey | undefined
): ReceivableCreditKey {
  if (explicit) return explicit;
  if (sourceType === "CUSTOMER_DEPOSIT" || sourceType === "RESERVATION_PAYMENT") {
    return "CUSTOMER_DEPOSITS_LIABILITY";
  }
  throw new ConvexError(
    "This receivable's credit account isn't obvious from its source type — specify creditSystemKey (Other Income, Customer Deposits Liability, or a cost reimbursement)."
  );
}

const chequeStatusValidator = v.union(
  v.literal("HELD"),
  v.literal("DEPOSITED"),
  v.literal("CLEARED"),
  v.literal("RETURNED"),
  v.literal("REPLACED"),
  v.literal("CANCELLED")
);

const approvalRequestTypeValidator = v.union(
  v.literal("REFUND"),
  v.literal("RESCHEDULE"),
  v.literal("CANCEL_RECEIVABLE")
);

/**
 * A refund may only be issued against a receivable whose outstanding balance
 * still reflects real collections.
 *
 * CANCELLED receivables have had outstandingAmount zeroed by the write-off, so
 * the `originalAmount - outstandingAmount` formula used for refund eligibility
 * reads them as fully paid when nothing was ever collected. REFUNDED ones have
 * already been refunded once.
 */
function assertRefundableReceivableStatus(status: ReceivableStatus): void {
  if (status === "CANCELLED") {
    throw new ConvexError(
      "This receivable was cancelled, so nothing was collected against it. A cancelled receivable cannot be refunded."
    );
  }
  if (status === "REFUNDED") {
    throw new ConvexError("This receivable has already been refunded.");
  }
}

type ReceivableStatus = Doc<"receivables">["status"];
type ReceivablePatch = Partial<Pick<Doc<"receivables">, "outstandingAmount" | "status" | "lastPaymentAt" | "updatedAt" | "dueDate" | "notes">>;
type CanonicalPaymentMethod = Parameters<typeof createCanonicalPayment>[1]["method"];
type ReceivableDocumentType = Parameters<typeof ensureReceivableDocument>[1]["documentType"];
type ReminderMessageType = Doc<"collectionReminders">["messageType"];
type ReminderChannel = Doc<"collectionReminders">["channel"];

const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_COOLDOWN_MS = 20 * 60 * 60 * 1000;

function assertPositiveAmount(amount: number, label = "Amount") {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ConvexError(`${label} must be greater than 0.`);
  }
}

function roundMoney(amount: number, currency: string) {
  const factor = Math.pow(10, scaleForCurrency(currency));
  return Math.round(amount * factor) / factor;
}

function dayRange(timestamp: number) {
  const start = new Date(timestamp);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  end.setMilliseconds(end.getMilliseconds() - 1);
  return { start: start.getTime(), end: end.getTime() };
}

function addMonths(timestamp: number, months: number) {
  const date = new Date(timestamp);
  date.setMonth(date.getMonth() + months);
  return date.getTime();
}

function nextStatus(outstandingAmount: number, dueDate: number, now = Date.now()): ReceivableStatus {
  if (outstandingAmount <= 0) return "PAID";
  if (dueDate < now) return "OVERDUE";
  return "PARTIALLY_PAID";
}

function customerName(customer: Doc<"customers"> | null) {
  if (!customer) return "Unknown customer";
  return `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Unknown customer";
}

function vehicleLabel(vehicle: Doc<"vehicles"> | null | undefined) {
  if (!vehicle) return undefined;
  return `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim();
}

function receivableDocumentType(sourceType: Doc<"receivables">["sourceType"]): ReceivableDocumentType {
  return sourceType === "INTERNAL_INSTALLMENT" ? "INSTALLMENT" : "INVOICE";
}

function canonicalPaymentMethod(method: Doc<"collectionPayments">["method"]): CanonicalPaymentMethod {
  switch (method) {
    case "CASH":
    case "BANK_TRANSFER":
    case "CHEQUE":
    case "PAYMENT_LINK":
    case "CARD":
    case "OTHER":
      return method;
    case "DEPOSIT_APPLIED":
    case "REFUND":
      return "OTHER";
  }
}

async function getOptionalVehicle(ctx: QueryCtx | MutationCtx, vehicleId?: Id<"vehicles">) {
  return vehicleId ? await ctx.db.get(vehicleId) : null;
}

async function validateOrgCustomer(ctx: QueryCtx | MutationCtx, orgId: Id<"organizations">, customerId: Id<"customers">) {
  const customer = await ctx.db.get(customerId);
  if (!customer || customer.orgId !== orgId) {
    throw new ConvexError("Customer not found in this organization.");
  }
  return customer;
}

async function validateOptionalLinks(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  links: {
    vehicleId?: Id<"vehicles">;
    saleId?: Id<"sales">;
    quoteId?: Id<"quotes">;
    applicationId?: Id<"financeApplications">;
    assignedTo?: Id<"users">;
  }
) {
  if (links.vehicleId) {
    const vehicle = await ctx.db.get(links.vehicleId);
    if (!vehicle || vehicle.orgId !== orgId) throw new ConvexError("Vehicle not found in this organization.");
  }
  if (links.saleId) {
    const sale = await ctx.db.get(links.saleId);
    if (!sale || sale.orgId !== orgId) throw new ConvexError("Sale not found in this organization.");
  }
  if (links.quoteId) {
    const quote = await ctx.db.get(links.quoteId);
    if (!quote || quote.orgId !== orgId) throw new ConvexError("Quote not found in this organization.");
  }
  if (links.applicationId) {
    const app = await ctx.db.get(links.applicationId);
    if (!app || app.orgId !== orgId) throw new ConvexError("Finance application not found in this organization.");
  }
  if (links.assignedTo) {
    const membership = await ctx.db
      .query("memberships")
      .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", links.assignedTo!))
      .unique();
    if (!membership) throw new ConvexError("Assigned user is not a member of this organization.");
  }
}

async function hydrateReceivable(ctx: QueryCtx, receivable: Doc<"receivables">) {
  const [customer, vehicle] = await Promise.all([
    ctx.db.get(receivable.customerId),
    getOptionalVehicle(ctx, receivable.vehicleId),
  ]);
  return {
    ...receivable,
    customerName: customerName(customer),
    vehicleLabel: vehicleLabel(vehicle),
  };
}

async function hydrateCheque(ctx: QueryCtx, cheque: Doc<"postDatedCheques">) {
  const [customer, vehicle, receivable] = await Promise.all([
    ctx.db.get(cheque.customerId),
    getOptionalVehicle(ctx, cheque.vehicleId),
    cheque.receivableId ? ctx.db.get(cheque.receivableId) : null,
  ]);
  return {
    ...cheque,
    customerName: customerName(customer),
    vehicleLabel: vehicleLabel(vehicle),
    receivableTitle: receivable?.title,
  };
}

async function hydratePayment(ctx: QueryCtx, payment: Doc<"collectionPayments">) {
  const [customer, vehicle, receivable] = await Promise.all([
    ctx.db.get(payment.customerId),
    getOptionalVehicle(ctx, payment.vehicleId),
    payment.receivableId ? ctx.db.get(payment.receivableId) : null,
  ]);
  return {
    ...payment,
    customerName: customerName(customer),
    vehicleLabel: vehicleLabel(vehicle),
    receivableTitle: receivable?.title,
  };
}

async function applyPostedPayment(
  ctx: MutationCtx,
  receivable: Doc<"receivables">,
  amount: number,
  paymentDate: number,
  currency: string
) {
  const outstandingAmount = roundMoney(Math.max(0, receivable.outstandingAmount - amount), currency);
  const patch: ReceivablePatch = {
    outstandingAmount,
    status: nextStatus(outstandingAmount, receivable.dueDate),
    lastPaymentAt: paymentDate,
    updatedAt: Date.now(),
  };
  await ctx.db.patch(receivable._id, patch);
}

/**
 * ⚠️ This trusts `receivable.canonicalReceivableDocumentId` without checking
 * that the document it names is actually sourced from THIS receivable, and the
 * REFUND and RESCHEDULE approval branches reach it without passing through the
 * cancellation gate's stricter `findCanonicalReceivableForLegacy`.
 *
 * That is safe today for one reason, and it is worth stating because it is a
 * convention rather than a constraint: `receivables.canonicalReceivableDocumentId`
 * has exactly ONE writer whole-tree — the patch at the bottom of this function —
 * and it always stores the document resolved from this receivable's own
 * `legacy_receivable/<id>` source key, so the link is self-consistent by
 * construction. Two independent review seats verified that enumeration.
 *
 * If a second writer ever appears, or if REFUND/RESCHEDULE grow their own
 * document resolution, this early return becomes a way to act on the wrong
 * document and must adopt the same source-key check.
 */
async function ensureCanonicalReceivableForLegacy(
  ctx: MutationCtx,
  receivable: Doc<"receivables">,
  actorId: Id<"users">,
  currency: string
) {
  if (receivable.canonicalReceivableDocumentId) {
    const existing = await ctx.db.get(receivable.canonicalReceivableDocumentId);
    if (existing && existing.orgId === receivable.orgId) return existing._id;
  }

  const canonicalReceivableDocumentId = await ensureReceivableDocument(ctx, {
    orgId: receivable.orgId,
    branchId: receivable.branchId,
    documentType: receivableDocumentType(receivable.sourceType),
    payerType: "CUSTOMER",
    customerId: receivable.customerId,
    sourceType: "legacy_receivable",
    sourceId: receivable._id,
    originalAmountMinor: toMinorUnits(receivable.originalAmount, currency),
    currency,
    issueDate: receivable.createdAt,
    dueDate: receivable.dueDate,
    actorId,
  });

  await ctx.db.patch(receivable._id, { canonicalReceivableDocumentId });
  return canonicalReceivableDocumentId;
}

/**
 * SCRUM-121A-PRE §5.1 — the canonical allocation gate.
 *
 * Cancelling a receivable while money is still applied to it produces
 * `CANCELLED` + `ACTIVE`: the GL is reversed and zeroed while the subledger
 * still holds the allocation, so the two disagree permanently and no reader can
 * tell which is right. Both cancellation writers must prove the absence of an
 * ACTIVE allocation before they write, and this is the single proof they share
 * — a second implementation would be a second opinion.
 *
 * ## Why the read is bounded and unfiltered
 *
 * `by_receivable` carries no `status`, so a filtered `.first()` bounds what is
 * RETURNED, not what is SCANNED: a document with a long history of REVERSED
 * allocations would walk that whole history and could exhaust the transaction's
 * read allowance, making a legitimate cancellation permanently unavailable.
 *
 * So this reads at most `LIMIT + 1` rows unfiltered and refuses explicitly when
 * more history exists than it can prove over. That refusal is a real operational
 * cost and it is the deliberate choice: the gate never permits a cancellation it
 * could not prove. The durable fix is a compound
 * `by_receivable_and_status` index, which reads only the ACTIVE range — that
 * needs `schema.ts`, which this stage is not authorized to touch, and is
 * required before the accounting backend deploys.
 *
 * ## Why it throws rather than returning a verdict
 *
 * The refusal must be an UNCAUGHT throw. Both callers run inside
 * `runWithIdempotency`, which inserts its `STARTED` row before the callback, and
 * a caught exception in Convex COMMITS everything already written. Only an
 * uncaught one rolls the whole transaction back — including that row — which is
 * what makes the refusal a true zero-delta.
 */
export const ALLOCATION_HISTORY_PROBE_LIMIT = 200;

export async function assertNoActiveAllocations(
  ctx: MutationCtx,
  receivableDocumentId: Id<"receivableDocuments">
) {
  const history = await ctx.db
    .query("paymentAllocations")
    .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", receivableDocumentId))
    .take(ALLOCATION_HISTORY_PROBE_LIMIT + 1);

  if (history.length > ALLOCATION_HISTORY_PROBE_LIMIT) {
    // The advice is deliberately state-agnostic. The likeliest way to reach
    // this bound is a long, entirely REVERSED correction history — in which case
    // "reverse the remaining allocations" names an action the operator cannot
    // take, because there is nothing left to reverse.
    throw new ConvexError(
      "This debt has too long an allocation history to verify in one step, so it cannot be cancelled safely from here. " +
      "It needs a manual reconciliation before it can be closed."
    );
  }
  if (history.some((allocation) => allocation.status === "ACTIVE")) {
    throw new ConvexError(
      "This debt still has payments applied to it and cannot be cancelled. Reverse the allocations first."
    );
  }
}

/**
 * Resolve the canonical document for a legacy receivable WITHOUT creating one.
 *
 * `ensureCanonicalReceivableForLegacy` writes, so the gate cannot use it. The
 * source key is checked as well as the stored link: a document that exists but
 * whose back-link is missing would otherwise let the gate read nothing and
 * conclude "no allocations" about a document it never looked at.
 */
async function findCanonicalReceivableForLegacy(
  ctx: MutationCtx,
  receivable: Doc<"receivables">
) {
  if (receivable.canonicalReceivableDocumentId) {
    const linked = await ctx.db.get(receivable.canonicalReceivableDocumentId);
    if (linked && linked.orgId === receivable.orgId) {
      // FAIL CLOSED on a link that does not identify THIS receivable.
      //
      // Neither this resolver nor `ensureCanonicalReceivableForLegacy` checks
      // the source key, so a stale link would send BOTH the gate and the
      // cancellation to the same wrong document — they would agree with each
      // other while the receivable's real document stayed open with live
      // allocations against it.
      //
      // Validating the link and silently falling through to the source key
      // would be worse than either: the gate would then prove the absence of
      // allocations on document A while the cancellation patched document B.
      // A gate that proves something about a different row than the one being
      // written is not a gate. So this refuses instead.
      //
      // No production writer can create this state — `receivables`'
      // `canonicalReceivableDocumentId` has exactly one writer, the patch in
      // `ensureCanonicalReceivableForLegacy`, which always stores the document
      // it resolved from this receivable's own source key. This is a forward
      // guard, exercised by a constructed fixture.
      if (linked.sourceType !== "legacy_receivable" || linked.sourceId !== receivable._id) {
        throw new ConvexError(
          "This receivable's accounting document cannot be identified, so it cannot be cancelled safely."
        );
      }
      return linked;
    }
  }
  return await ctx.db
    .query("receivableDocuments")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", receivable.orgId).eq("sourceType", "legacy_receivable").eq("sourceId", receivable._id)
    )
    .unique();
}

async function mirrorCollectionPaymentToCanonical(
  ctx: MutationCtx,
  args: {
    paymentId: Id<"collectionPayments">;
    payment: Doc<"collectionPayments">;
    receivable?: Doc<"receivables"> | null;
    actorId: Id<"users">;
    currency: string;
  }
): Promise<{
  canonicalPaymentId: Id<"canonicalPayments">;
  /** Absent exactly when this receipt discharged no receivable (SCRUM-218-C). */
  paymentAllocationId?: Id<"paymentAllocations">;
}> {
  const amountMinor = toMinorUnits(args.payment.amount, args.currency);
  const canonicalPaymentId = await createCanonicalPayment(ctx, {
    orgId: args.payment.orgId,
    branchId: args.payment.branchId,
    direction: args.payment.direction,
    payerType: "CUSTOMER",
    customerId: args.payment.customerId,
    method: canonicalPaymentMethod(args.payment.method),
    amountMinor,
    currency: args.currency,
    idempotencyKey: `collection_payment_${args.paymentId}`,
    actorId: args.actorId,
    status: "SETTLED",
    externalReference: args.payment.reference,
    receivedAt: args.payment.paymentDate,
  });

  const patch: Partial<Pick<Doc<"collectionPayments">, "canonicalPaymentId" | "paymentAllocationId">> = {
    canonicalPaymentId,
  };

  if (args.receivable && args.payment.direction === "IN") {
    const canonicalReceivableDocumentId = await ensureCanonicalReceivableForLegacy(
      ctx,
      args.receivable,
      args.actorId,
      args.currency
    );
    patch.paymentAllocationId = await allocatePaymentToReceivable(ctx, {
      orgId: args.payment.orgId,
      paymentId: canonicalPaymentId,
      receivableDocumentId: canonicalReceivableDocumentId,
      amountMinor,
      actorId: args.actorId,
    });
  }

  await ctx.db.patch(args.paymentId, patch);
  // Returned as an exact, non-optional canonical id plus the allocation this
  // call actually created. SCRUM-218-C seals that allocation id as the receipt
  // movement's lineage; recovering it later by set-difference is impossible,
  // because every write in one Convex transaction can share a `_creationTime`.
  return { canonicalPaymentId, paymentAllocationId: patch.paymentAllocationId };
}

/**
 * Unwinds ACTIVE allocations on a canonical receivable to cover a refund,
 * newest first. If the refund splits an allocation, the un-refunded remainder
 * is re-allocated from the same payment so the net reversed amount equals the
 * refund exactly. This is what reopens the canonical receivable's outstanding
 * balance to match the legacy receivable after a refund.
 */
async function reverseAllocationsForRefund(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    receivableDocumentId: Id<"receivableDocuments">;
    amountMinor: number;
    actorId: Id<"users">;
  }
) {
  const activeAllocations = (
    await ctx.db
      .query("paymentAllocations")
      .withIndex("by_receivable", (q) => q.eq("receivableDocumentId", args.receivableDocumentId))
      .filter((q) => q.eq(q.field("status"), "ACTIVE"))
      .collect()
  ).sort((a, b) => b.createdAt - a.createdAt);

  let remainingMinor = args.amountMinor;
  let coveredMinor = 0;
  for (const allocation of activeAllocations) {
    if (remainingMinor <= 0) break;
    const reversedMinor = Math.min(allocation.amountMinor, remainingMinor);
    await reverseAllocation(ctx, {
      orgId: args.orgId,
      allocationId: allocation._id,
      actorId: args.actorId,
    });
    if (allocation.amountMinor > remainingMinor) {
      await allocatePaymentToReceivable(ctx, {
        orgId: args.orgId,
        paymentId: allocation.paymentId,
        receivableDocumentId: args.receivableDocumentId,
        amountMinor: allocation.amountMinor - remainingMinor,
        actorId: args.actorId,
      });
      remainingMinor = 0;
    } else {
      remainingMinor -= allocation.amountMinor;
    }
    coveredMinor += reversedMinor;
  }

  if (remainingMinor > 0) {
    throw new ConvexError(
      `Canonical allocations cover only ${coveredMinor} of the requested refund ${args.amountMinor}.`
    );
  }
}

async function insertLedgerTransaction(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    direction: "IN" | "OUT";
    amount: number;
    date: number;
    description: string;
    vehicleId?: Id<"vehicles">;
    userId?: Id<"users">;
    category: "COLLECTION_PAYMENT" | "REFUND";
    idempotencyKey?: string;
  }
) {
  await ctx.db.insert("transactions", {
    orgId: args.orgId,
    type: args.direction,
    amount: args.amount,
    date: args.date,
    category: args.category,
    description: args.description,
    vehicleId: args.vehicleId,
    userId: args.userId,
    idempotencyKey: args.idempotencyKey,
  });
}

export const summary = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const currency = await getOrgCurrency(ctx, args.orgId);

    const now = Date.now();
    const today = dayRange(now);
    const openStatuses: ReceivableStatus[] = ["OPEN", "PARTIALLY_PAID", "OVERDUE", "RESCHEDULED"];
    let totalOutstanding = 0;
    let overdueOutstanding = 0;
    let dueToday = 0;

    for (const status of openStatuses) {
      const rows = await ctx.db
        .query("receivables")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
        .take(500);
      for (const row of rows) {
        totalOutstanding += row.outstandingAmount;
        if (row.dueDate < now || row.status === "OVERDUE") overdueOutstanding += row.outstandingAmount;
        if (row.dueDate >= today.start && row.dueDate <= today.end) dueToday += row.outstandingAmount;
      }
    }

    const todaysPayments = await ctx.db
      .query("collectionPayments")
      .withIndex("by_org_paymentDate", (q) => q.eq("orgId", args.orgId).gte("paymentDate", today.start))
      .take(500);
    const collectedToday = todaysPayments
      .filter((payment) => payment.paymentDate <= today.end && payment.status === "POSTED")
      .reduce((sum, payment) => sum + (payment.direction === "IN" ? payment.amount : -payment.amount), 0);

    const upcomingCheques = await ctx.db
      .query("postDatedCheques")
      .withIndex("by_org_chequeDate", (q) => q.eq("orgId", args.orgId).gte("chequeDate", now))
      .take(200);
    const upcomingChequesThisWeek = upcomingCheques
      .filter((cheque) => cheque.chequeDate <= now + 7 * DAY_MS && (cheque.status === "HELD" || cheque.status === "DEPOSITED"));
    const upcomingChequeTotal = upcomingChequesThisWeek.reduce((sum, cheque) => sum + cheque.amount, 0);

    return {
      totalOutstanding: roundMoney(totalOutstanding, currency),
      overdueOutstanding: roundMoney(overdueOutstanding, currency),
      dueToday: roundMoney(dueToday, currency),
      collectedToday: roundMoney(collectedToday, currency),
      upcomingChequeTotal: roundMoney(upcomingChequeTotal, currency),
      upcomingChequeCount: upcomingChequesThisWeek.length,
    };
  },
});

export const listReceivables = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
    status: v.optional(receivableStatusValidator),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const result = args.status
      ? await ctx.db
          .query("receivables")
          .withIndex("by_org_status_and_dueDate", (q) =>
            q.eq("orgId", args.orgId).eq("status", args.status!)
          )
          .order("asc")
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("receivables")
          .withIndex("by_org_dueDate", (q) => q.eq("orgId", args.orgId))
          .order("asc")
          .paginate(args.paginationOpts);

    return {
      ...result,
      page: await Promise.all(result.page.map((row) => hydrateReceivable(ctx, row))),
    };
  },
});

/**
 * Phase 41 — Installment Collections Calendar. Unlike listReceivables (load-
 * more pagination for a list view), this pulls every open receivable due
 * within a bounded date range (a visible calendar month) so the UI can group
 * them by day. Excludes settled statuses so cleared installments don't
 * clutter the calendar.
 */
export const listReceivablesDueBetween = query({
  args: {
    orgId: v.id("organizations"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const rows = await ctx.db
      .query("receivables")
      .withIndex("by_org_dueDate", (q) =>
        q.eq("orgId", args.orgId).gte("dueDate", args.startDate).lte("dueDate", args.endDate)
      )
      .collect();
    const openRows = rows.filter((row) => !row.isDeleted && !["PAID", "CANCELLED", "REFUNDED"].includes(row.status));
    return Promise.all(openRows.map((row) => hydrateReceivable(ctx, row)));
  },
});

export const listCheques = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
    status: v.optional(chequeStatusValidator),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const result = args.status
      ? await ctx.db
          .query("postDatedCheques")
          .withIndex("by_org_status_and_chequeDate", (q) =>
            q.eq("orgId", args.orgId).eq("status", args.status!)
          )
          .order("asc")
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("postDatedCheques")
          .withIndex("by_org_chequeDate", (q) => q.eq("orgId", args.orgId))
          .order("asc")
          .paginate(args.paginationOpts);

    return {
      ...result,
      page: await Promise.all(result.page.map((row) => hydrateCheque(ctx, row))),
    };
  },
});

export const listPayments = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const result = await ctx.db
      .query("collectionPayments")
      .withIndex("by_org_paymentDate", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .paginate(args.paginationOpts);

    return {
      ...result,
      page: await Promise.all(result.page.map((row) => hydratePayment(ctx, row))),
    };
  },
});

/**
 * SCRUM-218-C — the retained customer credit an organization still owes back.
 *
 * ⚠️ THIS EXISTS BECAUSE THE LIABILITY WAS OTHERWISE UNREACHABLE (Codex R04).
 * `recordPayment` returns only the collection payment id and `listPayments`
 * exposes neither the movement nor the position, so `applyRetainedCredit` — which
 * needs a `receiptMovementId` — had no supported way for an operator to obtain
 * its own argument. A retained liability with no discoverable discharge path is
 * functionally the "ship A without C" outcome the owner refused, reached by a
 * different route. My own tests hid the gap by reading the movement id straight
 * out of the database, which is exactly why it stayed invisible.
 *
 * Reads positions rather than movements: a position exists only where credit was
 * actually retained, so "no row" and "drawn down to zero" stay distinguishable.
 * `VIEW_FINANCE` rather than `MANAGE_FINANCE` — seeing what the dealership owes
 * a customer is a reporting act; only applying it moves money.
 */
export const listRetainedCredits = query({
  args: {
    orgId: v.id("organizations"),
    customerId: v.optional(v.id("customers")),
    /**
     * Omit or pass false to include positions already drawn to zero.
     *
     * ⚠️ THIS FILTERS THE PAGE, NOT THE QUERY, so a page can come back shorter
     * than `numItems` — even empty — while `isDone` is still false. A caller
     * must loop on `continueCursor` / `isDone` and never treat
     * `page.length < numItems` as the end of the results. Filtering inside the
     * paginated range is the alternative and it is worse: it would make the
     * cursor's meaning depend on a boolean argument.
     */
    onlyRemaining: v.optional(v.boolean()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    // Tenant scoping is the INDEX, not a post-filter: both ranges are rooted at
    // this org, so a foreign row is unreachable rather than merely excluded.
    const result = args.customerId
      ? await ctx.db
          .query("receiptRetainedPositions")
          .withIndex("by_org_customer", (q) =>
            q.eq("orgId", args.orgId).eq("customerId", args.customerId!)
          )
          .order("desc")
          .paginate(args.paginationOpts)
      : await ctx.db
          .query("receiptRetainedPositions")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .order("desc")
          .paginate(args.paginationOpts);

    const page = await Promise.all(
      result.page.map(async (position) => {
        const movement = await ctx.db.get(position.receiptMovementId);
        const customer = await ctx.db.get(position.customerId);
        return {
          receiptMovementId: position.receiptMovementId,
          customerId: position.customerId,
          customerName: customer ? `${customer.firstName} ${customer.lastName}`.trim() : undefined,
          currency: position.currency,
          initialUnappliedMinor: position.initialUnappliedMinor,
          remainingUnappliedMinor: position.remainingUnappliedMinor,
          applicationCount: position.applicationCount,
          // Whether `applyRetainedCredit` would currently accept it. The receipt
          // must be POSTED, so a credit whose own journal is still queued behind
          // an unmapped 2110 is visible but explicitly not yet applicable —
          // rather than failing at the point of use with no explanation.
          receiptPosted:
            movement !== null &&
            (await findPostedReceiptOccurrence(
              ctx,
              rehydrateReceiptOccurrence({ orgId: args.orgId, snapshot: movement.occurrence })
            )) !== null,
          collectionPaymentId: movement?.collectionPaymentId,
          createdAt: movement?.createdAt,
        };
      })
    );

    return {
      ...result,
      page: args.onlyRemaining ? page.filter((p) => p.remainingUnappliedMinor > 0) : page,
    };
  },
});

export const createReceivable = mutation({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    quoteId: v.optional(v.id("quotes")),
    applicationId: v.optional(v.id("financeApplications")),
    assignedTo: v.optional(v.id("users")),
    sourceType: receivableSourceValidator,
    title: v.string(),
    amount: v.number(),
    dueDate: v.number(),
    notes: v.optional(v.string()),
    creditSystemKey: v.optional(receivableCreditKeyValidator),
  },
  handler: async (ctx, args) => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    assertPositiveAmount(args.amount);
    if (!args.title.trim()) throw new ConvexError("Receivable title is required.");
    const creditSystemKey = args.saleId
      ? undefined
      : resolveReceivableCreditKey(args.sourceType, args.creditSystemKey);

    await validateOrgCustomer(ctx, args.orgId, args.customerId);
    await validateOptionalLinks(ctx, args.orgId, args);

    const currency = await getOrgCurrency(ctx, args.orgId);
    const now = Date.now();
    const receivableId = await ctx.db.insert("receivables", {
      orgId: args.orgId,
      branchId: membership.branchId,
      customerId: args.customerId,
      vehicleId: args.vehicleId,
      saleId: args.saleId,
      quoteId: args.quoteId,
      applicationId: args.applicationId,
      assignedTo: args.assignedTo,
      sourceType: args.sourceType,
      title: args.title.trim(),
      originalAmount: roundMoney(args.amount, currency),
      outstandingAmount: roundMoney(args.amount, currency),
      dueDate: args.dueDate,
      status: args.dueDate < now ? "OVERDUE" : "OPEN",
      notes: args.notes,
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    });

    const receivable = await ctx.db.get(receivableId);
    if (receivable) {
      await ensureCanonicalReceivableForLegacy(ctx, receivable, user._id, currency);
    }

    // A sale-linked receivable's AR was already recognized by SALE_COMPLETED
    // at sale completion — posting a second origin entry here would double-book
    // it. Every other manual receivable (damage claims, ad-hoc charges, etc.)
    // has no prior GL recognition, so it needs its own DR AR / CR Other Income.
    if (creditSystemKey) {
      await hookReceivableCreated(ctx, {
        orgId: args.orgId,
        receivableId,
        customerId: args.customerId,
        amountMinor: toMinorUnits(roundMoney(args.amount, currency), currency),
        currency,
        actorId: user._id,
        occurredAt: now,
        creditSystemKey,
      });
    }

    const actorName = await getActorName(ctx);
    await notifyManagers(ctx, args.orgId, "collection.receivable_created", {
      actorName,
      amount: String(roundMoney(args.amount, currency)),
    }, { link: `/${args.orgId}/accounting` });

    return receivableId;
  },
});

export const createInstallmentPlan = mutation({
  args: {
    orgId: v.id("organizations"),
    customerId: v.id("customers"),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    quoteId: v.optional(v.id("quotes")),
    applicationId: v.optional(v.id("financeApplications")),
    assignedTo: v.optional(v.id("users")),
    title: v.string(),
    totalAmount: v.number(),
    installmentCount: v.number(),
    firstDueDate: v.number(),
    intervalMonths: v.optional(v.number()),
    sourceType: v.optional(receivableSourceValidator),
    notes: v.optional(v.string()),
    creditSystemKey: v.optional(receivableCreditKeyValidator),
  },
  handler: async (ctx, args) => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    assertPositiveAmount(args.totalAmount, "Total amount");
    if (!Number.isInteger(args.installmentCount) || args.installmentCount < 1 || args.installmentCount > 120) {
      throw new ConvexError("Installment count must be between 1 and 120.");
    }
    const intervalMonths = args.intervalMonths ?? 1;
    if (!Number.isInteger(intervalMonths) || intervalMonths < 1 || intervalMonths > 12) {
      throw new ConvexError("Installment interval must be between 1 and 12 months.");
    }
    if (!args.title.trim()) throw new ConvexError("Payment plan title is required.");
    const creditSystemKey = args.saleId
      ? undefined
      : resolveReceivableCreditKey(args.sourceType ?? "INTERNAL_INSTALLMENT", args.creditSystemKey);

    await validateOrgCustomer(ctx, args.orgId, args.customerId);
    await validateOptionalLinks(ctx, args.orgId, args);

    const currency = await getOrgCurrency(ctx, args.orgId);
    const now = Date.now();
    const baseAmount = roundMoney(args.totalAmount / args.installmentCount, currency);
    let allocated = 0;
    const ids: Id<"receivables">[] = [];

    for (let i = 1; i <= args.installmentCount; i++) {
      const amount = i === args.installmentCount
        ? roundMoney(args.totalAmount - allocated, currency)
        : baseAmount;
      allocated = roundMoney(allocated + amount, currency);
      const dueDate = addMonths(args.firstDueDate, (i - 1) * intervalMonths);
      const id = await ctx.db.insert("receivables", {
        orgId: args.orgId,
        branchId: membership.branchId,
        customerId: args.customerId,
        vehicleId: args.vehicleId,
        saleId: args.saleId,
        quoteId: args.quoteId,
        applicationId: args.applicationId,
        assignedTo: args.assignedTo,
        sourceType: args.sourceType ?? "INTERNAL_INSTALLMENT",
        title: `${args.title.trim()} #${i}`,
        originalAmount: amount,
        outstandingAmount: amount,
        dueDate,
        status: dueDate < now ? "OVERDUE" : "OPEN",
        installmentNumber: i,
        totalInstallments: args.installmentCount,
        paymentPlanLabel: args.title.trim(),
        notes: args.notes,
        createdBy: user._id,
        createdAt: now,
        updatedAt: now,
      });
      const receivable = await ctx.db.get(id);
      if (receivable) {
        await ensureCanonicalReceivableForLegacy(ctx, receivable, user._id, currency);
      }

      // Same reasoning as createReceivable: skip when sale-linked, since that
      // AR was already recognized by SALE_COMPLETED.
      if (creditSystemKey) {
        await hookReceivableCreated(ctx, {
          orgId: args.orgId,
          receivableId: id,
          customerId: args.customerId,
          amountMinor: toMinorUnits(amount, currency),
          currency,
          actorId: user._id,
          occurredAt: now,
          creditSystemKey,
        });
      }

      ids.push(id);
    }

    const actorName = await getActorName(ctx);
    await notifyManagers(ctx, args.orgId, "collection.plan_created", {
      actorName,
      amount: String(roundMoney(args.totalAmount, currency)),
    }, { link: `/${args.orgId}/accounting` });

    return ids;
  },
});

export const recordPayment = mutation({
  args: {
    orgId: v.id("organizations"),
    receivableId: v.optional(v.id("receivables")),
    customerId: v.optional(v.id("customers")),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    amount: v.number(),
    method: paymentMethodValidator,
    paymentDate: v.number(),
    reference: v.optional(v.string()),
    notes: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "collections.recordPayment",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
      },
      async () => {
        assertPositiveAmount(args.amount);
        if (args.method === "REFUND") throw new ConvexError("Refunds require manager approval.");
        if (args.method === "OTHER") {
          throw new ConvexError("Select a specific payment method — OTHER is not accepted for recording a payment.");
        }

        let receivable: Doc<"receivables"> | null = null;
        if (args.receivableId) {
          receivable = await ctx.db.get(args.receivableId);
          if (!receivable || receivable.orgId !== args.orgId) throw new ConvexError("Receivable not found.");
          if (["PAID", "CANCELLED", "REFUNDED"].includes(receivable.status)) {
            throw new ConvexError("This receivable can no longer accept payments.");
          }
          if (args.amount > receivable.outstandingAmount) {
            throw new ConvexError("Payment amount cannot exceed the outstanding receivable amount.");
          }
          // SCRUM-121A-PRE §3.1 — a contradictory caller identity is refused,
          // not silently discarded.
          //
          // The derivation below reads `receivable?.x ?? args.x`, so when the
          // caller named a DIFFERENT customer, vehicle or sale than the
          // receivable carries, the row quietly won and the caller's identity
          // vanished. `validateOptionalLinks` never closed this: it proves each
          // link exists and belongs to the org independently, and never that two
          // links describe the same debt. `registerChequeCore` already refuses
          // the same contradiction for the customer, so one file held both
          // answers.
          //
          // Only a genuine conflict refuses. A value the receivable does not
          // carry is not a contradiction, so caller-supplied links still fill
          // gaps exactly as before.
          if (args.customerId && args.customerId !== receivable.customerId) {
            throw new ConvexError("Payment customer does not match the receivable customer.");
          }
          if (args.vehicleId && receivable.vehicleId && args.vehicleId !== receivable.vehicleId) {
            throw new ConvexError("Payment vehicle does not match the receivable vehicle.");
          }
          if (args.saleId && receivable.saleId && args.saleId !== receivable.saleId) {
            throw new ConvexError("Payment sale does not match the receivable sale.");
          }
          // Forward guard (§3.3), unreachable today — see the identical note in
          // registerChequeCore. No production writer soft-deletes a receivable.
          if (receivable.isDeleted) {
            throw new ConvexError("This receivable has been removed and can no longer accept payments.");
          }
        }

        const customerId = receivable?.customerId ?? args.customerId;
        if (!customerId) throw new ConvexError("Customer is required when no receivable is selected.");
        await validateOrgCustomer(ctx, args.orgId, customerId);

        const vehicleId = receivable?.vehicleId ?? args.vehicleId;
        const saleId = receivable?.saleId ?? args.saleId;
        await validateOptionalLinks(ctx, args.orgId, { vehicleId, saleId });

        // SCRUM-121A-PRE §3.1 — a link the CALLER filled in may not contradict
        // what the selected debt already implies.
        //
        // Two shapes reach this. The no-receivable one is supported and tested,
        // and nothing correlated its links: customer A plus a sale belonging to
        // customer B stored cleanly, attributing the canonical payment to A
        // while every operational reader showed B's deal.
        //
        // The second was the cross-family seat's finding, and it is the same
        // defect one level indirect. The contradiction checks above compare
        // LIKE-NAMED fields, so they see nothing when the receivable carries no
        // sale of its own: the caller's sale contradicts no field, is derived,
        // and attaches another customer's deal to this debt. Same hole one field
        // over for a caller-filled vehicle against the sale the receivable does
        // name.
        //
        // A sale names both a customer and a vehicle, so it is the identifier
        // that can prove the others. Vehicle-only and customer-only ad-hoc
        // payments stay unconstrained — a vehicle does not imply a customer, and
        // requiring one would refuse legitimate counter takings.
        //
        // Deliberately NOT applied to a pair that came entirely FROM the
        // receivable row. `createReceivable` never correlated its own customer,
        // sale and vehicle either, so a row can already hold an inconsistent
        // triple; refusing there would block collection on rows that exist
        // today. That is a pre-existing defect at the creation door, and fixing
        // it is not this change's to make.
        const callerFilledSale = !receivable?.saleId && args.saleId !== undefined;
        const callerFilledVehicle = !receivable?.vehicleId && args.vehicleId !== undefined;
        if (saleId && (!receivable || callerFilledSale || callerFilledVehicle)) {
          const sale = await ctx.db.get(saleId);
          if (sale) {
            if (sale.customerId !== customerId) {
              throw new ConvexError("Payment sale belongs to a different customer.");
            }
            if (vehicleId && sale.vehicleId !== vehicleId) {
              throw new ConvexError("Payment sale is for a different vehicle.");
            }
          }
        }

        const currency = await getOrgCurrency(ctx, args.orgId);
        const now = Date.now();
        const paymentId = await ctx.db.insert("collectionPayments", {
          orgId: args.orgId,
          branchId: membership.branchId,
          receivableId: receivable?._id,
          customerId,
          vehicleId,
          saleId,
          direction: "IN",
          method: args.method,
          amount: roundMoney(args.amount, currency),
          paymentDate: args.paymentDate,
          status: "POSTED",
          idempotencyKey: args.idempotencyKey,
          reference: args.reference,
          cashierId: user._id,
          notes: args.notes,
          createdAt: now,
        });

        if (receivable) {
          await applyPostedPayment(ctx, receivable, args.amount, args.paymentDate, currency);
        }

        await insertLedgerTransaction(ctx, {
          orgId: args.orgId,
          direction: "IN",
          amount: roundMoney(args.amount, currency),
          date: args.paymentDate,
          description: `Collection payment${receivable ? ` for ${receivable.title}` : ""}`,
          vehicleId,
          userId: user._id,
          category: "COLLECTION_PAYMENT",
          idempotencyKey: args.idempotencyKey,
        });

        const payment = await ctx.db.get(paymentId);
        // Refuses rather than skips (SCRUM-218-C). The row was inserted a few
        // statements above in this same transaction, so this is unreachable —
        // but the previous `if (payment)` shape meant an absent row silently
        // produced a receipt with no canonical payment and therefore no movement
        // to seal, which is precisely the "operationally final, accounting
        // missing" state this ticket exists to make impossible.
        if (!payment) {
          throw new ConvexError("Collection payment could not be re-read within its own transaction.");
        }
        const mirrored = await mirrorCollectionPaymentToCanonical(ctx, {
          paymentId,
          payment,
          receivable,
          actorId: user._id,
          currency,
        });

        // SCRUM-236 — the single forward producer of this receipt occurrence.
        //
        // The identity is constructed HERE, inside this invocation, from this
        // invocation's own arguments, and is never held anywhere else. The
        // trust registry backing `directCollectionReceipt` is a module-private
        // WeakSet whose lifetime is the MODULE, not the mutation, so a cached
        // identity would stay trusted across later invocations in the same
        // isolate and let one of them address an occurrence it never earned
        // (owner-proxy c17641 requirement 1).
        //
        // ⚠️ NOTHING MAY CATCH THIS CALL. `paymentId` is the occurrence's own
        // `sourceId`, so the identity cannot exist before the insert above —
        // "refuse before writes" is structurally unavailable on the forward
        // path, and the guarantee is the other one c17641 requirement 3
        // allows: the refusal ESCAPES the mutation and Convex rolls the whole
        // attempt back. In Convex a CAUGHT exception commits the writes made
        // before it, so wrapping this in a try/catch would leave the payment
        // row, the ledger transaction and the canonical mirror committed while
        // the accounting refused — and report the refusal as handled.
        const receiptIdentity = directCollectionReceipt({ orgId: args.orgId, paymentId });

        // SCRUM-218-C — seal what this receipt WAS before anything posts.
        //
        // The split is derived inside `sealReceiptMovement` from the canonical
        // payment row and the exact allocation this transaction created, not
        // from `args.amount`. On this path over-receipt is refused above, so the
        // outcome is one of exactly two shapes: a receivable was named and fully
        // absorbed the money, or none was and the whole receipt is retained
        // customer credit.
        const { split } = await sealReceiptMovement(ctx, {
          identity: receiptIdentity,
          orgId: args.orgId,
          collectionPaymentId: paymentId,
          canonicalPaymentId: mirrored.canonicalPaymentId,
          customerId,
          currency,
          allocationIds: mirrored.paymentAllocationId ? [mirrored.paymentAllocationId] : [],
          actorId: user._id,
        });

        await postReceiptOccurrence(ctx, {
          identity: receiptIdentity,
          currency,
          occurredAt: args.paymentDate,
          actorId: user._id,
          // Only demanded when there is actually a residue to credit. A receipt
          // that fully discharges a receivable must not become unpostable just
          // because an org has no 2110 — it never needed one.
          requiredSystemKeys: split.unappliedMinor > 0 ? [RETAINED_CREDIT_SYSTEM_KEY] : [],
          payload: {
            paymentId: paymentId.toString(),
            receivedMinor: split.receivedMinor,
            appliedMinor: split.appliedMinor,
            unappliedMinor: split.unappliedMinor,
            currency,
            customerId: customerId.toString(),
            paymentMethod: args.method,
          },
        });

        const actorName = await getActorName(ctx);
        await notifyManagers(ctx, args.orgId, "collection.payment_recorded", {
          actorName,
          amount: String(roundMoney(args.amount, currency)),
        }, { link: `/${args.orgId}/accounting` });

        return paymentId;
      }
    );
  },
});

/**
 * SCRUM-218-C part C — apply retained customer credit to a receivable.
 *
 * DR 2110 Unapplied Customer Receipts / CR Customer AR. No cash moves: the money
 * arrived when the receipt posted. Without this operation the 2110 liability
 * created by a no-receivable receipt could never be discharged, which is why
 * owner-proxy `c17653` refused to ship the receipt-side split on its own.
 *
 * ## Exact retry vs. a genuine second application
 *
 * These are different events and the distinction is the caller's to state.
 * Applications #1, #2 and #3 against one receipt are three legitimate economic
 * occurrences, each with its own sequence, identity and journal. An exact RETRY
 * of #1 must produce one effect, and the way a client says "this is a retry" is
 * by replaying the same `idempotencyKey`. The `fingerprint` then makes that
 * claim checkable: the same key with materially different inputs is rejected
 * rather than silently returning the first result.
 *
 * Omitting the key means "this is a new application", which is the correct
 * default for an operator clicking Apply a second time on purpose.
 */
export const applyRetainedCredit = mutation({
  args: {
    orgId: v.id("organizations"),
    receiptMovementId: v.id("receiptMovements"),
    receivableId: v.id("receivables"),
    requestedAmount: v.number(),
    appliedAt: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    // ⚠️ BEFORE runWithIdempotency, AND BEFORE THE FIRST WRITE (Codex R01).
    //
    // `v.number()` admits NaN, ±Infinity and any finite double, including dates
    // outside the `Date` domain. Such a value matches no accounting period, so
    // the command ENQUEUES and every monetary write in this mutation COMMITS —
    // then the outbox drain throws `RangeError` formatting the date, retries,
    // and dead-letters. The money would have moved with no journal, and no
    // replay could repair it. Refusing here is the only point that helps.
    if (args.appliedAt !== undefined) {
      assertValidAccountingDate(args.appliedAt, "Application date");
    }
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "collections.applyRetainedCredit",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        // Every input that changes what money does. Replaying one key against a
        // different receipt, receivable or amount is a contradiction, not a
        // retry, and must not quietly return the first application's result.
        //
        // `appliedAt` is included because it selects the ACCOUNTING PERIOD, so
        // the same key with a different date is a different economic claim.
        // `null` — not `Date.now()` — encodes "omitted": folding in the server
        // clock would make every retry of an omitted-date call disagree with
        // itself and refuse a legitimate replay.
        fingerprint: JSON.stringify([
          args.receiptMovementId.toString(),
          args.receivableId.toString(),
          args.requestedAmount,
          args.appliedAt ?? null,
        ]),
      },
      async () => {
        assertPositiveAmount(args.requestedAmount);
        const currency = await getOrgCurrency(ctx, args.orgId);
        const appliedAt = args.appliedAt ?? Date.now();

        const movement = await ctx.db.get(args.receiptMovementId);
        if (!movement || movement.orgId !== args.orgId) {
          throw new ConvexError("Receipt movement not found.");
        }

        // Proves BOTH that the stored snapshot is structurally canonical (by
        // re-minting it through the sanctioned rehydration door) and that the
        // receipt's own journal is POSTED. Applying a credit whose receipt never
        // reached the ledger would relieve a receivable against a liability that
        // does not exist in the books.
        await requirePostedReceiptForMovement(ctx, movement);

        const position = await loadRetainedPosition(ctx, args.orgId, movement._id);

        const receivable = await ctx.db.get(args.receivableId);
        if (!receivable || receivable.orgId !== args.orgId) {
          throw new ConvexError("Receivable not found.");
        }
        if (["PAID", "CANCELLED", "REFUNDED"].includes(receivable.status)) {
          throw new ConvexError("This receivable can no longer accept payments.");
        }
        // Same customer — retained credit belongs to the person who overpaid, and
        // applying it to a different customer's debt would move money between
        // two parties' accounts with no transaction behind it.
        if (receivable.customerId !== movement.customerId) {
          throw new ConvexError("This retained credit belongs to a different customer.");
        }
        // Same currency. The position, the receipt and the org must agree; there
        // is no conversion here and silently treating minor units of one currency
        // as another would misstate the amount outright.
        if (movement.currency.toUpperCase() !== currency.toUpperCase()) {
          throw new ConvexError("This retained credit is held in a different currency.");
        }

        // Resolved BEFORE the cap is computed, deliberately.
        //
        // `allocatePaymentToReceivable` refuses — it throws, it does not clamp —
        // when the amount exceeds the CANONICAL document's outstanding balance,
        // while the operator sees the LEGACY receivable. Those two can drift.
        // Capping only on the legacy figure would turn that drift into a hard
        // failure of a legitimate application; capping on the lower of the two
        // caps instead, which is the same safe direction from either side.
        const receivableDocumentId = await ensureCanonicalReceivableForLegacy(
          ctx,
          receivable,
          user._id,
          currency
        );
        const canonicalOutstandingMinor = await getReceivableOutstandingMinor(ctx, receivableDocumentId);

        const amountMinor = computeApplicableMinor({
          requestedMinor: toMinorUnits(roundMoney(args.requestedAmount, currency), currency),
          remainingUnappliedMinor: position.remainingUnappliedMinor,
          outstandingMinor: Math.min(
            toMinorUnits(roundMoney(receivable.outstandingAmount, currency), currency),
            canonicalOutstandingMinor
          ),
        });
        if (amountMinor <= 0) {
          throw new ConvexError(
            "There is nothing to apply — the retained credit or the receivable's outstanding balance is already zero."
          );
        }
        const allocationId = await allocatePaymentToReceivable(ctx, {
          orgId: args.orgId,
          paymentId: movement.canonicalPaymentId,
          receivableDocumentId,
          amountMinor,
          actorId: user._id,
        });

        const { applicationId, sequence, idempotencyKey } = await recordRetainedApplication(ctx, {
          orgId: args.orgId,
          movement,
          position,
          receivableId: receivable._id,
          receivableDocumentId,
          allocationId,
          amountMinor,
          actorId: user._id,
        });

        await applyPostedPayment(
          ctx,
          receivable,
          fromMinorUnits(amountMinor, currency),
          appliedAt,
          currency
        );

        // ⚠️ NOTHING MAY CATCH THIS. As in `recordPayment`, a caught exception in
        // Convex COMMITS every write above it — the allocation, the application
        // row and the drawn-down position would survive while the journal
        // refused, leaving the credit spent with no accounting behind it.
        await hookReceiptCreditApplied(ctx, {
          orgId: args.orgId,
          sourceId: receiptApplicationSourceId(movement._id, sequence),
          idempotencyKey,
          receiptMovementId: movement._id.toString(),
          applicationId: applicationId.toString(),
          sequence,
          amountMinor,
          currency,
          customerId: movement.customerId.toString(),
          receivableDocumentId: receivableDocumentId.toString(),
          occurredAt: appliedAt,
          actorId: user._id,
        });

        return {
          applicationId,
          sequence,
          appliedMinor: amountMinor,
          remainingUnappliedMinor: position.remainingUnappliedMinor - amountMinor,
        };
      }
    );
  },
});

/**
 * Shared cheque-registration core, reused by the registerCheque mutation
 * (MANAGE_FINANCE-gated, for Collections) and applications.registerExpectedPayment
 * (REGISTER_EXPECTED_PAYMENT-gated, for the pre-finalize payment step) — each
 * caller does its own permission check before calling this.
 */
export async function registerChequeCore(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    receivableId?: Id<"receivables">;
    customerId: Id<"customers">;
    vehicleId?: Id<"vehicles">;
    saleId?: Id<"sales">;
    applicationId?: Id<"financeApplications">;
    bank: string;
    chequeNumber: string;
    chequeDate: number;
    amount: number;
    notes?: string;
    actorId: Id<"users">;
    branchId?: Id<"branches">;
  }
) {
  assertPositiveAmount(args.amount);
  if (!args.bank.trim() || !args.chequeNumber.trim()) {
    throw new ConvexError("Bank and cheque number are required.");
  }

  const chequeCustomer = await validateOrgCustomer(ctx, args.orgId, args.customerId);
  // SCRUM-121A-PRE §3.3 — no NEW financial instrument against a withdrawn
  // payer. Registering a cheque creates a future claim on someone the
  // dealership has already removed, and `customers.softDelete` permits the
  // withdrawal while money is still owed.
  //
  // This lives in the shared core rather than the public `registerCheque`
  // wrapper on purpose: `applications.registerExpectedPayment` reaches this
  // same function under its own permission, so a guard placed in the wrapper
  // would leave that door open while looking closed.
  if (chequeCustomer.isDeleted) {
    throw new ConvexError("This customer has been removed and cannot have new cheques registered.");
  }
  await validateOptionalLinks(ctx, args.orgId, {
    vehicleId: args.vehicleId,
    saleId: args.saleId,
    applicationId: args.applicationId,
  });

  let receivable: Doc<"receivables"> | null = null;
  if (args.receivableId) {
    receivable = await ctx.db.get(args.receivableId);
    if (!receivable || receivable.orgId !== args.orgId) throw new ConvexError("Receivable not found.");
    if (receivable.customerId !== args.customerId) throw new ConvexError("Cheque customer must match receivable customer.");
    // SCRUM-121A-PRE §3.3 — a settled or voided debt cannot be given a new
    // instrument. This door checked organization and customer but never status,
    // so a cheque could be registered against a PAID, CANCELLED or REFUNDED
    // receivable and then CLEARED — and clearing runs `applyPostedPayment`,
    // which reopens the closed row. That is a pre-funds REGISTRATION refusal
    // and moves no money: it prevents the instrument that would later resurrect
    // the debt, rather than refusing a cheque that has already cleared.
    if (["PAID", "CANCELLED", "REFUNDED"].includes(receivable.status)) {
      throw new ConvexError("This receivable is closed and cannot accept a new cheque.");
    }
    // Forward guard, and labelled as one: no production WRITER sets
    // `isDeleted` on a receivable today, so this cannot be reached through the
    // real doors. It is here because the field exists on the row and the
    // calendar reader at :562 already honours it, so the first writer that
    // appears must not find the money paths silently accepting a withdrawn
    // target.
    //
    // Not unreachable by the SUITE, though: `D10` constructs the state directly
    // and exercises both this and its twin in recordPayment, so a mutation here
    // is killed rather than surviving as dead code.
    if (receivable.isDeleted) {
      throw new ConvexError("This receivable has been removed and cannot accept a new cheque.");
    }
    if (args.vehicleId && receivable.vehicleId && args.vehicleId !== receivable.vehicleId) {
      throw new ConvexError("Cheque vehicle does not match the receivable vehicle.");
    }
    if (args.saleId && receivable.saleId && args.saleId !== receivable.saleId) {
      throw new ConvexError("Cheque sale does not match the receivable sale.");
    }
  }

  const existingCheques = await ctx.db
    .query("postDatedCheques")
    .withIndex("by_org_bank_and_chequeNumber", (q) =>
      q.eq("orgId", args.orgId).eq("bank", args.bank.trim()).eq("chequeNumber", args.chequeNumber.trim())
    )
    .collect();
  const hasActiveDuplicate = existingCheques.some((c) => !c.isDeleted && c.status !== "CANCELLED");
  if (hasActiveDuplicate) {
    throw new ConvexError("A cheque with this bank and number already exists.");
  }

  const currency = await getOrgCurrency(ctx, args.orgId);
  const now = Date.now();
  return await ctx.db.insert("postDatedCheques", {
    orgId: args.orgId,
    branchId: args.branchId,
    receivableId: receivable?._id,
    customerId: args.customerId,
    vehicleId: receivable?.vehicleId ?? args.vehicleId,
    saleId: receivable?.saleId ?? args.saleId,
    applicationId: args.applicationId,
    bank: args.bank.trim(),
    chequeNumber: args.chequeNumber.trim(),
    chequeDate: args.chequeDate,
    amount: roundMoney(args.amount, currency),
    status: "HELD",
    notes: args.notes,
    createdBy: args.actorId,
    createdAt: now,
    updatedAt: now,
  });
}

export const registerCheque = mutation({
  args: {
    orgId: v.id("organizations"),
    receivableId: v.optional(v.id("receivables")),
    customerId: v.id("customers"),
    vehicleId: v.optional(v.id("vehicles")),
    saleId: v.optional(v.id("sales")),
    bank: v.string(),
    chequeNumber: v.string(),
    chequeDate: v.number(),
    amount: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    return await registerChequeCore(ctx, { ...args, actorId: user._id, branchId: membership.branchId });
  },
});

export const depositCheque = mutation({
  args: {
    orgId: v.id("organizations"),
    chequeId: v.id("postDatedCheques"),
    depositedDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const cheque = await ctx.db.get(args.chequeId);
    if (!cheque || cheque.orgId !== args.orgId) throw new ConvexError("Cheque not found.");
    if (cheque.status !== "HELD") throw new ConvexError("Only held cheques can be deposited.");
    await ctx.db.patch(args.chequeId, {
      status: "DEPOSITED",
      depositedDate: args.depositedDate ?? Date.now(),
      updatedAt: Date.now(),
    });
  },
});

/**
 * Shared state-transition core for marking a cheque CLEARED — used both by
 * the ordinary `clearCheque` mutation (legacy collections/GL flow below) and
 * by `applications.confirmDisbursement` (canonical finance-company flow),
 * which needs to transition an application-linked cheque without any of the
 * legacy collectionPayments/GL posting clearCheque does afterward.
 */
export async function markChequeClearedCore(
  ctx: MutationCtx,
  args: { orgId: Id<"organizations">; chequeId: Id<"postDatedCheques">; clearedAt?: number; idempotencyKey?: string }
): Promise<Doc<"postDatedCheques">> {
  const cheque = await ctx.db.get(args.chequeId);
  if (!cheque || cheque.orgId !== args.orgId || cheque.isDeleted) throw new ConvexError("Cheque not found.");
  if (cheque.status !== "HELD" && cheque.status !== "DEPOSITED") {
    throw new ConvexError("Only held or deposited cheques can be cleared.");
  }

  const clearedAt = args.clearedAt ?? Date.now();
  const patch: Partial<Doc<"postDatedCheques">> = {
    status: "CLEARED",
    clearedAt,
    depositedDate: cheque.depositedDate ?? clearedAt,
    updatedAt: Date.now(),
  };
  if (args.idempotencyKey !== undefined) patch.idempotencyKey = args.idempotencyKey;
  await ctx.db.patch(args.chequeId, patch);

  return { ...cheque, ...patch };
}

export const clearCheque = mutation({
  args: {
    orgId: v.id("organizations"),
    chequeId: v.id("postDatedCheques"),
    clearedAt: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "collections.clearCheque",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({ chequeId: args.chequeId, clearedAt: args.clearedAt ?? null }),
      },
      async () => {
        const currency = await getOrgCurrency(ctx, args.orgId);
        const existingCheque = await ctx.db.get(args.chequeId);
        if (!existingCheque || existingCheque.orgId !== args.orgId || existingCheque.isDeleted) {
          throw new ConvexError("Cheque not found.");
        }
        if (existingCheque.applicationId) {
          throw new ConvexError(
            `This cheque belongs to finance application ${existingCheque.applicationId} — confirm disbursement from the Applications page instead.`
          );
        }

        const cheque = await markChequeClearedCore(ctx, {
          orgId: args.orgId,
          chequeId: args.chequeId,
          clearedAt: args.clearedAt,
          idempotencyKey: args.idempotencyKey,
        });
        const clearedAt = cheque.clearedAt!;

        let receivable: Doc<"receivables"> | null = null;
        if (cheque.receivableId) {
          receivable = await ctx.db.get(cheque.receivableId);
          if (receivable && cheque.amount > receivable.outstandingAmount) {
            throw new ConvexError("Cheque amount cannot exceed the outstanding receivable amount.");
          }
        }

        const paymentId = await ctx.db.insert("collectionPayments", {
          orgId: args.orgId,
          branchId: membership.branchId,
          receivableId: cheque.receivableId,
          customerId: cheque.customerId,
          vehicleId: cheque.vehicleId,
          saleId: cheque.saleId,
          chequeId: args.chequeId,
          direction: "IN",
          method: "CHEQUE",
          amount: cheque.amount,
          paymentDate: clearedAt,
          status: "POSTED",
          idempotencyKey: args.idempotencyKey,
          reference: `${cheque.bank} #${cheque.chequeNumber}`,
          cashierId: user._id,
          createdAt: Date.now(),
        });

        if (receivable) {
          await applyPostedPayment(ctx, receivable, cheque.amount, clearedAt, currency);
        }

        await insertLedgerTransaction(ctx, {
          orgId: args.orgId,
          direction: "IN",
          amount: cheque.amount,
          date: clearedAt,
          description: `Cleared cheque ${cheque.bank} #${cheque.chequeNumber}`,
          vehicleId: cheque.vehicleId,
          userId: user._id,
          category: "COLLECTION_PAYMENT",
          idempotencyKey: args.idempotencyKey,
        });

        // Post to the GL: a cleared cheque deposits funds into the bank, and
        // that money either settles a receivable or becomes retained customer
        // credit (DR Bank / CR AR and/or CR 2110 — SCRUM-218-C). Booked as a
        // COLLECTION_PAYMENT so the return-after-clearing flow can reverse it by
        // its source event. Posts now, or enqueues to the outbox if the chart /
        // period is not yet set up.
        //
        // A cheque may carry no receivable — `cheque.receivableId` is optional
        // and guarded everywhere in this file — so this path reaches the
        // no-receivable shape exactly as `recordPayment` does.
        const payment = await ctx.db.get(paymentId);
        if (!payment) {
          throw new ConvexError("Collection payment could not be re-read within its own transaction.");
        }
        const mirrored = await mirrorCollectionPaymentToCanonical(ctx, {
          paymentId,
          payment,
          receivable,
          actorId: user._id,
          currency,
        });

        // SCRUM-236 — same single forward producer as `recordPayment`. See the
        // note there: identity built inside this invocation, never cached, and
        // this call must not be caught, because its refusal is only safe if it
        // escapes the mutation and rolls back the writes above.
        //
        // `paymentMethod: "BANK_TRANSFER"` is carried over unchanged from the
        // retired hook call. A cleared cheque deposits into the bank, so the
        // posting rule must resolve the bank account and not the cash account;
        // this is the existing production behavior and SCRUM-236 does not
        // change it.
        const receiptIdentity = directCollectionReceipt({ orgId: args.orgId, paymentId });

        // SCRUM-218-C — identical sealing to `recordPayment`; see the note there.
        const { split } = await sealReceiptMovement(ctx, {
          identity: receiptIdentity,
          orgId: args.orgId,
          collectionPaymentId: paymentId,
          canonicalPaymentId: mirrored.canonicalPaymentId,
          customerId: cheque.customerId,
          currency,
          allocationIds: mirrored.paymentAllocationId ? [mirrored.paymentAllocationId] : [],
          actorId: user._id,
        });

        await postReceiptOccurrence(ctx, {
          identity: receiptIdentity,
          currency,
          occurredAt: clearedAt,
          actorId: user._id,
          requiredSystemKeys: split.unappliedMinor > 0 ? [RETAINED_CREDIT_SYSTEM_KEY] : [],
          payload: {
            paymentId: paymentId.toString(),
            receivedMinor: split.receivedMinor,
            appliedMinor: split.appliedMinor,
            unappliedMinor: split.unappliedMinor,
            currency,
            customerId: cheque.customerId.toString(),
            paymentMethod: "BANK_TRANSFER",
          },
        });

        return paymentId;
      }
    );
  },
});

export const returnCheque = mutation({
  args: {
    orgId: v.id("organizations"),
    chequeId: v.id("postDatedCheques"),
    returnedAt: v.optional(v.number()),
    returnReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const cheque = await ctx.db.get(args.chequeId);
    if (!cheque || cheque.orgId !== args.orgId) throw new ConvexError("Cheque not found.");
    if (cheque.status === "CLEARED" || cheque.status === "REPLACED" || cheque.status === "CANCELLED") {
      throw new ConvexError("This cheque can no longer be returned.");
    }

    await ctx.db.patch(args.chequeId, {
      status: "RETURNED",
      returnedAt: args.returnedAt ?? Date.now(),
      returnReason: args.returnReason,
      updatedAt: Date.now(),
    });

    if (cheque.receivableId) {
      const receivable = await ctx.db.get(cheque.receivableId);
      if (receivable && receivable.status !== "PAID") {
        await ctx.db.patch(receivable._id, { status: "OVERDUE", updatedAt: Date.now() });
        await queueCustomerReminder(ctx, {
          orgId: args.orgId,
          customerId: cheque.customerId,
          receivableId: receivable._id,
          chequeId: cheque._id,
          messageType: "CHEQUE_RETURNED",
        });
      }
    }

    const actorName = await getActorName(ctx);
    await notifyManagers(ctx, args.orgId, "collection.cheque_returned", {
      actorName,
      amount: String(cheque.amount),
    }, { link: `/${args.orgId}/accounting` });
  },
});

export const replaceCheque = mutation({
  args: {
    orgId: v.id("organizations"),
    chequeId: v.id("postDatedCheques"),
    bank: v.string(),
    chequeNumber: v.string(),
    chequeDate: v.number(),
    amount: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    assertPositiveAmount(args.amount);
    const oldCheque = await ctx.db.get(args.chequeId);
    if (!oldCheque || oldCheque.orgId !== args.orgId) throw new ConvexError("Cheque not found.");
    if (oldCheque.status === "CLEARED" || oldCheque.status === "CANCELLED") {
      throw new ConvexError("Cleared or cancelled cheques cannot be replaced.");
    }

    const currency = await getOrgCurrency(ctx, args.orgId);
    const now = Date.now();
    const newChequeId = await ctx.db.insert("postDatedCheques", {
      orgId: args.orgId,
      branchId: membership.branchId,
      receivableId: oldCheque.receivableId,
      customerId: oldCheque.customerId,
      vehicleId: oldCheque.vehicleId,
      saleId: oldCheque.saleId,
      // Transfers rather than copies — an application's expected-payment
      // cheque must stay a 1:1 link so confirmDisbursement's lookup by
      // applicationId keeps resolving to exactly one (the active) cheque.
      applicationId: oldCheque.applicationId,
      bank: args.bank.trim(),
      chequeNumber: args.chequeNumber.trim(),
      chequeDate: args.chequeDate,
      amount: roundMoney(args.amount, currency),
      status: "HELD",
      notes: args.notes,
      createdBy: user._id,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.patch(args.chequeId, {
      status: "REPLACED",
      replacementChequeId: newChequeId,
      applicationId: undefined,
      updatedAt: now,
    });

    return newChequeId;
  },
});

/**
 * Returns a cheque that has already been CLEARED by the bank.
 * Reverses the original clearing accounting event, reopens the receivable
 * balance, and optionally records a bank return fee.
 */
export const returnClearedCheque = mutation({
  args: {
    orgId: v.id("organizations"),
    chequeId: v.id("postDatedCheques"),
    returnReason: v.optional(v.string()),
    bankFeeMinor: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    if (
      args.bankFeeMinor !== undefined &&
      (!Number.isSafeInteger(args.bankFeeMinor) || args.bankFeeMinor < 0)
    ) {
      throw new ConvexError("Bank fee must be a non-negative integer minor-unit amount.");
    }

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "collections.returnClearedCheque",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          chequeId: args.chequeId,
          bankFeeMinor: args.bankFeeMinor ?? 0,
          returnReason: args.returnReason ?? null,
        }),
      },
      async () => {
        const cheque = await ctx.db.get(args.chequeId);
        if (!cheque || cheque.orgId !== args.orgId) throw new ConvexError("Cheque not found.");
        if (cheque.status !== "CLEARED") {
          throw new ConvexError("Only cleared cheques can be returned after clearing.");
        }

        const now = Date.now();

        // Find the collection payment created when this cheque cleared
        const clearedPayment = await ctx.db
          .query("collectionPayments")
          .withIndex("by_cheque", (q) => q.eq("chequeId", args.chequeId))
          .filter((q) => q.eq(q.field("status"), "POSTED"))
          .first();

        // 🔴 SCRUM-218-C / review RM-01 — REFUSE RATHER THAN SILENTLY MISSTATE 2110.
        //
        // This handler reverses the clearing event and reopens the cheque's own
        // receivable. It knows nothing about retained credit. So when a
        // no-receivable cheque created a retained position and that credit was
        // already applied to a DIFFERENT receivable, returning the cheque
        // reverses the full CR 2110 while the application's DR 2110 stands:
        //
        //     CR 2110  100000   original clearing
        //     DR 2110   40000   retained credit applied elsewhere
        //     DR 2110  100000   cheque-return reversal
        //     ------------------------------------------------
        //     net       40000 DEBIT on a LIABILITY control account
        //
        // and the other receivable stays PAID on money the bank took back. A
        // reviewer reproduced exactly those numbers against this code.
        //
        // Unwinding an application — reopening the right receivable, reversing
        // the RECEIPT_CREDIT_APPLIED journal, restoring the position, and
        // deciding which application to reverse when the amounts differ — is
        // SCRUM-130's charter, not this ticket's. Refusing converts a silent,
        // signal-free corruption into a visible stop an accountant can act on,
        // and it follows the convention this file already sets: a
        // partially-refunded cleared cheque likewise cannot be auto-returned.
        //
        // Placed BEFORE the first write. Everything above is a read.
        if (clearedPayment) {
          const movement = await ctx.db
            .query("receiptMovements")
            .withIndex("by_org_payment", (q) =>
              q.eq("orgId", args.orgId).eq("collectionPaymentId", clearedPayment._id)
            )
            .unique();
          if (movement) {
            const position = await ctx.db
              .query("receiptRetainedPositions")
              .withIndex("by_org_movement", (q) =>
                q.eq("orgId", args.orgId).eq("receiptMovementId", movement._id)
              )
              .unique();
            if (position && position.applicationCount > 0) {
              throw new ConvexError(
                "This cheque's retained customer credit has already been applied to another receivable, " +
                  "so returning it automatically would leave the customer-credit liability misstated. " +
                  "Reverse the applied credit in Accounting first."
              );
            }
          }
        }

        // Reverse the GL impact of the original clearing.
        if (clearedPayment) {
          const clearingEvent = await ctx.db
            .query("accountingEvents")
            .withIndex("by_org_source", (q) =>
              q.eq("orgId", args.orgId)
                .eq("sourceType", "collectionPayments")
                .eq("sourceId", clearedPayment._id.toString())
            )
            .filter((q) => q.eq(q.field("status"), "POSTED"))
            .first();

          if (clearingEvent) {
            const reversalIdempotencyKey = `cheque_return_after_clear_${args.chequeId}`;
            const period = await getOpenPeriodForDate(ctx, args.orgId, now);
            if (period) {
              await reverseAccountingEvent(ctx, {
                orgId: args.orgId,
                originalEventId: clearingEvent._id,
                reversalDate: now,
                reason: args.returnReason ?? "Cheque returned after clearing",
                actorId: user._id,
                idempotencyKey: reversalIdempotencyKey,
              });
            } else {
              // No open period — defer the reversal so it is never silently lost.
              await enqueuePendingReversal(ctx, {
                orgId: args.orgId,
                originalEventId: clearingEvent._id,
                reversalDate: now,
                reason: args.returnReason ?? "Cheque returned after clearing",
                actorId: user._id,
                idempotencyKey: reversalIdempotencyKey,
                sourceType: "collectionPayments",
                sourceId: clearedPayment._id.toString(),
              });
            }
          } else {
            // The clearing GL post may still be sitting unposted in the outbox
            // (cleared before a chart/period existed). Cancel it so it never
            // posts — the net effect of clear-then-return is zero.
            await cancelPendingPostByKey(ctx, args.orgId, `collection_payment_${clearedPayment._id}`);
          }

          if (clearedPayment.paymentAllocationId) {
            await reverseAllocation(ctx, {
              orgId: args.orgId,
              allocationId: clearedPayment.paymentAllocationId,
              actorId: user._id,
            });
          }
          if (clearedPayment.canonicalPaymentId) {
            await ctx.db.patch(clearedPayment.canonicalPaymentId, { status: "VOIDED" });
          }

          // Mark the payment as voided
          await ctx.db.patch(clearedPayment._id, { status: "VOIDED" });
        }

        // Reopen the linked legacy receivable
        if (cheque.receivableId) {
          const receivable = await ctx.db.get(cheque.receivableId);
          if (receivable) {
            await ctx.db.patch(receivable._id, {
              outstandingAmount: (receivable.outstandingAmount ?? 0) + cheque.amount,
              status: "OVERDUE",
              updatedAt: now,
            });
          }
        }

        // Post bank fee as expense if provided. Convert minor→major units with
        // the central currency-aware helper (the old `JOD ? 3 : 2` was wrong for
        // KWD/BHD/OMR/JPY) and route it through the posting engine so it hits the
        // GL (DR General Expenses / CR Bank) instead of only the legacy tables.
        if (args.bankFeeMinor && args.bankFeeMinor > 0) {
          const currency = await getOrgCurrency(ctx, args.orgId);
          const feeAmount = fromMinorUnits(args.bankFeeMinor, currency);
          const feeExpenseId = await ctx.db.insert("expenses", {
            orgId: args.orgId,
            title: `Bank return fee — cheque ${cheque.bank} #${cheque.chequeNumber}`,
            amount: feeAmount,
            date: now,
            category: "FEES",
            status: "PAID",
          });
          await ctx.db.insert("transactions", {
            orgId: args.orgId,
            type: "OUT",
            amount: feeAmount,
            date: now,
            category: "EXPENSE",
            description: `Bank return fee — cheque ${cheque.bank} #${cheque.chequeNumber}`,
            expenseId: feeExpenseId,
          });
          await hookExpensePosted(ctx, {
            orgId: args.orgId,
            expenseId: feeExpenseId,
            amountMinor: args.bankFeeMinor,
            currency,
            category: "FEES",
            paymentMethod: "BANK_TRANSFER",
            actorId: user._id,
            occurredAt: now,
          });
        }

        // Mark cheque as RETURNED (after clearing)
        await ctx.db.patch(args.chequeId, {
          status: "RETURNED",
          returnedAt: now,
          returnReason: args.returnReason,
          returnedAfterClearing: true,
          bankFeeMinor: args.bankFeeMinor,
          updatedAt: now,
        });

        const actorName = await getActorName(ctx);
        await notifyManagers(ctx, args.orgId, "collection.cheque_returned", {
          actorName,
          amount: String(cheque.amount),
        }, { link: `/${args.orgId}/accounting` });
      }
    );
  },
});

const disbursementMethodValidator = v.union(
  v.literal("CASH"),
  v.literal("BANK_TRANSFER"),
  v.literal("CHEQUE"),
  v.literal("CARD")
);

export const requestApproval = mutation({
  args: {
    orgId: v.id("organizations"),
    receivableId: v.id("receivables"),
    requestType: approvalRequestTypeValidator,
    requestedAmount: v.optional(v.number()),
    requestedDueDate: v.optional(v.number()),
    disbursementMethod: v.optional(disbursementMethodValidator),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const receivable = await ctx.db.get(args.receivableId);
    if (!receivable || receivable.orgId !== args.orgId) throw new ConvexError("Receivable not found.");
    if (!args.reason.trim()) throw new ConvexError("Reason is required.");
    if (args.requestType === "REFUND") {
      assertPositiveAmount(args.requestedAmount ?? 0, "Refund amount");
      if (!args.disbursementMethod) throw new ConvexError("Disbursement method is required for refund requests.");
      // Refund eligibility is derived as originalAmount - outstandingAmount.
      // Cancelling a receivable zeroes outstandingAmount, which makes a written
      // -off, never-collected receivable indistinguishable from a fully paid
      // one — so a refund against it would disburse real cash and post a GL
      // refund for money that was never received. Blocked here and again at
      // approval time, so neither gate alone is load-bearing.
      assertRefundableReceivableStatus(receivable.status);
    }
    if (args.requestType === "RESCHEDULE" && !args.requestedDueDate) {
      throw new ConvexError("New due date is required for reschedule requests.");
    }

    const existing = await ctx.db
      .query("collectionApprovalRequests")
      .withIndex("by_receivable", (q) => q.eq("receivableId", args.receivableId))
      .collect();
    if (existing.some((request) => request.status === "PENDING" && request.requestType === args.requestType)) {
      throw new ConvexError("A pending request of this type already exists.");
    }

    const currency = await getOrgCurrency(ctx, args.orgId);
    const now = Date.now();
    const requestId = await ctx.db.insert("collectionApprovalRequests", {
      orgId: args.orgId,
      receivableId: args.receivableId,
      customerId: receivable.customerId,
      requestedBy: user._id,
      requestType: args.requestType,
      status: "PENDING",
      requestedAmount: args.requestedAmount ? roundMoney(args.requestedAmount, currency) : undefined,
      requestedDueDate: args.requestedDueDate,
      disbursementMethod: args.requestType === "REFUND" ? args.disbursementMethod : undefined,
      reason: args.reason.trim(),
      createdAt: now,
      updatedAt: now,
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(ctx, args.orgId, "collection.approval_requested", {
      actorName,
      amount: String(args.requestedAmount ?? receivable.outstandingAmount),
    }, { link: `/${args.orgId}/accounting` });

    return requestId;
  },
});

export const listApprovals = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(v.union(v.literal("PENDING"), v.literal("APPROVED"), v.literal("REJECTED"))),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);
    const status = args.status ?? "PENDING";
    const requests = await ctx.db
      .query("collectionApprovalRequests")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
      .order("desc")
      .take(100);

    return await Promise.all(requests.map(async (request) => {
      const [receivable, customer, requester] = await Promise.all([
        ctx.db.get(request.receivableId),
        ctx.db.get(request.customerId),
        ctx.db.get(request.requestedBy),
      ]);
      return {
        ...request,
        receivableTitle: receivable?.title ?? "Receivable",
        customerName: customerName(customer),
        requestedByName: requester?.name ?? requester?.email ?? "Unknown",
      };
    }));
  },
});

export const respondToApproval = mutation({
  args: {
    orgId: v.id("organizations"),
    requestId: v.id("collectionApprovalRequests"),
    status: v.union(v.literal("APPROVED"), v.literal("REJECTED")),
    decisionNotes: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "collections.respondToApproval",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
      },
      async () => {
        const request = await ctx.db.get(args.requestId);
        if (!request || request.orgId !== args.orgId) throw new ConvexError("Approval request not found.");
        if (request.status !== "PENDING") throw new ConvexError("This request has already been resolved.");
        assertDifferentActors(
          user._id,
          request.requestedBy,
          "Requester cannot approve or reject their own collection approval request."
        );

        const receivable = await ctx.db.get(request.receivableId);
        if (!receivable || receivable.orgId !== args.orgId) throw new ConvexError("Receivable not found.");

        const currency = await getOrgCurrency(ctx, args.orgId);
        const now = Date.now();
        await ctx.db.patch(args.requestId, {
          status: args.status,
          decisionNotes: args.decisionNotes,
          decidedBy: user._id,
          decidedAt: now,
          responseIdempotencyKey: args.idempotencyKey,
          updatedAt: now,
        });

        if (args.status === "APPROVED") {
          if (request.requestType === "RESCHEDULE") {
            if (!request.requestedDueDate) throw new ConvexError("Requested due date is missing.");
            await ctx.db.patch(receivable._id, {
              dueDate: request.requestedDueDate,
              status: request.requestedDueDate < now ? "OVERDUE" : "RESCHEDULED",
              updatedAt: now,
            });
            // Keep the canonical receivable document in step with the legacy
            // row — aging and dunning read the canonical dueDate.
            const rescheduledDocId = await ensureCanonicalReceivableForLegacy(
              ctx,
              receivable,
              user._id,
              currency
            );
            await ctx.db.patch(rescheduledDocId, { dueDate: request.requestedDueDate });
          } else if (request.requestType === "CANCEL_RECEIVABLE") {
            // Block if any payments have already been collected: cancelling a
            // financially-recognised receivable without a reversal GL event
            // leaves the subledger in an inconsistent state. Use the Refund
            // path to return collected funds first, then cancel.
            const paidAmount = roundMoney(receivable.originalAmount - receivable.outstandingAmount, currency);
            if (paidAmount > 0) {
              throw new ConvexError(
                "Cannot cancel a receivable that has already received payments. " +
                "Issue a refund for the collected amount first, then cancel."
              );
            }
            // Block if a post-dated cheque in HELD or DEPOSITED state is
            // linked to this receivable. Cancelling the receivable would leave
            // an active financial instrument with nowhere to post when cleared.
            const heldCheque = await ctx.db
              .query("postDatedCheques")
              .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "HELD"))
              .filter((q) => q.eq(q.field("receivableId"), receivable._id))
              .first();
            const depositedCheque = !heldCheque
              ? await ctx.db
                  .query("postDatedCheques")
                  .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "DEPOSITED"))
                  .filter((q) => q.eq(q.field("receivableId"), receivable._id))
                  .first()
              : null;
            if (heldCheque || depositedCheque) {
              throw new ConvexError(
                "Cannot cancel a receivable with an active cheque (HELD or DEPOSITED). " +
                "Return or cancel the cheque first, then cancel the receivable."
              );
            }
            // SCRUM-121A-PRE §5.1 — the canonical gate, evaluated before this
            // branch writes anything.
            //
            // The `paidAmount` check above is KEPT, not replaced: it asks a
            // different question, about the legacy row's own balance. It cannot
            // see a canonical allocation, because a document-only payment intent
            // never runs the legacy mirror — that mirror requires a
            // `receivableId` — so an intent settled against the canonical
            // document leaves `paidAmount` at zero while the subledger holds a
            // live allocation. That is a reachable CANCELLED + ACTIVE through
            // public mutations only, which is why the gate is here and not a
            // stronger version of the legacy check.
            const existingCanonical = await findCanonicalReceivableForLegacy(ctx, receivable);
            if (existingCanonical) {
              await assertNoActiveAllocations(ctx, existingCanonical._id);
            }

            await ctx.db.patch(receivable._id, {
              outstandingAmount: 0,
              status: "CANCELLED",
              updatedAt: now,
            });
            const cancelledDocId = await ensureCanonicalReceivableForLegacy(
              ctx,
              receivable,
              user._id,
              currency
            );
            // SCRUM-121A-PRE §5.2 — cancel WITH the metadata, atomically.
            //
            // Patching `status` alone left `cancelledAt` undefined, and
            // `getReceivablesAsOf` excludes a cancelled document only when
            // `cancelledAt <= asOfDate`. A document with no `cancelledAt` is
            // therefore included at EVERY asOfDate, permanently — so this
            // transition reversed the GL while `arAging` went on counting the
            // debt at full value forever. `saleCancellation.ts` already writes
            // all four fields; this makes the second writer agree with it.
            //
            // The reason is never stored empty: the approver's notes when they
            // wrote any, otherwise the requester's mandatory reason.
            const cancellationReason = args.decisionNotes?.trim() || request.reason;
            await ctx.db.patch(cancelledDocId, {
              status: "CANCELLED",
              cancelledAt: now,
              cancelledBy: user._id,
              cancellationReason,
            });
            // Reverse the RECEIVABLE_CREATED entry (or cancel its pending post)
            // so AR and the credit account it hit (income/deposit liability/
            // expense reimbursement) don't stay overstated once the receivable
            // is gone operationally. No-op for sale-linked receivables, which
            // never post a RECEIVABLE_CREATED event in the first place.
            await hookReceivableCancelled(ctx, {
              orgId: args.orgId,
              receivableId: receivable._id,
              reason: args.decisionNotes ?? "Receivable cancelled",
              actorId: user._id,
              reversalDate: now,
            });
          } else if (request.requestType === "REFUND") {
            const refundAmount = roundMoney(request.requestedAmount ?? 0, currency);
            assertPositiveAmount(refundAmount, "Refund amount");
            // Re-checked at approval time, not just at request time: the
            // receivable can be cancelled while a refund request sits PENDING,
            // and paidAmount below would then read the full original amount as
            // "collected". See assertRefundableReceivableStatus.
            assertRefundableReceivableStatus(receivable.status);
            const paidAmount = roundMoney(receivable.originalAmount - receivable.outstandingAmount, currency);
            if (refundAmount > paidAmount) throw new ConvexError("Refund amount cannot exceed collected amount.");

            // Use the method captured at request time so the GL entry posts to
            // the correct cash account (bank vs. cash on hand vs. cheque).
            if (!request.disbursementMethod) {
              throw new ConvexError(
                "This legacy refund request has no disbursement method. Reject it and submit a new request."
              );
            }
            const refundDisbursementMethod = request.disbursementMethod;

            const refundPaymentId = await ctx.db.insert("collectionPayments", {
              orgId: args.orgId,
              branchId: membership.branchId,
              receivableId: receivable._id,
              customerId: receivable.customerId,
              vehicleId: receivable.vehicleId,
              saleId: receivable.saleId,
              direction: "OUT",
              method: refundDisbursementMethod,
              amount: refundAmount,
              paymentDate: now,
              status: "POSTED",
              idempotencyKey: args.idempotencyKey,
              reference: `Refund approval ${args.requestId}`,
              cashierId: user._id,
              notes: args.decisionNotes,
              createdAt: now,
            });

            const refundPayment = await ctx.db.get(refundPaymentId);
            const canonicalReceivableDocumentId = await ensureCanonicalReceivableForLegacy(
              ctx,
              receivable,
              user._id,
              currency
            );
            if (refundPayment) {
              await mirrorCollectionPaymentToCanonical(ctx, {
                paymentId: refundPaymentId,
                payment: refundPayment,
                receivable,
                actorId: user._id,
                currency,
              });
            }

            // Unwind the original collections so the canonical receivable
            // reopens by exactly the refunded amount — without this the
            // canonical doc stays PAID while the legacy row shows a balance.
            const refundAmountMinor = toMinorUnits(refundAmount, currency);
            await reverseAllocationsForRefund(ctx, {
              orgId: args.orgId,
              receivableDocumentId: canonicalReceivableDocumentId,
              amountMinor: refundAmountMinor,
              actorId: user._id,
            });

            const newOutstanding = roundMoney(receivable.outstandingAmount + refundAmount, currency);
            await ctx.db.patch(receivable._id, {
              outstandingAmount: newOutstanding,
              status: refundAmount >= paidAmount ? "REFUNDED" : nextStatus(newOutstanding, receivable.dueDate),
              updatedAt: now,
            });

            await insertLedgerTransaction(ctx, {
              orgId: args.orgId,
              direction: "OUT",
              amount: refundAmount,
              date: now,
              description: `Refund for ${receivable.title}`,
              vehicleId: receivable.vehicleId,
              userId: user._id,
              category: "REFUND",
              idempotencyKey: args.idempotencyKey,
            });

            await hookCollectionRefund(ctx, {
              orgId: args.orgId,
              paymentId: refundPaymentId,
              customerId: receivable.customerId,
              amountMinor: refundAmountMinor,
              currency,
              paymentMethod: refundDisbursementMethod,
              actorId: user._id,
              occurredAt: now,
            });
          }
        }

        await notifyUser(ctx, args.orgId, request.requestedBy, "collection.approval_responded", {
          status: args.status,
          amount: String(request.requestedAmount ?? receivable.outstandingAmount),
        }, { link: `/${args.orgId}/accounting` });

        return args.requestId;
      }
    );
  },
});

export const getReconciliationDraft = query({
  args: {
    orgId: v.id("organizations"),
    businessDate: v.number(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const currency = await getOrgCurrency(ctx, args.orgId);
    const { start, end } = dayRange(args.businessDate);
    const payments = await ctx.db
      .query("collectionPayments")
      .withIndex("by_org_cashier", (q) => q.eq("orgId", args.orgId).eq("cashierId", user._id))
      .take(500);
    const cashPayments = payments.filter(
      (payment) =>
        !payment.reconciliationId &&
        payment.status === "POSTED" &&
        payment.paymentDate >= start &&
        payment.paymentDate <= end &&
        (payment.method === "CASH" || payment.method === "REFUND")
    );
    const expectedCash = cashPayments.reduce(
      (sum, payment) => sum + (payment.direction === "IN" ? payment.amount : -payment.amount),
      0
    );
    return {
      businessDate: start,
      expectedCash: roundMoney(expectedCash, currency),
      paymentCount: cashPayments.length,
    };
  },
});

export const submitCashierReconciliation = mutation({
  args: {
    orgId: v.id("organizations"),
    businessDate: v.number(),
    countedCash: v.number(),
    notes: v.optional(v.string()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "collections.submitCashierReconciliation",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
      },
      async () => {
        if (!Number.isFinite(args.countedCash) || args.countedCash < 0) {
          throw new ConvexError("Counted cash must be zero or greater.");
        }
        const currency = await getOrgCurrency(ctx, args.orgId);
        const { start, end } = dayRange(args.businessDate);
        const payments = await ctx.db
          .query("collectionPayments")
          .withIndex("by_org_cashier", (q) => q.eq("orgId", args.orgId).eq("cashierId", user._id))
          .take(500);
        const cashPayments = payments.filter(
          (payment) =>
            !payment.reconciliationId &&
            payment.status === "POSTED" &&
            payment.paymentDate >= start &&
            payment.paymentDate <= end &&
            (payment.method === "CASH" || payment.method === "REFUND")
        );
        const expectedCash = roundMoney(cashPayments.reduce(
          (sum, payment) => sum + (payment.direction === "IN" ? payment.amount : -payment.amount),
          0
        ), currency);
        const countedCash = roundMoney(args.countedCash, currency);
        const now = Date.now();
        const reconciliationId = await ctx.db.insert("cashierReconciliations", {
          orgId: args.orgId,
          branchId: membership.branchId,
          cashierId: user._id,
          businessDate: start,
          expectedCash,
          countedCash,
          difference: roundMoney(countedCash - expectedCash, currency),
          status: "SUBMITTED",
          idempotencyKey: args.idempotencyKey,
          notes: args.notes,
          createdAt: now,
          updatedAt: now,
        });

        for (const payment of cashPayments) {
          await ctx.db.patch(payment._id, { reconciliationId });
        }

        const actorName = await getActorName(ctx);
        await notifyManagers(ctx, args.orgId, "collection.reconciliation_submitted", {
          actorName,
          amount: String(countedCash),
        }, { link: `/${args.orgId}/accounting` });

        return reconciliationId;
      }
    );
  },
});

export const listReconciliations = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const rows = await ctx.db
      .query("cashierReconciliations")
      .withIndex("by_org_businessDate", (q) => q.eq("orgId", args.orgId))
      .order("desc")
      .take(50);
    return await Promise.all(rows.map(async (row) => {
      const cashier = await ctx.db.get(row.cashierId);
      return {
        ...row,
        cashierName: cashier?.name ?? cashier?.email ?? "Unknown",
      };
    }));
  },
});

export const reviewCashierReconciliation = mutation({
  args: {
    orgId: v.id("organizations"),
    reconciliationId: v.id("cashierReconciliations"),
    status: v.union(v.literal("APPROVED"), v.literal("REJECTED")),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);
    const reconciliation = await ctx.db.get(args.reconciliationId);
    if (!reconciliation || reconciliation.orgId !== args.orgId) throw new ConvexError("Reconciliation not found.");
    if (reconciliation.status !== "SUBMITTED") throw new ConvexError("Only submitted reconciliations can be reviewed.");
    assertDifferentActors(
      user._id,
      reconciliation.cashierId,
      "Cashier cannot approve or reject their own reconciliation."
    );
    await ctx.db.patch(args.reconciliationId, {
      status: args.status,
      notes: args.notes ?? reconciliation.notes,
      reviewedBy: user._id,
      reviewedAt: Date.now(),
      updatedAt: Date.now(),
    });
  },
});

export const dailyCollectionList = query({
  args: {
    orgId: v.id("organizations"),
    businessDate: v.number(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const currency = await getOrgCurrency(ctx, args.orgId);
    const { start, end } = dayRange(args.businessDate);
    const payments = await ctx.db
      .query("collectionPayments")
      .withIndex("by_org_paymentDate", (q) => q.eq("orgId", args.orgId).gte("paymentDate", start))
      .take(500);
    const rows = payments.filter((payment) => payment.paymentDate <= end && payment.status === "POSTED");
    const totalsByMethod: Record<string, number> = {};
    for (const payment of rows) {
      totalsByMethod[payment.method] = roundMoney(
        (totalsByMethod[payment.method] ?? 0) + (payment.direction === "IN" ? payment.amount : -payment.amount),
        currency
      );
    }
    return {
      totalsByMethod,
      total: roundMoney(Object.values(totalsByMethod).reduce((sum, amount) => sum + amount, 0), currency),
      rows: await Promise.all(rows.map((payment) => hydratePayment(ctx, payment))),
    };
  },
});

export const upcomingChequeReport = query({
  args: {
    orgId: v.id("organizations"),
    startDate: v.number(),
    endDate: v.number(),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const currency = await getOrgCurrency(ctx, args.orgId);
    const cheques = await ctx.db
      .query("postDatedCheques")
      .withIndex("by_org_chequeDate", (q) => q.eq("orgId", args.orgId).gte("chequeDate", args.startDate))
      .take(500);
    const rows = cheques.filter(
      (cheque) =>
        cheque.chequeDate <= args.endDate &&
        (cheque.status === "HELD" || cheque.status === "DEPOSITED")
    );
    return {
      total: roundMoney(rows.reduce((sum, cheque) => sum + cheque.amount, 0), currency),
      rows: await Promise.all(rows.map((cheque) => hydrateCheque(ctx, cheque))),
    };
  },
});

export const agingReport = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const currency = await getOrgCurrency(ctx, args.orgId);
    const now = Date.now();
    const statuses: ReceivableStatus[] = ["OPEN", "PARTIALLY_PAID", "OVERDUE", "RESCHEDULED"];
    const buckets = {
      current: { count: 0, amount: 0 },
      days1To30: { count: 0, amount: 0 },
      days31To60: { count: 0, amount: 0 },
      days61To90: { count: 0, amount: 0 },
      over90: { count: 0, amount: 0 },
    };

    for (const status of statuses) {
      const rows = await ctx.db
        .query("receivables")
        .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", status))
        .take(500);
      for (const row of rows) {
        const ageDays = Math.floor((now - row.dueDate) / DAY_MS);
        const bucket = ageDays <= 0
          ? buckets.current
          : ageDays <= 30
            ? buckets.days1To30
            : ageDays <= 60
              ? buckets.days31To60
              : ageDays <= 90
                ? buckets.days61To90
                : buckets.over90;
        bucket.count += 1;
        bucket.amount = roundMoney(bucket.amount + row.outstandingAmount, currency);
      }
    }

    return buckets;
  },
});

async function hasRecentReminder(
  ctx: MutationCtx,
  args: {
    receivableId?: Id<"receivables">;
    chequeId?: Id<"postDatedCheques">;
    messageType: ReminderMessageType;
    since: number;
  }
) {
  const rows = args.receivableId
    ? await ctx.db
        .query("collectionReminders")
        .withIndex("by_receivable", (q) => q.eq("receivableId", args.receivableId))
        .collect()
    : args.chequeId
      ? await ctx.db
          .query("collectionReminders")
          .withIndex("by_cheque", (q) => q.eq("chequeId", args.chequeId))
          .collect()
      : [];
  return rows.some(
    (row) =>
      row.messageType === args.messageType &&
      row.createdAt >= args.since &&
      (row.status === "PENDING" || row.status === "SENT" || row.status === "SKIPPED")
  );
}

async function queueCustomerReminder(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    customerId: Id<"customers">;
    receivableId?: Id<"receivables">;
    chequeId?: Id<"postDatedCheques">;
    messageType: ReminderMessageType;
  }
) {
  const customer = await ctx.db.get(args.customerId);
  const channel: ReminderChannel = customer?.whatsapp ? "WHATSAPP" : customer?.phone ? "SMS" : "MANUAL";
  const now = Date.now();
  if (await hasRecentReminder(ctx, { ...args, since: now - REMINDER_COOLDOWN_MS })) {
    return null;
  }
  const reminderId = await ctx.db.insert("collectionReminders", {
    orgId: args.orgId,
    customerId: args.customerId,
    receivableId: args.receivableId,
    chequeId: args.chequeId,
    channel,
    messageType: args.messageType,
    status: channel === "MANUAL" ? "SKIPPED" : "PENDING",
    scheduledAt: now,
    error: channel === "MANUAL" ? "No customer phone or WhatsApp number on file." : undefined,
    createdAt: now,
  });
  if (channel !== "MANUAL") {
    await ctx.scheduler.runAfter(0, internal.collectionReminderActions.sendCollectionReminder, { reminderId });
  }
  return reminderId;
}

/** Organizations processed per scheduled continuation of the reminder cron. */
const REMINDER_ORG_BATCH_SIZE = 50;

export const processDailyCollectionReminders = internalMutation({
  // `cursor` is supplied by this mutation's own scheduled continuation; the
  // cron itself invokes it with no arguments.
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const dueSoonLimit = now + 2 * DAY_MS;
    const chequeLimit = now + 3 * DAY_MS;

    // Was `.take(200)`. Convex's default order is ascending _creationTime, so
    // that processed the same OLDEST 200 organizations every single day and
    // silently skipped every tenant created after them — their receivables
    // never flipped to OVERDUE and no customer reminder was ever sent, with no
    // error to notice. Paginate across scheduled continuations instead, the
    // same shape changelog.broadcastNewEntry already uses for org fan-out.
    const page = await ctx.db
      .query("organizations")
      .paginate({ cursor: args.cursor ?? null, numItems: REMINDER_ORG_BATCH_SIZE });
    const organizations = page.page;
    let queued = 0;
    let markedOverdue = 0;

    for (const org of organizations) {
      const activeStatuses: ReceivableStatus[] = ["OPEN", "PARTIALLY_PAID", "RESCHEDULED"];
      for (const status of activeStatuses) {
        const overdue = await ctx.db
          .query("receivables")
          .withIndex("by_org_status_and_dueDate", (q) =>
            q.eq("orgId", org._id).eq("status", status).lte("dueDate", now)
          )
          .take(100);
        for (const receivable of overdue) {
          await ctx.db.patch(receivable._id, { status: "OVERDUE", updatedAt: now });
          const reminderId = await queueCustomerReminder(ctx, {
            orgId: org._id,
            customerId: receivable.customerId,
            receivableId: receivable._id,
            messageType: "OVERDUE",
          });
          if (reminderId) queued++;
          markedOverdue++;
        }

        const dueSoon = await ctx.db
          .query("receivables")
          .withIndex("by_org_status_and_dueDate", (q) =>
            q.eq("orgId", org._id).eq("status", status).gte("dueDate", now)
          )
          .take(100);
        for (const receivable of dueSoon.filter((row) => row.dueDate <= dueSoonLimit)) {
          const reminderId = await queueCustomerReminder(ctx, {
            orgId: org._id,
            customerId: receivable.customerId,
            receivableId: receivable._id,
            messageType: "DUE_SOON",
          });
          if (reminderId) queued++;
        }
      }

      const cheques = await ctx.db
        .query("postDatedCheques")
        .withIndex("by_org_status_and_chequeDate", (q) =>
          q.eq("orgId", org._id).eq("status", "HELD").gte("chequeDate", now)
        )
        .take(100);
      for (const cheque of cheques.filter((row) => row.chequeDate <= chequeLimit)) {
        const reminderId = await queueCustomerReminder(ctx, {
          orgId: org._id,
          customerId: cheque.customerId,
          chequeId: cheque._id,
          receivableId: cheque.receivableId,
          messageType: "CHEQUE_UPCOMING",
        });
        if (reminderId) queued++;
      }
    }

    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.collections.processDailyCollectionReminders, {
        cursor: page.continueCursor,
      });
    }

    return { queued, markedOverdue, isDone: page.isDone };
  },
});

export const getReminderPayload = internalQuery({
  args: { reminderId: v.id("collectionReminders") },
  handler: async (ctx, args) => {
    const reminder = await ctx.db.get(args.reminderId);
    if (!reminder) return null;
    const [customer, receivable, cheque, currency] = await Promise.all([
      ctx.db.get(reminder.customerId),
      reminder.receivableId ? ctx.db.get(reminder.receivableId) : null,
      reminder.chequeId ? ctx.db.get(reminder.chequeId) : null,
      getOrgCurrency(ctx, reminder.orgId),
    ]);
    return { reminder, customer, receivable, cheque, currency };
  },
});

export const markReminderResult = internalMutation({
  args: {
    reminderId: v.id("collectionReminders"),
    status: v.union(v.literal("SENT"), v.literal("FAILED"), v.literal("SKIPPED")),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: Partial<Pick<Doc<"collectionReminders">, "status" | "error" | "sentAt">> = {
      status: args.status,
      error: args.error,
    };
    if (args.status === "SENT") patch.sentAt = Date.now();
    await ctx.db.patch(args.reminderId, patch);
  },
});
