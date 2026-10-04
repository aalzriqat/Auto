import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import type { Doc, Id } from "./_generated/dataModel";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { throwAppError, AppErrorCode } from "./utils/errors";
import { runWithIdempotency } from "./utils/idempotency";
import { getOrgCurrency } from "./accounting/workflowHooks";
import {
  amountToMinorOrThrow,
  depositMethodValidator,
  normalizeCurrency,
  requireDepositMethod,
} from "./utils/depositRecording";
import { activeQuoteDepositMinor, postQuoteDeposit } from "./utils/quoteDepositPosting";
import {
  assertNoQuoteLinkedReservationDeposit,
  quoteTerminalReason,
} from "./utils/depositRequestGuards";
import { assertAcquirable } from "./commitments";
import { getActorName, notifyByPermission, notifyUser } from "./utils/notifications";

/**
 * SCRUM-444 (owner ruling, Jira c21232, Option B): a salesperson RECORDS A
 * REQUEST; no money enters the ledger until a manager or accountant CONFIRMS
 * receipt.
 *
 * INVARIANT. A held deposit reaches the ledger (deposit row, transaction,
 * collection/canonical payment, DEPOSIT_RECEIVED outbox event, vehicle
 * commitment) ONLY through an action by an actor holding
 * CONFIRM_FINANCE_DISBURSEMENT. A request has no money, subledger, ledger or
 * commitment effect, and can never outlive the quote or deal it belongs to
 * (see `utils/depositRequestGuards.ts` for the doors that enforce the second
 * half).
 *
 * The four mutations below therefore split cleanly: `request` and `withdraw`
 * touch ONE row in ONE table; `reject` touches one row and a notification;
 * only `confirm` reaches money, and it does so through the same
 * `postQuoteDeposit` body `deposits.create` uses.
 */

const REQUEST_NOT_FOUND = "Deposit request not found in this organization.";

function requestIsTerminalMessage(status: Doc<"depositRequests">["status"]): string {
  switch (status) {
    case "CONFIRMED":
      return "This deposit request was already confirmed.";
    case "REJECTED":
      return "This deposit request was already rejected. Ask the salesperson to make a new request if the customer still wants to pay.";
    case "WITHDRAWN":
      return "This deposit request was withdrawn. Ask the salesperson to make a new request if the customer still wants to pay.";
    case "PENDING":
      return "This deposit request is still pending.";
  }
}

function holdsConfirmAuthority(role: Doc<"roles">): boolean {
  return isSystemOwnerRole(role) || role.permissions.includes(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT);
}

/**
 * SCRUM-444 F4: whether the requester can still be told about their request.
 * The predicate is the one the tenancy guard denies on — no membership, or an
 * offboarding one — so a member who has left is never sent deal details.
 */
async function requesterIsActiveMember(
  ctx: Parameters<typeof requireTenantAuth>[0],
  orgId: Id<"organizations">,
  userId: Id<"users">
): Promise<boolean> {
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_org_user", (q) => q.eq("orgId", orgId).eq("userId", userId))
    .unique();
  return !!membership && !membership.offboardingStatus;
}

async function loadOwnedRequest(
  ctx: Parameters<typeof requireTenantAuth>[0],
  orgId: Id<"organizations">,
  requestId: Id<"depositRequests">
): Promise<Doc<"depositRequests">> {
  const row = await ctx.db.get(requestId);
  // One message for "missing" and "someone else's": a foreign id must not be
  // distinguishable from a nonexistent one.
  if (!row || row.orgId !== orgId) throw new ConvexError(REQUEST_NOT_FOUND);
  return row;
}

/**
 * Record that the customer wants to put a deposit down. Writes ONE row.
 *
 * A pending request does not hold the car (owner Q1): the commitment becomes
 * true only when a manager confirms, and is checked again there. It is also
 * checked here, read-only, so a car another deal holds is refused before the
 * customer is asked for money (SCRUM-629 F-27).
 */
