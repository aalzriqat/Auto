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

/**
 * The deployment transition, which is the only place old and new rules meet.
 *
 * A عربون taken BEFORE recognition was separated was booked as revenue on
 * arrival. Its sale completing afterwards recognizes the full amount earned —
 * so the old receipt has to stop being revenue, or the same money is counted
 * twice. Deducting it from the sale instead (the first attempt) left BOTH
 * periods wrong: the deposit's month kept revenue for a car nobody had sold,
 * and the sale's month recognized less than it earned. It is dropped at read
 * time instead, and no historical row is rewritten.
 */
describe("a legacy عربون that a completed sale later takes over", () => {
  /** A pre-change receipt WITH a real deposits row — the attributable case. */
  async function legacyDepositWithRow(
    s: Seeded,
    opts: { vehicleId: any; at: number; amount: number; status?: "HELD" | "REFUNDED" }
  ) {
    const depositId = await s.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: s.orgId, vehicleId: opts.vehicleId, customerId: s.customerId,
        amount: opts.amount, amountMinor: opts.amount * 1000, currency: "JOD", method: "CASH",
        status: opts.status ?? "HELD", holdActive: opts.status === "REFUNDED" ? false : true,
        createdAt: opts.at, createdBy: s.userId,
      })
    );
    await s.t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId: s.orgId, type: "IN", amount: opts.amount, date: opts.at,
        category: "DEPOSIT", description: "Legacy deposit",
        vehicleId: opts.vehicleId, depositId,
      })
    );
    return depositId;
  }

  /** The authoritative relationship: an application tying deposit to sale. */
  async function applyToSale(
    s: Seeded,
    opts: { depositId: any; vehicleId: any; saleId: any; amount: number; key: string; status?: "APPLIED" | "REVERSED" }
  ) {
    await s.t.run((ctx) =>
      ctx.db.insert("depositApplications", {
        orgId: s.orgId, depositId: opts.depositId, vehicleId: opts.vehicleId,
        saleId: opts.saleId, customerId: s.customerId,
        amountMinor: opts.amount * 1000, currency: "JOD",
        treatment: "CUSTOMER_RECEIVABLE" as const,
        eventType: "DEPOSIT_APPLIED", eventSourceType: "sale",
        eventSourceId: opts.saleId, eventVersion: 1,
        eventIdempotencyKey: opts.key,
        status: opts.status ?? ("APPLIED" as const),
        appliedAt: Date.now(), appliedBy: s.userId,
      })
    );
  }

  async function completedSale(s: Seeded, vehicleId: any, price: number, at: number) {
    return await s.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: s.orgId, vehicleId, customerId: s.customerId, salespersonId: s.userId,
        salePrice: price, saleDate: at, status: "COMPLETED" as const,
      })
    );
  }

  test("A — SOURCED: the deposit's month drops to zero and the sale's month gets the full margin", async () => {
    const s = await seed("transSourced");
    const v = await vehicle(s, "transSourced", true);
    const janAt = Date.now() - 40 * DAY;
    const febAt = Date.now();

    const depositId = await legacyDepositWithRow(s, { vehicleId: v, at: janAt, amount: DEPOSIT });
    const saleId = await completedSale(s, v, SALE_PRICE, febAt);
    await s.t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId: s.orgId, type: "IN", amount: SALE_PRICE - DEPOSIT, date: febAt,
        category: "VEHICLE_SALE", description: "Sale",
        vehicleId: v, recognizedRevenueAmount: MARGIN,
        grossTransactionValueAmount: SALE_PRICE,
      })
    );
    await applyToSale(s, { depositId, vehicleId: v, saleId, amount: DEPOSIT, key: "k-a" });

    const jan = await s.asUser.query(api.reports.getProfitAndLoss, { orgId: s.orgId, ...monthWindow(janAt) });
    const feb = await s.asUser.query(api.reports.getProfitAndLoss, { orgId: s.orgId, ...monthWindow(febAt) });

    expect(jan.totalRevenue).toBe(0);
    expect(feb.totalRevenue).toBe(MARGIN);
  });

  test("B — STOCK: same transition, full owned-sale revenue in the sale's month", async () => {
    const s = await seed("transOwned");
    const v = await vehicle(s, "transOwned", false);
    const janAt = Date.now() - 40 * DAY;
    const febAt = Date.now();

    const depositId = await legacyDepositWithRow(s, { vehicleId: v, at: janAt, amount: DEPOSIT });
    const saleId = await completedSale(s, v, OWNED_PRICE, febAt);
    await s.t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId: s.orgId, type: "IN", amount: OWNED_PRICE - DEPOSIT, date: febAt,
        category: "VEHICLE_SALE", description: "Sale",
        vehicleId: v, recognizedRevenueAmount: OWNED_PRICE,
        grossTransactionValueAmount: OWNED_PRICE,
      })
    );
    await applyToSale(s, { depositId, vehicleId: v, saleId, amount: DEPOSIT, key: "k-b" });

    const jan = await s.asUser.query(api.reports.getProfitAndLoss, { orgId: s.orgId, ...monthWindow(janAt) });
    const feb = await s.asUser.query(api.reports.getProfitAndLoss, { orgId: s.orgId, ...monthWindow(febAt) });

    expect(jan.totalRevenue).toBe(0);
    expect(feb.totalRevenue).toBe(OWNED_PRICE);
  });

  test("C — an orphan receipt with no deposits row is NEVER excluded automatically", async () => {
    // Nine of these exist in production, sharing one import timestamp, with no
    // status and no resolution history. Whether they were real deposits,
    // applied, refunded or opening data is not knowable from their shape, and
    // shape is not permission to reinterpret them.
    const s = await seed("orphan");
    const v = await vehicle(s, "orphan", false);
    const at = Date.now();
    await depositReceipt(s, { vehicleId: v, at, amount: DEPOSIT, legacy: true });
    // A completed sale on the same car — the tempting heuristic.
    await completedSale(s, v, OWNED_PRICE, at);

    const pl = await s.asUser.query(api.reports.getProfitAndLoss, { orgId: s.orgId, ...monthWindow(at) });
    expect(pl.totalRevenue).toBe(DEPOSIT);
  });

  test("D — a legacy deposit still HELD keeps its legacy treatment", async () => {
    const s = await seed("stillHeld");
    const v = await vehicle(s, "stillHeld", false);
    const at = Date.now();
    await legacyDepositWithRow(s, { vehicleId: v, at, amount: DEPOSIT });

    const pl = await s.asUser.query(api.reports.getProfitAndLoss, { orgId: s.orgId, ...monthWindow(at) });
    expect(pl.totalRevenue).toBe(DEPOSIT);
  });

  test("E — a REFUNDED legacy deposit is not reinterpreted through the transition path", async () => {
    const s = await seed("refunded");
    const v = await vehicle(s, "refunded", false);
    const at = Date.now();
    await legacyDepositWithRow(s, { vehicleId: v, at, amount: DEPOSIT, status: "REFUNDED" });

    const pl = await s.asUser.query(api.reports.getProfitAndLoss, { orgId: s.orgId, ...monthWindow(at) });
    // Correcting it belongs to the follow-up historical PR, not to this path.
    expect(pl.totalRevenue).toBe(DEPOSIT);
  });

  test("F — one deposit across two vehicles is excluded ONCE, not once per sale", async () => {
    const s = await seed("multiApply");
    const a = await vehicle(s, "multiA", false);
    const b = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: "VINMULTIB", make: "Kia", model: "Rio", year: 2023,
        mileage: 5, color: "Red", fuelType: "Gas", transmission: "Auto",
        sellingPrice: OWNED_PRICE, status: "AVAILABLE",
        sourceType: "STOCK" as const, purchasePrice: OWNED_COST,
      })
    );
    const at = Date.now();
    const depositId = await legacyDepositWithRow(s, { vehicleId: a, at, amount: DEPOSIT });
    const saleA = await completedSale(s, a, OWNED_PRICE, at);
    const saleB = await completedSale(s, b, OWNED_PRICE, at);
    await applyToSale(s, { depositId, vehicleId: a, saleId: saleA, amount: 200, key: "k-f1" });
    await applyToSale(s, { depositId, vehicleId: b, saleId: saleB, amount: 100, key: "k-f2" });

    const pl = await s.asUser.query(api.reports.getProfitAndLoss, { orgId: s.orgId, ...monthWindow(at) });
    // The receipt is one row; it leaves revenue once. Nothing goes negative.
    expect(pl.totalRevenue).toBe(0);
  });

  test("H — cancelling the sale does NOT give the deposit's month its revenue back", async () => {
    // The resurrection this closes. Jan books 300, Feb recognises the full
    // sale and Jan drops to zero — then the sale is cancelled in March and Jan
    // got its 300 back, two months after the fact, because the application had
    // become REVERSED. Cancelling a sale returns the money to the deposit
    // liability; it does not make a receipt from January into earned revenue,
    // and a cancellation is not a recognition event.
    const s = await seed("cancelled");
    const v = await vehicle(s, "cancelled", false);
    const janAt = Date.now() - 40 * DAY;
    const febAt = Date.now();

    const depositId = await legacyDepositWithRow(s, { vehicleId: v, at: janAt, amount: DEPOSIT });
    const saleId = await completedSale(s, v, OWNED_PRICE, febAt);
    await applyToSale(s, {
      depositId, vehicleId: v, saleId, amount: DEPOSIT, key: "k-h", status: "REVERSED",
    });

    const jan = await s.asUser.query(api.reports.getProfitAndLoss, { orgId: s.orgId, ...monthWindow(janAt) });
    expect(jan.totalRevenue).toBe(0);
  });

  test("H2 — nor does a refund or a re-application to another sale restore it", async () => {
    const s = await seed("afterReversal");
    const v = await vehicle(s, "afterReversal", false);
    const janAt = Date.now() - 40 * DAY;
    const febAt = Date.now();

    // Refunded after the reversal: still not revenue on the receipt's date.
    const depositId = await legacyDepositWithRow(s, {
      vehicleId: v, at: janAt, amount: DEPOSIT, status: "REFUNDED",
    });
    const saleId = await completedSale(s, v, OWNED_PRICE, febAt);
    await applyToSale(s, {
      depositId, vehicleId: v, saleId, amount: DEPOSIT, key: "k-h2a", status: "REVERSED",
    });
    // And re-applied to a second sale, which recognises its OWN revenue.
    const saleId2 = await completedSale(s, v, OWNED_PRICE, febAt);
    await applyToSale(s, { depositId, vehicleId: v, saleId: saleId2, amount: DEPOSIT, key: "k-h2b" });

    const jan = await s.asUser.query(api.reports.getProfitAndLoss, { orgId: s.orgId, ...monthWindow(janAt) });
    expect(jan.totalRevenue).toBe(0);
  });

  test("H3 — three applications on one receipt exclude it once, never below zero", async () => {
    const s = await seed("excludeOnce");
    const v = await vehicle(s, "excludeOnce", false);
    const at = Date.now();
    const depositId = await legacyDepositWithRow(s, { vehicleId: v, at, amount: DEPOSIT });
    for (const i of [1, 2, 3]) {
      const saleId = await completedSale(s, v, OWNED_PRICE, at);
      await applyToSale(s, { depositId, vehicleId: v, saleId, amount: 100, key: `k-h3-${i}` });
    }

    const pl = await s.asUser.query(api.reports.getProfitAndLoss, { orgId: s.orgId, ...monthWindow(at) });
    // The receipt is one row: it leaves revenue once, and nothing subtracts it
    // a second time. Exclusion is set membership, not arithmetic.
    expect(pl.totalRevenue).toBe(0);
  });

  test("G — a post-deploy deposit is already flagged and untouched by this path", async () => {
    const s = await seed("newDeposit");
    const v = await vehicle(s, "newDeposit", false);
    const at = Date.now();
    await depositReceipt(s, { vehicleId: v, at, amount: DEPOSIT });

    const pl = await s.asUser.query(api.reports.getProfitAndLoss, { orgId: s.orgId, ...monthWindow(at) });
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

  test("the impact report classifies orphan receipts apart from unresolved deposits", async () => {
    // The nine production rows with no deposits row are a different problem
    // from a real deposit still held: a migration can act on the second and
    // cannot act on the first without being told what it is. Folding them
    // together would hand the follow-up PR one number covering two decisions.
    const s = await seed("classify");
    const v = await vehicle(s, "classify", false);
    const at = Date.now();

    // One orphan (no deposits row) and one real HELD deposit.
    await depositReceipt(s, { vehicleId: v, at, amount: 70, legacy: true });
    const depositId = await s.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: s.orgId, vehicleId: v, customerId: s.customerId,
        amount: DEPOSIT, amountMinor: DEPOSIT * 1000, currency: "JOD", method: "CASH",
        status: "HELD", holdActive: true, createdAt: at, createdBy: s.userId,
      })
    );
    await s.t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId: s.orgId, type: "IN", amount: DEPOSIT, date: at, category: "DEPOSIT",
        description: "Real legacy deposit", vehicleId: v, depositId,
      })
    );

    const report = await s.t.query(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import("./_generated/api")).internal.depositRevenueImpact.depositRevenueImpact as any,
      { orgId: s.orgId }
    );

    expect(report.orphanReceipts).toBe(1);
    expect(report.orphanAmount).toBe(70);
    // The orphan must NOT inflate the correctable population.
    expect(report.unresolvedLegacyDeposits).toBe(1);
    expect(report.unresolvedAmount).toBe(DEPOSIT);
    expect(report.attributableLegacyDeposits).toBe(1);
    expect(report.heldLegacyDeposits).toBe(1);
  });

  test("a receipt whose deposit row is gone is counted once, not twice", async () => {
    // The awkward middle case: `depositId` is set and its applications still
    // exist, but the deposits row itself has been hard-deleted. The receipt was
    // attributed by slice through the surviving applications AND then counted
    // again for its full value as an orphan — the same money in two classes, in
    // the report the back-book migration decision is made from.
    //
    // An orphan is decided by the absence of the deposits row alone, before any
    // application is read.
    const s = await seed("gonerow");
    const v = await vehicle(s, "gonerow", false);
    const at = Date.now();

    const depositId = await s.t.run((ctx) =>
      ctx.db.insert("deposits", {
        orgId: s.orgId, vehicleId: v, customerId: s.customerId,
        amount: DEPOSIT, amountMinor: DEPOSIT * 1000, currency: "JOD", method: "CASH",
        status: "APPLIED", holdActive: false, createdAt: at, createdBy: s.userId,
      })
    );
    await s.t.run((ctx) =>
      ctx.db.insert("transactions", {
        orgId: s.orgId, type: "IN", amount: DEPOSIT, date: at, category: "DEPOSIT",
        description: "Legacy receipt whose deposit row was later purged",
        vehicleId: v, depositId,
      })
    );
    const saleId = await s.t.run((ctx) =>
      ctx.db.insert("sales", {
        orgId: s.orgId, vehicleId: v, customerId: s.customerId,
        salespersonId: s.userId, salePrice: SALE_PRICE, saleDate: at,
        status: "COMPLETED" as const,
      })
    );
    await s.t.run((ctx) =>
      ctx.db.insert("depositApplications", {
        orgId: s.orgId, depositId, saleId, vehicleId: v, customerId: s.customerId,
        amountMinor: DEPOSIT * 1000, currency: "JOD",
        treatment: "CUSTOMER_RECEIVABLE" as const,
        eventType: "DEPOSIT_APPLIED", eventSourceType: "sale",
        eventSourceId: saleId, eventVersion: 1,
        eventIdempotencyKey: `gonerow_${at}`,
        status: "APPLIED" as const,
        appliedAt: at, appliedBy: s.userId,
      })
    );
    // The row disappears; its applications and its receipt do not.
    await s.t.run((ctx) => ctx.db.delete(depositId));

    const report = await s.t.query(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (await import("./_generated/api")).internal.depositRevenueImpact.depositRevenueImpact as any,
      { orgId: s.orgId }
    );

    expect(report.orphanReceipts).toBe(1);
    expect(report.orphanAmount).toBe(DEPOSIT);
    // Counted ONCE: not also attributed as a slice through the applications.
    expect(report.crossPeriodAmount + report.samePeriodAmount).toBe(0);
    expect(report.perOrg[0].rows).toHaveLength(1);
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
    // This fixture has no deposits row, so it is an UNATTRIBUTABLE receipt —
    // reported, never inferred, and deliberately not counted as a deposit a
    // migration could correct.
    expect(report.orphanReceipts).toBe(1);
    expect(report.unresolvedLegacyDeposits).toBe(0);

    // Read-only, and asserted rather than assumed — this report exists to
    // inform a migration decision, not to make one.
    const after = await s.t.run(async (ctx) =>
      (await ctx.db.query("transactions").collect()).map((r) => r._id).sort()
    );
    expect(after).toEqual(before);
  });
});
