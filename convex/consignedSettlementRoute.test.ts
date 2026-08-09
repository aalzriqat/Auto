/**
 * Where the buyer's money went on a consigned sale, and what follows from it.
 *
 * A consigned vehicle is the supplier's either way, so both routes post the
 * dealership's margin and nothing more. What differs is the balance sheet:
 *
 *   THROUGH_DEALERSHIP  gross landed in the dealership's account on his behalf,
 *                       so it holds a receivable from the customer for the whole
 *                       amount and owes him his share.
 *   DIRECT_TO_SUPPLIER  the buyer paid him. Nothing gross ever reached these
 *                       books. The dealership owes him nothing and holds only a
 *                       claim for the margin he now owes back.
 *
 * The route is recorded per deal rather than derived, because the same vehicle
 * can be sold either way and only the agreement says which.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { SYSTEM_KEYS } from "./utils/defaultChart";
import {
  consignedSettlementRoute,
  dealershipCollectsGross,
} from "./utils/vehicleOwnership";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

const PERMS = [
  "view:sales", "create:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
];

const SALE_PRICE = 12_500;
const SUPPLIER_ENTITLEMENT = 9_500;
const MARGIN = SALE_PRICE - SUPPLIER_ENTITLEMENT;

async function seedDealer(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Route ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_user`, email: `${tag}@example.com`, name: "Route User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });

  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: "One" })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VINRT${tag}`, make: "Toyota", model: "Camry", year: 2024, mileage: 10,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: SALE_PRICE,
      status: "AVAILABLE",
      sourceType: "SOURCED", sourcedFromName: "Amman Importer Co", sourceCost: SUPPLIER_ENTITLEMENT,
    })
  );

  return { t, orgId, userId, asUser, customerId, vehicleId };
}

/**
 * Net movement per system key across every POSTED journal line for a sale.
 * Positive is a net debit. Reads the ledger rather than the rule's return
 * value, so it fails if the posting is correct in principle but never lands.
 */
async function postedBySystemKey(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: string,
  saleId: string
): Promise<Record<string, number>> {
  return await t.run(async (ctx) => {
    // `.withIndex` is unavailable here: passing the convexTest handle as a
    // parameter widens ctx.db to a union over every table, which drops the
    // per-table index names. Filtering after collect is equivalent at test size.
    const accounts = (await ctx.db.query("chartOfAccounts").collect())
      .filter((a) => a.orgId === orgId);
    const keyByAccount = new Map<string, string>();
    for (const a of accounts) if (a.systemKey) keyByAccount.set(a._id, a.systemKey);

    const entries = (await ctx.db.query("journalEntries").collect())
      .filter((e) => e.orgId === orgId && e.sourceType === "sales" && e.sourceId === saleId);

    const totals: Record<string, number> = {};
    for (const entry of entries) {
      if (entry.status !== "POSTED") continue;
      const lines = (await ctx.db.query("journalLines").collect())
        .filter((l) => l.journalEntryId === entry._id);
      for (const l of lines) {
        const key = keyByAccount.get(l.accountId);
        if (!key) continue;
        totals[key] = (totals[key] ?? 0) + l.debitMinor - l.creditMinor;
      }
    }
    return totals;
  });
}

async function completeConsignedSale(
  seeded: Awaited<ReturnType<typeof seedDealer>>,
  route?: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER",
  extra: Record<string, unknown> = {}
) {
  return await seeded.asUser.mutation(api.sales.create, {
    orgId: seeded.orgId,
    vehicleId: seeded.vehicleId,
    customerId: seeded.customerId,
    salespersonId: seeded.userId,
    salePrice: SALE_PRICE,
    saleDate: Date.now(),
    status: "COMPLETED" as const,
    ...(route ? { supplierSettlementRoute: route } : {}),
    ...extra,
  });
}

describe("reading the route", () => {
  test("absent means THROUGH_DEALERSHIP, because that is what old rows posted", () => {
    // Every consigned sale written before the field existed passed the route as
    // a hardcoded THROUGH_DEALERSHIP literal. Reading absent as anything else
    // would retroactively restate those deals.
    expect(consignedSettlementRoute({})).toBe("THROUGH_DEALERSHIP");
    expect(consignedSettlementRoute({ supplierSettlementRoute: undefined })).toBe("THROUGH_DEALERSHIP");
  });

  test("a recorded route is honoured", () => {
    expect(consignedSettlementRoute({ supplierSettlementRoute: "DIRECT_TO_SUPPLIER" }))
      .toBe("DIRECT_TO_SUPPLIER");
    expect(dealershipCollectsGross("DIRECT_TO_SUPPLIER")).toBe(false);
    expect(dealershipCollectsGross("THROUGH_DEALERSHIP")).toBe(true);
  });
});

