import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type MutationCtx } from "./_generated/server";
import { mutation } from "./functions";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { runWithIdempotency } from "./utils/idempotency";
import { PERMISSIONS, isSystemOwnerRole } from "./utils/permissions";
import { disbursementAccountKey } from "./accounting/postingRules";
import { hookFinanceCompanyForwardPaid, hookFinanceCompanyForwardReversed } from "./accounting/workflowHooks";
import { checkPostingAllowed } from "./accountingPeriods";
import { directPaymentMethodValidator } from "./utils/handoverCostPayment";
import { isMinorAmount } from "./utils/financingEconomics";
import { resolveDealCurrency } from "./utils/settlementDeductions";
import { MAX_DIRECT_PAYMENT_REFERENCE_CHARS } from "./utils/feeDocLimits";
import { isForwardPlanVersion, planVersionOf } from "./utils/financedSalePostingPlan";
import { manualPayerOf } from "./utils/manualFinancePayer";
import { prospectiveForwardPlan } from "./applications";
import { heldDepositRowsForVehicle } from "./utils/saleCompletion";
import { toMinorUnits } from "./utils/money";
import { mayReadFinanceEconomics } from "./utils/financeApplicationProjection";
import {
  FORWARD_DEPOSIT_PROVENANCE_REFUSAL,
  FORWARD_VERSIONS_ONLY,
  MAX_FORWARD_VERSIONS,
  deriveForwardState,
  forwardCancelRefusal,
  forwardFinalizeBlock,
  forwardReversalKey,
  type ForwardFinalizeBlock,
  type ForwardProof,
} from "./utils/financeCompanyForward";
import { assertNoActiveDealUnwind } from "./utils/dealUnwindGuard";
import { AppErrorCode, throwAppError } from "./utils/errors";

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

/** No sale has been created for the deal, so no plan fields are frozen on it. */
const isUnfinalized = (app: Doc<"financeApplications">): boolean =>
  app.finalizedSaleId === undefined && app.status !== "CLOSED";

/**
 * The finance company's transfer is confirmed: to the dealership (`disbursedAt`) on the through
 * route, or by a supplier advice on file on the direct route. The advice counts by its amount as
 * well as its date, exactly as both cancel paths read it.
 */
const isTransferConfirmed = (app: Doc<"financeApplications">): boolean =>
  app.disbursedAt !== undefined ||
  app.supplierDisbursementConfirmedAt !== undefined ||
  app.supplierDisbursedAmountMinor !== undefined;

