/**
 * The one place that decides whether a deal may be turned into a completed sale.
 *
 * A financed deal is supposed to commit through its finance application:
 * handover registered, dealer economics recorded, then `finalizeDeal`. Every
 * public sale door reached the shared completion path without ever asking
 * whether the deal was financed, so a caller holding `create:sales` could
 * complete a configured quote outright — the sale COMPLETED, the vehicle SOLD,
 * the accounting side effects run, and the application left stranded because
 * its own `finalizeDeal` then fails on an already-sold vehicle.
 *
 * Two things about the shape of this guard are load-bearing, and both were
 * arrived at by discarding an earlier design that looked equivalent.
 *
 * ## Authority is derived, never asserted
 *
 * The first design exempted the authorized path with a caller-supplied flag
 * (`allowFinancedCompletion`, or equivalently "an `applicationId` was passed").
 * That is forgeable by construction: this module cannot see WHO set the field,
 * only that it is set, so any future entry point that copies the argument shape
 * inherits the bypass silently — passing the flag looks like ordinary plumbing
 * rather than an authorization decision. That is the same "four places to
 * forget" failure the guard exists to prevent, relocated into a single field.
 *
 * So nothing here trusts the caller. `finalizeDeal` is not EXEMPT from this
 * boundary; it is simply the only caller whose deals can SATISFY it, because
 * satisfaction is read from the application's own persisted lifecycle state.
 * A matching application id is identity, not authority — which is why an
 * APPROVED application with no handover is still refused.
 *
 * ## The deal is resolved from the VEHICLE, not from the arguments
 *
 * `applicationId` is optional on the shared args and `quoteId` is optional on
 * `sales.create` and `sales.createDraft`. A guard keyed on either closes
 * nothing, because the dangerous shape simply omits the field: drop the quote
 * and a quote-keyed guard never runs, while the vehicle is still sold and the
 * application still stranded.
 *
 * The harm is a property of the vehicle — it is the thing sold out from under a
 * live application — so that is what gets looked up. The quote is consulted as
 * well, because a financed quote whose application has not been created yet has
 * no application row to find and must still be refused.
 */
import { ConvexError } from "convex/values";
import { Doc, Id } from "../_generated/dataModel";
import { MutationCtx, QueryCtx } from "../_generated/server";

/** Statuses that mean the application is over and can strand nothing. */
const FINISHED_APPLICATION_STATUSES = new Set(["REJECTED", "CANCELLED", "CLOSED"]);

/** The subset of a quote that decides whether the deal is financed. */
export interface FinancedQuoteFacts {
  mode?: string;
  companyId?: Id<"financeCompanies">;
}

/**
 * Whether this quote's deal has to commit through a finance application.
 *
 * The `companyId` fallback is not a refinement, it is the point. `saveQuote`
 * rejects a `companyId` only when a mode is PRESENT and non-configured, so
 * `companyId` set with `mode === undefined` is creatable through the ordinary
 * public mutation today — and it is the shape that gets written down as
 * `financingType: "CASH"`, which misstates a financed deal as a cash one rather
 * than merely skipping a lifecycle. A guard reading `mode` alone closes the
 * doors against explicitly-financed quotes and leaves every mode-less
 * configured quote walking through all of them, which is the defect, not a
 * smaller version of it.
 *
 * `settlementPayer` reads the same shape the same way, for the same reason.
 */
export function quoteCommitsThroughApplication(quote: FinancedQuoteFacts): boolean {
  if (quote.mode !== undefined) return quote.mode !== "CASH";
  return quote.companyId !== undefined;
}

/**
 * What is missing before this deal's economics can be sold on, or `null` when
 * nothing is.
 *
 * A deal that never recorded a submitted quotation is a legacy shape with no
 * economics to check, and is let through untouched — the same reading
 * `finalizeDeal` has always used.
 */
