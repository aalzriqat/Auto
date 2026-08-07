import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx } from "../_generated/server";
import { notifyManagers, getActorName } from "./notifications";
import { calculateCommissionFromTiers, CommissionTier } from "./commission";
import {
  markVehicleAsSold,
  createSaleTransaction,
  closeLeadsAsWon,
} from "./saleHelpers";
import {
  resolveDepositsForQuote,
  recordUnpostedDepositTreatment,
  depositStatusForTreatment,
  type DepositTreatment,
} from "./depositHelpers";
import { throwAppError, AppErrorCode } from "./errors";
import { requireOrgMember } from "./tenancy";
import {
  hookSaleCompleted,
  hookCommissionAccrued,
  hookDepositApplied,
  hookDepositAppliedToSettlement,
  hookDepositRefunded,
  hookDepositForfeited,
  hookTradeInAccepted,
  getOrgCurrency,
  commissionAccountingDate,
} from "../accounting/workflowHooks";
import { computeResoldProductMargin } from "../accounting/postingRules";
import { toMinorUnits } from "./money";
import { computeVehicleCapitalizedCost, vehicleHasCostBasis } from "./vehicleCost";
import {
  consignedSettlementRoute,
  dealershipCollectsGross,
  type ConsignedSettlementRoute,
} from "./vehicleOwnership";
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
  warrantyCost?: number;
  warrantyTermMonths?: number;
  gapSold?: number;
  gapCost?: number;
  gapTermMonths?: number;
  idempotencyKey?: string;
  actorId: Id<"users">;
  // Where the buyer's money went, on a consigned (SOURCED) sale only. Omitted
  // means THROUGH_DEALERSHIP — see consignedSettlementRoute(). Ignored for
  // dealer-owned stock, which has no supplier to settle with.
  supplierSettlementRoute?: ConsignedSettlementRoute;
  // What happens to the customer's reservation deposit. Required on a consigned
  // sale that has one — see resolveReservationDeposits.
  depositResolution?: { treatment: DepositTreatment; reason?: string };
  // MANUAL commission mode carries the manager-entered amount through
  // completion untouched. Populated from the existing sale when completing a
  // draft; undefined for freshly-created sales.
  existingCommissionAmount?: number;
};

type PreparedSaleCompletion = {
  vehicle: Doc<"vehicles">;
  customer: Doc<"customers">;
  leadId?: Id<"leads">;
  commissionAmount?: number;
  currency: string;
  // True when the commission amount is already known at completion, in EITHER
  // mode. MANUAL used to defer accrual to payment time so the amount stayed
  // editable; it no longer does — recognition follows measurability, and a
  // wrong amount is corrected by a signed adjusting entry rather than by being
  // left unposted. Both branches below now set this from `commissionAmount`
  // alone, so the mode no longer decides it.
  accrueAtCompletion: boolean;
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

  const membership = await requireOrgMember(ctx, args.orgId, args.salespersonId);

  const orgSettings = await ctx.db
    .query("orgSettings")
    .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
    .unique();

  const commissionMode = orgSettings?.commissionMode ?? "AUTO_MEMBER";

  let commissionAmount: number | undefined;
  // Commission expense is recognized once the obligation is both probable (the
  // sale completed) and measurable (an amount exists) — dated to the sale, so it
  // lands in the same period as the revenue it was earned against.
  //
  // AUTO modes derive the amount here, so they are measurable at completion.
  // MANUAL is measurable at completion only when a manager already entered an
  // amount on the draft; otherwise nothing accrues until one is set, and
  // sales.setCommissionAmount accrues it then. Deferring MANUAL accrual to
  // PAYMENT (the previous behavior) recognized the expense on a cash basis
  // inside an accrual ledger: a car sold in July with its commission paid in
  // August showed full margin in July and a naked expense in August.
  let accrueAtCompletion = false;
  if (commissionMode === "MANUAL") {
    commissionAmount = args.existingCommissionAmount;
    accrueAtCompletion = commissionAmount != null;
  } else {
    commissionAmount = await computeAutoCommissionAmount(ctx, {
      salePrice: args.salePrice,
      vehicle,
      commissionMode,
      memberCommissionRate: membership.commissionRate,
      commissionTiers: orgSettings?.commissionTiers ?? [],
    });
    accrueAtCompletion = commissionAmount != null;
  }

  const currency = await getOrgCurrency(ctx, args.orgId);

  return { vehicle, customer, leadId, commissionAmount, currency, accrueAtCompletion };
}

