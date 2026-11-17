import { ConvexError, v, type Infer } from "convex/values";
import { paginationOptsValidator, paginationResultValidator } from "convex/server";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import { writeAuditLog } from "./utils/auditLog";
import { cashCloseoutApplies, dealModeOf, dealSettlesDirect } from "./utils/financedSaleRecognition";
import { isSystemOwnerRole, PERMISSIONS } from "./utils/permissions";
import { loadActiveFees, loadCustodyRecords } from "./utils/settlementDeductions";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { isDealerBorneFee } from "./utils/feeSummary";
import { formatDealNumber } from "./utils/dealNumberFormat";

async function isOpenCashDeal(ctx: MutationCtx | QueryCtx, app: Doc<"financeApplications">) {
  if (app.status !== "APPROVED") return false;
  const [settlesDirect, mode] = await Promise.all([dealSettlesDirect(ctx, app), dealModeOf(ctx, app)]);
  return cashCloseoutApplies(app, { settlesDirect, mode });
}

async function requireNoCosts(ctx: MutationCtx, app: Doc<"financeApplications">) {
  if (!(await isOpenCashDeal(ctx, app))) {
    throw new ConvexError("No-cost declarations are only available for eligible cash deals.");
  }
  const fees = await loadActiveFees(ctx, app._id);
  if (fees.some(isDealerBorneFee)) {
    throw new ConvexError("This deal has recorded cost lines. Review the itemized costs before finalizing.");
  }
  const custody = await loadCustodyRecords(ctx, app._id, "checking no-cost closeout");
  if (custody.some((row) => row.orgId !== app.orgId)) {
    throw new ConvexError("This deal's custody records could not be verified.");
  }
  return custody;
}

function isCustodian(
  app: Doc<"financeApplications">,
  custody: ReadonlyArray<Doc<"financeDealCustody">>,
  userId: Id<"users">,
) {
  return app.plannedCustody?.userId === userId || custody.some((record) => record.userId === userId);
}

const cashNoCostAction = v.union(
  v.null(),
  v.object({ state: v.literal("UNDECLARED"), canDeclare: v.boolean() }),
  v.object({ state: v.literal("AWAITING_APPROVAL"), canDeclare: v.literal(false) }),
  v.object({ state: v.literal("AWAITING_APPROVAL"), canDeclare: v.literal(false), confirmVersion: v.number() }),
);

async function noCostAction(
  ctx: QueryCtx,
  app: Doc<"financeApplications">,
  actor: { userId: Id<"users">; canCreate: boolean; canApprove: boolean },
): Promise<Infer<typeof cashNoCostAction>> {
  const salesperson = actor.canCreate && actor.userId === app.salespersonId;
  const approver = actor.canApprove && actor.userId !== app.salespersonId;
  if ((!salesperson && !approver) || !(await isOpenCashDeal(ctx, app))) return null;
  const [fees, custody] = await Promise.all([
    loadActiveFees(ctx, app._id),
    loadCustodyRecords(ctx, app._id, "reading no-cost closeout"),
  ]);
  if (fees.some(isDealerBorneFee) || custody.some((row) => row.orgId !== app.orgId) ||
    (approver && isCustodian(app, custody, actor.userId))) return null;
  const declaration = app.cashNoCostCloseout;
  const current = declaration && !declaration.invalidated && declaration.declaredBy === app.salespersonId
    ? declaration : null;
  if (current?.confirmation) return null;
  if (!current) return { state: "UNDECLARED", canDeclare: salesperson };
  if (!approver) return { state: "AWAITING_APPROVAL", canDeclare: false };
  return { state: "AWAITING_APPROVAL", canDeclare: false, confirmVersion: current.version };
}

const pendingNoCostConfirmation = v.object({
  applicationId: v.id("financeApplications"),
  dealReference: v.string(),
  confirmVersion: v.number(),
});

