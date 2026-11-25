import { expect, test, vi } from "vitest";
import { seedCashDealer } from "../test-utils/cashDealerFixture";
import { ConvexError } from "convex/values";
import { api } from "./_generated/api";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }), check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

test("the cash quote reports actual posted receipts and the remaining amount", async () => {
  const { t, asUser, orgId, vehicleId, customerId } = await seedCashDealer(
    "actual-cash-quote", import.meta.glob("./**/*.ts"),
  );
  const quoteId = await asUser.mutation(api.quotes.saveQuote, {
    orgId, vehicleId, customerId, mode: "CASH", vehiclePrice: 20_000, downPayment: 0, termMonths: 0,
  });
  const target = { orgId, quoteId };
  const balance = () => asUser.query(api.paymentVouchers.cashQuoteReceiptBalance, target);
  await expect(balance()).resolves.toEqual({
    currency: "JOD", scale: 3, totalMinor: 20_000_000, receivedMinor: 0, remainingMinor: 20_000_000,
  });

  const firstId = await asUser.mutation(api.deposits.create, {
    ...target, amount: 5_000, method: "CASH", idempotencyKey: "actual-opening-deposit",
  });
  await expect(balance()).resolves.toMatchObject({ receivedMinor: 5_000_000, remainingMinor: 15_000_000 });
  const secondId = await asUser.mutation(api.deposits.create, {
    ...target, amount: 3_000, method: "CASH", idempotencyKey: "actual-later-deposit",
  });
  expect(secondId).not.toBe(firstId);
  await expect(balance()).resolves.toMatchObject({ receivedMinor: 8_000_000, remainingMinor: 12_000_000 });
  await asUser.mutation(api.deposits.voidDeposit, {
    orgId, depositId: secondId, reason: "Entered twice",
  });
  await expect(balance()).resolves.toMatchObject({ receivedMinor: 5_000_000, remainingMinor: 15_000_000 });

  // A held row without its matching posted payment cannot verify the balance.
  await t.run((ctx) => ctx.db.patch(firstId, { canonicalPaymentId: undefined }));
  await expect(balance()).resolves.toBeNull();
});

async function openCashQuote(tag: string) {
  const dealer = await seedCashDealer(tag, import.meta.glob("./**/*.ts"));
  const quoteId = await dealer.asUser.mutation(api.quotes.saveQuote, {
    orgId: dealer.orgId, vehicleId: dealer.vehicleId, customerId: dealer.customerId,
    mode: "CASH", vehiclePrice: 20_000, downPayment: 0, termMonths: 0,
  });
  return { ...dealer, quoteId };
}

test("a member of another organization and a signed-out caller are refused by code", async () => {
  const { t, orgId, quoteId, asUser } = await openCashQuote("balance-auth");
  await asUser.mutation(api.deposits.create, {
    orgId, quoteId, amount: 5_000, method: "CASH", idempotencyKey: "balance-auth-deposit",
  });
  const other = await t.run(async (ctx) => {
    const otherOrg = await ctx.db.insert("organizations", { name: "Other org", createdAt: Date.now() });
    const userId = await ctx.db.insert("users", { clerkId: "balance_other", email: "o@e.com", name: "Other" });
    const roleId = await ctx.db.insert("roles", { orgId: otherOrg, name: "Owner", permissions: ["view:sales"] });
    await ctx.db.insert("memberships", { orgId: otherOrg, userId, roleId });
    return otherOrg;
  });
  const asOther = t.withIdentity({ subject: "balance_other", clerkId: "balance_other" });
  await expect(asOther.query(api.paymentVouchers.cashQuoteReceiptBalance, { orgId, quoteId }))
    .rejects.toMatchObject({ data: { code: "UNAUTHORIZED" } });
  // Their own org is authorised, but the quote is not theirs: no balance is disclosed.
  await expect(asOther.query(api.paymentVouchers.cashQuoteReceiptBalance, { orgId: other, quoteId }))
    .rejects.toBeInstanceOf(ConvexError);
  await expect(t.query(api.paymentVouchers.cashQuoteReceiptBalance, { orgId, quoteId }))
    .rejects.toMatchObject({ data: { code: "UNAUTHENTICATED" } });
});

