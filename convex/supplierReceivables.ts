import { v, ConvexError } from "convex/values";
import { query } from "./_generated/server";
import { mutation } from "./functions";
import { Doc, Id } from "./_generated/dataModel";
import { MutationCtx, QueryCtx } from "./_generated/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { runWithIdempotency } from "./utils/idempotency";
import { normalizePaymentMethod, paymentMethodValidator } from "./utils/paymentMethods";
import { fromMinorUnits, toMinorUnits } from "./utils/money";
import { hookSupplierReceivableCollected } from "./accounting/workflowHooks";
import { auditLog } from "./financialAudit";

/**
 * Collecting the dealership's agency margin from a supplier who was paid
 * directly by the buyer.
 *
 * The mirror of `sourcingPayables`, and shaped like it on purpose: the same
 * status vocabulary, the same refusal to store a derivable remainder, the same
 * over-application guard. A consigned deal settles one way or the other, and
 * somebody reading one module should not have to learn a second set of
 * conventions to read the other.
 *
 * What it is NOT is a general receivables ledger. It answers one question per
 * deal — has the supplier paid us our margin yet, and how much of it — because
 * that is the question the DIRECT_TO_SUPPLIER route creates and nothing else
 * in the system could answer.
 */

/** The claim as it should be read, with the remainder derived rather than stored. */
export interface SupplierReceivableView {
  status: Doc<"vehicleSupplierReceivables">["status"];
  amountDue: number;
  amountReceived: number;
  remainingAmount: number;
  /** Surfaced rather than clamped away: being overpaid is a real event. */
  overReceivedAmount: number;
}

export function supplierReceivableView(
  row: Doc<"vehicleSupplierReceivables">
): SupplierReceivableView {
  const amountReceived = row.amountReceived ?? 0;
  return {
    status: row.status,
    amountDue: row.amountDue,
    amountReceived,
    remainingAmount: Math.max(0, row.amountDue - amountReceived),
    overReceivedAmount: Math.max(0, amountReceived - row.amountDue),
  };
}

/**
 * Opens the claim when a consigned sale settles DIRECT_TO_SUPPLIER.
 *
 * `alreadyReceivedAmount` is the part of the margin the dealership is already
 * holding in cash because the customer's reservation deposit was applied to the
 * settlement. That application credits Receivable from Suppliers in the GL, so
 * seeding it here is what keeps the subledger and the ledger agreeing from the
 * first moment — otherwise the claim would open at the full margin while the GL
 * already showed part of it collected.
 */
export async function openSupplierReceivable(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    saleId: Id<"sales">;
    sourcedFromName: string;
    amountDue: number;
    currency: string;
    alreadyReceivedAmount?: number;
    actorId: Id<"users">;
  }
): Promise<Id<"vehicleSupplierReceivables"> | null> {
  if (!Number.isFinite(args.amountDue) || args.amountDue <= 0) return null;

  const received = args.alreadyReceivedAmount ?? 0;
  const now = Date.now();
  return await ctx.db.insert("vehicleSupplierReceivables", {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    saleId: args.saleId,
    sourcedFromName: args.sourcedFromName,
    amountDue: args.amountDue,
    currency: args.currency,
    status: received >= args.amountDue ? "PAID" : received > 0 ? "PARTIALLY_PAID" : "OPEN",
    amountReceived: received > 0 ? received : undefined,
    ...(received >= args.amountDue ? { settledAt: now, settledBy: args.actorId } : {}),
    createdBy: args.actorId,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * How many receipts have already posted against this claim. The GL event is
 * keyed on it, so a second instalment of the same amount is a distinct event
 * rather than a duplicate suppressed by idempotency.
 */
function receiptSeqFor(row: Doc<"vehicleSupplierReceivables">): number {
  return row.receiptSeq ?? 0;
}

/**
 * Loads a claim and proves it belongs to the named org.
 *
 * Written out at each call site rather than hidden behind this helper, because
 * `scripts/tenantWriteGuard` reads the handler source and cannot see through a
 * function call — a guard it cannot see is a guard that stops being enforced
 * the moment somebody edits the helper. Kept here only for the error text.
 */
function receivableNotFound(): never {
  // Fails closed and identically for a missing and a foreign row, so the
  // response cannot be used to probe another org's records.
  throw new ConvexError("Supplier receivable not found.");
}

export const list = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(
      v.union(
        v.literal("OPEN"),
        v.literal("PARTIALLY_PAID"),
        v.literal("PAID"),
        v.literal("DISPUTED"),
        v.literal("CANCELLED")
      )
    ),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    const rows = args.status
      ? await ctx.db
          .query("vehicleSupplierReceivables")
          .withIndex("by_org_status", (q) => q.eq("orgId", args.orgId).eq("status", args.status!))
          .take(500)
      : await ctx.db
          .query("vehicleSupplierReceivables")
          .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
          .take(500);

    return await Promise.all(
      rows.map(async (row) => {
        const vehicle = await ctx.db.get(row.vehicleId);
        return {
          ...row,
          ...supplierReceivableView(row),
          vehicleLabel: vehicle
            ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim()
            : "Vehicle",
          vin: vehicle?.vin,
        };
      })
    );
  },
});

