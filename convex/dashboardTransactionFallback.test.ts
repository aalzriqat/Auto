import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { stats } from "./dashboard";

/**
 * `dashboard.stats` reports sales from the `sales` table when the period has
 * any, and falls back to the `VEHICLE_SALE` transaction ledger only when it has
 * none. The fallback read was issued unconditionally, so every dashboard load
 * on an org that has sales paid for an index range plus the documents behind it
 * whose result every consumer then discarded.
 *
 * These tests pin the read itself rather than a byte count: the fallback query
 * must not be *issued* when sales exist, must still be issued when they do not,
 * and the figures the dashboard publishes must not move either way.
 */

const PERMISSIONS = [
  "view:vehicles",
  "view:sales",
  "view:expenses",
  "view:reports",
  "view:finance",
  "view:leads",
  "view:users",
  "view:tasks",
  "view:customers",
];

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Fallback Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_tf1", email: "tf@test.com", name: "Fallback User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "ADMIN", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "1HGCM82633A004352",
      make: "Honda",
      model: "Accord",
      year: 2020,
      mileage: 10000,
      color: "Black",
      fuelType: "Petrol",
      transmission: "Automatic",
      sellingPrice: 15000,
      purchasePrice: 10000,
      status: "SOLD",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Fall", lastName: "Back" })
  );
  const asUser = t.withIdentity({ subject: "user_tf1" });
  return { t, orgId, userId, vehicleId, customerId, asUser };
}

type StatsArgs = {
  orgId: string;
  timeRange: "DAY" | "MONTH" | "YEAR" | "ALL_TIME";
};

function passthrough(target: object, prop: string | symbol): unknown {
  const value = (target as Record<string | symbol, unknown>)[prop];
  return typeof value === "function"
    ? (value as (...args: unknown[]) => unknown).bind(target)
    : value;
}

/**
 * Runs the real `stats` handler against a context whose `db.query` is recorded,
 * so the assertion is about which index ranges the handler actually opened
 * rather than about a derived number that merely happens to be unchanged.
 */
async function tablesQueriedByStats(
  asUser: Awaited<ReturnType<typeof setup>>["asUser"],
  args: StatsArgs
): Promise<string[]> {
  const tables: string[] = [];
  // The registered wrapper warns whenever a Convex function is invoked
  // directly. That is precisely what this probe does on purpose, so the
  // warning is muted rather than left to pollute the suite output.
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await asUser.run(async (ctx) => {
      const realDb = ctx.db as unknown as object;
      const spyDb = new Proxy(realDb, {
        get(target, prop) {
          if (prop === "query") {
            const query = passthrough(target, prop) as (table: string) => unknown;
            return (table: string) => {
              tables.push(table);
              return query(table);
            };
          }
          return passthrough(target, prop);
        },
      });
      const spyCtx = new Proxy(ctx as unknown as object, {
        get(target, prop) {
          if (prop === "db") return spyDb;
          return passthrough(target, prop);
        },
      });
      await (stats as unknown as (c: unknown, a: unknown) => Promise<unknown>)(spyCtx, args);
    });
  } finally {
    warn.mockRestore();
  }
  return tables;
}

const countOf = (tables: string[], table: string) =>
  tables.filter((entry) => entry === table).length;

describe("dashboard.stats — VEHICLE_SALE transaction fallback", () => {
  test("does NOT read the transaction ledger when the period has sales", async () => {
    const { orgId, userId, vehicleId, customerId, asUser, t } = await setup();

    await t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId,
        vehicleId,
        customerId,
        salespersonId: userId,
        salePrice: 19600,
        saleDate: Date.now() - 60 * 60 * 1000,
        status: "COMPLETED",
      })
    );

    // ALL_TIME has no comparison window, so `stats` issues no previous-period
    // reads at all. Any `transactions` range here can only be the current
    // period's fallback — which is what this test is about.
    const tables = await tablesQueriedByStats(asUser, { orgId, timeRange: "ALL_TIME" });

    expect(tables).toContain("sales");
    expect(countOf(tables, "transactions")).toBe(0);
  });

  test("nor in a comparing window, when both periods have sales", async () => {
    const { orgId, userId, vehicleId, customerId, asUser, t } = await setup();
    const day = 24 * 60 * 60 * 1000;

    // One sale inside the current 30-day window, one inside the 30 before it.
    // The previous-period ledger read is already lazy (`previousUsesSaleRows`);
    // with both windows served by sale rows, `stats` must touch the ledger
    // exactly zero times.
    for (const saleDate of [Date.now() - day, Date.now() - 40 * day]) {
      await t.run((ctx) =>
        ctx.db.insert("sales", {
          orgId,
          vehicleId,
          customerId,
          salespersonId: userId,
          salePrice: 19600,
          saleDate,
          status: "COMPLETED",
        })
      );
    }

    const tables = await tablesQueriedByStats(asUser, { orgId, timeRange: "MONTH" });

    expect(countOf(tables, "sales")).toBeGreaterThan(0);
    expect(countOf(tables, "transactions")).toBe(0);
  });

  test("the published figures still come from the sales rows, ignoring the ledger", async () => {
    const { orgId, userId, vehicleId, customerId, asUser, t } = await setup();
    const saleDate = Date.now() - 60 * 60 * 1000;

    await t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId,
        vehicleId,
        customerId,
        salespersonId: userId,
        salePrice: 19600,
        saleDate,
        status: "COMPLETED",
      })
    );
    // A decoy the fallback would have picked up. If the sales path is ever
    // traded away for the ledger path, these numbers move and this fails.
    await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "IN",
        amount: 999999,
        date: saleDate,
        category: "VEHICLE_SALE",
        description: "decoy ledger row",
      })
    );

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "MONTH" });

    expect(result.salesThisMonth).toBe(1);
    expect(result.salesVolumeThisMonth).toBe(19600);
    expect(result.truncated.sales).toBe(false);
  });

  test("still reads the ledger, with identical values, when the period has no sales", async () => {
    const { orgId, asUser, t } = await setup();
    const when = Date.now() - 60 * 60 * 1000;

    await t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId,
        type: "IN",
        amount: 7500,
        date: when,
        category: "VEHICLE_SALE",
        description: "ledger-only sale",
      })
    );

    const tables = await tablesQueriedByStats(asUser, { orgId, timeRange: "ALL_TIME" });
    // The ledger IS consulted when the window has no sale rows. Live ledger rows
    // hold `isDeleted` unset or legacy `false`, read as one query each; one
    // unset row is under the cap, so both run. This counts `db.query` calls
    // only - it cannot show which index or range a query used, or the rows it
    // scanned.
    expect(countOf(tables, "transactions")).toBe(2);

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "ALL_TIME" });
    expect(result.salesThisMonth).toBe(1);
    expect(result.salesVolumeThisMonth).toBe(7500);
    expect(result.truncated.sales).toBe(false);
  });
});

