import { describe, expect, test } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import schema from "./schema";
import { api } from "./_generated/api";
import {
  commercialRoleOf,
  legalOwnerTypeOf,
  isConsignedAgentSale,
} from "./utils/vehicleOwnership";

/**
 * A vehicle with `sourceType: SOURCED` is legally the supplier's — a confirmed
 * business invariant. The dealership never owns it, so it may never appear as
 * dealership inventory, never produce vehicle COGS, and never post revenue
 * beyond the agreed margin.
 */

async function seed(
  overrides: { status?: "AVAILABLE" | "SOLD"; sourceType?: "SOURCED" | "STOCK" } = {}
) {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  // `vehicles.update` goes through checkTenantWriteLimit, so this suite is one
  // of the few that genuinely reaches the rate limiter.
  registerRateLimiter(t);
  const ids = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "Bloom Cars", createdAt: Date.now() });
    const userId = await ctx.db.insert("users", { clerkId: "own_1", email: "o@x.com" });
    const roleId = await ctx.db.insert("roles", {
      orgId,
      name: "OWNER",
      permissions: ["edit:vehicles", "view:vehicles", "manage:finance", "view:finance"],
      isSystemOwnerRole: true,
    });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    const vehicleId = await ctx.db.insert("vehicles", {
      orgId, vin: "VINOWN9", make: "Toyota", model: "Camry", year: 2024, mileage: 10,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: 12_500,
      status: overrides.status ?? "AVAILABLE",
      sourceType: overrides.sourceType ?? "SOURCED",
      ...(overrides.sourceType === "STOCK"
        ? { purchasePrice: 9_500 }
        : { sourcedFromName: "Amman Importer Co", sourceCost: 9_500 }),
    });
    return { orgId, userId, vehicleId };
  });
  return { t, ...ids, asUser: t.withIdentity({ subject: "own_1" }) };
}

describe("what a SOURCED vehicle is, by construction", () => {
  test("a sourced vehicle is the supplier's and the dealership is its agent", () => {
    const vehicle = { sourceType: "SOURCED" as const };
    expect(legalOwnerTypeOf(vehicle)).toBe("SUPPLIER");
    expect(commercialRoleOf(vehicle)).toBe("CONSIGNED_AGENT");
    expect(isConsignedAgentSale(vehicle)).toBe(true);
  });

  test("owned stock is the dealership's and it sells as principal", () => {
    expect(legalOwnerTypeOf({ sourceType: "STOCK" })).toBe("DEALERSHIP");
    expect(commercialRoleOf({ sourceType: "STOCK" })).toBe("DEALER_OWNED_PRINCIPAL");
    expect(isConsignedAgentSale({ sourceType: "STOCK" })).toBe(false);
  });

  test("a vehicle predating sourceType is owned stock, not an unknown", () => {
    // Every row written before the field existed is dealer-owned by definition.
    // Reading it as unknown would strand the entire historical fleet outside
    // both accounting bases.
    expect(legalOwnerTypeOf({ sourceType: undefined })).toBe("DEALERSHIP");
    expect(commercialRoleOf({})).toBe("DEALER_OWNED_PRINCIPAL");
  });

  test("the role cannot disagree with the ownership, because neither is stored", () => {
    // Storing both would let a row claim SOURCED ownership with principal
    // accounting — the exact contradiction the invariants exist to forbid, and
    // one no validation can prevent once two fields can drift.
    for (const sourceType of ["SOURCED", "STOCK", undefined] as const) {
      const v = { sourceType };
      const consigned = legalOwnerTypeOf(v) === "SUPPLIER";
      expect(commercialRoleOf(v) === "CONSIGNED_AGENT").toBe(consigned);
      expect(isConsignedAgentSale(v)).toBe(consigned);
    }
  });
});

