import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query, MutationCtx } from "./_generated/server";
import { Id, TableNames } from "./_generated/dataModel";
import { requireSuperAdmin } from "./utils/tenancy";
import { throwAppError, AppErrorCode } from "./utils/errors";
import { logAdminAction } from "./adminAudit";

// Every table that carries an orgId, paired with an index whose first field
// is orgId (sometimes a compound index — Convex allows equality on a prefix
// of an index's fields). Used to fully cascade-delete an organization.
// Table/index names are passed through generic helpers below, which is why
// they're typed loosely here and cast at the call site (see deleteAllByOrg) —
// Convex's Id<TableName> can't be parameterized by a runtime string.
const ORG_SCOPED_TABLES: { table: TableNames; index: string }[] = [
  { table: "roles", index: "by_org" },
  { table: "memberships", index: "by_org" },
  { table: "invitations", index: "by_org" },
  { table: "vehicles", index: "by_org" },
  { table: "vehicleStatusRequests", index: "by_org" },
  { table: "vehicleEdits", index: "by_org" },
  { table: "customers", index: "by_org" },
  { table: "leads", index: "by_org" },
  { table: "sales", index: "by_org" },
  { table: "expenses", index: "by_org" },
  { table: "tasks", index: "by_org" },
  { table: "taskHistory", index: "by_org" },
  { table: "notifications", index: "by_org_user" },
  { table: "test_drives", index: "by_org" },
  { table: "workOrders", index: "by_org" },
  { table: "financeCompanies", index: "by_org" },
  { table: "vehicleValuations", index: "by_org" },
  { table: "guarantors", index: "by_org" },
  { table: "quotes", index: "by_org" },
  { table: "financeApplications", index: "by_org" },
  { table: "companyDocumentRules", index: "by_org" },
  { table: "applicationDocuments", index: "by_org" },
  { table: "branches", index: "by_org" },
  { table: "transactions", index: "by_org" },
  { table: "fixedAssets", index: "by_org" },
  { table: "partnerEquity", index: "by_org" },
  { table: "claims", index: "by_org" },
  { table: "wizardDrafts", index: "by_org_user" },
  { table: "orgSettings", index: "by_org" },
  { table: "orgCustomFields", index: "by_org" },
  { table: "orgCustomFieldValues", index: "by_org" },
  { table: "orgLeadSources", index: "by_org" },
  { table: "orgValuationCompanies", index: "by_org" },
  { table: "orgPipelineStages", index: "by_org" },
  { table: "orgImportMappings", index: "by_org_entity" },
  { table: "orgCustomerStatuses", index: "by_org" },
  { table: "profitApprovalRequests", index: "by_org" },
  { table: "feedback", index: "by_org" },
];

async function deleteAllByOrg(ctx: MutationCtx, table: TableNames, index: string, orgId: Id<"organizations">) {
  const rows = await (ctx.db.query(table) as any).withIndex(index, (q: any) => q.eq("orgId", orgId)).collect();
  for (const row of rows) {
    await ctx.db.delete(row._id);
  }
  return rows.length;
}

export const listOrgs = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const page = await ctx.db.query("organizations").order("desc").paginate(args.paginationOpts);
    const items = await Promise.all(
      page.page.map(async (org) => {
        const memberCount = (
          await ctx.db.query("memberships").withIndex("by_org", (q) => q.eq("orgId", org._id)).collect()
        ).length;
        return { ...org, memberCount };
      })
    );
    return { ...page, page: items };
  },
});

export const getOrgDetail = query({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const org = await ctx.db.get(args.orgId);
    if (!org) throwAppError(AppErrorCode.ORG_NOT_FOUND, "Organization not found.");

    const settings = await ctx.db
      .query("orgSettings")
      .withIndex("by_org", (q) => q.eq("orgId", args.orgId))
      .unique();

    const counts: Record<string, number> = {};
    for (const entity of ["vehicles", "customers", "leads", "sales", "expenses", "tasks"] as const) {
      counts[entity] = (
        await ctx.db.query(entity).withIndex("by_org", (q) => q.eq("orgId", args.orgId)).collect()
      ).length;
    }

    return { org, settings, counts };
  },
});

export const suspendOrg = mutation({
  args: { orgId: v.id("organizations"), reason: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const org = await ctx.db.get(args.orgId);
    if (!org) throwAppError(AppErrorCode.ORG_NOT_FOUND, "Organization not found.");

    await ctx.db.patch(args.orgId, {
      suspended: true,
      suspendedAt: Date.now(),
      suspendedReason: args.reason,
    });

    await logAdminAction(ctx, admin, {
      action: "suspendOrg",
      targetTable: "organizations",
      targetId: args.orgId,
      orgId: args.orgId,
      before: { suspended: org.suspended ?? false },
      after: { suspended: true, reason: args.reason },
    });
  },
});

export const unsuspendOrg = mutation({
  args: { orgId: v.id("organizations") },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const org = await ctx.db.get(args.orgId);
    if (!org) throwAppError(AppErrorCode.ORG_NOT_FOUND, "Organization not found.");

    await ctx.db.patch(args.orgId, {
      suspended: false,
      suspendedAt: undefined,
      suspendedReason: undefined,
    });

    await logAdminAction(ctx, admin, {
      action: "unsuspendOrg",
      targetTable: "organizations",
      targetId: args.orgId,
      orgId: args.orgId,
      before: { suspended: true },
      after: { suspended: false },
    });
  },
});

export const hardDeleteOrg = mutation({
  args: { orgId: v.id("organizations"), confirmName: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    const org = await ctx.db.get(args.orgId);
    if (!org) throwAppError(AppErrorCode.ORG_NOT_FOUND, "Organization not found.");

    if (args.confirmName !== org.name) {
      throwAppError(AppErrorCode.VALIDATION_FAILED, "Confirmation text does not match the organization name.");
    }

    const deletedCounts: Record<string, number> = {};
    for (const { table, index } of ORG_SCOPED_TABLES) {
      deletedCounts[table] = await deleteAllByOrg(ctx, table, index, args.orgId);
    }
    await ctx.db.delete(args.orgId);

    await logAdminAction(ctx, admin, {
      action: "hardDeleteOrg",
      targetTable: "organizations",
      targetId: args.orgId,
      orgId: args.orgId,
      before: { name: org.name, deletedCounts },
    });
  },
});
