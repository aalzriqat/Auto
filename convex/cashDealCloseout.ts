import { ConvexError, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { mutation } from "./functions";
import { writeAuditLog } from "./utils/auditLog";
import { cashCloseoutApplies, dealModeOf, dealSettlesDirect } from "./utils/financedSaleRecognition";
import { isSystemOwnerRole, PERMISSIONS } from "./utils/permissions";
import { loadActiveFees, loadCustodyRecords } from "./utils/settlementDeductions";
import { requireOwnedRow, requireTenantAuth } from "./utils/tenancy";
import { isDealerBorneFee } from "./utils/feeSummary";

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

export const getNoCostCloseout = query({
  args: { orgId: v.id("organizations"), applicationId: v.id("financeApplications") },
  returns: v.union(v.null(), v.object({
    state: v.union(v.literal("UNDECLARED"), v.literal("AWAITING_APPROVAL")),
    canDeclare: v.boolean(),
    confirmVersion: v.optional(v.number()),
  })),
  handler: async (ctx, { orgId, applicationId }) => {
    const { user, membership, role } = await requireTenantAuth(ctx, orgId);
    const owner = isSystemOwnerRole(role);
    const canCreate = owner || role.permissions.includes(PERMISSIONS.CREATE_FINANCE_APPLICATION);
    const canApprove = owner || role.permissions.includes(PERMISSIONS.APPROVE_REQUESTS);
    if (membership.impersonationGrantId || (!canCreate && !canApprove)) return null;

    const app = await requireOwnedRow(ctx, orgId, "financeApplications", applicationId);
    const salesperson = canCreate && user._id === app.salespersonId;
    const approver = canApprove && user._id !== app.salespersonId;
    if ((!salesperson && !approver) || !(await isOpenCashDeal(ctx, app))) return null;

    const [fees, custody] = await Promise.all([
      loadActiveFees(ctx, app._id),
      loadCustodyRecords(ctx, app._id, "reading no-cost closeout"),
    ]);
    if (fees.some(isDealerBorneFee) || custody.some((row) => row.orgId !== orgId) ||
      (approver && isCustodian(app, custody, user._id))) return null;
    const declaration = app.cashNoCostCloseout;
    const current = declaration && !declaration.invalidated && declaration.declaredBy === app.salespersonId
      ? declaration
      : null;
    if (current?.confirmation) return null;
    return {
      state: current ? "AWAITING_APPROVAL" as const : "UNDECLARED" as const,
      canDeclare: salesperson && !current,
      confirmVersion: approver ? current?.version : undefined,
    };
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