export const request = mutation({
  args: {
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
    /** Major units, in the organization's currency. */
    amount: v.number(),
    note: v.optional(v.string()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    const currency = normalizeCurrency(await getOrgCurrency(ctx, args.orgId));
    const amountMinor = amountToMinorOrThrow(args.amount, currency);
    const note = args.note?.trim() || undefined;

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "depositRequests.request",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          quoteId: args.quoteId,
          amountMinor,
          currency,
          note: note ?? null,
        }),
      },
      async () => {
        const quote = await ctx.db.get(args.quoteId);
        if (!quote || quote.orgId !== args.orgId) {
          throwAppError(AppErrorCode.QUOTE_NOT_FOUND, "Quote not found in this organization.");
        }
        const terminal = await quoteTerminalReason(ctx, quote);
        if (terminal) {
          throw new ConvexError(
            `${terminal} A deposit cannot be requested on it. Start a new quote for this customer.`
          );
        }

        // SCRUM-444 F1: a reservation deposit linked to this quote is money the
        // arithmetic below cannot see, so the request fails closed on it.
        await assertNoQuoteLinkedReservationDeposit(ctx, quote);

        // What the quote can still take, counting both the money already held
        // and the requests already waiting — otherwise two salespeople could
        // each request the full price and a manager would have to refuse the
        // second one after the customer had paid.
        const quoteAmountMinor = amountToMinorOrThrow(quote.vehiclePrice, currency, "Quote amount");
        const heldMinor = await activeQuoteDepositMinor(ctx, quote._id, currency);
        let pendingMinor = 0;
        for await (const pending of ctx.db
          .query("depositRequests")
          .withIndex("by_quote_status", (q) => q.eq("quoteId", quote._id).eq("status", "PENDING"))) {
          if (pending.orgId === args.orgId) pendingMinor += pending.amountMinor;
        }
        if (heldMinor + pendingMinor + amountMinor > quoteAmountMinor) {
          throw new ConvexError(
            "Total deposits, including requests already waiting, cannot exceed the quote amount. Lower the amount, or ask a manager to resolve the waiting request first."
          );
        }

        // SCRUM-629 F-27 (ruling c21924): the request still does not hold the
        // car, but asking a customer for money a manager would then have to
        // refuse is refused up front — the SAME commitment decision `confirm`
        // makes, for every quoted car, before anything is written or sent.
        // `confirm` re-checks: a rival may still take the car in between.
        for (const item of quote.vehicleItems ?? [{ vehicleId: quote.vehicleId }]) {
          // SCRUM-641: the authority refuses a soft-deleted car first, so asking a customer for money against one is refused up front.
          await assertAcquirable(ctx, {
            orgId: args.orgId,
            vehicleId: item.vehicleId,
            lineage: { quoteId: quote._id },
          });
        }

        const now = Date.now();
        const requestId = await ctx.db.insert("depositRequests", {
          orgId: args.orgId,
          quoteId: quote._id,
          customerId: quote.customerId,
          vehicleId: quote.vehicleId,
          amount: args.amount,
          amountMinor,
          currency,
          note,
          status: "PENDING",
          requestedBy: user._id,
          requestedAt: now,
          idempotencyKey: args.idempotencyKey,
        });

        // DA-06: the audience is whoever can CONFIRM — accountants included —
        // not "managers". Nobody else can act on it.
        const actorName = await getActorName(ctx);
        await notifyByPermission(
          ctx,
          args.orgId,
          PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
          "depositRequest.created",
          { actorName, amount: String(args.amount) },
          { link: `/${args.orgId}/approvals`, excludeUserId: user._id }
        );

        return requestId;
      }
    );
  },
});

/**
 * A manager or accountant confirms the money is IN. The only door in this file
 * that reaches the ledger.
 */