/**
 * What suppliers still owe the dealership in agency margin, in total and by
 * supplier. The aging view the GL balance alone could never produce.
 */
export const outstandingSummary = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);

    const rows = await ctx.db
      .query("vehicleSupplierReceivables")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .take(1000);

    let totalDue = 0;
    let totalReceived = 0;
    let totalOutstanding = 0;
    let disputedAmount = 0;
    const bySupplier = new Map<string, { outstanding: number; claims: number }>();

    for (const row of rows) {
      if (row.status === "CANCELLED") continue;
      const view = supplierReceivableView(row);
      totalDue += view.amountDue;
      totalReceived += view.amountReceived;
      totalOutstanding += view.remainingAmount;
      if (row.status === "DISPUTED") disputedAmount += view.remainingAmount;
      if (view.remainingAmount > 0) {
        const entry = bySupplier.get(row.sourcedFromName) ?? { outstanding: 0, claims: 0 };
        entry.outstanding += view.remainingAmount;
        entry.claims += 1;
        bySupplier.set(row.sourcedFromName, entry);
      }
    }

    return {
      totalDue,
      totalReceived,
      totalOutstanding,
      disputedAmount,
      bySupplier: Array.from(bySupplier.entries())
        .map(([sourcedFromName, v2]) => ({ sourcedFromName, ...v2 }))
        .sort((a, b) => b.outstanding - a.outstanding),
    };
  },
});

/**
 * Records money actually received from a supplier against his claim — the whole
 * remaining balance or part of it, they are the same operation.
 *
 * `markSettled` does not exist as a separate mutation on purpose. A "mark as
 * paid" that takes no amount is how a subledger drifts from the ledger: it
 * records a status without recording money, and the two then disagree about a
 * figure only one of them moved.
 */