test("a quote that is not an open stock cash quote has no balance", async () => {
  const notCash = await openCashQuote("balance-not-cash");
  await notCash.t.run((ctx) => ctx.db.patch(notCash.quoteId, { mode: "INTERNAL_INSTALLMENT" }));
  await expect(notCash.asUser.query(api.paymentVouchers.cashQuoteReceiptBalance, {
    orgId: notCash.orgId, quoteId: notCash.quoteId,
  })).resolves.toBeNull();

  const expired = await openCashQuote("balance-expired");
  await expired.t.run((ctx) => ctx.db.patch(expired.quoteId, { status: "EXPIRED" }));
  await expect(expired.asUser.query(api.paymentVouchers.cashQuoteReceiptBalance, {
    orgId: expired.orgId, quoteId: expired.quoteId,
  })).resolves.toBeNull();
});

test("a completed cash quote hands over to the invoice and reports no balance", async () => {
  const { asUser, orgId, userId, customerId, vehicleId } = await seedCashDealer(
    "balance-completed", import.meta.glob("./**/*.ts"),
  );
  const quoteId = await asUser.mutation(api.quotes.saveQuote, {
    orgId, vehicleId, customerId, mode: "CASH", vehiclePrice: 20_000, downPayment: 0, termMonths: 0,
  });
  await asUser.mutation(api.deposits.create, {
    orgId, quoteId, amount: 20_000, method: "CASH", idempotencyKey: "balance-completed-deposit",
  });
  await expect(asUser.query(api.paymentVouchers.cashQuoteReceiptBalance, { orgId, quoteId }))
    .resolves.toMatchObject({ receivedMinor: 20_000_000, remainingMinor: 0 });
  await asUser.mutation(api.sales.create, {
    quoteId, idempotencyKey: "balance-completed-sale", orgId, vehicleId, customerId, salespersonId: userId,
    salePrice: 20_000, saleDate: Date.now(), status: "COMPLETED", financingType: "CASH",
  });
  await expect(asUser.query(api.paymentVouchers.cashQuoteReceiptBalance, { orgId, quoteId })).resolves.toBeNull();
});

// A quote stores its price with no denomination, so the org currency may not change once any quote exists
// (existence lock in convex/orgSettings.ts, like financeApplications and financeCompanies).
async function ownerDealer(tag: string) {
  const dealer = await seedCashDealer(tag, import.meta.glob("./**/*.ts"));
  // `orgSettings.upsert` is owner-only.
  await dealer.t.run(async (ctx) => {
    const role = await ctx.db.query("roles").first();
    await ctx.db.patch(role!._id, { isSystemOwnerRole: true });
  });
  return dealer;
}
const CURRENCY_LOCKED = /cannot be changed after financial records exist/;

test("a JOD cash quote blocks the switch to USD, so the balance is never read in the wrong currency", async () => {
  const { t, asUser, orgId, vehicleId, customerId } = await ownerDealer("quote-currency-lock");
  const quoteId = await asUser.mutation(api.quotes.saveQuote, {
    orgId, vehicleId, customerId, mode: "CASH", vehiclePrice: 20_000, downPayment: 0, termMonths: 0,
  });
  await expect(asUser.mutation(api.orgSettings.upsert, { orgId, currency: "USD" })).rejects.toThrow(CURRENCY_LOCKED);
  await expect(t.run((ctx) => ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).first()))
    .resolves.toMatchObject({ currency: "JOD" });
  await asUser.mutation(api.deposits.create, {
    orgId, quoteId, amount: 5_000, method: "CASH", idempotencyKey: "quote-currency-lock-deposit",
  });
  await expect(asUser.query(api.paymentVouchers.cashQuoteReceiptBalance, { orgId, quoteId })).resolves.toEqual({
    currency: "JOD", scale: 3, totalMinor: 20_000_000, receivedMinor: 5_000_000, remainingMinor: 15_000_000,
  });
});

test("an expired quote still blocks the currency change", async () => {
  const { t, asUser, orgId, vehicleId, customerId } = await ownerDealer("quote-currency-expired");
  const quoteId = await asUser.mutation(api.quotes.saveQuote, {
    orgId, vehicleId, customerId, mode: "CASH", vehiclePrice: 20_000, downPayment: 0, termMonths: 0,
  });
  await t.run((ctx) => ctx.db.patch(quoteId, { status: "EXPIRED" }));
  await expect(asUser.mutation(api.orgSettings.upsert, { orgId, currency: "USD" })).rejects.toThrow(CURRENCY_LOCKED);
});

test("an organization with no quote can still change its currency", async () => {
  const { t, asUser, orgId } = await ownerDealer("quote-currency-none");
  await expect(asUser.mutation(api.orgSettings.upsert, { orgId, currency: "USD" })).resolves.toBeDefined();
  await expect(t.run((ctx) => ctx.db.query("orgSettings").withIndex("by_org", (q) => q.eq("orgId", orgId)).first()))
    .resolves.toMatchObject({ currency: "USD" });
});