/**
 * The legacy operational CASHBOOK — read-only.
 *
 * These rows are not the general ledger. The authoritative books are
 * `journalEntries` + `journalLines`. Rows here are written as a side effect of
 * the domain event that caused them (a sale, an expense, a collection, a
 * deposit, a work order), and this module deliberately exposes no way to create,
 * edit or delete one. See the note at the bottom of the file for why the write
 * mutations were removed rather than guarded.
 */
import { v } from "convex/values";
import { query, QueryCtx } from "./_generated/server";
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

/*
 * Why a "refuse if already represented in the GL" guard was tried, and dropped.
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
 * Kept as history because it is the reasoning that led here, and because the
 * same trap recurs elsewhere in this codebase: a status label is not evidence of
 * GL representation, the journal entry is. But the guard is gone — see below for
 * why a guard was the wrong shape for this problem entirely.
 */

/*
 * `transactions.update` and `transactions.remove` are gone for the same reason,
 * and the guard that used to protect them is gone with them.
 *
 * The guard asked "is this row already represented in the GL?" by looking for an
 * `accountingEvents` row keyed `sourceType: "transactions"`, `sourceId` = the
 * transaction id. That key is written by exactly ONE producer in the codebase:
 * `migrateUnpostedTransactions`, backfilling legacy pre-cutover rows.
 *
 * Every real-time domain workflow posts its GL exposure against the DOMAIN
 * entity instead. `vehicles.ts` inserts the VEHICLE_PURCHASE cashbook row and
 * then calls `hookVehicleAcquired`, which posts `sourceType: "vehicles"`;
 * `saleHelpers` posts `"sales"`, `expenses` posts `"expenses"`, the deposit
 * helpers post `"deposits"`, `collections` posts `"collectionPayments"`.
 * `accountingMigration.ts` documents this mismatch explicitly — its own
 * VEHICLE_ACQUIRED check exists precisely because "the lookup above can never
 * find it there."
 *
 * So the guard could not see the postings that matter. A read-only audit of
 * production found 113 cashbook rows and ZERO events keyed to `"transactions"`:
 * it protected nothing that exists today, and would have started protecting
 * things only after the SCRUM-4 cutover ran.
 *
 * The fix is not a longer guard. Recovering "which GL posting represents this
 * cashbook row" means re-deriving a link the schema does not store — there is no
 * foreign key from a `transactions` row to its journal entry, which is why
 * `saleCancellation.ts` has to find its rows by (org, vehicle, category,
 * customer) instead. Any enumeration of domain link types fails OPEN on the
 * cases it forgot, and a guard that fails open on an unknown row is not a guard.
 *
 * Neither mutation had a caller in the product once the mobile Accounting module
 * became read-only. So the module is now READ-ONLY: `list` and nothing else. A
 * cashbook row is written only as a side effect of the domain event that caused
 * it, and corrected only by a journal entry against the books themselves — which
 * is what SCRUM-53 asks for and what leaves an audit trail.
 *
 * One system path still soft-deletes cashbook rows: `voidSaleCashflowTransaction`
 * in `utils/saleCancellation.ts`, when a completed sale is cancelled. That is
 * correct and deliberately left alone — it runs inside the cancellation that
 * ALSO reverses the sale's GL posting, so the two move together instead of
 * diverging. `transactionsGlDivergence.test.ts` holds that inventory explicitly.
 */
