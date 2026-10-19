import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

/**
 * SCRUM-760 narrow pilot: registering commission lines is a new, uncertified
 * money write, so the server refuses it. This runs against the REAL switch
 * (no mock) so it fails the day someone flips the switch without updating it.
 */
test("addLine and removeLine are refused server-side during the pilot; the read still works", async () => {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Pilot Dealer", createdAt: Date.now() }));
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "pilot_user", email: "pilot@example.com", name: "Sam" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: ["view:commissions", "manage:commissions", "view:sales", "create:sales", "view:vehicles"] })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: [] })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: "VIN-PILOT", make: "Kia", model: "K5", year: 2024, color: "White",
      fuelType: "Gasoline", transmission: "Automatic", mileage: 10, sellingPrice: 15000, status: "AVAILABLE",
    })
  );
  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "A", lastName: "B", email: "ab@example.com" })
  );
  const asUser = t.withIdentity({ subject: "pilot_user", clerkId: "pilot_user" });
  const saleId = await asUser.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(), orgId, vehicleId, customerId, salespersonId: userId,
    salePrice: 15000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH",
  });

  await expect(
    asUser.mutation(api.dealCommissions.addLine, { orgId, saleId, kind: "PURCHASE", employeeId: userId, amount: 50 })
  ).rejects.toThrow(/not available during the pilot/);
  const rows = await t.run((ctx) => ctx.db.query("dealCommissionLines").collect());
  expect(rows).toHaveLength(0);

  const view = await asUser.query(api.dealCommissions.forSale, { orgId, saleId });
  expect(view.writesEnabled).toBe(false);
  expect(view.lines).toEqual([]);
});
