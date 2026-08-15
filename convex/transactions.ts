import { v, ConvexError } from "convex/values";
import { query, QueryCtx, type DatabaseReader } from "./_generated/server";
import { mutation } from "./functions";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { notifyManagers, getActorName } from "./utils/notifications";
import { Doc, Id } from "./_generated/dataModel";

type LedgerTransaction = Doc<"transactions">;
type LedgerEntityContext = {
  vehicleId?: Id<"vehicles">;
  customerId?: Id<"customers">;
  quoteReference?: string;
  reservationReference?: string;
};
type LedgerContextByTransactionId = Map<Id<"transactions">, LedgerEntityContext>;

function vehicleLabel(vehicle: Doc<"vehicles">): string {
  return `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim();
}

function customerName(customer: Doc<"customers">): string {
  return `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim();
}

function quoteIdTextFromDescription(description: string): string | null {
  return (
    description.match(/^Deposit held for quote\s+([^\s-]+)/i)?.[1] ??
    description.match(/^Deposit(?: refund)? for quote\s+([^\s-]+)/i)?.[1] ??
    description.match(/^عربون للعرض\s+([^\s-]+)/)?.[1] ??
    description.match(/^استرداد عربون للعرض\s+([^\s-]+)/)?.[1] ??
    null
  );
}

async function contextFromDepositId(
  ctx: QueryCtx,
  transaction: LedgerTransaction
): Promise<LedgerEntityContext | null> {
  if (!transaction.depositId) return null;

  const deposit = await ctx.db.get(transaction.depositId);
  if (!deposit || deposit.orgId !== transaction.orgId || deposit.isDeleted === true) {
    return null;
  }

  const context: LedgerEntityContext = {
    vehicleId: deposit.vehicleId,
    customerId: deposit.customerId,
  };
  if (deposit.quoteId) context.quoteReference = deposit.quoteId.toString();
  if (deposit.reservationId) context.reservationReference = deposit.reservationId.toString();
  return context;
}

async function contextFromLegacyQuoteDescription(
  ctx: QueryCtx,
  transaction: LedgerTransaction
): Promise<LedgerEntityContext | null> {
  const quoteIdText = quoteIdTextFromDescription(transaction.description);
  if (!quoteIdText) return null;

  const quoteId = ctx.db.normalizeId("quotes", quoteIdText);
  if (!quoteId) return null;

  const quote = await ctx.db.get(quoteId);
  if (!quote || quote.orgId !== transaction.orgId) return null;

  return {
    vehicleId: quote.vehicleId,
    customerId: quote.customerId,
    quoteReference: quote._id.toString(),
  };
}

async function contextForDepositTransaction(
  ctx: QueryCtx,
  transaction: LedgerTransaction
): Promise<LedgerEntityContext | null> {
  return await contextFromDepositId(ctx, transaction) ??
    await contextFromLegacyQuoteDescription(ctx, transaction);
}

async function contextsForDepositTransactions(
  ctx: QueryCtx,
  transactions: LedgerTransaction[]
): Promise<LedgerContextByTransactionId> {
  const entries = await Promise.all(
    transactions.map(async (transaction) => {
      const context = await contextForDepositTransaction(ctx, transaction);
      return [transaction._id, context] as const;
    })
  );

  return new Map(
    entries.flatMap(([transactionId, context]) =>
      context ? [[transactionId, context] as const] : []
    )
  );
}

function vehicleIdsForLedgerRows(
  transactions: LedgerTransaction[],
  contextByTransactionId: LedgerContextByTransactionId
): Array<Id<"vehicles">> {
  const vehicleIds = transactions.flatMap((transaction) =>
    transaction.vehicleId ? [transaction.vehicleId] : []
  );
  for (const context of contextByTransactionId.values()) {
    if (context.vehicleId) vehicleIds.push(context.vehicleId);
  }
  return vehicleIds;
}

function customerIdsForLedgerRows(
  transactions: LedgerTransaction[],
  contextByTransactionId: LedgerContextByTransactionId
): Array<Id<"customers">> {
  const customerIds = transactions.flatMap((transaction) =>
    transaction.customerId ? [transaction.customerId] : []
  );
  for (const context of contextByTransactionId.values()) {
    if (context.customerId) customerIds.push(context.customerId);
  }
  return customerIds;
}

function enrichLedgerTransaction(
  transaction: LedgerTransaction,
  context: LedgerEntityContext | null,
  vehicles: Map<Id<"vehicles">, Doc<"vehicles">>,
  customers: Map<Id<"customers">, Doc<"customers">>
) {
  const vehicleId = transaction.vehicleId ?? context?.vehicleId;
  const vehicle = vehicleId ? vehicles.get(vehicleId) : null;
  const customerId = transaction.customerId ?? context?.customerId;
  const customer = customerId ? customers.get(customerId) : null;
  return {
    ...transaction,
    ...(vehicle ? { vehicleLabel: vehicleLabel(vehicle) } : {}),
    ...(customer ? { customerName: customerName(customer) } : {}),
    ...(context?.quoteReference ? { quoteReference: context.quoteReference } : {}),
    ...(context?.reservationReference ? { reservationReference: context.reservationReference } : {}),
  };
}

