import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query } from "./_generated/server";
import { Id, TableNames } from "./_generated/dataModel";
import { requireSuperAdmin } from "./utils/tenancy";
import { throwAppError, AppErrorCode } from "./utils/errors";
import { logAdminAction } from "./adminAudit";

// Tables browsable in the cross-org Data Browser UI. Deliberately a subset
// of every org-scoped table (excludes internal/derived tables like
// wizardDrafts, orgImportMappings, orgCustomFieldValues).
const ADMIN_TABLES: { table: TableNames; index: string }[] = [
  { table: "vehicles", index: "by_org" },
  { table: "customers", index: "by_org" },
  { table: "leads", index: "by_org" },
  { table: "sales", index: "by_org" },
  { table: "expenses", index: "by_org" },
  { table: "tasks", index: "by_org" },
  { table: "test_drives", index: "by_org" },
  { table: "workOrders", index: "by_org" },
  { table: "quotes", index: "by_org" },
  { table: "financeApplications", index: "by_org" },
  { table: "guarantors", index: "by_org" },
  { table: "claims", index: "by_org" },
  { table: "transactions", index: "by_org" },
  { table: "fixedAssets", index: "by_org" },
  { table: "partnerEquity", index: "by_org" },
  { table: "branches", index: "by_org" },
  { table: "notifications", index: "by_org_user" },
  { table: "feedback", index: "by_org" },
  { table: "roles", index: "by_org" },
  { table: "invitations", index: "by_org" },
];

const ADMIN_TABLE_NAMES = ADMIN_TABLES.map((t) => t.table);

function assertAdminTable(table: string): { table: TableNames; index: string } {
  const entry = ADMIN_TABLES.find((t) => t.table === table);
  if (!entry) {
    throwAppError(AppErrorCode.VALIDATION_FAILED, `"${table}" is not a browsable admin table.`);
  }
  return entry;
}

export const listAdminTables = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx);
    return ADMIN_TABLE_NAMES;
  },
});

// Convex's Id<TableName> can't be parameterized by a runtime string, so the
// table name is validated against ADMIN_TABLES and then cast (`as any`) at
// the single call site below — the only place in the codebase this happens.
export const adminListByOrg = query({
  args: {
    orgId: v.id("organizations"),
    table: v.string(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const { index } = assertAdminTable(args.table);
    return await (ctx.db.query(args.table as TableNames) as any)
      .withIndex(index, (q: any) => q.eq("orgId", args.orgId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

export const adminGetRecord = query({
  args: { table: v.string(), id: v.string() },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    assertAdminTable(args.table);
    return await ctx.db.get(args.id as Id<TableNames>);
  },
});

export const adminUpdateRecord = mutation({
  args: { table: v.string(), id: v.string(), patch: v.any() },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    assertAdminTable(args.table);

    const id = args.id as Id<TableNames>;
    const before = await ctx.db.get(id);
    if (!before) throwAppError(AppErrorCode.VALIDATION_FAILED, "Record not found.");

    await ctx.db.patch(id, args.patch);
    const after = await ctx.db.get(id);

    await logAdminAction(ctx, admin, {
      action: "adminUpdateRecord",
      targetTable: args.table,
      targetId: args.id,
      orgId: (before as any).orgId,
      before,
      after,
    });
  },
});

export const adminHardDelete = mutation({
  args: { table: v.string(), id: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    assertAdminTable(args.table);

    const id = args.id as Id<TableNames>;
    const before = await ctx.db.get(id);
    if (!before) throwAppError(AppErrorCode.VALIDATION_FAILED, "Record not found.");

    await ctx.db.delete(id);

    await logAdminAction(ctx, admin, {
      action: "adminHardDelete",
      targetTable: args.table,
      targetId: args.id,
      orgId: (before as any).orgId,
      before,
    });
  },
});
