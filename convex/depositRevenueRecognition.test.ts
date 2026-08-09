/**
 * When a عربون becomes revenue — and when it must not.
 *
 * The defect: `getProfitAndLoss` counted DEPOSIT cash as revenue on arrival,
 * and the eventual sale was written net of what had already been collected to
 * keep the lifetime total honest. That only reconciles when the deposit and its
 * sale land in ONE period. Across a month boundary the earlier period reported
 * revenue for a car nobody had sold, and the later one was short by exactly the
 * same amount — which is why the total always looked right and the periods
 * never were.
 *
 * It also contradicted the model the rest of this work was built on: a عربون is
 * held customer money against a liability until the deal resolves it. Cash
 * arriving is not revenue being earned.
 *
 * These pin the separation: `transactions.amount` stays the operational cash
 * figure, `recognizedRevenueAmount` is what was EARNED in the sale's period, and
 * payment timing cannot move it.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const PERMS = [
  "view:sales", "create:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "manage:finance", "view:finance", "view:reports",
];

const OWNED_PRICE = 8_000;
const OWNED_COST = 6_000;
const SALE_PRICE = 12_500;
const ENTITLEMENT = 9_500;
const MARGIN = SALE_PRICE - ENTITLEMENT;
const DEPOSIT = 300;

const DAY = 86_400_000;

async function seed(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Rev ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "Rev User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag })
  );
  const asUser = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  return { t, orgId, userId, customerId, asUser };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

async function vehicle(s: Seeded, tag: string, sourced: boolean) {
  return await s.t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId: s.orgId, vin: `VINREV${tag}`, make: "Toyota", model: "Camry", year: 2024,
      mileage: 10, color: "White", fuelType: "Gas", transmission: "Auto",
      sellingPrice: sourced ? SALE_PRICE : OWNED_PRICE,
      status: "AVAILABLE",
      ...(sourced
        ? { sourceType: "SOURCED" as const, sourcedFromName: "Amman Importer Co", sourceCost: ENTITLEMENT }
        : { sourceType: "STOCK" as const, purchasePrice: OWNED_COST }),
    })
  );
}

/**
 * A deposit receipt as the CURRENT code writes one, and a sale completed later.
 * Written directly because the point is what the P&L reads, not the deposit
 * lifecycle — which `consignedDepositResolution` covers.
 */
async function depositReceipt(
  s: Seeded,
  opts: { vehicleId: any; at: number; amount: number; legacy?: boolean }
) {
  return await s.t.run((ctx) =>
    ctx.db.insert("transactions", {
      orgId: s.orgId,
      type: "IN",
      amount: opts.amount,
      date: opts.at,
      category: "DEPOSIT",
      description: "Deposit",
      vehicleId: opts.vehicleId,
      // A row written BEFORE recognition was separated carries no flag. That is
      // the only difference, and it is what keeps the back-book reading exactly
      // as it does today.
      ...(opts.legacy ? {} : { excludedFromRevenue: true }),
    })
  );
}

function monthWindow(at: number) {
  return { startDate: at - DAY, endDate: at + DAY };
}

/**
 * A عربون through the real path — quote, then `deposits.create`.
 *
 * Written directly first, which made every assertion here pass against the
 * UNFIXED code: with no quote there is no `previouslyCollected`, so the netting
 * under test never ran and the tests proved nothing. `deposits.create` is what
 * makes the sale actually carry a collected amount.
 */
async function quoteWithDeposit(
  s: Seeded,
  opts: { vehicleId: any; price: number; amount: number; at: number }
) {
  const quoteId = await s.t.run((ctx) =>
    ctx.db.insert("quotes", {
      orgId: s.orgId, customerId: s.customerId, vehicleId: opts.vehicleId,
      vehiclePrice: opts.price, downPayment: 0, termMonths: 0,
      status: "ACCEPTED", createdBy: s.userId, createdAt: opts.at,
    })
  );
  await s.asUser.mutation(api.deposits.create, {
    orgId: s.orgId, quoteId, amount: opts.amount, method: "CASH" as const,
  });
  // The receipt is dated now by the mutation; the whole point is that it sits
  // in an EARLIER period than the sale, so it is moved back deliberately.
  await s.t.run(async (ctx) => {
    const rows = await ctx.db
      .query("transactions")
      .withIndex("by_org", (q) => q.eq("orgId", s.orgId))
      .collect();
    for (const r of rows) {
      if (r.category === "DEPOSIT" && r.type === "IN") await ctx.db.patch(r._id, { date: opts.at });
    }
  });
  return quoteId;
}

