import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, describe, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { stats } from "./dashboard";

/**
 * DAY and MONTH compute a second, equally expensive accounting window so the
 * client can render deltas. The web dashboard defaults to MONTH and never reads
 * `previousPeriod` — every consumer of that field is in apps/mobile. So the
 * comparison window is measured, assembled and returned to a caller that throws
 * it away, on every dashboard load.
 *
 * `includePreviousPeriod` lets a caller decline that work. It defaults to true,
 * so mobile and every existing caller keep their current behaviour untouched.
 *
 * ⚠️ On this branch NO caller sends it — the web opt-out is Phase 2, gated on
 * the argument being live in production. These tests therefore exercise the
 * argument directly rather than through any client, which is the only way to
 * cover behaviour that no caller reaches yet.
 *
 * These tests pin the reads themselves via the same context spy used for the
 * sale-ledger fallback, rather than a byte count.
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

const DAY = 24 * 60 * 60 * 1000;

async function setup() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Prev Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_pp1", email: "pp@test.com", name: "Prev User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "ADMIN", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Prev", lastName: "Customer" })
  );

  // Sales in BOTH the current 30-day window and the 30 before it, so the
  // comparison window has real work to do and skipping it is observable.
  for (let i = 0; i < 4; i++) {
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "VINPREVPERIOD00" + i,
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
    await t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId,
        vehicleId,
        customerId,
        salespersonId: userId,
        salePrice: 19600,
        saleDate: Date.now() - (i < 2 ? 1 : 40) * DAY,
        status: "COMPLETED",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("expenses", {
        orgId,
        vehicleId,
        title: "Detailing",
        amount: 100,
        date: Date.now() - (i < 2 ? 1 : 40) * DAY,
        category: "MAINTENANCE",
      })
    );
  }

  const asUser = t.withIdentity({ subject: "user_pp1" });
  return { t, orgId, asUser };
}

type StatsArgs = {
  orgId: string;
  timeRange: "DAY" | "MONTH" | "YEAR" | "ALL_TIME";
  includePreviousPeriod?: boolean;
};

function passthrough(target: object, prop: string | symbol): unknown {
  const value = (target as Record<string | symbol, unknown>)[prop];
  return typeof value === "function"
    ? (value as (...args: unknown[]) => unknown).bind(target)
    : value;
}

async function tablesQueriedByStats(
  asUser: Awaited<ReturnType<typeof setup>>["asUser"],
  args: StatsArgs
): Promise<string[]> {
  const tables: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await asUser.run(async (ctx) => {
      const spyDb = new Proxy(ctx.db as unknown as object, {
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

describe("dashboard.stats — includePreviousPeriod", () => {
  test("issues NO previous-period reads when the caller declines them", async () => {
    const { orgId, asUser } = await setup();

    const withPrevious = await tablesQueriedByStats(asUser, {
      orgId,
      timeRange: "MONTH",
    });
    const withoutPrevious = await tablesQueriedByStats(asUser, {
      orgId,
      timeRange: "MONTH",
      includePreviousPeriod: false,
    });

    // The comparison window costs a second sales range and a second expenses
    // range, plus the per-vehicle costing fan-out behind it.
    expect(countOf(withPrevious, "sales")).toBe(2);
    expect(countOf(withoutPrevious, "sales")).toBe(1);
    expect(countOf(withoutPrevious, "expenses")).toBeLessThan(
      countOf(withPrevious, "expenses")
    );
    expect(withoutPrevious.length).toBeLessThan(withPrevious.length);
  });

  test("defaults to including it, so existing callers are untouched", async () => {
    const { orgId, asUser } = await setup();

    const defaulted = await tablesQueriedByStats(asUser, { orgId, timeRange: "MONTH" });
    const explicitTrue = await tablesQueriedByStats(asUser, {
      orgId,
      timeRange: "MONTH",
      includePreviousPeriod: true,
    });

    expect(defaulted).toEqual(explicitTrue);

    const result = await asUser.query(api.dashboard.stats, {
      orgId,
      timeRange: "MONTH",
      includePreviousPeriod: true,
    });
    expect(result.previousPeriod).toBeDefined();
  });

  test("every current-period figure is identical either way", async () => {
    const { orgId, asUser } = await setup();

    const withPrevious = await asUser.query(api.dashboard.stats, {
      orgId,
      timeRange: "MONTH",
    });
    const withoutPrevious = await asUser.query(api.dashboard.stats, {
      orgId,
      timeRange: "MONTH",
      includePreviousPeriod: false,
    });

    expect(withoutPrevious.previousPeriod).toBeUndefined();
    expect(withPrevious.previousPeriod).toBeDefined();

    // Everything the current period publishes must be untouched by the flag.
    const stripPrevious = (value: Record<string, unknown>) => {
      const copy = { ...value };
      delete copy.previousPeriod;
      return copy;
    };
    expect(stripPrevious(withoutPrevious as unknown as Record<string, unknown>)).toEqual(
      stripPrevious(withPrevious as unknown as Record<string, unknown>)
    );
  });
});

/**
 * The incompleteness markers deliberately fold BOTH windows together:
 *
 *   profit:   profitIncomplete || previousUnknownMarginExcluded
 *   turnover: turnoverTruncated || previousTurnoverTruncated
 *             || unknownMarginExcluded || previousUnknownMarginExcluded
 *
 * That is right when the comparison window was asked for — a delta computed
 * against a window with unestablished earnings is not a fact about the
 * business. It is wrong when the caller declined that window: an unrequested
 * period must have no influence at all, or the web dashboard inherits a
 * "your figures are incomplete" marker from a month it never asked about.
 *
 * The strict deep-equality test above cannot prove this, because in its fixture
 * `previousUnknownMarginExcluded` is false either way. This one makes the
 * previous window genuinely unknown, so the two answers must diverge.
 */
