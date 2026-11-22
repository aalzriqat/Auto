import { type MutationCtx } from "../../_generated/server";
import { type Id } from "../../_generated/dataModel";
import { postDomainEvent } from "./posting";
import { type FinancedSalePlanPayload, saleCompletedKey } from "../postingRules";
import { isChartInitialized } from "../chartAccountsRead";
import {
  ensureSaleFiAccounts,
  ensureConsignmentAccounts,
  ensureFinancedSettlementAccounts,
} from "../chartAccountsProvision";
import { makeReversalHook } from "./reversal";

/**
 * Restates one historical consigned sale from principal to agent basis. The
 * idempotency key is the sale, so a re-run of the migration posts nothing:
 * postOrEnqueue drops an event whose key is already POSTED or already queued.
 */
export async function hookConsignedSaleReclassified(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    vehicleId: Id<"vehicles">;
    customerId: Id<"customers">;
    currency: string;
    revenueMinor: number;
    commissionMinor: number;
    cogsMinor: number;
    actorId: Id<"users">;
    occurredAt: number;
  }
) {
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "CONSIGNED_SALE_RECLASSIFIED",
    sourceType: "sales",
    sourceId: args.saleId.toString(),
    idempotencyKey: `consigned_agent_reclass_${args.saleId}`,
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      saleId: args.saleId.toString(),
      vehicleId: args.vehicleId.toString(),
      customerId: args.customerId.toString(),
      currency: args.currency,
      revenueMinor: args.revenueMinor,
      commissionMinor: args.commissionMinor,
      cogsMinor: args.cogsMinor,
    },
  });
}

export async function hookSaleCompleted(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    customerId: Id<"customers">;
    vehicleId: Id<"vehicles">;
    salespersonId: Id<"users">;
    saleAmountMinor: number;
    costMinor: number | undefined;
    currency: string;
    taxMinor: number | undefined;
    actorId: Id<"users">;
    occurredAt: number;
    /** Pass true for drop-shipped vehicles — credits AP-Suppliers instead of Vehicle Inventory for COGS. */
    isSourced?: boolean;
    /** Present when the vehicle is the supplier's and this sale is on agent basis — see SaleCompletedPayload. */
    consignment?: {
      supplierEntitlementMinor: number;
      /** What the third party actually pays the supplier on the direct route — see SaleCompletedPayload. */
      supplierGrossReceiptMinor?: number;
      /** Whether an outside financier pays for the car — see SaleCompletedPayload. */
      externallyFinanced?: boolean;
      /** Whether that financier is a CONFIGURED company — see SaleCompletedPayload. */
      financedByConfiguredCompany?: boolean;
      supplierName?: string;
      settlementRoute: "DIRECT_TO_SUPPLIER" | "THROUGH_DEALERSHIP";
    };
    /** Documentation/admin fees on top of the vehicle price — added to the AR debit, credited to Dealer Fee Income. */
    dealerFeesMinor?: number;
    /** Warranty/GAP premium collected and the portion owed to the third-party underwriter — see SaleCompletedPayload. */
    warrantySoldMinor?: number;
    warrantyCostMinor?: number;
    gapSoldMinor?: number;
    gapCostMinor?: number;
    /**
     * Present only on an external financed sale settled through the dealership.
     * Carries the frozen recognition plan into the sale's own journal entry, so
     * the sale has exactly one writer and its reversal mirrors what posted.
     */
    financedSalePlan?: FinancedSalePlanPayload;
  }
) {
  // Self-heal for orgs that initialized their chart before dealer-fee/warranty/GAP
  // support existed — only relevant when this specific sale actually uses one
  // of those fields, to avoid the extra lookups on every ordinary sale.
  if (args.dealerFeesMinor || args.warrantySoldMinor || args.gapSoldMinor) {
    if (await isChartInitialized(ctx, args.orgId)) {
      await ensureSaleFiAccounts(ctx, args.orgId, args.actorId);
    }
  }
  // Every existing org's chart predates agent accounting, so the first sourced
  // sale after deploy would otherwise fail to resolve these three keys.
  if (args.consignment && (await isChartInitialized(ctx, args.orgId))) {
    await ensureConsignmentAccounts(ctx, args.orgId, args.actorId);
  }
  // Same reason, for the contra-revenue, finance-payable and settlement-expense
  // accounts a financed plan posts to. Scoped to sales that carry one.
  if (args.financedSalePlan && (await isChartInitialized(ctx, args.orgId))) {
    await ensureFinancedSettlementAccounts(ctx, args.orgId, args.actorId);
  }
  await postDomainEvent(ctx, {
    orgId: args.orgId,
    eventType: "SALE_COMPLETED",
    sourceType: "sales",
    sourceId: args.saleId.toString(),
    idempotencyKey: saleCompletedKey(args.saleId),
    currency: args.currency,
    occurredAt: args.occurredAt,
    actorId: args.actorId,
    payload: {
      saleId: args.saleId.toString(),
      saleAmountMinor: args.saleAmountMinor,
      costMinor: args.costMinor,
      currency: args.currency,
      customerId: args.customerId.toString(),
      vehicleId: args.vehicleId.toString(),
      salespersonId: args.salespersonId.toString(),
      taxMinor: args.taxMinor,
      // Stamped unconditionally, like `consignmentEvaluated` below and for the
      // same reason: it says "this payload was built by code that knows
      // `saleAmountMinor` is tax-EXCLUSIVE" (SCRUM-22). An event queued before
      // this deploy carries no marker, and its receivable was sized without the
      // tax, so `ruleSaleCompleted` posts it on the old basis and the two stay
      // consistent. Without the marker the drain would debit AR the tax as
      // well and strand it against a receivable that can never cover it.
      taxConventionExclusive: true,
      isSourced: args.isSourced ?? false,
      // Stamped unconditionally. It says "this payload was built by code that
      // considers consignment", which is what lets ruleSaleCompleted refuse a
      // sourced sale with no consignment block without also refusing the ones
      // queued before agent basis existed. See SaleCompletedPayload.
      consignmentEvaluated: true,
      ...(args.consignment ? { consignment: args.consignment } : {}),
      dealerFeesMinor: args.dealerFeesMinor,
      warrantySoldMinor: args.warrantySoldMinor,
      warrantyCostMinor: args.warrantyCostMinor,
      gapSoldMinor: args.gapSoldMinor,
      gapCostMinor: args.gapCostMinor,
      ...(args.financedSalePlan ? { financedSalePlan: args.financedSalePlan } : {}),
    },
  });
}

/** Reverses the SALE_COMPLETED entry (or cancels its pending post) when a sale is cancelled. */
export const hookSaleCancelled = makeReversalHook<{ saleId: Id<"sales"> }>({
  eventType: "SALE_COMPLETED",
  sourceType: "sales",
  sourceId: (a) => a.saleId.toString(),
  reversalKey: (a) => `sale_cancelled_${a.saleId}`,
  pendingPostKey: (a) => `sale_completed_${a.saleId}`,
});
