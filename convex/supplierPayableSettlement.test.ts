/**
 * Paying a supplier what he is owed on a consigned sale settled through the
 * dealership — the other direction from `supplierReceivables`.
 *
 * These exist because instalments never reached the ledger. `recordPartialPayment`
 * posted nothing, on the reasoning that the derived settlement view reports the
 * balance either way. That is true of a part payment and false of the last one:
 * the row reached PAID with no GL entry ever raised, and `markPaid` — the only
 * path that raised one — refuses a PAID payable. The supplier read as settled
 * everywhere except the ledger, and no workflow could discharge the liability.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { SYSTEM_KEYS } from "./utils/defaultChart";


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
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "approve:requests",
];

const SALE_PRICE = 12_500;
const ENTITLEMENT = 9_500;
const MARGIN = SALE_PRICE - ENTITLEMENT;
void MARGIN;
const SCALE = 1000;

async function seed(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `SP ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "SP User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: PERMS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const managerId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_m`, email: `${tag}m@e.com`, name: "SP Manager" })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: managerId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  const asManager = t.withIdentity({ subject: `${tag}_m`, clerkId: `${tag}_m` });
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
    ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VINSP${tag}`, make: "Toyota", model: "Camry", year: 2024, mileage: 10,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: SALE_PRICE,
      status: "AVAILABLE", sourceType: "SOURCED",
      sourcedFromName: "Amman Importer Co", sourceCost: ENTITLEMENT,
    })
  );

  const saleId = await asUser.mutation(api.sales.create, {
    orgId, vehicleId, customerId, salespersonId: userId,
    salePrice: SALE_PRICE, saleDate: Date.now(), status: "COMPLETED" as const,
    supplierSettlementRoute: "THROUGH_DEALERSHIP" as const,
  });

  const payable = (await t.run((ctx) =>
    ctx.db.query("vehicleSupplierPayables").collect()
  ))[0]!;

  return { t, orgId, userId, asUser, asManager, customerId, vehicleId, saleId, payable };
}

/** Net movement per system key across the org's posted ledger. */
async function ledger(
  t: ReturnType<typeof convexTestWithComponents>,
  orgId: string
): Promise<Record<string, number>> {
  return await t.run(async (ctx) => {
    const accounts = (await ctx.db.query("chartOfAccounts").collect())
      .filter((a) => a.orgId === orgId);
    const keyByAccount = new Map<string, string>();
    for (const a of accounts) if (a.systemKey) keyByAccount.set(a._id, a.systemKey);

    const entries = (await ctx.db.query("journalEntries").collect())
      .filter((e) => e.orgId === orgId && e.status === "POSTED");
    const allLines = await ctx.db.query("journalLines").collect();

    const totals: Record<string, number> = {};
    for (const entry of entries) {
      for (const l of allLines.filter((x) => x.journalEntryId === entry._id)) {
        const key = keyByAccount.get(l.accountId);
        if (!key) continue;
        totals[key] = (totals[key] ?? 0) + l.debitMinor - l.creditMinor;
      }
    }
    return totals;
  });
}

describe("instalments actually reach the ledger", () => {
  test("a payable settled by instalments discharges AP-Suppliers in full", async () => {
    const s = await seed("instal");
    expect(s.payable.amountDue).toBe(ENTITLEMENT);

    await s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
      orgId: s.orgId, payableId: s.payable._id, amount: 4_000, paymentMethod: "CASH",
    });
    await s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
      orgId: s.orgId, payableId: s.payable._id, amount: ENTITLEMENT - 4_000, paymentMethod: "CASH",
    });

    const row = await s.t.run((ctx) => ctx.db.get(s.payable._id));
    expect(row?.status).toBe("PAID");
    expect(row?.amountPaid).toBe(ENTITLEMENT);

    const gl = await ledger(s.t, s.orgId);
    // The liability the sale raised is gone, and the cash that left matches it.
    expect(gl[SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS] ?? 0).toBe(0);
    expect(gl[SYSTEM_KEYS.CASH_ON_HAND] ?? 0).toBe(-ENTITLEMENT * SCALE);
  });

  test("marking a partially-paid payable settles only the remainder", async () => {
    // Posting `amountDue` here would discharge AP a second time for the
    // instalment already posted, leaving the account short by exactly that.
    const s = await seed("remainder");
    await s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
      orgId: s.orgId, payableId: s.payable._id, amount: 2_000, paymentMethod: "CASH",
    });
    await s.asUser.mutation(api.sourcingPayables.markPaid, {
      orgId: s.orgId, payableId: s.payable._id, paymentMethod: "CASH",
    });

    const gl = await ledger(s.t, s.orgId);
    expect(gl[SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS] ?? 0).toBe(0);
    expect(gl[SYSTEM_KEYS.CASH_ON_HAND] ?? 0).toBe(-ENTITLEMENT * SCALE);
  });

  test("two instalments of the same amount are two movements, not one", async () => {
    // postAccountingEvent dedupes on (eventType, sourceType, sourceId,
    // eventVersion), so without a payment sequence the second identical
    // instalment returns "already posted" and the ledger loses it.
    const s = await seed("sameamt");
    for (let i = 0; i < 2; i++) {
      await s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
        orgId: s.orgId, payableId: s.payable._id, amount: 1_000, paymentMethod: "CASH",
      });
    }
    const gl = await ledger(s.t, s.orgId);
    expect(gl[SYSTEM_KEYS.CASH_ON_HAND] ?? 0).toBe(-2_000 * SCALE);
  });
});
