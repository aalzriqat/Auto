import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { disbursementAccountKey } from "../accounting/postingRules";
import { getOrgCurrency, isPostableNow } from "../accounting/workflowHooks";
import { requireActiveBankInCurrency } from "./bankAccountGuards";
import { SYSTEM_KEYS, type SystemKey } from "./defaultChart";
import { AppErrorCode, throwAppError } from "./errors";
import { toMinorSameCurrencyOrUndefined, toMinorUnits } from "./money";
import { openingVehicleEvidence } from "./openingVehicleBasis";
import type { PaymentMethod } from "./paymentMethods";
import { requireSupplierAmountMinor } from "./supplierPaymentAmounts";
import { deriveSettlementStatus, settlementView } from "./supplierSettlement";
import { isSupplierSettlementDoorDisabled } from "./supplierSettlementContainment";
import { requireOwnedRow } from "./tenancy";
import { hasVehicleAcquisitionAccountingExposure } from "./vehicleAcquisition";
import { ConvexError } from "convex/values";

type AcquisitionCostCorrectionType =
  | "PRIOR_PERIOD_RESTATEMENT"
  | "SUPPLIER_INVOICE_ERROR"
  | "CASH_REFUND"
  | "VENDOR_CREDIT";

const AP_CORRECTION_TYPES: readonly AcquisitionCostCorrectionType[] = [
  "SUPPLIER_INVOICE_ERROR",
  "VENDOR_CREDIT",
];

/**
 * The vehicle, proven to belong to `orgId` (the tenancy guard every
 * id-taking handler routes through) and not soft-deleted. Both a foreign row
 * and a deleted one read as VEHICLE_NOT_FOUND, so the reply cannot be used to
 * probe another organisation's inventory.
 */
export async function loadOwnedLiveVehicle(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<Doc<"vehicles">> {
  let vehicle: Doc<"vehicles">;
  try {
    vehicle = await requireOwnedRow(ctx, orgId, "vehicles", vehicleId);
  } catch (error) {
    if (error instanceof ConvexError) {
      throwAppError(AppErrorCode.VEHICLE_NOT_FOUND, "Vehicle not found in this organization.");
    }
    throw error;
  }
  if (vehicle.isDeleted) {
    throwAppError(AppErrorCode.VEHICLE_NOT_FOUND, "Vehicle not found in this organization.");
  }
  return vehicle;
}

/**
 * The POSTED acquisition event, payload included. STRICTER than
 * `hasPostedVehicleAcquisition` (which counts a pending/failed/reversed event
 * as "exposure" and whose semantics the edit lock deliberately keeps): a
 * correction posts a delta on top of the ledger's existing balance, so the base
 * entry must actually be settled.
 */
async function findPostedAcquisitionEvent(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<Doc<"accountingEvents"> | null> {
  return ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", orgId).eq("sourceType", "vehicles").eq("sourceId", vehicleId.toString())
    )
    .filter((q) =>
      q.and(q.eq(q.field("eventType"), "VEHICLE_ACQUIRED"), q.eq(q.field("status"), "POSTED"))
    )
    .first();
}

/** The acquisition's outbox POST row in the given status, if one is queued. */
async function findQueuedAcquisitionPost(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">,
  status: "PENDING" | "FAILED"
): Promise<Doc<"pendingAccountingEvents"> | null> {
  return ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", orgId).eq("idempotencyKey", `vehicle_acquired_${vehicleId}`)
    )
    .filter((q) => q.and(q.eq(q.field("kind"), "POST"), q.eq(q.field("status"), status)))
    .first();
}

/** How the car was paid, read from the posted event's payload. `undefined` = legacy/unknown (treated as cash). */
function originalPaymentMethodOf(event: Doc<"accountingEvents">): string | undefined {
  const payload = event.payload as { paymentMethod?: unknown } | null | undefined;
  return typeof payload?.paymentMethod === "string" ? payload.paymentMethod : undefined;
}

/**
 * The acquisition-time payable of an ON_ACCOUNT purchase: the vehicle's rows
 * with NO `saleId` (a sale-time payable belongs to the sourced-sale workflow).
 * `row` is non-null only when there is exactly one.
 */
