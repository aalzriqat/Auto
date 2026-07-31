import { convexTestWithComponents } from "../test-utils/convexTest";
import { beforeEach, expect, test, vi } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

/**
 * Behaviour of the dashboard counts now that they are answered by
 * `@convex-dev/aggregate` B-trees rather than by reading rows.
 *
 * Every test here asserts a filter the *old row scan* applied, because that is
 * where an aggregate rewrite goes wrong: a `.filter()` is easy to read and
 * obvious when missing, whereas the same condition expressed as a key prefix
 * silently counts the wrong range if the key is laid out differently than the
 * reader assumes. `convex/vehicleAggregate.test.ts` covers the tree mechanics;
 * this file covers the query contracts built on top of them.
 */

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");
const NOW = 1_800_000_000_000;

/** A real VIN that passes its ISO 3779 check digit. */
const VALID_VIN = "1HGCM82633A004352";

const DASHBOARD_PERMISSIONS = [
  "view:vehicles",
  "view:leads",
  "view:users",
  "view:customers",
];

beforeEach(() => {
  process.env.CLERK_JWT_ISSUER_DOMAIN ??= "https://test.clerk.accounts.dev";
  process.env.NEXT_PUBLIC_APP_URL ??= "https://test.example.com";
});

function setup() {
  return convexTestWithComponents(schema, MODULES);
}

async function seedDealer(
  t: ReturnType<typeof setup>,
  opts: { clerkId?: string; name?: string } = {},
) {
  const clerkId = opts.clerkId ?? "dash_user";
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: opts.name ?? "Dashboard Motors", createdAt: NOW }),
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId, email: `${clerkId}@example.com`, name: "Dash User" }),
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: DASHBOARD_PERMISSIONS }),
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  return { orgId, roleId, asUser: t.withIdentity({ subject: clerkId, clerkId }) };
}

async function insertVehicle(
  t: ReturnType<typeof setup>,
  orgId: Id<"organizations">,
  overrides: {
    status?: string;
    sourceType?: "STOCK" | "SOURCED";
    isDeleted?: boolean;
    vin?: string;
    n?: number;
  } = {},
) {
  return await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      make: "Toyota",
      model: `Corolla ${overrides.n ?? 0}`,
      year: 2020,
      vin: overrides.vin ?? `VIN${String(overrides.n ?? 0).padStart(14, "0")}`,
      mileage: 1000,
      color: "White",
      fuelType: "PETROL",
      transmission: "AUTOMATIC",
      sellingPrice: 10000,
      status: (overrides.status ?? "AVAILABLE") as "AVAILABLE",
      createdAt: NOW,
      ...(overrides.sourceType ? { sourceType: overrides.sourceType } : {}),
      ...(overrides.isDeleted ? { isDeleted: true } : {}),
    }),
  );
}

async function insertLead(
  t: ReturnType<typeof setup>,
  orgId: Id<"organizations">,
  stage: string,
  opts: { isDeleted?: boolean } = {},
) {
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Lead", lastName: "Customer" }),
  );
  return await t.run((ctx) =>
    ctx.db.insert("leads", {
      orgId,
      customerId,
      source: "walk-in",
      stage: stage as "NEW",
      ...(opts.isDeleted ? { isDeleted: true } : {}),
    }),
  );
}

async function statsFor(t: ReturnType<typeof setup>, orgId: Id<"organizations">, asUser: ReturnType<ReturnType<typeof setup>["withIdentity"]>) {
  vi.setSystemTime(NOW);
  return await asUser.query(api.dashboard.stats, { orgId });
}

test("total vehicles counts own stock only, while the aging histogram still counts sourced cars", async () => {
  // The whole reason `sourcedFlag` was added to the vehicle sort key. These two
  // readers disagree on purpose: `stats` reports what the dealer holds, the
  // histogram reports every AVAILABLE car regardless of where it came from —
  // which is what its row scan did, since it never looked at `sourceType`.
  const t = setup();
  const { orgId, asUser } = await seedDealer(t);

  await insertVehicle(t, orgId, { n: 1, sourceType: "STOCK" });
  await insertVehicle(t, orgId, { n: 2 }); // sourceType absent — legacy own stock
  await insertVehicle(t, orgId, { n: 3, sourceType: "SOURCED" });

  const stats = await statsFor(t, orgId, asUser);
  expect(stats.totalVehicles).toBe(2);
  expect(stats.availableVehicles).toBe(2);

  vi.setSystemTime(NOW);
  const buckets = await asUser.query(api.vehicles.getAgingBuckets, { orgId });
  const histogramTotal = buckets.reduce((acc, b) => acc + b.count, 0);
  expect(histogramTotal).toBe(3);
});