async function getRowsById<TTable extends "vehicles" | "customers">(
  ctx: QueryCtx,
  ids: Array<Id<TTable>>
): Promise<Map<Id<TTable>, Doc<TTable>>> {
  const uniqueIds = Array.from(new Set(ids));
  const docs = await Promise.all(uniqueIds.map((id) => ctx.db.get(id)));
  const pairs = docs.flatMap((doc) => doc ? [[doc._id, doc] as const] : []);
  return new Map(pairs);
}

async function enrichLedgerTransactions(
  ctx: QueryCtx,
  rows: LedgerTransaction[]
) {
  const depositRows = rows.filter((row) => row.category === "DEPOSIT");
  const contextByTransactionId = depositRows.length > 0
    ? await contextsForDepositTransactions(ctx, depositRows)
    : new Map<Id<"transactions">, LedgerEntityContext>();
  const vehicleIds = vehicleIdsForLedgerRows(rows, contextByTransactionId);
  const customerIds = customerIdsForLedgerRows(rows, contextByTransactionId);

  const [vehicles, customers] = await Promise.all([
    getRowsById(ctx, vehicleIds),
    getRowsById(ctx, customerIds),
  ]);

  return rows.map((row) => {
    const context = contextByTransactionId.get(row._id) ?? null;
    return enrichLedgerTransaction(row, context, vehicles, customers);
  });
}

export const list = query({
  args: {
    orgId: v.id("organizations"),
    paginationOpts: paginationOptsValidator,
    startDate: v.optional(v.number()),
    endDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    const q = ctx.db
      .query("transactions")
      .withIndex("by_org_date", (q) => q.eq("orgId", args.orgId))
      .order("desc");
    const pageResult = await q
      .filter((q) => {
        const notDeleted = q.neq(q.field("isDeleted"), true);
        if (args.startDate && args.endDate) {
          return q.and(
            notDeleted,
            q.gte(q.field("date"), args.startDate),
            q.lte(q.field("date"), args.endDate)
          );
        }
        return notDeleted;
      })
      .paginate(args.paginationOpts);

    const page = await enrichLedgerTransactions(ctx, pageResult.page);
    return { ...pageResult, page };
  },
});

/*
 * `transactions.add` used to live here, and is deliberately gone.
 *
 * It let any caller holding `manage:finance` insert a row into the operational
 * cashbook directly, choosing its own amount, date and category — including
 * VEHICLE_SALE, CAPITAL_INJECTION and PARTNER_DRAW. Nothing about that write
 * reached the authoritative books: no accounting event, no journal entry, no
 * period check, no `financialAuditLog`. It was a second place to record money.
 *
 * Its only caller in the entire repository was the mobile Accounting module,
 * which this change makes read-only. But a Convex `mutation` is a public API
 * endpoint, not an internal helper: it stays callable by any authenticated
 * client that holds the permission, whether or not the shipped UI offers a
 * button. Having zero callers is a reason it can be retired, not evidence that
 * it was unreachable.
 *
 * New financial activity now has exactly two doors: a real domain workflow (a
 * sale, an expense, a collection, a deposit, a work order — each of which
 * inserts its own cashbook row as a side effect of the thing that actually
 * happened) or an explicit manual journal entry. Both leave an audit trail.
 *
 * `transactionsGlDivergence.test.ts` fails the build if a public mutation in
 * this module ever inserts into `transactions` again.
 */

/**
 * Refuses to mutate a legacy cashbook row that the GL has already represented.
 *
 * `transactions` is the operational cashbook, not the authoritative ledger —
 * the books are `journalEntries` + `journalLines`. `migrateUnpostedTransactions`
 * copies a cashbook row into the GL and records an `accountingEvents` row with
 * `sourceType: "transactions"` and `sourceId` set to the transaction id. Once
 * that event is POSTED, the amount exists in two places, and only one of them
 * is the books.
 *
 * Editing or soft-deleting the cashbook row after that point changes the copy
 * nobody reports from, while the Trial Balance, P&L and Balance Sheet keep the
 * original figure. The user sees their correction succeed and the statements
 * disagree with it forever, with nothing to indicate which is right. A correction
 * after migration has to be a journal entry or an explicit reversal, both of
 * which leave an auditable trail — so this refuses rather than silently diverging.
 *
 * What counts as "represented" is REAL JOURNAL EVIDENCE, not the event's status
 * label. The status alone is wrong in both directions:
 *
 *   - REVERSED does NOT mean the GL forgot the row. `reversals.ts` patches the
 *     ORIGINAL event to REVERSED *in place*, keeps its `journalEntryId`, and
 *     posts a second, inverted entry beside it. Both halves stay in the books —
 *     `accountingReports.getPostedLines` deliberately reads REVERSED entries'
 *     lines, because dropping the original half of a cancelled pair would leave
 *     the reversal's inverted lines alone and turn a net-zero cancellation into
 *     a one-sided wrong balance. So a reversed row is represented in the GL
 *     twice, and editing the cashbook copy afterwards makes the surviving audit
 *     trail describe an amount that no longer exists at its own source.
 *   - POSTED does not by itself prove a journal entry exists, and a row can
 *     carry a `journalEntryId` under another status.
 *
 * So this blocks on POSTED, on REVERSED, and on any event that carries a
 * `journalEntryId` — whichever arrives first. PENDING and FAILED events with no
 * journal entry do not block: a queued event is not GL representation, and the
 * unmigrated cashbook is exactly what the legacy screen is still for. That is
 * the same POSTED/REVERSED-need-real-journal-evidence distinction Lane 5's
 * integrity diagnostic uses, rather than a second interpretation of status.
 *
 * Both writers below call this. They are the only two paths that patch a
 * `transactions` row (`transactions.ts:update` and `:remove`); every other
 * module only inserts. `transactionsGlDivergence.test.ts` fails if a third
 * writer appears without the guard.
 */
