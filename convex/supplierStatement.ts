import { ConvexError, v } from "convex/values";
import { query } from "./_generated/server";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { PERMISSIONS } from "./utils/permissions";
import { requireFeature } from "./subscriptions";
import { readSupplierOutstanding, readSupplierSettled } from "./utils/supplierObligationDue";
import { readSupplierPaymentsReconciliation } from "./utils/supplierPaymentsReconciliation";
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

const settledRow = v.object({
  kind: v.union(v.literal("PAYABLE"), v.literal("RECEIVABLE"), v.literal("RECOVERY")),
  id: v.string(),
  currency: v.string(),
  status: v.string(),
  dueMinor: v.number(),
  settledMinor: v.number(),
  lastChangedAt: v.number(),
});
const settledSection = v.object({
  rows: v.array(settledRow),
  totals: v.array(v.object({ currency: v.string(), settledMinor: v.number() })),
  complete: v.boolean(),
});

/**
 * SCRUM-869 slice 4 - what this supplier has been paid (A/P) and has paid back (A/R): settled and
 * part-settled rows with the cash actually moved, newest first. Same gate and tenancy as
 * `outstanding`; no net field, no currency blending.
 */
export const settled = query({
  args: { orgId: v.id("organizations"), supplierId: v.id("suppliers") },
  returns: v.object({ supplierId: v.id("suppliers"), payable: settledSection, receivable: settledSection }),
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
    await requireFeature(ctx, args.orgId, "accounting");
    await requireOwnedRow(ctx, args.orgId, "suppliers", args.supplierId, SUPPLIER_NOT_FOUND_MESSAGE);
    const { payable, receivable } = await readSupplierSettled(ctx, args);
    return { supplierId: args.supplierId, payable, receivable };
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
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
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
