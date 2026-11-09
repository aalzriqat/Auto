import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { PERMISSIONS } from "./permissions";
import { hasReadHeadroom } from "./transactionReadHeadroom";
import type { ObligationKind } from "./supplierObligationDue";

export const supplierSourceValidator = v.object({
  kind: v.union(v.literal("VEHICLE"), v.literal("SALE"), v.literal("APPLICATION"), v.literal("EXPENSE"), v.literal("OPENING")),
  id: v.string(), label: v.string(), href: v.union(v.string(), v.null()),
});
export const supplierRowContextValidator = v.object({
  role: v.union(v.literal("AP"), v.literal("AR")),
  occurredAt: v.union(v.number(), v.null()),
  counterparty: v.string(),
  source: v.union(supplierSourceValidator, v.null()),
  vehicleSource: v.optional(v.union(supplierSourceValidator, v.null())),
});
type Source = Infer<typeof supplierSourceValidator>;
type Context = Infer<typeof supplierRowContextValidator>;
type NavigationArgs = { orgId: Id<"organizations">; supplierId: Id<"suppliers">; permissions: readonly string[] };
type Obligation = Doc<"vehicleSupplierPayables"> | Doc<"vehicleSupplierReceivables"> | Doc<"supplierCostRecoveries">;

class NavigationBudgetExhausted extends Error {}

/** Every enrichment get spends the statement transaction's existing byte/document/range budget. */
async function owned<T extends TableNames>(ctx: QueryCtx, orgId: Id<"organizations">, id: Id<T>): Promise<Doc<T> | null> {
  if (!(await hasReadHeadroom(ctx))) throw new NavigationBudgetExhausted();
  const doc = await ctx.db.get(id);
  if (!doc || !("orgId" in doc) || doc.orgId !== orgId) return null;
  if ("isDeleted" in doc && doc.isDeleted) return null;
  return doc;
}

export function supplierVehicleLabel(vehicle: Pick<Doc<"vehicles">, "year" | "make" | "model">): string {
  return `${vehicle.year} ${vehicle.make} ${vehicle.model}`;
}

export function supplierVehicleHref(orgId: Id<"organizations">, vehicleId: Id<"vehicles">, permissions: readonly string[]): string | null {
  return permissions.includes(PERMISSIONS.VIEW_VEHICLES) ? `/${orgId}/vehicles?supplierVehicleId=${vehicleId}` : null;
}

async function readObligation(ctx: QueryCtx, args: NavigationArgs, row: { kind: ObligationKind; id: string }): Promise<Obligation | null> {
  if (row.kind === "PAYABLE") {
    const id = ctx.db.normalizeId("vehicleSupplierPayables", row.id);
    return id ? owned(ctx, args.orgId, id) : null;
  }
  if (row.kind === "RECEIVABLE") {
    const id = ctx.db.normalizeId("vehicleSupplierReceivables", row.id);
    return id ? owned(ctx, args.orgId, id) : null;
  }
  const id = ctx.db.normalizeId("supplierCostRecoveries", row.id);
  return id ? owned(ctx, args.orgId, id) : null;
}

async function saleSource(ctx: QueryCtx, args: NavigationArgs, saleId: Id<"sales">, vehicleLabel: string | null): Promise<Source | null> {
  const sale = await owned(ctx, args.orgId, saleId);
  if (!sale) return null;
  const canOpen = args.permissions.includes(PERMISSIONS.VIEW_SALES);
  const label = sale.dealNumber ? `#${sale.dealNumber} · ${vehicleLabel ?? sale._id}` : (vehicleLabel ?? sale._id);
  if (!sale.applicationId) return { kind: "SALE", id: sale._id, label, href: canOpen ? `/${args.orgId}/sales/${sale._id}/deal` : null };
  const app = await owned(ctx, args.orgId, sale.applicationId);
  if (!app) return { kind: "SALE", id: sale._id, label, href: null };
  return { kind: "APPLICATION", id: app._id, label, href: canOpen ? `/${args.orgId}/applications/${app._id}/deal` : null };
}