export async function assertNotRepresentedInGl(
  ctx: { db: DatabaseReader },
  orgId: Id<"organizations">,
  transactionId: Id<"transactions">
): Promise<void> {
  const events = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", orgId).eq("sourceType", "transactions").eq("sourceId", transactionId as string)
    )
    .collect();

  const representedInGl = events.some(
    (event) =>
      event.status === "POSTED" ||
      event.status === "REVERSED" ||
      event.journalEntryId !== undefined
  );

  if (representedInGl) {
    throw new ConvexError(
      "This entry has already been posted to the general ledger and can no longer be edited or deleted here. Record a correcting journal entry instead, so the change is auditable."
    );
  }
}

export const update = mutation({
  args: {
    orgId: v.id("organizations"),
    transactionId: v.id("transactions"),
    type: v.optional(v.union(v.literal("IN"), v.literal("OUT"))),
    amount: v.optional(v.number()),
    date: v.optional(v.number()),
    category: v.optional(v.union(
      v.literal("VEHICLE_SALE"), v.literal("VEHICLE_PURCHASE"),
      v.literal("EXPENSE"), v.literal("DEPOSIT"),
      v.literal("COLLECTION_PAYMENT"), v.literal("REFUND"),
      v.literal("PARTNER_DRAW"), v.literal("CAPITAL_INJECTION"),
      v.literal("CLAIM_PAYMENT"), v.literal("OTHER")
    )),
    description: v.optional(v.string()),
    vehicleId: v.optional(v.id("vehicles")),
    userId: v.optional(v.id("users")),
    expenseId: v.optional(v.id("expenses")),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const { orgId, transactionId, ...updates } = args;

    // Verify the transaction belongs to this org
    const transaction = await ctx.db.get(transactionId);
    if (!transaction || transaction.orgId !== orgId) {
      throw new ConvexError("Transaction not found in this organization.");
    }

    await assertNotRepresentedInGl(ctx, orgId, transactionId);

    if (updates.vehicleId) {
      const vehicle = await ctx.db.get(updates.vehicleId);
      if (!vehicle || vehicle.orgId !== orgId) {
        throw new ConvexError("Vehicle not found in this organization.");
      }
    }
    if (updates.expenseId) {
      const expense = await ctx.db.get(updates.expenseId);
      if (!expense || expense.orgId !== orgId) {
        throw new ConvexError("Expense not found in this organization.");
      }
    }

    // Clean up undefined optional values
    const cleanedUpdates = Object.fromEntries(
      Object.entries(updates).filter(([_, v]) => v !== undefined)
    );

    await ctx.db.patch(transactionId, cleanedUpdates);

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      orgId,
      "transaction.updated",
      { actorName },
      { link: `/${orgId}/accounting` }
    );
  },
});

// TODO: Add admin recovery endpoint if needed
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    transactionId: v.id("transactions"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
    const transaction = await ctx.db.get(args.transactionId);
    if (!transaction || transaction.orgId !== args.orgId) {
      throw new ConvexError("Transaction not found in this organization.");
    }

    // Same guard as `update`. A soft delete is not gentler than an edit here:
    // it removes the row from the cashbook while the GL keeps the posting, so
    // the two disagree in the direction that hides money rather than restates it.
    await assertNotRepresentedInGl(ctx, args.orgId, args.transactionId);

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new ConvexError("Unauthenticated");
    await ctx.db.patch(args.transactionId, {
      isDeleted: true,
      deletedAt: Date.now(),
      deletedBy: identity.subject
    });

    const actorName = await getActorName(ctx);
    await notifyManagers(
      ctx,
      args.orgId,
      "transaction.removed",
      { actorName },
      { link: `/${args.orgId}/accounting` }
    );
  },
});
