/**
 * SCRUM-778 — an organization that never chose a commission mode is MANUAL.
 *
 * Owner ruling (SCRUM-778 c22406): "default it to manual but keep the auto
 * option available". Commission is a manager's decision per deal; an automatic
 * mode accrues only for a dealership that explicitly opted into one.
 *
 * Before this, every reader fell back to AUTO_MEMBER, so a fresh organization
 * with a member commission rate had commission expense posted on every sale
 * with nobody entering an amount — and the manager could not then enter one,
 * because a completed AUTO sale's amount is locked.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { effectiveCommissionMode } from "./utils/commissionMode";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const PERMISSIONS = [
  "create:sales", "view:sales", "edit:sales", "view:vehicles",
  "view:commissions", "manage:commissions", "view:finance", "manage:finance",
];

/**
 * A dealership whose salesperson carries a 10% member rate, so an automatic
 * mode WOULD produce a commission. `commissionMode` omitted = never chosen.
 */
async function seedDealer(suffix: string, commissionMode?: "MANUAL" | "AUTO_MEMBER") {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S778 ${suffix}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `s778_${suffix}`, email: `s778${suffix}@example.com`, name: "Rep User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: PERMISSIONS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId, commissionRate: 10 }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "USD", currencySymbol: "$", enabledPaymentTypes: ["CASH"],
      ...(commissionMode ? { commissionMode } : {}),
    })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VIN-S778-${suffix}`, make: "Honda", model: "Accord", year: 2020, color: "Black",
      fuelType: "Gasoline", transmission: "Automatic", mileage: 50000,
      purchasePrice: 10000, sellingPrice: 15000, status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "John", lastName: "Doe", email: `${suffix}.c@example.com` })
  );
  const as = t.withIdentity({ subject: `s778_${suffix}`, clerkId: `s778_${suffix}` });
  await as.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await as.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999), fiscalYear, periodNumber: 1,
  });
  const period = (await as.query(api.accountingPeriods.list, { orgId }))[0];
  await as.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const completeSale = () =>
    as.mutation(api.sales.create, {
      idempotencyKey: crypto.randomUUID(), orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 15000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH",
    });

  /** Net Commission Payable in minor units, straight off the GL. */
  const commissionPayableMinor = () =>
    t.run(async (ctx) => {
      const account = await ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "COMMISSION_PAYABLE"))
        .unique();
      if (!account) return 0;
      const lines = await ctx.db
        .query("journalLines")
        .withIndex("by_org_account", (q) => q.eq("orgId", orgId).eq("accountId", account._id))
        .collect();
      return lines.reduce((sum, l) => sum + l.creditMinor - l.debitMinor, 0);
    });

  return { t, orgId, as, completeSale, commissionPayableMinor };
}

describe("SCRUM-778: an unset commission mode is MANUAL", () => {
  test("the shared resolver reads an unset mode as MANUAL and keeps an explicit one", () => {
    expect(effectiveCommissionMode(null)).toBe("MANUAL");
    expect(effectiveCommissionMode(undefined)).toBe("MANUAL");
    expect(effectiveCommissionMode({})).toBe("MANUAL");
    expect(effectiveCommissionMode({ commissionMode: "AUTO_MEMBER" })).toBe("AUTO_MEMBER");
    expect(effectiveCommissionMode({ commissionMode: "AUTO_TIERS" })).toBe("AUTO_TIERS");
    expect(effectiveCommissionMode({ commissionMode: "MANUAL" })).toBe("MANUAL");
  });

  test("completing a sale with no mode chosen accrues no commission", async () => {
    const d = await seedDealer("unset");
    const saleId = await d.completeSale();

    const sale = await d.t.run((ctx) => ctx.db.get(saleId));
    expect(sale?.status).toBe("COMPLETED");
    expect(sale?.commissionAmount ?? null).toBeNull();
    expect(await d.commissionPayableMinor()).toBe(0);
  });

  test("with no mode chosen, the manager enters the amount and it accrues then", async () => {
    const d = await seedDealer("unset_entry");
    const saleId = await d.completeSale();

    // The undecided sale is on the commissions work queue, as in MANUAL mode.
    const queue = await d.as.query(api.sales.listCommissionsPaginated, {
      orgId: d.orgId, paidStatus: "not_set", paginationOpts: { numItems: 50, cursor: null },
    });
    expect(queue.page.map((s: { _id: string }) => s._id)).toContain(saleId);

    await d.as.mutation(api.sales.setCommissionAmount, { orgId: d.orgId, saleId, commissionAmount: 250 });

    const sale = await d.t.run((ctx) => ctx.db.get(saleId));
    expect(sale?.commissionAmount).toBe(250);
    expect(await d.commissionPayableMinor()).toBe(25_000);
  });

  test("recalculation is refused when no mode was chosen — there is no calculator to run", async () => {
    const d = await seedDealer("unset_recalc");
    const saleId = await d.completeSale();

    await expect(
      d.as.mutation(api.sales.recalculateCommission, { orgId: d.orgId, saleId })
    ).rejects.toThrow(/automatic commission modes/i);
    expect(await d.commissionPayableMinor()).toBe(0);
  });

  // Control: the automatic option stays available as an explicit opt-in.
  test("an explicit AUTO_MEMBER mode still accrues the member-rate commission at completion", async () => {
    const d = await seedDealer("auto", "AUTO_MEMBER");
    const saleId = await d.completeSale();

    const sale = await d.t.run((ctx) => ctx.db.get(saleId));
    expect(sale?.commissionAmount).toBeGreaterThan(0);
    expect(await d.commissionPayableMinor()).toBe(Math.round(sale!.commissionAmount! * 100));
  });
});
