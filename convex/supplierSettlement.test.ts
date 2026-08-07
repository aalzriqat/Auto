import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import schema from "./schema";
import { api } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { deriveSettlementStatus, settlementView } from "./utils/supplierSettlement";

/**
 * What the supplier is owed on a consigned vehicle, and how much of it has
 * actually gone out.
 *
 * The payable already existed; it could only be PENDING, PAID or CANCELLED, so
 * an instalment had nowhere to be recorded and the supplier's balance stayed at
 * the full amount until the final payment landed.
 */

type Payable = Doc<"vehicleSupplierPayables">;

/** A payable shaped like the stored row, for the pure derivation tests. */
const payable = (overrides: Partial<Payable> = {}): Payable =>
  ({
    _id: "p1" as Id<"vehicleSupplierPayables">,
    _creationTime: 0,
    orgId: "o1" as Id<"organizations">,
    vehicleId: "v1" as Id<"vehicles">,
    saleId: "s1" as Id<"sales">,
    sourcedFromName: "Amman Importer Co",
    amountDue: 9_500,
    currency: "JOD",
    status: "DUE_ON_SALE",
    createdBy: "u1" as Id<"users">,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }) as Payable;

describe("settlement status follows the money", () => {
  test("a part payment reads as PARTIALLY_PAID with the balance still owed", () => {
    const view = settlementView(payable({ amountPaid: 4_000 }));
    expect(view.status).toBe("PARTIALLY_PAID");
    expect(view.remainingAmount).toBe(5_500);
  });

  test("paying the last instalment settles it without anybody setting a flag", () => {
    const view = settlementView(payable({ amountPaid: 9_500 }));
    expect(view.status).toBe("PAID");
    expect(view.remainingAmount).toBe(0);
  });

  test("nothing is due before the sale that triggers it exists", () => {
    expect(deriveSettlementStatus(payable({ saleId: undefined }))).toBe("NOT_YET_DUE");
  });

  test("a legacy PENDING row reads as due, not as an unknown state", () => {
    // Every row written before consigned-agent accounting carries PENDING.
    expect(deriveSettlementStatus(payable({ status: "PENDING" }))).toBe("DUE_ON_SALE");
  });

  test("a legacy PAID row with no recorded payments still reads as settled", () => {
    // amountPaid did not exist when it was written. Reading it as unpaid would
    // resurrect a debt the dealership already discharged.
    const view = settlementView(payable({ status: "PAID" }));
    expect(view.status).toBe("PAID");
    expect(view.amountPaid).toBe(9_500);
    expect(view.remainingAmount).toBe(0);
  });

  test("surfaces an overpayment rather than clamping it to zero", () => {
    const view = settlementView(payable({ amountPaid: 10_000 }));
    expect(view.overpaidAmount).toBe(500);
    expect(view.remainingAmount).toBe(0);
  });

  test("dispute and cancellation are stored, because no amount implies them", () => {
    expect(deriveSettlementStatus(payable({ status: "DISPUTED", amountPaid: 4_000 }))).toBe("DISPUTED");
    expect(deriveSettlementStatus(payable({ status: "CANCELLED" }))).toBe("CANCELLED");
  });
});

async function seed() {
  const t = convexTest(schema, import.meta.glob("./**/*.ts"));
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "Bloom Cars", createdAt: Date.now() });
    const userId = await ctx.db.insert("users", { clerkId: "sup_1", email: "o@x.com" });
    const permissions = ["manage:finance", "view:finance"];
    const roleId = await ctx.db.insert("roles", {
      orgId, name: "OWNER", permissions, isSystemOwnerRole: true,
    });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: "VINSUP1", make: "Toyota", model: "Camry", year: 2024, mileage: 10,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 12_500,
      status: "SOLD", sourceType: "SOURCED", sourcedFromName: "Amman Importer Co", sourceCost: 9_500,
    });
    const customerId = await ctx.db.insert("customers", { orgId, firstName: "A", lastName: "B" });
    const saleId = await ctx.db.insert("sales", {
      orgId, vehicleId, customerId, salespersonId: userId,
      salePrice: 12_500, saleDate: Date.now(), status: "COMPLETED",
    });
    const payableId = await ctx.db.insert("vehicleSupplierPayables", {
      orgId, vehicleId, saleId, sourcedFromName: "Amman Importer Co",
      amountDue: 9_500, currency: "JOD", status: "DUE_ON_SALE",
      createdBy: userId, createdAt: Date.now(), updatedAt: Date.now(),
    });
    return { orgId, payableId };
  });
  return { t, ...ids, asUser: t.withIdentity({ subject: "sup_1" }) };
}

