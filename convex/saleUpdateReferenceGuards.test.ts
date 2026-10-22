import { describe, expect, test, vi } from "vitest";
import { convexTestWithComponents } from "../test-utils/convexTest";
import { api } from "./_generated/api";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { ConvexError } from "convex/values";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

async function fixture() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  const userId = await t.run((ctx) => ctx.db.insert("users", {
    clerkId: "sale-reference-owner", email: "sale-reference@example.test", name: "Reference owner",
  }));
  const owner = t.withIdentity({ subject: "sale-reference-owner" });
  const orgId = await owner.mutation(api.organizations.create, { name: "QA TEST sale reference A" });
  const foreignOrgId = await owner.mutation(api.organizations.create, { name: "QA TEST sale reference B" });
  await owner.mutation(api.orgSettings.upsert, { orgId, currency: "JOD", currencySymbol: "JD" });
  const customerId = await owner.mutation(api.customers.create, { orgId, firstName: "QA TEST", lastName: "Reference buyer" });
  const vehicle = (ownerOrg: Id<"organizations">, vin: string, tradeIn = false) => t.run((ctx) => ctx.db.insert("vehicles", {
    orgId: ownerOrg, vin, make: "Toyota", model: "Corolla", year: 2024, mileage: 10,
    color: "White", fuelType: "Gasoline", transmission: "Automatic", sourceType: "STOCK",
    ...(tradeIn ? {} : { purchasePrice: 10_000 }), sellingPrice: 12_500, status: "AVAILABLE",
  }));
  const vehicleId = await vehicle(orgId, "QA-REFERENCE-SALE");
  const tradeInId = await vehicle(orgId, "QA-REFERENCE-OWN", true);
  const foreignTradeInId = await vehicle(foreignOrgId, "QA-REFERENCE-FOREIGN", true);
  const saleId = await owner.mutation(api.sales.createDraft, {
    orgId, vehicleId, customerId, salespersonId: userId, salePrice: 12_500,
    saleDate: Date.now(), financingType: "CASH", idempotencyKey: "sale-reference-draft",
  });
  const snapshot = () => t.run(async (ctx) => ({
    sales: await ctx.db.query("sales").collect(), vehicles: await ctx.db.query("vehicles").collect(),
    transactions: await ctx.db.query("transactions").collect(), notifications: await ctx.db.query("notifications").collect(),
    events: await ctx.db.query("accountingEvents").collect(), pending: await ctx.db.query("pendingAccountingEvents").collect(),
  }));
  return { t, owner, orgId, saleId, tradeInId, foreignTradeInId, snapshot };
}

describe("SCRUM-811 sale update owns trade-in metadata before persisting it", () => {
  test.each(["foreign", "missing", "deleted"] as const)("refuses a %s trade-in and leaves the constructed state unchanged", async (kind) => {
    const f = await fixture();
    let tradeInVehicleId = f.foreignTradeInId;
    if (kind === "missing") {
      tradeInVehicleId = f.tradeInId;
      await f.t.run((ctx) => ctx.db.delete(tradeInVehicleId));
    } else if (kind === "deleted") {
      tradeInVehicleId = f.tradeInId;
      await f.t.run((ctx) => ctx.db.patch(tradeInVehicleId, { isDeleted: true }));
    }
    const before = await f.snapshot();
    let refusal: unknown;
    try {
      await f.owner.mutation(api.sales.update, {
        orgId: f.orgId, saleId: f.saleId, tradeInVehicleId, tradeInValue: 0,
      });
    } catch (error) {
      refusal = error;
    }
    // Read back even if the mutation accepted: the red report must demonstrate
    // the persisted reference, not merely an unexpected resolved promise.
    const after = await f.snapshot();
    if (refusal === undefined) {
      expect(after.sales.find((row) => row._id === f.saleId)?.tradeInVehicleId).toBe(tradeInVehicleId);
    }
    expect(after).toEqual(before);
    expect(refusal).toBeInstanceOf(ConvexError);
    if (!(refusal instanceof ConvexError)) throw new Error("The sale update did not return the expected reference refusal.");
    expect(refusal.data).toBe("Trade-in vehicle not found in this organization.");
  });

  test("accepts a live same-org reference on a pending draft without moving money", async () => {
    const f = await fixture();
    const before = await f.snapshot();
    await f.owner.mutation(api.sales.update, { orgId: f.orgId, saleId: f.saleId, tradeInVehicleId: f.tradeInId, tradeInValue: 0 });
    const after = await f.snapshot();
    expect(await f.owner.query(api.sales.get, { orgId: f.orgId, saleId: f.saleId }))
      .toMatchObject({ status: "PENDING", tradeInVehicleId: f.tradeInId, tradeInValue: 0 });
    expect(after.vehicles).toEqual(before.vehicles);
    expect(after.transactions).toEqual(before.transactions);
    expect(after.events).toEqual(before.events);
    expect(after.pending).toEqual(before.pending);
  });
});
