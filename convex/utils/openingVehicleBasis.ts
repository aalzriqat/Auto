import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { toMinorUnits } from "./money";
import { orgResetState } from "./orgResetGeneration";
import { loadOpeningSourceIdentity } from "./openingSourceIdentity";

export const OPENING_STOCK_IMPORT_OPERATION = "vehicles.importBulk.openingStock";
type Ctx = QueryCtx | MutationCtx;
type Evidence = { vehicleId: Id<"vehicles">; vin: string; costMinor: number;
  currency: string; command: Doc<"commandIdempotency"> };

/** The command rows survive mutable vehicle-marker removal and financial reset. */
export async function listOpeningStockEvidence(ctx: Ctx, orgId: Id<"organizations">): Promise<Evidence[]> {
  const commands = await ctx.db.query("commandIdempotency")
    .withIndex("by_org_operation_key", (q) => q.eq("orgId", orgId).eq("operation", OPENING_STOCK_IMPORT_OPERATION))
    .take(101);
  if (commands.length > 100) throw new ConvexError("Opening stock exceeds the reviewed 100-vehicle allocation limit.");
  const result: Evidence[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    const raw = command.result as { vehicleId?: unknown; vin?: unknown; costMinor?: unknown;
      currency?: unknown; sourceType?: unknown } | null;
    if (command.status !== "COMPLETED" || !raw || typeof raw.vehicleId !== "string" ||
        typeof raw.vin !== "string" || !raw.vin || typeof raw.costMinor !== "number" ||
        !Number.isSafeInteger(raw.costMinor) || raw.costMinor <= 0 ||
        typeof raw.currency !== "string" || !raw.currency ||
        raw.sourceType !== "STOCK" ||
        seen.has(raw.vehicleId)) throw new ConvexError("Opening stock import proof is unavailable. Ask finance to review it.");
    seen.add(raw.vehicleId);
    result.push({ vehicleId: raw.vehicleId as Id<"vehicles">, vin: raw.vin,
      costMinor: raw.costMinor, currency: raw.currency, command });
  }
  return result;
}

export async function openingVehicleEvidence(ctx: Ctx, orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">): Promise<Evidence | null> {
  const evidence = await listOpeningStockEvidence(ctx, orgId);
  return evidence.find((row) => row.vehicleId === vehicleId) ?? null;
}

export async function assertOpeningVehicleBasis(ctx: Ctx, orgId: Id<"organizations">,
  vehicleId: Id<"vehicles">, effectiveDate?: number): Promise<"ORDINARY" | "POSTED"> {
  const evidence = await openingVehicleEvidence(ctx, orgId, vehicleId);
  if (!evidence) {
    await assertNoUnprovenOpeningStock(ctx, orgId, vehicleId);
    return "ORDINARY";
  }
  const org = await ctx.db.get(orgId);
  if ((evidence.command.resetGeneration ?? 0) !== orgResetState(org).generation) {
    throw new ConvexError("Opening stock predates a financial reset and needs a reviewed correction.");
  }
  const vehicle = await ctx.db.get(vehicleId);
  if (!vehicle || vehicle.orgId !== orgId || vehicle.isDeleted || vehicle.sourceType !== "STOCK" ||
      vehicle.openingStockImportId === undefined || vehicle.openingStockRowId === undefined) {
    throw new ConvexError("Opening stock import proof is unavailable. Ask finance to review it.");
  }
  const key = `${vehicle.openingStockImportId}:${vehicle.openingStockRowId}`;
  if (evidence.command.idempotencyKey !== key || evidence.vin !== vehicle.vin) {
    throw new ConvexError("Opening stock import proof conflicts with the vehicle. Ask finance to review it.");
  }
  const source = await loadOpeningSourceIdentity(ctx, orgId);
  if (source.status === "ABSENT" && source.headers.length === 0) {
    throw new ConvexError("Opening stock cannot change or sell before its opening balance is posted.");
  }
  if (source.status === "ABSENT") throw new ConvexError("Opening stock journal proof is unavailable.");
  if (source.status !== "AVAILABLE") throw new ConvexError("Opening stock has ambiguous opening balance proof.");
  const parent = source.parent;
  const results = parent.allocationResults?.filter((row) => row.kind === "VEHICLE_INVENTORY" && row.vehicleId === vehicleId) ?? [];
  if (results.length !== 1 || results[0].kind !== "VEHICLE_INVENTORY" ||
      vehicle.openingBalanceDraftId !== parent._id || !parent.currency) {
    throw new ConvexError("Opening stock lacks a verified posted allocation.");
  }
  const allocations = parent.allocations?.filter((row) => row.kind === "VEHICLE_INVENTORY" && row.rowKey === results[0].rowKey) ?? [];
  if (allocations.length !== 1 || allocations[0].kind !== "VEHICLE_INVENTORY" ||
      allocations[0].vehicleId !== vehicleId ||
      evidence.currency !== parent.currency || evidence.costMinor !== allocations[0].amountMinor ||
      toMinorUnits(vehicle.purchasePrice ?? 0, parent.currency) !== allocations[0].amountMinor) {
    throw new ConvexError("Opening stock cost no longer agrees with its posted basis.");
  }
  const journal = source.journal;
  if (!journal || journal.orgId !== orgId || journal.category !== "OPENING_BALANCE" ||
      journal.status !== "POSTED" || journal.sourceType !== "cutover" || journal.sourceId !== String(orgId) ||
      journal.accountingDate !== parent.asOfDate || journal.currency !== parent.currency) {
    throw new ConvexError("Opening stock journal proof is unavailable.");
  }
  if (effectiveDate !== undefined && effectiveDate < parent.asOfDate) {
    throw new ConvexError("This vehicle cannot be sold before its opening inventory basis date.");
  }
  const siblings = parent.allocations?.filter((row) => row.kind === "VEHICLE_INVENTORY") ?? [];
  const lines = await ctx.db.query("journalLines")
    .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", journal._id)).collect();
  const inventoryLines = lines.filter((line) => line.accountId === allocations[0].accountId);
  const total = siblings.reduce((sum, row) => sum + row.amountMinor, 0);
  if (!Number.isSafeInteger(total) || inventoryLines.length === 0 ||
      inventoryLines.some((line) => line.orgId !== orgId || line.currency !== parent.currency ||
        line.accountingDate !== parent.asOfDate || line.creditMinor !== 0) ||
      inventoryLines.reduce((sum, line) => sum + line.debitMinor, 0) !== total) {
    throw new ConvexError("Opening stock inventory journal does not match its allocated vehicles.");
  }
  return "POSTED";
}

async function assertNoUnprovenOpeningStock(ctx: Ctx, orgId: Id<"organizations">, vehicleId: Id<"vehicles">) {
  const vehicle = await ctx.db.get(vehicleId);
  const source = await loadOpeningSourceIdentity(ctx, orgId);
  if (vehicle?.orgId === orgId &&
      (source.status === "UNAVAILABLE" || vehicle.openingStockImportId !== undefined || vehicle.openingBalanceDraftId !== undefined ||
        source.headers.some((parent) => parent.allocationResults?.some((row) =>
          row.kind === "VEHICLE_INVENTORY" && row.vehicleId === vehicleId)))) {
    throw new ConvexError("Opening stock command proof is unavailable. Ask finance to review it.");
  }
}