/**
 * The single source of the automatic-commission calculation, shared by sale
 * completion and by sales.recalculateCommission (the manager's fix-up after a
 * missing vehicle cost is corrected).
 *
 * Returns `undefined` when the vehicle has no trustworthy cost basis (C3: the
 * capitalized cost would be ~zero, so commissioning would pay on ~the full
 * sale price — instead the sale is flagged for a manager). When a cost basis
 * IS present it always returns a number, including an explicit 0, so that a
 * stored `commissionAmount == null` on a completed AUTO sale unambiguously
 * means "never computed" rather than "computed as zero".
 */
export async function computeAutoCommissionAmount(
  ctx: MutationCtx,
  args: {
    salePrice: number;
    vehicle: Doc<"vehicles">;
    commissionMode: string;
    memberCommissionRate: number | undefined;
    commissionTiers: CommissionTier[];
  }
): Promise<number | undefined> {
  if (!vehicleHasCostBasis(args.vehicle)) return undefined;
  // Same cost basis the GL uses for COGS (purchase + landed costs + capitalized
  // reconditioning expenses) so commission, the GL, and the operational reports
  // all show the same margin for a sale.
  const vehicleCost = await computeVehicleCapitalizedCost(ctx, args.vehicle);
  const grossProfit = Math.max(0, args.salePrice - vehicleCost);
  if (args.commissionMode === "AUTO_TIERS") {
    return calculateCommissionFromTiers(grossProfit, args.commissionTiers);
  }
  const rate = args.memberCommissionRate ?? 0;
  return rate > 0 ? grossProfit * (rate / 100) : 0;
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
    warrantyCost: args.warrantyCost,
    warrantyTermMonths: args.warrantyTermMonths,
    gapSold: args.gapSold,
    gapCost: args.gapCost,
    gapTermMonths: args.gapTermMonths,
    commissionAmount,
    quoteId: args.quoteId,
    applicationId: args.applicationId,
    leadId: prepared.leadId,
    idempotencyKey: args.idempotencyKey,
    // Only meaningful for a consigned sale. Writing it on dealer-owned stock
    // would claim a supplier settlement arrangement that does not exist.
    supplierSettlementRoute:
      prepared.vehicle.sourceType === "SOURCED" ? args.supplierSettlementRoute : undefined,
  });
}

type ResolvedReservationDeposits = {
  /**
   * Applied against what the CUSTOMER owes the dealership. Only this reduces
   * the sale's outstanding balance; a deposit that went to the supplier
   * settlement, was refunded, or awaits a manual journal did not.
   */
  previouslyCollected: number;
  appliedDeposits: Array<{ depositId: Id<"deposits">; customerId: Id<"customers">; amount: number }>;
};

/**
 * Decides what happens to the reservation deposit (عربون) when a sale
 * completes.
 *
 * The reservation deposit is money paid to the DEALERSHIP against its own
 * receipt voucher. It is not the financing down payment, which the customer
 * pays to the finance company; nothing here may move one into the other.
 *
 * On a dealer-owned sale the answer has never been ambiguous — the customer
 * owes the dealership the whole price, so the deposit comes off that — and it
 * stays implicit. A consigned sale settled THROUGH_DEALERSHIP is the same
 * situation for the same reason: the dealership collected the gross and holds
 * the customer's receivable for it, so "applied" can only mean one thing there
 * too, and it stays implicit as well.
 *
 * Demanding a stated treatment on that route was a regression, not a
 * safeguard. No client passes one — `applications.finalizeDeal` has no such
 * argument at all — so a financed consigned deal with a عربون on it simply
 * could not be closed. It also had no upside: those deals already posted the
 * deposit against AR, and that was already right.
 *
 * What genuinely needs stating is DIRECT_TO_SUPPLIER, where the customer may
 * owe the dealership nothing at all and the deposit therefore has nowhere
 * obvious to go.
 *
 * REFUND_TO_CUSTOMER and FORFEITED are deliberately NOT actionable here. Both
 * already have a path — `deposits.release` — which requires APPROVE_REQUESTS
 * rather than CREATE_SALES, refuses a refund by the person who took the
 * deposit, rejects an "OTHER" payment method it cannot route, and writes the
 * canonical payment and cashflow rows beside the journal. Doing either from
 * sale completion would move the customer's money with none of that, letting
 * one salesperson take a deposit and forfeit it to income alone.
 */
