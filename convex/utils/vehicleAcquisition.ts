import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import {
  getOrgCurrency,
  hookVehicleAcquired,
  hookVehicleAcquisitionCostCorrected,
} from "../accounting/workflowHooks";
import { requireActiveBankInCurrency } from "./bankAccountGuards";
import { AppErrorCode, throwAppError } from "./errors";
import { fromMinorUnits, toMinorUnits } from "./money";
import { getActorName, notifyManagers } from "./notifications";
import { type AcquisitionPaymentMethod, normalizePaymentMethod } from "./paymentMethods";
import { requireSupplierAmountMinor } from "./supplierPaymentAmounts";
import { SUPPLIER_ERROR, type SupplierSnapshot, throwSupplierError } from "./supplierRegistry";
import type {
  VehicleCostCorrectionInput,
  inspectVehicleCostCorrection,
  prepareVehicleCostCorrection,
} from "./vehicleCostCorrection";
import { storedVehicleSourceType, throwVehicleSourceShape } from "./vehicleSourceShape";
import { ConvexError } from "convex/values";

/**
 * Posts the VEHICLE_ACQUIRED GL entry (+ legacy VEHICLE_PURCHASE transaction
 * row) for owned stock with a purchase price — shared by the direct
 * vehicles.create mutation, vehicles.update (a SOURCED→STOCK flip or a price
 * set for the first time), and vehicleEdits.resolve's CREATE-approval branch,
 * so a vehicle acquired via any of those paths gets the exact same accounting
 * treatment. Sourced/drop-ship vehicles never sit in physical inventory, so
 * this is a no-op for those.
 *
 * ON_ACCOUNT means no cash moved: instead of the legacy cash-transaction row,
 * this creates a vehicleSupplierPayables row (no saleId — settled independently
 * of any future sale, via the same sourcingPayables.markPaid a sourced
 * vehicle's payable uses) and credits AP-Suppliers in the GL instead of a
 * cash/bank account.
 */
export async function postOwnedVehicleAcquisition(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    isSourced: boolean;
    purchasePrice: number | undefined;
    purchasePaymentMethod?: AcquisitionPaymentMethod;
    bankAccountId?: Id<"bankAccounts">;
    /**
     * Required when purchasePaymentMethod is "ON_ACCOUNT": who the payable is owed to, as the
     * SERVER-resolved supplier master snapshot (SCRUM-868 P2). A name alone is not accepted.
     */
    creditor?: SupplierSnapshot;
    vehicleLabel: string;
    vin: string;
    actorId: Id<"users">;
  }
): Promise<void> {
  if (args.isSourced || args.purchasePrice == null || args.purchasePrice <= 0) return;

  // Defence at the money point: the caller's `isSourced` flag is a claim, the
  // stored row is the truth. Every caller posts AFTER its insert/patch, so the
  // row already reflects the final type; a consignment row never posts a purchase.
  const stored = await ctx.db.get(args.vehicleId);
  if (stored && storedVehicleSourceType(stored.sourceType) === "SOURCED") {
    throwVehicleSourceShape("VEHICLE_SOURCED_ACQUISITION_REFUSED");
  }

  const isOnAccount = args.purchasePaymentMethod === "ON_ACCOUNT";
  // No bypass writer (design prediction 1): the money point itself refuses an on-account purchase
  // that carries no resolved creditor, whatever the caller validated before.
  if (isOnAccount && !args.creditor) {
    throwSupplierError(SUPPLIER_ERROR.IDENTITY_REQUIRED, "A supplier is required.");
  }

  const now = Date.now();
  const currency = await getOrgCurrency(ctx, args.orgId);
  requireSupplierAmountMinor(args.purchasePrice, currency);
  const bankMethod = args.purchasePaymentMethod === "BANK_TRANSFER" ||
    args.purchasePaymentMethod === "CARD" || args.purchasePaymentMethod === "CHEQUE";
  if (bankMethod) {
    await requireActiveBankInCurrency(ctx, {
      orgId: args.orgId,
      bankAccountId: args.bankAccountId,
      currency,
      missingMessage: "Choose the bank account used to purchase this vehicle.",
      currencySubject: "vehicle purchase",
    });
  } else if (args.bankAccountId) {
    throw new ConvexError("A bank account is only valid for a bank-funded vehicle purchase.");
  }

  if (isOnAccount) {
    // No cash actually moved — the legacy transactions table only records
    // real cash movements (a SOURCED vehicle's supplier payable, which never
    // touches this table either, is the existing precedent).
    await hookVehicleAcquired(ctx, {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      costMinor: toMinorUnits(args.purchasePrice, currency),
      currency,
      paymentMethod: "ON_ACCOUNT",
      bankAccountId: undefined,
      actorId: args.actorId,
      occurredAt: now,
    });
    await ctx.db.insert("vehicleSupplierPayables", {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      sourcedFromName: args.creditor!.name,
      supplierId: args.creditor!.supplierId,
      supplierSnapshotVersion: args.creditor!.version,
      amountDue: args.purchasePrice,
      currency,
      status: "PENDING",
      createdBy: args.actorId,
      createdAt: now,
      updatedAt: now,
    });
    return;
  }

  await ctx.db.insert("transactions", {
    orgId: args.orgId,
    type: "OUT",
    amount: args.purchasePrice,
    date: now,
    category: "VEHICLE_PURCHASE",
    description: `Purchase of vehicle ${args.vehicleLabel} (VIN: ${args.vin})`,
    vehicleId: args.vehicleId,
  });

  await hookVehicleAcquired(ctx, {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    costMinor: toMinorUnits(args.purchasePrice, currency),
    currency,
    // Excludes "ON_ACCOUNT" — handled in the early-return branch above.
    paymentMethod: normalizePaymentMethod(args.purchasePaymentMethod as Exclude<AcquisitionPaymentMethod, "ON_ACCOUNT"> | undefined),
    bankAccountId: args.bankAccountId,
    actorId: args.actorId,
    occurredAt: now,
  });
}

