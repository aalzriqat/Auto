import type { Id } from "../convex/_generated/dataModel";
import type { MutationCtx } from "../convex/_generated/server";
import { normalizeNameKey } from "../convex/utils/supplierNames";
import type { convexTestWithComponents } from "./convexTest";

/**
 * A supplier master row for suites that exercise a vehicle or money path (SCRUM-868 P2).
 *
 * It inserts the row directly instead of going through `api.suppliers.create`: those suites build
 * their own organization and never initialise the registry lock, and what they need is "an id the
 * server can resolve", not a second test of the registry. The row has exactly the fields
 * `suppliers.create` writes. Lives outside `convex/` on purpose: nothing here ships, and the
 * supplier-master write guard (scripts/supplierMasterGuards.test.ts) scans production sources only.
 */
export async function seedSupplier(
  t: ReturnType<typeof convexTestWithComponents>,
  options: {
    orgId: Id<"organizations">;
    userId: Id<"users">;
    displayName: string;
    status?: "ACTIVE" | "INACTIVE";
    version?: number;
  }
): Promise<Id<"suppliers">> {
  const now = Date.now();
  return await t.run(async (ctx) =>
    ctx.db.insert("suppliers", {
      orgId: options.orgId,
      displayName: options.displayName,
      displayNameKey: normalizeNameKey(options.displayName),
      status: options.status ?? "ACTIVE",
      version: options.version ?? 1,
      origin: "MANUAL",
      createdBy: options.userId,
      createdAt: now,
      updatedBy: options.userId,
      updatedAt: now,
    })
  );
}

/** Renames a supplier master row in place, the way a real rename would (name and version move together). */
export async function renameSupplier(
  t: ReturnType<typeof convexTestWithComponents>,
  supplierId: Id<"suppliers">,
  displayName: string
): Promise<void> {
  await t.run(async (ctx) => {
    const row = await ctx.db.get(supplierId);
    if (!row) throw new Error("supplier missing");
    await ctx.db.patch(supplierId, {
      displayName,
      displayNameKey: normalizeNameKey(displayName),
      version: row.version + 1,
    });
  });
}

/**
 * The supplier in `orgId` named `displayName`, created on first use. For the many suites that
 * used to pass a supplier NAME to a vehicle write: they now pass `await supplierIdFor(...)` and
 * keep their stated name. Repeated calls with the same name return the same row, so one
 * supplier stays one supplier across the steps of a test. Any user stands in as the author
 * (these rows are fixtures; the audit field only needs a real user id).
 */
export async function supplierIdFor(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: Id<"organizations">,
  displayName: string
): Promise<Id<"suppliers">> {
  return await t.run((ctx) => supplierIdInCtx(ctx, orgId, displayName));
}

/**
 * `supplierIdFor` for a fixture that is already inside `t.run(async (ctx) => ...)`, e.g. one that
 * inserts a SOURCED vehicle in the same call: `sourcedSupplierId: await supplierIdInCtx(ctx, orgId, name)`.
 * Sale completion refuses a SOURCED car without a resolvable supplier id (SCRUM-868 P3), so a
 * fixture that sells one needs this row.
 */
export async function supplierIdInCtx(
  ctx: Pick<MutationCtx, "db">,
  orgId: Id<"organizations">,
  displayName: string
): Promise<Id<"suppliers">> {
  const nameKey = normalizeNameKey(displayName);
  // A fixture scan (tests hold a handful of suppliers); the production index is not needed here.
  const existing = (await ctx.db.query("suppliers").take(500)).find(
    (row) => row.orgId === orgId && row.displayNameKey === nameKey
  );
  if (existing) return existing._id;
  const author = await ctx.db.query("users").first();
  if (!author) throw new Error("supplierIdFor needs a seeded user");
  const now = Date.now();
  return await ctx.db.insert("suppliers", {
    orgId,
    displayName,
    displayNameKey: nameKey,
    status: "ACTIVE",
    version: 1,
    origin: "MANUAL",
    createdBy: author._id,
    createdAt: now,
    updatedBy: author._id,
    updatedAt: now,
  });
}