test("available vehicles counts only the AVAILABLE status, not all own stock", async () => {
  const t = setup();
  const { orgId, asUser } = await seedDealer(t);

  await insertVehicle(t, orgId, { n: 1, status: "AVAILABLE" });
  await insertVehicle(t, orgId, { n: 2, status: "SOLD" });
  await insertVehicle(t, orgId, { n: 3, status: "IN_REPAIR" });

  const stats = await statsFor(t, orgId, asUser);
  expect(stats.totalVehicles).toBe(3);
  expect(stats.availableVehicles).toBe(1);
});

test("soft-deleted vehicles drop out of both dashboard vehicle counts", async () => {
  const t = setup();
  const { orgId, asUser } = await seedDealer(t);

  await insertVehicle(t, orgId, { n: 1 });
  await insertVehicle(t, orgId, { n: 2, isDeleted: true });

  const stats = await statsFor(t, orgId, asUser);
  expect(stats.totalVehicles).toBe(1);
  expect(stats.availableVehicles).toBe(1);
});

test("vehicle counts are per-org: another dealer's stock never leaks in", async () => {
  const t = setup();
  const { orgId, asUser } = await seedDealer(t);
  const other = await seedDealer(t, { clerkId: "other_user", name: "Other Motors" });

  await insertVehicle(t, orgId, { n: 1 });
  await insertVehicle(t, other.orgId, { n: 2 });
  await insertVehicle(t, other.orgId, { n: 3 });

  const stats = await statsFor(t, orgId, asUser);
  expect(stats.totalVehicles).toBe(1);
});

test("active leads excludes WON, LOST and soft-deleted leads", async () => {
  const t = setup();
  const { orgId, asUser } = await seedDealer(t);

  await insertLead(t, orgId, "NEW");
  await insertLead(t, orgId, "NEGOTIATION");
  await insertLead(t, orgId, "WON");
  await insertLead(t, orgId, "LOST");
  await insertLead(t, orgId, "CONTACTED", { isDeleted: true });

  const stats = await statsFor(t, orgId, asUser);
  expect(stats.activeLeads).toBe(2);
});

test("team members counts this org's memberships only", async () => {
  const t = setup();
  const { orgId, roleId, asUser } = await seedDealer(t);
  const other = await seedDealer(t, { clerkId: "other_user", name: "Other Motors" });

  // seedDealer already created one membership per org.
  const secondUser = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "second", email: "second@example.com", name: "Second" }),
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: secondUser, roleId }));

  const stats = await statsFor(t, orgId, asUser);
  expect(stats.teamMembers).toBe(2);

  const otherStats = await statsFor(t, other.orgId, other.asUser);
  expect(otherStats.teamMembers).toBe(1);
});

test("data-quality counts ignore soft-deleted customers and vehicles", async () => {
  // The row scan filtered `isDeleted`; the aggregate expresses the same thing
  // as the LIVE prefix of the key. A deleted row still sits in the tree.
  const t = setup();
  const { orgId, asUser } = await seedDealer(t);

  await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Live", lastName: "NoPhone" }),
  );
  await t.run((ctx) =>
    ctx.db.insert("customers", {
      orgId,
      firstName: "Deleted",
      lastName: "NoPhone",
      isDeleted: true,
    }),
  );

  // "NONNAVINNOCHECKSUM" is the invalid-checksum VIN the existing
  // dataQualityStats test uses.
  await insertVehicle(t, orgId, { n: 1, vin: "NONNAVINNOCHECKSUM" });
  await insertVehicle(t, orgId, { n: 2, vin: "NONNAVINNOCHECKSUM", isDeleted: true });

  const quality = await asUser.query(api.dashboard.dataQualityStats, { orgId });
  expect(quality.customersMissingPhone).toBe(1);
  expect(quality.customersMissingEmail).toBe(1);
  expect(quality.vehiclesWithVinWarning).toBe(1);
});