async function loadV2Application(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  applicationId: Id<"financeApplications">
): Promise<Doc<"financeApplications">> {
  const app = await requireOwnedRow(ctx, orgId, "financeApplications", applicationId, APPLICATION_NOT_FOUND);
  // SCRUM-411 P2-01: the payment is recorded BEFORE finalizing, when the deal has
  // no frozen plan version yet. Such a deal is judged against the plan finalize
  // would freeze; a deal finalized under an older plan still has nothing to record.
  if (!isUnfinalized(app) && !isForwardPlanVersion(planVersionOf(app))) {
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

/** A deposit has a handful of hold rows on one car at most (re-allocations); more cannot be attributed. */
const MAX_HOLDS_PER_DEPOSIT_VEHICLE = 20;

interface DepositSlice {
  depositId: Id<"deposits">;
  holdId?: Id<"depositVehicleHolds">;
  amountMinor: number;
}

const refuseProvenance = (): never =>
  throwAppError(FORWARD_DEPOSIT_PROVENANCE_REFUSAL.code, FORWARD_DEPOSIT_PROVENANCE_REFUSAL.message);

/**
 * SCRUM-411 P2-02. The deposits (and holds) the deposit part of a forward is made of, read from
 * the SAME rows the plan's H is derived from (`heldDepositRowsForVehicle`), so the payment and
 * the plan cannot disagree about which deposit was paid onward. Immutable once written.
 *
 * Fails closed: a deposit of another organization, a deposit with more than one live hold on the
 * car (the amount cannot be pinned to one), or slices that do not add up to the deposit portion
 * refuse the payment rather than record provenance that is not true. Nothing is owed from a
 * deposit that is refunded or forfeited (H = 0): no slices, nothing is paid onward.
 */
async function depositSlicesFor(
  ctx: MutationCtx,
  app: Doc<"financeApplications">,
  currency: string,
  depositPortionMinor: number
): Promise<DepositSlice[]> {
  if (depositPortionMinor <= 0) return [];
  const slices: DepositSlice[] = [];
  let total = 0;
  for (const row of await heldDepositRowsForVehicle(ctx, app.quoteId, app.vehicleId)) {
    if (row.orgId !== app.orgId) return refuseProvenance();
    const amountMinor = toMinorUnits(row.amount, currency);
    if (amountMinor <= 0) continue;
    const holds = await ctx.db
      .query("depositVehicleHolds")
      .withIndex("by_deposit_vehicle", (q) => q.eq("depositId", row.depositId).eq("vehicleId", app.vehicleId))
      .take(MAX_HOLDS_PER_DEPOSIT_VEHICLE + 1);
    if (holds.length > MAX_HOLDS_PER_DEPOSIT_VEHICLE) return refuseProvenance();
    const liveHolds = holds.filter(
      (hold) => hold.active && (hold.allocationStatus === undefined || hold.allocationStatus === "ALLOCATED")
    );
    if (liveHolds.length > 1) return refuseProvenance();
    slices.push({
      depositId: row.depositId,
      ...(liveHolds[0] === undefined ? {} : { holdId: liveHolds[0]._id }),
      amountMinor,
    });
    total += amountMinor;
  }
  if (total !== depositPortionMinor) return refuseProvenance();
  return slices;
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
        // SCRUM-693: no payment to the finance company while the deal is being unwound.
        await assertNoActiveDealUnwind(ctx, args.orgId, args.applicationId);
        // SCRUM-411 P2-01. Before the sale the deposit and the contribution are
        // judged against the plan finalize WOULD freeze (one derivation, shared with
        // finalize); once CLOSED they are the frozen figures, as before.
        let prospective: { dueMinor: number; fingerprint: string } | undefined;
        let planFingerprint: string | undefined = app.financedSaleRecognitionFingerprint;
        let depositPortionMinor = app.forwardDepositPortionMinor ?? 0;
        let contributionPortionMinor = app.forwardContributionPortionMinor ?? 0;
        if (app.status === "APPROVED" && app.finalizedSaleId === undefined) {
          const plan = await prospectiveForwardPlan(ctx, app, mayReadFinanceEconomics(auth.role));
          if (plan === null) {
            throw new ConvexError("Nothing is owed to the finance company on this deal.");
          }
          prospective = { dueMinor: plan.forwardDueMinor, fingerprint: plan.fingerprint };
          planFingerprint = plan.fingerprint;
          depositPortionMinor = plan.forwardDepositMinor;
          contributionPortionMinor = plan.forwardContributionMinor;
        } else if (app.status !== "CLOSED") {
          throw new ConvexError("The deal must be approved before the payment to the finance company is recorded. Nothing has been recorded.");
        }
        const proof = await deriveForwardState(ctx, app, prospective);
        // After the transfer the ONLY payment that may still be recorded is the
        // replacement for one the finance company sent back: the amount owed is
        // due again and nothing else can clear it.
        if (isTransferConfirmed(app) && !(proof.returnedExceptionOpen && proof.state === "DUE")) {
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
        // SCRUM-411 P2-02: before the sale the deposit part of H + D is pinned, deposit by
        // deposit, to the rows the plan was derived from. After the sale (a replacement for a
        // returned payment) the deposit is already consumed into it and nothing is sliced.
        const depositSlices =
          prospective === undefined ? [] : await depositSlicesFor(ctx, app, currency, depositPortionMinor);

        const forwardId = await ctx.db.insert("financeCompanyForwards", {
          orgId: args.orgId,
          applicationId: app._id,
          ...payerIdentity,
          version,
          amountMinor: proof.dueMinor,
          depositPortionMinor,
          contributionPortionMinor,
          ...(planFingerprint === undefined ? {} : { planFingerprint }),
          currency,
          method: args.method,
          paidAt: args.paidAt,
          reference,
          actorId: auth.user._id,
          createdAt: now,
        });
        for (const slice of depositSlices) {
          await ctx.db.insert("financeCompanyForwardSlices", {
            orgId: args.orgId,
            applicationId: app._id,
            forwardId,
            version,
            depositId: slice.depositId,
            ...(slice.holdId === undefined ? {} : { holdId: slice.holdId }),
            vehicleId: app.vehicleId,
            amountMinor: slice.amountMinor,
            currency,
            actorId: auth.user._id,
            createdAt: now,
          });
        }
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

/** Also the forward-return step of a deal unwind (SCRUM-693, `dealUnwind.ts`). */
export async function reverseForward(
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
  // A deal not finalized yet has no frozen plan: list its versions without judging
  // them against one.
  const proof = await deriveForwardState(ctx, app, isUnfinalized(app) ? FORWARD_VERSIONS_ONLY : undefined);
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
        await assertNoActiveDealUnwind(ctx, args.orgId, args.applicationId);
        // On either route, once the transfer is confirmed the showroom's payment was not recorded in error.
        if (isTransferConfirmed(app)) {
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
      async () => {
        // SCRUM-693: an unwind records the return through its own step.
        await assertNoActiveDealUnwind(ctx, args.orgId, args.applicationId);
        return await reverseForward(
          ctx,
          { orgId: args.orgId, applicationId: args.applicationId, forwardId: args.forwardId, reason, kind: "RETURNED", actorId: auth.user._id },
          app
        );
      }
    );
  },
});

/** What the deal screen needs to know about the payment due BEFORE the sale (SCRUM-411 P2-01). */
export type PreFinalizeForwardState =
  | "NOT_READY"
  | "FIRST_PAYMENT_UNFUNDED"
  | "NOT_OWED"
  | "SETTLED"
  | ForwardFinalizeBlock;

const preFinalizeForwardStateValidator = v.union(
  v.literal("NOT_READY"),
  v.literal("FIRST_PAYMENT_UNFUNDED"),
  v.literal("NOT_OWED"),
  v.literal("SETTLED"),
  v.literal("UNPAID"),
  v.literal("STALE"),
  v.literal("POSTING_PENDING"),
  v.literal("POSTING_FAILED"),
  v.literal("REVERSAL_PENDING"),
  v.literal("NEEDS_REPAIR")
);

/**
 * SCRUM-411 P2-01. Whether the deposit and contribution owed to the finance
 * company are on the books for the plan finalize WOULD freeze, for an approved
 * deal that is not finalized yet - the question `finalizeDeal` and
 * `recordFinanceCompanyForward` answer with the SAME derivation
 * (`prospectiveForwardPlan` + `deriveForwardState` + `forwardFinalizeBlock`), so
 * the screen cannot offer a close the server will refuse or hide the payment
 * the server would accept. Read-only; never throws on the deal's own state.
 *
 * `null`: the deal is not an approved, unfinalized one, so this question does not
 * arise (after finalizing, the cockpit's own `forward` block answers it).
 * `NOT_READY`: the plan cannot be formed yet (the deal is not ready to close),
 * so nothing is judged - the closing readiness names what is missing.
 * `FIRST_PAYMENT_UNFUNDED`: the plan is refused because the agreed first payment
 * was founded on a deposit that is no longer applied (SCRUM-411 P2-03); the screen
 * names the next action instead of offering a close that finalize will refuse.
 *
 * STATUS for everyone allowed to read finance applications; the figures ride in
 * `money` only for a caller who may read finance economics (ACC-10), and a
 * withheld figure is `null`, never a zero. `mayRecord` is exactly the permission
 * pair `recordFinanceCompanyForward` requires. `onBooksForwardId` is an id, not
 * an amount: the payment a stale figure obliges someone to take back.
 *
 * SCRUM-411 B1: the payment is named, and `blocksCancel` raised, WHATEVER the plan
 * says - from the versions alone (`FORWARD_VERSIONS_ONLY`, the cancel gate's own
 * proof). A payment whose deposit was later refunded leaves no plan to form, and
 * the operator must still see the payment to take back and not be offered a cancel
 * the server refuses. `planReady: false` skips forming the plan (the deal is not
 * ready to close) and answers only that.
 */
export const preFinalizeForwardStatus = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    planReady: v.optional(v.boolean()),
  },
  returns: v.union(
    v.null(),
    v.object({
      state: preFinalizeForwardStateValidator,
      mayRecord: v.boolean(),
      onBooksForwardId: v.union(v.id("financeCompanyForwards"), v.null()),
      blocksCancel: v.boolean(),
      money: v.union(
        v.null(),
        v.object({
          dueMinor: v.number(),
          depositMinor: v.number(),
          contributionMinor: v.number(),
          onBooksMinor: v.number(),
        })
      ),
    })
  ),
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_FINANCE_APPLICATIONS]);
    const app = await requireOwnedRow(ctx, args.orgId, "financeApplications", args.applicationId, APPLICATION_NOT_FOUND);
    if (app.status !== "APPROVED" || app.finalizedSaleId !== undefined) return null;

    const mayReadMoney = mayReadFinanceEconomics(role);
    const mayRecord =
      isSystemOwnerRole(role) || NEEDS_FORWARD_PERMS.every((permission) => role.permissions.includes(permission));
    const liveProof = await deriveForwardState(ctx, app, FORWARD_VERSIONS_ONLY);
    const status = (
      state: PreFinalizeForwardState,
      proof?: ForwardProof,
      plan?: { forwardDueMinor: number; forwardDepositMinor: number; forwardContributionMinor: number }
    ) => ({
      state,
      mayRecord,
      onBooksForwardId: (proof ?? liveProof).onBooksForwardId,
      blocksCancel: forwardCancelRefusal(liveProof) !== null,
      money:
        mayReadMoney && proof !== undefined && plan !== undefined
          ? {
              dueMinor: plan.forwardDueMinor,
              depositMinor: plan.forwardDepositMinor,
              contributionMinor: plan.forwardContributionMinor,
              onBooksMinor: proof.versions.reduce(
                (sum, version) => (version.state === "ON_BOOKS" ? sum + version.amountMinor : sum),
                0
              ),
            }
          : null,
    });

    if (args.planReady === false) return status("NOT_READY");

    let plan: Awaited<ReturnType<typeof prospectiveForwardPlan>>;
    try {
      plan = await prospectiveForwardPlan(ctx, app, mayReadMoney);
    } catch (error) {
      if (!(error instanceof ConvexError)) throw error;
      // An agreed first payment that nothing funds (its deposit was refunded or forfeited) is a
      // blocker the operator must act on, not a "not ready yet": finalize refuses it too, and
      // there is nothing to pay until it is resolved.
      if ((error.data as { code?: unknown } | null)?.code === AppErrorCode.FIRST_PAYMENT_UNFUNDED) {
        return status("FIRST_PAYMENT_UNFUNDED");
      }
      // Any other refusal to form the plan (not ready to close, ...) is the deal's own state,
      // named by the closing readiness and by finalize itself.
      return status("NOT_READY");
    }
    if (plan === null) return status("NOT_OWED");

    const proof = await deriveForwardState(ctx, app, {
      dueMinor: plan.forwardDueMinor,
      fingerprint: plan.fingerprint,
    });
    const block = forwardFinalizeBlock(proof);
    if (block !== null) return status(block, proof, plan);
    return status(proof.state === "SETTLED" ? "SETTLED" : "NOT_OWED", proof, plan);
  },
});
