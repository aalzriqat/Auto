import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { requireFeature } from "./subscriptions";
import { readSupplierOutstanding, readSupplierSettled } from "./utils/supplierObligationDue";
import { readSupplierPaymentsReconciliation } from "./utils/supplierPaymentsReconciliation";
import { SUPPLIER_NOT_FOUND_MESSAGE } from "./utils/supplierRegistry";
import { addSupplierRowContext, supplierNavigationFailure, supplierRowContextValidator } from "./utils/supplierNavigation";
import { createSupplierReadCache } from "./utils/supplierReadCache";
import { paginationOptsValidator } from "convex/server";
import { ammanDateString } from "./utils/supplierDueDates";
import { attentionKind, attentionPage, readAttention, unlinkedPresence, unlinkedStatus } from "./utils/supplierAttention";

/**
 * SCRUM-869 slice 1 - one supplier's outstanding A/P and A/R (ADR
 * docs/adr/2026-11-03-supplier-statement-outstanding-query.md). Reads only, stores nothing.
 * A/P and A/R are returned as two sections with per-currency totals each; there is deliberately
 * no net, balance or difference field, and nothing here adds one to the other.
 */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * A SOURCED (consigned) car's supplier entitlement equals its acquisition cost, so the statement's amounts are cost-derived.
 * Finance access alone does not grant cost access (SCRUM-886 / ACC-10, OWASP API3): both are required, enforced here on the
 * server for the rows and the totals alike. The screen asks for the same pair before it queries.
 */
export const STATEMENT_PERMISSIONS = [PERMISSIONS.VIEW_FINANCE, PERMISSIONS.VIEW_COST_PRICE];

/** Permission denial withholds cost-derived reads; tenant and impersonation failures still throw. */
async function mayReadStatement(ctx: QueryCtx, orgId: Id<"organizations">): Promise<boolean> {
  const { role } = await requireTenantAuth(ctx, orgId);
  return isSystemOwnerRole(role) || STATEMENT_PERMISSIONS.every(permission => role.permissions.includes(permission));
}

const row = v.object({
  context: supplierRowContextValidator,
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
/** ROW_LIMIT: more rows than the per-family cap. READ_BUDGET: the transaction had no room to read them all (bytes, not rows). */
const incompleteReason = v.union(v.literal("ROW_LIMIT"), v.literal("READ_BUDGET"));
const section = v.object({
  rows: v.array(row),
  totals: v.array(
    v.object({ currency: v.string(), grossMinor: v.number(), disputedMinor: v.number(), overdueMinor: v.number() })
  ),
  complete: v.boolean(),
  incompleteReason: v.optional(incompleteReason),
});

const settledRow = v.object({
  context: supplierRowContextValidator,
  kind: v.union(v.literal("PAYABLE"), v.literal("RECEIVABLE"), v.literal("RECOVERY")),
  id: v.string(),
  currency: v.string(),
  status: v.string(),
  dueMinor: v.number(),
  settledMinor: v.number(),
  /**
   * Whether the obligation is settled in full, derived on the server. Not `settledMinor >= dueMinor`: for a margin claim the cash
   * leaves out the customer deposit applied to it, so a claim closed by deposit + a smaller receipt is COMPLETE.
   */
  settlement: v.union(v.literal("COMPLETE"), v.literal("PARTIAL")),
  lastChangedAt: v.number(),
  /** RECORDED payments or receipts, or a legacy PAID payable whose amount is inferred from its status. */
  basis: v.union(v.literal("RECORDED"), v.literal("INFERRED_FROM_PAID_STATUS")),
});
const settledSection = v.object({
  rows: v.array(settledRow),
  totals: v.array(v.object({ currency: v.string(), settledMinor: v.number() })),
  complete: v.boolean(),
  incompleteReason: v.optional(incompleteReason),
  /** Margin claims with a recorded supplier receipt that could not be read back from the ledger; their cash is unknown. */
  unverifiedCount: v.number(),
});

/**
 * SCRUM-869 slice 4 - what this supplier has been paid (A/P) and has paid back (A/R): settled and
 * part-settled rows with the cash actually moved, newest first. A/R shows supplier receipts established from their
 * postings, not `amountReceived` (which includes customer deposits applied to the settlement). Same gate and tenancy
 * as `outstanding`; no net field, no currency blending.
 */
export const settled = query({
  args: { orgId: v.id("organizations"), supplierId: v.id("suppliers") },
  returns: v.object({ supplierId: v.id("suppliers"), payable: settledSection, receivable: settledSection }),
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, STATEMENT_PERMISSIONS);
    await requireFeature(ctx, args.orgId, "accounting");
    await requireOwnedRow(ctx, args.orgId, "suppliers", args.supplierId, SUPPLIER_NOT_FOUND_MESSAGE);
    const result = await readSupplierSettled(ctx, args);
    try {
      const scope = { ...args, permissions: role.permissions, cache: createSupplierReadCache() };
      const payable = await addSupplierRowContext(ctx, scope, result.payable);
      const receivable = await addSupplierRowContext(ctx, scope, result.receivable);
      return { supplierId: args.supplierId, payable, receivable };
    } catch (error) { return supplierNavigationFailure(error); }
  },
});

