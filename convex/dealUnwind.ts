/**
 * SCRUM-693: unwind an already-paid finance deal from the deal page.
 *
 * A CLOSED v2 deal whose finance-company remittance was received by bank
 * transfer or cash reaches CANCELLED only through one server-owned
 * `dealUnwinds` record, in three steps: start, record the forward the financier
 * returned, then record the remittance refund and close the deal. Every money
 * leg is evidenced, and its reversal is proven POSTED (not queued) in an OPEN
 * period. The last step reverses the receipt and runs the existing closed-deal
 * teardown in one transaction, so a teardown refusal leaves nothing refunded.
 * While the record is ACTIVE, `assertNoActiveDealUnwind` keeps every other
 * command from moving the deal's money around it.
 *
 * Design: E:/tmp/scrum693-design.md. Rulings: Jira SCRUM-693 c22112 (v1),
 * c22118 (v2, D1-D6) and c22129 (ruling B: refund and close are one step). D3
 * (inspection hold) and D6 (redacted projection) ship in PR B; the deal-page
 * dialog ships in PR C.
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { AppErrorCode, throwAppError } from "./utils/errors";
import { DEAL_UNWIND_MESSAGES, type DealUnwindRefusalCode } from "./utils/dealUnwindMessages";
import { activeDealUnwindFor, paidDealReversalRoute, receiptPostedToPaymentAccount } from "./utils/dealUnwindGuard";
import { notifyManagers, getActorName } from "./utils/notifications";
import { runWithIdempotency } from "./utils/idempotency";
import { planVersionOf } from "./utils/financedSalePostingPlan";
import { deriveForwardState, forwardCancelRefusal } from "./utils/financeCompanyForward";
import { reverseForward } from "./financeCompanyForward";
import { disbursementVersionOf, financeDisbursementKeys } from "./utils/financeDisbursementKeys";
import { loadCustodyRecords } from "./utils/settlementDeductions";
import { assertNoPendingDepositRequest } from "./utils/depositRequestGuards";
import { manualPayerOf } from "./utils/manualFinancePayer";
import { MAX_DIRECT_PAYMENT_REFERENCE_CHARS } from "./utils/feeDocLimits";
import { getOpenPeriodForDate } from "./accountingPeriods";
import { hookFinanceCashReceivedReturned } from "./accounting/workflowHooks";
import { reverseAllocation, voidCanonicalPayment } from "./subledger";
import { auditLog } from "./financialAudit";
import {
  FINANCE_APP_RECEIVABLE_SOURCE,
  cancelClosedApplicationTeardown,
  closeOutCancelledApplication,
  resolveLinkedChequesForCancellation,
} from "./applications";

const REASON_MAX_CHARS = 500;
/** A client clock a little ahead of the server's is not a future date. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

const START_PERMS = [
  PERMISSIONS.CANCEL_CLOSED_DEAL,
  PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
  PERMISSIONS.VIEW_FINANCE,
];
const MONEY_STEP_PERMS = [PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT, PERMISSIONS.VIEW_FINANCE];
/** Refunding the remittance (MONEY_STEP_PERMS) and cancelling the deal, together. */
const FINISH_PERMS = [
  PERMISSIONS.CANCEL_CLOSED_DEAL,
  PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
  PERMISSIONS.VIEW_FINANCE,
];
const ABANDON_PERMS = [PERMISSIONS.CANCEL_CLOSED_DEAL];

function refuse(code: DealUnwindRefusalCode): never {
  throwAppError(AppErrorCode[code], DEAL_UNWIND_MESSAGES[code]);
}

function requiredText(raw: string, max: number, blankCode: DealUnwindRefusalCode): string {
  const text = raw.trim();
  if (text === "") refuse(blankCode);
  if (text.length > max) refuse("DEAL_UNWIND_TEXT_TOO_LONG");
  return text;
}

