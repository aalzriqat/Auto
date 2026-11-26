import type { SettlementPayer } from "../../utils/vehicleOwnership";
import { settlementPayer } from "../../utils/vehicleOwnership";
import { dealModeOf } from "../../utils/financedSaleRecognition";
import { manualPayerLabel } from "../../utils/manualFinancePayer";
import { ConvexError, type Infer } from "convex/values";
import { type MutationCtx, type QueryCtx } from "../../_generated/server";
import { type Doc, type Id } from "../../_generated/dataModel";
import { getOrgCurrency } from "../../accounting/workflowHooks";
import { toMinorUnits } from "../../utils/money";
import { assertAppraisalGapSettledToAdvance } from "../../utils/financingEconomics";
import {
  effectiveSupplierEntitlementMinor,
  storedConcessionMinor,
} from "../../utils/supplierConcession";
import {
  consignedSettlementRoute,
  consignedSettlementRouteValidator,
  dealershipCollectsGross,
  directSettlementBelowEntitlementRefusal,
  isConsignedAgentSale,
} from "../../utils/vehicleOwnership";
import { computeVehicleCapitalizedCost } from "../../utils/vehicleCost";
import { auditLog } from "../../utils/financialAuditWriter";
import { liveChequesForApplication } from "../../utils/fcCheque";
import {
  isManualFinanceApplication,
  isManualLetterUnitIntact,
  MANUAL_GAP_TO_FINANCIER_REFUSAL,
} from "../../utils/manualFinancePayer";

/**
 * A MANUAL finance company deal advances only on a complete, consistent letter
 * unit (SCRUM-27): the letter, `approvedDealerPurchaseAmountMinor` equal to the
 * letter's amount, the MANUAL basis and a derived gap, all present together.
 * Then a positive gap must be settled, and only to dealer-bound destinations.
 * Every refusal is before any write and carries no figures.
 */
export function assertManualLetterReady(
  app: Doc<"financeApplications">,
  action: string,
): void {
  if (!isManualLetterUnitIntact(app)) {
    throw new ConvexError(
      `This deal's finance company approval letter is not fully recorded. Enter (or re-enter) the letter's approved amount, the company's name and the amount the dealership sends it before ${action}.`,
    );
  }
  // Defence against a row a writer bypassed: OR-12 never sends a gap to the financier.
  if ((app.customerGapToFinanceCompanyMinor ?? 0) > 0) {
    throw new ConvexError(MANUAL_GAP_TO_FINANCIER_REFUSAL);
  }
  assertAppraisalGapSettledToAdvance(app, action);
}

/**
 * Refuses to advance a deal whose dealer-side economics are not actually there.
 *
 * A reappraisal or a reopened approval clears the approved purchase amount
 * while `status` stays APPROVED throughout, so status alone cannot be the gate.
 * Deals with no quotation recorded predate this model entirely and are let
 * through, so nothing in flight is stranded. The one exception is a manual
 * finance company: it never has a quotation, but it does carry an appraisal gap
 * (sale price minus the letter, OR-12), which is still gated.
 *
 * One copy, two callers: handover and finalization applied the same two checks
 * in the same order and differed only in the closing verb. Two copies of a
 * money-path gate drift, and the drift shows up as the stricter one being
 * quietly bypassed through the other door.
 */
export function assertDealerEconomicsReady(
  app: Doc<"financeApplications">,
  opts: { phase: "HANDOVER" | "FINALIZATION" },
): void {
  const action =
    opts.phase === "HANDOVER" ? "handing over the vehicle" : "finalizing";
  if (app.submittedQuotationMinor === undefined) {
    // A manual deal has no quotation but its letter, approved amount, MANUAL
    // basis and OR-12 appraisal gap are one unit, and it is gated on all of
    // them: keyed on "is manual", NOT on "has a letter", or a deal with no
    // letter at all would sail through handover and strand at finalization.
    if (isManualFinanceApplication(app)) assertManualLetterReady(app, action);
    return;
  }
  if (app.approvedDealerPurchaseAmountMinor === undefined) {
    throw new ConvexError(
      `The finance company's approved purchase amount is not recorded on this deal. Record it before ${action}.`,
    );
  }
  // An approval whose funding split could not be computed — the company's LTV
  // basis names an amount nobody recorded — is not something to hand a vehicle
  // over against, or to sell on. The approval being present is not enough.
  if (app.financeCompanyFundedPortionMinor === undefined) {
    throw new ConvexError(
      `This deal's funding split could not be calculated. Resolve the reconciliation note on it before ${action}.`,
    );
  }
  // A positive appraisal gap nobody has settled (SCRUM-116). Enforced here and
  // not only by the stage rail: a gap the handover stamps is sealed against the
  // one writer that can settle it, and finalization posts from the split.
  assertAppraisalGapSettledToAdvance(app, action);
}

