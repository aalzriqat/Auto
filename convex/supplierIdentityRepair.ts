/**
 * SCRUM-868 P3 round 2: the release-time repair and the counts-only check for P2-era supplier rows.
 *
 * The rule and its evidence requirements live in `utils/supplierIdentityRepair.ts`. This module is
 * the page-by-page driver the release step runs through `convex run` with the operator key.
 *
 * DESIGN CHOICE: A SEPARATE, BOUNDED, RESUMABLE MIGRATION, NOT A REPAIR INSIDE THE DOORS.
 *   - A settlement door that repaired on read would write inside a path whose job is to refuse, would
 *     bind a row at the moment money moves (when a wrong binding is costliest), would leave rows nobody
 *     touches unbound forever, and could not produce the all-rows count the release must refuse on.
 *   - Convex limits one transaction's reads, writes and run time
 *     (https://docs.convex.dev/production/state/limits), and the documented way to change many rows is a
 *     paginated function that handles one bounded batch per call
 *     (https://docs.convex.dev/database/pagination and the migrations guidance). Each call here examines at
 *     most `REPAIR_PAGE_MAX` rows, reads a fixed number of documents per row, and returns a cursor; the
 *     caller (scripts/rolloutRelease.mjs) owns the loop, so there is no state table to purge, reset or order.
 *   - It is idempotent: a bound row has a supplier id and is skipped, so a re-run after a failure, or a
 *     second release, resumes from the beginning and changes nothing already done.
 *
 * Every function here is internal: reachable only with the operator key, never from a client. Nothing
 * returned or logged carries a tenant name, a document id or a figure; counts and fixed reason codes only.
 */
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalQuery } from "./_generated/server";
import { internalMutation } from "./functions";
import { IN_FLIGHT_FINANCE_STATUSES } from "./utils/financeStatuses";
import { applicationVehicleIds } from "./utils/supplierConcession";
import {
  clampRepairPageSize,
  emptyReasonCounts,
  evaluateVehicleLink,
  repairStamp,
  type LinkVerdict,
  type ReasonCounts,
} from "./utils/supplierIdentityRepair";

const REPAIR_PHASES = ["PAYABLES", "RECEIVABLES", "RECOVERIES", "CONCESSIONS"] as const;
const repairPhaseValidator = v.union(
  v.literal("PAYABLES"),
  v.literal("RECEIVABLES"),
  v.literal("RECOVERIES"),
  v.literal("CONCESSIONS"),
);
const countPhaseValidator = v.union(
  v.literal("PAYABLES"),
  v.literal("RECEIVABLES"),
  v.literal("RECOVERIES"),
  v.literal("CONCESSIONS"),
  v.literal("VEHICLES"),
);
type RepairPhase = (typeof REPAIR_PHASES)[number];
type CountPhase = RepairPhase | "VEHICLES";

const byReasonValidator = v.object({
  NO_VEHICLE: v.number(),
  VEHICLE_OTHER_ORG: v.number(),
  VEHICLE_NOT_SOURCED: v.number(),
  VEHICLE_NO_SUPPLIER_LINK: v.number(),
  SUPPLIER_NOT_IN_ORG: v.number(),
  NAME_MISMATCH: v.number(),
  VERSION_AHEAD_OF_MASTER: v.number(),
});

const pageResultValidator = v.object({
  status: v.union(v.literal("MORE"), v.literal("READY")),
  cursor: v.union(v.string(), v.null()),
  examined: v.number(),
  repaired: v.number(),
  unresolved: v.number(),
  byReason: byReasonValidator,
});

/** A native scan budget (Convex 1.42): a page that would read more than this stops early and returns a cursor. */
const MAX_BYTES_READ_PER_PAGE = 4 * 1024 * 1024;

type PageResult = {
  status: "MORE" | "READY";
  cursor: string | null;
  examined: number;
  repaired: number;
  unresolved: number;
  byReason: ReasonCounts;
};

type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };

/** Whether a row is one the repair or the check is about: a native row, with no supplier id. */
const isIdLessNativeRow = (row: { origin?: string; supplierId?: Id<"suppliers"> }): boolean =>
  row.origin !== "OPENING" && row.supplierId === undefined;

/**
 * The concession the settlement completion revalidates: an unfinalized application in flight that holds
 * a supplier share. The same predicate as `assertNoHeldSupplierConcession`, so a deal the vehicle-edit
 * freeze protects is exactly a deal this repair and the check look at.
 */