describe("a عربون is not revenue when the cash arrives", () => {
  test("an owned sale recognizes its FULL price in the sale's period, not net of the deposit", async () => {
    const s = await seed("ownedCross");
    const v = await vehicle(s, "ownedCross", false);
    const depositAt = Date.now() - 40 * DAY;
    const saleAt = Date.now();

    const quoteId = await quoteWithDeposit(s, {
      vehicleId: v, price: OWNED_PRICE, amount: DEPOSIT, at: depositAt,
    });
    await s.asUser.mutation(api.sales.create, {
      orgId: s.orgId, vehicleId: v, customerId: s.customerId, salespersonId: s.userId,
      salePrice: OWNED_PRICE, saleDate: saleAt, status: "COMPLETED" as const, quoteId,
    });

    const depositPeriod = await s.asUser.query(api.reports.getProfitAndLoss, {
      orgId: s.orgId, ...monthWindow(depositAt),
    });
    const salePeriod = await s.asUser.query(api.reports.getProfitAndLoss, {
      orgId: s.orgId, ...monthWindow(saleAt),
    });

    // Nothing was earned when the money arrived.
    expect(depositPeriod.totalRevenue).toBe(0);
    // And the sale's period gets the whole price, not price-minus-deposit.
    expect(salePeriod.totalRevenue).toBe(OWNED_PRICE);
  });

  test("a consigned sale recognizes its FULL agency margin in the sale's period", async () => {
    const s = await seed("sourcedCross");
    const v = await vehicle(s, "sourcedCross", true);
    const depositAt = Date.now() - 40 * DAY;
    const saleAt = Date.now();

    const quoteId = await quoteWithDeposit(s, {
      vehicleId: v, price: SALE_PRICE, amount: DEPOSIT, at: depositAt,
    });
    await s.asUser.mutation(api.sales.create, {
      orgId: s.orgId, vehicleId: v, customerId: s.customerId, salespersonId: s.userId,
      salePrice: SALE_PRICE, saleDate: saleAt, status: "COMPLETED" as const, quoteId,
    });

    const depositPeriod = await s.asUser.query(api.reports.getProfitAndLoss, {
      orgId: s.orgId, ...monthWindow(depositAt),
    });
    const salePeriod = await s.asUser.query(api.reports.getProfitAndLoss, {
      orgId: s.orgId, ...monthWindow(saleAt),
    });

    expect(depositPeriod.totalRevenue).toBe(0);
    // The margin, whole — the supplier's share was never the dealership's, and
    // the عربون was never revenue.
    expect(salePeriod.totalRevenue).toBe(MARGIN);
  });

  test("a deposit and sale in the SAME period report the sale once, not the sum", async () => {
    // The case the old arithmetic got right by construction. It has to stay
    // right: the risk in separating the two is double counting inside a period.
    const s = await seed("sameMonth");
    const v = await vehicle(s, "sameMonth", false);
    const at = Date.now();

    const quoteId = await quoteWithDeposit(s, {
      vehicleId: v, price: OWNED_PRICE, amount: DEPOSIT, at: at - 3600_000,
    });
    await s.asUser.mutation(api.sales.create, {
      orgId: s.orgId, vehicleId: v, customerId: s.customerId, salespersonId: s.userId,
      salePrice: OWNED_PRICE, saleDate: at, status: "COMPLETED" as const, quoteId,
    });

    const pl = await s.asUser.query(api.reports.getProfitAndLoss, {
      orgId: s.orgId, ...monthWindow(at),
    });
    expect(pl.totalRevenue).toBe(OWNED_PRICE);
  });

  test("a deposit with no sale behind it is not revenue at all", async () => {
    // It is the customer's money. Whether it is later applied, refunded or
    // forfeited is a decision nobody has made yet.
    const s = await seed("heldOnly");
    const v = await vehicle(s, "heldOnly", false);
    const at = Date.now();

    await depositReceipt(s, { vehicleId: v, at, amount: DEPOSIT });

    const pl = await s.asUser.query(api.reports.getProfitAndLoss, {
      orgId: s.orgId, ...monthWindow(at),
    });
    expect(pl.totalRevenue).toBe(0);
  });
});

