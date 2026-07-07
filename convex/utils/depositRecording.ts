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