async function resolveReservationDeposits(
  ctx: MutationCtx,
  opts: {
    args: SaleCompletionArgs;
    prepared: PreparedSaleCompletion;
    saleId: Id<"sales">;
    isSourced: boolean;
    settlementRoute: ConsignedSettlementRoute;
    customerBillableMinor: number;
    /** The dealership's spread, or null when no supplier cost is recorded. */
    marginMinor: number | null;
  }
): Promise<ResolvedReservationDeposits> {
  const { args, prepared, saleId, isSourced, settlementRoute, customerBillableMinor } = opts;
  const empty: ResolvedReservationDeposits = { previouslyCollected: 0, appliedDeposits: [] };
  if (!args.quoteId) return empty;

  const heldTotal = await heldDepositTotalForQuote(ctx, args.quoteId);
  if (heldTotal === 0) return empty;

  const currency = prepared.currency;
  const heldTotalMinor = toMinorUnits(heldTotal, currency);

  const stated = args.depositResolution?.treatment;

  if (stated === "REFUND_TO_CUSTOMER" || stated === "FORFEITED") {
    // Both move real money and both already have a controlled path. See the
    // note on this function: reproducing them here would strip the approval
    // permission, the segregation-of-duties check and the subledger rows.
    throw new ConvexError(
      "Refunding or forfeiting a reservation deposit is a separate approval, not part of completing the sale. Complete the sale, then release the deposit from the deposits screen."
    );
  }

  // Implicit wherever "applied" can only mean one thing: dealer-owned stock,
  // and a consigned sale whose gross the dealership itself collected.
  const mustState = isSourced && !dealershipCollectsGross(settlementRoute);
  if (!mustState) {
    if (stated === "APPLY_TO_TRANSACTION_SETTLEMENT") {
      // The supplier's entitlement is already credited to AP-Suppliers in full
      // at sale, so a second credit would inflate the debt and never clear.
      throw new ConvexError(
        "The dealership collected the gross proceeds on this sale, so the supplier settlement is already recorded in full and a deposit cannot be applied to it again. Apply the deposit to what the customer owes the dealership instead."
      );
    }
    if (stated === "OTHER") return await recordOtherTreatment(ctx, opts);
    return await applyDepositsToCustomerAr(
      ctx,
      opts,
      isSourced ? "APPLY_TO_DEALER_AMOUNT" : undefined
    );
  }

  const treatment = stated;
  if (!treatment) {
    throw new ConvexError(
      "The buyer paid the supplier directly on this consigned sale, so the dealership may hold no receivable from the customer for the vehicle at all — what the reservation deposit is applied to is not implied by the sale. Record the deposit's treatment before completing."
    );
  }

  switch (treatment) {
    case "APPLY_TO_DEALER_AMOUNT": {
      // Capped at what the dealership actually billed. On DIRECT_TO_SUPPLIER
      // that is only its own fees and F&I products; applying more would credit
      // a receivable past zero and show the customer in credit for money the
      // supplier was paid.
      if (heldTotalMinor > customerBillableMinor) {
        throw new ConvexError(
          `The reservation deposit exceeds what the dealership billed this customer on this sale, so it cannot all be applied against it. Refund, forfeit, or apply the excess to the supplier settlement instead.`
        );
      }
      return await applyDepositsToCustomerAr(ctx, opts, treatment);
    }

    case "APPLY_TO_TRANSACTION_SETTLEMENT": {
      // Capped at the margin the supplier actually owes back. Deposits run
      // 5-10% of the price and consignment margins are often smaller, so a
      // deposit exceeding the margin is ordinary rather than exotic — and
      // applying it whole would drive Receivable from Suppliers to a credit
      // balance: an asset account holding what is really the supplier's money,
      // which nothing in the system can discharge.
      if (opts.marginMinor === null) {
        throw new ConvexError(
          "This vehicle has no recorded supplier cost, so the dealership's margin cannot be determined and a deposit cannot be applied against it."
        );
      }
      if (heldTotalMinor > opts.marginMinor) {
        throw new ConvexError(
          "The reservation deposit exceeds the dealership's margin on this consigned sale, so it cannot all be applied to the supplier settlement — the excess is the supplier's money, not the dealership's. Refund the excess to the customer before completing."
        );
      }
      const resolved = await resolveDepositsForQuote(ctx, {
        quoteId: args.quoteId,
        resolution: "APPLIED",
        actorId: args.actorId,
        treatment,
        saleId,
      });
      void resolved;
      for (const { depositId, customerId, amount } of await settlementResolvedDepositRows(ctx, args.quoteId)) {
        await hookDepositAppliedToSettlement(ctx, {
          orgId: args.orgId,
          depositId,
          customerId,
          amountMinor: toMinorUnits(amount, currency),
          currency,
          supplierName: prepared.vehicle.sourcedFromName,
          actorId: args.actorId,
          occurredAt: args.saleDate,
          saleId,
        });
      }
      // Not collected against the customer's balance — it settled the
      // supplier's claim instead.
      return empty;
    }

    case "OTHER":
      return await recordOtherTreatment(ctx, opts);
  }
}

