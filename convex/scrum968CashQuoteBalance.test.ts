import { expect, test } from "vitest";
import { seedCashDealer } from "../test-utils/cashDealerFixture";
import { api } from "./_generated/api";

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
