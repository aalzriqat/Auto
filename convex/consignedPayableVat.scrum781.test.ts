/**
 * SCRUM-781 — a consigned supplier payable carries no reclaimable VAT.
 *
 * Owner ruling (SCRUM-773 c22401): "(أ) لا، امنع إدخال الضريبة". A sourced
 * (consignment) car is the supplier's until it sells; the dealership acts as
 * agent and never bought it, so the supplier's settlement carries no input VAT
 * the dealership can reclaim. Booking one put VAT_RECEIVABLE on the books and
 * credited COGS on a sale whose agent-basis revenue has no such cost — profit
 * and reclaimable VAT both overstated by the amount typed.
 *
 * An OWNED vehicle bought on account is a real purchase; its VAT reclass stays.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { postVehicleAcquisitionIfOwned } from "./vehicles";

const MODULE_GLOB = import.meta.glob("./**/*.*s");
const newTest = () => convexTestWithComponents(schema, MODULE_GLOB);
type T = ReturnType<typeof newTest>;

async function seedOrg(t: T, tag: string) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S781 ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `s781_${tag}`, email: `s781${tag}@example.com`, name: `Owner ${tag}` })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: ["view:finance", "manage:finance"], isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] }));
  const as = t.withIdentity({ subject: `s781_${tag}`, clerkId: `s781_${tag}` });
  await as.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await as.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999), fiscalYear, periodNumber: 1,
  });
  const period = (await as.query(api.accountingPeriods.list, { orgId }))[0];
  await as.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  return { orgId, userId, as };
}

/** The production shape: a sourced car sold through the dealership, payable raised at sale. */
async function seedConsignedPayable(t: T, orgId: Id<"organizations">, userId: Id<"users">) {
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: "S781SOURCED00001", make: "Kia", model: "Sportage", year: 2023, mileage: 0, color: "White",
      fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 20000, status: "SOLD",
      sourceType: "SOURCED", sourcedFromName: "Sister Dealer Co", sourceCost: 18000,
    })
  );
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Jane", lastName: "Doe" }));
  const saleId = await t.run((ctx) =>
    ctx.db.insert("sales", { orgId, vehicleId, customerId, salespersonId: userId, salePrice: 20000, saleDate: Date.now(), status: "COMPLETED" })
  );
  const payableId = await t.run((ctx) =>
    ctx.db.insert("vehicleSupplierPayables", {
      orgId, vehicleId, saleId, sourcedFromName: "Sister Dealer Co", amountDue: 18000, currency: "JOD",
      status: "PENDING", createdBy: userId, createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  return { vehicleId, payableId };
}

/** An owned car bought ON_ACCOUNT, through the production acquisition writer. */
async function seedOwnedOnAccountPayable(t: T, orgId: Id<"organizations">, userId: Id<"users">) {
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: "S781OWNED0000001", make: "Toyota", model: "Corolla", year: 2022, mileage: 1000, color: "Grey",
      fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 12000, purchasePrice: 10000, status: "AVAILABLE",
    })
  );
  await t.run((ctx) =>
    postVehicleAcquisitionIfOwned(ctx, {
      orgId, vehicleId, isSourced: false, purchasePrice: 10000, purchasePaymentMethod: "ON_ACCOUNT",
      supplierName: "Wholesale Motors", vehicleLabel: "2022 Toyota Corolla", vin: "S781OWNED0000001", actorId: userId,
    })
  );
  const payable = await t.run((ctx) =>
    ctx.db.query("vehicleSupplierPayables").withIndex("by_org", (q) => q.eq("orgId", orgId)).first()
  );
  expect(payable?.saleId).toBeUndefined();
  return { vehicleId, payableId: payable!._id };
}

async function settlementLines(t: T, orgId: Id<"organizations">, payableId: Id<"vehicleSupplierPayables">) {
  return await t.run(async (ctx) => {
    const events = (
      await ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "vehicleSupplierPayables").eq("sourceId", payableId.toString())
        )
        .collect()
    ).filter((e) => e.eventType === "SUPPLIER_PAYMENT_SETTLED");
    const lines = [];
    for (const e of events) {
      if (!e.journalEntryId) continue;
      const entryLines = await ctx.db
        .query("journalLines")
        .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", e.journalEntryId!))
        .collect();
      for (const l of entryLines) {
        const account = await ctx.db.get(l.accountId);
        lines.push({ key: account?.systemKey, debit: l.debitMinor, credit: l.creditMinor });
      }
    }
    return { events, lines };
  });
}

