import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type MutationCtx } from "./_generated/server";
import { postAccountingEvent, type PostCommand } from "./accounting/postingEngine";
import { createCanonicalPayment } from "./subledger";
import { requireActiveBankInCurrency } from "./utils/bankAccountGuards";
import { assertDifferentActors } from "./utils/financialGuards";
import { fromMinorUnits } from "./utils/money";
import { requireOpeningSettlementBasis } from "./utils/openingSettlementBasis";
import { authorizeOpeningDepositRefund, OPENING_DEPOSIT_REFUND_JOURNAL_KEY, OPENING_DEPOSIT_REFUND_SOURCE } from "./utils/openingDepositRefundPosting";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { hasPendingDispositionForDeposit } from "./utils/depositCancellationPending";
import { assertDepositNotInLiveForward } from "./utils/financeCompanyForward";
import { DAY_MS, utcDay, isRepresentableTimestamp } from "./utils/ledgerCalendar";
import { assertPostingAllowed } from "./accountingPeriods";
import { assertOrgEconomicallyActive } from "./utils/orgLifecycle";
import { auditLog } from "./financialAudit";
import { mutation } from "./functions";
import { PERMISSIONS } from "./utils/permissions";
import { runWithIdempotency } from "./utils/idempotency";
import { isUtcMidnight } from "./utils/orgBusinessDay";


async function requireRefundableOpeningDeposit(ctx: MutationCtx, args: {
  orgId: Id<"organizations">;
  deposit: Doc<"deposits">;
  actorId: Id<"users">;
  method: "CASH" | "BANK_TRANSFER";
  bankAccountId?: Id<"bankAccounts">;
  payoutDate: number;
}) {
  const { orgId, deposit, actorId, payoutDate } = args;
  await assertOrgEconomicallyActive(ctx, orgId);
  const depositId = deposit._id;
  if (deposit.origin !== "OPENING" || deposit.status !== "HELD" || deposit.isDeleted ||
      !deposit.openingBalanceDraftId || !deposit.openingRowKey ||
      deposit.usesVehicleHoldRows !== false || deposit.holdActive ||
      deposit.quoteId || deposit.reservationId || deposit.canonicalPaymentId ||
      deposit.singleVehicleCommitmentClaimId || deposit.resolutionSaleId ||
      (deposit.releasedAmountMinor ?? 0) !== 0 || (deposit.refundedAmountMinor ?? 0) !== 0 ||
      (deposit.forfeitedAmountMinor ?? 0) !== 0 || (deposit.releaseCount ?? 0) !== 0) {
    throw new ConvexError("Only an unused opening deposit can be refunded here.");
  }
  assertDifferentActors(actorId, deposit.createdBy, "You cannot refund your own deposit.");
  const customer = await requireOwnedRow(ctx, orgId, "customers", deposit.customerId, "The deposit customer is unavailable.");
  if (customer.isDeleted) throw new ConvexError("The deposit customer is unavailable.");
  await assertDepositNotInLiveForward(ctx, deposit);
  const [application, hold, pending] = await Promise.all([
    ctx.db.query("depositApplications").withIndex("by_deposit", q => q.eq("depositId", depositId)).first(),
    ctx.db.query("depositVehicleHolds").withIndex("by_deposit", q => q.eq("depositId", depositId)).first(),
    hasPendingDispositionForDeposit(ctx, orgId, depositId),
  ]);
  if (application || hold || pending) throw new ConvexError("Only an unused opening deposit can be refunded here.");

  const basis = await requireOpeningSettlementBasis(ctx, orgId, {
    draftId: deposit.openingBalanceDraftId,
    rowKey: deposit.openingRowKey,
  }, "CUSTOMER_DEPOSIT");
  const now = Date.now();
  if (basis.allocation.kind !== "CUSTOMER_DEPOSIT" || basis.result.kind !== "CUSTOMER_DEPOSIT" ||
      basis.result.depositId !== depositId || basis.allocation.customerId !== deposit.customerId ||
      basis.allocation.vehicleId !== deposit.vehicleId || basis.allocation.depositKind !== deposit.openingDepositKind ||
      (deposit.openingDepositKind === "SECURITY" && deposit.vehicleId) ||
      basis.amountMinor !== deposit.amountMinor || basis.currency !== deposit.currency ||
      basis.asOfDate > now || utcDay(basis.asOfDate) > utcDay(payoutDate)) {
    throw new ConvexError("The opening deposit balance could not be verified for refund.");
  }

  if (args.method === "BANK_TRANSFER") {
    await requireActiveBankInCurrency(ctx, {
      orgId, bankAccountId: args.bankAccountId, currency: basis.currency,
      missingMessage: "Select the bank account used for this refund.", currencySubject: "opening deposit refund",
    });
  } else if (args.bankAccountId) {
    throw new ConvexError("A cash refund cannot name a bank account.");
  }

  return basis;
}

