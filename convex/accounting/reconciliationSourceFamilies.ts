import type { Doc } from "../_generated/dataModel";
import { PREPAID_RECLASS_EVENT, PREPAID_RECLASS_SOURCE } from "../utils/prepaidReclassificationProof";

/**
 * Which accounting events and journal sources a control-account reconciliation may explain. Split out of
 * accountingReports.ts under the file-size ratchet (SCRUM-961 follow-up); the opening-prepaid reclassification is an
 * employee-advance source because it debits Employee Advances (1230).
 */
export type ReconciliationControlFamily = "SUPPLIER_RECOVERABLE" | "EMPLOYEE_ADVANCE";

export function reconciliationEventFamilySupported(event: Doc<"accountingEvents">, family: ReconciliationControlFamily): boolean {
  if (family === "EMPLOYEE_ADVANCE") return (
    ((event.eventType === "EMPLOYEE_ADVANCE_PAID" || event.eventType === "EMPLOYEE_ADVANCE_RECOVERED") && event.sourceType === "employeeAdvances") ||
    (event.eventType === "PAYROLL_PAID" && event.sourceType === "payrollItems") ||
    (event.eventType === PREPAID_RECLASS_EVENT && event.sourceType === PREPAID_RECLASS_SOURCE));
  return (event.eventType === "EXPENSE_POSTED" && event.sourceType === "expenses") ||
    (event.eventType === "SUPPLIER_COST_RECOVERY_RECEIVED" && event.sourceType === "supplierCostRecoveryReceipts");
}

export const SUPPORTED_SOURCE_FAMILIES: Record<
  ReconciliationControlFamily,
  {
    journalSourceTypes: readonly string[];
    eventSourceTypes: readonly string[];
  }
> = {
  EMPLOYEE_ADVANCE: {
    journalSourceTypes: ["employeeAdvances", "payrollItems", "cutover", PREPAID_RECLASS_SOURCE],
    eventSourceTypes: ["employeeAdvances", "payrollItems", PREPAID_RECLASS_SOURCE],
  },
  SUPPLIER_RECOVERABLE: {
    journalSourceTypes: ["supplierCostRecoveryReceipts", "cutover", "expenses"],
    eventSourceTypes: ["supplierCostRecoveryReceipts", "expenses"],
  },
};
