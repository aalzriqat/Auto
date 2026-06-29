import { ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { throwAppError, AppErrorCode } from "./errors";

const FINANCIAL_TABLES = new Set<string>([
  "transactions",
  "sales",
  "deposits",
  "receivables",
  "collectionPayments",
  "postDatedCheques",
  "cashierReconciliations",
  "collectionApprovalRequests",
  "expenses",
  "fixedAssets",
  "partnerEquity",
  "claims",
  "financeApplications",
  "financeCompanies",
  "vehicleValuations",
  "accountingEvents",
  "journalEntries",
  "journalLines",
]);

export function isFinancialTable(table: string) {
  return FINANCIAL_TABLES.has(table);
}

export function assertAdminMayMutateTable(table: string, action: string) {
  if (!isFinancialTable(table)) return;
  throwAppError(
    AppErrorCode.FORBIDDEN,
    `Financial table "${table}" cannot be changed through ${action}. Use a domain reversal, cancellation, or audited correction workflow.`
  );
}

export function assertDifferentActors(
  actorId: Id<"users">,
  priorActorId: Id<"users">,
  message: string
) {
  if (actorId === priorActorId) {
    throw new ConvexError(message);
  }
}

