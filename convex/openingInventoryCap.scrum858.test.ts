/**
 * SCRUM-858 S2 (owner ruling SCRUM-858#c23884, 2026-10-29): owned vehicle inventory opens per VIN at cost, and a
 * consigned (SOURCED) vehicle is never recognised as owned opening inventory.
 *
 * Two defects are pinned here:
 *  - G-C1: the opening read 101 vehicles over ALL the organization's vehicles and refused above 100, so a showroom
 *    with 60 owned and 45 consigned cars could not open at all. The cap must count only owned, unsold vehicles.
 *  - G-C2: a draft row naming a SOURCED vehicle failed only through a generic "proof conflicts" message. It now
 *    refuses early with a coded English and Arabic error.
 *
 * Every test drives the public mutations and queries. The harness is convex-test: serial, no OCC, so these prove
 * logic, not production concurrency.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const MODULE_GLOB = import.meta.glob("./**/*.ts");

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }), check: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

async function seed() {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Opening inventory org", createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() }),
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: "oi_owner", email: "oi_owner@test.com", name: "Owner" }));
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Owner",
      isSystemOwnerRole: true,
      permissions: ["manage:finance", "view:finance", "create:vehicles", "edit:vehicles", "view:vehicles", "view:cost_price", "view:reports"],
    }),
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] }));
  const owner = t.withIdentity({ subject: "oi_owner", clerkId: "oi_owner" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await owner.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(year, 0, 1),
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    fiscalYear: year,
    periodNumber: 1,
  });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId });
  await owner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const accounts = await owner.query(api.chartOfAccounts.list, { orgId, activeOnly: true });
  const accountId = (key: string) => {
    const found = accounts.find((row) => row.systemKey === key);
    if (!found) throw new Error(`Missing system account ${key}`);
    return found._id;
  };
  return { t, orgId, owner, accountId };
}
type Seed = Awaited<ReturnType<typeof seed>>;

const BASE_VEHICLE = {
  make: "Synthetic",
  model: "Cap",
  year: 2024,
  mileage: 0,
  color: "Gray",
  fuelType: "Petrol",
  transmission: "Automatic",
  sellingPrice: 20_000,
} as const;
const vin = (prefix: string, index: number) => `${prefix}${String(index).padStart(6, "0")}`;

/** Owned cars imported with durable opening evidence; cost is 8,000 JOD plus the index. */
async function importOwned(s: Seed, count: number, importId: string) {
  return s.owner.mutation(api.vehicles.importBulk, {
    orgId: s.orgId,
    acquisitionPosting: "OPENING_STOCK",
    importId,
    vehicles: Array.from({ length: count }, (_, index) => ({
      ...BASE_VEHICLE,
      rowId: index + 1,
      vin: vin("STOCKCAP", index + 1),
      purchasePrice: 8_000 + index,
      sourceType: "STOCK",
    })),
  });
}

/** Consigned cars. They carry a cost on purpose: a priced SOURCED car must still never count as owned. */
async function insertSourced(s: Seed, count: number, prefix = "SRCCAP") {
  const ids: Id<"vehicles">[] = [];
  for (let index = 0; index < count; index++) {
    ids.push(
      await s.t.run((ctx) =>
        ctx.db.insert("vehicles", {
          orgId: s.orgId,
          ...BASE_VEHICLE,
          vin: vin(prefix, index + 1),
          status: "AVAILABLE",
          sourceType: "SOURCED",
          sourcedFromName: "Synthetic consignor",
          sourceCost: 7_000,
          purchasePrice: 7_000,
        }),
      ),
    );
  }
  return ids;
}

async function insertSoldOwned(s: Seed, count: number) {
  for (let index = 0; index < count; index++) {
    await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId,
        ...BASE_VEHICLE,
        vin: vin("SOLDCAP", index + 1),
        status: "SOLD",
        sourceType: "STOCK",
        purchasePrice: 5_000,
      }),
    );
  }
}

