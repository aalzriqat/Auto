import { ConvexError } from "convex/values";
import { type MutationCtx, type QueryCtx } from "../../_generated/server";
import { type Doc, type Id } from "../../_generated/dataModel";
import { projectFinanceApplication } from "../../utils/financeApplicationProjection";
import { closingRefusalError } from "../../utils/financedSaleRecognition";
import { getOrgCurrency } from "../../accounting/workflowHooks";
import { denominationOf, assertSupportedDenomination } from "../../utils/money";
import {
  firstPaymentRefusal,
  readFirstPaymentEvidence,
} from "../../utils/firstPaymentEvidence";
import {
  assertDealerEconomicsReady,
  settlesDirectToSupplier,
} from "./settlementRouting";
export type FinancedHandoverEvidence = {
  approvedPurchaseAmountMinor: number | null;
  financeCompanyFundedPortionMinor: number | null;
  dealerContributionMinor: number | null;
  approvedAmountIsFarFromEvidence: boolean;
  currency: { code: string; scale: number } | null;
};

export type ApprovalAnomaly = (
  app: Doc<"financeApplications">,
  appraisals: Doc<"financeAppraisals">[],
  visible: boolean,
) => boolean;

/**
 * Everything the financed-deal cockpit renders, from one query.
 *
 * Deliberately not six queries with the arithmetic done in React. The screen's
 * headline is `صافي ربح المعرض`, a MANAGEMENT figure derived from the finance
 * company's approved purchase amount rather than from what the customer paid —
 * a number the books do not support and must never be asked to. Computing it on
 * the client would make it trivially separable from the qualifier that says so,
 * and would give the screen a second opinion about money the ledger already has
 * an opinion about. One assembly, server-side, is the enforcement.
 *
 * Returns `null` for an application that does not exist or belongs to another
 * org — the same shape `get` uses, so the screen has one not-found path.
 */
/**
 * A stamp of the economics a handover confirmation is about, issued to every
 * caller who can load the deal and demanded back by `registerVehicleHandover`.
 *
 * Deliberately NOT permission-shaped: a caller whose amounts are redacted still
 * needs one, because the deal must not be sealed against figures that moved
 * regardless of who is looking. Keying this to visibility is what left default
 * SALES unguarded and dead-ended `confirm:finance_disbursement` roles at once.
 *
 * And deliberately CARRYING NO MONEY. The first version of this encoded the
 * approved amount and its split directly — `v1|<approved>|<funded>|<contribution>`
 * — and then projected it to every caller, handing the exact figures
 * `redactSettlementEvidence` withholds to the callers it withholds them from,
 * legible at a glance. A digest would not have saved it: the format is known
 * and at 100% LTV the search collapses to a single figure. So the token is a
 * revision counter and says nothing about the deal but that it changed.
 */
export function economicsStamp(app: Doc<"financeApplications">): string {
  return `v2|${app.economicsRevision ?? 0}`;
}

/**
 * Everything the handover confirmation is allowed to show, resolved ONCE on the
 * server and consumed identically by `dealCockpit` and `applications.get`.
 *
 * Five defects of one class reached this screen before it looked like this:
 * some of what the operator saw came from one query and some from another, or
 * some from a snapshot and some from live props, and the two disagreed. The
 * cure is not another careful patch — it is that there is now exactly one
 * answer, computed in one place, for both doors into the same one-way action.
 *
 * THE FIGURES MOVE TOGETHER. The split is not separately gated: with the
 * approved amount withheld but its two addends shown, an operator recovers the
 * withheld figure by adding them — `funded + contribution` IS the approved
 * amount. Showing a decomposition of a number that is being withheld is not a
 * partial disclosure, it is the whole one with an extra step.
 *
 * CURRENCY FAILS CLOSED. `economicsCurrency` is the deal's own denomination and
 * the only trustworthy one. The organization's current currency is NOT a
 * fallback: `orgSettings` does not count `financeApplications` among the rows
 * that lock it, so an org can record economics in JOD and later switch to USD —
 * this schema says so in as many words. Guessing would render 1,150,000 minor
 * units of USD as 1,150 JOD on the screen that seals the deal permanently. When
 * the denomination cannot be established, this returns null and the client
 * refuses the confirmation rather than spelling a number in a currency nobody
 * verified.
 */
export async function handoverEvidenceFor(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  role: Doc<"roles">,
  approvedAmountIsFarFromEvidenceFor: ApprovalAnomaly,
): Promise<FinancedHandoverEvidence> {
  /**
   * EVERY figure here comes from the projection, each under its OWN class.
   *
   * This used to derive all three from one boolean: "may this caller see the
   * approved amount?" gated the amount AND its two addends. That was coherent
   * while they shared a visibility class. The owner-proxy ruling of 2026-09-13
   * split them - the approval is an APPROVAL_WORKFLOW fact, its decomposition
   * is accounting economics behind `view:finance` - and a single derived
   * boolean then published the composition to every role holding
   * `approve:finance_application` or `confirm:finance_disbursement`.
   *
   * So the boolean is no longer allowed to speak for fields it does not
   * classify. Each field is read from `projected`, which makes
   * `financeApplicationProjection` the single authority rather than one of two
   * places that have to agree.
   */
  const projected = projectFinanceApplication(app, role);
  const visibleAmount = projected.approvedDealerPurchaseAmountMinor;
  const maySeeFigures = visibleAmount !== undefined;
  const appraisals = await ctx.db
    .query("financeAppraisals")
    .withIndex("by_application", (q) => q.eq("applicationId", app._id))
    .collect();
  return {
    approvedPurchaseAmountMinor: visibleAmount ?? null,
    financeCompanyFundedPortionMinor:
      projected.financeCompanyFundedPortionMinor ?? null,
    dealerContributionMinor: projected.dealerContributionMinor ?? null,
    approvedAmountIsFarFromEvidence: approvedAmountIsFarFromEvidenceFor(
      app,
      appraisals,
      maySeeFigures,
    ),
    currency: denominationOf(app.economicsCurrency),
  };
}

