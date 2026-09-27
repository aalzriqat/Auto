import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx } from "./_generated/server";
import { requireTenantAuth, requireOwnedRow } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { runWithIdempotency } from "./utils/idempotency";
import { toMinorUnits } from "./utils/money";
import { reverseAccountingEvent } from "./accounting/reversals";
import { expensePostedKey } from "./accounting/postingRules";
import {
  postingStateForKey,
  postSupplierCostRecoveryReceipt,
  supplierCostRecoveryReceiptKey,
  supplierCostRecoveryReceiptReversalKey,
} from "./accounting/supplierCostRecoveryPosting";
import { auditLog } from "./financialAudit";

/**
 * SCRUM-389 — recovering supplier-borne vehicle costs.
 *
 * A PAID expense whose `costBearer` is SUPPLIER debits Receivable from
 * Suppliers instead of an expense account, and opens exactly one row here in
 * the same transaction. The supplier then pays it back through immutable
 * receipts, each posted synchronously as its own ledger source.
 *
 * Invariants, in integer minor units of `currency`:
 *   - amountDueMinor = Σ LIVE receipts + remaining, remaining ≥ 0;
 *   - a LIVE receipt always has a POSTED event (no queued receipt exists);
 *   - the source expense can be reversed only once every receipt, and every
 *     receipt's event, is REVERSED and nothing is recovered.
 *
 * Out of scope and deliberately refused rather than half-built: write-off
 * (SCRUM-399), cheque receipts (SCRUM-400), netting against the supplier
 * payable at settlement (SCRUM-401). Until the write-off lands an unrecoverable
 * cost stays an OPEN receivable — visible, and never silently profit.
 */

/** How many receipts one recovery may carry — a bound on every read of them. */
export const MAX_RECEIPTS_PER_RECOVERY = 100;

/** The one derivation of a recovery's status. Never set by hand. */
export function recoveryStatusFor(args: {
  amountDueMinor: number;
  amountRecoveredMinor: number;
  reversed: boolean;
}): Doc<"supplierCostRecoveries">["status"] {
  if (args.reversed) return "REVERSED";
  if (args.amountRecoveredMinor <= 0) return "OPEN";
  if (args.amountRecoveredMinor >= args.amountDueMinor) return "RECOVERED";
  return "PARTIALLY_RECOVERED";
}

/**
 * Opens the recovery for a just-paid SUPPLIER expense. Called only from
 * `recordPaidExpenseSideEffects`, in the same transaction as the EXPENSE_POSTED
 * post or enqueue it follows.
 *
 * Idempotent per expense: a re-run of the paid side effects finds the row and
 * returns it rather than opening a second claim for one cost.
 */