async function loadAcquisitionPayable(
  ctx: QueryCtx | MutationCtx,
  vehicle: Pick<Doc<"vehicles">, "_id" | "orgId">
): Promise<{ row: Doc<"vehicleSupplierPayables"> | null; count: number }> {
  const rows = (
    await ctx.db
      .query("vehicleSupplierPayables")
      .withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicle._id))
      .collect()
  ).filter((row) => row.origin !== "OPENING" && row.saleId === undefined && row.orgId === vehicle.orgId);
  return { row: rows.length === 1 ? rows[0] : null, count: rows.length };
}

/**
 * How the car was ORIGINALLY paid. The posted event's payload is authoritative;
 * an event written before the method was recorded falls back to the evidence
 * that survives it: a sale-less acquisition payable means the purchase was on
 * account. Without that, a legacy on-account car would read as cash and be
 * offered a cash refund against money that never left the bank.
 */
function resolveOriginalPaymentMethod(
  event: Doc<"accountingEvents">,
  acquisitionPayableCount: number
): string | undefined {
  return originalPaymentMethodOf(event) ?? (acquisitionPayableCount > 0 ? "ON_ACCOUNT" : undefined);
}

/**
 * True when AP-type corrections may rewrite this payable. Judged from the MONEY
 * (`settlementView`), never the stored status: dispute and un-dispute rewrite
 * the stored status to DUE_ON_SALE while the row is exactly as payable as before,
 * so a stored-status test refuses a payable the money says is untouched.
 * Adjustable = unpaid, not disputed/cancelled/paid, same currency, and the
 * amount due equals the capitalized cost in minor units.
 */
function isPayableAdjustable(
  row: Doc<"vehicleSupplierPayables"> | null,
  orgCurrency: string,
  previousCost: number
): row is Doc<"vehicleSupplierPayables"> {
  if (!row) return false;
  const view = settlementView(row);
  if (view.status !== "DUE_ON_SALE" && view.status !== "NOT_YET_DUE") return false;
  if (view.amountPaid !== 0) return false;
  const dueMinor = toMinorSameCurrencyOrUndefined(row.amountDue, row.currency, orgCurrency);
  const costMinor = toMinorSameCurrencyOrUndefined(previousCost, orgCurrency, orgCurrency);
  return dueMinor !== undefined && dueMinor === costMinor;
}

/**
 * SCRUM-725: whether the period the acquisition was booked into is CLOSED or
 * LOCKED. A prior-period restatement through retained earnings only describes a
 * purchase whose period is already shut; for a purchase still in an open (or
 * future) period the right correction is the ordinary one, so the restatement
 * type is offered and accepted only when this is true. A missing period is not
 * "closed" — nothing has been shut, so the restatement is not offered.
 */
async function isAcquisitionPeriodClosed(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  acquisitionDate: number
): Promise<boolean> {
  // The period that contains the date is the latest one starting on or before it.
  const period = await ctx.db
    .query("accountingPeriods")
    .withIndex("by_org_startDate", (q) => q.eq("orgId", orgId).lte("startDate", acquisitionDate))
    .order("desc")
    .first();
  if (!period || period.endDate < acquisitionDate) return false;
  return period.status === "CLOSED" || period.status === "LOCKED";
}

/** The correction-type matrix, from how the car was originally paid. */
function allowedAcquisitionCorrectionTypes(
  originalPaymentMethod: string | undefined,
  payable: Doc<"vehicleSupplierPayables"> | null,
  payableAdjustable: boolean,
  acquisitionPeriodClosed: boolean
): AcquisitionCostCorrectionType[] {
  const restatement: AcquisitionCostCorrectionType[] = acquisitionPeriodClosed ? ["PRIOR_PERIOD_RESTATEMENT"] : [];
  if (originalPaymentMethod === "ON_ACCOUNT") {
    const allowed: AcquisitionCostCorrectionType[] = [];
    if (payableAdjustable) allowed.push("SUPPLIER_INVOICE_ERROR", "VENDOR_CREDIT");
    if (payable && deriveSettlementStatus(payable) === "PAID") allowed.push("CASH_REFUND");
    allowed.push(...restatement);
    return allowed;
  }
  return ["CASH_REFUND", ...restatement];
}

