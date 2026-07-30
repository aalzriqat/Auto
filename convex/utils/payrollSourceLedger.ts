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

/**
 * Whether a domain event with this idempotency key is actually on the books.
 *
 * Requires POSTED rather than merely "not REVERSED": `accountingEvents.status`
 * also admits PENDING and FAILED, and treating those as posted would let a
 * settlement clear a payable whose accrual has not landed — the exact condition
 * this module exists to prevent.
 */
async function prereqPosted(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  idempotencyKey: string
): Promise<boolean> {
  const event = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", idempotencyKey))
    .filter((q) => q.eq(q.field("status"), "POSTED"))
    .first();
  return event !== null;
}

/** EMPLOYEE_ADVANCE_RECOVERED: its advance issuance must be posted first. */
async function advanceRecoveryBlockedReason(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  payload: Record<string, unknown>
): Promise<string | null> {
  const advanceId = typeof payload.advanceId === "string" ? payload.advanceId : null;
  if (!advanceId) {
    return "it carries no advance reference, so the Employee Advances balance it credits cannot be traced to an issuance";
  }
  if (!(await prereqPosted(ctx, orgId, `employee_advance_paid_${advanceId}`))) {
    return "the advance issuance behind it has not posted to the ledger yet, so this would credit an Employee Advances balance that was never debited";
  }
  return null;
}

/** PAYROLL_PAID: salary + commission accruals AND recovered advance issuances must be posted first. */
async function payrollPaidBlockedReason(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  payload: Record<string, unknown>
): Promise<string | null> {
  const rawItemId = typeof payload.itemId === "string" ? payload.itemId : null;
  if (!rawItemId) {
    return "it carries no payslip reference, so the payables it clears cannot be traced to their accruals";
  }
  // Resolve the payslip FIRST, and fail closed if it cannot be — exactly as
  // advanceRecoveryBlockedReason does above. If the reference does not
  // normalize, or the row is missing or belongs to another org, none of the
  // prerequisite accruals below can be checked at all, and skipping a check is
  // an ALLOW: the credits post against payables nothing ever accrued.
  const itemId = ctx.db.normalizeId("payrollItems", rawItemId);
  const loaded = itemId ? await ctx.db.get(itemId) : null;
  const item = loaded && loaded.orgId === orgId ? loaded : null;

  const salaryMinor = typeof payload.salaryMinor === "number" ? payload.salaryMinor : 0;
  if (salaryMinor > 0) {
    if (!item) {
      return "its payslip could not be resolved in this organization, so the Salaries Payable it clears cannot be traced to an accrual";
    }
    if (!(await prereqPosted(ctx, orgId, `payroll_accrued_${item._id}`))) {
      return "the salary accrual behind it has not posted to the ledger yet, so this would clear a Salaries Payable that was never accrued";
    }
  }

  const commissionMinor = typeof payload.commissionMinor === "number" ? payload.commissionMinor : 0;
  if (commissionMinor > 0) {
    if (!item) {
      return "its payslip could not be resolved in this organization, so the commission accruals behind the Commission Payable it clears cannot be verified";
    }
    for (const saleId of item.commissionSaleIds) {
      if (!(await prereqPosted(ctx, orgId, `commission_accrued_${saleId}`))) {
        return "a commission accrual behind it has not posted to the ledger yet, so this would clear a Commission Payable that was never accrued";
      }
    }
  }
  // Advance recovery: the payment credits Employee Advances for every advance
  // this payslip recovered, so each of those issuances must be posted first —
  // otherwise the asset is credited below a debit that hasn't landed. The
  // recovery allocation rows record exactly which advances.
  const advanceRecoveredMinor =
    typeof payload.advanceRecoveredMinor === "number" ? payload.advanceRecoveredMinor : 0;
  if (advanceRecoveredMinor > 0) {
    if (!item) {
      return "its payslip could not be resolved in this organization, so the advance issuances behind the Employee Advances it credits cannot be verified";
    }
    const recoveries = await ctx.db
      .query("employeeAdvanceRecoveries")
      .withIndex("by_payroll_item", (q) => q.eq("payrollItemId", item._id))
      .collect();
    for (const rec of recoveries) {
      // A cross-org recovery row means the payslip and its allocations disagree
      // about tenancy. Skipping it would be an ALLOW on unverifiable evidence —
      // every other branch in this file blocks in that situation.
      if (rec.orgId !== orgId) {
        return "one of its advance-recovery rows belongs to another organization, so the Employee Advances it credits cannot be verified";
      }
      if (!(await prereqPosted(ctx, orgId, `employee_advance_paid_${rec.advanceId}`))) {
        return "an advance issuance behind it has not posted to the ledger yet, so this would credit an Employee Advances balance that was never debited";
      }
    }
  }
  return null;
}

/** Flat dispatcher: routes each settlement event type to its prerequisite check. */
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
    return advanceRecoveryBlockedReason(ctx, entry.orgId, payload);
  }
  return payrollPaidBlockedReason(ctx, entry.orgId, payload);
}