export async function openSupplierCostRecovery(
  ctx: MutationCtx,
  args: {
    expense: Doc<"expenses">;
    vehicle: Doc<"vehicles">;
    currency: string;
    actorId: Id<"users">;
  }
): Promise<Id<"supplierCostRecoveries">> {
  const existing = await ctx.db
    .query("supplierCostRecoveries")
    .withIndex("by_org_expense", (q) => q.eq("orgId", args.expense.orgId).eq("expenseId", args.expense._id))
    .first();
  if (existing) return existing._id;
  const now = Date.now();
  return await ctx.db.insert("supplierCostRecoveries", {
    orgId: args.expense.orgId,
    vehicleId: args.vehicle._id,
    expenseId: args.expense._id,
    sourcedFromName: (args.vehicle.sourcedFromName ?? "").trim(),
    amountDueMinor: toMinorUnits(args.expense.amount, args.currency),
    amountRecoveredMinor: 0,
    currency: args.currency,
    receiptSeq: 0,
    sourceEventKey: expensePostedKey(args.expense._id),
    status: "OPEN",
    createdBy: args.actorId,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Refuses reversal of a SUPPLIER expense while anything has been recovered on
 * it, and returns its recovery (or null for a SHOWROOM expense) so the caller
 * can close it after the ledger reversal.
 *
 * Re-read inside the reversal's own transaction. Every receipt write and every
 * receipt reversal patches the recovery row, and so does the caller once this
 * passes — so a concurrent receipt and this reversal conflict on that row and
 * serialize rather than both committing.
 *
 * Permitted only when ALL hold (v6 design):
 *   - every receipt row is REVERSED;
 *   - every receipt's GL event is REVERSED;
 *   - amountRecoveredMinor === 0.
 */
export async function assertSupplierCostExpenseReversible(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  expenseId: Id<"expenses">
): Promise<Doc<"supplierCostRecoveries"> | null> {
  const recovery = await ctx.db
    .query("supplierCostRecoveries")
    .withIndex("by_org_expense", (q) => q.eq("orgId", orgId).eq("expenseId", expenseId))
    .first();
  if (!recovery || recovery.status === "REVERSED") return recovery;
  const refusal =
    "The supplier has paid against this cost. Reverse every recovery receipt before reversing the expense.";
  if (recovery.amountRecoveredMinor !== 0) throw new ConvexError(refusal);
  const receipts = await ctx.db
    .query("supplierCostRecoveryReceipts")
    .withIndex("by_org_recovery", (q) => q.eq("orgId", orgId).eq("recoveryId", recovery._id))
    .take(MAX_RECEIPTS_PER_RECOVERY + 1);
  if (receipts.length > MAX_RECEIPTS_PER_RECOVERY) throw new ConvexError(refusal);
  if (receipts.some((receipt) => receipt.status !== "REVERSED")) throw new ConvexError(refusal);
  const states = await Promise.all(
    receipts.map((receipt) => postingStateForKey(ctx, orgId, supplierCostRecoveryReceiptKey(receipt._id)))
  );
  if (states.some(({ state }) => state !== "REVERSED")) throw new ConvexError(refusal);
  return recovery;
}

/** Closes a recovery whose source expense has just been reversed. */
export async function markSupplierCostRecoveryReversed(
  ctx: MutationCtx,
  recovery: Doc<"supplierCostRecoveries">,
  actorId: Id<"users">,
  now: number
): Promise<void> {
  if (recovery.status === "REVERSED") return;
  await ctx.db.patch(recovery._id, {
    status: "REVERSED",
    reversedAt: now,
    reversedBy: actorId,
    updatedAt: now,
  });
}

// ─── Queries ─────────────────────────────────────────────────────────────────

const recoveryStatusValidator = v.union(
  v.literal("OPEN"),
  v.literal("PARTIALLY_RECOVERED"),
  v.literal("RECOVERED"),
  v.literal("REVERSED")
);

/**
 * Recoveries with what is still owed and where the source posting stands.
 *
 * Served under VIEW_FINANCE only; the expense list keeps its own projection and
 * shows only the non-sensitive bearer enum. Bounded: past the bound the list
 * says it is incomplete rather than looking like the whole set.
 */
export const list = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(recoveryStatusValidator),
  },
  returns: v.object({
    items: v.array(
      v.object({
        _id: v.id("supplierCostRecoveries"),
        vehicleId: v.id("vehicles"),
        expenseId: v.id("expenses"),
        sourcedFromName: v.string(),
        currency: v.string(),
        amountDueMinor: v.number(),
        amountRecoveredMinor: v.number(),
        remainingMinor: v.number(),
        status: recoveryStatusValidator,
        sourcePostingState: v.union(
          v.literal("POSTED"),
          v.literal("REVERSED"),
          v.literal("PENDING"),
          v.literal("FAILED"),
          v.literal("NONE")
        ),
        expenseTitle: v.union(v.string(), v.null()),
        vehicleLabel: v.union(v.string(), v.null()),
        createdAt: v.number(),
      })
    ),
    complete: v.boolean(),
  }),
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const LIMIT = 200;
    const rows = args.status
      ? await ctx.db
          .query("supplierCostRecoveries")
          .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status!))
          .order("desc")
          .take(LIMIT + 1)
      : await ctx.db
          .query("supplierCostRecoveries")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .order("desc")
          .take(LIMIT + 1);
    const page = rows.slice(0, LIMIT);
    const items = await Promise.all(
      page.map(async (row) => {
        const vehicle = await ctx.db.get(row.vehicleId);
        const expense = await ctx.db.get(row.expenseId);
        const { state } = await postingStateForKey(ctx, args.orgId, row.sourceEventKey);
        return {
          _id: row._id,
          vehicleId: row.vehicleId,
          expenseId: row.expenseId,
          sourcedFromName: row.sourcedFromName,
          currency: row.currency,
          amountDueMinor: row.amountDueMinor,
          amountRecoveredMinor: row.amountRecoveredMinor,
          remainingMinor: Math.max(0, row.amountDueMinor - row.amountRecoveredMinor),
          status: row.status,
          sourcePostingState: state,
          expenseTitle: expense?.title ?? null,
          vehicleLabel: vehicle ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim() : null,
          createdAt: row.createdAt,
        };
      })
    );
    return { items, complete: rows.length <= LIMIT };
  },
});

