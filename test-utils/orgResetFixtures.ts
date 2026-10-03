import type { Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { RESET_ORG_INDEX_FOR_TEST } from "../convex/orgFinancialReset";
import { internal } from "../convex/_generated/api";
import { orgResetState } from "../convex/utils/orgResetGeneration";
import type { convexTestWithComponents } from "./convexTest";

type Harness = ReturnType<typeof convexTestWithComponents>;

/**
 * D-19 (SCRUM-565): fresh destructive resets are refused; only a reset that is
 * already in progress can continue. This puts an org into that state the way the
 * old first destructive batch did: `financialResetGeneration` moves to
 * `completed + 1`, `financialResetCompletedGeneration` is left alone. A no-op
 * when the org is already mid-reset or has no row.
 */
export async function beginInProgressReset(t: Harness, orgId: Id<"organizations">) {
  await t.run(async (ctx) => {
    const org = await ctx.db.get(orgId);
    if (org === null || orgResetState(org).inProgress) return;
    await ctx.db.patch(orgId, { financialResetGeneration: orgResetState(org).generation + 1 });
  });
}

/** One destructive batch, run as a continuation (the only destructive path D-19 leaves). */
export async function runContinuationBatch(t: Harness, orgId: Id<"organizations">, batchSize?: number) {
  await beginInProgressReset(t, orgId);
  return await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
    orgId,
    dryRun: false,
    ...(batchSize === undefined ? {} : { batchSize }),
  });
}

/**
 * Runs destructive reset batches until one reports `remaining === 0`. THROWS if
 * that never happens within `maxBatches`, so a reset that stalls fails loudly
 * instead of letting the test assert against a half-reset org. Seeds the
 * in-progress state first (D-19).
 */
export async function resetOrgToCompletion(
  t: Harness,
  orgId: Id<"organizations">,
  batchSize?: number,
  maxBatches = 40
) {
  await beginInProgressReset(t, orgId);
  for (let i = 0; i < maxBatches; i += 1) {
    const result = await t.mutation(internal.orgFinancialReset.resetOrgFinancialData, {
      orgId,
      dryRun: false,
      ...(batchSize === undefined ? {} : { batchSize }),
    });
    if (result.remaining === 0) return result;
  }
  throw new Error(`org financial reset did not reach remaining === 0 within ${maxBatches} batches`);
}

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