/**
 * Whether this deal's money goes straight from the finance company to the
 * supplier, so nothing gross ever reaches the dealership's books.
 *
 * Both halves are required and neither is derivable from the other. The route
 * says who the cheque is made out to; the vehicle says whether there is a
 * supplier at all. A route naming a supplier settlement on dealer-owned stock
 * is a contradiction rather than a direct deal, and reading it as direct would
 * suppress the finance-company receivable on an ordinary financed sale — the
 * dealership would simply stop recording that the company owes it the money.
 * So this fails closed onto the ordinary path.
 *
 * `consignedSettlementRoute` supplies the absent-means-THROUGH_DEALERSHIP
 * reading, which is what keeps every deal finalized before the field existed
 * behaving exactly as it did.
 */
export async function settlesDirectToSupplier(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">,
): Promise<boolean> {
  if (dealershipCollectsGross(consignedSettlementRoute(app))) return false;
  const vehicle = await ctx.db.get(app.vehicleId);
  return vehicle != null && isConsignedAgentSale(vehicle);
}

/**
 * The same question, asked of a deal that has already posted.
 *
 * `settlesDirectToSupplier` re-derives the route from the live vehicle, which is
 * right before the sale exists and wrong afterwards: the sale is the thing that
 * committed to one side or the other, and `sales.update` locks its route once
 * completed. Re-deriving post-sale means a later edit to the vehicle can flip
 * the answer under a deal that already posted.
 *
 * It also fails CLOSED. In `confirmDisbursement` a `false` answer PERMITS the
 * mutation, so a vehicle row that has gone missing — the super-admin panel can
 * hard-delete one — would have let a direct-route deal post DR Bank / CR
 * AR-Finance-Companies, inventing bank cash the dealership never received. A
 * guard whose evidence has disappeared must refuse, not wave the caller through.
 */
export async function closedDealSettlesDirectToSupplier(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">,
): Promise<boolean> {
  if (app.finalizedSaleId) {
    const sale = await ctx.db.get(app.finalizedSaleId);
    // A sale this application NAMES but which cannot be loaded is missing
    // evidence, not absent evidence. Falling through would let the caller
    // proceed on a guess about money that has already posted.
    if (!sale || sale.orgId !== app.orgId) {
      throw new ConvexError(
        "The sale behind this deal could not be loaded, so which way it settles cannot be established. Resolve that before recording any settlement against it.",
      );
    }
    return !dealershipCollectsGross(consignedSettlementRoute(sale));
  }

  // No sale was ever linked. That is a legacy shape rather than a broken one —
  // `confirmDisbursement` already tolerates deals closed before the canonical
  // receivable existed — so refusing here would strand them. The application's
  // own route is what `finalizeDeal` acted on, and absent reads as
  // THROUGH_DEALERSHIP, which is exactly what those deals posted.
  return !dealershipCollectsGross(consignedSettlementRoute(app));
}

/** The operator-facing reason an external payer cannot take the direct route. */
export function unidentifiedPayerRefusal(
  reason: "LEASE" | "PAYER_UNNAMED",
): string {
  return reason === "LEASE"
    ? "This is a lease, and the leasing provider is not recorded anywhere on the deal — so a payment to the supplier could not be attributed to anyone. Settle through the dealership until the provider is recorded."
    : "The finance provider on this deal is not named, so a payment to the supplier could not be attributed to anyone. Record the provider on the quote, then choose this route.";
}

/** The operator-facing reason the route cannot move once the vehicle is out. */
export const ROUTE_FIXED_AFTER_HANDOVER_REFUSAL =
  "The vehicle has already been handed over to the customer, so the settlement route can no longer be changed. The first-payment check at handover was made against the route recorded then.";

/**
 * SCRUM-1017: handover is the one place the customer's first payment is
 * checked, and it skips that check when the deal settles DIRECT to the
 * supplier. A route flipped direct -> handover -> through therefore delivered a
 * through-dealership deal with its first payment never verified (D-000009).
 *
 * So once `vehicleHandoverAt` is set the EFFECTIVE route is frozen. Compared on
 * the effective route (`consignedSettlementRoute`: absent reads as through) so
 * that re-recording the route already in force stays a no-op, and a deal
 * handed over with no route recorded may still record THROUGH_DEALERSHIP — what
 * handover actually checked, and what `finalizeDeal` would otherwise refuse
 * forever for want of. A handover undone through an identity correction clears
 * `vehicleHandoverAt`, which lifts this by itself.
 */