/**
 * SCRUM-869 - what was paid to one supplier according to the subledger, against the net debit to GL 2400 posted
 * against that supplier's payables (ADR docs/adr/2026-11-04-supplier-payments-gl-reconciliation.md). The obligation
 * side has no supplier dimension on the ledger and is reported as NOT_ATTRIBUTABLE, never as a number. Read-only.
 */
export const paymentsReconciliation = query({
  args: { orgId: v.id("organizations"), supplierId: v.id("suppliers") },
  returns: v.object({
    supplierId: v.id("suppliers"),
    status: v.union(v.literal("AVAILABLE"), v.literal("UNAVAILABLE")),
    unavailableReason: v.optional(
      v.union(
        v.literal("OVER_LIMIT"),
        v.literal("PENDING_POSTINGS"),
        v.literal("NO_CONTROL_ACCOUNT"),
        v.literal("INCONSISTENT_REFERENCE"),
      ),
    ),
    currencies: v.array(
      v.object({
        currency: v.string(),
        subledgerPaidMinor: v.number(),
        glPaidMinor: v.number(),
        differenceMinor: v.number(),
      }),
    ),
    isReconciled: v.boolean(),
    differences: v.array(
      v.object({
        payableId: v.id("vehicleSupplierPayables"),
        currency: v.string(),
        subledgerPaidMinor: v.number(),
        glPaidMinor: v.number(),
      }),
    ),
    excludedOpeningRows: v.number(),
    creditSide: v.literal("NOT_ATTRIBUTABLE"),
  }),
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, STATEMENT_PERMISSIONS);
    await requireFeature(ctx, args.orgId, "accounting");
    await requireOwnedRow(ctx, args.orgId, "suppliers", args.supplierId, SUPPLIER_NOT_FOUND_MESSAGE);
    return { supplierId: args.supplierId, ...(await readSupplierPaymentsReconciliation(ctx, args)) };
  },
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
    const { role } = await requireTenantAuth(ctx, args.orgId, STATEMENT_PERMISSIONS);
    await requireFeature(ctx, args.orgId, "accounting");
    if (!Number.isSafeInteger(args.nowMs) || Math.abs(args.nowMs - Date.now()) > MAX_CLOCK_SKEW_MS) {
      throw new ConvexError({ code: "SUPPLIER_STATEMENT_INVALID_TIME", message: "nowMs must be a whole number of milliseconds within one day of the server clock." });
    }
    await requireOwnedRow(ctx, args.orgId, "suppliers", args.supplierId, SUPPLIER_NOT_FOUND_MESSAGE);
    const cache = createSupplierReadCache();
    const result = await readSupplierOutstanding(ctx, args, cache);
    try {
      const scope = { ...args, permissions: role.permissions, cache };
      const payable = await addSupplierRowContext(ctx, scope, result.payable);
      const receivable = await addSupplierRowContext(ctx, scope, result.receivable);
      return { supplierId: args.supplierId, payable, receivable };
    } catch (error) { return supplierNavigationFailure(error); }
  },
});

/** Port of the unmerged attention slice: canonical-id pages, never notification delivery or an aggregate. */
export const attention = query({
  args: { orgId: v.id("organizations"), supplierId: v.id("suppliers"), kind: attentionKind,
    nowMs: v.number(), paginationOpts: paginationOptsValidator },
  returns: v.union(v.null(), attentionPage),
  handler: async (ctx, args) => {
    try {
      if (!(await mayReadStatement(ctx, args.orgId))) return null;
      await requireFeature(ctx, args.orgId, "accounting");
      await requireOwnedRow(ctx, args.orgId, "suppliers", args.supplierId, SUPPLIER_NOT_FOUND_MESSAGE);
      // A clock read in a cached query does not itself refresh the subscription. Validate and use the caller's time, as outstanding does.
      // https://docs.convex.dev/functions/query-functions#caching--reactivity--consistency
      if (!Number.isSafeInteger(args.nowMs) || Math.abs(args.nowMs - Date.now()) > MAX_CLOCK_SKEW_MS) {
        throw new ConvexError({ code: "SUPPLIER_STATEMENT_INVALID_TIME", message: "nowMs must be a whole number of milliseconds within one day of the server clock." });
      }
      const nowMs = args.nowMs;
      const result = await readAttention(ctx, args, nowMs);
      return { ...result, asOfDate: ammanDateString(nowMs) };
    } catch (error) {
      return supplierNavigationFailure(error, "SUPPLIER_ATTENTION_UNAVAILABLE");
    }
  },
});

/** Organisation-wide identity warning, independently cached from each supplier's attention pages. */
export const unlinkedAttention = query({
  args: { orgId: v.id("organizations"), kind: attentionKind },
  returns: v.union(v.null(), unlinkedStatus),
  handler: async (ctx, args) => {
    try {
      if (!(await mayReadStatement(ctx, args.orgId))) return null;
      await requireFeature(ctx, args.orgId, "accounting");
      return await unlinkedPresence(ctx, args.orgId, args.kind);
    } catch (error) { return supplierNavigationFailure(error, "SUPPLIER_ATTENTION_UNAVAILABLE"); }
  },
});
