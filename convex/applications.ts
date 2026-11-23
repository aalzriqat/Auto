import { economicsStamp, projectApplicationCockpit } from "./domains/deal";
import {
  closeOutCancelledApplication as completeCancelledApplication,
  cancelClosedApplicationTeardown as tearDownClosedApplication,
  executeList,
  executeGet,
  executeCreateFromQuote,
  executeRepairQuoteEconomicsLineage,
  executeUpdateStatus,
  executeCancelApplication,
  executeGetLog,
  executeRegisterVehicleHandover,
  executeRegisterExpectedPayment,
  executeCorrectExpectedPayment,
  executeAttestChequeFace,
  executeSetSupplierSettlementRoute,
  executeGetClosingReadiness,
  prepareFinancedClosing,
  executeFinalizeDeal,
  executeListDisbursementBankOptions,
  readDisbursementVersion,
  executeConfirmDisbursement,
  refuseFinanceReturn,
  validateFinanceReturn,
  executeReturnFinanceDisbursementCheque,
  validateSupplierAdvice,
  executeConfirmSupplierDisbursement,
  validateSupplierAdviceAmendment,
  executeAmendSupplierDisbursementAdvice,
} from "./domains/deal";
import type { TenantAuthContext } from "./utils/tenancy";
export {
  FINANCE_APP_RECEIVABLE_SOURCE,
  pendingDepositResolution,
  resolveSettlement,
} from "./domains/deal";

import {
  acquireVehicle,
  assertAcquirable,
  releaseRootIfNoLiveBasis,
} from "./commitments";
import { v, ConvexError } from "convex/values";
import { assertRt11DoorAllowed } from "./utils/rt11DoorContainment";
import { MutationCtx, query } from "./_generated/server";
import { mutation } from "./functions";

import { paginationOptsValidator } from "convex/server";
import {
  requireTenantAuth,
  requireOwnedRow,
  // The finance-application read boundary (SCRUM-117): an exhaustive
  // allowlist, not a blocklist. Every door that returns one of these rows
  // goes through it.
} from "./utils/tenancy";

import {
  PERMISSIONS,
  isSystemOwnerRole,
  type Permission,
} from "./utils/permissions";

import { throwAppError, AppErrorCode } from "./utils/errors";
import { assertNoActiveDealUnwind } from "./utils/dealUnwindGuard";

import { depositMethodValidator } from "./utils/depositRecording";

import { runWithIdempotency } from "./utils/idempotency";
import {
  registerChequeCore,
  markChequeClearedCore,
  assertNoActiveAllocations,
} from "./collections";

import { assertValidMinorAmount } from "./utils/money";
import {
  feeResponsibilityValidator,
  financingFailureReasonValidator,
} from "./utils/financingEconomics";

// The anomaly verdict, from the module that owns it. Both handover
// confirmations must warn about the same deals; see the helper's own note.
import {
  applySubmittedQuotation,
  approvedAmountIsFarFromEvidenceFor,
  assertQuotationRecordAuthority,
} from "./financingEconomics";

import {
  allocatePaymentToReceivable,
  getReceivableOutstandingMinor,
  reverseAllocation,
  voidCanonicalPayment,
} from "./subledger";

import { consignedSettlementRouteValidator } from "./utils/vehicleOwnership";

export const list = query({
  args: {
    orgId: v.id("organizations"),
    status: v.optional(v.string()), // DRAFT, PENDING_DOCS, etc.
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.VIEW_SALES,
    ]);
    return executeList(ctx, args, role);
  },
});

export const get = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    const { role } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.VIEW_SALES,
    ]);

    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) return null;
    return executeGet(ctx, args, app, role, (app, appraisals, visible) =>
      approvedAmountIsFarFromEvidenceFor(app, appraisals, visible),
    );
  },
});

/**
 * The handover stamp on its own, for a caller who may perform the handover.
 *
 * `dealCockpit` and `applications.get` both authorize on `view:sales`, and a
 * role can hold `register:vehicle_handover` without it. Requiring a stamp those
 * callers had no query to obtain would have dead-ended them exactly as keying
 * the old obligation to `view:finance` dead-ended `confirm:finance_disbursement`
 * — the same defect, one layer down, which is why this exists rather than a
 * note telling operators to open a different screen.
 *
 * Authorized on the permission to ACT, so the ability to obtain the token
 * follows from the ability to use it. It returns the token and nothing else:
 * no figures, no identity, no status.
 */