export const confirm = mutation({
  args: {
    orgId: v.id("organizations"),
    requestId: v.id("depositRequests"),
    /** What was actually received. Must equal the request — see below. */
    amount: v.number(),
    /** Required, no default: it picks the account the money is debited to. */
    method: v.optional(depositMethodValidator),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const method = requireDepositMethod(args.method);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "depositRequests.confirm",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          requestId: args.requestId,
          amount: args.amount,
          method,
        }),
      },
      // ⚠️ THE IDEMPOTENCY WRAP IS OUTSIDE EVERY STATE CHECK BELOW. A retry
      // after success finds the request CONFIRMED; if the PENDING check ran
      // first the retry would be refused as "already confirmed" instead of
      // being answered with the deposit it already made.
      async () => {
        const row = await loadOwnedRequest(ctx, args.orgId, args.requestId);
        if (row.status !== "PENDING") throw new ConvexError(requestIsTerminalMessage(row.status));

        const quote = await ctx.db.get(row.quoteId);
        if (!quote || quote.orgId !== args.orgId) {
          throwAppError(AppErrorCode.QUOTE_NOT_FOUND, "Quote not found in this organization.");
        }
        const terminal = await quoteTerminalReason(ctx, quote);
        if (terminal) {
          throw new ConvexError(
            `${terminal} A deposit can no longer be confirmed on it. Reject the request.`
          );
        }

        // Q2: the money that arrived is the money that was asked for. A
        // different amount is a different request — the salesperson's figure is
        // what the customer was told, and quietly posting another one would
        // make the row and the ledger disagree about what was requested.
        const currency = normalizeCurrency(row.currency);
        // SCRUM-444 F2: the request carries the currency it was raised in, and
        // the org may since have changed it (the lock now probes PENDING
        // requests, but an anomalous row must still never post at the wrong
        // scale). Checked BEFORE any write.
        const orgCurrency = normalizeCurrency(await getOrgCurrency(ctx, args.orgId));
        if (currency !== orgCurrency) {
          throw new ConvexError(
            `This request was raised in ${currency} but the organization now uses ${orgCurrency}, so it cannot be confirmed. Reject it and ask the salesperson to raise a new request.`
          );
        }
        const amountMinor = amountToMinorOrThrow(args.amount, currency);
        if (amountMinor !== row.amountMinor) {
          throw new ConvexError(
            "The amount received does not match the request. Reject this request and ask the salesperson to make a new one for the amount actually received."
          );
        }

        // SCRUM-444 F1: fail closed on a reservation deposit this quote cannot
        // see; the request stays PENDING (this mutation throws and rolls back).
        await assertNoQuoteLinkedReservationDeposit(ctx, quote);

        // Q1: a pending request never held the car, so a rival deal may have
        // taken it since. Checked BEFORE any write, with the way out named; the
        // request stays PENDING because this mutation throws and rolls back.
        for (const item of quote.vehicleItems ?? [{ vehicleId: quote.vehicleId }]) {
          try {
            await assertAcquirable(ctx, {
              orgId: args.orgId,
              vehicleId: item.vehicleId,
              lineage: { quoteId: quote._id },
            });
          } catch (error) {
            if (error instanceof ConvexError && typeof error.data === "string") {
              throw new ConvexError(
                `${error.data} The request stays pending: reject it, or ask the salesperson to withdraw it.`
              );
            }
            throw error;
          }
        }

        const depositId = await postQuoteDeposit(ctx, {
          orgId: args.orgId,
          quote,
          amount: row.amount,
          amountMinor: row.amountMinor,
          currency,
          method,
          notes: row.note,
          idempotencyKey: args.idempotencyKey,
          actorId: user._id,
        });

        // Same transaction as the deposit: a request cannot read CONFIRMED
        // without its deposit, nor a deposit exist for a request still PENDING.
        await ctx.db.patch(row._id, {
          status: "CONFIRMED",
          resolvedBy: user._id,
          resolvedAt: Date.now(),
          confirmedDepositId: depositId,
        });

        if (row.requestedBy !== user._id && (await requesterIsActiveMember(ctx, args.orgId, row.requestedBy))) {
          const actorName = await getActorName(ctx);
          await notifyUser(
            ctx,
            args.orgId,
            row.requestedBy,
            "depositRequest.confirmed",
            { actorName, amount: String(row.amount) },
            { link: `/${args.orgId}/sales` }
          );
        }

        return depositId;
      }
    );
  },
});