/**
 * The OTHER treatment: a human approved something the system has no rule for.
 * Nothing is posted, because there is no account to credit — the liability
 * stays on the books for a manual journal and only the vehicle hold is
 * released.
 */
async function recordOtherTreatment(
  ctx: MutationCtx,
  opts: { args: SaleCompletionArgs; saleId: Id<"sales"> }
): Promise<ResolvedReservationDeposits> {
  const reason = opts.args.depositResolution?.reason?.trim();
  if (!reason) {
    throw new ConvexError(
      "An 'other' deposit treatment has to say what it is. Record the approved treatment and the reason for it."
    );
  }
  await recordUnpostedDepositTreatment(ctx, {
    quoteId: opts.args.quoteId!,
    actorId: opts.args.actorId,
    reason,
    saleId: opts.saleId,
  });
  return { previouslyCollected: 0, appliedDeposits: [] };
}

/** The reservation deposits still holding a vehicle for this quote. */
async function heldDepositRowsForQuote(
  ctx: MutationCtx,
  quoteId: Id<"quotes">
): Promise<Array<{ depositId: Id<"deposits">; customerId: Id<"customers">; amount: number; method?: string }>> {
  const deposits = await ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", quoteId))
    .collect();
  return deposits
    .filter((d) => d.holdActive && d.isDeleted !== true)
    .map((d) => ({ depositId: d._id, customerId: d.customerId, amount: d.amount, method: d.method }));
}

async function heldDepositTotalForQuote(ctx: MutationCtx, quoteId: Id<"quotes">): Promise<number> {
  const rows = await heldDepositRowsForQuote(ctx, quoteId);
  return rows.reduce((sum, r) => sum + r.amount, 0);
}

/**
 * The rows a settlement-treatment resolution just closed. `resolveDepositsForQuote`
 * returns `appliedDeposits` only for customer-AR applications, so the settlement
 * path reads back the rows it stamped with this sale instead.
 */
async function settlementResolvedDepositRows(
  ctx: MutationCtx,
  quoteId: Id<"quotes">
): Promise<Array<{ depositId: Id<"deposits">; customerId: Id<"customers">; amount: number }>> {
  const deposits = await ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", quoteId))
    .collect();
  return deposits
    .filter((d) => d.resolutionTreatment === "APPLY_TO_TRANSACTION_SETTLEMENT" && d.isDeleted !== true)
    .map((d) => ({ depositId: d._id, customerId: d.customerId, amount: d.amount }));
}

