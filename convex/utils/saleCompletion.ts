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
  releaseHeldDeposit,
  type DepositTreatment,
} from "./depositHelpers";
import type { DepositMethod } from "./depositRecording";
import { throwAppError, AppErrorCode } from "./errors";
import { requireOrgMember } from "./tenancy";
import {
  hookSaleCompleted,
  hookCommissionAccrued,
  hookTradeInAccepted,
  getOrgCurrency,
  commissionAccountingDate,
} from "../accounting/workflowHooks";
import { computeResoldProductMargin } from "../accounting/postingRules";
import { toMinorUnits, fromMinorUnits } from "./money";
import { computeVehicleCapitalizedCost, vehicleHasCostBasis } from "./vehicleCost";
import { openSupplierReceivable } from "../supplierReceivables";
import {
  allocatedDepositForVehicle,
  throwAllocationRequired,
  assertQuoteDepositConservation,
} from "./depositAllocation";
import { recordDepositApplication } from "./depositApplications";
import { planDepositSettlementApplication } from "./depositSettlementPlan";
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
  depositResolution?: {
    treatment: DepositTreatment;
    reason?: string;
    /** Required for REFUND_TO_CUSTOMER — the deposit's own method may be OTHER, which cannot be paid out. */
    refundMethod?: DepositMethod;
  };
  // MANUAL commission mode carries the manager-entered amount through
  // completion untouched. Populated from the existing sale when completing a
  // draft; undefined for freshly-created sales.
  existingCommissionAmount?: number;
};

/**
 * Which line of the quote this car is — part of the identity of an application,
 * so an auditor can tie a slice of the deposit back to the line the customer
 * signed for rather than to a bare vehicle id.
 */