/** The account the correction's counter-line posts to — mirrors ruleVehicleAcquisitionCostCorrected. */
export function costCorrectionCounterKey(
  correctionType: AcquisitionCostCorrectionType,
  paymentMethod: string | undefined,
  deltaMinor?: number
): SystemKey {
  switch (correctionType) {
    case "SUPPLIER_INVOICE_ERROR":
    case "VENDOR_CREDIT":
      return SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS;
    case "CASH_REFUND":
      // A cheque received back from a supplier is held until cleared. An
      // extra amount we pay out by cheque leaves our bank.
      if (paymentMethod === "CHEQUE" && deltaMinor !== undefined && deltaMinor < 0) {
        return SYSTEM_KEYS.CHEQUES_IN_HAND;
      }
      return disbursementAccountKey(paymentMethod);
    case "PRIOR_PERIOD_RESTATEMENT":
      return SYSTEM_KEYS.RETAINED_EARNINGS;
  }
}

export type VehicleCostCorrectionInput = {
  orgId: Id<"organizations">;
  vehicleId: Id<"vehicles">;
  newCost: number;
  reason: string;
  correctionType: AcquisitionCostCorrectionType;
  paymentMethod?: PaymentMethod;
  bankAccountId?: Id<"bankAccounts">;
};

export function validateVehicleCostCorrection(args: VehicleCostCorrectionInput) {
  const reason = args.reason.trim();
  if (!reason) {
    throwAppError(
      AppErrorCode.COST_CORRECTION_REASON_REQUIRED,
      "A reason is required to correct a vehicle's purchase cost."
    );
  }
  if (!Number.isFinite(args.newCost) || args.newCost < 0) {
    throwAppError(
      AppErrorCode.COST_CORRECTION_INVALID_AMOUNT,
      "The new purchase cost must be a valid amount, zero or more."
    );
  }
  if (args.correctionType === "CASH_REFUND" && !args.paymentMethod) {
    throwAppError(
      AppErrorCode.COST_CORRECTION_PAYMENT_METHOD_REQUIRED,
      "Choose the account the refund was received into."
    );
  }
  return reason;
}

export async function inspectVehicleCostCorrection(
  ctx: MutationCtx,
  args: VehicleCostCorrectionInput,
  vehicle: Doc<"vehicles">,
) {
  if (vehicle.sourceType === "SOURCED") {
    throwAppError(
      AppErrorCode.COST_CORRECTION_SOURCED,
      "Sourced vehicles are not capitalized into inventory, so their cost cannot be corrected here. Nothing has been changed."
    );
  }
  if (vehicle.status === "SOLD") {
    throwAppError(
      AppErrorCode.COST_CORRECTION_SOLD,
      "This vehicle has already been sold, so its cost can no longer be corrected here. Ask your accountant for a manual journal entry."
    );
  }
  // Requires a *posted* acquisition, not merely pending: a correction posts
  // a delta on top of the ledger's existing balance, so the base entry
  // must already be settled — correcting against a still-pending base
  // could post before it, or interleave unpredictably with it.
  const [currency, acquisitionEvent] = await Promise.all([
    getOrgCurrency(ctx, args.orgId),
    findPostedAcquisitionEvent(ctx, args.orgId, args.vehicleId),
  ]);
  if (!acquisitionEvent) {
    throwAppError(
      AppErrorCode.COST_CORRECTION_NOT_POSTED,
      "This vehicle's purchase hasn't been posted to accounting yet, so its cost can't be corrected."
    );
  }

  // An amount that does not survive the round trip through the currency's minor units would
  // be stored as typed but posted rounded, so the vehicle and the ledger would disagree by
  // the rounding. Refused before any write.
  try {
    requireSupplierAmountMinor(args.newCost, currency);
  } catch (error) {
    console.error(error);
    throwAppError(
      AppErrorCode.COST_CORRECTION_INVALID_AMOUNT,
      "The new purchase cost must be a valid amount, zero or more."
    );
  }
  const previousCost = vehicle.purchasePrice ?? 0;
  const previousMinor = toMinorUnits(previousCost, currency);
  const newMinor = toMinorUnits(args.newCost, currency);
  const deltaMinor = newMinor - previousMinor;
  if (deltaMinor === 0) {
    throwAppError(
      AppErrorCode.COST_CORRECTION_NO_CHANGE,
      "The new purchase cost is the same as the current cost, so there is nothing to correct."
    );
  }
  // A supplier cheque RECEIVED needs a cheque-custody and clearing record,
  // which this correction flow cannot create. Never book it directly to the
  // bank or leave an untracked CHEQUES_IN_HAND balance.
  if (args.correctionType === "CASH_REFUND" && args.paymentMethod === "CHEQUE" && deltaMinor < 0) {
    throwAppError(AppErrorCode.COST_CORRECTION_HELD_CHEQUE_UNSUPPORTED,
      "A received supplier cheque cannot be recorded here until its custody and clearing can be tracked. Record a bank or cash refund only after that money is actually received.");
  }

  // ── The correction-type matrix, enforced from the ORIGINAL payment method.
  const { row, count: payableCount } = await loadAcquisitionPayable(ctx, vehicle);
  const originalMethod = resolveOriginalPaymentMethod(acquisitionEvent, payableCount);
  const rewritesPayable = originalMethod === "ON_ACCOUNT" && AP_CORRECTION_TYPES.includes(args.correctionType);
  const payableAdjustable = isPayableAdjustable(row, currency, previousCost);
  return { currency, acquisitionEvent, previousCost, deltaMinor, newMinor, row, originalMethod, rewritesPayable, payableAdjustable };
}

