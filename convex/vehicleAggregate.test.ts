import { convexTestWithComponents } from "../test-utils/convexTest";
import { beforeEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

beforeEach(() => {
  process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
});

function setup() {
  return convexTestWithComponents(schema, MODULES);
}

/** An identity-bound client — narrower than `t`: no withIdentity/registerComponent. */
type AsUser = ReturnType<ReturnType<typeof setup>["withIdentity"]>;

async function seedDealer(t: ReturnType<typeof setup>) {
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Aggregate Motors", createdAt: NOW }),
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "agg_user", email: "agg@example.com", name: "Agg User" }),
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Owner",
      permissions: ["view:vehicles", "create:vehicles", "delete:vehicles"],
    }),
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return { orgId, asUser: t.withIdentity({ subject: "agg_user", clerkId: "agg_user" }) };
}

/**
 * Writes a vehicle row directly, then seeds the tree with the production
 * backfill. This is how a deployment that predates the component gets its
 * counts, and it is the only way to place a row at an exact age — the real
 * `create` mutation stamps `createdAt` with `Date.now()` itself.
 */
async function seedVehicles(
  t: ReturnType<typeof setup>,
  rows: Array<{
    orgId: Id<"organizations">;
    ageDays: number;
    status?: string;
    isDeleted?: boolean;
  }>,
) {
  const ids: Id<"vehicles">[] = [];
  await t.run(async (ctx) => {
    let n = 0;
    for (const row of rows) {
      ids.push(
        await ctx.db.insert("vehicles", {
          orgId: row.orgId,
          make: "Toyota",
          model: `Corolla ${n}`,
          year: 2020,
          vin: `VIN${String(n).padStart(14, "0")}`,
          mileage: 1000,
          color: "White",
          fuelType: "PETROL",
          transmission: "AUTOMATIC",
          sellingPrice: 10000,
          sourceType: "STOCK" as const,
          status: (row.status ?? "AVAILABLE") as "AVAILABLE",
          createdAt: NOW - row.ageDays * DAY_MS,
          ...(row.isDeleted ? { isDeleted: true } : {}),
        }),
      );
      n++;
    }
  });
  await drainBackfill(t);
  return ids;
}

async function drainBackfill(t: ReturnType<typeof setup>, batchSize?: number) {
  let cursor: string | null | undefined = undefined;
  let batches = 0;
  for (;;) {
    const page: { isDone: boolean; continueCursor: string | null; migrated: number } =
      await t.mutation(internal.migrations.backfillVehicleAggregate, {
        ...(cursor === undefined ? {} : { cursor }),
        ...(batchSize === undefined ? {} : { batchSize }),
      });
    batches++;
    if (page.isDone) return batches;
    cursor = page.continueCursor;
    if (batches > 50) throw new Error("backfill did not terminate");
  }
}

async function bucketCounts(asUser: AsUser, orgId: Id<"organizations">) {
  vi.setSystemTime(NOW);
  const rows = await asUser.query(api.vehicles.getAgingBuckets, { orgId });
  return Object.fromEntries(rows.map((r) => [r.bucket, r.count])) as Record<string, number>;
}

test("age buckets match the row-scan boundaries exactly, including both edges", async () => {
  vi.useFakeTimers();
  const t = setup();
  const { orgId, asUser } = await seedDealer(t);

  // One vehicle on each side of every boundary the floor()-based row scan used.
  await seedVehicles(
    t,
    [0, 30, 31, 60, 61, 90, 91, 400].map((ageDays) => ({ orgId, ageDays })),
  );

  expect(await bucketCounts(asUser, orgId)).toEqual({
    "0-30": 2, // ages 0, 30
    "31-60": 2, // ages 31, 60
    "61-90": 2, // ages 61, 90
    "90+": 2, // ages 91, 400
  });
  vi.useRealTimers();
});

test("only live AVAILABLE vehicles are counted", async () => {
  vi.useFakeTimers();
  const t = setup();
  const { orgId, asUser } = await seedDealer(t);

  await seedVehicles(t, [
    { orgId, ageDays: 10 },
    { orgId, ageDays: 10, status: "SOLD" },
    { orgId, ageDays: 10, isDeleted: true },
  ]);

  expect(await bucketCounts(asUser, orgId)).toEqual({
    "0-30": 1,
    "31-60": 0,
    "61-90": 0,
    "90+": 0,
  });
  vi.useRealTimers();
});

test("counts are per-org: another org's vehicles never leak in", async () => {
  vi.useFakeTimers();
  const t = setup();
  const { orgId, asUser } = await seedDealer(t);
  const otherOrgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Other Motors", createdAt: NOW }),
  );

  await seedVehicles(t, [
    { orgId, ageDays: 5 },
    { orgId: otherOrgId, ageDays: 5 },
    { orgId: otherOrgId, ageDays: 5 },
  ]);

  expect((await bucketCounts(asUser, orgId))["0-30"]).toBe(1);
  vi.useRealTimers();
});

test("avgDays reflects the mean age within a bucket, and empty buckets are zero not NaN", async () => {
  vi.useFakeTimers();
  const t = setup();
  const { orgId, asUser } = await seedDealer(t);

  await seedVehicles(t, [
    { orgId, ageDays: 10 },
    { orgId, ageDays: 20 },
  ]);

  vi.setSystemTime(NOW);
  const rows = await asUser.query(api.vehicles.getAgingBuckets, { orgId });

  expect(rows).toHaveLength(4);
  expect(rows.find((r) => r.bucket === "0-30")).toEqual({
    bucket: "0-30",
    count: 2,
    avgDays: 15,
  });
  for (const row of rows.filter((r) => r.bucket !== "0-30")) {
    expect(row.count).toBe(0);
    expect(row.avgDays).toBe(0);
  }
  vi.useRealTimers();
});

test("a real softDelete mutation takes the vehicle out of the counts", async () => {
  vi.useFakeTimers();
  const t = setup();
  const { orgId, asUser } = await seedDealer(t);
  const [vehicleId] = await seedVehicles(t, [{ orgId, ageDays: 5 }]);

  expect((await bucketCounts(asUser, orgId))["0-30"]).toBe(1);

  // The production write path, not a hand-rolled patch. A soft delete is a
  // patch rather than a delete, which is exactly the case where a trigger that
  // only handles insert/delete leaves the tree counting a row the app treats as
  // gone.
  await asUser.mutation(api.vehicles.softDelete, { orgId, vehicleId });

  expect((await bucketCounts(asUser, orgId))["0-30"]).toBe(0);
  vi.useRealTimers();
});

test("the backfill is idempotent and pages past a single batch", async () => {
  vi.useFakeTimers();
  const t = setup();
  const { orgId, asUser } = await seedDealer(t);

  await seedVehicles(
    t,
    Array.from({ length: 5 }, () => ({ orgId, ageDays: 5 })),
  );
  expect((await bucketCounts(asUser, orgId))["0-30"]).toBe(5);

  // Re-running the whole migration must not double-count.
  await drainBackfill(t);
  expect((await bucketCounts(asUser, orgId))["0-30"]).toBe(5);

  // And it must actually page rather than stopping after the first batch.
  const batches = await drainBackfill(t, 2);
  expect(batches).toBeGreaterThan(1);
  expect((await bucketCounts(asUser, orgId))["0-30"]).toBe(5);
  vi.useRealTimers();
});
