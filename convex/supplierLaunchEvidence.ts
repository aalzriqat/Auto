/** SCRUM-868 P7: deployment-wide read-only identity evidence. No client export. */
import { v, type VFloat64 } from "convex/values";
import { internalQuery, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { finishedPage, holdsConcession, isIdLessNativeRow, lacksVehicleSupplier, scanOptions } from "./utils/supplierIdentityRepair";
import {
  SUPPLIER_LAUNCH_TABLES, SUPPLIER_LAUNCH_REASONS, SUPPLIER_LAUNCH_PAGE_SIZE,
  emptySupplierLaunchCounts, type SupplierLaunchReason as Reason, type SupplierLaunchTable as Table,
} from "./utils/supplierLaunchRegistry";

const tableValidator = v.union(...SUPPLIER_LAUNCH_TABLES.map(table => v.literal(table)));
const countFields = Object.fromEntries(SUPPLIER_LAUNCH_REASONS.map(reason => [reason, v.number()])) as
  Record<Reason, VFloat64<number, "required">>;
const countsValidator = v.object(countFields);
const UNAVAILABLE = { status: "UNAVAILABLE", code: "SUPPLIER_EVIDENCE_UNAVAILABLE" } as const;
const missingId = (missing: boolean): Reason | null => missing ? "MISSING_SUPPLIER_ID" : null;

type SupplierRow = { origin?: string; supplierId?: Id<"suppliers"> };
function supplierMissing(row: SupplierRow): Reason | null {
  return missingId(isIdLessNativeRow(row) || (row.origin === "OPENING" && row.supplierId === undefined));
}
function payableMissing(row: Doc<"vehicleSupplierPayables">): Reason | null {
  const ordinaryCreditor = row.origin === "OPENING" && row.openingKind === "OTHER_PAYABLE" && row.supplierId === undefined;
  return ordinaryCreditor ? null : supplierMissing(row);
}

async function editMissing(ctx: QueryCtx, row: Doc<"vehicleEdits">): Promise<Reason | null> {
  if (row.status !== "PENDING") return null;
  const payload = row.payload;
  const named = Boolean(payload.sourcedFromName?.trim());
  const onAccount = payload.purchasePaymentMethod === "ON_ACCOUNT" && !payload.purchaseSupplierId;
  if (row.type === "CREATE") {
    const sourced = payload.sourceType === "SOURCED" || named;
    return missingId((sourced && !payload.sourcedSupplierId) || (payload.sourceType === "STOCK" && onAccount));
  }
  const vehicle = row.vehicleId ? await ctx.db.get("vehicles", row.vehicleId) : null;
  // resolve(UPDATE) refuses these sources before applying money. Dead requests are not a launch veto.
  if (!vehicle || vehicle.orgId !== row.orgId || vehicle.isDeleted === true) return null;
  const sourced = (payload.sourceType ?? vehicle.sourceType) === "SOURCED";
  const changedName = named && payload.sourcedFromName?.trim() !== vehicle.sourcedFromName?.trim();
  if (!sourced) return missingId(onAccount);
  const needsLink = changedName || !vehicle.sourcedSupplierId;
  return missingId(needsLink && !payload.sourcedSupplierId);
}

/** One per-page cache, shared by both inherited-identity table handlers. Never cached across queries. */
function parentLookup(ctx: QueryCtx) {
  const cache = new Map<string, Reason | null>();
  return async <T extends "supplierCostRecoveries" | "vehicleSupplierPayables">(
    table: T, id: Id<T>, orgId: Id<"organizations">,
    reason: (parent: Doc<T>) => Reason | null,
  ): Promise<Reason | null> => {
    // Cache the rule result by parent AND receiving org, including absent/foreign parents.
    const key = `${table}:${id}:${orgId}`;
    if (cache.has(key)) return cache.get(key) ?? null;
    const parent = await ctx.db.get(table, id);
    const result: Reason | null = !parent || parent.orgId !== orgId ? "MISSING_SOURCE" : reason(parent);
    cache.set(key, result);
    return result;
  };
}

function expensePayee(row: Doc<"expenses">): Reason | null {
  return !row.isDeleted && row.costBearer === "SUPPLIER" && !row.vendorSupplierId ? "MISSING_PAYEE_ID" : null;
}
function expenseBearer(row: Doc<"expenses">): Reason | null {
  return !row.isDeleted && row.costBearer === "SUPPLIER" && !row.costBearerSupplierId ? "MISSING_BEARER_ID" : null;
}
function openingMissing(row: Doc<"openingBalanceDrafts">): Reason | null {
  return missingId((row.allocations ?? []).some(allocation =>
    (allocation.kind === "SUPPLIER_PAYABLE" || allocation.kind === "SUPPLIER_RECOVERABLE") && !allocation.supplierId));
}
function concessionMissing(app: Doc<"financeApplications">): Reason | null {
  // P3 protects held concessions; launch evidence also protects persisted terminal bases.
  return missingId((holdsConcession(app) || app.supplierGapBasis !== undefined) && app.supplierGapBasis?.supplierId === undefined);
}

type Reasons = readonly (Reason | null)[];
type Rule<T extends Table> = (row: Doc<T>) => Reasons | Promise<Reasons>;
async function scanTable<T extends Table>(ctx: QueryCtx, table: T, cursor: string | null, rule: Rule<T>) {
  // Native creation-time index includes orphan-org rows. One paginate call per query.
  const page = await ctx.db.query(table).withIndex("by_creation_time")
    .paginate(scanOptions(cursor, SUPPLIER_LAUNCH_PAGE_SIZE, SUPPLIER_LAUNCH_PAGE_SIZE + 1));
  if (page.pageStatus === "SplitRequired" || page.page.length > SUPPLIER_LAUNCH_PAGE_SIZE ||
    (!page.isDone && (!page.continueCursor || page.continueCursor === cursor))) return UNAVAILABLE;
  const counts = emptySupplierLaunchCounts();
  for (const row of page.page) {
    for (const reason of await rule(row)) if (reason) counts[reason] += 1;
  }
  return { ...finishedPage(page), examined: page.page.length, counts };
}

function tableScanners(ctx: QueryCtx, cursor: string | null) {
  const parent = parentLookup(ctx);
  return {
    vehicleSupplierPayables: () => scanTable(ctx, "vehicleSupplierPayables", cursor, row => [payableMissing(row)]),
    vehicleSupplierReceivables: () => scanTable(ctx, "vehicleSupplierReceivables", cursor, row => [supplierMissing(row)]),
    supplierCostRecoveries: () => scanTable(ctx, "supplierCostRecoveries", cursor, row => [supplierMissing(row)]),
    supplierCostRecoveryReceipts: () => scanTable(ctx, "supplierCostRecoveryReceipts", cursor,
      async row => [await parent("supplierCostRecoveries", row.recoveryId, row.orgId, supplierMissing)]),
    openingPayablePayments: () => scanTable(ctx, "openingPayablePayments", cursor,
      async row => [await parent("vehicleSupplierPayables", row.payableId, row.orgId, payableMissing)]),
    vehicles: () => scanTable(ctx, "vehicles", cursor,
      row => [missingId(row.sourceType === "SOURCED" && lacksVehicleSupplier(row))]),
    vehicleOwnershipConversions: () => scanTable(ctx, "vehicleOwnershipConversions", cursor,
      row => [missingId((row.supplierName !== undefined || row.fromSourceType === "SOURCED") && !row.supplierId)]),
    financeApplications: () => scanTable(ctx, "financeApplications", cursor, row => [concessionMissing(row)]),
    expenses: () => scanTable(ctx, "expenses", cursor, row => [expensePayee(row), expenseBearer(row)]),
    vehicleEdits: () => scanTable(ctx, "vehicleEdits", cursor, async row => [await editMissing(ctx, row)]),
    openingBalanceDrafts: () => scanTable(ctx, "openingBalanceDrafts", cursor, row => [openingMissing(row)]),
  } satisfies Record<Table, () => unknown>;
}

export const scanPage = internalQuery({
  args: { table: tableValidator, cursor: v.union(v.string(), v.null()) },
  returns: v.union(v.object({ status: v.union(v.literal("READY"), v.literal("MORE")),
    cursor: v.union(v.string(), v.null()), examined: v.number(), counts: countsValidator }),
    v.object({ status: v.literal("UNAVAILABLE"), code: v.literal("SUPPLIER_EVIDENCE_UNAVAILABLE") })),
  handler: scanSupplierLaunchPage,
});

/** Shared handler permits real database I/O instrumentation without framework-private members. */
export async function scanSupplierLaunchPage(ctx: QueryCtx, { table, cursor }: { table: Table; cursor: string | null }) {
  try { return await tableScanners(ctx, cursor)[table](); }
  catch (error) {
    console.error("Supplier launch evidence unavailable", error);
    return UNAVAILABLE;
  }
}