/** The receipts recorded against one recovery, newest first. */
export const listReceipts = query({
  args: {
    orgId: v.id("organizations"),
    recoveryId: v.id("supplierCostRecoveries"),
  },
  returns: v.array(
    v.object({
      _id: v.id("supplierCostRecoveryReceipts"),
      seq: v.number(),
      amountMinor: v.number(),
      currency: v.string(),
      method: v.union(v.literal("CASH"), v.literal("BANK_TRANSFER")),
      receivedDate: v.number(),
      reference: v.union(v.string(), v.null()),
      status: v.union(v.literal("POSTING"), v.literal("LIVE"), v.literal("REVERSED")),
      reversedAt: v.union(v.number(), v.null()),
    })
  ),
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireOwnedRow(ctx, args.orgId, "supplierCostRecoveries", args.recoveryId, "Supplier cost recovery not found.");
    const receipts = await ctx.db
      .query("supplierCostRecoveryReceipts")
      .withIndex("by_org_recovery", (q) => q.eq("orgId", args.orgId).eq("recoveryId", args.recoveryId))
      .order("desc")
      .take(MAX_RECEIPTS_PER_RECOVERY);
    return receipts.map((r) => ({
      _id: r._id,
      seq: r.seq,
      amountMinor: r.amountMinor,
      currency: r.currency,
      method: r.method,
      receivedDate: r.receivedDate,
      reference: r.reference ?? null,
      status: r.status,
      reversedAt: r.reversedAt ?? null,
    }));
  },
});

// ─── Commands ────────────────────────────────────────────────────────────────

/** A caller-supplied instant: a safe positive integer, and not in the future. */
function assertPastInstant(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConvexError(`The ${label} is not a valid date.`);
  }
  if (value > Date.now()) {
    throw new ConvexError(`The ${label} cannot be in the future.`);
  }
}

/**
 * Records money received from the supplier against one recovery.
 *
 * CASH or BANK_TRANSFER only; a cheque can bounce, and its return lifecycle is
 * SCRUM-400. The receipt posts SYNCHRONOUSLY and the mutation throws unless the
 * posting is POSTED, so there is no receipt the ledger does not carry. The
 * whole body runs inside `runWithIdempotency`, and the receipt id is allocated
 * only after the replay check — so a retry after a lost response returns the
 * first receipt instead of recording the supplier's payment twice.
 */