export function dealerEconomicsGap(
  app: Pick<
    Doc<"financeApplications">,
    "submittedQuotationMinor" | "approvedDealerPurchaseAmountMinor" | "financeCompanyFundedPortionMinor"
  >,
  action: string
): string | null {
  if (app.submittedQuotationMinor === undefined) return null;
  if (app.approvedDealerPurchaseAmountMinor === undefined) {
    return `The finance company's approved purchase amount is not recorded on this deal. Record it before ${action}.`;
  }
  // An approval whose funding split could not be computed — the company's LTV
  // basis names an amount nobody recorded — is not something to hand a vehicle
  // over against, or to sell on. The approval being present is not enough.
  if (app.financeCompanyFundedPortionMinor === undefined) {
    return `This deal's funding split could not be calculated. Resolve the reconciliation note on it before ${action}.`;
  }
  return null;
}

/**
 * Why this application cannot legitimately become a completed sale right now,
 * or `null` when it can.
 *
 * These are the same facts `finalizeDeal` establishes before it calls
 * `completeSale`, asked here as a question rather than enforced there as a
 * sequence — so that satisfying the lifecycle, rather than being a particular
 * caller, is what earns a deal its completion.
 */
export function financeApplicationCompletionGap(app: Doc<"financeApplications">): string | null {
  if (app.status !== "APPROVED") {
    return "This deal's finance application has not been approved, so the sale cannot be completed yet.";
  }
  if (!app.vehicleHandoverAt) {
    return "Register the vehicle handover to the customer before completing this deal.";
  }
  if (!app.expectedPaymentMethod || !app.expectedPaymentDate) {
    return "Register how and when the payment is expected before completing this deal.";
  }
  return dealerEconomicsGap(app, "completing this deal");
}

/**
 * Every application that selling this vehicle would strand.
 *
 * Keyed on the vehicle because that is the thing being sold. `by_vehicle` is
 * keyed on a globally unique document id, so it cannot span organizations, but
 * the org is asserted anyway rather than assumed — a tenancy check that holds
 * only because of an id's uniqueness is one schema change from not holding.
 */
async function liveApplicationsForVehicle(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">
): Promise<Doc<"financeApplications">[]> {
  const applications = await ctx.db
    .query("financeApplications")
    .withIndex("by_vehicle", (q) => q.eq("vehicleId", vehicleId))
    .collect();
  return applications.filter(
    (app) => app.orgId === orgId && !FINISHED_APPLICATION_STATUSES.has(app.status)
  );
}

/**
 * The canonical assertion. Every sale-completion door inherits it by reaching
 * `prepareSaleCompletion`, so a door added later inherits it too rather than
 * having to remember it.
 *
 * Deliberately runs before the sale is inserted, before the vehicle is patched
 * SOLD, and before any receivable, journal, outbox event or dealer-economics
 * write — a refusal must leave nothing behind.
 */
export async function assertFinancedDealCommitsThroughApplication(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    vehicleId: Id<"vehicles">;
    quote: FinancedQuoteFacts | null;
    applicationId?: Id<"financeApplications">;
  }
): Promise<void> {
  const live = await liveApplicationsForVehicle(ctx, args.orgId, args.vehicleId);
  const financedQuote = args.quote !== null && quoteCommitsThroughApplication(args.quote);

  // An ordinary cash deal — no financed quote, nothing live to strand. Left
  // exactly as it was, which is what keeps the walk-in sale working.
  if (!financedQuote && live.length === 0) return;

  if (!args.applicationId) {
    throw new ConvexError(
      "This deal is financed, so it commits through its finance application. Register the vehicle handover and record the dealer economics, then finalize it from the application. If the customer is paying cash instead, quote the deal as cash."
    );
  }

  const app = live.find((candidate) => candidate._id === args.applicationId);
  if (!app) {
    // Either the application is not this vehicle's, or it is already finished.
    // Identity is validated separately; this is the "finished" case, and a
    // finished application cannot authorize a second sale of the same car.
    throw new ConvexError(
      "This deal's finance application is no longer open, so it cannot be completed through it."
    );
  }

  const gap = financeApplicationCompletionGap(app);
  if (gap) throw new ConvexError(gap);

  // Deliberately NOT refused here: a second live application on the same
  // vehicle — an abandoned DRAFT from an earlier quote, say. Completing this
  // deal does strand it, but it was already stranded the moment two
  // applications named one car, and refusing would dead-end the legitimate
  // finalize behind a cancellation the operator has no prompt to perform. That
  // is a pre-existing condition this boundary is not chartered to fix, and
  // widening into it would trade a closed bypass for a blocked sale.
}
