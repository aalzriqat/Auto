import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { requireFeature } from "./subscriptions";
import { STATEMENT_PERMISSIONS } from "./supplierStatement";
import { readSupplierOutstanding, type ObligationRow, type StatementTotal } from "./utils/supplierObligationDue";
import { SUPPLIER_NOT_FOUND_MESSAGE } from "./utils/supplierRegistry";

/** Read-only projections of the statement, never a second financial balance (SCRUM-929 ADR). */
const currencyBalance = v.object({
  currency: v.string(), payableMinor: v.number(), receivableMinor: v.number(), netMinor: v.number(),
  overduePayableMinor: v.number(), overdueReceivableMinor: v.number(),
  disputedPayableMinor: v.number(), disputedReceivableMinor: v.number(),
  oldestDueDate: v.union(v.string(), v.null()),
});
const balanceRow = v.object({
  supplierId: v.id("suppliers"), supplier: v.string(), complete: v.boolean(), currencies: v.array(currencyBalance),
});

function validateClock(nowMs: number) {
  if (!Number.isSafeInteger(nowMs) || Math.abs(nowMs) > 8.64e15) {
    throw new ConvexError("The aging time must be a valid whole number of milliseconds.");
  }
}

function oldestDueDate(rows: readonly ObligationRow[], currency: string): string | null {
  let oldest: string | null = null;
  for (const row of rows) {
    if (row.currency === currency && row.dueDate !== null && (oldest === null || row.dueDate < oldest)) oldest = row.dueDate;
  }
  return oldest;
}

async function readBalance(ctx: QueryCtx, supplier: Doc<"suppliers">, nowMs: number) {
  const { payable, receivable } = await readSupplierOutstanding(ctx, { orgId: supplier.orgId, supplierId: supplier._id, nowMs });
  const identity = { supplierId: supplier._id, supplier: supplier.displayName };
  // One unread side makes the combined row unavailable. A missing currency is not evidence of zero on that side.
  if (!payable.complete || !receivable.complete) return { ...identity, complete: false, currencies: [] };
  const currencies = [...new Set([...payable.totals, ...receivable.totals].map(t => t.currency))].sort();
  const amount = (totals: StatementTotal[], currency: string) => totals.find(t => t.currency === currency);
  return {
    ...identity, complete: true,
    currencies: currencies.map(currency => {
      const ap = amount(payable.totals, currency);
      const ar = amount(receivable.totals, currency);
      const payableMinor = ap?.grossMinor ?? 0;
      const receivableMinor = ar?.grossMinor ?? 0;
      return {
        currency, payableMinor, receivableMinor, netMinor: receivableMinor - payableMinor,
        overduePayableMinor: ap?.overdueMinor ?? 0, overdueReceivableMinor: ar?.overdueMinor ?? 0,
        disputedPayableMinor: ap?.disputedMinor ?? 0, disputedReceivableMinor: ar?.disputedMinor ?? 0,
        oldestDueDate: oldestDueDate([...payable.rows, ...receivable.rows], currency),
      };
    }),
  };
}

async function guardedRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    console.error("Supplier balances read failed", error);
    throw new ConvexError("Unable to load supplier balances. Please try again later.");
  }
}

export const list = query({
  args: { orgId: v.id("organizations"), nowMs: v.number(), cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.object({ page: v.array(balanceRow), complete: v.boolean(), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, STATEMENT_PERMISSIONS);
    await requireFeature(ctx, args.orgId, "accounting");
    validateClock(args.nowMs);
    return guardedRead(async () => {
      // Exactly one pagination call. Five suppliers also bound worst-case registry document bytes.
      const suppliers = await ctx.db.query("suppliers").withIndex("by_org_and_status", q => q.eq("orgId", args.orgId))
        .paginate({ cursor: args.cursor ?? null, numItems: 5, maximumBytesRead: 2 * 1024 * 1024 });
      const page: Awaited<ReturnType<typeof readBalance>>[] = [];
      // Shared transaction headroom must be spent in order, never in Promise.all.
      for (const supplier of suppliers.page) page.push(await readBalance(ctx, supplier, args.nowMs));
      return {
        page, isDone: suppliers.isDone, continueCursor: suppliers.continueCursor,
        complete: !args.cursor && suppliers.isDone && page.every(row => row.complete),
      };
    });
  },
});

/** Same projection for the detail summary tiles. It does not alter the statement response or its figures. */
export const get = query({
  args: { orgId: v.id("organizations"), supplierId: v.id("suppliers"), nowMs: v.number() },
  returns: balanceRow,
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, STATEMENT_PERMISSIONS);
    await requireFeature(ctx, args.orgId, "accounting");
    validateClock(args.nowMs);
    const supplier = await requireOwnedRow(ctx, args.orgId, "suppliers", args.supplierId, SUPPLIER_NOT_FOUND_MESSAGE);
    return guardedRead(() => readBalance(ctx, supplier, args.nowMs));
  },
});
