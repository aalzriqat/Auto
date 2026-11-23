import { ConvexError } from "convex/values";
import { type MutationCtx } from "../../_generated/server";
import { type Doc, type Id } from "../../_generated/dataModel";
import { PERMISSIONS } from "../../utils/permissions";
import { notifyByPermission, getActorName } from "../../utils/notifications";
import {
  isForwardPlanVersion,
  planVersionOf,
} from "../../utils/financedSalePostingPlan";
import { assertForwardSettledForTransfer } from "../../utils/financeCompanyForward";
import { assertValidMinorAmount } from "../../utils/money";
import { auditLog } from "../../utils/financialAuditWriter";
import { manualPayerOf } from "../../utils/manualFinancePayer";
import {
  closedDealSettlesDirectToSupplier,
  unidentifiedPayerRefusal,
} from "./settlementRouting";
import { settlementPayerForApplication } from "./settlementRouting";

export function validateSupplierAdvice(args: ConfirmSupplierDisbursementInput) {
  assertValidMinorAmount(args.disbursedAmountMinor, "disbursed amount");
  // Convex accepts NaN as a `v.number()`, and every other timestamp on this
  // record comes from `Date.now()`. This one is operator-supplied, and its
  // documented purpose is backdating an advice that already arrived — so a
  // future date is not a valid one, and a NaN would be stored and returned.
  if (args.disbursedAt !== undefined) {
    if (!Number.isSafeInteger(args.disbursedAt) || args.disbursedAt <= 0) {
      throw new ConvexError("That disbursement date is not a valid date.");
    }
    if (args.disbursedAt > Date.now()) {
      throw new ConvexError("The disbursement date cannot be in the future.");
    }
  }
}

type ConfirmSupplierDisbursementInput = {
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  disbursedAmountMinor: number;
  reference?: string;
  disbursedAt?: number;
  idempotencyKey: string;
};

/**
 * Records that the finance company paid the SUPPLIER, on the direct route.
 *
 * This money never touches the dealership. It is read off the settlement advice
 * and recorded because it is the event that makes the supplier's margin
 * genuinely collectable — before it, the dealership is owed by a supplier who
 * has not himself been paid.
 *
 * **It posts no journal and creates no payment.** Every existing disbursement
 * path books cash into the dealership's bank; doing that here would invent
 * money the dealership never received. The dealership's asset on this deal is
 * the supplier margin claim `completeSale` already opened, and the only thing
 * that discharges it is `supplierReceivables.recordReceipt` when the supplier
 * actually hands the margin over. Settling the claim here instead would report
 * the money as collected on the day somebody else was paid.
 *
 * The amount is recorded as stated rather than checked against the deal's own
 * figures. What the company pays the supplier is a transaction between two
 * other parties, and the dealership's approved purchase amount is its
 * expectation of it, not its terms — refusing a mismatch would block recording
 * a fact that is true whether or not it matches.
 *
 * It is nonetheless COMPARED, because the supplier's debt was accrued from the
 * approval and a disagreement means the dealership holds two contradictory
 * records of one payment. That is recorded as
 * `supplierDisbursementStatus: "REQUIRES_RECONCILIATION"` rather than raised as
 * an error, for two reasons:
 *
 *   - a throw rolls back the write it is reacting to, so the evidence of the
 *     discrepancy would be discarded along with the advice, leaving nothing
 *     for anyone to reconcile;
 *   - the approval is immutable after finalization by design — it is the frozen
 *     basis for the supplier claim, the agency revenue, the salesperson's
 *     commission and the reports — so refusing the advice left the operator
 *     with no legal move at all.
 *
 * Neither the approval nor the claim is touched here. If the ADVICE was
 * mistyped, `amendSupplierDisbursementAdvice` corrects it under audit. If the
 * APPROVAL itself turns out to have been wrong, that is a financial correction
 * against a closed sale — supplier claim, GL, commission and reporting must all
 * move together — and it does not happen by editing a field.
 *
 * A bank or wire fee is not a revised approval. Who bears it is a separate
 * question with its own answer; it must not be settled by quietly restating
 * what the finance company approved.
 */
