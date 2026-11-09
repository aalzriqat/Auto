/** SCRUM-868 P7: deployment-wide read-only identity evidence. No client export. */
import { v } from "convex/values";
import { internalQuery, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

const tableValidator = v.union(
  v.literal("vehicleSupplierPayables"), v.literal("vehicleSupplierReceivables"),
  v.literal("supplierCostRecoveries"), v.literal("supplierCostRecoveryReceipts"),
  v.literal("openingPayablePayments"), v.literal("vehicles"), v.literal("vehicleOwnershipConversions"),
  v.literal("financeApplications"), v.literal("expenses"), v.literal("vehicleEdits"), v.literal("openingBalanceDrafts"),
);
const countsValidator = v.object({ MISSING_SUPPLIER_ID: v.number(), MISSING_PAYEE_ID: v.number(),
  MISSING_BEARER_ID: v.number(), MISSING_SOURCE: v.number() });
const emptyCounts = () => ({ MISSING_SUPPLIER_ID: 0, MISSING_PAYEE_ID: 0, MISSING_BEARER_ID: 0, MISSING_SOURCE: 0 });
type Counts = ReturnType<typeof emptyCounts>;
const UNAVAILABLE = { status: "UNAVAILABLE", code: "SUPPLIER_EVIDENCE_UNAVAILABLE" } as const;
const PAGE_SIZE = 8;
const MAX_BYTES = 4 * 1024 * 1024;

function ordinaryCreditor(row: Doc<"vehicleSupplierPayables">): boolean {
  return row.origin === "OPENING" && row.openingKind === "OTHER_PAYABLE" && row.supplierId === undefined;
}

async function editMissing(ctx: QueryCtx, row: Doc<"vehicleEdits">): Promise<boolean> {
  if (row.status !== "PENDING") return false;
  const payload = row.payload;
  if (row.type === "CREATE") {
    return ((payload.sourceType === "SOURCED" || Boolean(payload.sourcedFromName?.trim())) && !payload.sourcedSupplierId) ||
      (payload.sourceType === "STOCK" && payload.purchasePaymentMethod === "ON_ACCOUNT" && !payload.purchaseSupplierId);
  }
  const vehicle = row.vehicleId ? await ctx.db.get("vehicles", row.vehicleId) : null;
  if (!vehicle || vehicle.orgId !== row.orgId || vehicle.isDeleted === true) throw new Error("Supplier edit source unavailable");
  const sourced = (payload.sourceType ?? vehicle.sourceType) === "SOURCED";
  const changedName = Boolean(payload.sourcedFromName?.trim()) && payload.sourcedFromName?.trim() !== vehicle.sourcedFromName?.trim();
  return (sourced && !payload.sourcedSupplierId && (changedName || !vehicle.sourcedSupplierId)) ||
    (!sourced && payload.purchasePaymentMethod === "ON_ACCOUNT" && !payload.purchaseSupplierId);
}

// Each branch returns only counters. The generic table switch keeps row types narrowed.
export const scanPage = internalQuery({
  args: { table: tableValidator, cursor: v.union(v.string(), v.null()) },
  returns: v.union(v.object({ status: v.union(v.literal("READY"), v.literal("MORE")),
    cursor: v.union(v.string(), v.null()), examined: v.number(), counts: countsValidator }),
  v.object({ status: v.literal("UNAVAILABLE"), code: v.literal("SUPPLIER_EVIDENCE_UNAVAILABLE") })),
  handler: async (ctx, { table, cursor }) => {
    try {
      // Native creation-time index includes orphan-org rows. Never sample/filter before paging.
      const page = await ctx.db.query(table).withIndex("by_creation_time").paginate({ cursor,
        numItems: PAGE_SIZE, maximumRowsRead: 64, maximumBytesRead: MAX_BYTES });
      if (page.pageStatus === "SplitRequired" || page.page.length > PAGE_SIZE ||
        (!page.isDone && (!page.continueCursor || page.continueCursor === cursor))) return UNAVAILABLE;
      const counts: Counts = emptyCounts();
      for (const row of page.page) {
        await countRow(ctx, table, row, counts);
      }
      return { status: page.isDone ? "READY" as const : "MORE" as const,
        cursor: page.isDone ? null : page.continueCursor, examined: page.page.length, counts };
    } catch (error) {
      console.error("Supplier launch evidence unavailable", error);
      return UNAVAILABLE;
    }
  },
});

type Table = typeof tableValidator.type;
type Row = Doc<Table>;

function countPayable(row: Doc<"vehicleSupplierPayables">, counts: Counts) {
  if (!row.supplierId && !ordinaryCreditor(row)) counts.MISSING_SUPPLIER_ID += 1;
}
async function countReceipt(ctx: QueryCtx, row: Doc<"supplierCostRecoveryReceipts">, counts: Counts) {
  const parent = await ctx.db.get("supplierCostRecoveries", row.recoveryId);
  if (!parent || parent.orgId !== row.orgId) counts.MISSING_SOURCE += 1;
  else if (!parent.supplierId) counts.MISSING_SUPPLIER_ID += 1;
}
async function countPayment(ctx: QueryCtx, row: Doc<"openingPayablePayments">, counts: Counts) {
  const parent = await ctx.db.get("vehicleSupplierPayables", row.payableId);
  if (!parent || parent.orgId !== row.orgId) counts.MISSING_SOURCE += 1;
  else countPayable(parent, counts);
}
function countVehicle(row: Doc<"vehicles">, counts: Counts) {
  if (!row.isDeleted && row.sourceType === "SOURCED" && !row.sourcedSupplierId) counts.MISSING_SUPPLIER_ID += 1;
}
function countConversion(row: Doc<"vehicleOwnershipConversions">, counts: Counts) {
  if ((row.supplierName !== undefined || row.fromSourceType === "SOURCED") && !row.supplierId) counts.MISSING_SUPPLIER_ID += 1;
}
function countExpense(row: Doc<"expenses">, counts: Counts) {
  if (row.isDeleted || row.costBearer !== "SUPPLIER") return;
  if (!row.vendorSupplierId) counts.MISSING_PAYEE_ID += 1;
  if (!row.costBearerSupplierId) counts.MISSING_BEARER_ID += 1;
}
function countOpening(row: Doc<"openingBalanceDrafts">, counts: Counts) {
  if ((row.allocations ?? []).some(allocation =>
    (allocation.kind === "SUPPLIER_PAYABLE" || allocation.kind === "SUPPLIER_RECOVERABLE") && !allocation.supplierId)) {
    counts.MISSING_SUPPLIER_ID += 1;
  }
}
async function countRow(ctx: QueryCtx, table: Table, row: Row, counts: Counts): Promise<void> {
  // IDs are validated by Convex and the selected table's schema. Narrow through table-specific types.
  switch (table) {
    case "vehicleSupplierPayables":
      countPayable(row as Doc<"vehicleSupplierPayables">, counts);
      break;
    case "vehicleSupplierReceivables":
    case "supplierCostRecoveries":
      if (!(row as Doc<"supplierCostRecoveries">).supplierId) counts.MISSING_SUPPLIER_ID += 1;
      break;
    case "supplierCostRecoveryReceipts":
      await countReceipt(ctx, row as Doc<"supplierCostRecoveryReceipts">, counts);
      break;
    case "openingPayablePayments":
      await countPayment(ctx, row as Doc<"openingPayablePayments">, counts);
      break;
    case "vehicles":
      countVehicle(row as Doc<"vehicles">, counts);
      break;
    case "vehicleOwnershipConversions":
      countConversion(row as Doc<"vehicleOwnershipConversions">, counts);
      break;
    case "financeApplications": {
      const app = row as Doc<"financeApplications">;
      if (app.supplierGapBasis && !app.supplierGapBasis.supplierId) counts.MISSING_SUPPLIER_ID += 1;
      break;
    }
    case "expenses":
      countExpense(row as Doc<"expenses">, counts);
      break;
    case "vehicleEdits":
      if (await editMissing(ctx, row as Doc<"vehicleEdits">)) counts.MISSING_SUPPLIER_ID += 1;
      break;
    case "openingBalanceDrafts":
      countOpening(row as Doc<"openingBalanceDrafts">, counts);
      break;
  }
}