function pastDate(value: number, now: number, notBefore?: number): number {
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    value > now + CLOCK_SKEW_MS ||
    (notBefore !== undefined && value < notBefore)
  ) {
    refuse("DEAL_UNWIND_INVALID_DATE");
  }
  return value;
}

/** D4: the reversals post now, so today's period must be OPEN — CLOSING is not enough. */
async function assertPeriodOpen(ctx: QueryCtx, orgId: Id<"organizations">, now: number): Promise<void> {
  if ((await getOpenPeriodForDate(ctx, orgId, now)) === null) refuse("DEAL_UNWIND_PERIOD_NOT_OPEN");
}

/** A missing row and another organisation's row answer identically. */
async function loadOwnedApplication(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  applicationId: Id<"financeApplications">
): Promise<Doc<"financeApplications">> {
  const app = await ctx.db.get(applicationId);
  if (!app || app.orgId !== orgId) refuse("DEAL_UNWIND_NOT_FOUND");
  return app;
}

async function loadActiveUnwind(
  ctx: QueryCtx,
  orgId: Id<"organizations">,
  unwindId: Id<"dealUnwinds">
): Promise<{ unwind: Doc<"dealUnwinds">; app: Doc<"financeApplications"> }> {
  const unwind = await ctx.db.get(unwindId);
  if (!unwind || unwind.orgId !== orgId) refuse("DEAL_UNWIND_NOT_FOUND");
  if (unwind.status !== "ACTIVE") refuse("DEAL_UNWIND_NOT_ACTIVE");
  const app = await loadOwnedApplication(ctx, orgId, unwind.applicationId);
  return { unwind, app };
}

/**
 * The STRONG proof that one disbursement's FINANCE_CASH_RECEIVED is gone from
 * the books, unlike `isFinanceCashReceivedUndone`, which also passes on a
 * reversal that is only queued (PENDING). Either:
 *  - REVERSED: every event at the exact tuple is REVERSED, each by a POSTED
 *    reversal that links back to it under this version's reversal key; or
 *  - NOT_POSTED: no event ever existed and no POST is still queued for it (D5).
 * Anything else is null, and the caller fails closed.
 */
export async function isFinanceCashReceivedReversalPosted(
  ctx: QueryCtx,
  args: { orgId: Id<"organizations">; applicationId: Id<"financeApplications">; disbursementVersion: number }
): Promise<"REVERSED" | "NOT_POSTED" | null> {
  const keys = financeDisbursementKeys(args.applicationId, args.disbursementVersion);
  const events = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_event_source_version", (q) =>
      q
        .eq("orgId", args.orgId)
        .eq("eventType", "FINANCE_CASH_RECEIVED")
        .eq("sourceType", "financeApplications")
        .eq("sourceId", keys.sourceId)
        .eq("eventVersion", keys.eventVersion)
    )
    .collect();

  if (events.length === 0) {
    const queued = await ctx.db
      .query("pendingAccountingEvents")
      .withIndex("by_org_idempotency", (q) => q.eq("orgId", args.orgId).eq("idempotencyKey", keys.pendingPostKey))
      .unique();
    return queued === null || queued.kind !== "POST" ? "NOT_POSTED" : null;
  }

  for (const event of events) {
    if (event.status !== "REVERSED" || event.reversedByEventId === undefined) return null;
    const linked = await ctx.db.get(event.reversedByEventId);
    if (
      linked === null ||
      linked.orgId !== args.orgId ||
      linked.status !== "POSTED" ||
      linked.reversalOfEventId !== event._id ||
      linked.idempotencyKey !== keys.reversalKey
    ) {
      return null;
    }
  }
  return "REVERSED";
}

/**
 * The refusals both start and finish ask of the deal and its sale. The two
 * money steps run between them, so start sees a disbursed deal and finish one
 * whose remittance has been refunded.
 */
