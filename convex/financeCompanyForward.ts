import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { mutation } from "./functions";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { runWithIdempotency } from "./utils/idempotency";
import { PERMISSIONS } from "./utils/permissions";
import { disbursementAccountKey } from "./accounting/postingRules";
import { hookFinanceCompanyForwardPaid, hookFinanceCompanyForwardReversed } from "./accounting/workflowHooks";
import { checkPostingAllowed } from "./accountingPeriods";
import { directPaymentMethodValidator } from "./utils/handoverCostPayment";
import { isMinorAmount } from "./utils/financingEconomics";
import { resolveDealCurrency } from "./utils/settlementDeductions";
import { MAX_DIRECT_PAYMENT_REFERENCE_CHARS } from "./utils/feeDocLimits";
import { planVersionOf } from "./utils/financedSalePostingPlan";
import { manualPayerOf } from "./utils/manualFinancePayer";
import {
  MAX_FORWARD_VERSIONS,
  deriveForwardState,
  forwardReversalKey,
  type ForwardProof,
} from "./utils/financeCompanyForward";

/**
 * SCRUM-435 - the three commands that move the customer's deposit and the
 * dealership's own contribution to the finance company.
 *
 * Only a person holding CONFIRM_FINANCE_DISBURSEMENT and VIEW_FINANCE moves the
 * money (R1): the amount is never typed - it is the frozen figure the finalized
 * plan carries, and the caller must pin the amount they SAW. Every refusal names
 * who acts next and never echoes the deposit or the contribution.
 */

const APPLICATION_NOT_FOUND = "Finance application not found in this organization.";
const NEEDS_FORWARD_PERMS = [PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT, PERMISSIONS.VIEW_FINANCE];
export const CLOSED_PERIOD_REFUSAL =
  "This payment was made in a closed accounting period. An accountant must record it as a prior-period correction.";
const MAX_REASON_CHARS = 500;

function assertRealTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConvexError(`${label} must be a real date. Nothing has been recorded.`);
  }
}

function cleanReason(raw: string): string {
  const reason = raw.trim();
  if (reason.length === 0) {
    throw new ConvexError("A reason is required. Say why the payment is being taken back. Nothing has been changed.");
  }
  if (reason.length > MAX_REASON_CHARS) {
    throw new ConvexError(`The reason is too long (the most is ${MAX_REASON_CHARS} characters). Shorten it and try again. Nothing has been changed.`);
  }
  return reason;
}

async function loadV2Application(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  applicationId: Id<"financeApplications">
): Promise<Doc<"financeApplications">> {
  const app = await requireOwnedRow(ctx, orgId, "financeApplications", applicationId, APPLICATION_NOT_FOUND);
  if (planVersionOf(app) !== 2) {
    throw new ConvexError(
      "This deal was finalized before the finance-company forward step existed, so there is nothing to record here. Continue with the transfer confirmation."
    );
  }
  return app;
}

async function loadForwardRow(
  ctx: MutationCtx,
  app: Doc<"financeApplications">,
  forwardId: Id<"financeCompanyForwards">
): Promise<Doc<"financeCompanyForwards">> {
  const row = await requireOwnedRow(ctx, app.orgId, "financeCompanyForwards", forwardId, "Forward record not found in this organization.");
  if (row.applicationId !== app._id) {
    throw new ConvexError("That payment record belongs to a different deal. Nothing has been changed.");
  }
  return row;
}

function findOnBooks(proof: ForwardProof, forwardId: Id<"financeCompanyForwards">) {
  return proof.versions.find((version) => version.forwardId === forwardId);
}

/**
 * Records that the dealership paid the deposit and the contribution to the
 * finance company. Posts Dr AP-Finance / Cr cash-or-bank, dated at the true
 * `paidAt` when its period is open; a closed period is refused for an
 * accountant's prior-period correction.
 */