test("an empty string counts as a missing phone or email, matching the old falsy check", async () => {
  const t = setup();
  const { orgId, asUser } = await seedDealer(t);

  await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Blank", lastName: "Fields", phone: "", email: "" }),
  );

  const quality = await asUser.query(api.dashboard.dataQualityStats, { orgId });
  expect(quality.customersMissingPhone).toBe(1);
  expect(quality.customersMissingEmail).toBe(1);
});

test("the customer/lead/membership backfills seed rows their trees have never seen", async () => {
  // `runUnwrapped` writes without firing the triggers, which is exactly the
  // state a deployment is in the moment these components ship: rows in the
  // table, nothing in the tree.
  const t = setup();
  const { orgId, roleId, asUser } = await seedDealer(t);

  const strandedCustomer = await t.runUnwrapped((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Stranded", lastName: "Customer" }),
  );
  await t.runUnwrapped(async (ctx) => {
    await ctx.db.insert("leads", {
      orgId,
      customerId: strandedCustomer,
      source: "walk-in",
      stage: "NEW" as const,
    });
    const u = await ctx.db.insert("users", {
      clerkId: "stranded",
      email: "stranded@example.com",
      name: "Stranded",
    });
    await ctx.db.insert("memberships", { orgId, userId: u, roleId });
  });

  // Invisible until backfilled — the trees only saw seedDealer's own writes.
  const before = await statsFor(t, orgId, asUser);
  expect(before.activeLeads).toBe(0);
  expect(before.teamMembers).toBe(1);

  await t.mutation(internal.migrations.backfillCustomerAggregate, { continueAutomatically: false });
  await t.mutation(internal.migrations.backfillLeadAggregate, { continueAutomatically: false });
  await t.mutation(internal.migrations.backfillMembershipAggregate, {
    continueAutomatically: false,
  });

  const after = await statsFor(t, orgId, asUser);
  expect(after.activeLeads).toBe(1);
  expect(after.teamMembers).toBe(2);

  const quality = await asUser.query(api.dashboard.dataQualityStats, { orgId });
  expect(quality.customersMissingPhone).toBe(1);

  // Idempotent: a redrive must not double-count.
  await t.mutation(internal.migrations.backfillCustomerAggregate, { continueAutomatically: false });
  await t.mutation(internal.migrations.backfillLeadAggregate, { continueAutomatically: false });
  await t.mutation(internal.migrations.backfillMembershipAggregate, {
    continueAutomatically: false,
  });

  const redriven = await statsFor(t, orgId, asUser);
  expect(redriven.activeLeads).toBe(1);
  expect(redriven.teamMembers).toBe(2);
});

test("rebuildVehicleAggregates clears both vehicle trees and re-seeds them", async () => {
  // The migration a deployment needs after `sourcedFlag` changed the key:
  // `insertIfDoesNotExist` cannot fix a row already stored under a stale key,
  // so the rebuild has to clear first.
  vi.useFakeTimers();
  const t = setup();
  const { orgId, asUser } = await seedDealer(t);

  // `insertVehicle`'s default synthetic VIN ("VIN0000000000000N") does NOT pass
  // the check digit, so spell out a valid one where the count must not include
  // the row — otherwise this asserts 3 of 3 and stops discriminating.
  await insertVehicle(t, orgId, { n: 1, vin: VALID_VIN });
  await insertVehicle(t, orgId, { n: 2, sourceType: "SOURCED", vin: VALID_VIN });
  await insertVehicle(t, orgId, { n: 3, vin: "NONNAVINNOCHECKSUM" });

  await t.mutation(internal.migrations.rebuildVehicleAggregates, {});
  await t.finishAllScheduledFunctions(vi.runAllTimers);

  const stats = await statsFor(t, orgId, asUser);
  expect(stats.totalVehicles).toBe(2);

  const quality = await asUser.query(api.dashboard.dataQualityStats, { orgId });
  expect(quality.vehiclesWithVinWarning).toBe(1);
  vi.useRealTimers();
});
