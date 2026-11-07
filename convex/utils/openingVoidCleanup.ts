import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { fromMinorUnits } from "./money";
import { requireOwnedRow } from "./tenancy";
import { inTurn } from "./transactionReadHeadroom";
import { OPENING_MATERIALIZED_TABLES, openingMaterializedTargets, type OpeningMaterializedTarget } from "./openingResetCleanup";
import { refuseOpeningChange } from "./openingMaintenanceErrors";

type Opening = Doc<"openingBalanceDrafts">;
type Allocation = NonNullable<Opening["allocations"]>[number];
type Result = NonNullable<Opening["allocationResults"]>[number];

function requireUnchanged(condition: boolean): void {
  if (!condition) refuseOpeningChange("OPENING_VOID_CONFLICT");
}

async function validateOpeningReceivable(ctx: QueryCtx, draft: Opening,
  row: Extract<Allocation, { kind: "CUSTOMER_RECEIVABLE" }>, result: Extract<Result, { kind: "CUSTOMER_RECEIVABLE" }>) {
  const legacy = await requireOwnedRow(ctx, draft.orgId, "receivables", result.receivableId);
  const canonical = await requireOwnedRow(ctx, draft.orgId, "receivableDocuments", result.canonicalReceivableDocumentId);
  const amount = fromMinorUnits(row.amountMinor, draft.currency!);
  requireUnchanged(legacy.openingBalanceDraftId === draft._id && !legacy.isDeleted &&
    legacy.originalAmount === amount && legacy.outstandingAmount === amount && legacy.customerId === row.customerId &&
    legacy.canonicalReceivableDocumentId === canonical._id && ["OPEN", "OVERDUE"].includes(legacy.status) &&
    canonical.status === "OPEN" && canonical.sourceType === "legacy_receivable" && canonical.sourceId === String(legacy._id) &&
    canonical.originalAmountMinor === row.amountMinor && canonical.currency === draft.currency);
}

async function validateOpeningPayable(ctx: QueryCtx, draft: Opening,
  row: Extract<Allocation, { kind: "SUPPLIER_PAYABLE" | "OTHER_PAYABLE" }>, result: Extract<Result, { kind: "SUPPLIER_PAYABLE" | "OTHER_PAYABLE" }>) {
  const payable = await requireOwnedRow(ctx, draft.orgId, "vehicleSupplierPayables", result.payableId);
  requireUnchanged(payable.origin === "OPENING" && payable.openingBalanceDraftId === draft._id &&
    payable.openingRowKey === row.rowKey && payable.openingKind === row.kind && payable.status === "PENDING" &&
    payable.amountPaid === 0 && (payable.paymentSeq ?? 0) === 0 && payable.currency === draft.currency &&
    payable.amountDue === fromMinorUnits(row.amountMinor, draft.currency!));
}

async function validateOpeningMaster(ctx: QueryCtx, draft: Opening, row: Allocation, result: Result): Promise<boolean> {
  if (row.kind === "VEHICLE_INVENTORY" && result.kind === row.kind) {
    const vehicle = await requireOwnedRow(ctx, draft.orgId, "vehicles", result.vehicleId);
    requireUnchanged(vehicle._id === row.vehicleId && vehicle.openingBalanceDraftId === draft._id &&
      !vehicle.isDeleted && vehicle.status === "AVAILABLE" && vehicle.sourceType === "STOCK" &&
      vehicle.purchasePrice === fromMinorUnits(row.amountMinor, draft.currency!));
    return true;
  }
  if (row.kind === "PARTNER_CAPITAL" && result.kind === row.kind) {
    const partner = await requireOwnedRow(ctx, draft.orgId, "partnerEquity", result.partnerId);
    const total = (draft.allocations ?? []).reduce((sum, allocation) =>
      sum + (allocation.kind === "PARTNER_CAPITAL" && allocation.partnerId === row.partnerId ? allocation.amountMinor : 0), 0);
    requireUnchanged(partner._id === row.partnerId && partner.openingBalanceDraftId === draft._id && !partner.isDeleted &&
      partner.openingBalanceMinor === total && (partner.currentBalance ?? 0) === 0 && (partner.initialCapital ?? 0) === 0);
    return true;
  }
  return false;
}