export const recordFinanceCompanyForward = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    method: directPaymentMethodValidator,
    paidAt: v.number(),
    /** The total the payer SAW and pinned; the payment posts only when it is still the amount due. */
    expectedAmountMinor: v.number(),
    reference: v.optional(v.string()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, NEEDS_FORWARD_PERMS);
    const app = await loadV2Application(ctx, args.orgId, args.applicationId);
    if (!isMinorAmount(args.expectedAmountMinor)) {
      throw new ConvexError("The amount must be a whole number of minor units. Nothing has been recorded.");
    }
    assertRealTimestamp(args.paidAt, "The paid date");
    const now = Date.now();
    if (args.paidAt > now) throw new ConvexError("The paid date cannot be in the future. Nothing has been recorded.");
    const reference = args.reference?.trim() || undefined;
    if (reference !== undefined && reference.length > MAX_DIRECT_PAYMENT_REFERENCE_CHARS) {
      throw new ConvexError(`The payment reference is too long (the most is ${MAX_DIRECT_PAYMENT_REFERENCE_CHARS} characters). Shorten it and try again. Nothing has been recorded.`);
    }

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "financeCompanyForward.recordFinanceCompanyForward",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: auth.user._id,
        fingerprint: JSON.stringify({
          applicationId: args.applicationId,
          method: args.method,
          paidAt: args.paidAt,
          reference: reference ?? null,
          expectedAmountMinor: args.expectedAmountMinor,
        }),
      },
      async () => {
        // Judged inside the section: a replay returns the first result even if
        // the deal has moved on since.
        if (app.status !== "CLOSED") {
          throw new ConvexError("The deal must be finalized before the payment to the finance company is recorded. A manager finalizes the deal first.");
        }
        const proof = await deriveForwardState(ctx, app);
        // After the transfer the ONLY payment that may still be recorded is the
        // replacement for one the finance company sent back: the amount owed is
        // due again and nothing else can clear it.
        if (app.disbursedAt !== undefined && !(proof.returnedExceptionOpen && proof.state === "DUE")) {
          throw new ConvexError("The finance company's transfer is already confirmed, so this payment can no longer be recorded here. A manager reviews the deal.");
        }
        if (proof.state !== "DUE") {
          throw new ConvexError(
            proof.state === "SETTLED"
              ? "The payment to the finance company is already recorded. Continue with the transfer confirmation."
              : proof.state === "NOT_DUE"
                ? "Nothing is owed to the finance company on this deal."
                : "An earlier payment record on this deal is not settled on the books. An accountant resolves it before another is recorded."
          );
        }
        if (proof.dueMinor !== args.expectedAmountMinor) {
          throw new ConvexError("The amount due changed since you opened the form. Review the deal and record the payment again. Nothing has been recorded.");
        }
        const version = proof.versions.length + 1;
        if (version > MAX_FORWARD_VERSIONS) {
          throw new ConvexError("This deal has been paid and taken back too many times. An accountant reviews the deal. Nothing has been recorded.");
        }
        const currency = await resolveDealCurrency(ctx, app, "recording this payment");
        // SCRUM-27: exactly ONE payer identity - the configured company, or the
        // manual company's name frozen on the application. Neither is refused.
        const manualPayer = manualPayerOf(app);
        if (app.companyId === undefined && manualPayer === null) {
          throw new ConvexError("This deal has no finance company. Nothing has been recorded.");
        }
        const payerIdentity =
          app.companyId !== undefined
            ? { financeCompanyId: app.companyId }
            : { payerNameSnapshot: manualPayer!.name };
        const allowed = await checkPostingAllowed(ctx, args.orgId, args.paidAt);
        if (!allowed.ok && !allowed.waiting) throw new ConvexError(CLOSED_PERIOD_REFUSAL);

        const forwardId = await ctx.db.insert("financeCompanyForwards", {
          orgId: args.orgId,
          applicationId: app._id,
          ...payerIdentity,
          version,
          amountMinor: proof.dueMinor,
          depositPortionMinor: app.forwardDepositPortionMinor ?? 0,
          contributionPortionMinor: app.forwardContributionPortionMinor ?? 0,
          currency,
          method: args.method,
          paidAt: args.paidAt,
          reference,
          actorId: auth.user._id,
          createdAt: now,
        });
        await hookFinanceCompanyForwardPaid(ctx, {
          orgId: args.orgId,
          applicationId: app._id,
          forwardId,
          ...payerIdentity,
          version,
          amountMinor: proof.dueMinor,
          currency,
          paymentMethod: args.method,
          cashKey: disbursementAccountKey(args.method),
          actorId: auth.user._id,
          occurredAt: args.paidAt,
        });
        return forwardId;
      }
    );
  },
});