export const recordReceipt = mutation({
  args: {
    orgId: v.id("organizations"),
    receivableId: v.id("vehicleSupplierReceivables"),
    amount: v.number(),
    receiptMethod: v.optional(paymentMethodValidator),
    /** Cheque number or transfer reference. */
    receiptReference: v.optional(v.string()),
    /** The bank or cash account the money arrived in. */
    receiptAccountId: v.optional(v.id("chartOfAccounts")),
    receiptNotes: v.optional(v.string()),
    /** Defaults to now; set it when recording a receipt that landed earlier. */
    receivedAt: v.optional(v.number()),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const receiptMethod = normalizePaymentMethod(args.receiptMethod);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "supplierReceivables.recordReceipt",
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        // EVERY persisted input that can change the stored record. `receivedAt`
        // was missing, and it is the one the cockpit lets an operator correct:
        // because the caller deliberately REUSES its key after a lost response,
        // a retry with a fixed date produced an identical fingerprint and was
        // replayed back as success while the ledger kept the original date.
        fingerprint: JSON.stringify({
          receivableId: args.receivableId,
          amount: args.amount,
          receiptMethod,
          receiptReference: args.receiptReference ?? null,
          receiptAccountId: args.receiptAccountId ?? null,
          receiptNotes: args.receiptNotes ?? null,
          receivedAt: args.receivedAt ?? null,
        }),
      },
      async () => {
        const row = await ctx.db.get(args.receivableId);
        if (!row || row.orgId !== args.orgId) receivableNotFound();

        if (!Number.isFinite(args.amount) || args.amount <= 0) {
          throw new ConvexError("A receipt must be greater than zero.");
        }
        // The amount must be representable in the claim's currency. JOD carries
        // three decimals, so a half-fils receipt cannot be posted: the subledger
        // would store it verbatim while the journal rounded, and two receipts of
        // 0.0005 would mark a 0.001 claim PAID while crediting two fils against
        // a one-fils receivable. Checked here rather than in the dialog, because
        // this mutation is now reachable from a browser.
        if (fromMinorUnits(toMinorUnits(args.amount, row.currency), row.currency) !== args.amount) {
          throw new ConvexError(
            `A receipt in ${row.currency} cannot be finer than the currency allows. Round ${args.amount} to the nearest representable amount.`
          );
        }
        // `receivedAt` reaches `settledAt` and the accounting event. A skewed
        // clock, a modified client or a direct call could otherwise mark a large
        // claim paid against a journal dated in the future — or NaN, which every
        // comparison guard silently passes.
        if (args.receivedAt !== undefined) {
          if (!Number.isSafeInteger(args.receivedAt) || args.receivedAt <= 0) {
            throw new ConvexError("The receipt date is not a valid instant.");
          }
          if (args.receivedAt > Date.now()) {
            throw new ConvexError("A receipt cannot be dated in the future.");
          }
        }
        if (row.status === "CANCELLED") {
          throw new ConvexError("This claim was cancelled with its sale.");
        }
        if (row.status === "PAID") {
          throw new ConvexError("This claim is already settled in full.");
        }
        if (row.status === "DISPUTED") {
          throw new ConvexError(
            "This claim is under dispute. Resolve the dispute before recording money against it."
          );
        }

        const alreadyReceived = row.amountReceived ?? 0;
        const projected = alreadyReceived + args.amount;
        // Both comparisons below are made in the currency's integer minor units.
        //
        // In major units they were float comparisons against an accumulated
        // float, and that combination made a claim permanently unsettleable: a
        // 4.440 JOD claim collected as three receipts of 1.480 accumulates to
        // 4.4399999999999995, so `=== amountDue` was false and the claim stayed
        // PARTIALLY_PAID — while `> amountDue` rejected any further receipt,
        // because the residue owing is under a thousandth of a fils. The
        // supplier had paid in full and no amount existed that could close it.
        const dueMinor = toMinorUnits(row.amountDue, row.currency);
        const projectedMinor = toMinorUnits(projected, row.currency);
        // Being paid more than you are owed is a real error with real money
        // behind it, and absorbing it into the claim hides which deal it
        // happened on. Same refusal as the payable side.
        if (projectedMinor > dueMinor) {
          throw new ConvexError(
            `That would record ${projected} against ${row.amountDue} owed. Reduce the amount, or correct the claim first.`
          );
        }

        const now = args.receivedAt ?? Date.now();
        const settlesInFull = projectedMinor === dueMinor;
        const receiptSeq = receiptSeqFor(row) + 1;

        await ctx.db.patch(args.receivableId, {
          amountReceived: projected,
          status: settlesInFull ? "PAID" : "PARTIALLY_PAID",
          ...(settlesInFull ? { settledAt: now, settledBy: user._id } : {}),
          receiptMethod,
          receiptReference: args.receiptReference,
          receiptAccountId: args.receiptAccountId,
          receiptNotes: args.receiptNotes,
          receiptSeq,
          updatedAt: Date.now(),
        });

        await hookSupplierReceivableCollected(ctx, {
          orgId: args.orgId,
          receivableId: args.receivableId,
          vehicleId: row.vehicleId,
          sourcedFromName: row.sourcedFromName,
          amountMinor: toMinorUnits(args.amount, row.currency),
          currency: row.currency,
          paymentMethod: receiptMethod,
          receiptSeq,
          actorId: user._id,
          occurredAt: now,
        });

        await auditLog(ctx, {
          orgId: args.orgId,
          actorId: user._id,
          actionType: "ALLOCATE_PAYMENT",
          resourceType: "vehicleSupplierReceivables",
          resourceId: args.receivableId,
          description: `Received ${args.amount} ${row.currency} from ${row.sourcedFromName} against a consigned-sale commission claim of ${row.amountDue}.`,
          before: { amountReceived: alreadyReceived, status: row.status },
          after: { amountReceived: projected, status: settlesInFull ? "PAID" : "PARTIALLY_PAID" },
          idempotencyKey: args.idempotencyKey,
        });

        return {
          amountReceived: projected,
          remainingAmount: row.amountDue - projected,
          status: settlesInFull ? ("PAID" as const) : ("PARTIALLY_PAID" as const),
        };
      }
    );
  },
});