async function validateOpeningPayroll(ctx: QueryCtx, draft: Opening, row: Allocation, result: Result): Promise<boolean> {
  if (row.kind === "EMPLOYEE_ADVANCE" && result.kind === row.kind) {
    const advance = await requireOwnedRow(ctx, draft.orgId, "employeeAdvances", result.advanceId);
    requireUnchanged(advance.openingBalanceDraftId === draft._id && !advance.isDeleted && advance.userId === row.userId &&
      advance.amountMinor === row.amountMinor && advance.currency === draft.currency && advance.recoveredMinor === 0 && advance.status === "OUTSTANDING");
    return true;
  }
  if (row.kind === "EMPLOYEE_COMMISSION" && result.kind === row.kind) {
    const liability = await requireOwnedRow(ctx, draft.orgId, "openingCommissionLiabilities", result.openingCommissionLiabilityId);
    requireUnchanged(liability.openingDraftId === draft._id && liability.openingRowKey === row.rowKey &&
      liability.userId === row.userId && liability.amountMinor === row.amountMinor && liability.currency === draft.currency &&
      liability.paidMinor === 0 && liability.paidPayrollItemId === undefined && liability.paidAt === undefined);
    return true;
  }
  return false;
}

async function validateOpeningBenefit(ctx: QueryCtx, draft: Opening, row: Allocation, result: Result): Promise<boolean> {
  if (row.kind === "PREPAID_EXPENSE" && result.kind === row.kind) {
    const schedule = await requireOwnedRow(ctx, draft.orgId, "prepaidExpenseSchedules", result.scheduleId);
    requireUnchanged(schedule.kind === "OPENING" && schedule.openingBalanceDraftId === draft._id && schedule.openingRowKey === row.rowKey &&
      schedule.totalMinor === row.amountMinor && schedule.currency === draft.currency && schedule.status === "ACTIVE" &&
      schedule.recognizedMinor === 0 && schedule.monthsRecognized === 0);
    return true;
  }
  if (row.kind === "SUPPLIER_RECOVERABLE" && result.kind === row.kind) {
    const recovery = await requireOwnedRow(ctx, draft.orgId, "supplierCostRecoveries", result.recoveryId);
    requireUnchanged(recovery.origin === "OPENING" && recovery.openingBalanceDraftId === draft._id && recovery.openingRowKey === row.rowKey &&
      recovery.amountDueMinor === row.amountMinor && recovery.currency === draft.currency && recovery.status === "OPEN" &&
      recovery.amountRecoveredMinor === 0 && (recovery.receiptSeq ?? 0) === 0);
    return true;
  }
  return false;
}

async function validateOpeningDeposit(ctx: QueryCtx, draft: Opening,
  row: Extract<Allocation, { kind: "CUSTOMER_DEPOSIT" }>, result: Extract<Result, { kind: "CUSTOMER_DEPOSIT" }>) {
  const deposit = await requireOwnedRow(ctx, draft.orgId, "deposits", result.depositId);
  requireUnchanged(deposit.origin === "OPENING" && deposit.openingBalanceDraftId === draft._id && deposit.openingRowKey === row.rowKey &&
    deposit.amountMinor === row.amountMinor && deposit.currency === draft.currency && deposit.customerId === row.customerId &&
    deposit.status === "HELD" && !deposit.isDeleted && !deposit.holdActive && !deposit.usesVehicleHoldRows &&
    deposit.canonicalPaymentId === undefined && deposit.quoteId === undefined &&
    deposit.singleVehicleCommitmentClaimId === undefined);
}