describe("recording instalments against a supplier", () => {
  test("two instalments settle the payable, and the balance falls as they land", async () => {
    const s = await seed();
    const first = await s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
      orgId: s.orgId, payableId: s.payableId, amount: 4_000, paymentReference: "CHQ-1",
    });
    expect(first.remainingAmount).toBe(5_500);
    expect((await s.t.run((ctx) => ctx.db.get(s.payableId)))?.status).toBe("PARTIALLY_PAID");

    const second = await s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
      orgId: s.orgId, payableId: s.payableId, amount: 5_500, paymentReference: "CHQ-2",
    });
    expect(second.remainingAmount).toBe(0);

    const row = await s.t.run((ctx) => ctx.db.get(s.payableId));
    expect(row?.status).toBe("PAID");
    expect(row?.amountPaid).toBe(9_500);
    // Settled by the payments, so the settlement is stamped.
    expect(row?.paidAt).toBeDefined();
  });

  test("refuses to pay a supplier more than he is owed", async () => {
    const s = await seed();
    await s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
      orgId: s.orgId, payableId: s.payableId, amount: 9_000,
    });
    // Netting the excess into the next payable would hide which deal it
    // happened on.
    await expect(
      s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
        orgId: s.orgId, payableId: s.payableId, amount: 1_000,
      })
    ).rejects.toThrow(/against 9500 owed/i);
  });

  test("a retried instalment does not pay the supplier twice", async () => {
    const s = await seed();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
        orgId: s.orgId, payableId: s.payableId, amount: 4_000, idempotencyKey: "pay-retry-1",
      });
    }
    expect((await s.t.run((ctx) => ctx.db.get(s.payableId)))?.amountPaid).toBe(4_000);
  });

  test("a disputed payable cannot be settled by quietly paying it", async () => {
    const s = await seed();
    await s.asUser.mutation(api.sourcingPayables.setDisputed, {
      orgId: s.orgId, payableId: s.payableId, disputed: true,
      reason: "Supplier claims 9,800 against our agreed 9,500.",
    });

    await expect(
      s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
        orgId: s.orgId, payableId: s.payableId, amount: 4_000,
      })
    ).rejects.toThrow(/under dispute/i);
  });

  test("a dispute must say what is disputed", async () => {
    const s = await seed();
    // It is the only record of why the supplier is not being paid.
    await expect(
      s.asUser.mutation(api.sourcingPayables.setDisputed, {
        orgId: s.orgId, payableId: s.payableId, disputed: true,
      })
    ).rejects.toThrow(/say what is disputed/i);
  });

  test("lifting a dispute returns to what the money says, not to a remembered status", async () => {
    const s = await seed();
    await s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
      orgId: s.orgId, payableId: s.payableId, amount: 4_000,
    });
    await s.asUser.mutation(api.sourcingPayables.setDisputed, {
      orgId: s.orgId, payableId: s.payableId, disputed: true, reason: "Balance queried.",
    });
    await s.asUser.mutation(api.sourcingPayables.setDisputed, {
      orgId: s.orgId, payableId: s.payableId, disputed: false,
    });

    const row = await s.t.run((ctx) => ctx.db.get(s.payableId));
    expect(row?.status).toBe("PARTIALLY_PAID");
    expect(row?.disputeReason).toBeUndefined();
  });

  test("neither mutation will touch another organization's payable", async () => {
    // The pinned-count comment asserts both are held to the ownership rule.
    // Asserting it in a comment is not the same as it being true.
    const s = await seed();
    const foreignPayableId = await s.t.run(async (ctx) => {
      const otherOrgId = await ctx.db.insert("organizations", {
        name: "Other Motors", createdAt: Date.now(),
      });
      const otherUserId = await ctx.db.insert("users", { clerkId: "sup_other", email: "x@y.com" });
      const vehicleId = await ctx.db.insert("vehicles", {
        orgId: otherOrgId, vin: "VINOTHER1", make: "Kia", model: "Rio", year: 2023,
        mileage: 5, color: "Blue", fuelType: "Gas", transmission: "Auto",
        sellingPrice: 8_000, status: "SOLD", sourceType: "SOURCED",
        sourcedFromName: "Zarqa Importer", sourceCost: 6_000,
      });
      return await ctx.db.insert("vehicleSupplierPayables", {
        orgId: otherOrgId, vehicleId, sourcedFromName: "Zarqa Importer",
        amountDue: 6_000, currency: "JOD", status: "DUE_ON_SALE",
        createdBy: otherUserId, createdAt: Date.now(), updatedAt: Date.now(),
      });
    });

    await expect(
      s.asUser.mutation(api.sourcingPayables.recordPartialPayment, {
        orgId: s.orgId, payableId: foreignPayableId, amount: 1_000,
      })
    ).rejects.toThrow(/not found/i);
    await expect(
      s.asUser.mutation(api.sourcingPayables.setDisputed, {
        orgId: s.orgId, payableId: foreignPayableId, disputed: true, reason: "x",
      })
    ).rejects.toThrow(/not found/i);

    // Untouched — the refusal is real, not a message in front of a write.
    const foreign = await s.t.run((ctx) => ctx.db.get(foreignPayableId));
    expect(foreign?.status).toBe("DUE_ON_SALE");
    expect(foreign?.amountPaid).toBeUndefined();
  });

  test("settling in full records the amount, not just the flag", async () => {
    const s = await seed();
    await s.asUser.mutation(api.sourcingPayables.markPaid, {
      orgId: s.orgId, payableId: s.payableId, paymentReference: "TRF-9",
    });
    const row = await s.t.run((ctx) => ctx.db.get(s.payableId));
    expect(row?.status).toBe("PAID");
    // Left at zero, every reader would have to special-case this row forever.
    expect(row?.amountPaid).toBe(9_500);
    expect(row?.paymentReference).toBe("TRF-9");
  });
});