async function assertDealUnwindable(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  action: string
): Promise<Doc<"sales">> {
  if (app.status !== "CLOSED" || planVersionOf(app) !== 2) refuse("DEAL_UNWIND_NOT_ELIGIBLE");
  if (app.supplierDisbursementConfirmedAt !== undefined || app.supplierDisbursedAmountMinor !== undefined) {
    refuse("DEAL_UNWIND_DIRECT_ROUTE");
  }
  const sale = app.finalizedSaleId ? await ctx.db.get(app.finalizedSaleId) : null;
  if (!sale || sale.orgId !== app.orgId || sale.status !== "COMPLETED") refuse("DEAL_UNWIND_SALE_NOT_COMPLETED");
  // D1: paid commission cannot be recovered here yet; an unpaid one is reversed by the teardown.
  if (sale.commissionPaidAt !== undefined) refuse("DEAL_UNWIND_COMMISSION_PAID");

  const openCustody = (await loadCustodyRecords(ctx, app._id, action)).find((row) => row.status === "OPEN");
  if (openCustody) refuse("DEAL_UNWIND_OPEN_CUSTODY");
  return sale;
}

export const startDealUnwind = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, START_PERMS);
    const reason = requiredText(args.reason, REASON_MAX_CHARS, "DEAL_UNWIND_REASON_REQUIRED");
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "dealUnwind.startDealUnwind",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({ applicationId: args.applicationId, reason }),
      },
      async () => {
        const app = await loadOwnedApplication(ctx, args.orgId, args.applicationId);
        if ((await activeDealUnwindFor(ctx, args.orgId, app._id)) !== null) refuse("DEAL_UNWIND_ALREADY_ACTIVE");
        if (app.disbursedAt === undefined || app.disbursedAmountMinor === undefined) refuse("DEAL_UNWIND_NOT_ELIGIBLE");

        // A cheque deal reverses through the existing returned-cheque path.
        const route = await paidDealReversalRoute(ctx, app);
        if (route.route === "CHEQUE") refuse("DEAL_UNWIND_CHEQUE_DEAL");
        const sale = await assertDealUnwindable(ctx, app, "unwinding this deal");
        await assertNoPendingDepositRequest(ctx, { orgId: args.orgId, quoteId: app.quoteId, action: "unwind this deal" });
        if (route.route === "CHAIN_MISMATCH") refuse("DEAL_UNWIND_CHAIN_MISMATCH");
        if (route.route === "INELIGIBLE") refuse("DEAL_UNWIND_NOT_ELIGIBLE");
        const { method } = route;
        const version = disbursementVersionOf(app);

        const now = Date.now();
        const unwindId = await ctx.db.insert("dealUnwinds", {
          orgId: args.orgId,
          applicationId: app._id,
          saleId: sale._id,
          status: "ACTIVE",
          reason,
          startedBy: user._id,
          startedAt: now,
          remittanceVersion: version,
          remittanceMinor: app.disbursedAmountMinor,
          remittanceMethod: method,
          forwardDueMinor: app.financeCompanyForwardDueMinor ?? 0,
          createdAt: now,
          updatedAt: now,
        });
        await auditLog(ctx, {
          orgId: args.orgId,
          actorId: user._id,
          actionType: "DEAL_UNWIND_STARTED",
          resourceType: "financeApplications",
          resourceId: app._id,
          description: `Deal unwind started: ${reason}`,
          after: {
            unwindId,
            saleId: sale._id,
            remittanceVersion: version,
            remittanceMinor: app.disbursedAmountMinor,
            remittanceMethod: method,
          },
          idempotencyKey: args.idempotencyKey,
        });
        return unwindId;
      }
    );
  },
});

