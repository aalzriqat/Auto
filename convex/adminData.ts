import { v } from "convex/values";
import { paginationOptsValidator } from "convex/server";
import { query } from "./_generated/server";
import { mutation } from "./functions";
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

/**
 * Resolves a client-supplied id string and PROVES it belongs to the
 * client-supplied table.
 *
 * `assertAdminMayMutateTable` can only see the table *name* the caller claims,
 * while `ctx.db.get/patch/delete` resolve by the id's *real* table. Without
 * this check the two disagree, and a caller could pass a financial record's id
 * under `table:"vehicles"` (which clears the financial guard) and still mutate
 * or delete that financial row — silently unbalancing the ledger and writing an
 * audit entry naming the wrong table.
 */
function assertIdBelongsToTable(
  ctx: { db: { normalizeId: (t: TableNames, id: string) => Id<TableNames> | null } },
  table: TableNames,
  rawId: string
): Id<TableNames> {
  const id = ctx.db.normalizeId(table, rawId);
  if (!id) {
    throwAppError(
      AppErrorCode.VALIDATION_FAILED,
      `Record ${rawId} does not belong to table ${table}.`
    );
  }
  return id;
}

/**
 * `patch` is `v.any()`, so it can carry any field — including `orgId`, which
 * would silently move a record between tenants and corrupt both dealers' books.
 * Tenancy is not an editable attribute from this surface.
 */
function assertPatchDoesNotRetenant(patch: unknown): void {
  if (patch && typeof patch === "object" && "orgId" in (patch as Record<string, unknown>)) {
    throwAppError(
      AppErrorCode.VALIDATION_FAILED,
      "orgId cannot be changed through the admin data browser — a record cannot be moved between organizations."
    );
  }
}

/**
 * A vehicle's sale-lifecycle fields are workflow output, not editable data.
 *
 * SCRUM-212. `vehicles` is deliberately NOT in `FINANCIAL_TABLES` — a dealer's
 * VIN, colour or mileage genuinely does need repairing from here. But
 * `soldBySaleId` is the authority `restoreVehicleFromSale` trusts to decide
 * whether a car may be returned to the lot, and that guard fails closed. A
 * forged value therefore does not corrupt the books; it does something quieter
 * and harder to undo — it strands the car, because every legitimate
 * cancellation is refused with a message blaming a sale that does not own it.
 * Setting SOLD with no owner at all strands it the same way.
 *
 * Both reviewer seats found this independently and reproduced it, which is why
 * it is closed here rather than deferred: the field is new in this change, and
 * a guard that trusts a value anyone can forge is not a guard.
 *
 * ⚠️ Only an actual CHANGE is refused. The admin UI round-trips the whole
 * record as JSON, so an ordinary edit re-sends these fields at their current
 * values; refusing any patch that merely mentions them would break every
 * legitimate repair. Status changes belong to the sale workflow and to
 * `vehicleRequests`, which is where the tenant-facing doors already send them.
 */
const VEHICLE_LIFECYCLE_FIELDS = ["status", "soldBySaleId", "preHoldStatus"] as const;

function assertPatchDoesNotForgeVehicleLifecycle(
  table: string,
  patch: unknown,
  before: Record<string, unknown>
): void {
  if (table !== "vehicles") return;
  if (!patch || typeof patch !== "object") return;
  const next = patch as Record<string, unknown>;

  for (const field of VEHICLE_LIFECYCLE_FIELDS) {
    if (!(field in next)) continue;
    // Compared as strings so an Id and its serialized form agree, and so
    // undefined and a missing value are the same absence.
    if (String(next[field] ?? "") === String(before[field] ?? "")) continue;
    throwAppError(
      AppErrorCode.VALIDATION_FAILED,
      `A vehicle's ${field} records which sale owns the car and is set by the sale workflow, not by direct edit. Changing it here would let a cancellation restore a car that belongs to another sale, or strand this one. Use the sale or vehicle-request workflow instead.`
    );
  }
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
    const { table } = assertAdminTable(args.table);
    assertAdminMayMutateTable(args.table, "adminUpdateRecord");
    assertPatchDoesNotRetenant(args.patch);

    const id = assertIdBelongsToTable(ctx, table, args.id);
    const before = await ctx.db.get(id);
    if (!before) throwAppError(AppErrorCode.VALIDATION_FAILED, "Record not found.");

    assertPatchDoesNotForgeVehicleLifecycle(
      args.table,
      args.patch,
      before as unknown as Record<string, unknown>
    );

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
    const { table } = assertAdminTable(args.table);
    assertAdminMayMutateTable(args.table, "adminHardDelete");

    const id = assertIdBelongsToTable(ctx, table, args.id);
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