type OpeningRefundReservation = NonNullable<Doc<"deposits">["openingRefundReservation"]>;

async function reserveOpeningDepositRefund(ctx: MutationCtx, args: {
  orgId: Id<"organizations">;
  deposit: Doc<"deposits">;
  actorId: Id<"users">;
  method: OpeningRefundReservation["method"];
  bankAccountId?: Id<"bankAccounts">;
  reservationKey: string;
}) {
  if (args.deposit.openingRefundReservation) throw new ConvexError("This opening deposit is already reserved for refund.");
  const reservedAt = Date.now();
  const payoutDate = utcDay(reservedAt) * DAY_MS;
  await requireRefundableOpeningDeposit(ctx, { ...args, payoutDate });
  const periodId = await assertPostingAllowed(ctx, args.orgId, payoutDate);
  const reservation: OpeningRefundReservation = {
    key: args.reservationKey, reservedBy: args.actorId, reservedAt, periodId, method: args.method,
    ...(args.bankAccountId ? { bankAccountId: args.bankAccountId } : {}),
  };
  await ctx.db.patch(args.deposit._id, { openingRefundReservation: reservation });
  await auditLog(ctx, {
    orgId: args.orgId, actorId: args.actorId, actionType: "RESOLVE_DEPOSIT_ALLOCATION",
    resourceType: "deposits", resourceId: args.deposit._id, description: "Opening deposit reserved for refund",
    after: reservation, idempotencyKey: reservation.key,
  });
  return { reservationKey: reservation.key };
}

function requireOpeningRefundReservation(deposit: Doc<"deposits">, key: string, actorId: Id<"users">) {
  const reservation = deposit.openingRefundReservation;
  if (deposit.origin !== "OPENING" || deposit.status !== "HELD" || deposit.isDeleted ||
      !reservation || reservation.key !== key || reservation.reservedBy !== actorId) {
    throw new ConvexError("Only the approver holding the active opening refund reservation can settle or cancel it.");
  }
  return reservation;
}

async function cancelOpeningDepositRefundReservation(ctx: MutationCtx, args: {
  orgId: Id<"organizations">;
  deposit: Doc<"deposits">;
  actorId: Id<"users">;
  reservationKey: string;
  reason: string;
}) {
  await assertOrgEconomicallyActive(ctx, args.orgId);
  const reservation = requireOpeningRefundReservation(args.deposit, args.reservationKey, args.actorId);
  // Cancel only after the reserving approver attests that no payout took place.
  await ctx.db.patch(args.deposit._id, { openingRefundReservation: undefined });
  await auditLog(ctx, {
    orgId: args.orgId, actorId: args.actorId, actionType: "RESOLVE_DEPOSIT_ALLOCATION",
    resourceType: "deposits", resourceId: args.deposit._id,
    description: "Opening deposit refund reservation cancelled before payout",
    before: reservation, after: { reason: args.reason, confirmedUnpaid: true }, idempotencyKey: reservation.key,
  });
}