export const recordDealUnwindForwardReturn = mutation({
  args: {
    orgId: v.id("organizations"),
    unwindId: v.id("dealUnwinds"),
    returnedAt: v.number(),
    reference: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, MONEY_STEP_PERMS);
    const reference = requiredText(args.reference, MAX_DIRECT_PAYMENT_REFERENCE_CHARS, "DEAL_UNWIND_EVIDENCE_REQUIRED");
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "dealUnwind.recordDealUnwindForwardReturn",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({ unwindId: args.unwindId, returnedAt: args.returnedAt, reference }),
      },
      async () => {
        const { unwind, app } = await loadActiveUnwind(ctx, args.orgId, args.unwindId);
        if (unwind.forwardReturn !== undefined) refuse("DEAL_UNWIND_STEP_DONE");
        const now = Date.now();
        const returnedAt = pastDate(args.returnedAt, now);

        let proof = await deriveForwardState(ctx, app);
        if (!proof.applies) refuse("DEAL_UNWIND_FORWARD_NOT_APPLICABLE");

        let forwardId: Id<"financeCompanyForwards"> | undefined;
        if (proof.onBooksForwardId !== null) {
          // The payment is on the books: report it returned now and prove the
          // reversal POSTED. A throw rolls back the report.
          await assertPeriodOpen(ctx, args.orgId, now);
          forwardId = await reverseForward(
            ctx,
            {
              orgId: args.orgId,
              applicationId: app._id,
              forwardId: proof.onBooksForwardId,
              reason: `Deal unwind: returned by the finance company (${reference})`,
              kind: "RETURNED",
              actorId: user._id,
            },
            app
          );
          proof = await deriveForwardState(ctx, app);
          const version = proof.versions.find((row) => row.forwardId === forwardId);
          if (version?.state !== "RETURNED") refuse("DEAL_UNWIND_FORWARD_REVERSAL_UNPROVEN");
        } else {
          // Already reported returned through the existing button: record the
          // evidence only, and only when that return is posted.
          const returned = proof.versions.filter((row) => row.state === "RETURNED");
          if (returned.length === 0) refuse("DEAL_UNWIND_FORWARD_UNSETTLED");
          forwardId = returned[returned.length - 1].forwardId;
        }
        if (forwardCancelRefusal(proof) !== null) refuse("DEAL_UNWIND_FORWARD_UNSETTLED");

        await ctx.db.patch(unwind._id, {
          forwardReturn: { forwardId, returnedAt, reference, recordedBy: user._id, recordedAt: now },
          updatedAt: now,
        });
        await auditLog(ctx, {
          orgId: args.orgId,
          actorId: user._id,
          actionType: "DEAL_UNWIND_FORWARD_RETURNED",
          resourceType: "financeApplications",
          resourceId: app._id,
          description: `Deal unwind: the finance company returned the forwarded payment (${reference})`,
          after: { unwindId: unwind._id, forwardId, returnedAt, forwardState: proof.state },
          idempotencyKey: args.idempotencyKey,
        });
        return { unwindId: unwind._id, forwardId };
      }
    );
  },
});

/**
 * Sol ruling B (SCRUM-693 c22129): "record refund and close deal" is ONE
 * transaction. It reverses the receipt, voids its payment, runs the existing
 * closed-deal teardown, cancels the application and completes the unwind.
 * Every refusal - including one the teardown raises after the receipt writes -
 * throws out of the mutation, so all of them roll back together and no
 * refunded-but-still-sold state can exist. Until it succeeds the unwind may
 * still be abandoned.
 */