export async function prepareVehicleCostCorrection(
  ctx: MutationCtx,
  args: VehicleCostCorrectionInput,
  evidence: Awaited<ReturnType<typeof inspectVehicleCostCorrection>>,
  isAccountMapped: (key: SystemKey) => Promise<boolean>,
) {
  const { currency, acquisitionEvent, row, originalMethod, deltaMinor, rewritesPayable, payableAdjustable } = evidence;

  // SCRUM-725: a restatement through retained earnings is for a purchase whose
  // period is already closed. Refused with its own code, not the generic
  // "type doesn't fit", so the dialog can say exactly why even if a client
  // sends the type anyway.
  const acquisitionPeriodClosed = await isAcquisitionPeriodClosed(ctx, args.orgId, acquisitionEvent.accountingDate);
  if (args.correctionType === "PRIOR_PERIOD_RESTATEMENT" && !acquisitionPeriodClosed) {
    throwAppError(
      AppErrorCode.COST_CORRECTION_RESTATEMENT_PERIOD_OPEN,
      "Restating a purchase cost through retained earnings is only available when the purchase was recorded in a closed accounting period. This purchase is still in an open period, so choose another correction type."
    );
  }
  const allowedTypes = allowedAcquisitionCorrectionTypes(originalMethod, row, payableAdjustable, acquisitionPeriodClosed);
  if (!allowedTypes.includes(args.correctionType)) {
    throwAppError(
      AppErrorCode.COST_CORRECTION_TYPE_NOT_ALLOWED,
      "This correction type doesn't fit how the vehicle was paid for. Choose one of the other options."
    );
  }
  const payableToAdjust = rewritesPayable ? row : null;

  // ── It posts now or not at all. Both halves are checked BEFORE the first
  // write, so a refusal leaves the vehicle, the payable and the ledger as they were.
  const now = Date.now();
  const counterKey = costCorrectionCounterKey(args.correctionType, args.paymentMethod, deltaMinor);
  if (counterKey === SYSTEM_KEYS.BANK_ACCOUNT) {
    await requireActiveBankInCurrency(ctx, {
      orgId: args.orgId, bankAccountId: args.bankAccountId, currency,
      missingMessage: "Select the physical bank for this purchase cost correction.",
      currencySubject: "vehicle cost correction", errorCode: AppErrorCode.COST_CORRECTION_BANK_INVALID,
    });
  } else if (args.bankAccountId) {
    throwAppError(AppErrorCode.COST_CORRECTION_BANK_NOT_APPLICABLE, "A physical bank does not apply to this purchase cost correction.");
  }
  const [counterMapped, inventoryMapped] = await Promise.all([
    isAccountMapped(counterKey),
    isAccountMapped(SYSTEM_KEYS.VEHICLE_INVENTORY),
  ]);
  if (!counterMapped || !inventoryMapped || !(await isPostableNow(ctx, args.orgId, now))) {
    throwAppError(
      AppErrorCode.COST_CORRECTION_NOT_POSTABLE_NOW,
      "This correction can't be posted right now because the accounting period is closed or the required account is missing. Ask your accountant to open the period or set up the account, then try again."
    );
  }
  return { now, payableToAdjust };
}