async function ownedVehicles(s: Seed) {
  return s.t.run(async (ctx) =>
    (await ctx.db.query("vehicles").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect())
      .filter((vehicle) => vehicle.sourceType === "STOCK" && vehicle.status === "AVAILABLE" && vehicle.openingStockImportId !== undefined)
      .sort((a, b) => (a.vin ?? "").localeCompare(b.vin ?? "")),
  );
}

async function postOpening(s: Seed, owned: Awaited<ReturnType<typeof ownedVehicles>>) {
  const costs = owned.map((vehicle) => Math.round((vehicle.purchasePrice ?? 0) * 1000));
  const total = costs.reduce((sum, cost) => sum + cost, 0);
  const inventory = s.accountId("VEHICLE_INVENTORY");
  return s.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
    orgId: s.orgId,
    expectedCurrency: "JOD",
    asOfDate: Date.now(),
    lines: [
      { accountId: inventory, debitMinor: total, creditMinor: 0 },
      { accountId: s.accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: total },
    ],
    allocations: owned.map((vehicle, index) => ({
      kind: "VEHICLE_INVENTORY" as const,
      rowKey: `cap-${index + 1}`,
      accountId: inventory,
      vehicleId: vehicle._id,
      amountMinor: costs[index],
    })),
  });
}

async function writeCounts(s: Seed) {
  return s.t.run(async (ctx) => ({
    journals: (await ctx.db.query("journalEntries").collect()).length,
    lines: (await ctx.db.query("journalLines").collect()).length,
    drafts: (await ctx.db.query("openingBalanceDrafts").collect()).length,
    events: (await ctx.db.query("accountingEvents").collect()).length,
    marked: (await ctx.db.query("vehicles").collect()).filter((vehicle) => vehicle.openingBalanceDraftId !== undefined).length,
  }));
}

