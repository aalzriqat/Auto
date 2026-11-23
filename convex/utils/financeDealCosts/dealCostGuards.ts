import { ConvexError } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import { isSystemOwnerRole, PERMISSIONS } from "../permissions";

export const APPLICATION_NOT_FOUND = "Finance application not found in this organization.";

export const CUSTODY_NOT_FOUND = "Custody record not found in this organization.";

export const FEE_NOT_FOUND = "Deal cost not found in this organization.";

/** A timestamp the ledger can date an event at: a safe non-negative integer. */
export function isTimestamp(value: number | undefined): boolean {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0;
}

/** Refuses a `v.number()` date that is not a real timestamp — BEFORE it is fingerprinted or written. */
export function assertTimestamp(value: number | undefined, label: string): void {
  if (value !== undefined && !isTimestamp(value)) {
    throw new ConvexError(`${label} must be a real timestamp (got ${value}).`);
  }
}

/**
 * Refuses an economic date that has not happened yet (final round C).
 *
 * `now` is captured ONCE per mutation and shared by every date the command
 * judges, so a value equal to the server's instant passes and one
 * millisecond past it does not, with no second clock read to race against.
 * A backdated day is legitimate history and passes untouched. There is no
 * tolerance window: a calendar date the client picks is sent as UTC
 * midnight for a past day and as the current instant for today, so a
 * timestamp past the server's clock is always a day that has not occurred.
 * Thrown before anything is fingerprinted or written, like `assertTimestamp`.
 */
export function assertNotFuture(value: number | undefined, now: number, label: string): void {
  if (value !== undefined && value > now) {
    throw new ConvexError(`${label} cannot be in the future.`);
  }
}

/**
 * Whether the deal's recognized economics are FROZEN: the sale has been
 * finalized (or the application is CLOSED), so the legal invoice, every cost
 * line and every custody charge now stand behind a posted sale journal.
 *
 * After that point a posting-bearing edit — a new or adopted fee, a changed
 * actual or paid date, a void, a replaced invoice, a cost moved onto or off
 * custody, fresh cash handed over — would change what was recognized without
 * a correction journal on record. There is no immutable correction path in
 * this bounded change, so every such edit is REFUSED here with the reason,
 * and the screen reads the same predicate (`listDealCosts.economicsFrozen`)
 * to explain a disabled control. Returns and balanced reconciliation of existing
 * custody, reconciliation of recorded figures and reads remain available.
 * RT11-DOORS additionally blocks reimbursement/reversal after finalization,
 * shortage write-off, legacy migration and reopening during the pilot.
 */
export function dealEconomicsFrozen(
  app: Pick<Doc<"financeApplications">, "status" | "finalizedSaleId">
): { frozen: true; reason: "SALE_FINALIZED" | "APPLICATION_CLOSED" } | { frozen: false } {
  if (app.finalizedSaleId !== undefined) return { frozen: true, reason: "SALE_FINALIZED" };
  if (app.status === "CLOSED") return { frozen: true, reason: "APPLICATION_CLOSED" };
  return { frozen: false };
}

export function assertDealEconomicsOpen(
  app: Pick<Doc<"financeApplications">, "status" | "finalizedSaleId">,
  action: string
): void {
  const state = dealEconomicsFrozen(app);
  if (!state.frozen) return;
  throw new ConvexError(
    `This deal has been finalized, so its costs, invoice and custody charges are on the books as recognized; ${action} is refused because there is no correction journal to carry the change. Nothing has been changed.`
  );
}

/**
 * Whether the deal still takes NEW custody cash (R5, F3): an issuance opens
 * a claim on the drawer for a handover that is going to happen. A deal that
 * is CANCELLED or REJECTED has no handover to fund, exactly as a finalized
 * or CLOSED one has none left to fund — yet the freeze above covers only
 * the recognized states, and the screen alone withheld the door on the
 * stopped ones, so a direct caller could still hand cash to an employee on
 * a deal that had stopped. The server's own predicate, read by the screen
 * (`listDealCosts.acceptsNewCustodyCash`) and enforced INSIDE each
 * issuing command's idempotent section, so an exact replay of an issuance
 * that succeeded before the deal stopped still returns its stored result.
 *
 * NEW cash only. Separate RT11-DOORS pilot guards govern settlement:
 * reimbursement/reversal refuse after finalization; write-off, migration and
 * reopen refuse outright. Returns and balanced reconciliation stay available.
 */
