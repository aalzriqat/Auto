import { expect, test } from "vitest";
import { pendingFinanceIdentityDeal } from "../test-utils/financeIdentityBeforeHandoverFixture";
import { G, newApplication, seedFinancedDealership } from "../test-utils/financedDealFixture";
import { api } from "./_generated/api";

import { legacyFinancingMinor } from "../test-utils/legacyFinancing";
const modules = import.meta.glob("./**/*.ts");

test("an existing reservation stays available for settlement when no first payment was agreed", async () => {
  const seed = await seedFinancedDealership("zero-first-payment", {
    modules, ownerPerms: [], actors: {}, label: "Zero first payment", vinPrefix: "ZFP",
  });
  const { orgId } = seed;
  const { applicationId, quoteId } = await newApplication(seed, { firstPaymentMinor: 0 });
  const target = { orgId, applicationId };
  const receipt = { orgId, quoteId, method: "CASH" as const };
  const depositId = await seed.approver.as.mutation(api.deposits.create, {
    ...receipt, amount: 200, idempotencyKey: "existing-reservation",
  });
  await seed.owner.as.mutation(api.applications.updateStatus, { ...target, status: "UNDER_REVIEW" });
  await seed.approver.as.mutation(api.applications.updateStatus, { ...target, status: "APPROVED" });
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: G, customerFirstPaymentMinor: 0, source: "MANUAL_ENTRY",
  });
  await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...target, approvedAmountMinor: G,
      approvedFinancingAmountMinor: legacyFinancingMinor(G, 100), basis: "MANUAL", notes: "Reservation is separate from first payment",
  });
  await expect(seed.approver.as.mutation(api.deposits.create, {
    ...receipt, amount: 1, idempotencyKey: "receipt-after-zero-agreed",
  })).rejects.toThrow(/first.payment/i);
  const economicsStamp = await seed.owner.as.query(api.applications.handoverStamp, target);
  await seed.owner.as.mutation(api.applications.registerVehicleHandover, {
    ...target, economicsStamp: economicsStamp ?? undefined,
  });
  await expect(seed.t.run((ctx) => ctx.db.get(depositId))).resolves.toMatchObject({
    status: "HELD", amountMinor: 200_000, holdActive: true,
  });
});

test("separate deposits retain separate proof and cannot overfill verified first-payment terms", async () => {
  const { seed, args, quoteId } = await pendingFinanceIdentityDeal(modules, {
    kind: "BUYER", creditStage: "APPROVED", originalFirstPaymentMinor: 500_000,
  });
  const target = { orgId: args.orgId, applicationId: args.applicationId };
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: 12_500_000, customerFirstPaymentMinor: 500_000, source: "MANUAL_ENTRY",
  });
  await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...target, approvedAmountMinor: 12_500_000,
      approvedFinancingAmountMinor: legacyFinancingMinor(12_500_000, 100), basis: "MANUAL", notes: "Second receipt terms",
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
  await expect(seed.owner.as.query(api.paymentVouchers.listQuoteReceipts, {
    orgId: args.orgId, quoteId,
  })).resolves.toMatchObject({ receipts: [{ _id: first }, { _id: second }], truncated: false });
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
  await seed.approver.as.mutation(api.deposits.voidDeposit, {
    orgId: args.orgId, depositId: second, reason: "Receipt recorded in error",
  });
  await expect(seed.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target)).resolves.toMatchObject({
    proof: { status: "BLOCKED", heldMinor: 0, directMinor: 0 },
  });
  await expect(seed.owner.as.query(api.paymentVouchers.listQuoteReceipts, {
    orgId: args.orgId, quoteId,
  })).resolves.toMatchObject({
    receipts: [{ _id: first, status: "REFUNDED" }, { _id: second, status: "VOIDED" }],
  });
  await expect(seed.owner.as.query(api.paymentVouchers.getByDeposit, {
    orgId: args.orgId, depositId: second,
  })).resolves.toMatchObject({ _id: vouchers[1]?._id });
});

test("supplier-direct intake cannot exceed the held deposit that financing can forward", async () => {
  const seed = await seedFinancedDealership("supplier-receipts", {
    modules, ownerPerms: [], actors: {}, label: "Supplier receipts", vinPrefix: "SR", sourced: true,
  });
  const { applicationId, quoteId } = await newApplication(seed, { firstPaymentMinor: 500_000 });
  const { orgId } = seed;
  const target = { orgId, applicationId };
  await seed.owner.as.mutation(api.applications.updateStatus, { ...target, status: "UNDER_REVIEW" });
  await seed.approver.as.mutation(api.applications.updateStatus, { ...target, status: "APPROVED" });
  await seed.owner.as.mutation(api.applications.setSupplierSettlementRoute, {
    ...target, route: "DIRECT_TO_SUPPLIER",
  });
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: G, customerFirstPaymentMinor: 500_000, source: "MANUAL_ENTRY",
  });
  await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...target, approvedAmountMinor: G,
      approvedFinancingAmountMinor: legacyFinancingMinor(G, 100), basis: "MANUAL", notes: "Supplier settlement",
  });
  const receipt = { orgId, quoteId, method: "CASH" as const };
  const first = await seed.approver.as.mutation(api.deposits.create, {
    ...receipt, amount: 200, idempotencyKey: "supplier-first-deposit",
  });
  await expect(seed.approver.as.mutation(api.deposits.create, {
    ...receipt, amount: 301, idempotencyKey: "supplier-overpayment",
  })).rejects.toThrow(/first.payment/i);
  const second = await seed.approver.as.mutation(api.deposits.create, {
    ...receipt, amount: 300, idempotencyKey: "supplier-exact-remainder",
  });
  await seed.owner.as.mutation(api.applications.cancelApplication, {
    ...target, failureReason: "CUSTOMER_WITHDREW", idempotencyKey: "supplier-cancel-two-deposits",
  });
  const rows = await seed.t.run((ctx) => Promise.all([first, second].map((id) => ctx.db.get(id))));
  expect(rows).toMatchObject([
    { status: "HELD", holdActive: false, amountMinor: 200_000 },
    { status: "HELD", holdActive: false, amountMinor: 300_000 },
  ]);
  await expect(seed.approver.as.mutation(api.deposits.create, {
    ...receipt, amount: 1, idempotencyKey: "supplier-after-cancel",
  })).rejects.toThrow(/already ended/i);
});