/** What the settlement advice says the company paid the supplier. */
/** Cheque number or transfer reference from the advice. */
/** Defaults to now; set it when recording an advice that arrived earlier. */
// Every field that gets PERSISTED belongs here. `runWithIdempotency`
// rejects key reuse only when fingerprints differ, so omitting the
// reference and the date meant a replay carrying a corrected cheque
// number returned the prior result and silently discarded the
// correction — leaving stale evidence on a record whose whole purpose
// is to hold what the settlement advice said.
export async function executeConfirmSupplierDisbursement(
  ctx: MutationCtx,
  args: ConfirmSupplierDisbursementInput,
  user: Doc<"users">,
) {
  const app = await ctx.db.get(args.applicationId);
  if (!app || app.orgId !== args.orgId)
    throw new ConvexError("Application not found.");
  // Eligible once the deal is finalized, whether or not its sale survived.
  // `cancelApplication` moves a finalized deal to CANCELLED and keeps
  // `finalizedSaleId`; a sale cancelled through `sales.update` before
  // SCRUM-447 left it CLOSED. An application cancelled BEFORE it was
  // finalized has no sale and is refused, as is one whose linked sale is
  // not this organization's.
  //
  // On a cancelled sale the payment is still RECORDED. What the finance
  // company paid the supplier is a fact about two other parties, true
  // whether or not the dealership's sale survived — and this mutation
  // already records an advice that contradicts the approval for exactly
  // that reason. Refusing here would leave an operator unable to write
  // down a payment that really happened, and both cancel paths refuse a
  // sale whose disbursement is already confirmed, so cancel-then-confirm
  // is the only order in which this can occur at all.
  const linkedSale = app.finalizedSaleId
    ? await ctx.db.get(app.finalizedSaleId)
    : null;
  const saleIsCancelled =
    linkedSale?.orgId === app.orgId && linkedSale.status === "CANCELLED";
  const finalized =
    app.status === "CLOSED" || (app.status === "CANCELLED" && saleIsCancelled);
  if (!finalized) {
    throw new ConvexError(
      "The company's payment to the supplier can only be recorded once the deal is finalized.",
    );
  }
  // The payer has to be nameable, because that is what this record IS —
  // evidence that a specific third party paid the supplier. A configured
  // finance company is identified by id; a manual provider by the name
  // snapshotted at submission. Neither is `receivableDocuments.
  // financeCompanyId`: the direct route deliberately opens no
  // finance-company receivable, and this is provenance, not a payer of
  // one.
  const payer = await settlementPayerForApplication(ctx, app);
  if (!payer.external) {
    throw new ConvexError(
      "This application has no outside financier — no disbursement expected.",
    );
  }
  if (payer.counterparty === null) {
    throw new ConvexError(unidentifiedPayerRefusal(payer.unidentifiedReason));
  }
  if (args.disbursedAmountMinor <= 0) {
    throw new ConvexError("Disbursement amount must be positive.");
  }
  if (!(await closedDealSettlesDirectToSupplier(ctx, app))) {
    throw new ConvexError(
      "This deal settles through the dealership, so the finance company pays the dealership rather than the supplier. Confirm the disbursement on the deal instead.",
    );
  }
  // SCRUM-407 c21033 / SCRUM-411: the finance company transfers the FULL
  // approved amount only after the dealership has forwarded the deposit and its
  // contribution to it, on this route exactly as on the through route. The same
  // ONE proof `confirmDisbursement` asks; the refusal names who acts next and
  // never carries H or D.
  // A cancelled sale is exempt: the advice is evidence of a payment the finance company
  // already made to the supplier (recorded above whether or not the sale survived), and the
  // ordering rule protects a LIVE sale's transfer, which a cancelled sale no longer has.
  if (!saleIsCancelled && isForwardPlanVersion(planVersionOf(app)))
    await assertForwardSettledForTransfer(ctx, app);
  // Not folded into the idempotency key's job. A retry with the same key
  // is suppressed upstream; this catches a SECOND advice recorded under a
  // different key, which is a correction somebody has to make
  // deliberately rather than a second payment on the same deal.
  if (app.supplierDisbursementConfirmedAt !== undefined) {
    throw new ConvexError(
      // Names where a correction goes, rather than stopping dead. Once
      // this is recorded, a corrected reference or date cannot be
      // resubmitted here at all: the same idempotency key fails on the
      // fingerprint and a new key fails on this guard. That is deliberate
      // — a second advice on one deal must not be a routine action — but
      // an operator who mistyped a cheque number still needs somewhere to
      // go, and silence sent them nowhere. A first-class amend path with
      // its own audit record is tracked separately.
      "The company's payment to the supplier has already been recorded on this deal. To correct the amount, reference or date on a recorded advice, ask an administrator to amend it — it cannot be re-submitted here.",
    );
  }

  // The advice must record the amount the deal was approved at.
  //
  // The dealership's ruling is that on a financed direct deal the finance
  // company pays the supplier in exactly ONE payment, for the approved
  // amount. That makes any other figure a contradiction between two
  // records of the same fact — not a partial payment, which this route
  // does not have — and this mutation accepted any positive number, so the
  // contradiction could be stored silently and then read back as evidence.
  //
  // It matters even though the supplier claim no longer derives from this
  // field. The claim is accrued at finalization from the approval, so an
  // advice that disagrees means either the approval on file is not what
  // the company actually approved, or the money that reached the supplier
  // is not what the claim was raised against. Both need a human. Refusing
  // here is what makes the accrual VERIFIABLE rather than merely assumed —
  // the enforcement and the re-grounding are two halves of one fix, and
  // either alone leaves the debt derivable from the wrong quantity.
  //
  // Ordered AFTER the already-recorded check so a second advice is told
  // that one exists, which is the more specific and more actionable
  // answer, rather than being turned away over its amount.
  if (app.approvedDealerPurchaseAmountMinor === undefined) {
    throw new ConvexError(
      "This deal has no approved purchase amount recorded, so there is nothing to check the company's payment against. Record what it approved before confirming what it paid.",
    );
  }
  const approvedAtRecordingMinor = app.approvedDealerPurchaseAmountMinor;
  const adviceAgreesWithApproval =
    args.disbursedAmountMinor === approvedAtRecordingMinor;

  const vehicle = await ctx.db.get(app.vehicleId);
  const supplierName = vehicle?.sourcedFromName ?? "the supplier";
  const confirmedAt = args.disbursedAt ?? Date.now();
  // Name the payer in the audit trail rather than calling every one of
  // them "the finance company". On a manual provider that phrase was
  // simply untrue, and this record is the only place the settlement
  // advice's counterparty is written down.
  let payerName = "The finance company";
  const letterPayer = manualPayerOf(app);
  if (letterPayer !== null) {
    // SCRUM-27: the name exactly as on the approval letter, which the
    // manager entered, outranks the quote-time provider label.
    payerName = letterPayer.name;
  } else if (payer.counterparty.kind === "MANUAL_PROVIDER") {
    payerName = payer.counterparty.name;
  } else if (app.companyId) {
    const company = await ctx.db.get(app.companyId);
    if (company && company.orgId === args.orgId) payerName = company.name;
  }

  await ctx.db.patch(args.applicationId, {
    supplierDisbursementConfirmedAt: confirmedAt,
    supplierDisbursedAmountMinor: args.disbursedAmountMinor,
    supplierDisbursementReference: args.reference,
    supplierDisbursementConfirmedBy: user._id,
    // Recorded either way, and NOT thrown on when it disagrees. A throw
    // here would roll back the very evidence it is reacting to — the
    // dealership would be left knowing the supplier was paid and holding
    // no record that he was, which is the state that let a paid deal stay
    // cancellable. The contradiction is a fact about the deal, so it is
    // stored as one.
    supplierDisbursementStatus: adviceAgreesWithApproval
      ? ("CONFIRMED" as const)
      : ("REQUIRES_RECONCILIATION" as const),
    ...(adviceAgreesWithApproval
      ? {}
      : {
          supplierDisbursementApprovedAtRecordingMinor:
            approvedAtRecordingMinor,
        }),
    updatedAt: Date.now(),
    // Deliberately NOT FULLY_SETTLED. Nothing has been settled to the
    // dealership: the company has paid the supplier, and the dealership's
    // margin is still outstanding on the supplier claim. Marking this
    // settled would report the deal as collected on the strength of
    // somebody else's receipt.
    //
    // On a cancelled sale settlementStatus is left untouched — NOT_READY where
    // `cancelApplication` set it, whatever finalization left on a legacy CLOSED
    // application: late evidence of a payment to the supplier must not reopen
    // settlement on a deal that no longer exists.
    ...(saleIsCancelled ? {} : { settlementStatus: "EXPECTED" as const }),
  });

  await auditLog(ctx, {
    orgId: args.orgId,
    actorId: user._id,
    actionType: "CONFIRM_SUPPLIER_DISBURSEMENT",
    resourceType: "financeApplications",
    resourceId: args.applicationId,
    description: `${payerName} paid ${supplierName} ${args.disbursedAmountMinor} minor units directly${args.reference ? ` (ref ${args.reference})` : ""}. No dealership cash moved; the dealership's margin remains a claim on ${supplierName}.${
      adviceAgreesWithApproval
        ? ""
        : ` NEEDS RECONCILIATION: the deal was approved at ${approvedAtRecordingMinor} minor units, so the advice and the approval disagree by ${Math.abs(args.disbursedAmountMinor - approvedAtRecordingMinor)}. The supplier claim was raised against the approval and has NOT been changed.`
    }`,
    before: { supplierDisbursementConfirmedAt: null },
    after: {
      supplierDisbursementConfirmedAt: confirmedAt,
      supplierDisbursedAmountMinor: args.disbursedAmountMinor,
      settlementCounterparty: payerName,
      supplierDisbursementStatus: adviceAgreesWithApproval
        ? "CONFIRMED"
        : "REQUIRES_RECONCILIATION",
      ...(adviceAgreesWithApproval
        ? {}
        : { approvedDealerPurchaseAmountMinor: approvedAtRecordingMinor }),
    },
    idempotencyKey: args.idempotencyKey,
  });

  if (saleIsCancelled) {
    // Its own exception, with its own owner.
    //
    // Suppressing the reconciliation notice was right — nothing can be
    // reconciled on a cancelled deal and the cockpit renders it STOPPED —
    // but suppression alone left a payment recorded outside any live deal
    // with nobody told about it at all. The supplier has been paid for a
    // car whose sale was reversed and which may already be back in
    // sellable inventory; that is a human problem, and it is a different
    // one from a discrepancy.
    //
    // Fires whether or not the amount agreed with the approval: the
    // exception is WHERE the money landed, not how much of it.
    await notifyByPermission(
      ctx,
      args.orgId,
      PERMISSIONS.MANAGE_FINANCE,
      "application.payment_on_cancelled_deal" as const,
      { actorName: await getActorName(ctx) },
      { link: `/${args.orgId}/applications/${args.applicationId}/deal` },
    );
  } else if (!adviceAgreesWithApproval) {
    // A discrepancy nobody is told about is a discrepancy nobody resolves.
    //
    // Its own type, because it borrowed `application.created` — whose
    // template reads "{actorName} submitted a new finance application for
    // {customerName}" and which was never given a `customerName`, so the
    // renderer substituted only what it received and shipped the
    // placeholder verbatim. Recipients were told a new application had
    // arrived for a customer called `{customerName}`, about a deal that
    // had in fact stopped. Nothing in it said reconciliation.
    //
    // Routed on the finance authority rather than `notifyManagers`, which
    // selects on `manage:users` — a permission an org can reasonably give
    // an office administrator, and one that says nothing about being
    // allowed to see deal money.
    //
    // And it carries NO amount. `dispatch` stores `data` on the row as
    // given and `notifications.list` returns rows unprojected, so the
    // disbursed figure was not merely unrendered — it was readable by
    // every recipient, which put settlement evidence the cockpit gates
    // behind `view:finance` into the hands of people selected without it.
    // The message says what happened; the figures stay on the cockpit,
    // behind the gate that already exists for them.
    await notifyByPermission(
      ctx,
      args.orgId,
      PERMISSIONS.MANAGE_FINANCE,
      "application.settlement_advice_discrepancy" as const,
      {
        actorName: await getActorName(ctx),
      },
      // The cockpit route, which is the page that renders the
      // discrepancy and carries the correction action. There is no page
      // at `/applications/{id}` and no rewrite covering it — the only
      // redirect configured is `/login` — so the shorter form 404s, which
      // on the one notification whose entire job is to get somebody to
      // the recovery path is worse than not sending it.
      { link: `/${args.orgId}/applications/${args.applicationId}/deal` },
    );
  }

  return {
    confirmedAt,
    disbursedAmountMinor: args.disbursedAmountMinor,
    status: adviceAgreesWithApproval
      ? ("CONFIRMED" as const)
      : ("REQUIRES_RECONCILIATION" as const),
  };
}