export function dealAcceptsNewCustodyCash(
  app: Pick<Doc<"financeApplications">, "status" | "finalizedSaleId">
):
  | { accepts: true }
  | { accepts: false; reason: "SALE_FINALIZED" | "APPLICATION_CLOSED" | "APPLICATION_CANCELLED" | "APPLICATION_REJECTED" } {
  const frozen = dealEconomicsFrozen(app);
  if (frozen.frozen) return { accepts: false, reason: frozen.reason };
  if (app.status === "CANCELLED") return { accepts: false, reason: "APPLICATION_CANCELLED" };
  if (app.status === "REJECTED") return { accepts: false, reason: "APPLICATION_REJECTED" };
  return { accepts: true };
}

export function assertDealAcceptsNewCustodyCash(
  app: Pick<Doc<"financeApplications">, "status" | "finalizedSaleId">,
  action: string,
  settleSentence = "Custody the employee already holds can still be returned, reimbursed, reversed or reconciled.",
  gone = "no handover left to fund"
): void {
  const state = dealAcceptsNewCustodyCash(app);
  if (state.accepts) return;
  if (state.reason === "APPLICATION_CANCELLED" || state.reason === "APPLICATION_REJECTED") {
    throw new ConvexError(
      `This deal has been ${state.reason === "APPLICATION_CANCELLED" ? "cancelled" : "rejected"}, so there is ${gone}; ${action} is refused. ${settleSentence} Nothing has been changed.`
    );
  }
  assertDealEconomicsOpen(app, action);
}

/**
 * Refuses to let a CREATE-level caller destroy CONFIRM-level work.
 *
 * Reconciling a cost requires `CONFIRM_FINANCE_DISBURSEMENT`, which SALES does
 * not hold; recording and voting an amount requires only
 * `CREATE_FINANCE_APPLICATION`, which it does. So without this a salesperson
 * could overwrite an accountant's checked figure, identity and notes.
 *
 * Checked against the role already loaded rather than by calling
 * `requireTenantAuth` a second time: that helper is not side-effect-free in a
 * mutation — it writes an impersonation audit row — so re-calling it logged a
 * second `impersonated-write:` entry naming an operation that never happened.
 */
export function assertMayUndoReconciliation(
  auth: { role: Doc<"roles"> },
  action: string
): void {
  if (isSystemOwnerRole(auth.role)) return;
  if (auth.role.permissions.includes(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT)) return;
  throw new ConvexError(
    `${action} needs the permission to confirm finance disbursements, because somebody has already reconciled it.`
  );
}

/**
 * A cost line that touches an employee's custody is a LEDGER command — it
 * posts, re-posts or reverses a custody journal — so it carries the custody
 * authority, not the cost-entry one (Codex AF-CUST-04). CREATE is held by
 * SALES; confirming disbursements is not. Same shape as
 * `assertMayUndoReconciliation`: judged on the role already loaded.
 */
export function assertMayPostCustody(auth: { role: Doc<"roles"> }, action: string): void {
  if (isSystemOwnerRole(auth.role)) return;
  if (auth.role.permissions.includes(PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT)) return;
  throw new ConvexError(
    `${action} needs the permission to confirm finance disbursements, because it moves what an employee's custody has on the books.`
  );
}

/**
 * The revision of a line's actual evidence (SCRUM-834): how many times
 * `recordActualFeeAmount` has replaced it. A line never re-recorded — every
 * legacy row, every fresh insert — carries none and reads as 0.
 */
export function actualEvidenceRevisionOf(fee: Pick<Doc<"financeDealFees">, "actualEvidenceRevision">): number {
  return fee.actualEvidenceRevision ?? 0;
}

/** The revision a re-record writes: one past the stored one, or a refusal when the stored one is not a count. */
export function nextActualEvidenceRevision(fee: Pick<Doc<"financeDealFees">, "actualEvidenceRevision">, action: string): number {
  const current = actualEvidenceRevisionOf(fee);
  if (!Number.isSafeInteger(current) || current < 0 || current >= Number.MAX_SAFE_INTEGER) {
    throw new ConvexError(
      `This cost line carries an evidence revision that is not a usable count (${String(current)}), so ${action} is refused; nothing has been changed. Have the record reviewed.`
    );
  }
  return current + 1;
}
