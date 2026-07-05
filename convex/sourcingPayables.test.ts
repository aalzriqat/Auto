/**
 * Phase 41 tests — supplier payable settlement VAT reclassification.
 *
 * markPaid always debits/credits ACCOUNTS_PAYABLE_SUPPLIERS and cash/bank in
 * full (the liability was originally booked at the full gross amount back at
 * SALE_COMPLETED, so netting it here would leave a residual balance). When a
 * VAT portion is supplied, it's reclassified out of COST_OF_VEHICLES_SOLD
 * into VAT_RECEIVABLE as a separate, self-balancing pair.
 */
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const MODULE_GLOB = import.meta.glob("./**/*.*s");

async function seedDealerWithPayable(amountDue = 5000) {
  const t = convexTest(schema, MODULE_GLOB);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Phase41 Sourcing Dealer", createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "p41s_owner", email: "p41sowner@example.com", name: "Owner" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", {
      orgId, name: "Owner", permissions: ["view:finance", "manage:finance"], isSystemOwnerRole: true,
    })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] })
  );

  const asOwner = t.withIdentity({ subject: "p41s_owner", clerkId: "p41s_owner" });
  await asOwner.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asOwner.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asOwner.query(api.accountingPeriods.list, { orgId }))[0];
  await asOwner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: "SOURCEDVIN000001", make: "Kia", model: "Sportage", year: 2023, mileage: 0,
      color: "White", fuelType: "Gasoline", transmission: "Automatic", sellingPrice: 20000, status: "SOLD",
    })
  );
  const payableId = await t.run((ctx) =>
    ctx.db.insert("vehicleSupplierPayables", {
      orgId, vehicleId, sourcedFromName: "Sister Dealer Co", amountDue, currency: "JOD",
      status: "PENDING", createdBy: userId, createdAt: Date.now(), updatedAt: Date.now(),
    })
  );

  async function accountBySystemKey(systemKey: string) {
    return await t.run((ctx) =>
      ctx.db
        .query("chartOfAccounts")
        .withIndex("by_org_systemKey", (q) => q.eq("orgId", orgId).eq("systemKey", systemKey))
        .unique()
    );
  }

  return { t, orgId, asOwner, payableId, accountBySystemKey };
}

describe("sourcingPayables.markPaid VAT reclassification", () => {
  test("without a VAT amount, settles AP and cash for the full amount with no VAT line", async () => {
    const { t, orgId, asOwner, payableId, accountBySystemKey } = await seedDealerWithPayable(5000);

    await asOwner.mutation(api.sourcingPayables.markPaid, { orgId, payableId, paymentMethod: "BANK_TRANSFER" });

    const event = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "vehicleSupplierPayables").eq("sourceId", payableId.toString())
        )
        .filter((q) => q.eq(q.field("eventType"), "SUPPLIER_PAYMENT_SETTLED"))
        .first()
    );
    const lines = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", event!.journalEntryId!)).collect()
    );
    expect(lines).toHaveLength(2);

    const ap = await accountBySystemKey("ACCOUNTS_PAYABLE_SUPPLIERS");
    const bank = await accountBySystemKey("BANK_ACCOUNT");
    expect(lines.find((l) => l.accountId === ap!._id)?.debitMinor).toBe(5_000_000);
    expect(lines.find((l) => l.accountId === bank!._id)?.creditMinor).toBe(5_000_000);
  });

  test("with a VAT amount, AP and cash still settle in full, plus a self-balancing VAT reclass pair", async () => {
    const { t, orgId, asOwner, payableId, accountBySystemKey } = await seedDealerWithPayable(5000);

    await asOwner.mutation(api.sourcingPayables.markPaid, {
      orgId, payableId, paymentMethod: "BANK_TRANSFER", taxAmount: 500,
    });

    const payable = await t.run((ctx) => ctx.db.get(payableId));
    expect(payable?.taxAmount).toBe(500);

    const event = await t.run((ctx) =>
      ctx.db
        .query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", orgId).eq("sourceType", "vehicleSupplierPayables").eq("sourceId", payableId.toString())
        )
        .filter((q) => q.eq(q.field("eventType"), "SUPPLIER_PAYMENT_SETTLED"))
        .first()
    );
    const lines = await t.run((ctx) =>
      ctx.db.query("journalLines").withIndex("by_journal_entry", (q) => q.eq("journalEntryId", event!.journalEntryId!)).collect()
    );
    expect(lines).toHaveLength(4);

    const totalDebit = lines.reduce((s, l) => s + l.debitMinor, 0);
    const totalCredit = lines.reduce((s, l) => s + l.creditMinor, 0);
    expect(totalDebit).toBe(totalCredit);

    const ap = await accountBySystemKey("ACCOUNTS_PAYABLE_SUPPLIERS");
    const bank = await accountBySystemKey("BANK_ACCOUNT");
    const vat = await accountBySystemKey("VAT_RECEIVABLE");
    const cogs = await accountBySystemKey("COST_OF_VEHICLES_SOLD");

    // AP + cash settle for the FULL gross amount — not netted by the VAT portion.
    expect(lines.find((l) => l.accountId === ap!._id)?.debitMinor).toBe(5_000_000);
    expect(lines.find((l) => l.accountId === bank!._id)?.creditMinor).toBe(5_000_000);
    // VAT reclass is a separate, self-balancing pair.
    expect(lines.find((l) => l.accountId === vat!._id)?.debitMinor).toBe(500_000);
    expect(lines.find((l) => l.accountId === cogs!._id)?.creditMinor).toBe(500_000);
  });

  test("rejects a VAT amount greater than the amount due", async () => {
    const { orgId, asOwner, payableId } = await seedDealerWithPayable(1000);

    await expect(
      asOwner.mutation(api.sourcingPayables.markPaid, {
        orgId, payableId, paymentMethod: "CASH", taxAmount: 2000,
      })
    ).rejects.toThrow(/cannot exceed/i);
  });
});