test("an approved manual lender letter caps additional receipts without a submitted quotation", async () => {
  const seed = await seedFinancedDealership("manual-receipts", {
    modules, ownerPerms: [], actors: {}, label: "Manual receipts", vinPrefix: "MAR",
  });
  const { orgId, customerId, vehicleId } = seed;
  const quoteId = await seed.owner.as.mutation(api.quotes.saveQuote, {
    orgId, customerId, vehicleId, mode: "MANUAL_FINANCE_COMPANY",
    manualProviderName: "Manual Bank", manualProfitRate: 6, manualInsuranceRate: 2,
    manualAdminFees: 0, vehiclePrice: G / 1000, downPayment: 500, termMonths: 48,
    totalFinancedAmount: G / 1000 - 500, customerEligibilityStatusIds: [seed.customerStatusId],
  });
  const applicationId = await seed.owner.as.mutation(api.applications.createFromQuote, { orgId, quoteId });
  const target = { orgId, applicationId };
  await seed.owner.as.mutation(api.applications.updateStatus, { ...target, status: "UNDER_REVIEW" });
  await seed.approver.as.mutation(api.applications.updateStatus, { ...target, status: "APPROVED" });
  // Exercise an existing approved letter while the pilot still blocks creating one.
  await seed.t.run((ctx) => ctx.db.patch(applicationId, {
    approvedDealerPurchaseAmountMinor: G,
    approvedPurchaseBasis: "MANUAL",
    rawAppraisalGapMinor: 0,
    manualApproval: {
      approvedAmountMinor: G, financierName: "Manual Bank", dealerSendsMinor: 0,
      enteredBy: seed.approver.userId, enteredAt: Date.now(),
    },
  }));
  const receipt = { orgId, quoteId, method: "CASH" as const };
  await seed.approver.as.mutation(api.deposits.create, { ...receipt, amount: 200, idempotencyKey: "manual-first" });
  await expect(seed.approver.as.mutation(api.deposits.create, {
    ...receipt, amount: 301, idempotencyKey: "manual-overfill",
  })).rejects.toThrow(/first.payment/i);
  await seed.approver.as.mutation(api.deposits.create, { ...receipt, amount: 300, idempotencyKey: "manual-second" });
  await expect(seed.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target)).resolves.toMatchObject({
    proof: { status: "READY", heldMinor: 500_000 },
  });
});

test("existing deposit history leaves enough proof capacity before accepting a new receipt or request", async () => {
  const { seed, args, quoteId } = await pendingFinanceIdentityDeal(modules, {
    kind: "BUYER", creditStage: "APPROVED", originalFirstPaymentMinor: 500_000,
  });
  const { orgId, applicationId } = args;
  const target = { orgId, applicationId };
  await seed.t.run(async (ctx) => {
    for (let index = 0; index < 50; index += 1) {
      await ctx.db.insert("deposits", {
        orgId, quoteId, customerId: seed.customerId, vehicleId: seed.vehicleId, amount: 1,
        status: "VOIDED", holdActive: false, createdBy: seed.owner.userId, createdAt: Date.now(),
      });
    }
  });
  await expect(seed.approver.as.mutation(api.deposits.create, {
    orgId, quoteId, method: "CASH", amount: 1, idempotencyKey: "history-overflow-before-terms",
  })).rejects.toThrow(/deposit history/i);
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: G, customerFirstPaymentMinor: 500_000, source: "MANUAL_ENTRY",
  });
  await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...target, approvedAmountMinor: G,
      approvedFinancingAmountMinor: legacyFinancingMinor(G, 100), basis: "MANUAL", notes: "Deposit history limit",
  });
  await expect(seed.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target)).resolves.toMatchObject({
    proof: { status: "BLOCKED", heldMinor: 0, directMinor: 0 },
  });
  await expect(seed.approver.as.mutation(api.deposits.create, {
    orgId, quoteId, method: "CASH", amount: 1, idempotencyKey: "history-overflow",
  })).rejects.toThrow(/deposit history/i);
  await expect(seed.owner.as.mutation(api.depositRequests.request, {
    orgId, quoteId, amount: 1, idempotencyKey: "history-overflow-request",
  })).rejects.toThrow(/deposit history/i);
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
