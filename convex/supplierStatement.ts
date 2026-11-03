import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { requireFeature } from "./subscriptions";
import { readSupplierOutstanding } from "./utils/supplierObligationDue";
import { SUPPLIER_NOT_FOUND_MESSAGE } from "./utils/supplierRegistry";

/**
 * SCRUM-869 slice 1 - one supplier's outstanding A/P and A/R (ADR
 * docs/adr/2026-11-03-supplier-statement-outstanding-query.md). Reads only, stores nothing.
 * A/P and A/R are returned as two sections with per-currency totals each; there is deliberately
 * no net, balance or difference field, and nothing here adds one to the other.
 */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

const row = v.object({
  kind: v.union(v.literal("PAYABLE"), v.literal("RECEIVABLE"), v.literal("RECOVERY")),
  id: v.string(),
  currency: v.string(),
  outstandingMinor: v.number(),
  disputedMinor: v.number(),
  dueAt: v.union(v.number(), v.null()),
  dueDate: v.union(v.string(), v.null()),
  rule: v.string(),
  explanation: v.string(),
  daysOverdue: v.union(v.number(), v.null()),
  bucket: v.string(),
});
const section = v.object({
  rows: v.array(row),
  totals: v.array(
    v.object({ currency: v.string(), grossMinor: v.number(), disputedMinor: v.number(), overdueMinor: v.number() })
  ),
  complete: v.boolean(),
});

export const outstanding = query({
  args: {
    orgId: v.id("organizations"),
    supplierId: v.id("suppliers"),
    /** The caller's "now" (see `supplierDueAging.list`): validated, not trusted. */
    nowMs: v.number(),
  },
  returns: v.object({ supplierId: v.id("suppliers"), payable: section, receivable: section }),
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    if (!Number.isSafeInteger(args.nowMs) || Math.abs(args.nowMs - Date.now()) > MAX_CLOCK_SKEW_MS) {
      throw new ConvexError("nowMs must be a whole number of milliseconds within one day of the server clock.");
    }
    await requireOwnedRow(ctx, args.orgId, "suppliers", args.supplierId, SUPPLIER_NOT_FOUND_MESSAGE);
    const { payable, receivable } = await readSupplierOutstanding(ctx, args);
    return { supplierId: args.supplierId, payable, receivable };
  },
});
