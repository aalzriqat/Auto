import { ConvexError, v } from "convex/values";
import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { hookDepositReceived } from "../accounting/workflowHooks";
import { createCanonicalPayment } from "../subledger";
import { scaleForCurrency, toMinorUnits } from "./money";

export const depositMethodValidator = v.union(
  v.literal("CASH"),
  v.literal("BANK_TRANSFER"),
  v.literal("PAYMENT_LINK"),
  v.literal("CARD"),
  v.literal("CHEQUE"),
  v.literal("OTHER"),
);

export type DepositMethod = "CASH" | "BANK_TRANSFER" | "PAYMENT_LINK" | "CARD" | "CHEQUE" | "OTHER";

export function normalizeCurrency(currency: string): string {
  const normalized = currency.trim().toUpperCase();
  if (!normalized) throw new ConvexError("Currency is required.");
  return normalized;
}

export function amountToMinorOrThrow(amount: number, currency: string, label = "Deposit amount"): number {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new ConvexError(`${label} must be greater than 0.`);
  }

  const scale = scaleForCurrency(currency);
  const factor = Math.pow(10, scale);
  const scaled = amount * factor;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-9) {
    throw new ConvexError(`${label} has too many decimal places for ${currency}.`);
  }

  const amountMinor = toMinorUnits(amount, currency);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    throw new ConvexError(`${label} must be a positive minor-unit amount.`);
  }
  return amountMinor;
}

export function methodOrDefault(method?: DepositMethod): DepositMethod {
  if (method === "OTHER") {
    throw new ConvexError("Select a specific payment method — OTHER is not accepted for a deposit.");
  }
  return method ?? "CASH";
}

export async function recordHeldDeposit(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    customerId: Id<"customers">;
    quoteId?: Id<"quotes">;
    reservationId?: Id<"vehicleReservations">;
    amount: number;
    amountMinor: number;
    currency: string;
    method: DepositMethod;
    actorId: Id<"users">;
    now?: number;
    notes?: string;
    idempotencyKey?: string;
    sourceLabel: string;
    /**
     * SCRUM-208 — WHICH REPRESENTATION HOLDS THIS DEPOSIT'S CARS.
     *
     * ⚠️ REQUIRED, AND WRITTEN IN THE INSERT. This is the canonical
     * authority's discriminator between the two shapes a deposit hold can
     * take:
     *
     *   false — DIRECT: the row's own `holdActive` IS the hold on its car.
     *   true  — SLICED: `depositVehicleHolds` rows are, one per car.
     *
     * It was added to the schema with readers on both sides and NO WRITER, so
     * every deposit this product creates carried `undefined` — which those
     * readers correctly treat as "predates the canonical model" and fail
     * closed on. The canonical range then matched nothing, no pointer was ever
     * stamped, and no deposit could be restored. A field with readers and no
     * writer is not a half-built feature; it is a feature that is inert on
     * every real row while its tests pass on hand-written ones.
     *
     * ⚠️ NOT DERIVED HERE. Only the caller knows whether it is about to write
     * hold rows — this function cannot see the quote's line items, and
     * guessing from `vehicleId` alone would call every multi-vehicle deposit
     * DIRECT. It is passed in, and it is not optional, so a new door cannot
     * omit it and silently create another inert row.
     */
    usesVehicleHoldRows: boolean;
  },
): Promise<Id<"deposits">> {
  const now = args.now ?? Date.now();
  const [vehicle, customer] = await Promise.all([
    ctx.db.get(args.vehicleId),
    ctx.db.get(args.customerId),
  ]);
  const vehicleLabel = vehicle
    ? `${vehicle.year} ${vehicle.make} ${vehicle.model}`.trim()
    : "Vehicle";
  const customerLabel = customer
    ? `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Customer"
    : "Customer";

  const depositId = await ctx.db.insert("deposits", {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    customerId: args.customerId,
    quoteId: args.quoteId,
    reservationId: args.reservationId,
    amount: args.amount,
    amountMinor: args.amountMinor,
    currency: args.currency,
    method: args.method,
    status: "HELD",
    holdActive: true,
    // Stamped in the insert, never patched afterwards: a deposit that exists
    // for even one write without its representation class is a row the
    // canonical readers must refuse.
    usesVehicleHoldRows: args.usesVehicleHoldRows,
    idempotencyKey: args.idempotencyKey,
    notes: args.notes,
    createdBy: args.actorId,
    createdAt: now,
  });

  await ctx.db.insert("transactions", {
    orgId: args.orgId,
    type: "IN",
    amount: args.amount,
    date: now,
    category: "DEPOSIT",
    // Cash in, but not revenue: this is the customer's money held against a
    // liability until the deal resolves it. The row stays on the operational
    // ledger — the dealership did receive it — and is kept out of the P&L,
    // which used to count it as turnover the moment it arrived and then wrote
    // the eventual sale net of it to compensate.
    excludedFromRevenue: true,
    description: `Deposit for ${args.sourceLabel} - ${vehicleLabel} - ${customerLabel}`,
    vehicleId: args.vehicleId,
    depositId,
    idempotencyKey: args.idempotencyKey,
  });

  const collectionPaymentId = await ctx.db.insert("collectionPayments", {
    orgId: args.orgId,
    customerId: args.customerId,
    vehicleId: args.vehicleId,
    direction: "IN",
    method: args.method,
    amount: args.amount,
    paymentDate: now,
    status: "POSTED",
    idempotencyKey: args.idempotencyKey,
    reference: `Deposit ${depositId}`,
    cashierId: args.actorId,
    notes: args.notes,
    createdAt: now,
  });

  const canonicalPaymentId = await createCanonicalPayment(ctx, {
    orgId: args.orgId,
    direction: "IN",
    payerType: "CUSTOMER",
    customerId: args.customerId,
    method: args.method,
    amountMinor: args.amountMinor,
    currency: args.currency,
    idempotencyKey: `deposit_received_${depositId}`,
    actorId: args.actorId,
    status: "SETTLED",
    externalReference: `Deposit ${depositId}`,
    receivedAt: now,
  });
  await ctx.db.patch(depositId, { canonicalPaymentId });
  await ctx.db.patch(collectionPaymentId, { canonicalPaymentId });

  await hookDepositReceived(ctx, {
    orgId: args.orgId,
    depositId,
    customerId: args.customerId,
    amountMinor: args.amountMinor,
    currency: args.currency,
    paymentMethod: args.method,
    actorId: args.actorId,
    occurredAt: now,
  });

  // Receipt voucher (سند قبض) — proof-of-payment document auto-generated for
  // every deposit, printable from the wizard/reservation flow that took it.
  const voucherId = await ctx.db.insert("paymentVouchers", {
    orgId: args.orgId,
    depositId,
    voucherNumber: "pending",
    customerId: args.customerId,
    customerNameSnapshot: customerLabel,
    descriptionAr: `عربون شراء سيارة ${vehicleLabel}`.trim(),
    amount: args.amount,
    amountMinor: args.amountMinor,
    currency: args.currency,
    issuedAt: now,
    issuedBy: args.actorId,
  });
  await ctx.db.patch(voucherId, {
    voucherNumber: `RV-${new Date(now).getFullYear()}-${String(voucherId).slice(-8).toUpperCase()}`,
  });

  return depositId;
}
