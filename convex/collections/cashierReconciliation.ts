import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { getOrgCurrency } from "../accounting/workflowHooks";
import { assertDifferentActors } from "../utils/financialGuards";
import { runWithIdempotency } from "../utils/idempotency";
import { getActorName, notifyManagers } from "../utils/notifications";
import { type OrgDayWindow, paymentOnOrgDay } from "../utils/orgBusinessDay";
import { PERMISSIONS } from "../utils/permissions";
import { requireTenantAuth } from "../utils/tenancy";
import { roundMoney } from "./amounts";
import { orgBusinessDay, takeAcrossRanges } from "./collectionReads";

/**
 * Unreconciled POSTED drawer payments (CASH and REFUND) one cashier can have on
 * one business day before the reconciliation refuses rather than certifies.
 *
 * LIMIT + 1 is the total read budget across both methods: 500 full documents,
 * exactly the bound of the read this replaced. Payment `notes` are uncapped, so
 * no row count is byte-safe on its own (SCRUM-398).
 */
const RECONCILIATION_DAY_LIMIT = 499;

const RECONCILIATION_DAY_TOO_LARGE =
  "This business day has too many unreconciled payments to reconcile in one step. Contact support.";

// SCRUM-264: a refund written at a sale-date key cannot be told from one at the same instant, so west of
// UTC the day it belongs to is unknown. Neutral wording: it names no date and promises no outcome.
const RECONCILIATION_DATE_UNCERTAIN =
  "A payment in this business day cannot be placed on one day, so the day cannot be reconciled yet. Contact support.";

/**
 * SCRUM-259: the drawer cash a reconciliation certifies, shared by the draft and
 * the submit so the two cannot disagree.
 *
 * It used to read the cashier's first 500 payments of all time and filter
 * afterwards, so once a cashier passed 500 rows every later payment was
 * invisible and the reconciliation certified a subtotal of a hidden prefix. The
 * index now narrows to exactly the unreconciled POSTED rows in the day, and a
 * day that does not fit is reported as incomplete instead of truncated.
 */
async function readCashierDayCashPayments(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  cashierId: Id<"users">,
  window: OrgDayWindow
): Promise<
  | { complete: false; reason: "TOO_LARGE" | "DATE_UNCERTAIN" }
  | { complete: true; payments: Doc<"collectionPayments">[]; expectedCash: number }
> {
  const readMethod = (method: "CASH" | "REFUND", budget: number) =>
    takeAcrossRanges(window.ranges, budget, (range, take) =>
      ctx.db
        .query("collectionPayments")
        .withIndex("by_org_cashier_unreconciled_method_date", (q) =>
          q
            .eq("orgId", orgId)
            .eq("cashierId", cashierId)
            .eq("reconciliationId", undefined)
            .eq("status", "POSTED")
            .eq("method", method)
            .gte("paymentDate", range.start)
            .lte("paymentDate", range.end)
        )
        .take(take)
    );
  // Sequential on purpose: the second read gets only what the first left over.
  const cash = await readMethod("CASH", RECONCILIATION_DAY_LIMIT + 1);
  // Never issue a zero-budget read: CASH alone already proves the day incomplete.
  const refundBudget = RECONCILIATION_DAY_LIMIT + 1 - cash.length;
  const refunds = refundBudget > 0 ? await readMethod("REFUND", refundBudget) : [];
  const raw = [...cash, ...refunds];
  // The raw read may include a neighbouring date's key that sits inside the span, so exceeding the
  // limit is refused conservatively: the part that was read cannot be certified as the whole day.
  if (raw.length > RECONCILIATION_DAY_LIMIT) return { complete: false, reason: "TOO_LARGE" };
  const payments: Doc<"collectionPayments">[] = [];
  for (const payment of raw) {
    const verdict = paymentOnOrgDay(window, payment);
    // Certifying a drawer total that may include or exclude a payment of another day is the defect
    // this refuses: the cashier would attach (and so close) a payment that may belong to another day.
    if (verdict === "UNPLACEABLE") return { complete: false, reason: "DATE_UNCERTAIN" };
    if (verdict === "IN_DAY") payments.push(payment);
  }
  const expectedCash = payments.reduce(
    (sum, payment) => sum + (payment.direction === "IN" ? payment.amount : -payment.amount),
    0
  );
  return { complete: true, payments, expectedCash };
}

