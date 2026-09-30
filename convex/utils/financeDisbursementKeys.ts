/**
 * SCRUM-239: the ONE builder of a finance-company disbursement's identities.
 *
 * A disbursement can be undone (the cleared cheque bounces) and then made again
 * on a new cheque. The second confirmation must not collide with the first:
 * the canonical payment is keyed by `idempotencyKey` and a VOIDED row would be
 * returned as-is, and the posting engine refuses to re-post a REVERSED event.
 * So every disbursement carries a version, and every key derives from it here.
 *
 * Version 1 (the only version that has ever existed in production, and what an
 * absent `disbursementVersion` means) reproduces the historical strings
 * byte-for-byte, so no stored row needs migrating. Version n >= 2 appends
 * `_v<n>` and uses n as the accounting `eventVersion`.
 *
 * The reversal keys are versioned too: `reverseAccountingEvent` answers
 * "already reversed" for a key it has seen, so a version-1 reversal key reused
 * for version 2 would silently leave version 2's cash receipt POSTED.
 */
import type { Id } from "../_generated/dataModel";

export interface FinanceDisbursementKeys {
  /** `canonicalPayments.idempotencyKey` of this disbursement's payment. */
  paymentKey: string;
  /** Idempotency key of the forward FINANCE_CASH_RECEIVED post. */
  cashReceivedPostKey: string;
  /** `accountingEvents.sourceId` of the FINANCE_CASH_RECEIVED event. */
  sourceId: string;
  /** `accountingEvents.eventVersion` of the FINANCE_CASH_RECEIVED event. */
  eventVersion: number;
  /** Idempotency key of the reversal of that event. */
  reversalKey: string;
  /** Key under which a still-pending forward post sits in the outbox. */
  pendingPostKey: string;
}

/** An absent version means the first disbursement. */
export function disbursementVersionOf(row: { disbursementVersion?: number }): number {
  return row.disbursementVersion ?? 1;
}

export function financeDisbursementKeys(
  applicationId: Id<"financeApplications"> | string,
  version: number = 1
): FinanceDisbursementKeys {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error(`disbursement version must be a safe integer >= 1, received ${String(version)}`);
  }
  const suffix = version === 1 ? "" : `_v${version}`;
  const cashReceivedPostKey = `finance_cash_received_${applicationId}${suffix}`;
  return {
    paymentKey: `finance_disbursement_${applicationId}${suffix}`,
    cashReceivedPostKey,
    sourceId: `disbursement_${applicationId}${suffix}`,
    eventVersion: version,
    reversalKey: `finance_cash_received_reversed_${applicationId}${suffix}`,
    pendingPostKey: cashReceivedPostKey,
  };
}
