import { v, ConvexError } from "convex/values";
import { query, QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import { paginationOptsValidator } from "convex/server";
import { requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
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

/**
 * The legacy `transactions` cashbook is a read-only operational projection.
 *
 * It is NOT the books. The authoritative accounting record is
 * `accountingEvents` -> `journalEntries` / `journalLines`. A row in this table
 * is a cash-movement projection that the owning domain workflow writes in the
 * same atomic operation that owns the accounting event.
 *
 * These three mutations were the generic door into that table: a finance user
 * could add, edit or delete something the UI presented as Accounting while the
 * real books did not move at all. That is a shadow ledger — a false book — and
 * it is the SCRUM-53 defect.
 *
 * The refusal is UNCONDITIONAL and deliberately so. An earlier revision tried to
 * refuse only rows that were "already represented in the GL", and that guard
 * protected nothing: this table carries no marker naming the posting that
 * represents a row, and `sourceType: "transactions"` cannot prove which domain
 * posting owns one. A guard that has to guess representation fails open on every
 * row it guesses wrong. So no row is writable through this surface, and there is
 * nothing to guess.
 *
 * This is containment, not the whole retirement. The three names remain exported
 * so that installed mobile clients — which bind Convex functions by hand-written
 * string reference in `apps/mobile/src/convexApi.ts`, not through the generated
 * api — receive an explicit refusal instead of a "function not found". Deleting
 * the names is the ordered client-second stage and is tracked separately.
 *
 * New financial activity originates only from the owning domain workflow or from
 * an authoritative Manual Journal, which posts to the GL and is subject to
 * period, approval and audit control.
 */
function refuseLegacyLedgerWrite(operation: string): never {
  throw new ConvexError(
    `The cash movements list is view only and is not the General Ledger. ` +
      `'${operation}' has been retired: it changed this list without changing the books. ` +
      `Record this through the workflow that owns it, or through a Manual Journal.`
  );
}

/**
 * RETIRED. Refuses before authentication, before any read, and before any write.
 *
 * The args validator is kept so a stale installed client gets this refusal
 * rather than an argument-shape error, which would read as a transient bug and
 * invite a retry.
 */
export const add = mutation({
  args: {
    orgId: v.id("organizations"),
    type: v.union(v.literal("IN"), v.literal("OUT")),
    amount: v.number(),
    date: v.number(),
    category: v.union(
      v.literal("VEHICLE_SALE"), v.literal("VEHICLE_PURCHASE"),
      v.literal("EXPENSE"), v.literal("DEPOSIT"),
      v.literal("COLLECTION_PAYMENT"), v.literal("REFUND"),
      v.literal("PARTNER_DRAW"), v.literal("CAPITAL_INJECTION"),
      v.literal("CLAIM_PAYMENT"), v.literal("OTHER")
    ),
    description: v.string(),
    vehicleId: v.optional(v.id("vehicles")),
    userId: v.optional(v.id("users")),
    expenseId: v.optional(v.id("expenses")),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (): Promise<never> => refuseLegacyLedgerWrite("transactions.add"),
});

/** RETIRED. See {@link refuseLegacyLedgerWrite}. */
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
  handler: async (): Promise<never> => refuseLegacyLedgerWrite("transactions.update"),
});

/** RETIRED. See {@link refuseLegacyLedgerWrite}. */
export const remove = mutation({
  args: {
    orgId: v.id("organizations"),
    transactionId: v.id("transactions"),
  },
  handler: async (): Promise<never> => refuseLegacyLedgerWrite("transactions.remove"),
});
