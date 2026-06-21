import { convexTest } from "convex-test";
import { expect, test, describe } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

const PERMISSIONS = ["edit:vehicles", "view:customers"];

async function setup() {
  const t = convexTest(schema, import.meta.glob("./**/*.*s"));
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: "Test Dealer", createdAt: Date.now() })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "user_q1", email: "q@test.com", name: "Quote User" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: PERMISSIONS })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  const asUser = t.withIdentity({ subject: "user_q1", clerkId: "user_q1" });

  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId,
      vin: "1HGCM82633A444444",
      make: "Hyundai",
      model: "Tucson",
      year: 2022,
      color: "Gray",
      fuelType: "Gasoline",
      transmission: "Automatic",
      mileage: 8000,
      sellingPrice: 19000,
      status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Layla", lastName: "Nasser" })
  );

  return { t, orgId, customerId, vehicleId, asUser };
}

describe("quotes.get", () => {
  test("returns the quote when the org matches", async () => {
    const { orgId, customerId, vehicleId, asUser } = await setup();

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 19000,
      downPayment: 1000,
      termMonths: 0,
    });

    const quote = await asUser.query(api.quotes.get, { orgId, quoteId });
    expect(quote?._id).toBe(quoteId);
    expect(quote?.vehiclePrice).toBe(19000);
  });

  test("throws for a quote belonging to a different org", async () => {
    const { t, orgId, customerId, vehicleId, asUser } = await setup();

    const quoteId = await asUser.mutation(api.quotes.saveQuote, {
      orgId,
      customerId,
      vehicleId,
      vehiclePrice: 19000,
      downPayment: 1000,
      termMonths: 0,
    });

    const orgId2 = await t.run((ctx) =>
      ctx.db.insert("organizations", { name: "Other Dealer", createdAt: Date.now() })
    );

    await expect(
      asUser.query(api.quotes.get, { orgId: orgId2, quoteId })
    ).rejects.toThrow();
  });
});
