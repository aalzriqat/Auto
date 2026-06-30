import { ConvexError } from "convex/values";
import { Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { notifyManagers, getActorName } from "./notifications";
import { calculateCommissionFromTiers } from "./commission";
import {
  markVehicleAsSold,
  createSaleTransaction,
  closeLeadsAsWon,
} from "./saleHelpers";
import { resolveDepositsForQuote } from "./depositHelpers";
import { throwAppError, AppErrorCode } from "./errors";
import {
  hookSaleCompleted,
  hookCommissionAccrued,
  hookDepositApplied,
  getOrgCurrency,
} from "../accounting/workflowHooks";
import { toMinorUnits } from "./money";

type SaleStatus = "PENDING" | "COMPLETED" | "CANCELLED";
type FinancingType = "CASH" | "FINANCED" | "LEASE";

export async function completeSale(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    customerId: Id<"customers">;
    salespersonId: Id<"users">;
    salePrice: number;
    saleDate: number;
    status?: SaleStatus;
    quoteId?: Id<"quotes">;
    applicationId?: Id<"financeApplications">;
    taxRate?: number;
    taxAmount?: number;
    dealerFees?: number;
    downPayment?: number;
    tradeInVehicleId?: Id<"vehicles">;
    tradeInValue?: number;
    financingType?: FinancingType;
    loanAmount?: number;
    apr?: number;
    termMonths?: number;
    warrantySold?: number;
    gapSold?: number;
    idempotencyKey?: string;
    actorId: Id<"users">;
  }
): Promise<Id<"sales">> {
  const vehicle = await ctx.db.get(args.vehicleId);
  if (!vehicle || vehicle.orgId !== args.orgId) {
    throwAppError(AppErrorCode.VEHICLE_NOT_FOUND, "Vehicle not found in this organization.");
  }
  if (vehicle.status === "SOLD") {
    throwAppError(AppErrorCode.VEHICLE_ALREADY_SOLD, "This vehicle has already been sold.");
  }
  if (vehicle.status === "ARCHIVED") {
    throwAppError(AppErrorCode.VEHICLE_ARCHIVED, "Cannot sell an archived vehicle. Restore it first.");
  }

  const customer = await ctx.db.get(args.customerId);
  if (!customer || customer.orgId !== args.orgId) {
    throwAppError(AppErrorCode.CUSTOMER_NOT_FOUND, "Customer not found in this organization.");
  }

  if (args.tradeInVehicleId) {
    const tradeInVehicle = await ctx.db.get(args.tradeInVehicleId);
    if (!tradeInVehicle || tradeInVehicle.orgId !== args.orgId) {
      throw new ConvexError("Trade-in vehicle not found in this organization.");
    }
  }

  let leadId: Id<"leads"> | undefined;
  if (args.quoteId) {
    const quote = await ctx.db.get(args.quoteId);
    if (!quote || quote.orgId !== args.orgId) {
      throwAppError(AppErrorCode.QUOTE_NOT_FOUND, "Quote not found in this organization.");
    }
    if (quote.customerId !== args.customerId || quote.vehicleId !== args.vehicleId) {
      throw new ConvexError("Quote does not match the sale customer and vehicle.");
    }
    leadId = quote.leadId;
  }

  if (args.applicationId) {
    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) {
      throw new ConvexError("Finance application not found in this organization.");
    }
    if (
      app.customerId !== args.customerId ||
      app.vehicleId !== args.vehicleId ||
      (args.quoteId && app.quoteId !== args.quoteId)
    ) {
      throw new ConvexError("Finance application does not match the sale source records.");
    }
  }

  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_org_user", (q) =>
      q.eq("orgId", args.orgId).eq("userId", args.salespersonId)
    )
    .unique();
  if (!membership) {
    throwAppError(AppErrorCode.SALESPERSON_NOT_MEMBER, "Salesperson is not a member of this organization.");
  }

  const orgSettings = await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
    .unique();

  const commissionMode = orgSettings?.commissionMode ?? "AUTO_MEMBER";
  const grossProfit = vehicle.purchasePrice != null
    ? Math.max(0, args.salePrice - vehicle.purchasePrice)
    : args.salePrice;

  let commissionAmount: number | undefined;
  if (commissionMode === "AUTO_MEMBER") {
    const rate = membership.commissionRate ?? 0;
    if (rate > 0) {
      commissionAmount = grossProfit * (rate / 100);
    }
  } else if (commissionMode === "AUTO_TIERS") {
    const amount = calculateCommissionFromTiers(grossProfit, orgSettings?.commissionTiers ?? []);
    if (amount > 0) commissionAmount = amount;
  }

  const saleId = await ctx.db.insert("sales", {
    orgId: args.orgId,
    branchId: vehicle.branchId,
    vehicleId: args.vehicleId,
    customerId: args.customerId,
    salespersonId: args.salespersonId,
    salePrice: args.salePrice,
    saleDate: args.saleDate,
    status: args.status ?? "PENDING",
    taxRate: args.taxRate,
    taxAmount: args.taxAmount,
    dealerFees: args.dealerFees,
    downPayment: args.downPayment,
    tradeInVehicleId: args.tradeInVehicleId,
    tradeInValue: args.tradeInValue,
    financingType: args.financingType,
    loanAmount: args.loanAmount,
    apr: args.apr,
    termMonths: args.termMonths,
    warrantySold: args.warrantySold,
    gapSold: args.gapSold,
    commissionAmount,
    quoteId: args.quoteId,
    applicationId: args.applicationId,
    leadId,
    idempotencyKey: args.idempotencyKey,
  });

  await markVehicleAsSold(ctx, args.vehicleId);

  const currency = await getOrgCurrency(ctx, args.orgId);

  let previouslyCollected = 0;
  if (args.quoteId) {
    const resolvedResult = await resolveDepositsForQuote(ctx, {
      quoteId: args.quoteId,
      resolution: "APPLIED",
      actorId: args.actorId,
    });
    previouslyCollected = resolvedResult.total;

    for (const { depositId, customerId, amount } of resolvedResult.appliedDeposits) {
      await hookDepositApplied(ctx, {
        orgId: args.orgId,
        depositId,
        customerId,
        amountMinor: toMinorUnits(amount, currency),
        currency,
        actorId: args.actorId,
        occurredAt: args.saleDate,
        saleId,
      });
    }
  }

  await createSaleTransaction(ctx, {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    salePrice: args.salePrice,
    saleDate: args.saleDate,
    vehicle,
    previouslyCollected,
    idempotencyKey: args.idempotencyKey,
  });

  await closeLeadsAsWon(ctx, {
    orgId: args.orgId,
    customerId: args.customerId,
    vehicleId: args.vehicleId,
    leadId,
  });

  await hookSaleCompleted(ctx, {
    orgId: args.orgId,
    saleId,
    customerId: args.customerId,
    vehicleId: args.vehicleId,
    salespersonId: args.salespersonId,
    saleAmountMinor: toMinorUnits(args.salePrice, currency),
    costMinor: vehicle.purchasePrice != null ? toMinorUnits(vehicle.purchasePrice, currency) : undefined,
    currency,
    taxMinor: args.taxAmount != null ? toMinorUnits(args.taxAmount, currency) : undefined,
    actorId: args.actorId,
    occurredAt: args.saleDate,
  });

  if (commissionAmount != null && commissionAmount > 0) {
    await hookCommissionAccrued(ctx, {
      orgId: args.orgId,
      saleId,
      salespersonId: args.salespersonId,
      amountMinor: toMinorUnits(commissionAmount, currency),
      currency,
      actorId: args.actorId,
      occurredAt: args.saleDate,
    });
  }

  const actorName = await getActorName(ctx);
  await notifyManagers(
    ctx,
    args.orgId,
    "sale.created",
    { actorName, vehicleLabel: `${vehicle.year} ${vehicle.make} ${vehicle.model}` },
    { link: `/${args.orgId}/sales?highlightId=${saleId}` }
  );

  return saleId;
}