/**
 * Marks a claim as disputed, or lifts the dispute.
 *
 * A disputed claim is not one that happens to be unpaid — it is one the two
 * sides do not agree on. Recording receipts against it is refused while it
 * stands, so a disagreement cannot be closed by quietly banking something.
 */
export const setDisputed = mutation({
  args: {
    orgId: v.id("organizations"),
    receivableId: v.id("vehicleSupplierReceivables"),
    disputed: v.boolean(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const row = await ctx.db.get(args.receivableId);
    if (!row || row.orgId !== args.orgId) receivableNotFound();

    if (row.status === "CANCELLED") {
      throw new ConvexError("This claim was cancelled with its sale.");
    }
    if (row.status === "PAID") {
      throw new ConvexError("This claim is already settled in full.");
    }
    if (args.disputed && !args.reason?.trim()) {
      throw new ConvexError("Say what is disputed — a dispute with no reason cannot be resolved.");
    }

    const now = Date.now();
    if (args.disputed) {
      await ctx.db.patch(args.receivableId, {
        status: "DISPUTED",
        disputeReason: args.reason,
        disputedAt: now,
        disputedBy: user._id,
        updatedAt: now,
      });
    } else {
      // Back to whatever the money says, not to a remembered status: a
      // stored one could disagree with the receipts recorded meanwhile.
      const received = row.amountReceived ?? 0;
      await ctx.db.patch(args.receivableId, {
        status: received > 0 ? "PARTIALLY_PAID" : "OPEN",
        disputeReason: undefined,
        disputedAt: undefined,
        disputedBy: undefined,
        updatedAt: now,
      });
    }
    return { status: args.disputed ? "DISPUTED" : row.amountReceived ? "PARTIALLY_PAID" : "OPEN" };
  },
});

/**
 * Cancels the claims belonging to a sale being cancelled.
 *
 * Refuses when money has already arrived, for the same reason the payable side
 * refuses: unwinding a receipt is a correction somebody has to make
 * deliberately, not something a cancellation should do on its way past.
 */
export async function cancelSupplierReceivablesForSale(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    actorId: Id<"users">;
    now: number;
  }
): Promise<void> {
  const rows = await ctx.db
    .query("vehicleSupplierReceivables")
    .withIndex("by_sale", (q) => q.eq("saleId", args.saleId))
    .collect();
  const owned = rows.filter((row) => row.orgId === args.orgId);

  // Keyed on receipts actually recorded, not on `amountReceived`. A claim can
  // open with part of it already received because the customer's reservation
  // deposit was applied to the settlement — that is the dealership holding its
  // own margin in customer cash, not the supplier having paid, and cancelling
  // reverses that deposit application anyway. Refusing on it would have made
  // any direct-settled sale with a settlement-applied deposit permanently
  // uncancellable.
  if (owned.some((row) => (row.receiptSeq ?? 0) > 0)) {
    throw new ConvexError(
      "Cannot automatically cancel a sale after the supplier has paid against its commission claim. Use a manual accounting correction."
    );
  }

  for (const row of owned) {
    if (row.status === "CANCELLED") continue;
    await ctx.db.patch(row._id, {
      status: "CANCELLED",
      cancelledAt: args.now,
      cancelledBy: args.actorId,
      updatedAt: args.now,
    });
  }
}

/** Reads the claims raised by one sale. Used by tests and by reconciliation. */
export async function supplierReceivablesForSale(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  saleId: Id<"sales">
): Promise<Doc<"vehicleSupplierReceivables">[]> {
  const rows = await ctx.db
    .query("vehicleSupplierReceivables")
    .withIndex("by_org_sale", (q) => q.eq("orgId", orgId).eq("saleId", saleId))
    .collect();
  return rows;
}