async function quoteLineIndexFor(
  ctx: MutationCtx,
  quoteId: Id<"quotes"> | undefined,
  vehicleId: Id<"vehicles">
): Promise<number | undefined> {
  if (!quoteId) return undefined;
  const quote = await ctx.db.get(quoteId);
  if (!quote) return undefined;
  const items = quote.vehicleItems ?? [{ vehicleId: quote.vehicleId }];
  const index = items.findIndex((item) => item.vehicleId === vehicleId);
  return index >= 0 ? index : undefined;
}

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
  /**
   * Applied against the supplier's settlement instead. The GL credit for this
   * already reduced Receivable from Suppliers, so the claim opened below has to
   * open net of it or the subledger and the ledger disagree from the outset.
   */
  appliedToSupplierSettlement: number;
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
 * The trigger is the DEPOSIT BALANCE, not the settlement route. A reservation
 * deposit is the dealership's own arrangement with its customer and has nothing
 * to do with whether the supplier was settled through the dealership or paid
 * directly — tying the two together made an unrelated field decide whether a
 * customer's money needed a decision.
 *
 * What actually decides it is whether the deposit's disposition follows from
 * the settlement. It does exactly when the dealership billed the customer at
 * least as much as it is holding: the deposit comes off that bill, there is
 * nowhere else for it to go, and no human needs to be asked. Whenever a balance
 * would be left over — the whole deposit on a direct-settled consigned sale
 * that carried no dealer fees, or simply a deposit larger than the invoice on
 * any sale — the remainder is undetermined and has to be stated.
 *
 * REFUND_TO_CUSTOMER and FORFEITED are available here, but they run through
 * `releaseHeldDeposit`, the same path the deposits screen uses. That keeps the
 * approval permission, the refusal to let the person who took a deposit be the
 * one who keeps it, the refund-method check, and the cashflow and payment-
 * subledger rows attached to the decision rather than to the screen it is made
 * on.
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
  const empty: ResolvedReservationDeposits = {
    previouslyCollected: 0,
    appliedDeposits: [],
    appliedToSupplierSettlement: 0,
  };
  if (!args.quoteId) return empty;

  const currency = prepared.currency;

  // THIS car's share of the quote's deposit, and nothing else.
  //
  // A quote can carry several cars against one عربون paid on one receipt
  // voucher, so the deposit row is quote-scoped by design. How much of it
  // belongs to each car is a decision somebody made and stored — see
  // convex/utils/depositAllocation.ts. Comparing the whole quote's deposit
  // against one line item's bill made a two-car quote demand a treatment on
  // the first completion and then refuse every treatment offered.
  const allocation = await allocatedDepositForVehicle(ctx, {
    quoteId: args.quoteId,
    vehicleId: args.vehicleId,
    currency,
  });
  if (allocation.kind === "NO_DEPOSIT") return empty;
  if (allocation.kind === "NOT_ALLOCATED") throwAllocationRequired();

  const heldTotalMinor = allocation.allocatedMinor;
  if (heldTotalMinor === 0) {
    // Zero is a decision — this car carries none of the deposit — and its hold
    // still has to be consumed by its sale. Returning early left the hold
    // ALLOCATED and active on a car that was now SOLD, and everything
    // downstream reads an active hold as money that can still be moved: a
    // further 3,000 could be allocated to that completed sale, or another car's
    // released share re-allocated onto it, both accepted by the server and both
    // offered on screen. It also kept the row's face value counted as an
    // outstanding deposit liability for good.
    await resolveDepositsForQuote(ctx, {
      quoteId: args.quoteId!,
      vehicleId: args.vehicleId,
      currency,
      resolution: "APPLIED",
      actorId: args.actorId,
      saleId,
    });
    return empty;
  }
  const allocationHoldId = allocation.kind === "ALLOCATED" ? allocation.holdId : undefined;

  const stated = args.depositResolution?.treatment;

  // Determined exactly when the dealership billed the customer at least what it
  // is holding: the deposit comes off that bill and nothing is left over. Note
  // this is a statement about amounts, not about the settlement route — a
  // direct-settled consigned sale carrying enough dealer fees is just as
  // determined as an ordinary owned sale, and an owned sale whose deposit
  // exceeds its invoice is just as undetermined as a bare consigned one.
  const fullyAbsorbedByCustomerBill = heldTotalMinor <= customerBillableMinor;

  if (!stated) {
    if (fullyAbsorbedByCustomerBill) {
      // Unchanged behaviour, and the overwhelmingly common case. A treatment is
      // recorded on consigned sales so an auditor can see which of several
      // possible dispositions applied; on owned stock APPLIED has only ever
      // meant one thing, so nothing is recorded and old rows stay comparable.
      return await applyDepositsToCustomerAr(
        ctx,
        opts,
        isSourced ? "APPLY_TO_DEALER_AMOUNT" : undefined
      );
    }
    throw new ConvexError(
      "The reservation deposit held on this vehicle is larger than what the dealership billed the customer for it, so part of it would be left unapplied. Record what happens to that money: applied to what they owe the dealership, applied to the supplier settlement, refunded, forfeited, or an approved other treatment with a reason."
    );
  }

  const treatment = stated;

  switch (treatment) {
    case "APPLY_TO_DEALER_AMOUNT": {
      // Capped at what the dealership actually billed. Applying more would
      // credit a receivable past zero and show the customer in credit for money
      // nobody billed them.
      if (!fullyAbsorbedByCustomerBill) {
        throw new ConvexError(
          "The reservation deposit exceeds what the dealership billed this customer on this sale, so it cannot all be applied against it. Refund, forfeit, or apply the excess to the supplier settlement instead."
        );
      }
      return await applyDepositsToCustomerAr(ctx, opts, treatment);
    }

    case "APPLY_TO_TRANSACTION_SETTLEMENT": {
      // The operator states one thing — that this عربون forms part of the final
      // settlement of this deal — and the server derives where that lands. The
      // rule is shared with `sales.consignedSalePreview` so the figure shown
      // before confirming is the figure that posts; see depositSettlementPlan.
      const plan = planDepositSettlementApplication({
        isSourced,
        settlementRoute,
        depositMinor: heldTotalMinor,
        customerBillableMinor,
        marginMinor: opts.marginMinor,
      });
      if (!plan.ok) throw new ConvexError(plan.reason);

      if (plan.destination === "CUSTOMER_RECEIVABLE") {
        // THROUGH_DEALERSHIP: the dealership collected the gross, so the
        // supplier's entitlement is already credited to AP-Suppliers in full
        // and crediting it again would inflate the debt by the deposit. What
        // the customer paid the dealership comes off what the dealership
        // billed them — which is `APPLY_TO_DEALER_AMOUNT`, recorded as such
        // because that is what the money actually did. The application row
        // carries `CUSTOMER_RECEIVABLE`, so a later cancellation reverses the
        // entry that was really posted rather than a settlement entry that
        // never was.
        return await applyDepositsToCustomerAr(ctx, opts, "APPLY_TO_DEALER_AMOUNT");
      }

      const resolved = await resolveDepositsForQuote(ctx, {
        quoteId: args.quoteId,
        vehicleId: args.vehicleId,
        currency,
        resolution: "APPLIED",
        actorId: args.actorId,
        treatment,
        saleId,
      });
      // The slices this call actually consumed. Re-reading the deposits table
      // and filtering on `deposit.vehicleId` reported the quote's FIRST line
      // item, which on a multi-vehicle quote is not the car being sold.
      for (const { depositId, customerId, amount, holdId } of resolved.consumedSlices) {
        await recordDepositApplication(ctx, {
          orgId: args.orgId,
          depositId,
          quoteId: args.quoteId,
          quoteLineIndex: await quoteLineIndexFor(ctx, args.quoteId, args.vehicleId),
          vehicleId: args.vehicleId,
          saleId,
          customerId,
          holdId,
          amountMinor: toMinorUnits(amount, currency),
          currency,
          treatment: "SUPPLIER_SETTLEMENT",
          supplierName: prepared.vehicle.sourcedFromName,
          actorId: args.actorId,
          occurredAt: args.saleDate,
        });
      }
      // Not collected against the customer's balance — it settled the
      // supplier's claim instead, which the claim below must open net of.
      //
      // Summed from the slices actually consumed, NOT from the allocated cap.
      //
      // This is a structural guarantee, not a fix for a reproducible bug, and
      // the distinction is worth stating precisely: the cap `heldTotalMinor`
      // and `consumedSlices` are computed from THE SAME hold rows under THE
      // SAME predicate (this vehicle ∧ active ∧ an allocated amount), so they
      // are EQUAL — not merely ordered. Saying "≤ always", as this comment
      // first did, asserts an ordering the code does not actually guarantee and
      // would quietly stop being true if quotes ever became mutable: a quote
      // carrying both hold-bearing and hold-less deposits would let the
      // resolution consume more than the cap authorised. Quotes are
      // insert-only today, so that shape is not constructible.
      //
      // What it removes is the possibility. The GL debits/credits iterate
      // `consumedSlices` (just above); the claim's `alreadyReceivedAmount` used
      // to take the cap. Since the cap can only ever be the LARGER of the two,
      // a divergence would tell the subledger MORE had been received than the
      // GL credited — the claim would read as more settled than it is and the
      // dealership would stop short of collecting its own margin from the
      // supplier. Both books balance while it happens. Deriving both sides from
      // one array means the question cannot arise.
      const appliedMinor = resolved.consumedSlices.reduce(
        (sum, slice) => sum + toMinorUnits(slice.amount, currency),
        0
      );
      return {
        ...empty,
        appliedToSupplierSettlement: fromMinorUnits(appliedMinor, currency),
      };
    }

    case "REFUND_TO_CUSTOMER":
    case "FORFEITED": {
      // Only where the deposit belongs to this car alone. `releaseHeldDeposit`
      // resolves the WHOLE deposit row — refunds it, posts it, closes it — and
      // on a multi-vehicle quote that row is also holding the other cars'
      // money. Refunding one car's share through it would pay out the rest of
      // the deal by accident.
      //
      // The partial case has its own path: reduce this car's allocation, then
      // resolve the released slice explicitly (deposits.resolveReleasedAllocation).
      if (allocationHoldId !== undefined) {
        throw new ConvexError(
          "This deposit is shared with other vehicles on the same quote, so it cannot be refunded or forfeited from here — doing so would resolve the whole deposit and take the other vehicles' share with it. Re-allocate this vehicle's share to zero first, then decide what happens to the released amount."
        );
      }
      // Routed through the shared release path so the approval permission, the
      // segregation-of-duties refusal and the cashflow/payment-subledger rows
      // travel with the decision. Completing a sale authorizes `create:sales`;
      // keeping or returning a customer's deposit is a different authority.
      for (const row of await heldDepositRowsForVehicle(ctx, args.quoteId, args.vehicleId)) {
        await releaseHeldDeposit(ctx, {
          orgId: args.orgId,
          depositId: row.depositId,
          resolution: treatment === "REFUND_TO_CUSTOMER" ? "REFUNDED" : "FORFEITED",
          actorId: args.actorId,
          refundMethod: args.depositResolution?.refundMethod,
          occurredAt: args.saleDate,
          saleId,
          treatment,
        });
      }
      // Neither reduces what the customer owes on this sale.
      return empty;
    }

    case "OTHER":
      return await recordOtherTreatment(ctx, {
        ...opts,
        isSharedDeposit: allocationHoldId !== undefined,
      });
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
  opts: { args: SaleCompletionArgs; saleId: Id<"sales">; isSharedDeposit: boolean }
): Promise<ResolvedReservationDeposits> {
  if (opts.isSharedDeposit) {
    throw new ConvexError(
      "This deposit is shared with other vehicles on the same quote, so an 'other' treatment cannot be recorded against it from here — it would release the whole deposit. Re-allocate this vehicle's share to zero first, then record the treatment against the released amount."
    );
  }
  const reason = opts.args.depositResolution?.reason?.trim();
  if (!reason) {
    throw new ConvexError(
      "An 'other' deposit treatment has to say what it is. Record the approved treatment and the reason for it."
    );
  }
  await recordUnpostedDepositTreatment(ctx, {
    quoteId: opts.args.quoteId!,
    vehicleId: opts.args.vehicleId,
    actorId: opts.args.actorId,
    reason,
    saleId: opts.saleId,
  });
  return { previouslyCollected: 0, appliedDeposits: [], appliedToSupplierSettlement: 0 };
}

