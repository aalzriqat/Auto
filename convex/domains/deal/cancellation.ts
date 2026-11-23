import { ConvexError, type Infer } from "convex/values";
import { type MutationCtx, type QueryCtx } from "../../_generated/server";
import { type Id } from "../../_generated/dataModel";
import { requireTenantAuth, type TenantAuthContext } from "../../utils/tenancy";
import { cancelAuthorityFor, isSystemOwnerRole } from "../../utils/permissions";
import { throwAppError, AppErrorCode } from "../../utils/errors";
import {
  assertNoActiveDealUnwind,
  paidDealReversalRoute,
} from "../../utils/dealUnwindGuard";
import { DEAL_UNWIND_MESSAGES } from "../../utils/dealUnwindMessages";
import { notifyManagers, getActorName } from "../../utils/notifications";
import { releaseHoldForApplicationQuote } from "../../utils/depositHelpers";
import { assertNoPendingDepositRequest } from "../../utils/depositRequestGuards";
import {
  isForwardPlanVersion,
  planVersionOf,
} from "../../utils/financedSalePostingPlan";
import {
  FORWARD_VERSIONS_ONLY,
  deriveForwardState,
  forwardCancelRefusal,
} from "../../utils/financeCompanyForward";
import { loadCustodyRecords } from "../../utils/settlementDeductions";
import {
  defaultAppraisalFeeResponsibility,
  feeResponsibilityValidator,
  financingFailureReasonValidator,
} from "../../utils/financingEconomics";
import {
  releaseRootsForApplicationQuote,
  resolveLinkedChequesForCancellation,
  cancelClosedApplicationTeardown,
  closeOutCancelledApplication,
} from "./cancellationTeardown";

type CancelApplicationInput = {
  orgId: Id<"organizations">;
  applicationId: Id<"financeApplications">;
  reason?: string;
  failureReason?: Infer<typeof financingFailureReasonValidator>;
  failureNotes?: string;
  appraisalFeeResponsibility?: Infer<typeof feeResponsibilityValidator>;
  appraisalFeeResponsibilityReason?: string;
  idempotencyKey: string;
};