export function settlementRouteChangeRefusedAfterHandover(
  app: Pick<Doc<"financeApplications">, "vehicleHandoverAt" | "supplierSettlementRoute">,
  requested: Infer<typeof consignedSettlementRouteValidator>,
): boolean {
  return (
    app.vehicleHandoverAt !== undefined &&
    requested !== consignedSettlementRoute(app)
  );
}

/**
 * Whether the screen should offer the route control as changeable. False only
 * when a route is on record AND the vehicle is out: an unrecorded route stays
 * recordable (the server then accepts only the one handover checked).
 */
export function canChangeSettlementRoute(
  app: Pick<Doc<"financeApplications">, "vehicleHandoverAt" | "supplierSettlementRoute">,
): boolean {
  return app.vehicleHandoverAt === undefined || app.supplierSettlementRoute === undefined;
}

type SetSupplierSettlementRouteInput = {
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  route: Infer<typeof consignedSettlementRouteValidator>;
};

/**
 * Records who the finance company pays on a consigned deal.
 *
 * A decision, not a derivation. The finance company sends the cheque in full
 * with no deduction, made out to the supplier or to the dealership depending on
 * who owns the car, and only the agreement says which — so it is captured
 * before finalization the same way the handover and the expected payment are,
 * and `finalizeDeal` carries it onto the sale.
 *
 * Refused on dealer-owned stock rather than stored and ignored. There is no
 * supplier to settle with, and a stored route on such a deal would make every
 * later reader re-derive whether the vehicle was consigned before it could
 * trust the field — the same reasoning that keeps it off dealer-owned sales.
 *
 * Refused once the application is CLOSED because that is the point the ledger
 * committed: the sale has posted either a supplier payable or a supplier
 * receivable, and flipping the route afterwards would leave the subledger
 * describing the opposite deal from the journal. Correcting a posted deal is a
 * correction, not an edit.
 *
 * Also fixed once the vehicle is handed over (SCRUM-1017): see
 * `settlementRouteChangeRefusedAfterHandover`.
 */