describe("dashboard.stats — an unrequested previous window cannot pollute the markers", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  /**
   * A consigned sale whose earning cannot be established: settled directly with
   * the supplier and financed (so `needsFrozenMarginEvidence` holds), carrying
   * no frozen consigned margin, against a SOURCED vehicle. That is precisely
   * the shape `earningIsUnknownGiven` refuses to guess at.
   */
  async function seedUnknownEarningConsignedSale(
    t: Awaited<ReturnType<typeof setup>>["t"],
    orgId: string,
    customerId: string,
    userId: string,
    saleDate: number
  ) {
    const vehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "VINCONSIGNEDUNK1",
        make: "Toyota",
        model: "Camry",
        year: 2021,
        mileage: 5000,
        color: "White",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 22000,
        status: "SOLD",
        sourceType: "SOURCED",
        sourcedFromName: "Amman Importer Co",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId,
        vehicleId,
        customerId,
        salespersonId: userId,
        salePrice: 22000,
        saleDate,
        status: "COMPLETED",
        financingType: "FINANCED",
        supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
        // No consignedMarginMinor/Currency: nothing was frozen, so the
        // dealership's earning on this deal is not established.
      })
    );
  }

  async function seedBothWindows() {
    const base = await setup();
    const { t, orgId } = base;
    const userId = await t.run(async (ctx) => {
      const membership = await ctx.db
        .query("memberships")
        .filter((q) => q.eq(q.field("orgId"), orgId))
        .first();
      return membership!.userId;
    });
    const customerId = await t.run((ctx) =>
      ctx.db.insert("customers", { orgId, firstName: "Win", lastName: "Dow" })
    );

    // Current window: an ordinary, fully-known owned sale.
    const ownedVehicleId = await t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId,
        vin: "VINOWNEDKNOWN001",
        make: "Honda",
        model: "Civic",
        year: 2022,
        mileage: 1000,
        color: "Blue",
        fuelType: "Petrol",
        transmission: "Automatic",
        sellingPrice: 18000,
        purchasePrice: 12000,
        status: "SOLD",
      })
    );
    await t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId,
        vehicleId: ownedVehicleId,
        customerId,
        salespersonId: userId,
        salePrice: 18000,
        saleDate: Date.now() - 1 * DAY_MS,
        status: "COMPLETED",
      })
    );

    // Previous window: the consigned sale whose earning is unknown.
    await seedUnknownEarningConsignedSale(
      t,
      orgId,
      customerId,
      userId,
      Date.now() - 40 * DAY_MS
    );

    return base;
  }

  test("with the window requested, the previous period's unknown earning is reported", async () => {
    const { orgId, asUser } = await seedBothWindows();

    const result = await asUser.query(api.dashboard.stats, {
      orgId,
      timeRange: "MONTH",
      includePreviousPeriod: true,
    });

    // The current window is complete on its own; the marker that is set comes
    // from the comparison window, and the delta is withheld rather than
    // published against an unestablished basis.
    expect(result.truncated.profit).toBe(true);
    expect(result.previousPeriod?.netProfit).toBeUndefined();
  });

  test("with the window declined, it influences neither the reads nor the markers", async () => {
    const { orgId, asUser } = await seedBothWindows();

    const tables = await tablesQueriedByStats(asUser, {
      orgId,
      timeRange: "MONTH",
      includePreviousPeriod: false,
    });
    // Only the current window's sales range - the comparison window is not read.
    expect(countOf(tables, "sales")).toBe(1);

    const declined = await asUser.query(api.dashboard.stats, {
      orgId,
      timeRange: "MONTH",
      includePreviousPeriod: false,
    });
    const requested = await asUser.query(api.dashboard.stats, {
      orgId,
      timeRange: "MONTH",
      includePreviousPeriod: true,
    });

    expect(declined.previousPeriod).toBeUndefined();

    // The current period is unchanged...
    expect(declined.salesThisMonth).toBe(requested.salesThisMonth);
    expect(declined.salesVolumeThisMonth).toBe(requested.salesVolumeThisMonth);
    expect(declined.grossTransactionValueThisMonth).toBe(
      requested.grossTransactionValueThisMonth
    );

    // ...and the markers now describe only the window that was asked for.
    expect(declined.truncated.profit).toBe(false);
    expect(declined.truncated.turnover).toBe(false);
    expect(requested.truncated.profit).toBe(true);
  });
});