describe("the back-book keeps the arithmetic it was written under", () => {
  test("a pre-change deposit row still counts, so historical periods do not drop", async () => {
    // The trap in removing DEPOSIT from revenue outright: those sales are
    // recorded NET of what was collected, so excluding their deposits would
    // understate every historical period rather than correct it. Old rows keep
    // reading exactly as they do today; `depositRevenueImpact` measures what a
    // reviewed migration would move.
    const s = await seed("legacyRow");
    const v = await vehicle(s, "legacyRow", false);
    const at = Date.now();

    await depositReceipt(s, { vehicleId: v, at, amount: DEPOSIT, legacy: true });

    const pl = await s.asUser.query(api.reports.getProfitAndLoss, {
      orgId: s.orgId, ...monthWindow(at),
    });
    expect(pl.totalRevenue).toBe(DEPOSIT);
  });

  test("the impact report attributes SLICES, never the whole receipt per sale", async () => {
    // The inflation this exists to catch: one 500 عربون split 300 to car A and
    // 150 to car B, 50 still held. Counting the receipt once per sale reports
    // 1,000 of impact instead of 450 — and a migration decision would be taken
    // on a number more than twice the real one, growing with every extra line
    // on the quote.
    const s = await seed("slices");
    const a = await vehicle(s, "sliceA", false);
    const b = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: "VINSLICEB", make: "Kia", model: "Rio", year: 2023,
        mileage: 5, color: "Red", fuelType: "Gas", transmission: "Auto",
        sellingPrice: OWNED_PRICE, status: "AVAILABLE",
        sourceType: "STOCK" as const, purchasePrice: OWNED_COST,
      })
    );
    const at = Date.now();

    const depositId = await s.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: s.orgId, vehicleId: a, customerId: s.customerId,
        amount: 500, amountMinor: 500 * 1000, currency: "JOD", method: "CASH",
        status: "HELD", holdActive: true, createdAt: at, createdBy: s.userId,
      })
    );
    await s.t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId: s.orgId, type: "IN", amount: 500, date: at, category: "DEPOSIT",
        description: "Legacy split deposit", vehicleId: a, depositId,
      })
    );

    // Two completed sales, each carrying its own applied slice.
    const saleFor = async (vehicleId: typeof a, slice: number) => {
      const saleId = await s.t.run((ctx) =>
        ctx.db.insert("sales", {
          orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
          salePrice: OWNED_PRICE, saleDate: at, status: "COMPLETED" as const,
        })
      );
      await s.t.run((ctx) =>
        ctx.db.insert("depositApplications", {
          orgId: s.orgId, depositId, vehicleId, saleId, customerId: s.customerId,
          amountMinor: slice * 1000, currency: "JOD",
          treatment: "CUSTOMER_RECEIVABLE" as const,
          eventType: "DEPOSIT_APPLIED", eventSourceType: "sale",
          eventSourceId: saleId, eventVersion: 1,
          eventIdempotencyKey: `slice:${vehicleId}:${slice}`,
          status: "APPLIED" as const, appliedAt: at, appliedBy: s.userId,
        })
      );
    };
    await saleFor(a, 300);
    await saleFor(b, 150);

    const report = await s.t.query(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import("./_generated/api")).internal.depositRevenueImpact.depositRevenueImpact as any,
      { orgId: s.orgId }
    );

    const org = report.perOrg[0];
    // 300 + 150 attributed to their own sale periods, 50 still held. Never 1,000.
    expect(org.samePeriodAmount + org.crossPeriodAmount).toBe(450);
    expect(org.unresolvedAmount).toBe(50);
    expect(org.partialOrMultiSaleDeposits).toBe(1);
  });

  test("a refunded or forfeited legacy deposit is not counted as unresolved", async () => {
    // Terminal decisions. The money is not waiting on anything, so counting it
    // as unresolved would overstate the work a migration has left to do.
    for (const status of ["REFUNDED", "FORFEITED"] as const) {
      const s = await seed(`terminal${status}`);
      const v = await vehicle(s, `terminal${status}`, false);
      const at = Date.now();
      const depositId = await s.t.run((ctx) =>
        ctx.db.insert("deposits", {
          orgId: s.orgId, vehicleId: v, customerId: s.customerId,
          amount: DEPOSIT, amountMinor: DEPOSIT * 1000, currency: "JOD", method: "CASH",
          status, holdActive: false, createdAt: at, createdBy: s.userId,
        })
      );
      await s.t.run((ctx) =>
        ctx.db.insert("transactions", {
          orgId: s.orgId, type: "IN", amount: DEPOSIT, date: at, category: "DEPOSIT",
          description: "Legacy terminal deposit", vehicleId: v, depositId,
        })
      );

      const report = await s.t.query(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (await import("./_generated/api")).internal.depositRevenueImpact.depositRevenueImpact as any,
        { orgId: s.orgId }
      );
      expect(report.unresolvedLegacyDeposits).toBe(0);
      expect(
        status === "REFUNDED" ? report.refundedLegacyDeposits : report.forfeitedLegacyDeposits
      ).toBe(1);
    }
  });

  test("the impact report counts a cross-period legacy deposit and writes nothing", async () => {
    const s = await seed("impact");
    const v = await vehicle(s, "impact", false);
    const at = Date.now();
    await depositReceipt(s, { vehicleId: v, at, amount: DEPOSIT, legacy: true });

    const before = await s.t.run(async (ctx) =>
      (await ctx.db.query("transactions").collect()).map((r) => r._id).sort()
    );

    const report = await s.t.query(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import("./_generated/api")).internal.depositRevenueImpact.depositRevenueImpact as any,
      { orgId: s.orgId }
    );

    expect(report.orgsAffected).toBe(1);
    expect(report.perOrg[0].legacyDepositRows).toBe(1);
    // No completed sale behind it, so it is revenue with nothing to offset it.
    expect(report.unresolvedLegacyDeposits).toBe(1);

    // Read-only, and asserted rather than assumed — this report exists to
    // inform a migration decision, not to make one.
    const after = await s.t.run(async (ctx) =>
      (await ctx.db.query("transactions").collect()).map((r) => r._id).sort()
    );
    expect(after).toEqual(before);
  });
});