describe("DIRECT_TO_SUPPLIER — the buyer paid the supplier", () => {
  test("posts the margin as a claim on the supplier, with no customer receivable and no gross", async () => {
    const s = await seedDealer("dts1");
    const saleId = await completeConsignedSale(s, "DIRECT_TO_SUPPLIER");
    const posted = await postedBySystemKey(s.t, s.orgId, saleId);

    expect(posted[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS]).toBe(MARGIN * 1000);
    expect(posted[SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE]).toBe(-MARGIN * 1000);
    // Nothing gross ever reached these books.
    expect(posted[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS] ?? 0).toBe(0);
    expect(posted[SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS] ?? 0).toBe(0);
    // Never the dealership's car, so never its revenue, cost or inventory.
    expect(posted[SYSTEM_KEYS.SALES_REVENUE] ?? 0).toBe(0);
    expect(posted[SYSTEM_KEYS.COST_OF_VEHICLES_SOLD] ?? 0).toBe(0);
    expect(posted[SYSTEM_KEYS.VEHICLE_INVENTORY] ?? 0).toBe(0);
  });

  test("creates no supplier payable, because the dealership owes him nothing", async () => {
    const s = await seedDealer("dts2");
    await completeConsignedSale(s, "DIRECT_TO_SUPPLIER");

    const payables = await s.t.run((ctx) =>
      ctx.db.query("vehicleSupplierPayables").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()
    );
    // A payable here would be a debt that no payment will ever settle: the
    // supplier was already paid by the buyer. It would sit unsettleable forever
    // while the real claim — the margin he owes back — ran the other way.
    expect(payables).toHaveLength(0);
  });

  test("the customer's receivable covers only what the dealership actually billed", async () => {
    const s = await seedDealer("dts3");
    const saleId = await completeConsignedSale(s, "DIRECT_TO_SUPPLIER", { dealerFees: 250 });

    const sale = await s.t.run((ctx) => ctx.db.get(saleId as never)) as { canonicalReceivableDocumentId?: string };
    const receivable = await s.t.run((ctx) =>
      ctx.db.get(sale.canonicalReceivableDocumentId as never)
    ) as { originalAmountMinor: number };

    // Only the dealership's own charge. The vehicle was invoiced by the
    // supplier to the buyer; including it would show the customer owing money
    // nobody ever billed them, and would have no GL counterpart.
    expect(receivable.originalAmountMinor).toBe(250 * 1000);

    const posted = await postedBySystemKey(s.t, s.orgId, saleId);
    expect(posted[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS]).toBe(250 * 1000);
    expect(posted[SYSTEM_KEYS.DEALER_FEE_INCOME]).toBe(-250 * 1000);
  });
});

describe("THROUGH_DEALERSHIP — gross ran through the dealership", () => {
  test("holds the gross as receivable, the supplier's share as a liability, and the spread as revenue", async () => {
    const s = await seedDealer("thd1");
    const saleId = await completeConsignedSale(s, "THROUGH_DEALERSHIP");
    const posted = await postedBySystemKey(s.t, s.orgId, saleId);

    expect(posted[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS]).toBe(SALE_PRICE * 1000);
    expect(posted[SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS]).toBe(-SUPPLIER_ENTITLEMENT * 1000);
    expect(posted[SYSTEM_KEYS.CONSIGNMENT_COMMISSION_REVENUE]).toBe(-MARGIN * 1000);
    expect(posted[SYSTEM_KEYS.RECEIVABLE_FROM_SUPPLIERS] ?? 0).toBe(0);
  });

  test("records the payable the settlement flow will later discharge", async () => {
    const s = await seedDealer("thd2");
    await completeConsignedSale(s, "THROUGH_DEALERSHIP");

    const payables = await s.t.run((ctx) =>
      ctx.db.query("vehicleSupplierPayables").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()
    );
    expect(payables).toHaveLength(1);
    expect(payables[0]!.amountDue).toBe(SUPPLIER_ENTITLEMENT);
  });

  test("omitting the route posts identically to naming it", async () => {
    const named = await seedDealer("thd3");
    const namedSale = await completeConsignedSale(named, "THROUGH_DEALERSHIP");
    const omitted = await seedDealer("thd4");
    const omittedSale = await completeConsignedSale(omitted, undefined);

    expect(await postedBySystemKey(omitted.t, omitted.orgId, omittedSale))
      .toEqual(await postedBySystemKey(named.t, named.orgId, namedSale));
  });
});

describe("what the route is not allowed to do", () => {
  test("it is not recorded on dealer-owned stock, which has no supplier to settle with", async () => {
    const s = await seedDealer("own1");
    const ownedVehicleId = await s.t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId: s.orgId, vin: "VINOWNED1", make: "Kia", model: "Rio", year: 2023, mileage: 5,
        color: "Red", fuelType: "Gas", transmission: "Auto", sellingPrice: 8_000,
        status: "AVAILABLE", sourceType: "STOCK", purchasePrice: 6_000,
      })
    );
    const saleId = await s.asUser.mutation(api.sales.create, {
      orgId: s.orgId,
      vehicleId: ownedVehicleId,
      customerId: s.customerId,
      salespersonId: s.userId,
      salePrice: 8_000,
      saleDate: Date.now(),
      status: "COMPLETED" as const,
      supplierSettlementRoute: "DIRECT_TO_SUPPLIER" as const,
    });

    const sale = await s.t.run((ctx) => ctx.db.get(saleId as never)) as { supplierSettlementRoute?: string };
    // Storing it would claim a supplier settlement arrangement that does not
    // exist, and every reader of the field would then have to re-derive whether
    // the vehicle was consigned before trusting it.
    expect(sale.supplierSettlementRoute).toBeUndefined();
  });

  test("it cannot be changed after completion, once the ledger has committed to it", async () => {
    const s = await seedDealer("lock1");
    const saleId = await completeConsignedSale(s, "THROUGH_DEALERSHIP");

    await expect(
      s.asUser.mutation(api.sales.update, {
        orgId: s.orgId,
        saleId,
        supplierSettlementRoute: "DIRECT_TO_SUPPLIER" as const,
      })
    ).rejects.toThrow(/locked/i);
  });
});