type RegisterVehicleHandoverInput = {
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  notes?: string;
  economicsStamp?: string;
};

/**
 * التنازل بالسيارة للعميل — records that the vehicle has been handed over to
 * the customer. Required before finalizeDeal. Data-capture only, no document
 * is generated.
 */
/**
 * The economics the operator's screen was built from, as the server stamped
 * them — `economicsStamp` from the same `dealCockpit` / `get` payload the
 * confirmation was rendered against.
 *
 * WHY A STAMP AND NOT THE AMOUNT. Handover is the moment those figures
 * become permanent. Between a dialog rendering them and the operator
 * pressing confirm, another approver can legitimately record different ones
 * — the vehicle has not gone out yet, so nothing refuses them — and sealing
 * against a figure that has since moved is the exact confidence this
 * confirmation was built to create, pointed at the wrong number.
 *
 * The first attempt asked for the approved amount back and demanded it only
 * from callers who could SEE it. That was wrong in both directions, and the
 * regression tests for both directions live in `financingEconomics.test.ts`:
 *
 *   • TOO NARROW — default SALES holds neither `view:finance` nor
 *     `confirm:finance_disbursement`, so the obligation was never raised for
 *     the role most likely to hand a vehicle over. It sealed silently.
 *   • TOO BROAD — a role holding `confirm:finance_disbursement` without
 *     `view:finance_applications` was required to confirm a figure the
 *     cockpit could not display to it, dead-ending handover entirely.
 *
 * Visibility was never the right basis. Whether a caller may READ the
 * amount and whether the deal may be SEALED against figures that moved are
 * different questions, and `approvedDealerPurchaseAmountMinor` is in any
 * case a display gate rather than a confidentiality boundary — see the note
 * in `redactSettlementEvidence`. So the stamp is issued to every caller who
 * can load the deal, redacted or not, and demanded from all of them. There
 * is no predicate left to keep exhaustive across four queries.
 *
 * Compared inside the mutation's own transaction, so there is no window
 * between the check and the write.
 *
 * Optional in the VALIDATOR only so a client running a bundle from before
 * this change gets the readable refusal below instead of a raw validator
 * dump. The handler demands it unconditionally: absent is refused, exactly
 * like stale. Fail closed — a brief loud refusal during a deploy, never a
 * silent seal.
 */
export async function executeRegisterVehicleHandover(
  ctx: MutationCtx,
  args: RegisterVehicleHandoverInput,
  app: Doc<"financeApplications">,
  user: Doc<"users">,
) {
  if (app.status !== "APPROVED")
    throw new ConvexError(
      "Application must be APPROVED before registering handover.",
    );
  if (app.vehicleHandoverAt)
    throw new ConvexError("Vehicle handover has already been registered.");
  // Deal fitness first. A deal that cannot be handed over at all is not
  // improved by being asked to confirm a figure — and the refusal that names
  // the missing funding split is the more useful one to reach the operator.
  assertDealerEconomicsReady(app, { phase: "HANDOVER" });
  // Reject unsupported currencies at the handover write boundary.
  assertSupportedDenomination(
    app.economicsCurrency,
    "handing the vehicle over",
  );
  // A missing currency blocks approved amounts. Preserve SCRUM-61 recovery before approval.
  if (
    app.approvedDealerPurchaseAmountMinor !== undefined &&
    denominationOf(app.economicsCurrency) === null
  ) {
    throw new ConvexError(
      "AutoFlow cannot confirm which currency this deal's approved amount is recorded in, so the vehicle cannot be handed over yet. Record the deal's economics again to restate them in a supported currency.",
    );
  }

  // Require the current economics stamp for every caller.
  if (args.economicsStamp === undefined) {
    throw new ConvexError(
      "Confirm the handover from the deal screen so the figures you acted on can be checked. If you were already on it, reload the page and try again.",
    );
  }
  if (args.economicsStamp !== economicsStamp(app)) {
    throw new ConvexError(
      "The deal's approved figures changed while you were confirming the handover. Re-check them on the deal before handing the vehicle over.",
    );
  }

  const now = Date.now();
  const firstPayment = await readFirstPaymentEvidence(ctx, app, {
    settlesDirect: await settlesDirectToSupplier(ctx, app),
    currency: app.economicsCurrency ?? (await getOrgCurrency(ctx, args.orgId)),
    now,
  });
  const refusal = firstPaymentRefusal(firstPayment.status);
  if (refusal) throw closingRefusalError(refusal);
  await ctx.db.patch(args.applicationId, {
    vehicleHandoverAt: now,
    firstPaymentEvidenceChecked: true,
    vehicleHandoverBy: user._id,
    vehicleHandoverNotes: args.notes,
    handoverStatus: "HANDED_OVER",
    updatedAt: now,
  });
  return now;
}
