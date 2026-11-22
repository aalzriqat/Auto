import { type MutationCtx } from "../../_generated/server";
import { type Id } from "../../_generated/dataModel";
import { postDomainEvent } from "./posting";
import { ensureVatReceivableAccountIfChartReady } from "./vatAccounts";

/**
 * A receipt against a supplier receivable. Keyed on the receivable AND a
 * sequence, because a claim can legitimately be collected in several
 * instalments — keying on the receivable alone would silently drop every
 * payment after the first.
 */
export async function hookSupplierReceivableCollected(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    receivableId: Id<"vehicleSupplierReceivables">;
    vehicleId: Id<"vehicles">;
    sourcedFromName: string;
    amountMinor: number;
    currency: string;
    paymentMethod?: string;
    bankAccountId?: Id<"bankAccounts">;
    receiptSeq: number;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "SUPPLIER_RECEIVABLE_COLLECTED",
    sourceType: "vehicleSupplierReceivables",
    sourceId: args.receivableId.toString(),
    idempotencyKey: `supplier_receivable_collected_${args.receivableId}_${args.receiptSeq}`,
    // The source identity has to differ too, not just the key — see the note on
    // postDomainEvent's eventVersion.
    eventVersion: args.receiptSeq,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      receivableId: args.receivableId.toString(),
      sourcedFromName: args.sourcedFromName,
      amountMinor: args.amountMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
      bankAccountId: args.bankAccountId?.toString(),
      vehicleId: args.vehicleId.toString(),
    },
  });
}

export async function hookSupplierPaymentSettled(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    payableId: Id<"vehicleSupplierPayables">;
    openingSource?: {draftId:Id<"openingBalanceDrafts">;rowKey:string};
    openingPaymentId?:Id<"openingPayablePayments">;
    supplierId?: Id<"suppliers">;
    paymentSeq?: number;
    sourcedFromName: string;
    amountMinor: number;
    taxMinor?: number;
    currency: string;
    paymentMethod?: string;
    bankAccountId?: Id<"bankAccounts">;
    costOrigin?: "COGS" | "VEHICLE_INVENTORY";
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  if (args.taxMinor && args.taxMinor > 0) {
    await ensureVatReceivableAccountIfChartReady(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "SUPPLIER_PAYMENT_SETTLED",
    sourceType: "vehicleSupplierPayables",
    sourceId: args.payableId.toString(),
    // Sequenced: a payable can be settled in instalments, and each one is its
    // own movement of money. See the note on postDomainEvent's eventVersion for
    // why the key alone is not enough.
    idempotencyKey: `supplier_payment_settled_${args.payableId}_${args.paymentSeq ?? 1}`,
    eventVersion: args.paymentSeq ?? 1,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      payableId: args.payableId.toString(),
      openingSource:args.openingSource,
      openingPaymentId:args.openingPaymentId,
      supplierId: args.supplierId,
      sourcedFromName: args.sourcedFromName,
      amountMinor: args.amountMinor,
      taxMinor: args.taxMinor,
      currency: args.currency,
      paymentMethod: args.paymentMethod,
      bankAccountId: args.bankAccountId?.toString(),
      costOrigin: args.costOrigin,
    },
  });
}