export const handoverStamp = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.REGISTER_VEHICLE_HANDOVER,
    ]);
    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) return null;
    return economicsStamp(app);
  },
});

export const dealCockpit = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.VIEW_SALES,
    ]);

    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) return null;

    return projectApplicationCockpit(
      ctx,
      app,
      { user, role },
      (app, appraisals, visible) =>
        approvedAmountIsFarFromEvidenceFor(app, appraisals, visible),
      (tx, receivableId) => getReceivableOutstandingMinor(tx, receivableId),
    );
  },
});

export const createFromQuote = mutation({
  args: {
    orgId: v.id("organizations"),
    quoteId: v.id("quotes"),
    adoptReservationId: v.optional(v.id("vehicleReservations")),
    notes: v.optional(v.string()),
    confirmedCalculatedQuotationMinor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CREATE_SALES,
    ]);
    return executeCreateFromQuote(
      ctx,
      args,
      auth,
      (tx, command) => assertAcquirable(tx, command),
      (tx, command) => acquireVehicle(tx, command),
      (role, quotation) => assertQuotationRecordAuthority(role, quotation),
      (tx, command) => applySubmittedQuotation(tx, command),
    );
  },
});

export const repairQuoteEconomicsLineage = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    expectedCurrency: v.string(),
    dryRun: v.boolean(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.MANAGE_FINANCE,
    ]);
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
    );
    const quote = await requireOwnedRow(ctx, args.orgId, "quotes", app.quoteId);
    return executeRepairQuoteEconomicsLineage(ctx, args, app, quote, user);
  },
});

export const updateStatus = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    status: v.union(
      v.literal("DRAFT"),
      v.literal("PENDING_DOCS"),
      v.literal("UNDER_REVIEW"),
      v.literal("APPROVED"),
      v.literal("REJECTED"),
      v.literal("CLOSED"),
    ),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId);
    const hasView =
      isSystemOwnerRole(auth.role) ||
      auth.role.permissions.includes(PERMISSIONS.VIEW_FINANCE_APPLICATIONS);
    if (!hasView) {
      throw new ConvexError("Forbidden: Missing required permissions.");
    }

    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId) {
      throw new ConvexError("Application not found");
    }
    return executeUpdateStatus(
      ctx,
      args,
      app,
      auth,
      () =>
        requireTenantAuth(ctx, args.orgId, [
          PERMISSIONS.REVIEW_FINANCE_APPLICATION,
        ]),
      () =>
        requireTenantAuth(ctx, args.orgId, [
          PERMISSIONS.APPROVE_FINANCE_APPLICATION,
        ]),
      (tx, command) => releaseRootIfNoLiveBasis(tx, command),
    );
  },
});

export const cancelApplication = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    reason: v.optional(v.string()),
    failureReason: v.optional(financingFailureReasonValidator),
    failureNotes: v.optional(v.string()),
    appraisalFeeResponsibility: v.optional(feeResponsibilityValidator),
    appraisalFeeResponsibilityReason: v.optional(v.string()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    let createRefusal: unknown = null;
    let auth: TenantAuthContext;
    try {
      auth = await requireTenantAuth(ctx, args.orgId, [
        PERMISSIONS.CREATE_FINANCE_APPLICATION,
      ]);
    } catch (error) {
      createRefusal = error;
      try {
        auth = await requireTenantAuth(ctx, args.orgId, [
          PERMISSIONS.CANCEL_CLOSED_DEAL,
        ]);
      } catch {
        throw error;
      }
    }

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "applications.cancelApplication",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: auth.user._id,
        fingerprint: JSON.stringify({
          applicationId: args.applicationId,
          reason: args.reason,
          failureReason: args.failureReason,
          appraisalFeeResponsibility: args.appraisalFeeResponsibility,
        }),
      },
      () =>
        executeCancelApplication(
          ctx,
          args,
          auth,
          createRefusal,
          (tx, command) => releaseRootIfNoLiveBasis(tx, command),
          (tx, command) => assertNoActiveAllocations(tx, command),
        ),
    );
  },
});

export const getLog = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [PERMISSIONS.VIEW_SALES]);
    const application = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      "Finance application not found in this organization.",
    );
    return executeGetLog(ctx, args, application);
  },
});

const expectedPaymentMethodValidator = v.union(
  v.literal("CASH"),
  v.literal("INTERNAL_INSTALLMENT"),
  v.literal("CHEQUE"),
  v.literal("BANK_TRANSFER"),
);