/**
 * A posted or queued acquisition locks the recorded cost. A correction must
 * move the vehicle's cost and its journal together.
 */
async function hasPostedVehicleAcquisition(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  const postedEvent = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", orgId).eq("sourceType", "vehicles").eq("sourceId", vehicleId.toString())
    )
    .filter((q) => q.eq(q.field("eventType"), "VEHICLE_ACQUIRED"))
    .first();
  return postedEvent !== null;
}

/**
 * True once a vehicle's acquisition is either posted to the GL or durably
 * queued in the accounting outbox — reused by the legacy transaction
 * migration tool (accountingMigration.ts) so it can recognize a
 * VEHICLE_PURCHASE transaction row as already accounted for via its
 * companion VEHICLE_ACQUIRED event (sourced from "vehicles", not
 * "transactions") instead of posting a second, duplicate event.
 */
export async function hasVehicleAcquisitionAccountingExposure(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  if (await hasPostedVehicleAcquisition(ctx, orgId, vehicleId)) return true;

  const pendingPost = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", orgId).eq("idempotencyKey", `vehicle_acquired_${vehicleId}`))
    .first();
  return pendingPost !== null;
}

/**
 * True once a landed-cost capitalization (posted or queued) exists for the
 * vehicle. Together with `hasVehicleAcquisitionAccountingExposure` this is the
 * vehicle's owned-inventory exposure: a landed cost debits Vehicle Inventory for
 * a car the dealership owns, and can exist without any acquisition (an owned car
 * entered without a purchase price). `landedCostTotal` is NOT evidence, because
 * it can be edited back to 0 after the posting, so the accounting records
 * themselves are read, by index range on the source and idempotency prefixes
 * that `hookVehicleLandedCostCapitalized` writes.
 *
 * Deliberately separate from `hasVehicleAcquisitionAccountingExposure`, whose
 * semantics `accountingMigration.ts` depends on. The flip guard in `update`
 * checks the two separately because each has its own coded refusal.
 */
export async function hasVehicleLandedCostAccountingExposure(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  const sourcePrefix = `${vehicleId}_`;
  const postedLandedCost = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", orgId).eq("sourceType", "vehicleLandedCosts").gte("sourceId", sourcePrefix).lt("sourceId", `${sourcePrefix}￿`)
    )
    .first();
  if (postedLandedCost !== null) return true;

  const keyPrefix = `landed_cost_${vehicleId}_`;
  const queuedLandedCost = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", orgId).gte("idempotencyKey", keyPrefix).lt("idempotencyKey", `${keyPrefix}￿`)
    )
    .first();
  return queuedLandedCost !== null;
}

