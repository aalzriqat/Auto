import { expect } from "vitest";
import { api } from "../convex/_generated/api";
import { registerHandover } from "./convexTest";
import { pendingFinanceIdentityDeal } from "./financeIdentityBeforeHandoverFixture";

export async function expectFinanceIdentityLenderReturn(
  modules: Record<string, () => Promise<unknown>>,
  kind: "BUYER" | "VEHICLE",
  receivedMinor: number,
  evidenceKind: "RECEIPT" | "CONFIRMATION",
) {
  const { seed, args, original } = await pendingFinanceIdentityDeal(modules, { kind, creditStage: "APPROVED", replacementDownPaymentMajor: 500 });
  const target = { orgId: args.orgId, applicationId: args.applicationId };
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: 12_500_000, customerFirstPaymentMinor: 500_000, source: "MANUAL_ENTRY",
  });
  await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...target, approvedAmountMinor: 12_500_000, basis: "MANUAL", notes: "Original approval",
  });
  const paidAt = Date.now();
  const paymentId = await seed.approver.as.mutation(api.customerFinanceCompanyPayments.confirmFirstPayment, {
    ...target, amountMinor: receivedMinor, paidAt, reference: "Original lender receipt",
    kind: evidenceKind, idempotencyKey: "original-direct-receipt-for-return",
  });

  const detail = await seed.approver.as.query(api.deliveredDealIdentityCorrections.detail, { ...target, kind });
  expect(detail).toMatchObject({
    state: "BLOCKED",
    lenderReturn: {
      originalReceipt: { paymentId, paidAt, amountMinor: receivedMinor, currency: "JOD" },
      options: [expect.objectContaining({ quoteId: args.replacementQuoteId })],
    },
  });
  if (detail?.state !== "BLOCKED" || !detail.lenderReturn) throw new Error("Expected lender return option");
  const before = await seed.t.run((ctx) => ctx.db.get(target.applicationId));
  const journalsBefore = await seed.t.run((ctx) => ctx.db.query("journalEntries").collect());
  const correction = {
    ...args, expectedUpdatedAt: detail.lenderReturn.updatedAt, expectedEconomicsStamp: detail.lenderReturn.economicsStamp,
    lenderConfirmationReference: "LENDER-REPLACEMENT-TERMS",
    lenderReturn: {
      paymentId, receiptStamp: detail.lenderReturn.originalReceipt.receiptStamp,
      reference: "LENDER REFUND-001", amountMinor: receivedMinor, refundedAt: Date.now(), verifiedSamePayer: true as const,
    },
  };
  const apply = () => seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, correction);
  await expect(seed.owner.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, correction))
    .rejects.toThrow(/independent/i);
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, {
    ...correction, lenderReturn: { ...correction.lenderReturn, amountMinor: receivedMinor - 1 },
  })).rejects.toThrow(/full lender refund/i);
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, {
    ...correction, lenderReturn: { ...correction.lenderReturn, receiptStamp: "stale" },
  })).rejects.toThrow(/first-payment evidence changed/i);
  await expect(seed.t.run((ctx) => ctx.db.get(target.applicationId))).resolves.toEqual(before);
  await expect(seed.t.run((ctx) => ctx.db.get(paymentId))).resolves.toMatchObject({ status: "CONFIRMED" });

  await expect(apply()).resolves.toBe(args.applicationId);
  await expect(apply()).resolves.toBe(args.applicationId);
  await expect(seed.t.run((ctx) => ctx.db.get(target.applicationId))).resolves.toMatchObject({
    dealId: original.dealId, dealNumber: original.dealNumber, quoteId: args.replacementQuoteId,
    customerFirstPaymentMinor: 500_000, status: "PENDING_DOCS", handoverStatus: "BLOCKED",
  });
  const returned = await seed.t.run((ctx) => ctx.db.get(paymentId));
  expect(returned).toMatchObject({
    status: "VOIDED", reference: "Original lender receipt", amountMinor: receivedMinor,
    lenderReturn: {
      reference: "LENDER REFUND-001", amountMinor: receivedMinor, originalCustomerId: original.customerId,
      verifiedSamePayer: true,
    },
  });
  if (!returned?.lenderReturn) throw new Error("Expected original refund evidence");
  await expect(seed.t.run((ctx) => ctx.db.query("deliveredDealIdentityCorrections")
    .withIndex("by_org_returned_first_payment", (q) => q.eq("orgId", target.orgId).eq("returnedDirectFirstPaymentId", paymentId))
    .unique())).resolves.toMatchObject({
    applicationId: target.applicationId, returnedDirectFirstPaymentId: paymentId, kind,
  });
  await expect(seed.t.run((ctx) => ctx.db.query("journalEntries").collect())).resolves.toEqual(journalsBefore);
  await expect(seed.approver.as.query(api.deliveredDealIdentityCorrections.detail, { ...target, kind }))
    .resolves.toMatchObject({ state: "AVAILABLE_BEFORE_HANDOVER" });

  await seed.owner.as.mutation(api.applications.updateStatus, { ...target, status: "UNDER_REVIEW" });
  await seed.approver.as.mutation(api.applications.updateStatus, { ...target, status: "APPROVED" });
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: 12_500_000, source: "MANUAL_ENTRY",
  });
  await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...target, approvedAmountMinor: 12_500_000, basis: "MANUAL", notes: "New approval",
  });
  const deliver = () => registerHandover(seed.owner.as, api, target.orgId, target.applicationId);
  await expect(deliver()).rejects.toThrow(/verify the customer's agreed first payment/i);
  const evidence = await seed.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target);
  expect(evidence).toMatchObject({ replacementAgreementStartsAt: expect.any(Number), proof: { status: "BLOCKED", directMinor: 0 } });
  const nextReceipt = {
    ...target, expectedAgreement: evidence.agreement, amountMinor: 500_000, paidAt: Date.now(),
    reference: "New lender receipt", kind: "RECEIPT" as const, idempotencyKey: "replacement-agreement-payment",
  };
  await expect(seed.approver.as.mutation(api.customerFinanceCompanyPayments.confirmFirstPayment, nextReceipt))
    .rejects.toThrow(/verify a lender receipt/i);
  const verifyPayment = (reference: string) => seed.approver.as.mutation(api.customerFinanceCompanyPayments.confirmFirstPayment, {
    ...nextReceipt, reference, verifiedReplacementAgreement: true,
  });
  await expect(verifyPayment(" original lender   receipt ")).rejects.toThrow(/returned first payment/i);
  await expect(verifyPayment("lender refund-001")).rejects.toThrow(/returned first payment/i);
  await expect(verifyPayment(nextReceipt.reference)).resolves.toEqual(expect.any(String));
  await expect(deliver()).resolves.toBeGreaterThan(0);
}