export async function getReconciliationDraftHandler(
  ctx: QueryCtx,
  args: {
    orgId: Id<"organizations">;
    businessDate: number;
  },
) {
  const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
  const currency = await getOrgCurrency(ctx, args.orgId);
  const { key: businessDate, window } = await orgBusinessDay(ctx, args.orgId, args.businessDate);
  const day = await readCashierDayCashPayments(ctx, args.orgId, user._id, window);
  if (!day.complete) {
    return { businessDate, complete: false as const, reason: day.reason, expectedCash: null, paymentCount: null };
  }
  return {
    businessDate,
    complete: true as const,
    expectedCash: roundMoney(day.expectedCash, currency),
    paymentCount: day.payments.length,
  };
}

export async function submitCashierReconciliationHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    businessDate: number;
    countedCash: number;
    notes?: string;
    idempotencyKey: string;
  },
) {
  const { user, membership } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.MANAGE_FINANCE]);
  return await runWithIdempotency(
    ctx,
    {
      orgId: args.orgId,
      operation: "collections.submitCashierReconciliation",
      economic: true,
      idempotencyKey: args.idempotencyKey,
      actorId: user._id,
      // Counted cash against a business date — a different count for the same
      // day is a new declaration, not a retry of the earlier one.
      fingerprint: JSON.stringify({
        businessDate: args.businessDate,
        countedCash: args.countedCash,
      }),
    },
    async () => {
      if (!Number.isFinite(args.countedCash) || args.countedCash < 0) {
        throw new ConvexError("Counted cash must be zero or greater.");
      }
      const currency = await getOrgCurrency(ctx, args.orgId);
      const { key: businessDate, window } = await orgBusinessDay(ctx, args.orgId, args.businessDate);
      const day = await readCashierDayCashPayments(ctx, args.orgId, user._id, window);
      if (!day.complete) {
        // Certifying the part we could read would be the defect this replaced.
        // The throw also rolls back the idempotency record, so a retry is fresh.
        throw new ConvexError(
          day.reason === "DATE_UNCERTAIN" ? RECONCILIATION_DATE_UNCERTAIN : RECONCILIATION_DAY_TOO_LARGE
        );
      }
      const expectedCash = roundMoney(day.expectedCash, currency);
      const countedCash = roundMoney(args.countedCash, currency);
      const now = Date.now();
      const reconciliationId = await ctx.db.insert("cashierReconciliations", {
        orgId: args.orgId,
        branchId: membership.branchId,
        cashierId: user._id,
        businessDate,
        expectedCash,
        countedCash,
        difference: roundMoney(countedCash - expectedCash, currency),
        status: "SUBMITTED",
        idempotencyKey: args.idempotencyKey,
        notes: args.notes,
        createdAt: now,
        updatedAt: now,
      });

      for (const payment of day.payments) {
        await ctx.db.patch(payment._id, { reconciliationId });
      }

      const actorName = await getActorName(ctx);
      await notifyManagers(ctx, args.orgId, "collection.reconciliation_submitted", {
        actorName,
        amount: String(countedCash),
      }, { link: `/${args.orgId}/accounting` });

      return reconciliationId;
    }
  );
}

export async function listReconciliationsHandler(ctx: QueryCtx, args: { orgId: Id<"organizations"> }) {
  await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE]);
  const rows = await ctx.db
    .query("cashierReconciliations")
    .withIndex("by_org_businessDate", (q) => q.eq("orgId", args.orgId))
    .order("desc")
    .take(50);
  return await Promise.all(rows.map(async (row) => {
    const cashier = await ctx.db.get(row.cashierId);
    return {
      ...row,
      cashierName: cashier?.name ?? cashier?.email ?? "Unknown",
    };
  }));
}

export async function reviewCashierReconciliationHandler(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    reconciliationId: Id<"cashierReconciliations">;
    status: "APPROVED" | "REJECTED";
    notes?: string;
  },
) {
  const { user } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.APPROVE_REQUESTS]);
  const reconciliation = await ctx.db.get(args.reconciliationId);
  if (!reconciliation || reconciliation.orgId !== args.orgId) throw new ConvexError("Reconciliation not found.");
  if (reconciliation.status !== "SUBMITTED") throw new ConvexError("Only submitted reconciliations can be reviewed.");
  assertDifferentActors(
    user._id,
    reconciliation.cashierId,
    "Cashier cannot approve or reject their own reconciliation."
  );
  await ctx.db.patch(args.reconciliationId, {
    status: args.status,
    notes: args.notes ?? reconciliation.notes,
    reviewedBy: user._id,
    reviewedAt: Date.now(),
    updatedAt: Date.now(),
  });
}