/** True when the vehicle's landed-cost row holds any non-zero item (offsetting items included). */
export async function hasNonZeroLandedCostItems(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<boolean> {
  const row = await ctx.db
    .query("vehicleLandedCosts")
    .withIndex("by_org_vehicle", (q) => q.eq("orgId", orgId).eq("vehicleId", vehicleId))
    .first();
  return (row?.items ?? []).some((item) => item.amount !== 0);
}

/** The refusal for a direct edit of a posted purchase cost (vehicles.update and vehicleEdits.resolve). */
export function throwVehicleCostPosted(): never {
  throwAppError(
    AppErrorCode.VEHICLE_COST_POSTED,
    "This vehicle's purchase cost has already been posted to accounting and can't be edited directly. Use 'Correct purchase cost' instead."
  );
}

/**
 * STRICTER than `hasVehicleAcquisitionAccountingExposure`, and deliberately local.
 *
 * The shared helper answers "was an attempt ever made". That is the right
 * question for `accountingMigration`, which uses it to avoid posting a second
 * event. It is the wrong question here, because this guard uses the answer to
 * take its PERMISSIVE branch — to conclude a car is already capitalized and may
 * be skipped — so it has to prove capitalization is CURRENTLY TRUE, not that
 * something was once attempted.
 *
 * `accountingEvents.status` is PENDING | POSTED | FAILED | REVERSED and the
 * shared helper inspects none of them. A REVERSED acquisition, whose journal has
 * been netted back to zero, and a dead-lettered FAILED outbox row would both
 * read as "capitalized", and the car would be silently skipped forever while a
 * later sale credits Vehicle Inventory against a debit that no longer exists.
 *
 * The shared helper is deliberately NOT changed: it has five other callers in
 * `accountingMigration.ts` and `vehicleEdits.ts` whose looser semantics are
 * correct for what they ask, and widening this change to alter their behaviour
 * is the scope creep that produced the defects this round exists to close.
 * SCRUM-94 owns the durable identity work; SCRUM-166 owns the shared helper.
 *
 * It returns the EVIDENCE rather than a boolean because "an acquisition was
 * posted for this vehicleId" is not enough to conclude that a row in a new
 * import is a retry OF THAT PURCHASE. A vehicle document is editable — make,
 * model and year can all be corrected after the fact — so vehicle facts alone
 * are a contradiction check, not proof of economic identity. The posted event
 * carries the part that cannot be edited from the vehicle screen: what was
 * capitalized, in which currency, and how it was paid. See
 * `acquisitionFingerprintMismatch`.
 */
export interface ProvenAcquisitionEvidence {
  /** From the event payload. `undefined` means the record cannot prove it. */
  costMinor: number | undefined;
  currency: string | undefined;
  paymentMethod: string | undefined;
  bankAccountId: string | undefined;
}

export async function provenAcquisitionEvidence(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<ProvenAcquisitionEvidence | null> {
  const events = await ctx.db
    .query("accountingEvents")
    .withIndex("by_org_source", (q) =>
      q.eq("orgId", orgId).eq("sourceType", "vehicles").eq("sourceId", vehicleId.toString())
    )
    .filter((q) => q.eq(q.field("eventType"), "VEHICLE_ACQUIRED"))
    .collect();
  const posted = events.find((event) => event.status === "POSTED");
  if (posted) return readAcquisitionEvidence(posted.payload, posted.currency);

  // An outbox row still queued to POST is durable and will post, so it is real
  // exposure. A FAILED row has been dead-lettered and is not — accepting one
  // would skip a car that never capitalized, which is SCRUM-59 itself arriving
  // by another route (covered: "a DEAD-LETTERED outbox row is not proof").
  // A row already resolved to POSTED is represented by the event checked above.
  //
  // ⚠️ The `kind === "POST"` half has NO test, deliberately. Mutation testing
  // found it survives deletion, and the reason is that the state it excludes is
  // unreachable: `enqueuePendingReversal` is the only writer of a REVERSE row,
  // and every caller supplies a prefixed key (`reversed_*`, `trade_in_reversed_*`,
  // `sale_cancelled_*`, `prepaid_reversed_*`, `cheque_return_after_clear_*`, ...),
  // so no REVERSE row can carry `vehicle_acquired_<id>` and this lookup can
  // never return one. It is kept as a fail-closed assertion of that invariant,
  // not removed — but a test for it would assert a shape the system does not
  // produce, which is worse than none.
  const queued = await ctx.db
    .query("pendingAccountingEvents")
    .withIndex("by_org_idempotency", (q) =>
      q.eq("orgId", orgId).eq("idempotencyKey", `vehicle_acquired_${vehicleId}`)
    )
    .collect();
  const pending = queued.find((row) => row.kind === "POST" && row.status === "PENDING");
  if (pending) return readAcquisitionEvidence(pending.payload, pending.currency);
  return null;
}

/**
 * `payload` is `v.any()`, so every field here is read defensively and a value of
 * the wrong shape becomes `undefined` rather than being trusted. `undefined` is
 * never treated as agreement — the caller refuses on it.
 */
function readAcquisitionEvidence(
  payload: unknown,
  rowCurrency: string | undefined
): ProvenAcquisitionEvidence {
  const p = (payload ?? {}) as Record<string, unknown>;
  const costMinor = typeof p.costMinor === "number" && Number.isFinite(p.costMinor) ? p.costMinor : undefined;
  const payloadCurrency = typeof p.currency === "string" && p.currency.trim() ? p.currency : undefined;
  const paymentMethod = typeof p.paymentMethod === "string" && p.paymentMethod.trim() ? p.paymentMethod : undefined;
  const bankAccountId = typeof p.bankAccountId === "string" && p.bankAccountId.trim() ? p.bankAccountId : undefined;
  return { costMinor, currency: payloadCurrency ?? rowCurrency, paymentMethod, bankAccountId };
}

/** Records the audit, cashbook and ledger effects of a validated cost correction. */
export async function recordVehicleCostCorrection(
  ctx: MutationCtx,
  args: VehicleCostCorrectionInput,
  correction: {
    vehicle: Doc<"vehicles">;
    actorId: Id<"users">;
    reason: string;
    evidence: Awaited<ReturnType<typeof inspectVehicleCostCorrection>>;
    posting: Awaited<ReturnType<typeof prepareVehicleCostCorrection>>;
  },
) {
  const { vehicle, actorId, reason, evidence, posting: { now, payableToAdjust } } = correction;
  const { previousCost, originalMethod, deltaMinor, currency } = evidence;

  const correctionId = await ctx.db.insert("vehicleCostCorrections", {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    previousCost,
    newCost: args.newCost,
    reason,
    correctionType: args.correctionType,
    bankAccountId: args.bankAccountId,
    // What the supplier balance was before this correction rewrote it, so the audit trail can
    // reconstruct the payable from the correction row alone.
    ...(payableToAdjust
      ? { payableId: payableToAdjust._id, previousAmountDue: payableToAdjust.amountDue }
      : {}),
    correctedBy: actorId,
    createdAt: now,
  });

  // A cash/bank correction moved real money, so the cashbook gets a row for it. The ORIGINAL
  // purchase row is never edited: the correction is its own dated entry, linked back by its
  // idempotency key. AP and restatement corrections move no cash and write nothing here.
  //
  // An ON_ACCOUNT-origin car gets NO row: neither its acquisition nor its supplier payments
  // (sourcingPayables markPaid / recordPartialPayment) are ever projected into the cashbook, so
  // a lone refund IN row would drive P&L cost of goods negative. The GL still posts in full.
  if (args.correctionType === "CASH_REFUND" && originalMethod !== "ON_ACCOUNT") {
    await ctx.db.insert("transactions", {
      orgId: args.orgId,
      // Money back from the supplier is cash IN; an underpayment settled now is cash OUT.
      type: deltaMinor < 0 ? "IN" : "OUT",
      amount: fromMinorUnits(Math.abs(deltaMinor), currency),
      date: now,
      category: "VEHICLE_PURCHASE",
      description: `Purchase cost correction (${args.paymentMethod ?? "CASH"}) for vehicle ${vehicle.year} ${vehicle.make} ${vehicle.model} (VIN: ${vehicle.vin})`,
      idempotencyKey: `vehicle_cost_correction_${correctionId}`,
      vehicleId: args.vehicleId,
    });
  }

  await hookVehicleAcquisitionCostCorrected(ctx, {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    // The correction record's own _id, not a timestamp — two corrections
    // landing in the same millisecond must not collide on idempotencyKey.
    correctionToken: correctionId.toString(),
    deltaMinor,
    currency,
    correctionType: args.correctionType,
    paymentMethod: args.paymentMethod,
    bankAccountId: args.bankAccountId,
    actorId: actorId,
    occurredAt: now,
  });

  const actorName = await getActorName(ctx);
  await notifyManagers(
    ctx,
    args.orgId,
    "vehicle.cost_corrected",
    { actorName, vehicleLabel: `${vehicle.year} ${vehicle.make} ${vehicle.model}` },
    { link: `/${args.orgId}/vehicles?highlightId=${args.vehicleId}` }
  );

  return { previousCost, newCost: args.newCost };
}
