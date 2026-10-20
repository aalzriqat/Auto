/**
 * A one-dealer CASH fixture shared by the SCRUM-802 suites: an owner with sales and finance permissions, an open
 * accounting period, one customer and one stock vehicle. `modules` is the calling suite's own
 * `import.meta.glob("./**\/*.*s")`, because a glob resolves relative to the file that writes it.
 */
import { convexTestWithComponents } from "./convexTest";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { api } from "../convex/_generated/api";

export const CASH_DEALER_PERMS = [
  "view:sales", "create:sales", "edit:sales", "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers", "manage:finance", "view:finance", "approve:requests", "confirm:finance_disbursement",
];

export async function seedCashDealer(tag: string, modules: Record<string, () => Promise<unknown>>) {
  const t = convexTestWithComponents(schema, modules as never);
  const now = Date.now();
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S802 ${tag}`, createdAt: now }));
  await t.run((ctx) => ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: now, updatedAt: now }));
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_user`, email: `${tag}@example.com`, name: tag }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Owner", permissions: CASH_DEALER_PERMS }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] }));
  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId, startDate: Date.UTC(fiscalYear, 0, 1), endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999), fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Cash", lastName: "Buyer" }));
  const mkVehicle = (vin: string, extra: Record<string, unknown> = {}) =>
    t.run((ctx) =>
      ctx.db.insert("vehicles", {
        orgId, vin, make: "Toyota", model: "Camry", year: 2024, mileage: 0, color: "White", fuelType: "Petrol",
        transmission: "Automatic", sellingPrice: 20000, status: "AVAILABLE", ...extra,
      } as never)
    );
  const vehicleId = await mkVehicle(`VIN802${tag}`, { purchasePrice: 17000 });
  return { t, orgId, userId, customerId, vehicleId, asUser, mkVehicle };
}
export type SeededCashDealer = Awaited<ReturnType<typeof seedCashDealer>>;

/**
 * SCRUM-802 (pilot): a suite that completes a CASH sale only as a fixture for something else pays the full price by
 * deposit first (the pilot procedure) and completes the sale against the returned quote. `asUser` needs
 * `view:sales` and `confirm:finance_disbursement`.
 */
export async function payFullPriceByDeposit(
  asUser: ReturnType<ReturnType<typeof convexTestWithComponents>["withIdentity"]>,
  args: { orgId: Id<"organizations">; customerId: Id<"customers">; vehicleId: Id<"vehicles">; price: number }
): Promise<Id<"quotes">> {
  const quoteId = await asUser.mutation(api.quotes.saveQuote, {
    orgId: args.orgId, customerId: args.customerId, vehicleId: args.vehicleId, vehiclePrice: args.price, downPayment: 0, termMonths: 0,
  });
  await asUser.mutation(api.deposits.create, {
    orgId: args.orgId, quoteId, amount: args.price, method: "CASH", idempotencyKey: crypto.randomUUID(),
  });
  return quoteId;
}