/**
 * The reservation deposits still holding THIS car under this quote.
 *
 * Scoped to the vehicle, not the quote. A quote can cover several cars
 * (`quotes.vehicleItems`), each completed on its own sale, and every deposit
 * row names the car it is holding — so the allocation is recorded per deposit
 * and never has to be apportioned or guessed. Summing the quote instead
 * compared one car's invoice against every car's deposits, which made a
 * two-vehicle quote demand a deposit treatment on the first completion and
 * then refuse every one of them.
 */
async function heldDepositRowsForVehicle(
  ctx: MutationCtx,
  quoteId: Id<"quotes">,
  vehicleId: Id<"vehicles">
): Promise<Array<{ depositId: Id<"deposits">; customerId: Id<"customers">; amount: number; method?: string }>> {
  const deposits = await ctx.db
    .query("deposits")
    .withIndex("by_quote", (q) => q.eq("quoteId", quoteId))
    .collect();
  return deposits
    .filter((d) => d.holdActive && d.isDeleted !== true && d.vehicleId === vehicleId)
    .map((d) => ({ depositId: d._id, customerId: d.customerId, amount: d.amount, method: d.method }));
}

async function heldDepositTotalForVehicle(
  ctx: MutationCtx,
  quoteId: Id<"quotes">,
  vehicleId: Id<"vehicles">
): Promise<number> {
  const rows = await heldDepositRowsForVehicle(ctx, quoteId, vehicleId);
  return rows.reduce((sum, r) => sum + r.amount, 0);
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
    vehicleId: args.vehicleId,
    currency: prepared.currency,
    resolution: "APPLIED",
    actorId: args.actorId,
    treatment,
    saleId,
  });
  // One immutable record per application, carrying the accounting identity it
  // posts under. A cancellation reverses THAT record, so backing out one car
  // can never disturb another car's live credit.
  for (const { depositId, customerId, amount, vehicleId, holdId } of resolved.appliedDeposits) {
    await recordDepositApplication(ctx, {
      orgId: args.orgId,
      depositId,
      quoteId: args.quoteId,
      quoteLineIndex: await quoteLineIndexFor(ctx, args.quoteId, vehicleId),
      vehicleId,
      saleId,
      customerId,
      holdId,
      amountMinor: toMinorUnits(amount, prepared.currency),
      currency: prepared.currency,
      treatment: "CUSTOMER_RECEIVABLE",
      actorId: args.actorId,
      occurredAt: args.saleDate,
    });
  }
  return {
    previouslyCollected: resolved.total,
    appliedDeposits: resolved.appliedDeposits,
    appliedToSupplierSettlement: 0,
  };
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

  const { previouslyCollected, appliedDeposits, appliedToSupplierSettlement } =
    await resolveReservationDeposits(ctx, {
    args,
    prepared,
    saleId,
    isSourced,
    settlementRoute,
    customerBillableMinor,
      marginMinor,
    });


  // Every dinar of the quote's deposit must still be in exactly one bucket.
  // A mutation is one transaction, so a mismatch here rolls the whole
  // completion back rather than leaving the customer's money half-counted.
  if (args.quoteId) {
    await assertQuoteDepositConservation(ctx, {
      quoteId: args.quoteId,
      currency: prepared.currency,
    });
  }

  await createSaleTransaction(ctx, {
    orgId: args.orgId,
    vehicleId: args.vehicleId,
    salePrice: args.salePrice,
    saleDate: args.saleDate,
    vehicle: prepared.vehicle,
    customer: prepared.customer,
    previouslyCollected,
    // Agent basis recognizes the margin only; the gross stays on the row as
    // `amount`. Computed from the same cost basis the GL and commissions use.
    //
    // NOT reduced by `previouslyCollected`. It was, and that made recognized
    // revenue depend on when the customer paid rather than on when the
    // dealership earned it: a 3,000 margin with a 300 عربون taken the previous
    // month recognized 2,700 in the month of the sale, and the missing 300 had
    // been booked as revenue in the month the deposit arrived — against a car
    // that had not been sold. Recognition is an accrual question; the cash
    // movement is already recorded on `amount`.
    //
    // Nothing is deducted here at all. A عربون already counted as revenue
    // under the old rule is handled where it was counted — at report read
    // time, in getProfitAndLoss — because deducting it here would have kept
    // BOTH periods wrong: the deposit's month keeps revenue for a car nobody
    // had sold, and the sale's month recognizes less than it earned.
    // Derived from `marginMinor`, the same integer the journal posts from —
    // never recomputed in major units. `salePrice - costAmount` is a float
    // subtraction, and at three decimals 12,500.7 − 9,500.5 is
    // 3000.2000000000007 while the ledger credits 3000.2. The report could
    // then never tie to the journal, off by an amount too small to chase and
    // too persistent to ignore.
    recognizedRevenue:
      isSourced && marginMinor !== null
        ? fromMinorUnits(Math.max(0, marginMinor), prepared.currency)
        : args.salePrice,
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
        // Both agency refusals are made HERE, not only in the posting rule.
        //
        // `consignedAgentSaleLines` throws on each of these, but that rule is
        // only evaluated when the event posts immediately. `postOrEnqueue`
        // posts only when a chart exists AND an open period covers the sale's
        // date; otherwise it enqueues the raw payload and no rule sees it
        // until the outbox drains. That is not just an org still setting
        // accounting up — it is any BACKDATED sale into a closed month. In
        // those cases the sale was fully recorded — vehicle SOLD, cashflow
        // row, receivable, commission, supplier payable — and the journal
        // failed later, out of sight of whoever sold the car.
        //
        // A refusal that depends on the accounting calendar is not a refusal.
        // Same boundary, same reasoning, as the missing supplier cost above.
        //
        // The shortfall case is the more dangerous of the two, because it does
        // not merely skip a journal: the payable below is written for the FULL
        // entitlement, so the dealership owes the supplier more than the deal
        // collected with nothing on the books saying so. Paying it later
        // debits an AP that the sale never credited.
        if (toMinorUnits(args.salePrice, prepared.currency) < costMinor) {
          throw new ConvexError(
            `This car is ${prepared.vehicle.sourcedFromName ?? "the supplier"}'s and the dealership sells it as his agent, but the sale price is below the supplier's entitlement of ${costAmount} — the amount he is owed for it. The deal would lose money the dealership has to fund, which is a real situation but not one that can be assumed. Record the shortfall against the supplier agreement, or agree a lower supplier amount, before completing the sale.`
          );
        }
        // A financed deal settled directly with the supplier used to be refused
        // here, because the finance company's side of the settlement had no way
        // to record it. It does now, so the refusal is gone rather than
        // weakened — but what it was protecting against is worth keeping in
        // view, because none of it is enforced by this function.
        //
        // The hazard was never the journal. This rule posts from
        // `settlementRoute` and always has: on the direct route it debits the
        // supplier claim and credits commission, and nothing about financing
        // changes that. The hazard was everything `finalizeDeal` does AFTER the
        // sale — a finance-company receivable for the principal, a
        // customer-receivable transfer, and a DR AR-Finance / CR AR-Customers
        // posting — all of which describe money coming to the dealership on a
        // deal where it comes to the supplier. Those are now skipped on this
        // route, in `applications.settlesDirectToSupplier`.
        //
        // The other half was that the route could not be expressed at all:
        // `finalizeDeal` called `completeSale` with no `supplierSettlementRoute`,
        // so an absent route read as THROUGH_DEALERSHIP and posted the deal the
        // opposite way from what was agreed. It is now recorded on the
        // application and carried through.
        //
        // Everything else in this block still refuses, and deliberately: a
        // missing supplier entitlement, a sale below it, and a taxed agency
        // sale are unchanged by who financed the buyer.
        if (args.taxAmount != null && args.taxAmount > 0) {
          throw new ConvexError(
            `This is an agency sale — the dealership sells this car as ${prepared.vehicle.sourcedFromName ?? "the supplier"}'s agent — and agency sales have no agreed tax treatment yet, so whether the tax is his liability or the dealership's changes who owes the money. Record the tax against the supplier agreement, or sell the car as dealership stock, before completing the sale.`
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
  // On DIRECT_TO_SUPPLIER the claim runs the other way: the buyer paid him the
  // gross, so he is holding the dealership's margin. Debiting Receivable from
  // Suppliers records that it is owed; this records which deal it is owed on,
  // and is the only thing `supplierReceivables.recordReceipt` can settle
  // against. Without it the GL account would accrete every margin ever earned
  // this way with nothing able to discharge it.
  //
  // A zero margin opens nothing. The supplier owes the dealership nothing on
  // this car, and a receivable for nothing is an OPEN row that can never be
  // collected, never be closed by a receipt, and shows on the aging report
  // forever.
  //
  // Rounded to the currency before it becomes a claim total. `salePrice` and
  // the capitalized cost are both decimals, and their difference carries float
  // error that would otherwise be stored as the amount a supplier owes — a
  // receivable of 2999.9999999999995 can never be settled to zero.
  // The SAME integer the journal posts from, not a second rounding of the float
  // difference. `marginMinor` is `round(salePrice) - round(cost)`; this was
  // `round(salePrice - cost)`, and where either amount carries more decimals
  // than the currency scale those two disagree by a minor unit. The GL debit on
  // the direct route comes from `marginMinor`, so the claim was raised for an
  // amount its own posting never matched — unsettleable by one fils, forever on
  // the aging report. Same defect as `recognizedRevenue` above; this is its
  // sibling. `marginMinor` is non-null on every path that reaches here: a
  // sourced sale without a positive `costMinor` throws further up.
  const marginMinorForClaim = Math.max(0, marginMinor ?? 0);
  const supplierOwesMargin = marginMinorForClaim > 0;
  if (isSourced && costAmount > 0 && supplierOwesMargin && !dealershipCollectsGross(settlementRoute)) {
    const marginAmount = fromMinorUnits(marginMinorForClaim, prepared.currency);
    await openSupplierReceivable(ctx, {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      saleId,
      sourcedFromName: prepared.vehicle.sourcedFromName ?? "Unknown supplier",
      amountDue: marginAmount,
      currency: prepared.currency,
      alreadyReceivedAmount: appliedToSupplierSettlement,
      actorId: args.actorId,
    });
  }

  if (isSourced && costAmount > 0 && dealershipCollectsGross(settlementRoute)) {
    const now = Date.now();
    await ctx.db.insert("vehicleSupplierPayables", {
      orgId: args.orgId,
      vehicleId: args.vehicleId,
      saleId,
      sourcedFromName: prepared.vehicle.sourcedFromName ?? "Unknown supplier",
      // At the currency's scale, mirroring the receivable side. `sourceCost` is
      // a decimal a person typed and the capitalized cost is a sum of them, so
      // stored raw this becomes a payable no payment can close: `recordPayment`
      // refuses to overpay, which leaves the last fraction of a fils unpayable
      // and the row permanently short of PAID.
      amountDue: fromMinorUnits(toMinorUnits(costAmount, prepared.currency), prepared.currency),
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
    depositResolution?: {
    treatment: DepositTreatment;
    reason?: string;
    /** Required for REFUND_TO_CUSTOMER — the deposit's own method may be OTHER, which cannot be paid out. */
    refundMethod?: DepositMethod;
  };
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
    depositResolution?: {
    treatment: DepositTreatment;
    reason?: string;
    /** Required for REFUND_TO_CUSTOMER — the deposit's own method may be OTHER, which cannot be paid out. */
    refundMethod?: DepositMethod;
  };
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
