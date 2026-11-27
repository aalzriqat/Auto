import { CUSTODY_CLEARING_KEY } from "../utils/dealCustodyPosting";
import { SYSTEM_KEYS, type SystemKey } from "../utils/defaultChart";
import { assertCustodyAmount } from "./custodyRuleGuards";
import type { LineSpec, RuleResult } from "./postingRules";

/**
 * The two deal-custody adjustment rules (write-off and payable reclassification), split out of postingRules.ts under
 * the file-size ratchet (SCRUM-961 follow-up). Moved verbatim; `line` is the same three-field constructor postingRules uses.
 */
function line(accountSystemKey: SystemKey, debitMinor: number, creditMinor: number, description?: string): LineSpec {
  return { accountSystemKey, debitMinor, creditMinor, description };
}
export interface CustodyWrittenOffPayload {
  custodyId: string;
  applicationId: string;
  userId: string;
  amountMinor: number;
  currency: string;
  reason: string;
}

/** An unaccountable shortage absorbed as a loss: Dr Cash Over/Short / Cr Custody Clearing. */
export function ruleCustodyWrittenOff(p: CustodyWrittenOffPayload): RuleResult {
  assertCustodyAmount(p, "CUSTODY_WRITTEN_OFF");
  return {
    lines: [
      line(SYSTEM_KEYS.CASH_OVER_SHORT, p.amountMinor, 0, "Deal custody shortage written off"),
      line(CUSTODY_CLEARING_KEY, 0, p.amountMinor, "Custody balance written off"),
    ],
    memo: "Deal custody shortage written off",
    category: "SYSTEM",
  };
}

export interface CustodyPayableReclassifiedPayload {
  custodyId: string;
  applicationId: string;
  userId: string;
  /** Signed: positive moves shortfall INTO the payable, negative takes it back out. */
  deltaMinor: number;
  /** What the payable carries for this record after the delta — for the reader, not the rule. */
  payableAfterMinor: number;
  currency: string;
}

/**
 * Moves the employee's out-of-pocket shortfall between the clearing asset and
 * the reimbursements payable (Codex AF-CUST-01). A positive delta: Dr Custody
 * Clearing / Cr Employee Reimbursements Payable — the asset stops carrying a
 * credit and the liability carries the debt. A negative delta is the same
 * lines the other way, as the debt is repaid, reversed or the fee removed.
 * Driven by the record's position after each movement, never split at fee
 * time, so the outcome does not depend on the order cash and receipts arrive.
 */
export function ruleCustodyPayableReclassified(p: CustodyPayableReclassifiedPayload): RuleResult {
  if (!Number.isSafeInteger(p.deltaMinor) || p.deltaMinor === 0) {
    throw new Error(`CUSTODY_PAYABLE_RECLASSIFIED carries a delta that is not a non-zero integer (${p.deltaMinor}) — refusing to post.`);
  }
  const amount = Math.abs(p.deltaMinor);
  return {
    lines:
      p.deltaMinor > 0
        ? [
            line(CUSTODY_CLEARING_KEY, amount, 0, "Out-of-pocket shortfall moved off custody clearing"),
            line(SYSTEM_KEYS.EMPLOYEE_REIMBURSEMENTS_PAYABLE, 0, amount, "Owed to employee for deal costs paid out of pocket"),
          ]
        : [
            line(SYSTEM_KEYS.EMPLOYEE_REIMBURSEMENTS_PAYABLE, amount, 0, "Employee reimbursement liability released"),
            line(CUSTODY_CLEARING_KEY, 0, amount, "Shortfall returned to custody clearing"),
          ],
    memo: "Employee custody shortfall reclassified",
    category: "SYSTEM",
  };
}