const holdsConcession = (app: Doc<"financeApplications">): boolean =>
  (app.supplierGapShareMinor ?? 0) > 0 &&
  app.finalizedSaleId === undefined &&
  IN_FLIGHT_FINANCE_STATUSES.includes(app.status);

function scanOptions(cursor: string | null, numItems: number) {
  return { cursor, numItems, maximumRowsRead: numItems, maximumBytesRead: MAX_BYTES_READ_PER_PAGE };
}

async function pageOf(
  ctx: QueryCtx | MutationCtx,
  orgId: Id<"organizations">,
  phase: CountPhase,
  cursor: string | null,
  numItems: number,
) {
  const options = scanOptions(cursor, numItems);
  switch (phase) {
    case "PAYABLES":
      return await ctx.db.query("vehicleSupplierPayables").withIndex("by_org", (q) => q.eq("orgId", orgId)).paginate(options);
    case "RECEIVABLES":
      return await ctx.db.query("vehicleSupplierReceivables").withIndex("by_org", (q) => q.eq("orgId", orgId)).paginate(options);
    case "RECOVERIES":
      return await ctx.db.query("supplierCostRecoveries").withIndex("by_org", (q) => q.eq("orgId", orgId)).paginate(options);
    case "CONCESSIONS":
      return await ctx.db.query("financeApplications").withIndex("by_org", (q) => q.eq("orgId", orgId)).paginate(options);
    case "VEHICLES":
      return await ctx.db
        .query("vehicles")
        .withIndex("by_org_sourceType_status", (q) => q.eq("orgId", orgId).eq("sourceType", "SOURCED"))
        .paginate(options);
  }
}

const finishedPage = (page: Pick<Page<unknown>, "isDone" | "continueCursor">) => ({
  status: page.isDone ? ("READY" as const) : ("MORE" as const),
  cursor: page.isDone ? null : page.continueCursor,
});

const noWork: PageResult = {
  status: "READY",
  cursor: null,
  examined: 0,
  repaired: 0,
  unresolved: 0,
  byReason: emptyReasonCounts(),
};

/**
 * Binds one page of id-less rows of one kind. A row is written only on a RESOLVED verdict; every other
 * outcome leaves it untouched and counts it. Re-running changes nothing already bound.
 */