// SCRUM-413 D-b: the entry gate is status-sensitive, but the status is not
// known until the application is loaded inside the idempotent body. So the
// entry admits EITHER holder (CREATE for every status but CLOSED;
// CANCEL_CLOSED for CLOSED), and the body then requires the one that
// matches the loaded status. A replay is keyed by org + operation + key,
// not by actor, so this entry gate is what bounds who may be served one.
// Neither holder: surface the original (CREATE) refusal unchanged.
export async function executeCancelApplication(
  ctx: MutationCtx,
  args: CancelApplicationInput,
  auth: TenantAuthContext,
  createRefusal: unknown,
  releaseRootIfNoLiveBasis: (
    ctx: MutationCtx,
    args: {
      orgId: Id<"organizations">;
      vehicleId: Id<"vehicles">;
      reason: string;
      decisionNow: number;
    },
  ) => Promise<void>,
  assertNoActiveAllocations: (
    ctx: QueryCtx | MutationCtx,
    receivableDocumentId: Id<"receivableDocuments">,
  ) => Promise<void>,
) {
  const app = await ctx.db.get(args.applicationId);
  if (!app || app.orgId !== args.orgId) {
    throw new ConvexError("Application not found");
  }

  // SCRUM-413 D-b: the authority this status needs. CLOSED takes
  // CANCEL_CLOSED and deliberately NOT CREATE (reversing a closed deal is
  // its own authority); every other status, including a fresh key against
  // an already-CANCELLED application, takes CREATE.
  const authority = cancelAuthorityFor(app.status, planVersionOf(app));
  if (app.status === "CLOSED") {
    // The entry gate already loaded and validated the caller's role, so
    // this is an in-memory check that refuses exactly as requireTenantAuth.
    const missing = authority[0].filter(
      (permission) => !auth.role.permissions.includes(permission),
    );
    if (missing.length > 0 && !isSystemOwnerRole(auth.role)) {
      throwAppError(
        AppErrorCode.FORBIDDEN,
        `Forbidden: Missing required permissions: ${missing.join(", ")}`,
      );
    }
  } else if (createRefusal !== null) {
    throw createRefusal;
  }

  if (app.status === "CANCELLED") {
    // A deal that was finalized and then reversed (unwind or closed-deal cancel) had its deposit holds
    // deliberately reinstated by the teardown, pending a refund-or-forfeit decision (SCRUM-712). A repeated
    // cancel must not release them: only the deposit decision does.
    if (app.finalizedSaleId !== undefined) return;
    await releaseHoldForApplicationQuote(ctx, {
      quoteId: app.quoteId,
      actorId: auth.user._id,
    });
    await releaseRootsForApplicationQuote(
      ctx,
      {
        orgId: args.orgId,
        quoteId: app.quoteId,
        decisionNow: Date.now(),
        reason: "finance application cancelled",
      },
      releaseRootIfNoLiveBasis,
    );
    return;
  }

  // SCRUM-693: an unwind in progress owns the deal's ending; finish or
  // abandon it first. After the replay above, so a finished unwind's
  // CANCELLED deal still answers a retried cancel.
  await assertNoActiveDealUnwind(ctx, args.orgId, args.applicationId);

  // SCRUM-444 DA-03: cancelling ends the deal, and a deposit request still
  // waiting on it would be orphaned. After the already-cancelled replay
  // above, so a retry of a cancellation that succeeded is not refused.
  await assertNoPendingDepositRequest(ctx, {
    orgId: args.orgId,
    quoteId: app.quoteId,
    action: "cancel this application",
  });

  // Cash in an employee's pocket does not stop being there because the
  // deal did. An OPEN custody record is refused here rather than
  // silently orphaned on a CANCELLED deal nothing offers actions on:
  // settle it (return / reimburse / reconcile / write off) first. A
  // CLOSED custody record is left exactly as it is — the costs the
  // employee really paid stay posted; cancelling a deal erases nothing
  // that was spent.
  const openCustody = (
    await loadCustodyRecords(
      ctx,
      args.applicationId,
      "cancelling this application",
    )
  ).find((row) => row.status === "OPEN");
  if (openCustody) {
    throw new ConvexError(
      "An employee still holds cash custody on this deal. Settle that custody record (return the balance, reimburse what is owed, then reconcile or write it off) before cancelling the application.",
    );
  }

  // Reversing an already-APPROVED decision is more sensitive than voiding
  // a draft/in-review one, so require the same permission used to approve.
  if (app.status === "APPROVED") {
    await requireTenantAuth(ctx, args.orgId, authority[1]);
  }

  // SCRUM-447 D4: resolve linked finance-company cheques before any other
  // write (HELD -> CANCELLED; DEPOSITED refused; terminal rows skipped).
  await resolveLinkedChequesForCancellation(
    ctx,
    app,
    auth.user._id,
    args.reason?.trim() || "Finance application cancelled",
    Date.now(),
  );

  const reason = args.reason ?? "Finance application cancelled";
  // SCRUM-121A-PRE §5.2 — the stored cancellation reason is never blank.
  // `args.reason` is an optional STRING, so `??` only catches undefined:
  // an empty or whitespace-only string passed straight through and became
  // a cancelledAt/cancelledBy pair with no reason beside it, which is the
  // one field of that trio a human actually reads.
  //
  // Deliberately a separate constant rather than a change to `reason`
  // above: `reason` also feeds the sale reversal, the commission void and
  // the teardown, and this stage is authorized for the finance-receivable
  // cancellation slice only.
  const cancellationReason =
    args.reason?.trim() || "Finance application cancelled";
  const now = Date.now();

  if (app.status === "CLOSED") {
    // SCRUM-435 (v2 deals only; v1 is unchanged): the deal has payments the
    // finance company holds, so a manager cancels it - never sales or an
    // accountant alone - and only when the forward proof allows it.
    if (isForwardPlanVersion(planVersionOf(app))) {
      try {
        await requireTenantAuth(ctx, args.orgId, authority[1]);
      } catch {
        throw new ConvexError("A manager cancels a finalized deal.");
      }
    }

    // SCRUM-693: a paid deal is reversed through Unwind deal on the deal
    // page (dealUnwind.ts), never by a bare cancel. Ahead of the forward
    // refusal: the unwind returns the forward itself, so it is the one
    // instruction that leads somewhere.
    // A v1 deal cannot be unwound, so it keeps the manual-correction
    // refusal; so does a cheque deal or one whose receipt records
    // disagree (F2), which the unwind would refuse anyway.
    if (app.disbursedAt) {
      if (
        isForwardPlanVersion(planVersionOf(app)) &&
        (await paidDealReversalRoute(ctx, app)).route === "UNWIND"
      ) {
        throwAppError(
          AppErrorCode.DEAL_CANCEL_USE_UNWIND,
          DEAL_UNWIND_MESSAGES.DEAL_CANCEL_USE_UNWIND,
        );
      }
      throw new ConvexError(
        "Disbursement has already been confirmed for this deal — funds have been received from the finance company. " +
          "This can't be auto-reversed from here; void it through a manual accounting correction instead.",
      );
    }
    if (isForwardPlanVersion(planVersionOf(app))) {
      const forwardBlock = forwardCancelRefusal(
        await deriveForwardState(ctx, app),
      );
      if (forwardBlock !== null)
        throwAppError(forwardBlock.code, forwardBlock.message);
    }

    // The direct route's mirror of the refusal above, and NOT the same
    // fact as the supplier-receipt refusal inside
    // `cancelSupplierReceivablesForSale`. That one fires when the supplier
    // has paid the DEALERSHIP its margin; this fires when the finance
    // company has paid the SUPPLIER. A deal where the company has paid but
    // the supplier has not yet remitted passed every guard and cancelled
    // cleanly — reversing the sale, cancelling the margin claim, and
    // returning a financed, paid-for, already-handed-over car to sellable
    // inventory while the dealership silently wrote off a margin it is
    // still owed. Handover is a precondition of finalization, so the
    // customer always has the car by this point.
    //
    // Widened to any recorded advice, matching the guard on
    // `sales.update`. A mismatched advice is a question about how much the
    // supplier was paid, never about whether — and the version of this
    // check that only looked at the timestamp let a deal whose advice had
    // been rejected cancel as though the company had never paid.
    if (
      app.supplierDisbursementConfirmedAt !== undefined ||
      app.supplierDisbursedAmountMinor !== undefined
    ) {
      throw new ConvexError(
        app.supplierDisbursementStatus === "REQUIRES_RECONCILIATION"
          ? "The finance company has already paid the supplier on this deal, and the recorded advice does not agree with the approved amount. Cancelling would reverse a sale that has been funded while that disagreement is still unresolved — settle what was actually paid first, then unwind it with the company and record a manual accounting correction."
          : "The finance company has already paid the supplier on this deal. That payment is between the company and the supplier and can't be reversed from here — unwind it with them and record a manual accounting correction instead.",
      );
    }

    await cancelClosedApplicationTeardown(
      ctx,
      {
        app,
        actorId: auth.user._id,
        reason,
        cancellationReason,
        now,
      },
      assertNoActiveAllocations,
    );
  } else {
    // SCRUM-411 P2-01: the payment to the finance company is recorded BEFORE
    // finalizing, so a deal not yet finalized can already hold one. Cancelling
    // would strand it on the books with no sale to clear it against; the payment
    // is taken back (or reported returned) first, by the same proof as above.
    if (app.finalizedSaleId === undefined) {
      const forwardBlock = forwardCancelRefusal(
        await deriveForwardState(ctx, app, FORWARD_VERSIONS_ONLY),
      );
      if (forwardBlock !== null)
        throwAppError(forwardBlock.code, forwardBlock.message);
    }
    await releaseHoldForApplicationQuote(ctx, {
      quoteId: app.quoteId,
      actorId: auth.user._id,
    });
  }

  await closeOutCancelledApplication(
    ctx,
    {
      app,
      actorId: auth.user._id,
      now,
      cancellationReason,
      note: args.reason,
      failurePatch: args.failureReason
        ? {
            failureReason: args.failureReason,
            failureNotes: args.failureNotes ?? cancellationReason,
            failedAt: now,
            failedBy: auth.user._id,
            appraisalFeeResponsibility:
              args.appraisalFeeResponsibility ??
              defaultAppraisalFeeResponsibility(args.failureReason),
            appraisalFeeResponsibilityReason:
              args.appraisalFeeResponsibilityReason,
          }
        : {},
    },
    releaseRootIfNoLiveBasis,
  );

  const actorName = await getActorName(ctx);
  const customer = await ctx.db.get(app.customerId);
  await notifyManagers(
    ctx,
    args.orgId,
    "application.cancelled",
    {
      actorName,
      customerName: customer
        ? `${customer.firstName} ${customer.lastName}`
        : "Unknown",
    },
    { link: `/${args.orgId}/applications`, excludeUserId: auth.user._id },
  );
}