// SCRUM-413 D-a: `MANAGE_SUPPLIER_SETTLEMENT`, its own authority (it was
// `finalize:financed_deal`, which the SALES template carried, so every
// salesperson could decide where the finance company's cheque was made
// out). The default MANAGER and ACCOUNTANT templates hold it; SALES does
// not. An absent route reads as THROUGH_DEALERSHIP, so whoever records
// it must be someone who knows which way the cheque was made out.
export async function executeSetSupplierSettlementRoute(
  ctx: MutationCtx,
  args: SetSupplierSettlementRouteInput,
  app: Doc<"financeApplications">,
  user: Doc<"users">,
) {
  if (app.status === "CLOSED") {
    throw new ConvexError(
      "This deal is already finalized and its settlement has posted, so the route cannot be changed. Correct the sale instead.",
    );
  }
  if (app.status === "CANCELLED") {
    throw new ConvexError("This application was cancelled.");
  }

  const vehicle = await ctx.db.get(app.vehicleId);
  if (!vehicle || vehicle.orgId !== args.orgId)
    throw new ConvexError("Vehicle not found.");
  if (!isConsignedAgentSale(vehicle)) {
    throw new ConvexError(
      "This vehicle is dealership stock, so there is no supplier to settle with and no settlement route to choose.",
    );
  }
  // Somebody outside the dealership has to be the one paying the supplier.
  //
  // An INTERNAL_INSTALLMENT deal is financed BY THE DEALERSHIP: the customer
  // pays it over time and it owes the supplier, so no external party pays him
  // and the direct route is incoherent. Accepting it was not merely
  // meaningless — `completeSale` reads the route to decide the customer's
  // vehicle receivable, so it zeroed the record of instalments the customer
  // genuinely owes, and `confirmSupplierDisbursement` then refused the deal
  // forever because it has no finance company. A dead end with the customer's
  // debt erased on the way in.
  //
  // Asked of the quote MODE rather than of `companyId`, which is only ever
  // set on CONFIGURED_FINANCE_COMPANY deals — see `settlementPayer`.
  if (args.route === "DIRECT_TO_SUPPLIER") {
    // SCRUM-447 D3: on the direct route the company pays the supplier, so a
    // live finance-company cheque to the dealership contradicts it.
    if ((await liveChequesForApplication(ctx, args.applicationId)).length > 0) {
      throw new ConvexError(
        "This deal has a live finance-company cheque to the dealership, which contradicts the direct route. Correct the expected payment first.",
      );
    }
    const payer = await settlementPayerForApplication(ctx, app);
    if (!payer.external) {
      throw new ConvexError(
        "This deal has no outside financier, so nobody outside the dealership pays the supplier — the direct route does not apply. If the dealership is financing the customer itself, settle through the dealership.",
      );
    }
    // External, but nobody the advice could name. Refused rather than
    // recorded as an unattributable payment.
    if (payer.counterparty === null) {
      throw new ConvexError(unidentifiedPayerRefusal(payer.unidentifiedReason));
    }
    // The mirror of the check `approveDealerPurchaseAmount` makes.
    //
    // That one fires when the amount is entered on a deal already routed
    // direct; this one fires when the route is chosen on a deal already
    // approved. Either ordering reaches the same illegal state — the supplier
    // paid less than he is owed — and a guard that covers only one of them is
    // a guard with a documented way around it.
    if (app.approvedDealerPurchaseAmountMinor !== undefined) {
      const costAmount = await computeVehicleCapitalizedCost(ctx, vehicle);
      if (costAmount > 0) {
        const currency =
          app.economicsCurrency ?? (await getOrgCurrency(ctx, args.orgId));
        const refusal = directSettlementBelowEntitlementRefusal({
          approvedAmountMinor: app.approvedDealerPurchaseAmountMinor,
          // SCRUM-766 PR-C: what the supplier is owed is his entitlement LESS any
          // concession recorded on this application (0 when none, so unchanged).
          supplierEntitlementMinor: effectiveSupplierEntitlementMinor({
            entitlementMinor: toMinorUnits(costAmount, currency),
            concessionMinor: storedConcessionMinor(app),
          }),
          supplierName: vehicle.sourcedFromName,
        });
        if (refusal) throw new ConvexError(refusal);
      }
    }
  }
  // A held عربون no longer blocks the direct route (SCRUM-407 c21033, SCRUM-411):
  // plan v3 discharges it at the sale and owes it onward to the finance company
  // together with the contribution, exactly as on the through route.

  // SCRUM-1017. After every deal-specific refusal above (so each keeps its own
  // message) and before the first write, so a refusal leaves no row and no audit.
  if (settlementRouteChangeRefusedAfterHandover(app, args.route)) {
    throw new ConvexError(ROUTE_FIXED_AFTER_HANDOVER_REFUSAL);
  }

  const previous = consignedSettlementRoute(app);
  await ctx.db.patch(args.applicationId, {
    supplierSettlementRoute: args.route,
    updatedAt: Date.now(),
  });

  await auditLog(ctx, {
    orgId: args.orgId,
    actorId: user._id,
    actionType: "SET_SUPPLIER_SETTLEMENT_ROUTE",
    resourceType: "financeApplications",
    resourceId: args.applicationId,
    description:
      args.route === "DIRECT_TO_SUPPLIER"
        ? `Financed consigned deal will settle DIRECT to ${vehicle.sourcedFromName ?? "the supplier"}: the finance company pays him, and the dealership holds only a claim for its margin.`
        : `Financed consigned deal will settle THROUGH the dealership: gross arrives here on ${vehicle.sourcedFromName ?? "the supplier"}'s behalf and his entitlement is owed to him.`,
    before: { supplierSettlementRoute: previous },
    after: { supplierSettlementRoute: args.route },
  });

  return { route: args.route };
}

/**
 * Resolves who pays for the car on this deal, from the application's own
 * snapshot.
 *
 * The MODE falls back to the quote's current mode when the application predates
 * `quoteModeAtSubmission`, which is exactly what `finalizeDeal` already does
 * when it derives `financingType` — so the two cannot disagree about what kind
 * of deal this is.
 *
 * The IDENTITY does NOT fall back. A settlement advice records who paid the
 * supplier, and re-deriving that later from a quote field the operator can
 * still edit would let the named payer change after the payment was recorded.
 * A legacy row carrying no snapshot therefore resolves as external-but-unnamed
 * and is refused the direct route, rather than being attributed to whoever the
 * quote happens to name today.
 */
export async function settlementPayerForApplication(
  ctx: QueryCtx | MutationCtx,
  app: Doc<"financeApplications">,
): Promise<SettlementPayer> {
  return settlementPayer({
    quoteMode: await dealModeOf(ctx, app),
    financeCompanyId: app.companyId,
    manualProviderName: manualPayerLabel(app),
  });
}