export const listPendingNoCostConfirmations = query({
  args: { orgId: v.id("organizations"), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(pendingNoCostConfirmation),
  handler: async (ctx, { orgId, paginationOpts }) => {
    const { user, membership } = await requireTenantAuth(ctx, orgId, [PERMISSIONS.APPROVE_REQUESTS]);
    if (membership.impersonationGrantId) return { page: [], isDone: true, continueCursor: "" };
    const result = await ctx.db.query("financeApplications")
      .withIndex("by_org_status", (q) => q.eq("orgId", orgId).eq("status", "APPROVED"))
      .order("desc")
      .paginate({ ...paginationOpts, numItems: Math.min(10, Math.max(1, paginationOpts.numItems)),
        maximumRowsRead: 10, maximumBytesRead: 1_000_000 });
    const candidates = await Promise.all(result.page.map(async (app) => {
      if (!app.cashNoCostCloseout) return null;
      const action = await noCostAction(ctx, app, { userId: user._id, canCreate: false, canApprove: true });
      if (!action || !("confirmVersion" in action)) return null;
      return {
        applicationId: app._id,
        dealReference: formatDealNumber(app.dealNumber) ?? `#${String(app._id).slice(-4)}`,
        confirmVersion: action.confirmVersion,
      };
    }));
    return { ...result, page: candidates.filter((row) => row !== null) };
  },
});

export const getNoCostCloseout = query({
  args: { orgId: v.id("organizations"), applicationId: v.id("financeApplications") },
  returns: cashNoCostAction,
  handler: async (ctx, { orgId, applicationId }): Promise<Infer<typeof cashNoCostAction>> => {
    const { user, membership, role } = await requireTenantAuth(ctx, orgId);
    const owner = isSystemOwnerRole(role);
    const canCreate = owner || role.permissions.includes(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    const canApprove = owner || role.permissions.includes(PERMISSIONS.APPROVE_REQUESTS);
    if (membership.impersonationGrantId || (!canCreate && !canApprove)) return null;

    const app = await requireOwnedRow(ctx, orgId, "financeApplications", applicationId);
    return noCostAction(ctx, app, { userId: user._id, canCreate, canApprove });
  },
});

export const declareNoCosts = mutation({
  args: { orgId: v.id("organizations"), applicationId: v.id("financeApplications") },
  returns: v.number(),
  handler: async (ctx, { orgId, applicationId }) => {
    const { user, membership } = await requireTenantAuth(ctx, orgId, [PERMISSIONS.CREATE_FINANCE_APPLICATION]);
    const app = await requireOwnedRow(ctx, orgId, "financeApplications", applicationId);
    if (membership.impersonationGrantId || user._id !== app.salespersonId) {
      throw new ConvexError("Only the deal's salesperson can declare that it had no costs.");
    }
    await requireNoCosts(ctx, app);

    const previous = app.cashNoCostCloseout;
    if (previous && !previous.invalidated && previous.declaredBy === user._id) return previous.version;
    const version = (previous?.version ?? 0) + 1;
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new ConvexError("This deal's cost closeout version could not be verified.");
    }
    await ctx.db.patch(applicationId, {
      cashNoCostCloseout: { version, declaredBy: user._id, declaredAt: Date.now() },
    });
    await writeAuditLog(ctx, user, {
      action: "DECLARE_CASH_DEAL_NO_COSTS",
      orgId,
      targetTable: "financeApplications",
      targetId: applicationId,
      after: { version },
    });
    return version;
  },
});

export const confirmNoCosts = mutation({
  args: {
    orgId: v.id("organizations"),
    applicationId: v.id("financeApplications"),
    expectedVersion: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, { orgId, applicationId, expectedVersion }) => {
    const { user, membership } = await requireTenantAuth(ctx, orgId, [PERMISSIONS.APPROVE_REQUESTS]);
    const app = await requireOwnedRow(ctx, orgId, "financeApplications", applicationId);
    if (membership.impersonationGrantId || user._id === app.salespersonId) {
      throw new ConvexError("An independent approver must confirm this deal's costs.");
    }
    const custody = await requireNoCosts(ctx, app);

    const declaration = app.cashNoCostCloseout;
    if (!declaration || declaration.invalidated || declaration.version !== expectedVersion ||
      declaration.declaredBy !== app.salespersonId) {
      throw new ConvexError("The no-cost declaration is missing or changed. Ask sales to declare it again.");
    }
    if (isCustodian(app, custody, user._id)) {
      throw new ConvexError("An independent approver must confirm this deal's costs.");
    }
    if (declaration.confirmation) {
      if (declaration.confirmation.by === user._id) return declaration.version;
      throw new ConvexError("This declaration has already been confirmed.");
    }
    await ctx.db.patch(applicationId, {
      cashNoCostCloseout: { ...declaration, confirmation: { by: user._id, at: Date.now() } },
    });
    await writeAuditLog(ctx, user, {
      action: "CONFIRM_CASH_DEAL_NO_COSTS",
      orgId,
      targetTable: "financeApplications",
      targetId: applicationId,
      after: { version: declaration.version },
    });
    return declaration.version;
  },
});