export const registerVehicleHandover = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    notes: v.optional(v.string()),
    economicsStamp: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.REGISTER_VEHICLE_HANDOVER,
    ]);
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      "Application not found",
    );
    return executeRegisterVehicleHandover(ctx, args, app, user);
  },
});

export const registerExpectedPayment = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    method: expectedPaymentMethodValidator,
    expectedDate: v.number(),
    chequeDetails: v.optional(
      v.object({
        bank: v.string(),
        chequeNumber: v.string(),
      }),
    ),
    faceAmount: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { user, role } = await requireTenantAuth(ctx, args.orgId);
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      "Application not found",
    );
    await assertNoActiveDealUnwind(ctx, args.orgId, args.applicationId);
    const closedUndisbursed = app.status === "CLOSED" && !app.disbursedAt;
    const allowed: Permission[] = closedUndisbursed
      ? [PERMISSIONS.REGISTER_EXPECTED_PAYMENT, PERMISSIONS.MANAGE_FINANCE]
      : [PERMISSIONS.REGISTER_EXPECTED_PAYMENT];
    if (
      !isSystemOwnerRole(role) &&
      !allowed.some((p) => role.permissions.includes(p))
    ) {
      throwAppError(
        AppErrorCode.FORBIDDEN,
        `Forbidden: Missing required permissions: ${PERMISSIONS.REGISTER_EXPECTED_PAYMENT}`,
      );
    }
    return executeRegisterExpectedPayment(
      ctx,
      args,
      app,
      user,
      closedUndisbursed,
      (tx, command) => registerChequeCore(tx, command),
    );
  },
});

export const correctExpectedPayment = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.MANAGE_FINANCE,
    ]);
    const reason = args.reason.trim();
    if (!reason)
      throw new ConvexError(
        "Give a reason for correcting the expected payment.",
      );

    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      "Application not found",
    );
    return executeCorrectExpectedPayment(
      ctx,
      args,
      app,
      user,
      reason,
      (tx, command) => assertNoActiveAllocations(tx, command),
    );
  },
});

export const attestChequeFace = mutation({
  args: {
    orgId: v.id("organizations"),
    chequeId: v.id("postDatedCheques"),
    faceAmount: v.string(),
    note: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.MANAGE_FINANCE,
    ]);
    return executeAttestChequeFace(ctx, args, user);
  },
});

export const setSupplierSettlementRoute = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    route: consignedSettlementRouteValidator,
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.MANAGE_SUPPLIER_SETTLEMENT,
    ]);

    const app = await ctx.db.get(args.applicationId);
    if (!app || app.orgId !== args.orgId)
      throw new ConvexError("Application not found.");
    return executeSetSupplierSettlementRoute(ctx, args, app, user);
  },
});

export const getClosingReadiness = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.VIEW_FINANCE_APPLICATIONS,
    ]);
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
    );
    return executeGetClosingReadiness(ctx, args, app, auth);
  },
});

export const finalizeDeal = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    depositResolution: v.optional(
      v.object({
        treatment: v.union(
          v.literal("APPLY_TO_DEALER_AMOUNT"),
          v.literal("APPLY_TO_TRANSACTION_SETTLEMENT"),
          v.literal("REFUND_TO_CUSTOMER"),
          v.literal("FORFEITED"),
          v.literal("OTHER"),
        ),
        reason: v.optional(v.string()),
        refundMethod: v.optional(depositMethodValidator),
      }),
    ),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const auth = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const mayReadMoney = await prepareFinancedClosing(ctx, args, auth);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "applications.finalizeDeal",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: auth.user._id,
        fingerprint: JSON.stringify({
          applicationId: args.applicationId,
          depositResolution: args.depositResolution ?? null,
        }),
      },
      () => executeFinalizeDeal(ctx, args, auth, mayReadMoney),
    );
  },
});

export const listDisbursementBankOptions = query({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
  },
  handler: async (ctx, args) => {
    await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const app = await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      "Application not found.",
    );
    return executeListDisbursementBankOptions(ctx, args, app);
  },
});

