import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
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
import { computeVehicleCapitalizedCost } from "./vehicleCost";
import {
  allocatePaymentToReceivable,
  createCanonicalPayment,
  ensureReceivableDocument,
} from "../subledger";

type SaleStatus = "PENDING" | "COMPLETED" | "CANCELLED";
type FinancingType = "CASH" | "FINANCED" | "LEASE";

type SaleCompletionArgs = {
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
};

type PreparedSaleCompletion = {
  vehicle: Doc<"vehicles">;
  customer: Doc<"customers">;
  leadId?: Id<"leads">;
  commissionAmount?: number;
  currency: string;
};

async function prepareSaleCompletion(
  ctx: MutationCtx,
  args: SaleCompletionArgs
): Promise<PreparedSaleCompletion> {
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
    // A multi-vehicle quote's vehicleId is only its first line item — accept
    // any vehicle actually on the quote, not just the primary one.
    const quoteVehicleIds = quote.vehicleItems
      ? quote.vehicleItems.map((item) => item.vehicleId)
      : [quote.vehicleId];
    if (quote.customerId !== args.customerId || !quoteVehicleIds.includes(args.vehicleId)) {
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
  // Same cost basis the GL uses for COGS (purchase + landed costs + capitalized
  // reconditioning expenses) — previously this only subtracted purchasePrice,
  // so commission, the GL, and the operational reports could each show a
  // different margin for the same sale.
  const vehicleCost = await computeVehicleCapitalizedCost(ctx, vehicle);
  const grossProfit = Math.max(0, args.salePrice - vehicleCost);

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

  const currency = await getOrgCurrency(ctx, args.orgId);

  return { vehicle, customer, leadId, commissionAmount, currency };
}

async function insertSaleRecord(
  ctx: MutationCtx,
  args: SaleCompletionArgs,
  prepared: PreparedSaleCompletion,
  status: "PENDING" | "COMPLETED",
  commissionAmount?: number
) {
  return await ctx.db.insert("sales", {
    orgId: args.orgId,
    branchId: prepared.vehicle.branchId,
    vehicleId: args.vehicleId,
    customerId: args.customerId,
    salespersonId: args.salespersonId,
    salePrice: args.salePrice,
    saleDate: args.saleDate,
    status,
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
    leadId: prepared.leadId,
    idempotencyKey: args.idempotencyKey,
  });
}

async function applySaleCompletionSideEffects(
  ctx: MutationCtx,
  args: SaleCompletionArgs,
  prepared: PreparedSaleCompletion,
  saleId: Id<"sales">
) {
  await markVehicleAsSold(ctx, args.vehicleId);

  let previouslyCollected = 0;
  let appliedDeposits: Array<{ depositId: Id<"deposits">; customerId: Id<"customers">; amount: number }> = [];
  if (args.quoteId) {
    const resolvedResult = await resolveDepositsForQuote(ctx, {
      quoteId: args.quoteId,
      resolution: "APPLIED",
      actorId: args.actorId,
    });
    previouslyCollected = resolvedResult.total;
    appliedDeposits = resolvedResult.appliedDeposits;

    for (const { depositId, customerId, amount } of resolvedResult.appliedDeposits) {
      await hookDepositApplied(ctx, {
        orgId: args.orgId,
        depositId,
        customerId,
        amountMinor: toMinorUnits(amount, prepared.currency),
        currency: prepared.currency,
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
    vehicle: prepared.vehicle,
    customer: prepared.customer,
    previouslyCollected,
    idempotencyKey: args.idempotencyKey,
  });

  await closeLeadsAsWon(ctx, {
    orgId: args.orgId,
    customerId: args.customerId,
    vehicleId: args.vehicleId,
    leadId: prepared.leadId,
  });

  const isSourced = prepared.vehicle.sourceType === "SOURCED";
  // Single authoritative cost basis (see computeVehicleCapitalizedCost): for
  // sourced vehicles this is sourceCost; for owned stock it's purchase price
  // plus everything capitalized into Vehicle Inventory along the way (landed
  // costs, reconditioning expenses) — the exact amount that was debited to
  // VEHICLE_INVENTORY, so this credit fully relieves it at sale.
  const costAmount = await computeVehicleCapitalizedCost(ctx, prepared.vehicle);
  const costMinor = costAmount > 0 ? toMinorUnits(costAmount, prepared.currency) : undefined;

  await hookSaleCompleted(ctx, {
    orgId: args.orgId,
    saleId,
    customerId: args.customerId,
    vehicleId: args.vehicleId,
    salespersonId: args.salespersonId,
    saleAmountMinor: toMinorUnits(args.salePrice, prepared.currency),
    costMinor,
    currency: prepared.currency,
    taxMinor: args.taxAmount != null ? toMinorUnits(args.taxAmount, prepared.currency) : undefined,
    actorId: args.actorId,
    occurredAt: args.saleDate,
    isSourced,
  });

  const saleReceivableId = await ensureReceivableDocument(ctx, {
    orgId: args.orgId,
    branchId: prepared.vehicle.branchId,
    documentType: "INVOICE",
    payerType: "CUSTOMER",
    customerId: args.customerId,
    sourceType: "sales",
    sourceId: saleId,
    originalAmountMinor: toMinorUnits(args.salePrice, prepared.currency),
    currency: prepared.currency,
    issueDate: args.saleDate,
    dueDate: args.saleDate,
    actorId: args.actorId,
  });
  await ctx.db.patch(saleId, { canonicalReceivableDocumentId: saleReceivableId });

  for (const { depositId, amount } of appliedDeposits) {
    const depositPaymentId = await createCanonicalPayment(ctx, {
      orgId: args.orgId,
      branchId: prepared.vehicle.branchId,
      direction: "IN",
      payerType: "CUSTOMER",
      customerId: args.customerId,
      method: "OTHER",
      amountMinor: toMinorUnits(amount, prepared.currency),
      currency: prepared.currency,
      idempotencyKey: `deposit_received_${depositId}`,
      actorId: args.actorId,
      status: "SETTLED",
      externalReference: `Deposit ${depositId}`,
      receivedAt: args.saleDate,
    });
    await allocatePaymentToReceivable(ctx, {
      orgId: args.orgId,
      paymentId: depositPaymentId,
      receivableDocumentId: saleReceivableId,
      amountMinor: toMinorUnits(amount, prepared.currency),
      actorId: args.actorId,
    });
  }

  // For sourced vehicles, record the outstanding payable to the supplier dealer.
  // The GL entry (DR COGS / CR AP-Suppliers) was already posted by hookSaleCompleted.
  if (isSourced && costAmount > 0) {
    const now = Date.now();
    await ctx.db.insert("vehicleSupplierPayables", {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      saleId,
      sourcedFromName: prepared.vehicle.sourcedFromName ?? "Unknown supplier",
      amountDue: costAmount,
      currency: prepared.currency,
      status: "PENDING",
      createdBy: args.actorId,
      createdAt: now,
      updatedAt: now,
    });
  }

  if (prepared.commissionAmount != null && prepared.commissionAmount > 0) {
    await hookCommissionAccrued(ctx, {
      orgId: args.orgId,
      saleId,
      salespersonId: args.salespersonId,
      amountMinor: toMinorUnits(prepared.commissionAmount, prepared.currency),
      currency: prepared.currency,
      actorId: args.actorId,
      occurredAt: args.saleDate,
    });
  }

  const actorName = await getActorName(ctx);
  await notifyManagers(
    ctx,
    args.orgId,
    "sale.created",
    { actorName, vehicleLabel: `${prepared.vehicle.year} ${prepared.vehicle.make} ${prepared.vehicle.model}` },
    { link: `/${args.orgId}/sales?highlightId=${saleId}` }
  );
}

export async function createDraftSale(
  ctx: MutationCtx,
  args: SaleCompletionArgs
): Promise<Id<"sales">> {
  if (args.status !== undefined && args.status !== "PENDING") {
    throwAppError(AppErrorCode.VALIDATION_FAILED, "Draft sales must be created with PENDING status.");
  }
  const prepared = await prepareSaleCompletion(ctx, args);
  return await insertSaleRecord(ctx, args, prepared, "PENDING");
}

export async function completeSale(
  ctx: MutationCtx,
  args: SaleCompletionArgs
): Promise<Id<"sales">> {
  if (args.status !== "COMPLETED") {
    throwAppError(
      AppErrorCode.VALIDATION_FAILED,
      "Sales completion must be explicit. Use createDraft for PENDING sales."
    );
  }

  const prepared = await prepareSaleCompletion(ctx, args);
  const saleId = await insertSaleRecord(ctx, args, prepared, "COMPLETED", prepared.commissionAmount);
  await applySaleCompletionSideEffects(ctx, args, prepared, saleId);

  return saleId;
}

/**
 * Completes one sale per vehicle on a (possibly multi-vehicle) quote/application,
 * all sharing the same quoteId — inventory is tracked per-VIN, so a single sale
 * row can't span multiple vehicles. Down payment/tax are split proportionally
 * by each vehicle's share of the total price so every sale row's own numbers
 * stay reconcilable rather than double-counting the deal-level totals.
 */
export async function completeSalesForLineItems(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    quoteId: Id<"quotes">;
    applicationId?: Id<"financeApplications">;
    vehicleItems: Array<{ vehicleId: Id<"vehicles">; unitPrice: number }>;
    customerId: Id<"customers">;
    salespersonId: Id<"users">;
    saleDate: number;
    downPayment?: number;
    taxRate?: number;
    financingType?: FinancingType;
    idempotencyKey?: string;
    actorId: Id<"users">;
  }
): Promise<Id<"sales">[]> {
  if (args.vehicleItems.length === 0) {
    throw new ConvexError("Cannot complete a sale without at least one vehicle line item.");
  }
  if (args.vehicleItems.some((item) => item.unitPrice <= 0)) {
    throw new ConvexError("Vehicle line item prices must be greater than zero.");
  }

  const total = args.vehicleItems.reduce((sum, item) => sum + item.unitPrice, 0);
  const saleIds: Id<"sales">[] = [];

  for (const item of args.vehicleItems) {
    const share = total > 0 ? item.unitPrice / total : 1 / args.vehicleItems.length;
    const saleId = await completeSale(ctx, {
      orgId: args.orgId,
      vehicleId: item.vehicleId,
      customerId: args.customerId,
      salespersonId: args.salespersonId,
      salePrice: item.unitPrice,
      saleDate: args.saleDate,
      status: "COMPLETED",
      quoteId: args.quoteId,
      applicationId: args.applicationId,
      downPayment: args.downPayment !== undefined ? args.downPayment * share : undefined,
      taxRate: args.taxRate,
      taxAmount: args.taxRate !== undefined ? item.unitPrice * (args.taxRate / 100) : undefined,
      financingType: args.financingType,
      idempotencyKey: args.idempotencyKey ? `${args.idempotencyKey}:${item.vehicleId}` : undefined,
      actorId: args.actorId,
    });
    saleIds.push(saleId);
  }

  return saleIds;
}

export async function completeExistingSale(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    saleId: Id<"sales">;
    actorId: Id<"users">;
    idempotencyKey?: string;
  }
): Promise<Id<"sales">> {
  const sale = await ctx.db.get(args.saleId);
  if (!sale || sale.isDeleted || sale.orgId !== args.orgId) {
    throwAppError(AppErrorCode.SALE_NOT_FOUND, "Sale not found in this organization.");
  }
  if (sale.status === "COMPLETED") {
    throwAppError(AppErrorCode.SALE_ALREADY_COMPLETED, "Sale has already been completed.");
  }
  if (sale.status === "CANCELLED") {
    throwAppError(AppErrorCode.VALIDATION_FAILED, "Cancelled sales cannot be completed.");
  }

  const completionArgs: SaleCompletionArgs = {
    orgId: sale.orgId,
    vehicleId: sale.vehicleId,
    customerId: sale.customerId,
    salespersonId: sale.salespersonId,
    salePrice: sale.salePrice,
    saleDate: sale.saleDate,
    status: "COMPLETED",
    quoteId: sale.quoteId,
    applicationId: sale.applicationId,
    taxRate: sale.taxRate,
    taxAmount: sale.taxAmount,
    dealerFees: sale.dealerFees,
    downPayment: sale.downPayment,
    tradeInVehicleId: sale.tradeInVehicleId,
    tradeInValue: sale.tradeInValue,
    financingType: sale.financingType,
    loanAmount: sale.loanAmount,
    apr: sale.apr,
    termMonths: sale.termMonths,
    warrantySold: sale.warrantySold,
    gapSold: sale.gapSold,
    idempotencyKey: args.idempotencyKey ?? sale.idempotencyKey,
    actorId: args.actorId,
  };

  const prepared = await prepareSaleCompletion(ctx, completionArgs);
  await ctx.db.patch(args.saleId, {
    status: "COMPLETED",
    commissionAmount: prepared.commissionAmount,
    leadId: prepared.leadId,
    idempotencyKey: completionArgs.idempotencyKey,
  });
  await applySaleCompletionSideEffects(ctx, completionArgs, prepared, args.saleId);

  return args.saleId;
}
