/**
 * SCRUM-773 — Special Orders (/sourcing) bug hunt, phase 1 backend checks.
 *
 * Each test states the rule it holds the code to (an owner ruling or the
 * function's own contract), not what the code happens to do today.
 */
import { convexTestWithComponents } from "../test-utils/convexTest";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const MODULE_GLOB = import.meta.glob("./**/*.*s");
const newTest = () => convexTestWithComponents(schema, MODULE_GLOB);
type T = ReturnType<typeof newTest>;

async function seedOrg(t: T, tag: string) {
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S773 ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `s773_${tag}`, email: `s773${tag}@example.com`, name: `Owner ${tag}` })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Owner", permissions: ["view:finance", "manage:finance"], isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] }));
  const as = t.withIdentity({ subject: `s773_${tag}`, clerkId: `s773_${tag}` });
  await as.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await as.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999), fiscalYear, periodNumber: 1,
  });
  const period = (await as.query(api.accountingPeriods.list, { orgId }))[0];
  await as.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  return { orgId, userId, as };
}

/** A sourced (consignment) car sold through the dealership, with its supplier payable. */
async function seedSourcedPayable(t: T, orgId: Id<"organizations">, userId: Id<"users">) {
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: "S773SOURCED00001", make: "Kia", model: "Sportage", year: 2023, mileage: 0, color: "White",
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

async function settlementEvents(t: T, orgId: Id<"organizations">, payableId: Id<"vehicleSupplierPayables">) {
  const events = await t.run((ctx) =>
    ctx.db
      .query("accountingEvents")
      .withIndex("by_org_source", (q) =>
        q.eq("orgId", orgId).eq("sourceType", "vehicleSupplierPayables").eq("sourceId", payableId.toString())
      )
      .collect()
  );
  return events.filter((e) => e.eventType === "SUPPLIER_PAYMENT_SETTLED");
}

describe("SCRUM-773 special orders: supplier payable settlement", () => {
  // setDisputed's own contract: "Payment is refused while it stands, so the
  // dispute cannot be settled by quietly paying it." recordPartialPayment
  // honours it; markPaid (the screen's only pay button) must too.
  test("markPaid refuses a disputed payable and posts nothing", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "disp");
    const { payableId } = await seedSourcedPayable(t, orgId, userId);
    await as.mutation(api.sourcingPayables.setDisputed, { orgId, payableId, disputed: true, reason: "Supplier invoice is 500 too high" });

    await expect(
      as.mutation(api.sourcingPayables.markPaid, { idempotencyKey: crypto.randomUUID(), orgId, payableId, paymentMethod: "CASH" })
    ).rejects.toThrow(/disput/i);

    const payable = await t.run((ctx) => ctx.db.get(payableId));
    expect(payable?.status).toBe("DISPUTED");
    expect(payable?.amountPaid ?? 0).toBe(0);
    expect(await settlementEvents(t, orgId, payableId)).toHaveLength(0);
  });

  // Tenancy: a caller-supplied document id must belong to the caller's org
  // (requireOwnedRow rule). Another dealership's bank account may not be
  // recorded as where this payment's money left.
  test("markPaid refuses a payment account that belongs to another organization", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "own");
    const other = await seedOrg(t, "other");
    const { payableId } = await seedSourcedPayable(t, orgId, userId);
    const foreignBank = await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", other.orgId).eq("systemKey", "BANK_ACCOUNT"))
        .unique()
    );
    expect(foreignBank).not.toBeNull();

    await expect(
      as.mutation(api.sourcingPayables.markPaid, {
        idempotencyKey: crypto.randomUUID(), orgId, payableId, paymentMethod: "BANK_TRANSFER", paymentAccountId: foreignBank!._id,
      })
    ).rejects.toThrow(/Payment account not found/);

    await expect(
      as.mutation(api.sourcingPayables.recordPartialPayment, {
        idempotencyKey: crypto.randomUUID(), orgId, payableId, amount: 1000, paymentMethod: "BANK_TRANSFER", paymentAccountId: foreignBank!._id,
      })
    ).rejects.toThrow(/Payment account not found/);

    const payable = await t.run((ctx) => ctx.db.get(payableId));
    expect(payable?.status).toBe("PENDING");
    expect(payable?.amountPaid ?? 0).toBe(0);
    expect(payable?.paymentAccountId).toBeUndefined();
    expect(await settlementEvents(t, orgId, payableId)).toHaveLength(0);
  });

  // Control for the test above: the ownership check refuses only a foreign
  // account. The org's own bank account still pays, through both doors.
  test("both payment doors accept the organization's own payment account", async () => {
    const t = newTest();
    const { orgId, userId, as } = await seedOrg(t, "ctl");
    const { payableId } = await seedSourcedPayable(t, orgId, userId);
    const ownBank = await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", "BANK_ACCOUNT"))
        .unique()
    );
    expect(ownBank).not.toBeNull();

    await as.mutation(api.sourcingPayables.recordPartialPayment, {
      idempotencyKey: crypto.randomUUID(), orgId, payableId, amount: 1000, paymentMethod: "BANK_TRANSFER", paymentAccountId: ownBank!._id,
    });
    await as.mutation(api.sourcingPayables.markPaid, {
      idempotencyKey: crypto.randomUUID(), orgId, payableId, paymentMethod: "BANK_TRANSFER", paymentAccountId: ownBank!._id,
    });

    const payable = await t.run((ctx) => ctx.db.get(payableId));
    expect(payable?.status).toBe("PAID");
    expect(payable?.amountPaid).toBe(18000);
    expect(payable?.paymentAccountId).toBe(ownBank!._id);
    expect(await settlementEvents(t, orgId, payableId)).toHaveLength(2);
  });
});