export async function readVehiclePurchaseCostLock(
  ctx: QueryCtx,
  args: { orgId: Id<"organizations">; vehicleId: Id<"vehicles"> },
) {
  await loadOwnedLiveVehicle(ctx, args.orgId, args.vehicleId);
  return {
    locked: !!(await openingVehicleEvidence(ctx, args.orgId, args.vehicleId)) ||
      await hasVehicleAcquisitionAccountingExposure(ctx, args.orgId, args.vehicleId),
  };
}

export async function readVehicleCostCorrectionContext(
  ctx: QueryCtx,
  args: { orgId: Id<"organizations">; vehicleId: Id<"vehicles"> },
) {
  // The reply carries the vehicle's cost, so it needs the cost-visibility gate as well.

  const vehicle = await loadOwnedLiveVehicle(ctx, args.orgId, args.vehicleId);

  const currentCost = vehicle.purchasePrice ?? 0;
  const [currency, correctionRows, event] = await Promise.all([
    getOrgCurrency(ctx, args.orgId),
    ctx.db
      .query("vehicleCostCorrections")
      .withIndex("by_org_vehicle", (q) => q.eq("orgId", args.orgId).eq("vehicleId", args.vehicleId))
      .order("desc")
      .take(5),
    findPostedAcquisitionEvent(ctx, args.orgId, args.vehicleId),
  ]);
  const corrections = correctionRows.map((row) => ({
    previousCost: row.previousCost,
    newCost: row.newCost,
    reason: row.reason,
    correctionType: row.correctionType ?? null,
    createdAt: row.createdAt,
  }));

  const blocked = (blockedReason: "SOLD" | "SOURCED" | "NOT_POSTED" | "PENDING_POST" | "POST_FAILED") => ({
    blockedReason,
    currentCost,
    currency,
    originalPaymentMethod: null,
    payable: null,
    allowedTypes: [] as AcquisitionCostCorrectionType[],
    corrections,
  });
  if (vehicle.sourceType === "SOURCED") return blocked("SOURCED");
  if (vehicle.status === "SOLD") return blocked("SOLD");
  if (!event) {
    // Three different truths, three different instructions: still queued (wait for the period
    // or the chart), dead-lettered (finance must resolve it), and never attempted at all.
    if (await findQueuedAcquisitionPost(ctx, args.orgId, args.vehicleId, "PENDING")) return blocked("PENDING_POST");
    if (await findQueuedAcquisitionPost(ctx, args.orgId, args.vehicleId, "FAILED")) return blocked("POST_FAILED");
    return blocked("NOT_POSTED");
  }

  const { row, count } = await loadAcquisitionPayable(ctx, vehicle);
  const originalPaymentMethod = resolveOriginalPaymentMethod(event, count);
  const payableRow = originalPaymentMethod === "ON_ACCOUNT" ? row : null;

  return {
    blockedReason: null,
    currentCost,
    currency,
    originalPaymentMethod: originalPaymentMethod ?? null,
    payable: payableRow
      ? { status: payableRow.status, amountDue: payableRow.amountDue, amountPaid: settlementView(payableRow).amountPaid }
      : null,
    // SCRUM-869#c23881: while the pilot refuses the supplier-payable rewrite, do not offer it.
    allowedTypes: allowedAcquisitionCorrectionTypes(
      originalPaymentMethod,
      payableRow,
      isPayableAdjustable(payableRow, currency, currentCost),
      await isAcquisitionPeriodClosed(ctx, args.orgId, event.accountingDate)
    ).filter(
      (type) =>
        !(originalPaymentMethod === "ON_ACCOUNT" && AP_CORRECTION_TYPES.includes(type) &&
          isSupplierSettlementDoorDisabled("SUPPLIER_PAYABLE_CORRECTION_PILOT_DISABLED"))
    ),
    // SCRUM-725: restatement is offered only for a closed-period acquisition.
    corrections,
  };
}