async function reverseForward(
  ctx: MutationCtx,
  args: {
    orgId: Id<"organizations">;
    applicationId: Id<"financeApplications">;
    forwardId: Id<"financeCompanyForwards">;
    reason: string;
    kind: "VOID" | "RETURNED";
    actorId: Id<"users">;
  },
  app: Doc<"financeApplications">
): Promise<Id<"financeCompanyForwards">> {
  const row = await loadForwardRow(ctx, app, args.forwardId);
  if (row.reversalRequestedAt !== undefined) {
    throw new ConvexError("This payment is already being taken back. Nothing has been changed.");
  }
  const proof = await deriveForwardState(ctx, app);
  const version = findOnBooks(proof, row._id);
  const allowed = args.kind === "RETURNED" ? ["ON_BOOKS"] : ["ON_BOOKS", "POSTING_PENDING", "POSTING_FAILED"];
  if (version === undefined || !allowed.includes(version.state)) {
    throw new ConvexError(
      args.kind === "RETURNED"
        ? "Only a payment that is on the books can be reported as returned by the finance company. An accountant reviews the deal."
        : "Only a payment that is recorded and not yet reversed can be taken back. An accountant reviews the deal."
    );
  }
  const now = Date.now();
  await ctx.db.patch(row._id, {
    reversalRequestedAt: now,
    reversalIdempotencyKey: forwardReversalKey(app._id, row.version),
    reversalKind: args.kind,
    reverseReason: args.reason,
    reversalActorId: args.actorId,
  });
  const outcome = await hookFinanceCompanyForwardReversed(ctx, {
    orgId: args.orgId,
    applicationId: app._id,
    forwardId: row._id,
    version: row.version,
    reason: args.reason,
    actorId: args.actorId,
    // A late reversal posts on the first open day; the actual date stays on the row.
    reversalDate: now,
  });
  if (outcome === "REVERSED" || outcome === "NOT_POSTED") {
    await ctx.db.patch(row._id, { reversedAt: now });
  }
  return row._id;
}

/**
 * Takes a payment back BEFORE the finance company's transfer is confirmed
 * (recorded in error). Reason required. A queued, never-posted payment is simply
 * cancelled.
 */
export const reverseFinanceCompanyForward = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    forwardId: v.id("financeCompanyForwards"),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, NEEDS_FORWARD_PERMS);
    const app = await loadV2Application(ctx, args.orgId, args.applicationId);
    const reason = cleanReason(args.reason);
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "financeCompanyForward.reverseFinanceCompanyForward",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: auth.user._id,
        fingerprint: JSON.stringify({ applicationId: args.applicationId, forwardId: args.forwardId, reason }),
      },
      async () => {
        if (app.disbursedAt !== undefined) {
          throw new ConvexError("The finance company's transfer is already confirmed. If the finance company returned the money, report it as returned instead.");
        }
        return await reverseForward(
          ctx,
          { orgId: args.orgId, applicationId: args.applicationId, forwardId: args.forwardId, reason, kind: "VOID", actorId: auth.user._id },
          app
        );
      }
    );
  },
});

/**
 * The finance company sent the payment back - before or after the transfer. The
 * forward is reversed on the books and the deal is due again; a CLOSED deal may
 * then be cancelled, or a replacement payment recorded.
 */
export const reportFinanceCompanyForwardReturned = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    forwardId: v.id("financeCompanyForwards"),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, NEEDS_FORWARD_PERMS);
    const app = await loadV2Application(ctx, args.orgId, args.applicationId);
    const reason = cleanReason(args.reason);
    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "financeCompanyForward.reportFinanceCompanyForwardReturned",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: auth.user._id,
        fingerprint: JSON.stringify({ applicationId: args.applicationId, forwardId: args.forwardId, reason }),
      },
      async () =>
        await reverseForward(
          ctx,
          { orgId: args.orgId, applicationId: args.applicationId, forwardId: args.forwardId, reason, kind: "RETURNED", actorId: auth.user._id },
          app
        )
    );
  },
});