export const recordReceipt = mutation({
  args: {
    orgId: v.id("organizations"),
    recoveryId: v.id("supplierCostRecoveries"),
    amountMinor: v.number(),
    method: v.union(v.literal("CASH"), v.literal("BANK_TRANSFER")),
    receivedDate: v.number(),
    reference: v.optional(v.string()),
    notes: v.optional(v.string()),
    idempotencyKey: v.string(),
  },
  returns: v.object({
    receiptId: v.id("supplierCostRecoveryReceipts"),
    amountRecoveredMinor: v.number(),
    remainingMinor: v.number(),
    status: recoveryStatusValidator,
  }),
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "supplierCostRecoveries.recordReceipt",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        // Every persisted caller input.
        fingerprint: JSON.stringify({
          recoveryId: args.recoveryId,
          amountMinor: args.amountMinor,
          method: args.method,
          receivedDate: args.receivedDate,
          reference: args.reference ?? null,
          notes: args.notes ?? null,
        }),
      },
      async () => {
        const recovery = await requireOwnedRow(
          ctx,
          args.orgId,
          "supplierCostRecoveries",
          args.recoveryId,
          "Supplier cost recovery not found."
        );
        // NaN, Infinity and fractions all fail `isSafeInteger`; `<= 0` alone
        // would let NaN through.
        if (!Number.isSafeInteger(args.amountMinor) || args.amountMinor <= 0) {
          throw new ConvexError("A receipt must be a positive whole amount in the currency's smallest unit.");
        }
        assertPastInstant(args.receivedDate, "receipt date");
        if (recovery.status === "REVERSED") {
          throw new ConvexError("This cost was reversed, so there is nothing to recover.");
        }
        // Money cannot be recovered against a debit the ledger does not carry:
        // a queued or failed source would leave this credit with nothing to
        // offset, and a reversed one has already been undone.
        const source = await postingStateForKey(ctx, args.orgId, recovery.sourceEventKey);
        if (source.state !== "POSTED") {
          throw new ConvexError(
            "This cost has not been posted to the ledger yet. Receipts can be recorded once it has."
          );
        }
        // A credit dated before its debit would show the receivable negative
        // at any cutoff between the two dates.
        if (source.accountingDate === undefined || args.receivedDate < source.accountingDate) {
          throw new ConvexError("A receipt cannot be dated before the cost it recovers was posted.");
        }
        const remaining = recovery.amountDueMinor - recovery.amountRecoveredMinor;
        if (args.amountMinor > remaining) {
          throw new ConvexError("That is more than the supplier still owes on this cost.");
        }
        if (recovery.receiptSeq >= MAX_RECEIPTS_PER_RECOVERY) {
          throw new ConvexError("This recovery has reached its receipt limit.");
        }

        const now = Date.now();
        const seq = recovery.receiptSeq + 1;
        // Allocated first so the posting can be keyed on it. POSTING never
        // persists: any throw below rolls this insert back with everything else.
        const receiptId = await ctx.db.insert("supplierCostRecoveryReceipts", {
          orgId: args.orgId,
          recoveryId: recovery._id,
          vehicleId: recovery.vehicleId,
          seq,
          amountMinor: args.amountMinor,
          currency: recovery.currency,
          method: args.method,
          receivedDate: args.receivedDate,
          reference: args.reference?.trim() || undefined,
          notes: args.notes?.trim() || undefined,
          idempotencyKey: args.idempotencyKey,
          status: "POSTING",
          createdBy: user._id,
          createdAt: now,
        });
        await postSupplierCostRecoveryReceipt(ctx, {
          orgId: args.orgId,
          receiptId,
          recoveryId: recovery._id,
          vehicleId: recovery.vehicleId,
          sourcedFromName: recovery.sourcedFromName,
          amountMinor: args.amountMinor,
          currency: recovery.currency,
          paymentMethod: args.method,
          receivedDate: args.receivedDate,
          actorId: user._id,
        });
        await ctx.db.patch(receiptId, { status: "LIVE" });

        const amountRecoveredMinor = recovery.amountRecoveredMinor + args.amountMinor;
        const status = recoveryStatusFor({
          amountDueMinor: recovery.amountDueMinor,
          amountRecoveredMinor,
          reversed: false,
        });
        await ctx.db.patch(recovery._id, { amountRecoveredMinor, receiptSeq: seq, status, updatedAt: now });

        await auditLog(ctx, {
          orgId: args.orgId,
          actorId: user._id,
          actionType: "ALLOCATE_PAYMENT",
          resourceType: "supplierCostRecoveries",
          resourceId: recovery._id,
          description: `Recovered ${args.amountMinor} (minor units, ${recovery.currency}) from ${recovery.sourcedFromName} against a supplier-borne vehicle cost.`,
          before: { amountRecoveredMinor: recovery.amountRecoveredMinor, status: recovery.status },
          after: { amountRecoveredMinor, status },
          idempotencyKey: args.idempotencyKey,
        });

        return {
          receiptId,
          amountRecoveredMinor,
          remainingMinor: recovery.amountDueMinor - amountRecoveredMinor,
          status,
        };
      }
    );
  },
});