describe("SCRUM-781: no reclaimable VAT on a consigned supplier payable", () => {
  test("markPaid refuses a VAT amount on a consigned payable and changes nothing", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "refuse");
    const { payableId } = await seedConsignedPayable(t, orgId, userId);
    const idempotencyKey = crypto.randomUUID();

    await expect(
      as.mutation(api.sourcingPayables.markPaid, { idempotencyKey, orgId, payableId, paymentMethod: "BANK_TRANSFER", taxAmount: 2000 })
    ).rejects.toThrow(/consign/i);
    // A refusal is not cached: the same key is refused again, not replayed as success.
    await expect(
      as.mutation(api.sourcingPayables.markPaid, { idempotencyKey, orgId, payableId, paymentMethod: "BANK_TRANSFER", taxAmount: 2000 })
    ).rejects.toThrow(/consign/i);

    const payable = await t.run((ctx) => ctx.db.get(payableId));
    expect(payable?.status).toBe("PENDING");
    expect(payable?.amountPaid ?? 0).toBe(0);
    expect(payable?.taxAmount).toBeUndefined();
    expect((await settlementLines(t, orgId, payableId)).events).toHaveLength(0);
  });

  test("a consigned payable settles at its gross amount when no VAT is entered", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "gross");
    const { payableId } = await seedConsignedPayable(t, orgId, userId);

    await as.mutation(api.sourcingPayables.markPaid, { idempotencyKey: crypto.randomUUID(), orgId, payableId, paymentMethod: "BANK_TRANSFER" });

    const payable = await t.run((ctx) => ctx.db.get(payableId));
    expect(payable?.status).toBe("PAID");
    const { lines } = await settlementLines(t, orgId, payableId);
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.key === "ACCOUNTS_PAYABLE_SUPPLIERS")?.debit).toBe(18_000_000);
    expect(lines.find((l) => l.key === "BANK_ACCOUNT")?.credit).toBe(18_000_000);
    expect(lines.some((l) => l.key === "VAT_RECEIVABLE")).toBe(false);
  });

  test("an explicit zero VAT on a consigned payable is not a VAT entry and settles", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "zero");
    const { payableId } = await seedConsignedPayable(t, orgId, userId);

    await as.mutation(api.sourcingPayables.markPaid, {
      idempotencyKey: crypto.randomUUID(), orgId, payableId, paymentMethod: "BANK_TRANSFER", taxAmount: 0,
    });

    const { lines } = await settlementLines(t, orgId, payableId);
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.key === "VAT_RECEIVABLE")).toBe(false);
  });

  // Control: an owned purchase on account keeps its VAT reclass, out of
  // inventory while the car is unsold and out of COGS once it has sold.
  test("an owned on-account payable still reclasses VAT out of inventory while unsold", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "owned");
    const { payableId } = await seedOwnedOnAccountPayable(t, orgId, userId);

    await as.mutation(api.sourcingPayables.markPaid, {
      idempotencyKey: crypto.randomUUID(), orgId, payableId, paymentMethod: "BANK_TRANSFER", taxAmount: 1000,
    });

    const { lines } = await settlementLines(t, orgId, payableId);
    expect(lines).toHaveLength(4);
    expect(lines.find((l) => l.key === "ACCOUNTS_PAYABLE_SUPPLIERS")?.debit).toBe(10_000_000);
    expect(lines.find((l) => l.key === "VAT_RECEIVABLE")?.debit).toBe(1_000_000);
    expect(lines.find((l) => l.key === "VEHICLE_INVENTORY")?.credit).toBe(1_000_000);
  });

  test("an owned on-account payable reclasses VAT out of COGS once the car has sold", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "ownedsold");
    const { vehicleId, payableId } = await seedOwnedOnAccountPayable(t, orgId, userId);
    await t.run((ctx) => ctx.db.patch(vehicleId, { status: "SOLD" }));

    await as.mutation(api.sourcingPayables.markPaid, {
      idempotencyKey: crypto.randomUUID(), orgId, payableId, paymentMethod: "BANK_TRANSFER", taxAmount: 1000,
    });

    const { lines } = await settlementLines(t, orgId, payableId);
    expect(lines.find((l) => l.key === "VAT_RECEIVABLE")?.debit).toBe(1_000_000);
    expect(lines.find((l) => l.key === "COST_OF_VEHICLES_SOLD")?.credit).toBe(1_000_000);
  });
});
