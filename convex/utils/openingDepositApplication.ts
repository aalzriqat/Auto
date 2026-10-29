import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { recordDepositApplication } from "./depositApplications";
import { fromMinorUnits } from "./money";
import { selectOpeningDepositsForSale } from "./openingDepositSelection";

/**
 * SCRUM-858 S1 (owner ruling SCRUM-858#c23884): the ONE door that consumes a named
 * opening deposit.
 *
 * An opening deposit was already held when the books opened, so it has no quote,
 * no vehicle hold and no receipt of its own, and the quote-keyed resolver
 * (`resolveDepositsForQuote`) can never see it. This pass is the customer-keyed
 * equivalent for exactly that population, and it goes through the same stored
 * application identity (`recordDepositApplication`) as every other deposit, so
 * a cancellation, a reversal and the reconciliation read it like any other.
 *
 * What it will and will not take, stated so nobody has to infer it:
 *   - RESERVATION deposits only. A security deposit is the customer's refundable
 *     guarantee, not a payment for a car, so nothing here spends it.
 *   - A row naming a VIN is applied only to a sale of that VIN. A row naming none
 *     is customer credit and is applied to the customer's sale.
 *   - A row is applied whole or not at all, and never beyond what the customer
 *     was billed. A row that does not fit stays HELD for a later sale.
 *   - Never refunded or forfeited (see openingDepositContainment.ts).
 */

export type AppliedOpeningDeposit = {
  depositId: Id<"deposits">;
  customerId: Id<"customers">;
  /** Major units, like the native appliedDeposits it is merged into. */
  amount: number;
  vehicleId: Id<"vehicles">;
};

export async function applyOpeningDepositsToSale(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    customerId: Id<"customers">;
    vehicleId: Id<"vehicles">;
    saleId: Id<"sales">;
    quoteId?: Id<"quotes">;
    quoteLineIndex?: number;
    currency: string;
    /** What the customer was billed and has not already covered by another deposit. */
    capMinor: number;
    actorId: Id<"users">;
    occurredAt: number;
  }
): Promise<AppliedOpeningDeposit[]> {
  // The same read-only selection the cash pay-first check uses (openingDepositSelection.ts).
  const picks = await selectOpeningDepositsForSale(ctx, args);
  const applied: AppliedOpeningDeposit[] = [];
  for (const { deposit, rowMinor } of picks) {
    // `holdActive` is not written: an opening deposit is born `holdActive: false`
    // (`insertOpeningDeposit`) and there is no vehicle hold to lift.
    await ctx.db.patch(deposit._id, {
      status: "APPLIED",
      resolvedBy: args.actorId,
      resolvedAt: args.occurredAt,
      resolutionSaleId: args.saleId,
    });
    await recordDepositApplication(ctx, {
      orgId: args.orgId,
      depositId: deposit._id,
      quoteId: args.quoteId,
      quoteLineIndex: args.quoteLineIndex,
      vehicleId: args.vehicleId,
      saleId: args.saleId,
      customerId: deposit.customerId,
      amountMinor: rowMinor,
      currency: args.currency,
      treatment: "CUSTOMER_RECEIVABLE",
      actorId: args.actorId,
      occurredAt: args.occurredAt,
    });
    applied.push({
      depositId: deposit._id,
      customerId: deposit.customerId,
      amount: fromMinorUnits(rowMinor, args.currency),
      vehicleId: args.vehicleId,
    });
  }
  return applied;
}