async function sourceFor(ctx: QueryCtx, args: NavigationArgs, obligation: Obligation): Promise<{ source: Source | null; vehicleSource?: Source | null }> {
  // P5 opening obligations have no vehicle. Never reinterpret them as a native obligation.
  if ("origin" in obligation && obligation.origin === "OPENING") {
    const draft = await owned(ctx, args.orgId, obligation.openingBalanceDraftId);
    if (!draft || draft.status !== "POSTED") return { source: null };
    const canOpen = args.permissions.includes(PERMISSIONS.MANAGE_FINANCE);
    return { source: { kind: "OPENING", id: draft._id, label: obligation.title, href: canOpen ? `/${args.orgId}/accounting?section=settings` : null } };
  }
  if (!("vehicleId" in obligation)) return { source: null };
  if ("expenseId" in obligation) {
    const expense = await owned(ctx, args.orgId, obligation.expenseId);
    if (!expense) return { source: null };
    const vehicle = await owned(ctx, args.orgId, obligation.vehicleId);
    // No individual expense screen exists. Keep its own label and link the recorded vehicle separately.
    return { source: { kind: "EXPENSE", id: expense._id, label: expense.title, href: null },
      vehicleSource: vehicle ? { kind: "VEHICLE", id: vehicle._id, label: supplierVehicleLabel(vehicle), href: supplierVehicleHref(args.orgId, vehicle._id, args.permissions) } : null };
  }
  const vehicle = await owned(ctx, args.orgId, obligation.vehicleId);
  if ("saleId" in obligation && obligation.saleId) return { source: await saleSource(ctx, args, obligation.saleId, vehicle ? supplierVehicleLabel(vehicle) : null) };
  return { source: vehicle ? { kind: "VEHICLE", id: vehicle._id, label: supplierVehicleLabel(vehicle), href: supplierVehicleHref(args.orgId, vehicle._id, args.permissions) } : null };
}

/** Public statement projection only; aging, alert and balance readers keep their existing contracts. */
export async function addSupplierRowContext<S extends {
  rows: Array<{ kind: ObligationKind; id: string }>; totals: unknown[]; complete: boolean; incompleteReason?: "ROW_LIMIT" | "READ_BUDGET";
}>(ctx: QueryCtx, args: NavigationArgs, section: S): Promise<Omit<S, "rows"> & { rows: Array<S["rows"][number] & { context: Context }> }> {
  const rows: Array<S["rows"][number] & { context: Context }> = [];
  let cut = false;
  for (const row of section.rows) {
    try {
      const obligation = await readObligation(ctx, args, row);
      if (!obligation || obligation.supplierId !== args.supplierId) {
        throw new Error("Supplier statement source identity changed");
      }
      const occurredAt = Number.isSafeInteger(obligation.createdAt) && Math.abs(obligation.createdAt) <= 8.64e15 ? obligation.createdAt : null;
      rows.push({ ...row, context: { role: row.kind === "PAYABLE" ? "AP" : "AR", occurredAt,
        counterparty: obligation.sourcedFromName, ...await sourceFor(ctx, args, obligation) } });
    } catch (error) {
      if (!(error instanceof NavigationBudgetExhausted)) throw error;
      cut = true;
      break;
    }
  }
  if (cut) return { ...section, rows, totals: [], complete: false, incompleteReason: "READ_BUDGET" as const };
  return { ...section, rows };
}

/** Stable, localized public code. Detailed source failures stay on the server. */
export function supplierNavigationFailure(error: unknown): never {
  console.error("Supplier navigation read failed", error);
  throw new ConvexError({ code: "SUPPLIER_NAVIGATION_UNAVAILABLE", message: "Supplier records could not be loaded. Please try again." });
}
