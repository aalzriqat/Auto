import type { Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { RESET_ORG_INDEX_FOR_TEST } from "../convex/orgFinancialReset";

/** Table names here are dynamic (driven by the reset's own table list), so the typed db is bypassed. */
export interface LooseDb {
  query(table: string): {
    withIndex(
      index: string,
      range: (q: { eq(field: string, value: unknown): unknown }) => unknown
    ): { collect(): Promise<Array<Record<string, unknown>>> };
  };
  get(id: unknown): Promise<unknown>;
}

/** Surviving rows of `table` for the org, read through the reset's own index. */
export async function rowsOf(db: LooseDb, table: string, orgId: Id<"organizations">) {
  return await db
    .query(table)
    .withIndex(RESET_ORG_INDEX_FOR_TEST[table], (q) => q.eq("orgId", orgId))
    .collect();
}

export interface Base {
  orgId: Id<"organizations">;
  userId: Id<"users">;
  vehicleId: Id<"vehicles">;
  customerId: Id<"customers">;
  now: number;
}

/** An org with the user, vehicle and customer every protected row needs. */
export async function seedBase(
  ctx: MutationCtx,
  tag: string,
  clerkPrefix: string,
  suspended = true
): Promise<Base> {
  const now = Date.now();
  const orgId = await ctx.db.insert("organizations", { name: tag, createdAt: now, suspended });
  const userId = await ctx.db.insert("users", {
    clerkId: `${clerkPrefix}${tag}`,
    email: `${tag.replace(/\s/g, "")}@x.com`,
  });
  const vehicleId = await ctx.db.insert("vehicles", {
    orgId, vin: `VIN${tag}`, make: "Kia", model: "Rio", year: 2024, mileage: 10,
    color: "Red", fuelType: "Gas", transmission: "Auto", sellingPrice: 15000,
    status: "AVAILABLE",
  });
  const customerId = await ctx.db.insert("customers", { orgId, firstName: "Refs", lastName: "Customer" });
  return { orgId, userId, vehicleId, customerId, now };
}
