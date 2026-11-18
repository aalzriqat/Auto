import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

export async function projectCustomerDeposits(ctx: QueryCtx, orgId: Id<"organizations">, depositPage: Doc<"deposits">[]) {
  return Promise.all(
    depositPage
      .filter((deposit) => deposit.isDeleted !== true)
      .map(async (deposit) => {
        // Names the linked car for the customer screen. The row's own org is checked on the read, so a
        // vehicle id that points into another organization names nothing.
        const vehicle = deposit.vehicleId ? await ctx.db.get(deposit.vehicleId) : null;
        const vehicleDesc =
          vehicle && vehicle.orgId === orgId ? `${vehicle.year} ${vehicle.make} ${vehicle.model}` : undefined;
        return {
          _id: deposit._id,
          status: deposit.status,
          amountMinor: deposit.amountMinor,
          amount: deposit.amount,
          currency: deposit.currency,
          vehicleId: deposit.vehicleId,
          vehicleDesc,
          quoteId: deposit.quoteId,
          origin: deposit.origin,
          openingDepositKind: deposit.openingDepositKind,
          openingRefundReserved: deposit.openingRefundReservation !== undefined,
          createdAt: deposit.createdAt,
        };
      })
  );
}
