import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { mutation, query } from "./_generated/server";
import { Id, TableNames } from "./_generated/dataModel";
import { requireSuperAdmin } from "./utils/tenancy";
import { throwAppError, AppErrorCode } from "./utils/errors";
import { logAdminAction } from "./adminAudit";
import { assertAdminMayMutateTable } from "./utils/financialGuards";

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
    // When true, only soft-deleted rows (isDeleted === true) are returned —
    // used by the Data Browser's "Deleted only" view to find restorable records.
    deletedOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireSuperAdmin(ctx);
    const { index } = assertAdminTable(args.table);
    let q = (ctx.db.query(args.table as TableNames) as any).withIndex(
      index,
      (q: any) => q.eq("orgId", args.orgId)
    );
    if (args.deletedOnly) {
      q = q.filter((q: any) => q.eq(q.field("isDeleted"), true));
    }
    return await q.order("desc").paginate(args.paginationOpts);
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
    assertAdminMayMutateTable(args.table, "adminUpdateRecord");

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

// Undo a soft delete: clear isDeleted/deletedAt/deletedBy so the record
// reappears in its original org's normal (isDeleted-filtered) queries. The
// record keeps its orgId, so it is restored to the exact dealer that owned it.
// Accepts one or many ids so the UI can restore a single row or a bulk
// selection in a single atomic mutation. Financial tables are blocked by the
// same guard as edits/deletes — restoring a financial record could re-open GL
// impact, so it must go through a domain workflow instead.
export const adminRestoreRecords = mutation({
  args: { table: v.string(), ids: v.array(v.string()) },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    assertAdminTable(args.table);
    assertAdminMayMutateTable(args.table, "adminRestoreRecords");

    if (args.ids.length === 0) {
      throwAppError(AppErrorCode.VALIDATION_FAILED, "No records selected to restore.");
    }

    let restored = 0;
    for (const rawId of args.ids) {
      // normalizeId proves the id actually belongs to args.table. Without it a
      // caller could pass a financial-table id under table:"vehicles" (which
      // passes the guard above) and this loop would patch that financial row.
      const id = ctx.db.normalizeId(args.table as TableNames, rawId);
      if (!id) {
        throwAppError(AppErrorCode.VALIDATION_FAILED, `Record ${rawId} does not belong to table ${args.table}.`);
      }
      const before = await ctx.db.get(id);
      if (!before) {
        throwAppError(AppErrorCode.VALIDATION_FAILED, `Record not found: ${rawId}`);
      }
      if ((before as any).orgId === undefined) {
        throwAppError(AppErrorCode.VALIDATION_FAILED, "Record is not org-scoped and cannot be restored here.");
      }
      if ((before as any).isDeleted !== true) {
        throwAppError(AppErrorCode.VALIDATION_FAILED, "Record is not soft-deleted, so there is nothing to restore.");
      }

      await ctx.db.patch(id, {
        isDeleted: false,
        deletedAt: undefined,
        deletedBy: undefined,
      } as any);
      const after = await ctx.db.get(id);

      await logAdminAction(ctx, admin, {
        action: "adminRestoreRecord",
        targetTable: args.table,
        targetId: rawId,
        orgId: (before as any).orgId,
        before,
        after,
      });
      restored += 1;
    }

    return { restored };
  },
});

export const adminHardDelete = mutation({
  args: { table: v.string(), id: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireSuperAdmin(ctx);
    assertAdminTable(args.table);
    assertAdminMayMutateTable(args.table, "adminHardDelete");

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