describe("SCRUM-858 S2 owned opening inventory", () => {
  test("sixty owned cars open when the organization also holds forty-five consigned and ten sold cars", async () => {
    const s = await seed();
    expect(await importOwned(s, 60, "cap-sixty")).toMatchObject({ inserted: 60, skipped: 0 });
    const sourcedIds = await insertSourced(s, 45);
    await insertSoldOwned(s, 10);
    const owned = await ownedVehicles(s);
    expect(owned).toHaveLength(60);

    await postOpening(s, owned);

    const expectedTotal = owned.reduce((sum, vehicle) => sum + Math.round((vehicle.purchasePrice ?? 0) * 1000), 0);
    const posted = await s.t.run(async (ctx) => {
      const header = (await ctx.db.query("openingBalanceDrafts").collect()).find((row) => row.status === "POSTED");
      const lines = await ctx.db
        .query("journalLines")
        .withIndex("by_org_account", (q) => q.eq("orgId", s.orgId).eq("accountId", s.accountId("VEHICLE_INVENTORY")))
        .collect();
      return {
        allocationCount: header?.allocations?.length,
        inventoryDebit: lines.reduce((sum, line) => sum + line.debitMinor - line.creditMinor, 0),
        sourced: await Promise.all(sourcedIds.map((id) => ctx.db.get(id))),
      };
    });
    // C-1: the control equals the sum of per-VIN cost, one allocation per owned car.
    expect(posted.allocationCount).toBe(60);
    expect(posted.inventoryDebit).toBe(expectedTotal);
    expect(await s.owner.query(api.accountingReports.vehicleInventoryReconciliation, { orgId: s.orgId })).toMatchObject({
      isReconciled: true,
      byCurrency: { JOD: { glBalanceMinor: expectedTotal, subledgerBalanceMinor: expectedTotal } },
    });
    // C-2: a consigned car has no opening marker and no share of the control.
    for (const vehicle of posted.sourced) {
      expect(vehicle?.openingBalanceDraftId).toBeUndefined();
      expect(vehicle?.openingStockImportId).toBeUndefined();
    }
  });

  test("exactly one hundred owned cars still open, the reviewed limit", async () => {
    const s = await seed();
    expect(await importOwned(s, 100, "cap-hundred")).toMatchObject({ inserted: 100, skipped: 0 });
    await insertSourced(s, 30);

    await postOpening(s, await ownedVehicles(s));

    expect(await s.t.run(async (ctx) => (await ctx.db.query("journalEntries").collect()).length)).toBe(1);
  });

  test("more than one hundred owned unsold cars refuse with the limit message before any write", async () => {
    const s = await seed();
    for (let index = 0; index < 101; index++) {
      await s.t.run((ctx) =>
        ctx.db.insert("vehicles", {
          orgId: s.orgId,
          ...BASE_VEHICLE,
          vin: vin("OVERCAP", index + 1),
          status: "AVAILABLE",
          sourceType: "STOCK",
          purchasePrice: 8_000,
        }),
      );
    }
    const before = await writeCounts(s);

    await expect(
      s.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
        orgId: s.orgId,
        expectedCurrency: "JOD",
        asOfDate: Date.now(),
        lines: [
          { accountId: s.accountId("VEHICLE_INVENTORY"), debitMinor: 1_000, creditMinor: 0 },
          { accountId: s.accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 1_000 },
        ],
      }),
    ).rejects.toThrow(/reviewed opening allocation limit/i);
    expect(await writeCounts(s)).toEqual(before);
  });

  test("an owned car with no sourceType (legacy row) is still counted and still needs its tracked import", async () => {
    const s = await seed();
    // A legacy owned row: sourceType was never written. It is owned stock, not consignment.
    await s.t.run((ctx) =>
      ctx.db.insert("vehicles", { orgId: s.orgId, ...BASE_VEHICLE, vin: vin("LEGACY", 1), status: "AVAILABLE", purchasePrice: 9_000 }),
    );
    const before = await writeCounts(s);

    await expect(
      s.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
        orgId: s.orgId,
        expectedCurrency: "JOD",
        asOfDate: Date.now(),
        lines: [
          { accountId: s.accountId("VEHICLE_INVENTORY"), debitMinor: 1_000, creditMinor: 0 },
          { accountId: s.accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 1_000 },
        ],
      }),
    ).rejects.toThrow(/tracked opening import/i);
    expect(await writeCounts(s)).toEqual(before);
  });

  test("an owned car held in repair or inspection is counted by the cap and by the tracked-import check", async () => {
    const s = await seed();
    await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId,
        ...BASE_VEHICLE,
        vin: vin("INREPAIR", 1),
        status: "IN_REPAIR",
        sourceType: "STOCK",
        purchasePrice: 9_000,
      }),
    );
    await expect(
      s.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
        orgId: s.orgId,
        expectedCurrency: "JOD",
        asOfDate: Date.now(),
        lines: [
          { accountId: s.accountId("VEHICLE_INVENTORY"), debitMinor: 1_000, creditMinor: 0 },
          { accountId: s.accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 1_000 },
        ],
      }),
    ).rejects.toThrow(/tracked opening import/i);
  });

  const unsoldStatuses = ["AVAILABLE", "RESERVED", "IN_INSPECTION", "IN_REPAIR", "ARCHIVED", "SOURCING"] as const;
  test.each(unsoldStatuses)("an owned costed car in status %s with no tracked import blocks the cutover", async (status) => {
    const s = await seed();
    await s.t.run((ctx) =>
      ctx.db.insert("vehicles", { orgId: s.orgId, ...BASE_VEHICLE, vin: vin("STATUS", 1), status, sourceType: "STOCK", purchasePrice: 9_000 }),
    );
    await expect(
      s.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
        orgId: s.orgId,
        expectedCurrency: "JOD",
        asOfDate: Date.now(),
        lines: [
          { accountId: s.accountId("VEHICLE_INVENTORY"), debitMinor: 1_000, creditMinor: 0 },
          { accountId: s.accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 1_000 },
        ],
      }),
    ).rejects.toThrow(/tracked opening import/i);
  });

  test("a soft-deleted costed owned car is not an owned car and does not block the cutover", async () => {
    const s = await seed();
    await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId,
        ...BASE_VEHICLE,
        vin: vin("DELETED", 1),
        status: "AVAILABLE",
        sourceType: "STOCK",
        purchasePrice: 9_000,
        isDeleted: true,
      }),
    );
    const message = await s.owner
      .mutation(api.accountingCutover.postOpeningBalanceDirect, {
        orgId: s.orgId,
        expectedCurrency: "JOD",
        asOfDate: Date.now(),
        lines: [
          { accountId: s.accountId("VEHICLE_INVENTORY"), debitMinor: 1_000, creditMinor: 0 },
          { accountId: s.accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 1_000 },
        ],
      })
      .then(() => "")
      .catch((error: unknown) => String((error as Error)?.message ?? error));
    expect(message).not.toMatch(/tracked opening import|allocation limit/i);
  });

  test("an owned car with no recorded cost needs no tracked import and does not block the cutover", async () => {
    const s = await seed();
    await s.t.run(async (ctx) => {
      await ctx.db.insert("vehicles", { orgId: s.orgId, ...BASE_VEHICLE, vin: vin("NOCOST", 1), status: "AVAILABLE", sourceType: "STOCK" });
      await ctx.db.insert("vehicles", { orgId: s.orgId, ...BASE_VEHICLE, vin: vin("NOCOST", 2), status: "AVAILABLE", sourceType: "STOCK", purchasePrice: 0 });
    });
    const message = await s.owner
      .mutation(api.accountingCutover.postOpeningBalanceDirect, {
        orgId: s.orgId,
        expectedCurrency: "JOD",
        asOfDate: Date.now(),
        lines: [
          { accountId: s.accountId("VEHICLE_INVENTORY"), debitMinor: 1_000, creditMinor: 0 },
          { accountId: s.accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 1_000 },
        ],
      })
      .then(() => "")
      .catch((error: unknown) => String((error as Error)?.message ?? error));
    expect(message).not.toMatch(/tracked opening import|allocation limit/i);
  });

  test("owned cars spread over several unsold statuses count together against the limit", async () => {
    const s = await seed();
    for (const [status, prefix] of [["AVAILABLE", "SPLITA"], ["IN_REPAIR", "SPLITR"]] as const) {
      for (let index = 0; index < 60; index++) {
        await s.t.run((ctx) =>
          ctx.db.insert("vehicles", { orgId: s.orgId, ...BASE_VEHICLE, vin: vin(prefix, index + 1), status, sourceType: "STOCK", purchasePrice: 8_000 }),
        );
      }
    }
    await expect(
      s.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
        orgId: s.orgId,
        expectedCurrency: "JOD",
        asOfDate: Date.now(),
        lines: [
          { accountId: s.accountId("VEHICLE_INVENTORY"), debitMinor: 1_000, creditMinor: 0 },
          { accountId: s.accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 1_000 },
        ],
      }),
    ).rejects.toThrow(/reviewed opening allocation limit/i);
  });

  test("a bucket crowded past the limit by soft-deleted rows fails closed instead of hiding an owned car", async () => {
    const s = await seed();
    for (let index = 0; index < 101; index++) {
      await s.t.run((ctx) =>
        ctx.db.insert("vehicles", {
          orgId: s.orgId,
          ...BASE_VEHICLE,
          vin: vin("CROWD", index + 1),
          status: "AVAILABLE",
          sourceType: "STOCK",
          purchasePrice: 8_000,
          isDeleted: true,
        }),
      );
    }
    await expect(
      s.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, {
        orgId: s.orgId,
        expectedCurrency: "JOD",
        asOfDate: Date.now(),
        lines: [
          { accountId: s.accountId("VEHICLE_INVENTORY"), debitMinor: 1_000, creditMinor: 0 },
          { accountId: s.accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: 1_000 },
        ],
      }),
    ).rejects.toThrow(/reviewed opening allocation limit/i);
  });
});