export const finishDealUnwind = mutation({
  args: {
    orgId: v.id("organizations"),
    unwindId: v.id("dealUnwinds"),
    method: v.union(v.literal("BANK_TRANSFER"), v.literal("CASH")),
    refundedAt: v.number(),
    bankReference: v.optional(v.string()),
    voucherNumber: v.optional(v.string()),
    recipientAcknowledged: v.optional(v.boolean()),
    creditNoteReference: v.string(),
    vehicleReturnedAt: v.number(),
    vehicleReturnNote: v.string(),
    customerPaymentDisposition: v.union(v.literal("REFUND"), v.literal("RETAIN_CREDIT")),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, FINISH_PERMS);
    let evidence: { bankReference?: string; voucherNumber?: string; recipientAcknowledged?: boolean };
    if (args.method === "BANK_TRANSFER") {
      evidence = {
        bankReference: requiredText(args.bankReference ?? "", MAX_DIRECT_PAYMENT_REFERENCE_CHARS, "DEAL_UNWIND_EVIDENCE_REQUIRED"),
      };
    } else {
      if (args.recipientAcknowledged !== true) refuse("DEAL_UNWIND_EVIDENCE_REQUIRED");
      evidence = {
        voucherNumber: requiredText(args.voucherNumber ?? "", MAX_DIRECT_PAYMENT_REFERENCE_CHARS, "DEAL_UNWIND_EVIDENCE_REQUIRED"),
        recipientAcknowledged: true,
      };
    }
    const creditNoteReference = requiredText(
      args.creditNoteReference,
      MAX_DIRECT_PAYMENT_REFERENCE_CHARS,
      "DEAL_UNWIND_DISPOSITION_REQUIRED"
    );
    const vehicleReturnNote = requiredText(args.vehicleReturnNote, REASON_MAX_CHARS, "DEAL_UNWIND_DISPOSITION_REQUIRED");
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "dealUnwind.finishDealUnwind",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          unwindId: args.unwindId,
          method: args.method,
          refundedAt: args.refundedAt,
          ...evidence,
          creditNoteReference,
          vehicleReturnedAt: args.vehicleReturnedAt,
          vehicleReturnNote,
          customerPaymentDisposition: args.customerPaymentDisposition,
        }),
      },
      async () => {
        const { unwind, app } = await loadActiveUnwind(ctx, args.orgId, args.unwindId);
        const now = Date.now();
        const vehicleReturnedAt = pastDate(args.vehicleReturnedAt, now);

        // The same refusals cancelApplication asks of a CLOSED deal, in its order.
        await assertNoPendingDepositRequest(ctx, { orgId: args.orgId, quoteId: app.quoteId, action: "finish this unwind" });
        const sale = await assertDealUnwindable(ctx, app, "finishing this unwind");
        if (sale._id !== unwind.saleId) refuse("DEAL_UNWIND_STALE");

        // Sol: the forward comes back before the remittance goes out.
        const proof = await deriveForwardState(ctx, app);
        if (proof.applies && unwind.forwardReturn === undefined) refuse("DEAL_UNWIND_FORWARD_FIRST");
        if (forwardCancelRefusal(proof) !== null) refuse("DEAL_UNWIND_FORWARD_UNSETTLED");

        // The amount is never typed: it is the remittance snapshotted at start,
        // and the deal must still carry exactly that disbursement.
        const version = unwind.remittanceVersion;
        if (
          app.disbursedAt === undefined ||
          app.disbursedAmountMinor !== unwind.remittanceMinor ||
          disbursementVersionOf(app) !== version
        ) {
          refuse("DEAL_UNWIND_STALE");
        }
        // DA-1: reversing the receipt journal credits the account it debited, so
        // the refund must leave by the same rail.
        if (args.method !== unwind.remittanceMethod) refuse("DEAL_UNWIND_REFUND_METHOD_MISMATCH");
        const refundedAt = pastDate(args.refundedAt, now, app.disbursedAt);

        // The same chain binding the returned-cheque path proves.
        const keys = financeDisbursementKeys(app._id, version);
        const payment = await ctx.db
          .query("canonicalPayments")
          .withIndex("by_org_idempotency", (q) => q.eq("orgId", args.orgId).eq("idempotencyKey", keys.paymentKey))
          .unique();
        const expectedPayerType = app.companyId ? "FINANCE_COMPANY" : "MANUAL_FINANCE_COMPANY";
        const paymentCurrency = payment?.currency.toUpperCase();
        if (
          !payment ||
          payment.status !== "SETTLED" ||
          payment.direction !== "IN" ||
          payment.payerType !== expectedPayerType ||
          (app.companyId
            ? payment.financeCompanyId !== app.companyId
            : payment.payerNameSnapshot !== manualPayerOf(app)?.name) ||
          payment.amountMinor !== app.disbursedAmountMinor ||
          payment.receivedAt !== app.disbursedAt ||
          (app.economicsCurrency !== undefined && paymentCurrency !== app.economicsCurrency.toUpperCase())
        ) {
          refuse("DEAL_UNWIND_CHAIN_MISMATCH");
        }
        if (payment.method !== unwind.remittanceMethod) refuse("DEAL_UNWIND_REFUND_METHOD_MISMATCH");
        if (!(await receiptPostedToPaymentAccount(ctx, app, unwind.remittanceMethod))) refuse("DEAL_UNWIND_CHAIN_MISMATCH");

        const receivable = await ctx.db
          .query("receivableDocuments")
          .withIndex("by_org_source", (q) =>
            q.eq("orgId", args.orgId).eq("sourceType", FINANCE_APP_RECEIVABLE_SOURCE).eq("sourceId", app._id)
          )
          .unique();
        const activeAllocations = (
          await ctx.db.query("paymentAllocations").withIndex("by_payment", (q) => q.eq("paymentId", payment._id)).collect()
        ).filter((allocation) => allocation.status === "ACTIVE");
        const allocatedMinor = activeAllocations.reduce((sum, allocation) => sum + allocation.amountMinor, 0);
        if (
          !receivable ||
          activeAllocations.length === 0 ||
          allocatedMinor !== payment.amountMinor ||
          activeAllocations.some((allocation) => allocation.receivableDocumentId !== receivable._id)
        ) {
          refuse("DEAL_UNWIND_ALLOCATION_SHAPE");
        }
        await assertPeriodOpen(ctx, args.orgId, now);

        // 1. The receipt comes off the books.
        for (const allocation of activeAllocations) {
          await reverseAllocation(ctx, { orgId: args.orgId, allocationId: allocation._id, actorId: user._id });
        }
        await voidCanonicalPayment(ctx, { orgId: args.orgId, paymentId: payment._id, actorId: user._id });
        const outcome = await hookFinanceCashReceivedReturned(ctx, {
          orgId: args.orgId,
          applicationId: app._id,
          disbursementVersion: version,
          reason: `Deal unwind: finance-company payment refunded (${unwind.reason})`,
          actorId: user._id,
          reversalDate: now,
        });
        // The books, not the hook's string, are the evidence. A queued
        // reversal does not pass; the throw rolls back every write above.
        const receiptReversal = await isFinanceCashReceivedReversalPosted(ctx, {
          orgId: args.orgId,
          applicationId: app._id,
          disbursementVersion: version,
        });
        if (receiptReversal === null) refuse("DEAL_UNWIND_REVERSAL_UNPROVEN");
        await ctx.db.patch(app._id, {
          disbursedAt: undefined,
          disbursedAmountMinor: undefined,
          disbursementIdempotencyKey: undefined,
          settlementStatus: "EXPECTED",
          disbursementVersion: version + 1,
          updatedAt: now,
        });

        // 2. The deal is cancelled, from the row as the refund left it. A
        // teardown refusal here rolls back the receipt reversal above too.
        const refunded = await loadOwnedApplication(ctx, args.orgId, app._id);
        const reason = `Deal unwound: ${unwind.reason}`;
        await resolveLinkedChequesForCancellation(ctx, refunded, user._id, reason, now);
        await cancelClosedApplicationTeardown(ctx, {
          app: refunded,
          actorId: user._id,
          reason,
          cancellationReason: reason,
          now,
        });
        await closeOutCancelledApplication(ctx, {
          app: refunded,
          actorId: user._id,
          now,
          cancellationReason: reason,
          note: `Deal unwound. Credit note ${creditNoteReference}.`,
        });

        // 3. The unwind completes with both legs' evidence.
        const reversedAllocationIds = activeAllocations.map((allocation) => allocation._id);
        await ctx.db.patch(unwind._id, {
          status: "COMPLETED",
          remittanceRefund: {
            method: args.method,
            refundedAt,
            ...evidence,
            amountMinor: payment.amountMinor,
            paymentId: payment._id,
            reversedAllocationIds,
            receiptReversal,
            recordedBy: user._id,
            recordedAt: now,
          },
          completion: {
            creditNoteReference,
            vehicleReturnedAt,
            vehicleReturnNote,
            customerPaymentDisposition: args.customerPaymentDisposition,
            completedBy: user._id,
            completedAt: now,
          },
          updatedAt: now,
        });
        await auditLog(ctx, {
          orgId: args.orgId,
          actorId: user._id,
          actionType: "DEAL_UNWIND_REMITTANCE_REFUNDED",
          resourceType: "financeApplications",
          resourceId: app._id,
          description: `Deal unwind: finance-company payment refunded by ${args.method}`,
          before: {
            disbursedAt: app.disbursedAt,
            disbursedAmountMinor: app.disbursedAmountMinor,
            disbursementVersion: version,
            settlementStatus: app.settlementStatus,
          },
          after: {
            unwindId: unwind._id,
            paymentId: payment._id,
            reversedAllocationIds,
            cashReceivedSourceId: keys.sourceId,
            reversalOutcome: outcome,
            receiptReversal,
            disbursementVersion: version + 1,
          },
          idempotencyKey: args.idempotencyKey,
        });
        await auditLog(ctx, {
          orgId: args.orgId,
          actorId: user._id,
          actionType: "DEAL_UNWIND_COMPLETED",
          resourceType: "financeApplications",
          resourceId: app._id,
          description: `Deal unwound and cancelled. Credit note ${creditNoteReference}.`,
          after: {
            unwindId: unwind._id,
            saleId: sale._id,
            customerPaymentDisposition: args.customerPaymentDisposition,
            vehicleReturnedAt,
          },
          idempotencyKey: args.idempotencyKey,
        });

        // F5: the same notice a cancelled application sends.
        const customer = await ctx.db.get(app.customerId);
        await notifyManagers(
          ctx,
          args.orgId,
          "application.cancelled",
          {
            actorName: await getActorName(ctx),
            customerName: customer ? `${customer.firstName} ${customer.lastName}` : "Unknown",
          },
          { link: `/${args.orgId}/applications`, excludeUserId: user._id }
        );
        return { unwindId: unwind._id, applicationId: app._id, receiptReversal, nextDisbursementVersion: version + 1 };
      }
    );
  },
});