async function validateOpeningResult(ctx: QueryCtx, draft: Opening, row: Allocation, result: Result): Promise<void> {
  requireUnchanged(row.kind === result.kind && Number.isSafeInteger(row.amountMinor) && row.amountMinor > 0);
  if (await validateOpeningMaster(ctx, draft, row, result)) return;
  if (await validateOpeningPayroll(ctx, draft, row, result)) return;
  if (await validateOpeningBenefit(ctx, draft, row, result)) return;
  if (row.kind === "CUSTOMER_RECEIVABLE" && result.kind === row.kind) return validateOpeningReceivable(ctx, draft, row, result);
  if ((row.kind === "SUPPLIER_PAYABLE" || row.kind === "OTHER_PAYABLE") &&
      (result.kind === "SUPPLIER_PAYABLE" || result.kind === "OTHER_PAYABLE")) return validateOpeningPayable(ctx, draft, row, result);
  if (row.kind === "CUSTOMER_DEPOSIT" && result.kind === row.kind) return validateOpeningDeposit(ctx, draft, row, result);
  requireUnchanged(row.kind === "UNALLOCATED_LIABILITY" && result.kind === row.kind && row.purpose === result.purpose);
}

/** Read-only plan. The caller checks downstream references before using it. */
export async function prepareOpeningVoidTargets(ctx: QueryCtx, draft: Opening): Promise<OpeningMaterializedTarget[]> {
  const allocations = draft.allocations ?? [];
  const results = draft.allocationResults ?? [];
  requireUnchanged(allocations.length <= 100 && allocations.length === results.length &&
    new Set(allocations.map(row => row.rowKey)).size === allocations.length && new Set(results.map(row => row.rowKey)).size === results.length);
  const targets = new Map<string, OpeningMaterializedTarget>();
  await inTurn(allocations, async row => {
    const result = results.find(candidate => candidate.rowKey === row.rowKey);
    if (!result) refuseOpeningChange("OPENING_VOID_CONFLICT");
    try { await validateOpeningResult(ctx, draft, row, result); }
    catch (error) {
      console.error("Opening void source verification failed", error);
      refuseOpeningChange("OPENING_VOID_CONFLICT");
    }
    for (const target of openingMaterializedTargets(result)) {
      if (targets.has(target.id) && target.table !== "partnerEquity") refuseOpeningChange("OPENING_VOID_CONFLICT");
      targets.set(target.id, target);
    }
  });
  await assertCompleteOpeningSourceInventory(ctx, draft, targets);
  return [...targets.values()];
}

/** The immutable results must also cover the rows that actually exist. This
 * detects legacy/orphan source markers even when no result names their ids. */
async function assertCompleteOpeningSourceInventory(ctx: QueryCtx, draft: Opening,
  targets: ReadonlyMap<string, OpeningMaterializedTarget>) {
  await inTurn(OPENING_MATERIALIZED_TABLES, async table => {
    const rows = table === "vehicles"
      ? await ctx.db.query("vehicles").withIndex("by_org_openingBalanceDraftId", q => q.eq("orgId", draft.orgId).eq("openingBalanceDraftId", draft._id)).take(101)
      : await ctx.db.query(table).withIndex("by_org", q => q.eq("orgId", draft.orgId)).take(101);
    if (rows.length > 100) refuseOpeningChange("OPENING_VOID_CONFLICT");
    for (const row of rows) {
      const marker = "openingBalanceDraftId" in row ? row.openingBalanceDraftId : undefined;
      const commissionMarker = "openingDraftId" in row ? row.openingDraftId : undefined;
      if ((marker === draft._id || commissionMarker === draft._id) && !targets.has(row._id)) refuseOpeningChange("OPENING_VOID_CONFLICT");
    }
  });
}

/** Masters predate the opening; everything else in the shared inventory was
 * created by that opening. Retain allocations/results as the audit trail. */
export async function removeOpeningVoidTargets(ctx: MutationCtx, targets: readonly OpeningMaterializedTarget[]): Promise<void> {
  await inTurn(targets, async target => {
    if (target.table === "vehicles") await ctx.db.patch(target.id, { openingBalanceDraftId: undefined });
    else if (target.table === "partnerEquity") await ctx.db.patch(target.id, { openingBalanceDraftId: undefined, openingBalanceMinor: undefined });
    else await ctx.db.delete(target.id);
  });
}