describe("conversion to dealer-owned stock", () => {
  test("an unsold consigned car can still be bought in", async () => {
    const s = await seed();
    await s.asUser.mutation(api.vehicles.update, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      sourceType: "STOCK",
      purchasePrice: 9_500,
      purchasePaymentMethod: "CASH",
    });

    const vehicle = await s.t.run((ctx) => ctx.db.get(s.vehicleId));
    expect(vehicle?.sourceType).toBe("STOCK");
    expect(legalOwnerTypeOf(vehicle!)).toBe("DEALERSHIP");
  });

  test("buying one in leaves a record of what it was, which the flag alone destroys", async () => {
    const s = await seed();
    await s.asUser.mutation(api.vehicles.update, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      sourceType: "STOCK",
      purchasePrice: 9_800,
      purchasePaymentMethod: "CASH",
    });

    const conversions = await s.t.run((ctx) =>
      ctx.db
        .query("vehicleOwnershipConversions")
        .withIndex("by_org_vehicle", (q) => q.eq("orgId", s.orgId).eq("vehicleId", s.vehicleId))
        .collect()
    );
    expect(conversions).toHaveLength(1);

    // Assert what the row says, not that it exists. Derived ownership means the
    // vehicle now reads as stock the dealership owns; without these values
    // nothing anywhere records that it was ever the supplier's, and an
    // agent-basis sale in its past would look like an error.
    const row = conversions[0]!;
    expect(row.fromSourceType).toBe("SOURCED");
    expect(row.toSourceType).toBe("STOCK");
    expect(row.supplierName).toBe("Amman Importer Co");
    expect(row.supplierEntitlementAtConversion).toBe(9_500);
    expect(row.purchaseAmount).toBe(9_800);
    expect(row.convertedBy).toBe(s.userId);
  });

  test("an edit that does not change ownership records no conversion", async () => {
    const s = await seed();
    await s.asUser.mutation(api.vehicles.update, {
      orgId: s.orgId, vehicleId: s.vehicleId, sellingPrice: 13_000,
    });

    const conversions = await s.t.run((ctx) =>
      ctx.db
        .query("vehicleOwnershipConversions")
        .withIndex("by_org_vehicle", (q) => q.eq("orgId", s.orgId).eq("vehicleId", s.vehicleId))
        .collect()
    );
    expect(conversions).toHaveLength(0);
  });

  test("a consigned car that has already been SOLD cannot be converted afterwards", async () => {
    const s = await seed({ status: "SOLD" });

    // The sale already posted on agent basis: commission only, no COGS, no
    // inventory. Converting now capitalizes Vehicle Inventory for a car that
    // has already left, and nothing will ever relieve it — the asset sits on
    // the balance sheet permanently, and the completed sale's basis has been
    // rewritten underneath it.
    await expect(
      s.asUser.mutation(api.vehicles.update, {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        sourceType: "STOCK",
        purchasePrice: 9_500,
        purchasePaymentMethod: "CASH",
      })
    ).rejects.toThrow(/already been sold/i);

    const vehicle = await s.t.run((ctx) => ctx.db.get(s.vehicleId));
    expect(vehicle?.sourceType).toBe("SOURCED");
  });

  test("owned stock that has already been SOLD cannot be converted to consigned either", async () => {
    // The mirror of the case above, and the one the code claimed was "caught by
    // the acquisition-exposure lock below" — it was not. That lock keys on
    // `"sourceType" in patch && patch.sourceType !== "SOURCED"`, so setting
    // sourceType TO "SOURCED" never triggered it.
    //
    // The damage runs the other way: the sale posted as principal — gross
    // revenue, COGS, inventory relieved. Declaring the car consigned afterwards
    // says the dealership never owned what it has already recognised revenue
    // and cost of sales on, and asserts a supplier is owed an entitlement out
    // of a completed deal nobody will ever settle. Ownership basis is not
    // retroactively editable; a historical correction goes through the audited
    // migration, which is exactly what `consignedSaleCorrections` exists for.
    const s = await seed({ status: "SOLD", sourceType: "STOCK" });

    await expect(
      s.asUser.mutation(api.vehicles.update, {
        orgId: s.orgId,
        vehicleId: s.vehicleId,
        sourceType: "SOURCED",
        sourcedFromName: "Amman Importer Co",
        sourceCost: 9_500,
      })
    ).rejects.toThrow(/already been sold/i);

    const vehicle = await s.t.run((ctx) => ctx.db.get(s.vehicleId));
    expect(vehicle?.sourceType).toBe("STOCK");
  });

  test("an unsold owned car can still be reclassified as consigned", async () => {
    // The guard is about the SALE, not about the direction. Before a sale there
    // is nothing recognised to contradict.
    const s = await seed({ status: "AVAILABLE", sourceType: "STOCK" });

    await s.asUser.mutation(api.vehicles.update, {
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      sourceType: "SOURCED",
      sourcedFromName: "Amman Importer Co",
      sourceCost: 9_500,
    });

    const vehicle = await s.t.run((ctx) => ctx.db.get(s.vehicleId));
    expect(vehicle?.sourceType).toBe("SOURCED");
  });
});