/** The long-standing behaviour: the deposit comes off what the customer owes. */
async function applyDepositsToCustomerAr(
  ctx: MutationCtx,
  opts: {
    args: SaleCompletionArgs;
    prepared: PreparedSaleCompletion;
    saleId: Id<"sales">;
  },
  treatment: "APPLY_TO_DEALER_AMOUNT" | undefined
): Promise<ResolvedReservationDeposits> {
  const { args, prepared, saleId } = opts;
  const resolved = await resolveDepositsForQuote(ctx, {
    quoteId: args.quoteId!,
    resolution: "APPLIED",
    actorId: args.actorId,
    treatment,
    saleId,
  });
  for (const { depositId, customerId, amount } of resolved.appliedDeposits) {
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
  return { previouslyCollected: resolved.total, appliedDeposits: resolved.appliedDeposits };
}

async function applySaleCompletionSideEffects(
  ctx: MutationCtx,
  args: SaleCompletionArgs,
  prepared: PreparedSaleCompletion,
  saleId: Id<"sales">
) {
  await markVehicleAsSold(ctx, args.vehicleId);

  const isSourced = prepared.vehicle.sourceType === "SOURCED";
  const settlementRoute = consignedSettlementRoute(args);

  // Amounts the customer is actually billed by the DEALERSHIP. Computed before
  // deposits are resolved because a reservation deposit may only be applied
  // against something the customer genuinely owes it, and that cap has to be
  // known first.
  //
  // Warranty/GAP: the dealer resells these (collects the full premium, owes
  // most of it to the underwriter, keeps a margin) — a term is required
  // whenever there's a premium to defer, since it drives the recognition
  // schedule (see dealerProductDeferrals / recognizeDeferredCommissionForMonth).
  const dealerFeesMinor = args.dealerFees && args.dealerFees > 0 ? toMinorUnits(args.dealerFees, prepared.currency) : undefined;
  const warrantySoldMinor = args.warrantySold && args.warrantySold > 0 ? toMinorUnits(args.warrantySold, prepared.currency) : undefined;
  if (warrantySoldMinor && (!args.warrantyTermMonths || args.warrantyTermMonths <= 0)) {
    throw new ConvexError("A warranty term (in months) is required when a warranty premium is charged.");
  }
  const warrantyCostMinor = args.warrantyCost && args.warrantyCost > 0 ? toMinorUnits(args.warrantyCost, prepared.currency) : undefined;
  const gapSoldMinor = args.gapSold && args.gapSold > 0 ? toMinorUnits(args.gapSold, prepared.currency) : undefined;
  if (gapSoldMinor && (!args.gapTermMonths || args.gapTermMonths <= 0)) {
    throw new ConvexError("A GAP term (in months) is required when a GAP premium is charged.");
  }
  const gapCostMinor = args.gapCost && args.gapCost > 0 ? toMinorUnits(args.gapCost, prepared.currency) : undefined;

  // On a consigned sale settled DIRECT_TO_SUPPLIER the vehicle itself is NOT
  // billed by the dealership: the buyer paid the supplier, the dealership
  // issued no invoice for the car, and the customer owes it nothing for it.
  const vehicleReceivableMinor =
    isSourced && !dealershipCollectsGross(settlementRoute)
      ? 0
      : toMinorUnits(args.salePrice, prepared.currency);
  const customerBillableMinor =
    vehicleReceivableMinor + (dealerFeesMinor ?? 0) + (warrantySoldMinor ?? 0) + (gapSoldMinor ?? 0);

  // Hoisted above the deposit resolution because the settlement treatment is
  // capped at the margin, and the margin cannot be known without the cost.
  const costAmount = await computeVehicleCapitalizedCost(ctx, prepared.vehicle);
  const costMinor = costAmount > 0 ? toMinorUnits(costAmount, prepared.currency) : undefined;
  const marginMinor =
    isSourced && costMinor !== undefined
      ? toMinorUnits(args.salePrice, prepared.currency) - costMinor
      : null;

  const { previouslyCollected, appliedDeposits } = await resolveReservationDeposits(ctx, {
    args,
    prepared,
    saleId,
    isSourced,
    settlementRoute,
    customerBillableMinor,
    marginMinor,
  });

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

  // A sourced vehicle is legally the supplier's, so this sale is an agency
  // sale: the dealership may recognize the spread over his entitlement and
  // nothing more. `sourceCost` IS that entitlement — it is the figure the
  // dealership agreed he gets, and the same figure the old principal posting
  // was already crediting to AP-Suppliers.
  //
  // Absent, there is no entitlement to net against and therefore no margin.
  // Posting anyway would either claim the whole transaction as the
  // dealership's or invent a cost; both misstate revenue on a car it never
  // owned, so the sale stops here rather than guessing.
  const consignment = isSourced
    ? (() => {
        if (costMinor === undefined || costMinor <= 0) {
          throw new ConvexError(
            "This vehicle is sourced, so it belongs to the supplier and the sale is an agency sale — but no supplier cost is recorded, so the dealership's margin cannot be determined. Record the agreed supplier amount, or convert the vehicle to dealer-owned stock first."
          );
        }
        return {
          supplierEntitlementMinor: costMinor,
          supplierName: prepared.vehicle.sourcedFromName,
          settlementRoute,
        };
      })()
    : undefined;

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
    consignment,
    // Agent basis relieves no inventory and books no COGS — the dealership
    // never held this car. Passing the cost through would post both.
    ...(consignment ? { costMinor: undefined } : {}),
    dealerFeesMinor,
    warrantySoldMinor,
    warrantyCostMinor,
    gapSoldMinor,
    gapCostMinor,
  });

  for (const deferral of [
    { productType: "WARRANTY" as const, soldMinor: warrantySoldMinor, costMinor: warrantyCostMinor, termMonths: args.warrantyTermMonths },
    { productType: "GAP" as const, soldMinor: gapSoldMinor, costMinor: gapCostMinor, termMonths: args.gapTermMonths },
  ]) {
    if (!deferral.soldMinor) continue;
    const { marginMinor } = computeResoldProductMargin(deferral.soldMinor, deferral.costMinor ?? 0);
    if (marginMinor <= 0) continue;
    await ctx.db.insert("dealerProductDeferrals", {
      orgId: args.orgId,
      saleId,
      productType: deferral.productType,
      totalMarginMinor: marginMinor,
      currency: prepared.currency,
      termMonths: deferral.termMonths!,
      recognizedMinor: 0,
      monthsRecognized: 0,
      status: "ACTIVE",
      createdAt: Date.now(),
    });
  }

  // The receivable's total must match what the AR debit in hookSaleCompleted
  // actually posted (salePrice + dealerFees + warranty/GAP premiums) — not
  // just salePrice — or the subledger and GL diverge by that amount. That is
  // exactly `customerBillableMinor`, computed above so the deposit cap and this
  // document cannot disagree about what the customer was billed.
  const saleReceivableId = await ensureReceivableDocument(ctx, {
    orgId: args.orgId,
    branchId: prepared.vehicle.branchId,
    documentType: "INVOICE",
    payerType: "CUSTOMER",
    customerId: args.customerId,
    sourceType: "sales",
    sourceId: saleId,
    originalAmountMinor: customerBillableMinor,
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

  if (args.tradeInVehicleId && args.tradeInValue && args.tradeInValue > 0) {
    if (args.tradeInVehicleId === args.vehicleId) {
      throw new ConvexError("A vehicle cannot be traded in against its own sale.");
    }
    const tradeInVehicle = await ctx.db.get(args.tradeInVehicleId);
    if (!tradeInVehicle || tradeInVehicle.orgId !== args.orgId || tradeInVehicle.isDeleted) {
      throw new ConvexError("Trade-in vehicle not found in this organization.");
    }
    if (tradeInVehicle.status === "SOLD" || tradeInVehicle.status === "ARCHIVED") {
      throw new ConvexError(`This trade-in vehicle is ${tradeInVehicle.status.toLowerCase()} and cannot be accepted as a trade-in.`);
    }
    // Sourced/drop-ship vehicles cost-basis from sourceCost, not purchasePrice
    // (see computeVehicleCapitalizedCost) — patching purchasePrice below would
    // silently never establish a cost basis for this vehicle if it's later resold.
    if (tradeInVehicle.sourceType === "SOURCED") {
      throw new ConvexError("A sourced/drop-ship vehicle record cannot be used as a trade-in.");
    }
    // A trade-in vehicle must be brand new to inventory — if it already has a
    // purchase price, it was already capitalized via the normal acquisition
    // flow (postVehicleAcquisitionIfOwned), and capitalizing it again here
    // would double-count Vehicle Inventory.
    if (tradeInVehicle.purchasePrice && tradeInVehicle.purchasePrice > 0) {
      throw new ConvexError(
        "This trade-in vehicle already has a purchase price recorded. Clear it before completing this sale, or the trade-in value won't be capitalized correctly."
      );
    }

    const tradeInValueMinor = toMinorUnits(args.tradeInValue, prepared.currency);
    const tradeInPaymentId = await createCanonicalPayment(ctx, {
      orgId: args.orgId,
      branchId: prepared.vehicle.branchId,
      direction: "IN",
      payerType: "CUSTOMER",
      customerId: args.customerId,
      method: "TRADE_IN",
      amountMinor: tradeInValueMinor,
      currency: prepared.currency,
      idempotencyKey: `trade_in_payment_${saleId}`,
      actorId: args.actorId,
      status: "SETTLED",
      externalReference: `Trade-in vehicle ${args.tradeInVehicleId}`,
      receivedAt: args.saleDate,
    });
    await allocatePaymentToReceivable(ctx, {
      orgId: args.orgId,
      paymentId: tradeInPaymentId,
      receivableDocumentId: saleReceivableId,
      amountMinor: tradeInValueMinor,
      actorId: args.actorId,
    });

    await hookTradeInAccepted(ctx, {
      orgId: args.orgId,
      vehicleId: args.tradeInVehicleId,
      saleId,
      customerId: args.customerId,
      tradeInValueMinor,
      currency: prepared.currency,
      actorId: args.actorId,
      occurredAt: args.saleDate,
    });

    // Sets the trade-in vehicle's cost basis to the trade-in value, so
    // computeVehicleCapitalizedCost picks it up correctly if/when it's later resold.
    await ctx.db.patch(args.tradeInVehicleId, { purchasePrice: args.tradeInValue });
  }

  // For sourced vehicles the dealership owes the supplier his entitlement out
  // of the gross it collected — but only on the route where it actually
  // collected the gross. On DIRECT_TO_SUPPLIER the buyer paid him, so nothing
  // is owed to him at all; the claim runs the other way and lives in
  // Receivable from Suppliers (see consignedAgentSaleLines). Creating a payable
  // there would invent a debt and leave it permanently unsettleable, because no
  // payment will ever be made against it.
  if (isSourced && costAmount > 0 && dealershipCollectsGross(settlementRoute)) {
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

  if (prepared.accrueAtCompletion && prepared.commissionAmount != null && prepared.commissionAmount > 0) {
    await hookCommissionAccrued(ctx, {
      orgId: args.orgId,
      saleId,
      salespersonId: args.salespersonId,
      amountMinor: toMinorUnits(prepared.commissionAmount, prepared.currency),
      currency: prepared.currency,
      actorId: args.actorId,
      // The same rule every other commission entry uses. Dating this one at the
      // raw saleDate let a backdated completion queue its accrual behind a
      // closed period while a later correction or payment — which DO use the
      // rule — posted into an open one, leaving Commission Payable negative.
      occurredAt: await commissionAccountingDate(ctx, args.orgId, saleId, args.saleDate),
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
    supplierSettlementRoute?: ConsignedSettlementRoute;
    depositResolution?: { treatment: DepositTreatment; reason?: string };
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
      supplierSettlementRoute: args.supplierSettlementRoute,
      depositResolution: args.depositResolution,
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
    depositResolution?: { treatment: DepositTreatment; reason?: string };
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
    warrantyCost: sale.warrantyCost,
    warrantyTermMonths: sale.warrantyTermMonths,
    gapSold: sale.gapSold,
    gapCost: sale.gapCost,
    gapTermMonths: sale.gapTermMonths,
    idempotencyKey: args.idempotencyKey ?? sale.idempotencyKey,
    actorId: args.actorId,
    // Carried from the draft, so completing it posts the route the deal was
    // actually structured under rather than silently reverting to the default.
    supplierSettlementRoute: sale.supplierSettlementRoute,
    // Stated at completion, not on the draft: it is a decision about money that
    // is only made when the deal actually closes.
    depositResolution: args.depositResolution,
    // Preserve a manager-entered MANUAL commission across completion.
    existingCommissionAmount: sale.commissionAmount,
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