async function recordOpeningDepositRefund(ctx: MutationCtx, args: {
  orgId: Id<"organizations">;
  deposit: Doc<"deposits">;
  actorId: Id<"users">;
  reservationKey: string;
  payoutReference: string;
  payoutDate: number;
}) {
  const { orgId, deposit, actorId, payoutDate } = args;
  const depositId = deposit._id;
  const reservation = requireOpeningRefundReservation(deposit, args.reservationKey, actorId);
  if (utcDay(payoutDate) < utcDay(reservation.reservedAt)) {
    throw new ConvexError("The payout date cannot be before the refund was reserved.");
  }
  const payoutPeriod = await assertPostingAllowed(ctx, orgId, payoutDate);
  if (payoutPeriod !== reservation.periodId) {
    throw new ConvexError("The payout must be dated in the accounting period reserved for this refund.");
  }
  const { method, bankAccountId } = reservation;
  const basis = await requireRefundableOpeningDeposit(ctx, { ...args, method, bankAccountId });
  const now = Date.now();
  const idempotencyKey = `${OPENING_DEPOSIT_REFUND_JOURNAL_KEY}${depositId}`;
  const referenceKey = args.payoutReference.toUpperCase();
  // Preserve one use of each payout reference per source.
  const paymentKey = bankAccountId
    ? `opening_deposit_refund_transfer_${bankAccountId}_${referenceKey}`
    : `opening_deposit_refund_cash_${referenceKey}`;
  const [existingPayment, pendingJournal] = await Promise.all([
    ctx.db.query("canonicalPayments").withIndex("by_org_idempotency", q =>
      q.eq("orgId", orgId).eq("idempotencyKey", paymentKey)).first(),
    ctx.db.query("pendingAccountingEvents").withIndex("by_org_idempotency", q =>
      q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey)).first(),
  ]);
  if (existingPayment || pendingJournal) {
    throw new ConvexError("This refund or transfer reference is already recorded. Ask finance to review it.");
  }

  const cmd: PostCommand = {
    orgId, actorId, eventType: "DEPOSIT_REFUNDED", sourceType: OPENING_DEPOSIT_REFUND_SOURCE,
    sourceId: depositId, eventVersion: 1, idempotencyKey, accountingDate: payoutDate, occurredAt: now,
    currency: basis.currency,
    payload: {
      depositId, customerId: deposit.customerId, amountMinor: basis.amountMinor, currency: basis.currency,
      paymentMethod: method, ...(bankAccountId ? { bankAccountId: bankAccountId } : {}),
      openingBalanceDraftId: basis.draftId, openingRowKey: basis.rowKey, reservationKey: reservation.key, payoutReference: args.payoutReference,
    },
  };
  const { eventId, journalEntryId, alreadyPosted } = await postAccountingEvent(ctx, authorizeOpeningDepositRefund(cmd));
  if (!eventId || !journalEntryId || alreadyPosted) {
    throw new ConvexError("The refund could not be posted. Ask finance to review it.");
  }

  const paymentId = await createCanonicalPayment(ctx, {
    orgId, actorId, direction: "OUT", payerType: "CUSTOMER", customerId: deposit.customerId,
    method: method, amountMinor: basis.amountMinor, currency: basis.currency,
    idempotencyKey: paymentKey, externalReference: args.payoutReference, receivedAt: payoutDate, accountingEventId: eventId,
  });
  const amount = fromMinorUnits(basis.amountMinor, basis.currency);
  await ctx.db.insert("collectionPayments", {
    orgId, customerId: deposit.customerId, vehicleId: deposit.vehicleId, direction: "OUT", method: "REFUND",
    amount, paymentDate: payoutDate, paymentDateKind: "calendarKey", status: "POSTED", cashierId: actorId, createdAt: now,
    canonicalPaymentId: paymentId, reference: `Opening deposit refund ${depositId}`, idempotencyKey,
  });
  await ctx.db.insert("transactions", {
    orgId, type: "OUT", amount, date: payoutDate, category: "DEPOSIT", description: "Opening deposit refund",
    vehicleId: deposit.vehicleId, depositId, idempotencyKey,
  });
  await ctx.db.patch(depositId, {
    status: "REFUNDED", releasedAmountMinor: basis.amountMinor, refundedAmountMinor: basis.amountMinor,
    openingRefundReservation: undefined, releaseCount: 1, resolvedBy: actorId, resolvedAt: now,
  });
  return { journalEntryId, paymentId };
}

const openingRefundMethod = v.union(v.literal("CASH"), v.literal("BANK_TRANSFER"));

