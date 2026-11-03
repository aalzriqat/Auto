/**
 * SCRUM-869 item 3 (allocation proof): partial and full settlement of one supplier payable through
 * the real doors, with hand-computed amounts, checked against three consumers at once - the row,
 * the GL control account 2400 and the supplier statement - and with a supplier A/R beside it that
 * must never move or offset. Evidence boundary: convex-test only, seeded data, not production.
 *
 * Hand computation (JOD, 3 decimals; 1 JOD = 1_000 minor): entitlement 9_500 JOD = 9_500_000 minor.
 *   after 4_000 JOD  -> owed 5_500_000, cash out 4_000_000
 *   after +5_500 JOD -> owed 0, cash out 9_500_000
 */import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { SYSTEM_KEYS } from "./utils/defaultChart";
vi.mock("./utils/saleDebtContainment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/saleDebtContainment")>()),
  CASH_SALE_FULL_PAYMENT_PILOT_REQUIRED: false,
}));


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
  // SCRUM-886 round 13: completing a SOURCED sale needs cost access.
  "view:cost_price",
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
  const supplierId = await t.run((ctx) =>
    ctx.db.insert("suppliers", {
      orgId,
      displayName: "Amman Importer Co",
      displayNameKey: "amman importer co",
      status: "ACTIVE",
      version: 1,
      origin: "MANUAL",
      createdBy: userId,
      createdAt: Date.now(),
      updatedBy: userId,
      updatedAt: Date.now(),
    })
  );

  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VINSP${tag}`, make: "Toyota", model: "Camry", year: 2024, mileage: 10,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: SALE_PRICE,
      status: "AVAILABLE", sourceType: "SOURCED",
      sourcedFromName: "Amman Importer Co", sourceCost: ENTITLEMENT,
      sourcedSupplierId: supplierId,
    })
  );

  const saleId = await asUser.mutation(api.sales.create, { idempotencyKey: crypto.randomUUID(),
    orgId, vehicleId, customerId, salespersonId: userId,
    salePrice: SALE_PRICE, saleDate: Date.now(), status: "COMPLETED" as const,
    supplierSettlementRoute: "THROUGH_DEALERSHIP" as const,
  });

  const payable = (await t.run((ctx) =>
    ctx.db.query("vehicleSupplierPayables").collect()
  ))[0]!;

  return { t, orgId, userId, asUser, asManager, customerId, vehicleId, saleId, payable, supplierId };
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

const NOW = () => Date.now();

async function owed(s: Awaited<ReturnType<typeof seed>>) {
  return await s.asUser.query(api.supplierStatement.outstanding, {
    orgId: s.orgId, supplierId: s.supplierId, nowMs: NOW(),
  });
}

describe("SCRUM-869 settlement allocation proof", () => {
  test("partial then full settlement: row, GL 2400 and statement agree at every step; A/R never moves", async () => {
    const s = await seed("alloc");
    const receivableId = await s.t.run((ctx) =>
      ctx.db.insert("vehicleSupplierReceivables", {
        orgId: s.orgId, vehicleId: s.vehicleId, saleId: s.saleId, supplierId: s.supplierId, sourcedFromName: "Amman Importer Co",
        amountDue: 3_000, currency: "JOD", status: "OPEN", createdBy: s.userId, createdAt: Date.now(), updatedAt: Date.now(),
      } as never)
    );

    const before = await owed(s);
    expect(before.payable.totals).toEqual([expect.objectContaining({ currency: "JOD", grossMinor: 9_500_000 })]);
    expect(before.receivable.totals).toEqual([expect.objectContaining({ currency: "JOD", grossMinor: 3_000_000 })]);
    expect((await ledger(s.t, s.orgId))[SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS]).toBe(-9_500_000);

    await s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
      idempotencyKey: crypto.randomUUID(), orgId: s.orgId, payableId: s.payable._id, amount: 4_000, paymentMethod: "CASH",
    });
    const mid = await owed(s);
    expect(mid.payable.totals).toEqual([expect.objectContaining({ grossMinor: 5_500_000 })]);
    expect(mid.payable.rows).toHaveLength(1);
    expect((await ledger(s.t, s.orgId))[SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS]).toBe(-5_500_000);
    expect(mid.receivable.totals).toEqual(before.receivable.totals);

    await s.asUser.mutation(api.sourcingPayables.markPaid, {
      idempotencyKey: crypto.randomUUID(), orgId: s.orgId, payableId: s.payable._id, paymentMethod: "CASH",
    });
    const after = await owed(s);
    expect(after.payable.rows).toEqual([]);
    expect(after.payable.totals).toEqual([]);
    const gl = await ledger(s.t, s.orgId);
    expect(gl[SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS] ?? 0).toBe(0);
    expect(gl[SYSTEM_KEYS.CASH_ON_HAND] ?? 0).toBe(-9_500_000);
    // Paying the supplier did not touch what the supplier owes: no implicit offset.
    expect(after.receivable.totals).toEqual(before.receivable.totals);
    const receivable = await s.t.run((ctx) => ctx.db.get(receivableId));
    expect(receivable?.amountReceived ?? 0).toBe(0);
    expect(receivable?.status).toBe("OPEN");
  });

  test("over-application is refused and changes nothing; a retried instalment pays once", async () => {
    const s = await seed("overapply");
    await expect(
      s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
        idempotencyKey: crypto.randomUUID(), orgId: s.orgId, payableId: s.payable._id, amount: 9_500.001, paymentMethod: "CASH",
      })
    ).rejects.toThrow();
    expect((await owed(s)).payable.totals[0]?.grossMinor).toBe(9_500_000);
    expect((await ledger(s.t, s.orgId))[SYSTEM_KEYS.ACCOUNTS_PAYABLE_SUPPLIERS]).toBe(-9_500_000);

    const key = crypto.randomUUID();
    const pay = () =>
      s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
        idempotencyKey: key, orgId: s.orgId, payableId: s.payable._id, amount: 4_000, paymentMethod: "CASH",
      });
    await pay();
    await pay();
    expect((await owed(s)).payable.totals[0]?.grossMinor).toBe(5_500_000);
    expect((await ledger(s.t, s.orgId))[SYSTEM_KEYS.CASH_ON_HAND]).toBe(-4_000_000);
  });

  test("a disputed payable refuses settlement and stays inside the statement gross", async () => {
    const s = await seed("dispute");
    await s.asUser.mutation(api.sourcingPayables.setDisputed, {
      orgId: s.orgId, payableId: s.payable._id, disputed: true, reason: "Wrong invoice", idempotencyKey: crypto.randomUUID(),
    });
    await expect(
      s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
        idempotencyKey: crypto.randomUUID(), orgId: s.orgId, payableId: s.payable._id, amount: 1_000, paymentMethod: "CASH",
      })
    ).rejects.toThrow();
    const r = await owed(s);
    expect(r.payable.totals).toEqual([expect.objectContaining({ grossMinor: 9_500_000, disputedMinor: 9_500_000 })]);
  });
});