export const confirmDisbursement = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    disbursedAmountMinor: v.number(),
    idempotencyKey: v.string(),
    expectedDisbursementVersion: v.optional(v.number()),
    bankAccountId: v.optional(v.id("bankAccounts")),
  },
  handler: async (ctx, args) => {
    assertValidMinorAmount(args.disbursedAmountMinor, "disbursed amount");
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);
    const version = await readDisbursementVersion(ctx, args);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "applications.confirmDisbursement",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          applicationId: args.applicationId,
          disbursedAmountMinor: args.disbursedAmountMinor,
          ...(version > 1 ? { disbursementVersion: version } : {}),
          ...(args.bankAccountId ? { bankAccountId: args.bankAccountId } : {}),
        }),
        ...(version > 1
          ? {
              onFingerprintConflict: (): never =>
                refuseFinanceReturn("FINANCE_CONFIRM_STALE_REQUEST"),
            }
          : {}),
      },
      () =>
        executeConfirmDisbursement(
          ctx,
          args,
          user,
          version,
          (tx, command) => markChequeClearedCore(tx, command),
          (tx, command) => allocatePaymentToReceivable(tx, command),
        ),
    );
  },
});

export const returnFinanceDisbursementCheque = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    chequeId: v.id("postDatedCheques"),
    returnReason: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
      PERMISSIONS.VIEW_FINANCE,
    ]);
    const returnReason = validateFinanceReturn(args);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "applications.returnFinanceDisbursementCheque",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          applicationId: args.applicationId,
          chequeId: args.chequeId,
          returnReason,
        }),
        onFingerprintConflict: () =>
          refuseFinanceReturn("FINANCE_RETURN_KEY_CONFLICT"),
      },
      () =>
        executeReturnFinanceDisbursementCheque(
          ctx,
          args,
          user,
          returnReason,
          (tx, command) => reverseAllocation(tx, command),
          (tx, command) => voidCanonicalPayment(tx, command),
        ),
    );
  },
});

export const confirmSupplierDisbursement = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    disbursedAmountMinor: v.number(),
    reference: v.optional(v.string()),
    disbursedAt: v.optional(v.number()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    validateSupplierAdvice(args);
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.CONFIRM_FINANCE_DISBURSEMENT,
    ]);

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "applications.confirmSupplierDisbursement",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          applicationId: args.applicationId,
          disbursedAmountMinor: args.disbursedAmountMinor,
          reference: args.reference ?? null,
          disbursedAt: args.disbursedAt ?? null,
        }),
      },
      () => executeConfirmSupplierDisbursement(ctx, args, user),
    );
  },
});

export const amendSupplierDisbursementAdvice = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    disbursedAmountMinor: v.number(),
    reference: v.optional(v.string()),
    clearReference: v.optional(v.boolean()),
    disbursedAt: v.optional(v.number()),
    reason: v.string(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    const reason = validateSupplierAdviceAmendment(args);
    const { user } = await requireTenantAuth(ctx, args.orgId, [
      PERMISSIONS.MANAGE_FINANCE,
    ]);
    await requireOwnedRow(
      ctx,
      args.orgId,
      "financeApplications",
      args.applicationId,
      "Application not found.",
    );
    assertRt11DoorAllowed("SUPPLIER_ADVICE_AMENDMENT_PILOT_DISABLED");

    return await runWithIdempotency(
      ctx,
      {
        orgId: args.orgId,
        operation: "applications.amendSupplierDisbursementAdvice",
        economic: true,
        idempotencyKey: args.idempotencyKey,
        actorId: user._id,
        fingerprint: JSON.stringify({
          applicationId: args.applicationId,
          disbursedAmountMinor: args.disbursedAmountMinor,
          reference: args.reference ?? null,
          clearReference: args.clearReference ?? false,
          disbursedAt: args.disbursedAt ?? null,
          reason,
        }),
      },
      () => executeAmendSupplierDisbursementAdvice(ctx, args, user, reason),
    );
  },
});
export {
  transferFinancedAmountFromCustomerReceivable,
  resolveLinkedChequesForCancellation,
  prospectiveForwardPlan,
} from "./domains/deal";
export async function closeOutCancelledApplication(
  ctx: MutationCtx,
  args: Parameters<typeof completeCancelledApplication>[1],
): Promise<void> {
  return completeCancelledApplication(ctx, args, (tx, command) =>
    releaseRootIfNoLiveBasis(tx, command),
  );
}

export async function cancelClosedApplicationTeardown(
  ctx: MutationCtx,
  args: Parameters<typeof tearDownClosedApplication>[1],
) {
  return tearDownClosedApplication(ctx, args, (tx, command) =>
    assertNoActiveAllocations(tx, command),
  );
}
