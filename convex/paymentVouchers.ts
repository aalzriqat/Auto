import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { getOrgCurrency } from "./accounting/workflowHooks";
import { MAX_QUOTE_DEPOSITS, readPostedQuoteDepositMinor } from "./utils/firstPaymentEvidence";
import { denominationOf, toMinorUnits } from "./utils/money";
import { isConsignedAgentSale } from "./utils/vehicleOwnership";

export const getByDeposit = query({
  args: {
    orgId: v.id("organizations"),
    depositId: v.id("deposits"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    const voucher = await ctx.db
      .query("paymentVouchers")
      .withIndex("by_deposit", (q) => q.eq("depositId", args.depositId))
      .filter((q) => q.neq(q.field("isDeleted"), true))
      .first();
    if (!voucher || voucher.orgId !== args.orgId) return null;
    return voucher;
  },
});

export const listQuoteReceipts = query({
  args: {
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
  },
  returns: v.object({
    receipts: v.array(v.object({
      _id: v.id("deposits"),
      amount: v.number(),
      currency: v.optional(v.string()),
      status: v.union(v.literal("HELD"), v.literal("APPLIED"), v.literal("REFUNDED"),
        v.literal("FORFEITED"), v.literal("VOIDED")),
    })),
    truncated: v.boolean(),
  }),
  handler: async (ctx, { orgId, quoteId }) => {
    await requireTenantAuth(ctx, orgId, [PERMISSIONS.VIEW_SALES]);
    const quote = await requireOwnedRow(ctx, orgId, "quotes", quoteId);
    const limit = 50;
    const rows = await ctx.db.query("deposits")
      .withIndex("by_quote", (q) => q.eq("quoteId", quote._id))
      .order("desc")
      .take(limit + 1);
    const receipts = rows.slice(0, limit).reverse()
      .filter((row) => row.orgId === orgId && row.customerId === quote.customerId &&
        (row.isDeleted !== true || row.status === "VOIDED"))
      .map(({ _id, amount, currency, status }) => ({ _id, amount, currency, status }));
    return { receipts, truncated: rows.length > limit };
  },
});

/** Current receipt proof for an open dealer-stock cash quote. The posted
 * invoice takes over after closing. */
export const cashQuoteReceiptBalance = query({
  args: { orgId: v.id("organizations"), quoteId: v.id("quotes") },
  returns: v.union(v.null(), v.object({
    currency: v.string(), scale: v.number(), totalMinor: v.number(),
    receivedMinor: v.number(), remainingMinor: v.number(),
  })),
  handler: async (ctx, { orgId, quoteId }) => {
    await requireTenantAuth(ctx, orgId, [PERMISSIONS.VIEW_SALES]);
    const quote = await requireOwnedRow(ctx, orgId, "quotes", quoteId);
    if (quote.mode !== "CASH" || quote.status === "EXPIRED" || quote.supersededAt !== undefined ||
      (quote.vehicleItems !== undefined && quote.vehicleItems.length !== 1)) return null;
    const vehicle = await requireOwnedRow(ctx, orgId, "vehicles", quote.vehicleId);
    const item = quote.vehicleItems?.[0];
    if (vehicle.isDeleted || isConsignedAgentSale(vehicle) || (item && item.vehicleId !== vehicle._id)) return null;

    const [sale, denomination, rows] = await Promise.all([
      ctx.db.query("sales").withIndex("by_quote", (q) => q.eq("quoteId", quoteId)).first(),
      getOrgCurrency(ctx, orgId).then(denominationOf),
      ctx.db.query("deposits").withIndex("by_quote_status", (q) => q.eq("quoteId", quoteId).eq("status", "HELD"))
        .take(MAX_QUOTE_DEPOSITS + 1),
    ]);
    if (sale || !denomination || rows.length > MAX_QUOTE_DEPOSITS) return null;
    if (rows.some((row) => row.orgId !== orgId || row.customerId !== quote.customerId ||
      row.vehicleId !== vehicle._id || (!row.isDeleted && row.holdActive === undefined))) return null;
    const { code: currency, scale } = denomination;
    const price = item?.unitPrice ?? quote.vehiclePrice;
    if (price <= 0 || !Number.isSafeInteger(Math.round(price * 10 ** scale))) return null;
    const totalMinor = toMinorUnits(price, currency);
    const receivedMinor = await readPostedQuoteDepositMinor(ctx, {
      app: quote, deposits: rows, currency, cutoff: Date.now(),
    });
    if (totalMinor <= 0 || receivedMinor === null || receivedMinor > totalMinor) return null;
    return { currency, scale, totalMinor, receivedMinor, remainingMinor: totalMinor - receivedMinor };
  },
});
