import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";

/**
 * Outbox posting guard for payroll/advance settlement events, mirroring
 * prepaidPostingBlockedReason. It stops a queued settlement from crediting an
 * asset/payable whose debit is still queued — the negative-balance window that
 * opens when the two events belong to different accounting periods and drain
 * out of order (e.g. the current period is opened before the closed one that
 * holds the prerequisite).
 *
 * - PAYROLL_PAID must not clear Salaries/Commission Payable before those
 *   accruals post.
 * - EMPLOYEE_ADVANCE_RECOVERED must not credit Employee Advances before the
 *   issuance that debited it posts.
 *
 * Held (not failed) entries stay PENDING and retry once the prerequisite posts.
 */
const PAYROLL_SETTLEMENT_EVENT_TYPES = new Set(["PAYROLL_PAID", "EMPLOYEE_ADVANCE_RECOVERED"]);

/** Whether a domain event with this idempotency key is on the books (posted, not reversed). */
async function prereqPosted(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  idempotencyKey: string
): Promise<boolean> {
  const event = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey))
    .filter((q) => q.neq(q.field("status"), "REVERSED"))
    .first();
  return event !== null;
}

export async function payrollPostingBlockedReason(
  ctx: MutationCtx,
  entry: {
    orgId: Id<"organizations">;
    eventType?: string;
    payload?: unknown;
  }
): Promise<string | null> {
  if (!entry.eventType || !PAYROLL_SETTLEMENT_EVENT_TYPES.has(entry.eventType)) return null;
  const payload = (entry.payload ?? {}) as Record<string, unknown>;

  if (entry.eventType === "EMPLOYEE_ADVANCE_RECOVERED") {
    const advanceId = typeof payload.advanceId === "string" ? payload.advanceId : null;
    if (!advanceId) {
      return "it carries no advance reference, so the Employee Advances balance it credits cannot be traced to an issuance";
    }
    if (!(await prereqPosted(ctx, entry.orgId, `employee_advance_paid_${advanceId}`))) {
      return "the advance issuance behind it has not posted to the ledger yet, so this would credit an Employee Advances balance that was never debited";
    }
    return null;
  }

  // PAYROLL_PAID: salary/commission accruals for the payslip must be posted.
  const rawItemId = typeof payload.itemId === "string" ? payload.itemId : null;
  if (!rawItemId) {
    return "it carries no payslip reference, so the payables it clears cannot be traced to their accruals";
  }
  const salaryMinor = typeof payload.salaryMinor === "number" ? payload.salaryMinor : 0;
  if (salaryMinor > 0 && !(await prereqPosted(ctx, entry.orgId, `payroll_accrued_${rawItemId}`))) {
    return "the salary accrual behind it has not posted to the ledger yet, so this would clear a Salaries Payable that was never accrued";
  }
  const commissionMinor = typeof payload.commissionMinor === "number" ? payload.commissionMinor : 0;
  if (commissionMinor > 0) {
    const itemId = ctx.db.normalizeId("payrollItems", rawItemId);
    const item = itemId ? await ctx.db.get(itemId) : null;
    if (item && item.orgId === entry.orgId) {
      for (const saleId of item.commissionSaleIds) {
        if (!(await prereqPosted(ctx, entry.orgId, `commission_accrued_${saleId}`))) {
          return "a commission accrual behind it has not posted to the ledger yet, so this would clear a Commission Payable that was never accrued";
        }
      }
    }
  }
  return null;
}