/** A manager or accountant declines the request. No money effects. */
export const reject = mutation({
  args: {
    orgId: v.id("organizations"),
    requestId: v.id("depositRequests"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const reason = args.reason.trim();
    if (!reason) {
      throw new ConvexError("Say why the request is rejected, so the salesperson knows what to do next.");
    }
    const row = await loadOwnedRequest(ctx, args.orgId, args.requestId);
    if (row.status !== "PENDING") throw new ConvexError(requestIsTerminalMessage(row.status));

    await ctx.db.patch(row._id, {
      status: "REJECTED",
      resolvedBy: user._id,
      resolvedAt: Date.now(),
      resolutionReason: reason,
    });

    if (row.requestedBy !== user._id && (await requesterIsActiveMember(ctx, args.orgId, row.requestedBy))) {
      const actorName = await getActorName(ctx);
      await notifyUser(
        ctx,
        args.orgId,
        row.requestedBy,
        "depositRequest.rejected",
        { actorName, amount: String(row.amount), reason },
        { link: `/${args.orgId}/sales` }
      );
    }
    return null;
  },
});

/** The requester (or a manager or accountant) takes the request back. No money effects. */
export const withdraw = mutation({
  args: {
    orgId: v.id("organizations"),
    requestId: v.id("depositRequests"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    const row = await loadOwnedRequest(ctx, args.orgId, args.requestId);
    if (row.requestedBy !== user._id && !holdsConfirmAuthority(role)) {
      throw new ConvexError(
        "Only the person who made this request, or a manager or accountant, can withdraw it."
      );
    }
    if (row.status !== "PENDING") throw new ConvexError(requestIsTerminalMessage(row.status));

    await ctx.db.patch(row._id, {
      status: "WITHDRAWN",
      resolvedBy: user._id,
      resolvedAt: Date.now(),
      resolutionReason: args.reason?.trim() || undefined,
    });
    return null;
  },
});

/**
 * Every request waiting for a decision, for the confirm/reject queue.
 * CONFIRM authority only: the queue is a to-do list for the people who can act.
 */
export const listPending = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT]);
    const rows = await ctx.db
      .query("depositRequests")
      .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", "PENDING"))
      .take(200);
    return await Promise.all(
      rows.map(async (row) => {
        const [customer, vehicle, requester] = await Promise.all([
          ctx.db.get(row.customerId),
          ctx.db.get(row.vehicleId),
          ctx.db.get(row.requestedBy),
        ]);
        return {
          _id: row._id,
          quoteId: row.quoteId,
          amount: row.amount,
          currency: row.currency,
          note: row.note ?? null,
          requestedAt: row.requestedAt,
          requestedByName: requester?.name || requester?.email || "A team member",
          customerName:
            `${customer?.firstName ?? ""} ${customer?.lastName ?? ""}`.trim() || "Customer",
          vehicleLabel: vehicle
            ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim()
            : "Vehicle",
        };
      })
    );
  },
});

/**
 * The requests on one quote, newest first, plus whether the caller may decide
 * them. The wizard uses it to show "requested — awaiting confirmation" (zero
 * paid) beside any confirmed deposit.
 */
export const listForQuote = query({
  args: { orgId: v.id("organizations"), quoteId: v.id("quotes") },
  handler: async (ctx, args) => {
    const { role, user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    const quote = await ctx.db.get(args.quoteId);
    if (!quote || quote.orgId !== args.orgId) return null;
    const rows = await ctx.db
      .query("depositRequests")
      .withIndex("by_quote", (q) => q.eq("quoteId", args.quoteId))
      .order("desc")
      .take(50);
    return {
      canConfirm: holdsConfirmAuthority(role),
      requests: rows
        .filter((row) => row.orgId === args.orgId)
        .map((row) => ({
          _id: row._id,
          amount: row.amount,
          currency: row.currency,
          note: row.note ?? null,
          status: row.status,
          requestedAt: row.requestedAt,
          resolutionReason: row.resolutionReason ?? null,
          confirmedDepositId: row.confirmedDepositId ?? null,
          isMine: row.requestedBy === user._id,
        })),
    };
  },
});