describe("SCRUM-858 S2 a consigned vehicle is never owned opening inventory", () => {
  async function sourcedRowAttempt(s: Seed, vehicleId: Id<"vehicles">, amountMinor: number) {
    const inventory = s.accountId("VEHICLE_INVENTORY");
    return {
      orgId: s.orgId,
      expectedCurrency: "JOD",
      asOfDate: Date.now(),
      lines: [
        { accountId: inventory, debitMinor: amountMinor, creditMinor: 0 },
        { accountId: s.accountId("RETAINED_EARNINGS"), debitMinor: 0, creditMinor: amountMinor },
      ],
      allocations: [{ kind: "VEHICLE_INVENTORY" as const, rowKey: "sourced-1", accountId: inventory, vehicleId, amountMinor }],
    };
  }

  test("a never-imported consigned car named in a direct post refuses with the coded error before any write", async () => {
    const s = await seed();
    const [sourcedId] = await insertSourced(s, 1);
    const before = await writeCounts(s);

    await expect(s.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, await sourcedRowAttempt(s, sourcedId, 7_000_000))).rejects.toMatchObject({
      data: { code: "OPENING_INVENTORY_SOURCED_REFUSED" },
    });
    expect(await writeCounts(s)).toEqual(before);
  });

  test("the same row refuses at draft time, so it never reaches an approver", async () => {
    const s = await seed();
    const [sourcedId] = await insertSourced(s, 1);
    const before = await writeCounts(s);

    await expect(s.owner.mutation(api.accountingCutover.draftOpeningBalance, await sourcedRowAttempt(s, sourcedId, 7_000_000))).rejects.toMatchObject({
      data: { code: "OPENING_INVENTORY_SOURCED_REFUSED" },
    });
    expect(await writeCounts(s)).toEqual(before);
  });

  test("an owned car with full import evidence that was later flipped to consigned refuses with the coded error", async () => {
    const s = await seed();
    await importOwned(s, 1, "cap-flip");
    const [vehicle] = await ownedVehicles(s);
    await s.t.run((ctx) => ctx.db.patch(vehicle._id, { sourceType: "SOURCED" }));
    const before = await writeCounts(s);

    await expect(s.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, await sourcedRowAttempt(s, vehicle._id, 8_000_000))).rejects.toMatchObject({
      data: { code: "OPENING_INVENTORY_SOURCED_REFUSED" },
    });
    expect(await writeCounts(s)).toEqual(before);
  });

  test("a consigned car of another organization stays a plain not-found, not a coded consignment answer", async () => {
    const s = await seed();
    const otherOrgId = await s.t.run((ctx) => ctx.db.insert("organizations", { name: "Other dealer", createdAt: Date.now() }));
    const foreignSourcedId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: otherOrgId,
        ...BASE_VEHICLE,
        vin: vin("FOREIGN", 1),
        status: "AVAILABLE",
        sourceType: "SOURCED",
        sourcedFromName: "Other consignor",
        sourceCost: 7_000,
      }),
    );

    await expect(s.owner.mutation(api.accountingCutover.postOpeningBalanceDirect, await sourcedRowAttempt(s, foreignSourcedId, 7_000_000))).rejects.not.toMatchObject({
      data: { code: "OPENING_INVENTORY_SOURCED_REFUSED" },
    });
  });
});

describe("SCRUM-858 S2 the opening vehicle shows in its native inventory screen", () => {
  test("an opened owned car lists with its cost and opening markers, and a consigned car does not", async () => {
    const s = await seed();
    await importOwned(s, 2, "cap-screen");
    const [sourcedId] = await insertSourced(s, 1);
    const owned = await ownedVehicles(s);
    await postOpening(s, owned);

    const listed = await s.owner.query(api.vehicles.list, { orgId: s.orgId, paginationOpts: { cursor: null, numItems: 20 } });
    const byVin = new Map(listed.page.map((vehicle) => [vehicle.vin, vehicle]));
    for (const vehicle of owned) {
      const row = byVin.get(vehicle.vin);
      expect(row?.purchasePrice).toBe(vehicle.purchasePrice);
      expect(row?.openingBalanceDraftId).toBeDefined();
      expect(row?.openingStockImportId).toBe("cap-screen");
    }
    const sourced = listed.page.find((vehicle) => vehicle._id === sourcedId);
    expect(sourced?.openingBalanceDraftId).toBeUndefined();
  });
});