export const repairPage = internalMutation({
  args: {
    orgId: v.id("organizations"),
    phase: repairPhaseValidator,
    cursor: v.union(v.string(), v.null()),
    numItems: v.optional(v.number()),
  },
  returns: pageResultValidator,
  handler: async (ctx, { orgId, phase, cursor, numItems }): Promise<PageResult> => {
    if ((await ctx.db.get("organizations", orgId)) === null) return { ...noWork, byReason: emptyReasonCounts() };
    const size = clampRepairPageSize(numItems);
    const now = Date.now();
    const result: PageResult = { ...noWork, byReason: emptyReasonCounts() };

    const settle = (verdict: LinkVerdict): verdict is Extract<LinkVerdict, { kind: "RESOLVED" }> => {
      if (verdict.kind === "RESOLVED") {
        result.repaired += 1;
        return true;
      }
      result.unresolved += 1;
      result.byReason[verdict.reason] += 1;
      return false;
    };

    if (phase === "PAYABLES") {
      const page = await ctx.db
        .query("vehicleSupplierPayables")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .paginate(scanOptions(cursor, size));
      for (const row of page.page) {
        result.examined += 1;
        if (!isIdLessNativeRow(row)) continue;
        const verdict = await evaluateVehicleLink(ctx, orgId, row.origin === "OPENING" ? undefined : row.vehicleId, {
          name: row.sourcedFromName,
          version: row.supplierSnapshotVersion,
        });
        if (settle(verdict)) {
          await ctx.db.patch("vehicleSupplierPayables", row._id, {
            supplierId: verdict.supplierId,
            supplierIdentityRepair: repairStamp(now, verdict.nameMatchedOn),
          });
        }
      }
      return { ...result, ...finishedPage(page) };
    }

    if (phase === "RECEIVABLES") {
      const page = await ctx.db
        .query("vehicleSupplierReceivables")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .paginate(scanOptions(cursor, size));
      for (const row of page.page) {
        result.examined += 1;
        if (row.supplierId !== undefined) continue;
        const verdict = await evaluateVehicleLink(ctx, orgId, row.vehicleId, {
          name: row.sourcedFromName,
          version: row.supplierSnapshotVersion,
        });
        if (settle(verdict)) {
          await ctx.db.patch("vehicleSupplierReceivables", row._id, {
            supplierId: verdict.supplierId,
            supplierIdentityRepair: repairStamp(now, verdict.nameMatchedOn),
          });
        }
      }
      return { ...result, ...finishedPage(page) };
    }

    if (phase === "RECOVERIES") {
      const page = await ctx.db
        .query("supplierCostRecoveries")
        .withIndex("by_org", (q) => q.eq("orgId", orgId))
        .paginate(scanOptions(cursor, size));
      for (const row of page.page) {
        result.examined += 1;
        if (!isIdLessNativeRow(row)) continue;
        const verdict = await evaluateVehicleLink(ctx, orgId, row.origin === "OPENING" ? undefined : row.vehicleId, {
          name: row.sourcedFromName,
          version: row.supplierSnapshotVersion,
        });
        if (settle(verdict)) {
          await ctx.db.patch("supplierCostRecoveries", row._id, {
            supplierId: verdict.supplierId,
            supplierIdentityRepair: repairStamp(now, verdict.nameMatchedOn),
          });
        }
      }
      return { ...result, ...finishedPage(page) };
    }

    // CONCESSIONS: the supplier terms an open deal's concession was agreed against.
    const page = await ctx.db
      .query("financeApplications")
      .withIndex("by_org", (q) => q.eq("orgId", orgId))
      .paginate(scanOptions(cursor, size));
    for (const app of page.page) {
      result.examined += 1;
      const basis = app.supplierGapBasis;
      if (!holdsConcession(app) || basis?.supplierId !== undefined) continue;
      const vehicleIds = applicationVehicleIds(app);
      // A concession is recorded on a single-vehicle application only; a basis that is missing cannot be repaired.
      const verdict: LinkVerdict =
        basis === undefined || vehicleIds.length !== 1
          ? { kind: "UNRESOLVED", reason: "NO_VEHICLE" }
          : await evaluateVehicleLink(ctx, orgId, vehicleIds[0], { name: basis.supplierName });
      if (settle(verdict) && basis !== undefined) {
        await ctx.db.patch("financeApplications", app._id, {
          supplierGapBasis: {
            ...basis,
            supplierId: verdict.supplierId,
            supplierIdentityRepair: repairStamp(now, verdict.nameMatchedOn),
          },
        });
      }
    }
    return { ...result, ...finishedPage(page) };
  },
});

/**
 * The counts-only check. Read-only; walks the same rows the repair does and counts what the settlement
 * doors would still refuse: id-less native payables, receivables and recoveries (terminal ones included),
 * held concessions whose basis has no supplier id, and SOURCED vehicles that carry no supplier link.
 * Re-derived from the data on every call, so it never trusts what the repair reported.
 */
export const countPage = internalQuery({
  args: {
    orgId: v.id("organizations"),
    phase: countPhaseValidator,
    cursor: v.union(v.string(), v.null()),
    numItems: v.optional(v.number()),
  },
  returns: v.object({
    status: v.union(v.literal("MORE"), v.literal("READY")),
    cursor: v.union(v.string(), v.null()),
    examined: v.number(),
    unresolved: v.number(),
  }),
  handler: async (ctx, { orgId, phase, cursor, numItems }) => {
    const page = await pageOf(ctx, orgId, phase, cursor, clampRepairPageSize(numItems));
    let unresolved = 0;
    for (const row of page.page) {
      switch (phase) {
        case "PAYABLES":
        case "RECEIVABLES":
        case "RECOVERIES":
          if (isIdLessNativeRow(row as { origin?: string; supplierId?: Id<"suppliers"> })) unresolved += 1;
          break;
        case "CONCESSIONS": {
          const app = row as Doc<"financeApplications">;
          if (holdsConcession(app) && app.supplierGapBasis?.supplierId === undefined) unresolved += 1;
          break;
        }
        case "VEHICLES": {
          const vehicle = row as Doc<"vehicles">;
          if (vehicle.isDeleted !== true && vehicle.sourcedSupplierId === undefined) unresolved += 1;
          break;
        }
      }
    }
    return { ...finishedPage(page), examined: page.page.length, unresolved };
  },
});
