import { expect, test } from "vitest";
import { pendingFinanceIdentityDeal } from "../test-utils/financeIdentityBeforeHandoverFixture";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

test("separate deposits retain separate proof and cannot overfill verified first-payment terms", async () => {
  const { seed, args, quoteId } = await pendingFinanceIdentityDeal(modules, {
    kind: "BUYER", creditStage: "APPROVED", originalFirstPaymentMinor: 500_000,
  });
  const target = { orgId: args.orgId, applicationId: args.applicationId };
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: 12_500_000, customerFirstPaymentMinor: 500_000, source: "MANUAL_ENTRY",
  });
  await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...target, approvedAmountMinor: 12_500_000, basis: "MANUAL", notes: "Second receipt terms",
  });
  const receipt = { orgId: args.orgId, quoteId, method: "CASH" as const };
  const first = await seed.approver.as.mutation(api.deposits.create, {
    ...receipt, amount: 200, idempotencyKey: "first-receipt",
  });
  const request = await seed.owner.as.mutation(api.depositRequests.request, {
    orgId: args.orgId, quoteId, amount: 300, idempotencyKey: "second-receipt-request",
  });
  await expect(seed.owner.as.mutation(api.depositRequests.request, {
    orgId: args.orgId, quoteId, amount: 1, idempotencyKey: "competing-extra-request",
  })).rejects.toThrow(/first.payment/i);
  await expect(seed.approver.as.mutation(api.customerFinanceCompanyPayments.confirmFirstPayment, {
    ...target, amountMinor: 300_000, kind: "RECEIPT", reference: "DIRECT-PAYMENT",
    paidAt: Date.now(), idempotencyKey: "competing-direct-lender-proof",
  })).rejects.toThrow(/deposit request is still waiting/i);
  const app = await seed.owner.as.query(api.applications.get, target);
  await expect(seed.owner.as.mutation(api.applications.registerVehicleHandover, {
    ...target, economicsStamp: app?.economicsStamp,
  })).rejects.toThrow(/deposit request is still waiting/i);
  await expect(seed.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target)).resolves.toMatchObject({
    proof: { status: "BLOCKED", heldMinor: 200_000 },
  });
  const confirmation = {
    orgId: args.orgId, requestId: request, amount: 300, method: "CASH" as const,
    idempotencyKey: "second-receipt-confirmation",
  };
  const second = await seed.approver.as.mutation(api.depositRequests.confirm, confirmation);
  expect(second).not.toBe(first);
  await expect(seed.approver.as.mutation(api.depositRequests.confirm, confirmation)).resolves.toEqual(second);
  const vouchers = await Promise.all([first, second].map((depositId) =>
    seed.approver.as.query(api.paymentVouchers.getByDeposit, { orgId: args.orgId, depositId })));
  expect(vouchers.map((voucher) => voucher?.amount)).toEqual([200, 300]);
  expect(vouchers[0]?._id).not.toEqual(vouchers[1]?._id);
  await expect(seed.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target)).resolves.toMatchObject({
    proof: { status: "READY", heldMinor: 500_000, directMinor: 0 },
  });
  await expect(seed.approver.as.mutation(api.deposits.create, {
    ...receipt, amount: 1, idempotencyKey: "overpayment",
  })).rejects.toThrow(/first.payment/i);
  const entries = await seed.t.run((ctx) => ctx.db.query("accountingEvents").collect());
  expect(entries.filter((event) => event.eventType === "DEPOSIT_RECEIVED")).toEqual([
    expect.objectContaining({ sourceId: first, status: "POSTED" }),
    expect.objectContaining({ sourceId: second, status: "POSTED" }),
  ]);
  await seed.owner.as.mutation(api.deposits.release, {
    orgId: args.orgId, depositId: first, resolution: "REFUNDED", refundMethod: "CASH",
    idempotencyKey: "refund-original-deposit",
  });
  await expect(seed.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target)).resolves.toMatchObject({
    proof: { status: "BLOCKED", heldMinor: 300_000, directMinor: 0 },
  });
});

test("a stale receipt and request cannot add money to handed-over deal terms", async () => {
  const { seed, args, quoteId } = await pendingFinanceIdentityDeal(modules, {
    kind: "BUYER",
    creditStage: "APPROVED",
  });
  const receipt = { orgId: args.orgId, quoteId, method: "CASH" as const, amount: 300 };
  const firstCommand = { ...receipt, amount: 200, idempotencyKey: "original-receipt" };
  const first = await seed.approver.as.mutation(api.deposits.create, firstCommand);
  const request = await seed.owner.as.mutation(api.depositRequests.request, {
    orgId: args.orgId, quoteId, amount: 300, idempotencyKey: "receipt-before-handover",
  });
  await seed.t.run((ctx) => ctx.db.patch(args.applicationId, { vehicleHandoverAt: Date.now() }));

  await expect(seed.approver.as.mutation(api.deposits.create, firstCommand)).resolves.toBe(first);
  const before = await seed.t.run((ctx) => ctx.db.query("accountingEvents").collect());
  await expect(seed.approver.as.mutation(api.depositRequests.confirm, {
    orgId: args.orgId, requestId: request, amount: 300, method: "CASH", idempotencyKey: "stale-confirmation",
  })).rejects.toThrow(/handover/i);
  await seed.owner.as.mutation(api.depositRequests.withdraw, { orgId: args.orgId, requestId: request });
  await expect(seed.approver.as.mutation(api.deposits.create, {
    ...receipt, idempotencyKey: "stale-receipt",
  })).rejects.toThrow(/handover/i);
  await expect(seed.owner.as.mutation(api.depositRequests.request, {
    orgId: args.orgId, quoteId, amount: 300, idempotencyKey: "stale-request",
  })).rejects.toThrow(/handover/i);
  await expect(seed.t.run((ctx) => ctx.db.query("accountingEvents").collect())).resolves.toEqual(before);
});