export const reserveOpeningRefund = mutation({
  args: {
    orgId: v.id("organizations"), depositId: v.id("deposits"),
    method: openingRefundMethod, bankAccountId: v.optional(v.id("bankAccounts")), idempotencyKey: v.string(),
  },
  returns: v.object({ reservationKey: v.string() }),
  handler: async (ctx, args) => {
    const { orgId, depositId, method, bankAccountId } = args;
    const { user } = await requireTenantAuth(ctx, orgId, [PERMISSIONS.APPROVE_REQUESTS]);
    const deposit = await requireOwnedRow(ctx, orgId, "deposits", depositId, "Deposit not found.");
    const reservationKey = args.idempotencyKey.trim();
    const result = await runWithIdempotency(ctx, {
      orgId, operation: "deposits.reserveOpeningRefund", economic: true,
      idempotencyKey: reservationKey, actorId: user._id,
      fingerprint: JSON.stringify([depositId, method, bankAccountId ?? null]),
    }, () => reserveOpeningDepositRefund(ctx, {
      orgId, deposit, actorId: user._id, method, bankAccountId, reservationKey,
    }));
    const current = await ctx.db.get(depositId);
    if (current?.status !== "HELD" || current.openingRefundReservation?.key !== result.reservationKey) {
      throw new ConvexError("This refund reservation is no longer active.");
    }
    return result;
  },
});

export const openingRefundReservation = query({
  args: { orgId: v.id("organizations"), depositId: v.id("deposits") },
  returns: v.union(v.null(), v.object({
    reservationKey: v.string(), method: openingRefundMethod,
    bankAccountName: v.optional(v.string()),
  })),
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);
    const deposit = await requireOwnedRow(ctx, args.orgId, "deposits", args.depositId, "Deposit not found.");
    const reservation = deposit.openingRefundReservation;
    if (!reservation || reservation.reservedBy !== user._id || deposit.status !== "HELD" || deposit.isDeleted) return null;
    const bank = reservation.bankAccountId
      ? await requireOwnedRow(ctx, args.orgId, "bankAccounts", reservation.bankAccountId)
      : undefined;
    return { reservationKey: reservation.key, method: reservation.method, ...(bank ? { bankAccountName: bank.name } : {}) };
  },
});

export const cancelOpeningRefundReservation = mutation({
  args: {
    orgId: v.id("organizations"), depositId: v.id("deposits"),
    reservationKey: v.string(), confirmedUnpaid: v.literal(true), reason: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const { orgId, depositId, reservationKey } = args;
    const { user } = await requireTenantAuth(ctx, orgId, [PERMISSIONS.APPROVE_REQUESTS]);
    const deposit = await requireOwnedRow(ctx, orgId, "deposits", depositId, "Deposit not found.");
    const reason = args.reason.trim();
    if (!reason || reason.length > 240) throw new ConvexError("Enter a cancellation reason of 1 to 240 characters.");
    await cancelOpeningDepositRefundReservation(ctx, { orgId, deposit, actorId: user._id, reservationKey, reason });
    return null;
  },
});

export const recordOpeningRefund = mutation({
  args: {
    orgId: v.id("organizations"),
    depositId: v.id("deposits"),
    reservationKey: v.string(),
    payoutReference: v.string(),
    payoutDate: v.number(),
    idempotencyKey: v.string(),
  },
  returns: v.object({ journalEntryId: v.id("journalEntries"), paymentId: v.id("canonicalPayments") }),
  handler: async (ctx, args) => {
    const { orgId, depositId, reservationKey, payoutDate } = args;
    const { user } = await requireTenantAuth(ctx, orgId, [PERMISSIONS.APPROVE_REQUESTS]);
    const deposit = await requireOwnedRow(ctx, orgId, "deposits", depositId, "Deposit not found.");
    if (!isRepresentableTimestamp(payoutDate) || !isUtcMidnight(payoutDate) || payoutDate > Date.now()) {
      throw new ConvexError("Enter a valid refund date on or before today.");
    }
    const payoutReference = args.payoutReference.trim();
    if (!payoutReference || payoutReference.length > 120) {
      throw new ConvexError("Enter the completed refund receipt or bank transfer reference (120 characters or fewer).");
    }
    return runWithIdempotency(ctx, {
      orgId,
      operation: "deposits.recordOpeningRefund",
      economic: true,
      idempotencyKey: args.idempotencyKey,
      actorId: user._id,
      fingerprint: JSON.stringify([depositId, reservationKey, payoutReference, payoutDate]),
    }, () => recordOpeningDepositRefund(ctx, {
      orgId, deposit, actorId: user._id, reservationKey, payoutReference, payoutDate,
    }));
  },
});
