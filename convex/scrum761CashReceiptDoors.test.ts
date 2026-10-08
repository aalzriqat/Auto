import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { SYSTEM_KEYS } from "./utils/defaultChart";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULE_GLOB = import.meta.glob("./**/*.*s");

/** JOD is scale 3, so a major unit is 1000 minor. */
const jod = (major: number): number => Math.round(major * 1000);

async function seedDealer(tag: string) {
  const t = convexTestWithComponents(schema, MODULE_GLOB);
  const now = Date.now();

  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `Tax Dealer ${tag}`, createdAt: now })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId,
      plan: "professional",
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_user`, email: `${tag}@example.com`, name: `${tag} User` })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId,
      name: "Owner",
      permissions: [
        "view:sales", "create:sales", "edit:sales",
        "view:vehicles", "create:vehicles", "edit:vehicles",
        "view:customers", "create:customers",
        "manage:finance", "view:finance",
      ],
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId,
      currency: "JOD",
      currencySymbol: "JD",
      enabledPaymentTypes: ["CASH"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });

  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear,
    periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Taxed", lastName: "Buyer" })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: `VIN_TAX_${tag}`,
      make: "Toyota",
      model: "Camry",
      year: 2024,
      mileage: 0,
      color: "White",
      fuelType: "Petrol",
      transmission: "Automatic",
      purchasePrice: 17000,
      sellingPrice: 20000,
      status: "AVAILABLE",
    })
  );

  return { t, orgId, userId, customerId, vehicleId, asUser };
}
/** Outstanding on the sale's canonical invoice: original less ACTIVE allocations (the subledger's own derivation). */
async function invoiceState(t: Awaited<ReturnType<typeof seedDealer>>["t"], saleId: unknown) {
  return await t.run(async (ctx) => {
    const sale = await ctx.db.get(saleId as never) as { canonicalReceivableDocumentId?: string } | null;
    const docId = sale?.canonicalReceivableDocumentId as never;
    const doc = docId ? await ctx.db.get(docId) as { originalAmountMinor: number; status: string } | null : null;
    const allocations = docId
      ? await ctx.db.query("paymentAllocations").collect()
      : [];
    const active = allocations.filter((a) => (a as { receivableDocumentId: string }).receivableDocumentId === (docId as string) && (a as { status: string }).status === "ACTIVE");
    const paid = active.reduce((sum, a) => sum + (a as { amountMinor: number }).amountMinor, 0);
    return doc ? { status: doc.status, original: doc.originalAmountMinor, paid, outstanding: doc.originalAmountMinor - paid } : null;
  });
}

/** Net debit-positive movement per system account across every journal line in the org. */
async function glNet(t: Awaited<ReturnType<typeof seedDealer>>["t"]) {
  return await t.run(async (ctx) => {
    const net: Record<string, number> = {};
    for (const line of await ctx.db.query("journalLines").collect()) {
      const key = (await ctx.db.get(line.accountId))?.systemKey ?? String(line.accountId);
      net[key] = (net[key] ?? 0) + (line.debitMinor ?? 0) - (line.creditMinor ?? 0);
    }
    return net;
  });
}

async function cashSale(tag: string) {
  const seeded = await seedDealer(tag);
  const { orgId, userId, customerId, vehicleId, asUser } = seeded;
  const saleId = await asUser.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(), orgId, vehicleId, customerId, salespersonId: userId,
    salePrice: 20_000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH",
  });
  return { ...seeded, saleId };
}

/**
 * SCRUM-761 pilot-path finding (SCRUM-571): the cash sale's customer invoice has no product door that applies a
 * receipt to it. These tests pin what the doors do TODAY so the gap is a visible, executed fact rather than a code
 * reading. They are CHARACTERIZATION tests, not an endorsement: when the invoice receipt resolver ships they must be
 * rewritten to assert that the receipt reduces the invoice's outstanding.
 */
describe("SCRUM-571 gap: no product door applies a customer's payment to a cash sale's invoice", () => {
  test("recordPayment naming the sale is refused with SALE_DEBT_RECEIPT_REFUSED, and nothing is written", async () => {
    const { t, orgId, customerId, saleId, asUser } = await cashSale("bySale");
    const before = await glNet(t);

    await expect(
      asUser.mutation(api.collections.recordPayment, {
        orgId, saleId, customerId, amount: 20_000, method: "CASH", paymentDate: Date.now(), idempotencyKey: crypto.randomUUID(),
      })
    ).rejects.toThrow(/SALE_DEBT_RECEIPT_REFUSED/);

    expect(await t.run((ctx) => ctx.db.query("collectionPayments").collect())).toHaveLength(0);
    expect(await glNet(t)).toEqual(before);
    expect(await invoiceState(t, saleId)).toMatchObject({ status: "OPEN", paid: 0, outstanding: jod(20_000) });
  });

  test("recordPayment without the sale is ACCEPTED but parks the cash as unapplied: the invoice stays fully owed", async () => {
    const { t, orgId, customerId, vehicleId, saleId, asUser } = await cashSale("unapplied");

    await asUser.mutation(api.collections.recordPayment, {
      orgId, customerId, vehicleId, amount: 20_000, method: "CASH", paymentDate: Date.now(), idempotencyKey: crypto.randomUUID(),
    });

    const net = await glNet(t);
    // The cash is real and on the books, but as a liability to the customer, not against what they owe.
    expect(net[SYSTEM_KEYS.CASH_ON_HAND]).toBe(jod(20_000));
    expect(net[SYSTEM_KEYS.UNAPPLIED_CUSTOMER_RECEIPTS_LIABILITY]).toBe(-jod(20_000));
    expect(net[SYSTEM_KEYS.ACCOUNTS_RECEIVABLE_CUSTOMERS]).toBe(jod(20_000));
    // And the sale's own invoice never moved.
    expect(await invoiceState(t, saleId)).toMatchObject({ status: "OPEN", paid: 0, outstanding: jod(20_000) });
  });
});
