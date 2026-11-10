import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { hasReadHeadroom, type HeadroomCtx } from "./transactionReadHeadroom";

/** The money and decoration readers handle a spent budget independently. */
export class SupplierReadBudgetExhausted extends Error {}

export function createSupplierReadCache() {
  return {
    vehicles: new Map<Id<"vehicles">, Doc<"vehicles"> | null>(),
    sales: new Map<Id<"sales">, Doc<"sales"> | null>(),
    applications: new Map<Id<"financeApplications">, Doc<"financeApplications"> | null>(),
    expenses: new Map<Id<"expenses">, Doc<"expenses"> | null>(),
    openings: new Map<Id<"openingBalanceDrafts">, Doc<"openingBalanceDrafts"> | null>(),
  };
}
export type SupplierReadCache = ReturnType<typeof createSupplierReadCache>;
/** The source tables a statement row links to. Never a supplier table, so the supplier lock guard can prove it. */
export type CachedTable = "vehicles" | "sales" | "financeApplications" | "expenses" | "openingBalanceDrafts";

/** One query snapshot, one read per id, including missing documents. Headroom is charged only on a miss. */
export async function readCached<T extends CachedTable>(
  ctx: Pick<QueryCtx, "db"> & HeadroomCtx,
  cache: Map<Id<T>, Doc<T> | null>,
  id: Id<T>,
): Promise<Doc<T> | null> {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  if (!(await hasReadHeadroom(ctx))) throw new SupplierReadBudgetExhausted();
  const doc = await ctx.db.get(id);
  cache.set(id, doc);
  return doc;
}
