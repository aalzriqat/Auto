import { ConvexError, v, type Infer } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { PERMISSIONS } from "./permissions";
import type { ObligationKind } from "./supplierObligationDue";
import type { SupplierObligation } from "./supplierSettledRows";
import { readCached, SupplierReadBudgetExhausted, type CachedTable, type SupplierReadCache } from "./supplierReadCache";
import { inTurn } from "./transactionReadHeadroom";

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
type NavigationArgs = { orgId: Id<"organizations">; permissions: readonly string[]; cache: SupplierReadCache };

/** Every enrichment get spends the statement transaction's existing byte/document/range budget. */
async function owned<T extends CachedTable>(ctx: QueryCtx, orgId: Id<"organizations">, cache: Map<Id<T>, Doc<T> | null>, id: Id<T>): Promise<Doc<T> | null> {
  const doc = await readCached(ctx, cache, id);
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

async function saleSource(ctx: QueryCtx, args: NavigationArgs, saleId: Id<"sales">, vehicleLabel: string | null): Promise<Source | null> {
  const sale = await owned(ctx, args.orgId, args.cache.sales, saleId);
  if (!sale) return null;
  const canOpen = args.permissions.includes(PERMISSIONS.VIEW_SALES);
  const label = sale.dealNumber ? `#${sale.dealNumber} · ${vehicleLabel ?? sale._id}` : (vehicleLabel ?? sale._id);
  if (!sale.applicationId) return { kind: "SALE", id: sale._id, label, href: canOpen ? `/${args.orgId}/sales/${sale._id}/deal` : null };
  const app = await owned(ctx, args.orgId, args.cache.applications, sale.applicationId);
  if (!app) return { kind: "SALE", id: sale._id, label, href: null };
  return { kind: "APPLICATION", id: app._id, label, href: canOpen ? `/${args.orgId}/applications/${app._id}/deal` : null };
}

function vehicleSource(args: NavigationArgs, vehicle: Doc<"vehicles"> | null): Source | null {
  return vehicle ? { kind: "VEHICLE", id: vehicle._id, label: supplierVehicleLabel(vehicle), href: supplierVehicleHref(args.orgId, vehicle._id, args.permissions) } : null;
}

async function sourceFor(ctx: QueryCtx, args: NavigationArgs, obligation: SupplierObligation): Promise<{ source: Source | null; vehicleSource?: Source | null }> {
  // P5 opening obligations have no vehicle. Never reinterpret them as a native obligation.
  if ("origin" in obligation && obligation.origin === "OPENING") {
    const draft = await owned(ctx, args.orgId, args.cache.openings, obligation.openingBalanceDraftId);
    if (draft?.status !== "POSTED") return { source: null };
    const canOpen = args.permissions.includes(PERMISSIONS.MANAGE_FINANCE);
    return { source: { kind: "OPENING", id: draft._id, label: obligation.title, href: canOpen ? `/${args.orgId}/accounting?section=settings` : null } };
  }
  if (!("vehicleId" in obligation)) return { source: null };
  if ("expenseId" in obligation) {
    const expense = await owned(ctx, args.orgId, args.cache.expenses, obligation.expenseId);
    if (!expense) return { source: null };
    const vehicle = await owned(ctx, args.orgId, args.cache.vehicles, obligation.vehicleId);
    // No individual expense screen exists. Keep its own label and link the recorded vehicle separately.
    return { source: { kind: "EXPENSE", id: expense._id, label: expense.title, href: null },
      vehicleSource: vehicleSource(args, vehicle) };
  }
  const vehicle = await owned(ctx, args.orgId, args.cache.vehicles, obligation.vehicleId);
  if ("saleId" in obligation && obligation.saleId) return { source: await saleSource(ctx, args, obligation.saleId, vehicle ? supplierVehicleLabel(vehicle) : null) };
  return { source: vehicleSource(args, vehicle) };
}

/** Public statement projection only; aging, alert and balance readers keep their existing contracts. */
export async function addSupplierRowContext<R extends { kind: ObligationKind; id: string; document: SupplierObligation }, S extends {
  totals: unknown[]; complete: boolean;
}>(ctx: QueryCtx, args: NavigationArgs, section: S & { rows: R[] }): Promise<Omit<S, "rows"> & { rows: Array<Omit<R, "document"> & { context: Context }> }> {
  const rows: Array<Omit<R, "document"> & { context: Context }> = [];
  await inTurn(section.rows, async entry => {
    // The money reader already holds the obligation in this query's consistent snapshot.
    const { document: obligation, ...row } = entry;
    const occurredAt = Number.isSafeInteger(obligation.createdAt) && Math.abs(obligation.createdAt) <= 8.64e15 ? obligation.createdAt : null;
    const context: Context = { role: row.kind === "PAYABLE" ? "AP" : "AR", occurredAt, counterparty: obligation.sourcedFromName, source: null, vehicleSource: null };
    try {
      Object.assign(context, await sourceFor(ctx, args, obligation));
    } catch (error) {
      if (!(error instanceof SupplierReadBudgetExhausted)) throw error;
    }
    rows.push({ ...row, context });
  });
  return { ...section, rows };
}

/** Stable, localized public code. Detailed source failures stay on the server. */
const READ_FAILURE_MESSAGE = {
  SUPPLIER_NAVIGATION_UNAVAILABLE: "Supplier records could not be loaded. Please try again.",
  SUPPLIER_ATTENTION_UNAVAILABLE: "Supplier attention could not be loaded. Please try again.",
};

export function supplierNavigationFailure(error: unknown, code: keyof typeof READ_FAILURE_MESSAGE = "SUPPLIER_NAVIGATION_UNAVAILABLE"): never {
  // Attention retains coded auth/plan refusals; raw stored-fact and infrastructure errors stay server-side.
  if (code === "SUPPLIER_ATTENTION_UNAVAILABLE" && error instanceof ConvexError &&
    typeof error.data === "object" && error.data !== null && "code" in error.data) throw error;
  console.error("Supplier navigation read failed", error);
  throw new ConvexError({ code, message: READ_FAILURE_MESSAGE[code] });
}
