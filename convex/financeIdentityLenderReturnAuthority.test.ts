import { expect, test } from "vitest";
import { pendingFinanceIdentityDeal, legacyFinancingMinor } from "../test-utils/financeIdentityBeforeHandoverFixture";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");
const applyCorrection = api.financeIdentityBeforeHandover.applyCorrection;
const detail = api.deliveredDealIdentityCorrections.detail;

async function fundedBuyerCorrection() {
  const { seed, args } = await pendingFinanceIdentityDeal(modules, { kind: "BUYER", creditStage: "APPROVED", replacementDownPaymentMajor: 500 });
  const target = { orgId: args.orgId, applicationId: args.applicationId };
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: 12_500_000, customerFirstPaymentMinor: 500_000, source: "MANUAL_ENTRY",
  });
  await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...target, approvedAmountMinor: 12_500_000, approvedFinancingAmountMinor: legacyFinancingMinor(12_500_000, 100), basis: "MANUAL", notes: "Original approval",
  });
  const paidAt = Date.now() - 60_000;
  const paymentId = await seed.approver.as.mutation(api.customerFinanceCompanyPayments.confirmFirstPayment, {
    ...target, amountMinor: 500_000, paidAt, reference: "Original receipt",
    kind: "RECEIPT", idempotencyKey: "funded-authority-original-receipt",
  });
  const proof = await seed.approver.as.query(detail, { ...target, kind: "BUYER" });
  if (proof?.state !== "BLOCKED" || !proof.lenderReturn) throw new Error("Expected lender return evidence");
  const request = {
    ...args, expectedUpdatedAt: proof.lenderReturn.updatedAt, expectedEconomicsStamp: proof.lenderReturn.economicsStamp,
    lenderConfirmationReference: "Terms for the replacement buyer",
    lenderReturn: {
      paymentId, receiptStamp: proof.lenderReturn.originalReceipt.receiptStamp, reference: "Full lender return",
      amountMinor: 500_000, refundedAt: paidAt, verifiedSamePayer: true as const,
    },
  };
  const snapshot = () => seed.t.run(async (ctx) => ({
    application: await ctx.db.get(target.applicationId),
    originalReceipt: await ctx.db.get(paymentId),
    corrections: await ctx.db.query("deliveredDealIdentityCorrections").withIndex("by_org_application", (q) =>
      q.eq("orgId", target.orgId).eq("applicationId", target.applicationId)).collect(),
    journals: await ctx.db.query("journalEntries").collect(),
  }));
  return { seed, target, request, snapshot };
}

test("a buyer correction without lender-payment authority cannot see or record the funded return", async () => {
  const { seed, target, request, snapshot } = await fundedBuyerCorrection();
  const reviewer = seed.actors.identityApprover.as;
  const before = await snapshot();
  const option = await reviewer.query(detail, { ...target, kind: "BUYER" });
  expect(option).toMatchObject({ state: "BLOCKED" });
  expect(option).not.toHaveProperty("lenderReturn");
  await expect(reviewer.mutation(applyCorrection, request)).rejects.toThrow(/verify lender payments/i);
  await expect(reviewer.mutation(applyCorrection, { ...request, lenderReturn: undefined })).rejects.toThrow(/payment records/i);
  await expect(snapshot()).resolves.toEqual(before);
});

test("a funded return refuses impersonation and unrelated receipts without financial or correction writes", async () => {
  const { seed, target, request, snapshot } = await fundedBuyerCorrection();
  const { foreignPaymentId, otherDealPaymentId, membershipId } = await seed.t.run(async (ctx) => {
    const payment = await ctx.db.get(request.lenderReturn.paymentId);
    const application = await ctx.db.get(target.applicationId);
    const membership = await ctx.db.query("memberships").withIndex("by_org_user", (q) =>
      q.eq("orgId", target.orgId).eq("userId", seed.approver.userId)).unique();
    if (!payment || !application || !membership) throw new Error("Missing funded authority fixture");
    const { _id: _paymentId, _creationTime: _paymentTime, ...receipt } = payment;
    const { _id: _applicationId, _creationTime: _applicationTime, ...original } = application;
    const otherApp = await ctx.db.insert("financeApplications", original);
    const otherOrg = await ctx.db.insert("organizations", { name: "Foreign funded evidence fixture", createdAt: Date.now() });
    return {
      foreignPaymentId: await ctx.db.insert("customerFinanceCompanyPayments", { ...receipt, orgId: otherOrg }),
      otherDealPaymentId: await ctx.db.insert("customerFinanceCompanyPayments", { ...receipt, applicationId: otherApp }),
      membershipId: membership._id,
    };
  });
  const before = await snapshot();
  const approve = seed.approver.as;
  await expect(approve.mutation(applyCorrection, {
    ...request, lenderReturn: { ...request.lenderReturn, paymentId: foreignPaymentId },
  })).rejects.toThrow(/not found/i);
  await expect(approve.mutation(applyCorrection, {
    ...request, lenderReturn: { ...request.lenderReturn, paymentId: otherDealPaymentId },
  })).rejects.toThrow(/evidence changed/i);
  await seed.t.run(async (ctx) => {
    const grantId = await ctx.db.insert("impersonationGrants", {
      orgId: target.orgId, membershipId, actorUserId: seed.approver.userId, targetUserId: seed.owner.userId,
      reason: "Synthetic support session", grantedAt: Date.now(), expiresAt: Date.now() + 60_000,
    });
    await ctx.db.patch(membershipId, { impersonationGrantId: grantId });
  });
  await expect(approve.query(detail, { ...target, kind: "BUYER" })).resolves.toBeNull();
  await expect(approve.mutation(applyCorrection, request)).rejects.toThrow(/end impersonation/i);
  await expect(snapshot()).resolves.toEqual(before);
});

test("a funded return requires current proof and a refund at or after its receipt and at or before correction", async () => {
  const { seed, target, request, snapshot } = await fundedBuyerCorrection();
  const before = await snapshot();
  const approve = seed.approver.as;
  await expect(approve.mutation(applyCorrection, { ...request, lenderReturn: undefined })).rejects.toThrow(/returned the full/i);
  for (const refundedAt of [Date.now() + 86_400_000, Number.NaN, Number.POSITIVE_INFINITY]) {
    await expect(approve.mutation(applyCorrection, {
      ...request, lenderReturn: { ...request.lenderReturn, refundedAt },
    })).rejects.toThrow(/LENDER_REFUND_TIME/);
  }
  await expect(approve.mutation(applyCorrection, {
    ...request, lenderReturn: { ...request.lenderReturn, refundedAt: request.lenderReturn.refundedAt - 1 },
  })).rejects.toThrow(/LENDER_REFUND_TIME/);
  await expect(snapshot()).resolves.toEqual(before);
  await expect(approve.mutation(applyCorrection, request)).resolves.toBe(target.applicationId);
  const after = await snapshot();
  await expect(approve.mutation(applyCorrection, request)).resolves.toBe(target.applicationId);
  await expect(approve.mutation(applyCorrection, {
    ...request, lenderReturn: { ...request.lenderReturn, reference: "Different lender return" },
  })).rejects.toThrow(/idempotency|same request|already used/i);
  await expect(approve.query(detail, { ...target, kind: "BUYER" })).resolves.toMatchObject({ state: "AVAILABLE_BEFORE_HANDOVER" });
  await expect(snapshot()).resolves.toEqual(after);
});