export function validateSupplierAdviceAmendment(
  args: AmendSupplierDisbursementAdviceInput,
) {
  assertValidMinorAmount(args.disbursedAmountMinor, "disbursed amount");
  if (args.disbursedAmountMinor <= 0) {
    throw new ConvexError("Disbursement amount must be positive.");
  }
  const reason = args.reason.trim();
  if (reason.length < 10) {
    throw new ConvexError(
      "Say why the recorded advice was wrong. This amendment changes evidence about a payment somebody else made, and the reason is the only account of it.",
    );
  }
  // Same validation as recording one: this field is operator-supplied and
  // Convex stores a NaN as a `v.number()` without complaint.
  if (args.disbursedAt !== undefined) {
    if (!Number.isSafeInteger(args.disbursedAt) || args.disbursedAt <= 0) {
      throw new ConvexError("That disbursement date is not a valid date.");
    }
    if (args.disbursedAt > Date.now()) {
      throw new ConvexError("The disbursement date cannot be in the future.");
    }
  }
  return reason;
}

type AmendSupplierDisbursementAdviceInput = {
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  disbursedAmountMinor: number;
  reference?: string;
  clearReference?: boolean;
  disbursedAt?: number;
  reason: string;
  idempotencyKey: string;
};

/**
 * Corrects a settlement advice that was recorded wrongly.
 *
 * This is the ONLY thing on a finalized direct deal that may be restated, and
 * the boundary is deliberate. The advice is the dealership's transcription of a
 * document from someone else, so a mistyped cheque number or amount is an error
 * in the transcription and correcting it makes the record more true.
 *
 * The approved purchase amount is not in that category and is not touched here.
 * It is the frozen basis the supplier claim, the agency revenue, the
 * salesperson's commission and the reports were all measured from. Editing it
 * after finalization would move a number those four already depend on without
 * moving any of them, which is strictly more dangerous than leaving a deal in
 * `REQUIRES_RECONCILIATION` until a human decides what actually happened. If
 * the approval on file really was wrong, the answer is a financial correction
 * against a closed sale in which every dependent figure moves together — not
 * this mutation.
 *
 * Amending re-evaluates the advice against the approval, so a correction that
 * makes the two agree clears the flag, and one that does not leaves it standing.
 * The reconciliation state is derived from the evidence every time rather than
 * being something an operator can set.
 */