/**
 * `truncated.sales` claims the published sales figures are incomplete. Whether
 * they are is a property of the READ that produced them, not of a row count:
 *
 * - Every window (DAY / MONTH / YEAR / ALL_TIME) reads at most SALES_CAP + 1
 *   rows. Exactly SALES_CAP rows is a complete window; only the extra row
 *   proves overflow. The SALES_CAP + 1 case, where the figures turn `null`, is
 *   covered in dashboardWindowCaps.test.ts.
 * - The fallback ledger has the same bound, and only counts while it is the
 *   authoritative source (no sale rows in the window).
 */
describe("dashboard.stats — truncated.sales is source-aware", () => {
  const SALES_CAP = 5000;

  async function seedSales(
    t: Awaited<ReturnType<typeof setup>>["t"],
    seeds: {
      orgId: Id<"organizations">;
      vehicleId: Id<"vehicles">;
      customerId: Id<"customers">;
      userId: Id<"users">;
    },
    count: number,
    saleDate: number
  ) {
    await t.run(async (ctx) => {
      for (let i = 0; i < count; i++) {
        await ctx.db.insert("sales", {
          orgId: seeds.orgId,
          vehicleId: seeds.vehicleId,
          customerId: seeds.customerId,
          salespersonId: seeds.userId,
          salePrice: 100,
          saleDate,
          status: "COMPLETED",
        });
      }
    });
  }

  async function seedLedger(
    t: Awaited<ReturnType<typeof setup>>["t"],
    orgId: Id<"organizations">,
    count: number,
    date: number
  ) {
    await t.run(async (ctx) => {
      for (let i = 0; i < count; i++) {
        await ctx.db.insert("transactions", {
          orgId,
          type: "IN",
          amount: 10,
          date,
          category: "VEHICLE_SALE",
          description: "ledger row",
        });
      }
    });
  }

  test("MONTH with exactly SALES_CAP sale rows is NOT truncated — collect read them all", async () => {
    const { orgId, userId, vehicleId, customerId, asUser, t } = await setup();
    await seedSales(
      t,
      { orgId, vehicleId, customerId, userId },
      SALES_CAP,
      Date.now() - 60 * 60 * 1000
    );

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "MONTH" });

    expect(result.salesThisMonth).toBe(SALES_CAP);
    expect(result.truncated.sales).toBe(false);
  });

  test("ALL_TIME with exactly SALES_CAP sale rows is NOT truncated — only CAP + 1 proves overflow", async () => {
    const { orgId, userId, vehicleId, customerId, asUser, t } = await setup();
    await seedSales(
      t,
      { orgId, vehicleId, customerId, userId },
      SALES_CAP,
      Date.now() - 60 * 60 * 1000
    );

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "ALL_TIME" });

    expect(result.salesThisMonth).toBe(SALES_CAP);
    expect(result.truncated.sales).toBe(false);
  });

  test("no sales and exactly SALES_CAP fallback ledger rows is NOT truncated", async () => {
    const { orgId, asUser, t } = await setup();
    await seedLedger(t, orgId, SALES_CAP, Date.now() - 60 * 60 * 1000);

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "MONTH" });

    expect(result.salesThisMonth).toBe(SALES_CAP);
    expect(result.truncated.sales).toBe(false);
  });

  test("sales present: a capped ledger is neither read nor allowed to set the flag", async () => {
    const { orgId, userId, vehicleId, customerId, asUser, t } = await setup();
    const when = Date.now() - 60 * 60 * 1000;
    await seedSales(t, { orgId, vehicleId, customerId, userId }, 3, when);
    await seedLedger(t, orgId, SALES_CAP, when);

    const tables = await tablesQueriedByStats(asUser, { orgId, timeRange: "ALL_TIME" });
    expect(countOf(tables, "transactions")).toBe(0);

    const result = await asUser.query(api.dashboard.stats, { orgId, timeRange: "ALL_TIME" });
    expect(result.salesThisMonth).toBe(3);
    expect(result.truncated.sales).toBe(false);
  });
});