/**
 * Reverses one recovery receipt — the correction for a receipt recorded in
 * error. Its own economic command: the engine's standard reversal of that
 * receipt's event, the receipt marked REVERSED (never deleted), and the
 * recovery's recovered amount and status re-derived in the same transaction.
 */
export const reverseReceipt = mutation({
  args: {
    orgId: v.id("organizations"),
    receiptId: v.id("supplierCostRecoveryReceipts"),
    reason: v.string(),
    /** Defaults to now. Must fall in an open period — the engine checks. */
    reversalDate: v.optional(v.number()),
    idempotencyKey: v.string(),
  },
  returns: v.object({
    amountRecoveredMinor: v.number(),
    remainingMinor: v.number(),
    status: recoveryStatusValidator,
  }),
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "supplierCostRecoveries.reverseReceipt",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          receiptId: args.receiptId,
          reason: args.reason,
          reversalDate: args.reversalDate ?? null,
        }),
      },
      async () => {
        const receipt = await requireOwnedRow(
          ctx,
          args.orgId,
          "supplierCostRecoveryReceipts",
          args.receiptId,
          "Recovery receipt not found."
        );
        const reason = args.reason.trim();
        if (!reason) throw new ConvexError("A reason is required to reverse a recovery receipt.");
        const now = Date.now();
        const reversalDate = args.reversalDate ?? now;
        assertPastInstant(reversalDate, "reversal date");
        if (reversalDate < receipt.receivedDate) {
          throw new ConvexError("A receipt cannot be reversed before the date it was received.");
        }
        if (receipt.status !== "LIVE") {
          throw new ConvexError("Only a recorded receipt can be reversed.");
        }
        const recovery = await requireOwnedRow(
          ctx,
          args.orgId,
          "supplierCostRecoveries",
          receipt.recoveryId,
          "Supplier cost recovery not found."
        );
        // Conversion to owned stock is allowed once nothing is owed; reversing a
        // receipt afterwards would reopen a claim against a supplier on a car
        // the dealership now owns.
        const vehicle = await ctx.db.get(recovery.vehicleId);
        if (vehicle?.sourceType !== "SOURCED") {
          throw new ConvexError(
            "This car is no longer a sourced vehicle, so its supplier cost recoveries are closed and cannot be reversed."
          );
        }
        const posting = await postingStateForKey(ctx, args.orgId, supplierCostRecoveryReceiptKey(receipt._id));
        if (posting.state !== "POSTED" || !posting.eventId) {
          throw new ConvexError("This receipt's ledger entry is not in a state that can be reversed.");
        }
        await reverseAccountingEvent(ctx, {
          orgId: args.orgId,
          originalEventId: posting.eventId,
          reversalDate,
          reason,
          actorId: user._id,
          idempotencyKey: supplierCostRecoveryReceiptReversalKey(receipt._id),
        });
        await ctx.db.patch(receipt._id, {
          status: "REVERSED",
          reversedAt: now,
          reversedBy: user._id,
          reversalReason: reason,
          reversalDate,
        });

        const amountRecoveredMinor = recovery.amountRecoveredMinor - receipt.amountMinor;
        if (amountRecoveredMinor < 0) {
          throw new ConvexError("This recovery's recorded total does not cover the receipt being reversed.");
        }
        const status = recoveryStatusFor({
          amountDueMinor: recovery.amountDueMinor,
          amountRecoveredMinor,
          reversed: recovery.status === "REVERSED",
        });
        await ctx.db.patch(recovery._id, { amountRecoveredMinor, status, updatedAt: now });

        await auditLog(ctx, {
          orgId: args.orgId,
          actorId: user._id,
          actionType: "REVERSE_ALLOCATION",
          resourceType: "supplierCostRecoveryReceipts",
          resourceId: receipt._id,
          description: `Reversed a ${receipt.amountMinor} (minor units, ${receipt.currency}) supplier cost recovery receipt: ${reason}`,
          before: { amountRecoveredMinor: recovery.amountRecoveredMinor, status: recovery.status },
          after: { amountRecoveredMinor, status },
          idempotencyKey: args.idempotencyKey,
        });

        return { amountRecoveredMinor, remainingMinor: recovery.amountDueMinor - amountRecoveredMinor, status };
      }
    );
  },
});
