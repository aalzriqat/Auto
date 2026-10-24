import { expect, test } from "vitest";
import { convexTestWithComponents, registerRateLimiter } from "../test-utils/convexTest";
import { api } from "./_generated/api";
import schema from "./schema";

async function fixture() {
  const t = convexTestWithComponents(schema, import.meta.glob("./**/*.*s"));
  registerRateLimiter(t);
  const orgId = await t.run(async (ctx) => {
    const orgId = await ctx.db.insert("organizations", { name: "QA TEST distribution containment", createdAt: Date.now() });
    const userId = await ctx.db.insert("users", { clerkId: "distribution-owner", email: "owner@example.test" });
    const roleId = await ctx.db.insert("roles", { orgId, name: "OWNER", isSystemOwnerRole: true, permissions: [] });
    await ctx.db.insert("memberships", { orgId, userId, roleId });
    await ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() });
    await ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH"] });
    return orgId;
  });
  const owner = t.withIdentity({ subject: "distribution-owner" });
  await owner.mutation(api.chartOfAccounts.initialize, { orgId });
  const year = new Date().getUTCFullYear();
  await owner.mutation(api.accountingPeriods.create, { orgId, startDate: Date.UTC(year, 0, 1),
    endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999), fiscalYear: year, periodNumber: 1 });
  const [period] = await owner.query(api.accountingPeriods.list, { orgId });
  await owner.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });
  const partnerId = await owner.mutation(api.partnerEquity.add, { orgId, partnerName: "Synthetic partner", idempotencyKey: "create-distribution-partner" });
  return { t, owner, orgId, partnerId };
}

async function financialState(seed: Awaited<ReturnType<typeof fixture>>) {
  return seed.t.run(async (ctx) => ({ movements: await ctx.db.query("partnerEquityTransactions").collect(),
    events: await ctx.db.query("accountingEvents").collect(), journals: await ctx.db.query("journalEntries").collect(),
    lines: await ctx.db.query("journalLines").collect(), commands: await ctx.db.query("commandIdempotency").collect() }));
}

test("uncertified profit distribution refuses server-side before any economic write", async () => {
  const seed = await fixture();
  const before = await financialState(seed);
  await expect(seed.owner.mutation(api.partnerEquity.recordEquityMovement, {
    orgId: seed.orgId, partnerId: seed.partnerId, type: "PROFIT_DISTRIBUTION", amountMinor: 100_003,
    idempotencyKey: "pilot-profit-distribution", occurredAt: Date.now(),
  })).rejects.toThrow("Profit distribution is not available during the pilot");
  expect(await financialState(seed)).toEqual(before);
});