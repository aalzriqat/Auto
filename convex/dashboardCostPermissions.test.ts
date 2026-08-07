/**
 * What the dashboard is allowed to read on behalf of whom.
 *
 * Consigned accounting introduced a quiet regression here. Turnover on an agent
 * sale is the dealership's margin, so computing it means computing cost — and
 * the loop that does it was lifted out of the `canViewProfitMetrics` branch so
 * that turnover would be right for everyone. That did two things nobody asked
 * for: it ran `computeVehicleCapitalizedCost` (which reads every expense logged
 * against a car) for viewers who may not see costs at all, up to ~1,000 extra
 * document reads on every subscription tick; and it then showed those viewers
 * the margin under the name "revenue" — 12,500 on the car and 3,000 of turnover
 * discloses the supplier's entitlement exactly.
 *
 * The cost function is wrapped in a counter here rather than asserted about
 * indirectly, because "the reads are skipped" is a claim about what ran, and
 * nothing observable in the response can distinguish "did not read" from "read
 * and withheld".
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi, beforeEach } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const costProbe = vi.hoisted(() => ({ calls: 0 }));

vi.mock("./utils/vehicleCost", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./utils/vehicleCost")>();
  return {
    ...actual,
    computeVehicleCapitalizedCost: async (
      ...args: Parameters<typeof actual.computeVehicleCapitalizedCost>
    ) => {
      costProbe.calls += 1;
      return actual.computeVehicleCapitalizedCost(...args);
    },
  };
});

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const SALE_PRICE = 12_500;
const ENTITLEMENT = 9_500;
const MARGIN = SALE_PRICE - ENTITLEMENT;

/** Everything the dashboard needs except the two that gate profit. */
const BASE_PERMS = [
  "view:vehicles", "create:vehicles",
  "view:customers", "create:customers",
  "view:sales", "create:sales",
  "view:leads",
];
const PROFIT_PERMS = ["view:reports", "view:financials"];

async function seedDealer(tag: string, permissions: string[]) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Perm ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "Viewer" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: `Role ${tag}`, permissions })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"],
    })
  );

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag })
  );

  // A consigned car, sold. Its capitalized cost is the supplier's entitlement,
  // and a handful of expenses hang off it so the "expensive" loop really is.
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VINPERM${tag}`, make: "Toyota", model: "Camry", year: 2024, mileage: 10,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: SALE_PRICE,
      status: "SOLD", sourceType: "SOURCED", sourcedFromName: "Amman Importer Co",
      sourceCost: ENTITLEMENT,
    })
  );
  await t.run((ctx) =>
    ctx.db.insert("sales", {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: SALE_PRICE, saleDate: Date.now(), status: "COMPLETED",
    })
  );

  return { t, orgId, userId, asUser: t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` }) };
}

beforeEach(() => {
  costProbe.calls = 0;
});

describe("a viewer without profit permission", () => {
  test("triggers no vehicle cost computation at all", async () => {
    const s = await seedDealer("denied1", BASE_PERMS);

    await s.asUser.query(api.dashboard.stats, { orgId: s.orgId, timeRange: "YEAR" as const });

    // Not "fewer" — none. The loop is gated before the query, not after it.
    expect(costProbe.calls).toBe(0);
  });

  test("is never shown the margin, under any label", async () => {
    const s = await seedDealer("denied2", BASE_PERMS);

    const dash = await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId, timeRange: "YEAR" as const,
    });

    // The disclosure this prevents: 3,000 of "revenue" against a 12,500 car is
    // the supplier's entitlement stated by subtraction.
    expect(dash.salesVolumeThisMonth).not.toBe(MARGIN);
    expect(dash.salesVolumeThisMonth).toBe(SALE_PRICE);
    expect(dash.totalProfit).toBeUndefined();
  });

  test("is told which basis the figure is on rather than left to assume", async () => {
    const s = await seedDealer("denied3", BASE_PERMS);

    const dash = await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId, timeRange: "YEAR" as const,
    });

    // A gross figure passing itself off as accounting turnover is the other
    // way this goes wrong, and the label is what stops it.
    expect(dash.salesVolumeBasis).toBe("GROSS_TRANSACTION_VALUE");
  });
});

describe("a viewer with profit permission", () => {
  test("gets the agent basis, and the cost loop runs for it", async () => {
    const s = await seedDealer("allowed1", [...BASE_PERMS, ...PROFIT_PERMS]);

    const dash = await s.asUser.query(api.dashboard.stats, {
      orgId: s.orgId, timeRange: "YEAR" as const,
    });

    expect(dash.salesVolumeBasis).toBe("ACCOUNTING_TURNOVER");
    expect(dash.salesVolumeThisMonth).toBe(MARGIN);
    // The gross is still there, separately and explicitly.
    expect(dash.grossTransactionValueThisMonth).toBe(SALE_PRICE);
    expect(costProbe.calls).toBeGreaterThan(0);
  });
});