export const abandonDealUnwind = mutation({
  args: {
    orgId: v.id("organizations"),
    unwindId: v.id("dealUnwinds"),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, ABANDON_PERMS);
    const reason = requiredText(args.reason, REASON_MAX_CHARS, "DEAL_UNWIND_REASON_REQUIRED");
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "dealUnwind.abandonDealUnwind",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({ unwindId: args.unwindId, reason }),
      },
      async () => {
        const { unwind, app } = await loadActiveUnwind(ctx, args.orgId, args.unwindId);
        // SCRUM-693-R1 holds by construction (ruling B): the refund is recorded
        // only by the step that also completes the unwind, so an ACTIVE unwind
        // has never refunded anything and abandoning it leaves the deal paid.
        const now = Date.now();
        // Nothing is undone: a returned forward stays recorded, and the deal is
        // left CLOSED and still paid, so a bare cancel keeps pointing here.
        await ctx.db.patch(unwind._id, {
          status: "ABANDONED",
          abandonment: { reason, abandonedBy: user._id, abandonedAt: now },
          updatedAt: now,
        });
        await auditLog(ctx, {
          orgId: args.orgId,
          actorId: user._id,
          actionType: "DEAL_UNWIND_ABANDONED",
          resourceType: "financeApplications",
          resourceId: app._id,
          description: `Deal unwind abandoned: ${reason}`,
          after: {
            unwindId: unwind._id,
            forwardReturned: unwind.forwardReturn !== undefined,
          },
          idempotencyKey: args.idempotencyKey,
        });
        return { unwindId: unwind._id };
      }
    );
  },
});

