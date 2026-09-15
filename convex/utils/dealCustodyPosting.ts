import { SYSTEM_KEYS, type SystemKey } from "./defaultChart";
import { treatmentPosting, type FeeAccountingTreatment } from "./financedSalePostingPlan";

/**
 * Where a handover cost an EMPLOYEE paid out of deal custody lands in the
 * ledger — and which treatments such a cost may carry at all.
 *
 * The expense side is the SAME mapping the financed-sale plan uses for a
 * settlement-deducted component (`treatmentPosting`), so a transfer fee the
 * company withholds and a transfer fee an employee pays at the counter debit
 * the same account. What differs is the credit: the plan consumes
 * consideration, custody consumes the cash the employee holds (1250).
 *
 * Only the pure EXPENSE treatments are admitted. The others are refused with
 * a reason rather than mapped to a near-enough account:
 *
 *  - CAPITALIZED_TO_VEHICLE would debit 1400 for a cost that
 *    `utils/vehicleCostBasis` deliberately never reads from `financeDealFees`,
 *    so the vehicle's book value and its GL inventory balance would disagree
 *    by exactly this amount. Capitalizing through custody needs the cost-basis
 *    module to read it first — an open product decision, not a mapping.
 *  - CUSTOMER_RECEIVABLE / EMPLOYEE_RECEIVABLE would raise a control-account
 *    balance with no subledger row behind it (no `receivables` row, no
 *    `employeeAdvances` row), which every reconciliation report reads as a
 *    defect.
 *  - SALE_CONSIDERATION_REDUCTION / DEALER_CONCESSION are contra-revenue: a
 *    reduction of what the company remits, never cash anybody hands over.
 *  - EMPLOYEE_PAYABLE / REFUNDABLE_DEPOSIT have no account mapping anywhere.
 */
export const CUSTODY_POSTABLE_TREATMENTS: ReadonlySet<FeeAccountingTreatment> = new Set<FeeAccountingTreatment>([
  "FINANCE_COMPANY_COMMISSION",
  "APPRAISAL_EXPENSE",
  "INSURANCE_EXPENSE",
  "OWNERSHIP_TRANSFER_EXPENSE",
  "SELLING_EXPENSE",
]);

/** The expense account a custody-paid fee debits, or `null` with the refusal. */
export function custodyFeeExpenseKey(
  treatment: FeeAccountingTreatment
): { systemKey: SystemKey } | { systemKey: null; refusal: string } {
  if (!CUSTODY_POSTABLE_TREATMENTS.has(treatment)) {
    return {
      systemKey: null,
      refusal: `A cost treated as ${treatment} cannot be paid out of an employee's custody: only a cost the dealership expenses (appraisal, insurance, ownership transfer, finance-company commission or selling expense) posts against the cash an employee holds. Record it as a dealership-paid cost, or change its treatment.`,
    };
  }
  const posting = treatmentPosting(treatment);
  // Every admitted treatment is a mapped DEBIT in the plan by construction;
  // asserted rather than assumed so a later edit to one table fails here.
  if (posting === null || posting.side !== "DEBIT") {
    throw new Error(`Custody-postable treatment ${treatment} has no debit mapping in the financed-sale plan.`);
  }
  return { systemKey: posting.systemKey };
}

/** The account every custody movement and custody-paid fee clears through. */
export const CUSTODY_CLEARING_KEY: SystemKey = SYSTEM_KEYS.DEAL_CUSTODY_CLEARING;