/** The corrected amount from the advice. */
/**
 * Remove the recorded reference outright.
 *
 * Separate from omitting `reference`, which means "not part of this
 * correction". Without this there is no way to say "the advice carries no
 * cheque number" — a cleared form field arrives as `undefined`, identical
 * to silence, so the wrong reference survived while the operator was told
 * the correction had been saved.
 */
/**
 * Why the recorded advice was wrong. Required, and stored on the audit
 * record: an amendment with no stated cause is indistinguishable from
 * someone making the discrepancy go away.
 */
// Deliberately stricter than recording the advice. Recording is routine
// back-office work; overwriting a record of somebody else's payment is not,
// and MANAGE_FINANCE is the permission the default templates give to the
// roles that answer for the deal rather than the ones that key it in.
export async function executeAmendSupplierDisbursementAdvice(
  ctx: MutationCtx,
  args: AmendSupplierDisbursementAdviceInput,
  user: Doc<"users">,
  reason: string,
) {
  const app = await ctx.db.get(args.applicationId);
  if (!app || app.orgId !== args.orgId)
    throw new ConvexError("Application not found.");
  if (app.supplierDisbursementConfirmedAt === undefined) {
    throw new ConvexError(
      "There is no recorded settlement advice on this deal to amend. Record what the company paid the supplier first.",
    );
  }
  if (app.approvedDealerPurchaseAmountMinor === undefined) {
    throw new ConvexError(
      "This deal has no approved purchase amount recorded, so there is nothing to check the corrected advice against.",
    );
  }

  const previous = {
    supplierDisbursedAmountMinor: app.supplierDisbursedAmountMinor ?? null,
    supplierDisbursementReference: app.supplierDisbursementReference ?? null,
    supplierDisbursementConfirmedAt: app.supplierDisbursementConfirmedAt,
    supplierDisbursementStatus: app.supplierDisbursementStatus ?? "CONFIRMED",
  };

  const approvedAtRecordingMinor = app.approvedDealerPurchaseAmountMinor;
  const agrees = args.disbursedAmountMinor === approvedAtRecordingMinor;
  const confirmedAt = args.disbursedAt ?? app.supplierDisbursementConfirmedAt;

  // Three distinct instructions, told apart explicitly.
  //
  // Omitted means "not part of this correction", never "clear it".
  // Convex removes a field patched with `undefined`, so passing the
  // argument straight through DELETED the cheque number whenever the
  // caller did not resend it — on an amount-only correction, which is the
  // common case, and on the one path whose whole purpose is to keep the
  // evidence about somebody else's payment straight.
  //
  // But that left no way to say "this reference was never on the advice".
  // A cleared field arrived as `undefined`, indistinguishable from
  // silence, so the operator was told the correction succeeded while the
  // wrong cheque number survived — and the audit below recorded `null`,
  // asserting a removal that did not happen. On a record whose entire job
  // is to state what somebody else's document said, an audit entry that
  // contradicts the stored value is worse than the refused edit.
  const effectiveReference = args.clearReference
    ? undefined
    : (args.reference ?? app.supplierDisbursementReference);

  await ctx.db.patch(args.applicationId, {
    supplierDisbursedAmountMinor: args.disbursedAmountMinor,
    supplierDisbursementReference: effectiveReference,
    supplierDisbursementConfirmedAt: confirmedAt,
    supplierDisbursementConfirmedBy: user._id,
    supplierDisbursementStatus: agrees
      ? ("CONFIRMED" as const)
      : ("REQUIRES_RECONCILIATION" as const),
    // Cleared when it no longer applies rather than left behind, so the
    // frozen approval never outlives the discrepancy it was recording.
    supplierDisbursementApprovedAtRecordingMinor: agrees
      ? undefined
      : approvedAtRecordingMinor,
    updatedAt: Date.now(),
  });

  await auditLog(ctx, {
    orgId: args.orgId,
    actorId: user._id,
    actionType: "AMEND_SUPPLIER_DISBURSEMENT_ADVICE",
    resourceType: "financeApplications",
    resourceId: args.applicationId,
    description: `Settlement advice corrected to ${args.disbursedAmountMinor} minor units${args.clearReference ? " (reference removed)" : args.reference ? ` (ref ${args.reference})` : ""}. Reason: ${reason}. The approved purchase amount (${approvedAtRecordingMinor}) and the supplier claim raised against it are unchanged.`,
    before: previous,
    after: {
      supplierDisbursedAmountMinor: args.disbursedAmountMinor,
      // What was actually persisted, not what was passed in. These two
      // disagreed on exactly the case the operator cares about.
      supplierDisbursementReference: effectiveReference ?? null,
      supplierDisbursementConfirmedAt: confirmedAt,
      supplierDisbursementStatus: agrees
        ? "CONFIRMED"
        : "REQUIRES_RECONCILIATION",
    },
    idempotencyKey: args.idempotencyKey,
  });

  return {
    disbursedAmountMinor: args.disbursedAmountMinor,
    status: agrees
      ? ("CONFIRMED" as const)
      : ("REQUIRES_RECONCILIATION" as const),
  };
}
