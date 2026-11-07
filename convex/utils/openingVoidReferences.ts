import { convexToJson } from "convex/values";
import type { Id, TableNames } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { inTurn } from "./transactionReadHeadroom";
import { refuseOpeningChange } from "./openingMaintenanceErrors";

/** Schema census of incoming references to opening-created rows. The source
 * draft keeps its immutable references; the org is read separately. Vehicle
 * and partner masters survive, but their financial consumers also refuse. */
export const OPENING_VOID_REFERENCE_INDEX = {
  commitmentAuthorityWork: "by_org_work_key", receivableDocuments: "by_org", paymentAllocations: "by_org",
  vehicleCostCorrections: "by_org_vehicle", supplierCostRecoveryReceipts: "by_org", vehicleOwnershipConversions: "by_org",
  vehicleReservations: "by_org_vehicle", sales: "by_org", prepaidAmortizationFailures: "by_org",
  prepaidScheduleCorrections: "by_org", prepaidCorrectionRequests: "by_org_status", financeCompanyForwardSlices: "by_org_forward",
  depositRequests: "by_org_status", depositVehicleHolds: "by_org_vehicle_active", vehicleCommitmentClaims: "by_org_vehicle_status",
  depositApplications: "by_org", depositCancellationPendings: "by_org_vehicle_status", invoiceReceiptApplications: "by_org",
  receiptApplications: "by_org", paymentVouchers: "by_org", receivables: "by_org", collectionPayments: "by_org",
  postDatedCheques: "by_org", collectionApprovalRequests: "by_org", collectionReminders: "by_org", transactions: "by_org",
  claims: "by_org", employeeAdvanceRecoveries: "by_org", openingPayablePayments: "by_org", payrollItems: "by_org",
  paymentIntents: "by_org", partnerEquityTransactions: "by_org",
} as const satisfies Partial<Record<TableNames, string>>;

function referencesTarget(value: unknown, targetIds: ReadonlySet<string>): boolean {
  if (typeof value === "string") return targetIds.has(value);
  if (Array.isArray(value)) return value.some(child => referencesTarget(child, targetIds));
  if (value !== null && typeof value === "object") return Object.values(value).some(child => referencesTarget(child, targetIds));
  return false;
}

/** Bound every table and the total decoded evidence. Overflow refuses before
 * writes. Native transaction limits remain the final atomic rollback bound. */
export async function assertNoOpeningVoidReferences(ctx: QueryCtx, orgId: Id<"organizations">,
  targetIds: ReadonlySet<string>, originalLineIds: ReadonlySet<string>): Promise<void> {
  let bytes = 0;
  await inTurn(Object.entries(OPENING_VOID_REFERENCE_INDEX), async ([table, index]) => {
    // Each table/index pair has an orgId-leading index. The schema census test
    // checks these dynamic pairs; the cast does not weaken row ownership.
    const rows = await ctx.db.query(table as "receivables").withIndex(index as "by_org", q => q.eq("orgId", orgId)).take(101);
    if (rows.length > 100) refuseOpeningChange("OPENING_VOID_CONFLICT");
    await inTurn(rows, async row => {
      bytes += new TextEncoder().encode(JSON.stringify(convexToJson(row))).byteLength;
      if (bytes > 2 * 1024 * 1024 || row.orgId !== orgId) refuseOpeningChange("OPENING_VOID_CONFLICT");
      // Opening-created rows may refer to each other. Their complete identities
      // have already been checked; anything outside that set is later history.
      if (!targetIds.has(row._id) && referencesTarget(row, targetIds)) refuseOpeningChange("OPENING_VOID_CONFLICT");
    });
  });
  const statements = await ctx.db.query("bankStatementLines").withIndex("by_org_bankAccount", q => q.eq("orgId", orgId)).take(101);
  if (statements.length > 100 || statements.some(row => referencesTarget(row, originalLineIds))) refuseOpeningChange("OPENING_VOID_CONFLICT");
}
