import { convexTestWithComponents } from "../test-utils/convexTest";
import { expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { payFullPriceByDeposit } from "../test-utils/cashDealerFixture";

vi.mock("./utils/dealCommissionLines", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./utils/dealCommissionLines")>()),
  DEAL_COMMISSION_LINES_PILOT_DISABLED: true,
}));

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

/**
 * Kill switch: lines are enabled in this build (the owner ruled them on), but
 * the compile-time switch must still refuse every writer server-side when it is
 * set back to true. The switch is mocked ON here to prove that path stays wired.
 */
test("with the kill switch on, addLine is refused server-side and the read still works", async () => {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.ts"));
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: "Pilot Dealer", createdAt: Date.now() }));
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: "pilot_user", email: "pilot@example.com", name: "Sam" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "Admin", permissions: ["view:commissions", "manage:commissions", "view:sales", "create:sales", "view:vehicles", "confirm:finance_disbursement"] })
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
  // SCRUM-802 (pilot): the cash sale is only a fixture here, so it is completed the pilot way, paid in full by deposit.
  const quoteId = await payFullPriceByDeposit(asUser, { orgId, customerId, vehicleId, price: 15000 });
  const saleId = await asUser.mutation(api.sales.create, {
    idempotencyKey: crypto.randomUUID(), orgId, vehicleId, customerId, salespersonId: userId, quoteId,
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
