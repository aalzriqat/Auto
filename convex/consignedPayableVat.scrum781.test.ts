/**
 * SCRUM-781 - a consigned supplier payable is settled at its gross amount.
 *
 * Owner ruling, SCRUM-773#c22401 (2026-10-07), asked in Arabic with worked
 * numbers: there is no reclaimable VAT on a consigned-supplier payment, so the
 * backend must refuse a VAT amount on one. Re-affirmed 2026-10-28: consigned
 * (SOURCED) vehicles are in the pilot, so this must hold before launch.
 *
 * Invariant: a supplier payable for a consigned vehicle is settled at its gross
 * amount (Dr AP-Suppliers / Cr cash or bank). Any nonzero `taxAmount` is refused
 * with nothing written and nothing posted. An OWNED vehicle bought ON_ACCOUNT is a
 * real purchase: its VAT reclass stays (to Vehicle Inventory while unsold, to
 * COGS once sold).
 *
 * Why it matters: a consignment agent sale books no COGS, so crediting
 * COST_OF_VEHICLES_SOLD for the VAT drives COGS negative and overstates the
 * deal's profit by exactly the amount typed (18,000 owed, 20,000 sale, 2,000
 * commission: VAT 2,000 reads the profit as 4,000).
 *
 * The two payment doors are `markPaid` and `recordPartialPayment`. Only
 * `markPaid` declares `taxAmount`; the partial door is gross-only by its argument
 * validator, and the partial-door tests below are the guard that keeps it so.
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

const CONSIGNED_VAT_REFUSAL = /consigned.*gross amount.*VAT/i;

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

/**
 * The production shape of a consigned payable: `saleCompletion` raises it on a
 * THROUGH_DEALERSHIP consigned sale, so the vehicle is SOURCED and the row
 * carries the sale. The worked case from the ticket: 18,000 owed, 20,000 sale.
 */
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
  return { vehicleId, saleId, payableId };
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
  expect(payable && "saleId" in payable ? payable.saleId : undefined).toBeUndefined();
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
    const lines: Array<{ key: string | undefined; debit: number; credit: number }> = [];
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

/**
 * Everything a refused payment must leave untouched: the payable itself, the
 * command-identity table (a cached refusal would live there), and the ledger.
 */
async function writeSurface(t: T, orgId: Id<"organizations">, payableId: Id<"vehicleSupplierPayables">) {
  return await t.run(async (ctx) => ({
    payable: await ctx.db.get(payableId),
    commands: (await ctx.db.query("commandIdempotency").collect()).filter((c) => c.orgId === orgId).length,
    events: (await ctx.db.query("accountingEvents").collect()).filter((e) => e.orgId === orgId).length,
    journalEntries: (await ctx.db.query("journalEntries").collect()).filter((j) => j.orgId === orgId).length,
    journalLines: (await ctx.db.query("journalLines").collect()).length,
  }));
}

describe("SCRUM-781: a consigned supplier payable is settled gross, never with VAT", () => {
  test("markPaid refuses VAT 2,000 on a consigned payable; nothing is written and the refusal is not cached", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "refuse");
    const { payableId } = await seedConsignedPayable(t, orgId, userId);
    const before = await writeSurface(t, orgId, payableId);
    const idempotencyKey = crypto.randomUUID();
    const call = () =>
      as.mutation(api.sourcingPayables.markPaid, { idempotencyKey, orgId, payableId, paymentMethod: "CASH", taxAmount: 2000 });

    await expect(call()).rejects.toThrow(CONSIGNED_VAT_REFUSAL);
    // Not cached: the same command is refused again for the same reason, not
    // replayed as a success and not blocked as "already being processed".
    await expect(call()).rejects.toThrow(CONSIGNED_VAT_REFUSAL);

    expect(await writeSurface(t, orgId, payableId)).toEqual(before);
    const payable = await t.run((ctx) => ctx.db.get(payableId));
    expect(payable?.status).toBe("PENDING");
    expect(payable?.taxAmount).toBeUndefined();
    expect((await settlementLines(t, orgId, payableId)).events).toHaveLength(0);
  });

  test("after the refusal the same payable still settles gross with a fresh command", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "recover");
    const { payableId } = await seedConsignedPayable(t, orgId, userId);
    await expect(
      as.mutation(api.sourcingPayables.markPaid, { idempotencyKey: crypto.randomUUID(), orgId, payableId, paymentMethod: "CASH", taxAmount: 2000 })
    ).rejects.toThrow(CONSIGNED_VAT_REFUSAL);

    await as.mutation(api.sourcingPayables.markPaid, { idempotencyKey: crypto.randomUUID(), orgId, payableId, paymentMethod: "CASH" });

    const { lines } = await settlementLines(t, orgId, payableId);
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.key === "ACCOUNTS_PAYABLE_SUPPLIERS")?.debit).toBe(18_000_000);
    expect(lines.find((l) => l.key === "CASH_ON_HAND")?.credit).toBe(18_000_000);
    expect(lines.some((l) => l.key === "VAT_RECEIVABLE")).toBe(false);
  });

  test("markPaid refuses VAT on the unpaid remainder of a consigned payable that already took an instalment", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "remainder");
    const { payableId } = await seedConsignedPayable(t, orgId, userId);
    await as.mutation(api.sourcingPayables.recordPartialPayment, {
      idempotencyKey: crypto.randomUUID(), orgId, payableId, amount: 4000, paymentMethod: "CASH",
    });
    const before = await writeSurface(t, orgId, payableId);

    await expect(
      as.mutation(api.sourcingPayables.markPaid, { idempotencyKey: crypto.randomUUID(), orgId, payableId, paymentMethod: "CASH", taxAmount: 2000 })
    ).rejects.toThrow(CONSIGNED_VAT_REFUSAL);

    expect(await writeSurface(t, orgId, payableId)).toEqual(before);
    expect((await t.run((ctx) => ctx.db.get(payableId)))?.status).toBe("PARTIALLY_PAID");
  });

  test("a VAT amount too small to post (rounds to zero minor units) is still a VAT entry and is refused", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "tiny");
    const { payableId } = await seedConsignedPayable(t, orgId, userId);
    const before = await writeSurface(t, orgId, payableId);

    await expect(
      as.mutation(api.sourcingPayables.markPaid, { idempotencyKey: crypto.randomUUID(), orgId, payableId, paymentMethod: "CASH", taxAmount: 0.0001 })
    ).rejects.toThrow(CONSIGNED_VAT_REFUSAL);

    expect(await writeSurface(t, orgId, payableId)).toEqual(before);
  });

  test("a payable whose vehicle is SOURCED is consigned even without a linked sale", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "nosale");
    const { vehicleId, payableId } = await seedConsignedPayable(t, orgId, userId);
    await t.run((ctx) => ctx.db.patch(payableId, { saleId: undefined }));
    expect((await t.run((ctx) => ctx.db.get(vehicleId)))?.sourceType).toBe("SOURCED");
    const before = await writeSurface(t, orgId, payableId);

    await expect(
      as.mutation(api.sourcingPayables.markPaid, { idempotencyKey: crypto.randomUUID(), orgId, payableId, paymentMethod: "CASH", taxAmount: 2000 })
    ).rejects.toThrow(CONSIGNED_VAT_REFUSAL);

    expect(await writeSurface(t, orgId, payableId)).toEqual(before);
  });

  test("a payable whose vehicle cannot be read fails closed: VAT is refused", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "gone");
    const { vehicleId, payableId } = await seedConsignedPayable(t, orgId, userId);
    await t.run((ctx) => ctx.db.patch(payableId, { saleId: undefined }));
    await t.run((ctx) => ctx.db.delete(vehicleId));
    const before = await writeSurface(t, orgId, payableId);

    await expect(
      as.mutation(api.sourcingPayables.markPaid, { idempotencyKey: crypto.randomUUID(), orgId, payableId, paymentMethod: "CASH", taxAmount: 2000 })
    ).rejects.toThrow(CONSIGNED_VAT_REFUSAL);

    expect(await writeSurface(t, orgId, payableId)).toEqual(before);
  });

  test("recordPartialPayment takes no VAT argument: 2,000 is refused at the door and nothing is written", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "partial");
    const { payableId } = await seedConsignedPayable(t, orgId, userId);
    const before = await writeSurface(t, orgId, payableId);

    await expect(
      as.mutation(api.sourcingPayables.recordPartialPayment, {
        idempotencyKey: crypto.randomUUID(), orgId, payableId, amount: 4000, paymentMethod: "CASH",
        // Not part of the validator. The cast is the test: a caller that sends it anyway.
        ...({ taxAmount: 2000 } as Record<string, number>),
      })
    ).rejects.toThrow();

    expect(await writeSurface(t, orgId, payableId)).toEqual(before);
    expect((await settlementLines(t, orgId, payableId)).events).toHaveLength(0);
  });

  test("recordPartialPayment on a consigned payable settles gross: Dr AP / Cr cash, no VAT line", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "partialgross");
    const { payableId } = await seedConsignedPayable(t, orgId, userId);

    await as.mutation(api.sourcingPayables.recordPartialPayment, {
      idempotencyKey: crypto.randomUUID(), orgId, payableId, amount: 4000, paymentMethod: "CASH",
    });

    const { lines } = await settlementLines(t, orgId, payableId);
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.key === "ACCOUNTS_PAYABLE_SUPPLIERS")?.debit).toBe(4_000_000);
    expect(lines.find((l) => l.key === "CASH_ON_HAND")?.credit).toBe(4_000_000);
    expect(lines.some((l) => l.key === "VAT_RECEIVABLE" || l.key === "COST_OF_VEHICLES_SOLD")).toBe(false);
  });

  // ── positive controls ─────────────────────────────────────────────────────

  test("control: VAT omitted settles a consigned payable at 18,000 gross, Dr AP / Cr cash", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "gross");
    const { payableId } = await seedConsignedPayable(t, orgId, userId);

    await as.mutation(api.sourcingPayables.markPaid, { idempotencyKey: crypto.randomUUID(), orgId, payableId, paymentMethod: "CASH" });

    const payable = await t.run((ctx) => ctx.db.get(payableId));
    expect(payable?.status).toBe("PAID");
    expect(payable?.amountPaid).toBe(18000);
    const { lines } = await settlementLines(t, orgId, payableId);
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.key === "ACCOUNTS_PAYABLE_SUPPLIERS")?.debit).toBe(18_000_000);
    expect(lines.find((l) => l.key === "CASH_ON_HAND")?.credit).toBe(18_000_000);
  });

  test("control: an explicit VAT of 0 on a consigned payable is not a VAT entry and settles gross", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "zero");
    const { payableId } = await seedConsignedPayable(t, orgId, userId);

    await as.mutation(api.sourcingPayables.markPaid, { idempotencyKey: crypto.randomUUID(), orgId, payableId, paymentMethod: "CASH", taxAmount: 0 });

    const { lines } = await settlementLines(t, orgId, payableId);
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.key === "ACCOUNTS_PAYABLE_SUPPLIERS")?.debit).toBe(18_000_000);
    expect(lines.find((l) => l.key === "CASH_ON_HAND")?.credit).toBe(18_000_000);
    expect(lines.some((l) => l.key === "VAT_RECEIVABLE")).toBe(false);
  });

  test("control: an owned ON_ACCOUNT payable still reclassifies VAT out of Vehicle Inventory while the car is unsold", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "owned");
    const { payableId } = await seedOwnedOnAccountPayable(t, orgId, userId);

    await as.mutation(api.sourcingPayables.markPaid, { idempotencyKey: crypto.randomUUID(), orgId, payableId, paymentMethod: "CASH", taxAmount: 1000 });

    const { lines } = await settlementLines(t, orgId, payableId);
    expect(lines).toHaveLength(4);
    expect(lines.find((l) => l.key === "ACCOUNTS_PAYABLE_SUPPLIERS")?.debit).toBe(10_000_000);
    expect(lines.find((l) => l.key === "CASH_ON_HAND")?.credit).toBe(10_000_000);
    expect(lines.find((l) => l.key === "VAT_RECEIVABLE")?.debit).toBe(1_000_000);
    expect(lines.find((l) => l.key === "VEHICLE_INVENTORY")?.credit).toBe(1_000_000);
    expect(lines.some((l) => l.key === "COST_OF_VEHICLES_SOLD")).toBe(false);
  });

  test("control: an owned ON_ACCOUNT payable reclassifies VAT out of COGS once the car has sold", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "ownedsold");
    const { vehicleId, payableId } = await seedOwnedOnAccountPayable(t, orgId, userId);
    await t.run((ctx) => ctx.db.patch(vehicleId, { status: "SOLD" }));

    await as.mutation(api.sourcingPayables.markPaid, { idempotencyKey: crypto.randomUUID(), orgId, payableId, paymentMethod: "CASH", taxAmount: 1000 });

    const { lines } = await settlementLines(t, orgId, payableId);
    expect(lines.find((l) => l.key === "VAT_RECEIVABLE")?.debit).toBe(1_000_000);
    expect(lines.find((l) => l.key === "COST_OF_VEHICLES_SOLD")?.credit).toBe(1_000_000);
    expect(lines.some((l) => l.key === "VEHICLE_INVENTORY")).toBe(false);
  });
});
