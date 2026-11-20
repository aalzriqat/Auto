import { expect, test } from "vitest";
import { api } from "./_generated/api";
import { registerHandover } from "../test-utils/convexTest";
import { newApplication, seedFinancedDealership } from "../test-utils/financedDealFixture";

const modules = import.meta.glob("./**/*.ts");

const {
  requestFirstPaymentEvidenceCorrection: requestCorrection,
  approveFirstPaymentEvidenceCorrection: approveCorrection,
  withdrawFirstPaymentEvidenceCorrection: withdrawCorrection,
} = api.customerFinanceCompanyPayments;

async function deliveredProof(tag: string) {
  const s = await seedFinancedDealership(tag, {
    modules, ownerPerms: [], actors: { verifier: ["confirm:finance_disbursement", "view:finance"] },
    label: "Delivered payment proof", vinPrefix: "PROOF-CORRECTION",
  });
  const { applicationId } = await newApplication(s);
  const target = { orgId: s.orgId, applicationId };
  await s.owner.as.mutation(api.applications.updateStatus, { ...target, status: "UNDER_REVIEW" });
  await s.approver.as.mutation(api.applications.updateStatus, { ...target, status: "APPROVED" });
  const requiredMinor = 350_000;
  const quotationMinor = 11_000_000;
  await s.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: quotationMinor, customerFirstPaymentMinor: requiredMinor,
    source: "MANUAL_ENTRY",
  });
  await s.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...target, approvedAmountMinor: quotationMinor, basis: "MANUAL", notes: "Original approval",
  });
  const originalPaidAt = Date.now() - 2_000;
  const paymentId = await s.approver.as.mutation(api.customerFinanceCompanyPayments.confirmFirstPayment, {
    ...target, amountMinor: requiredMinor, paidAt: originalPaidAt, reference: "Lender receipt 001",
    kind: "RECEIPT", idempotencyKey: "original-first-payment-proof",
  });
  await registerHandover(s.owner.as, api, s.orgId, applicationId);
  const original = await s.t.run((ctx) => ctx.db.get(applicationId));
  if (!original?.vehicleHandoverAt) throw new Error("Expected a recorded delivery");
  const replacement = {
    ...target, paymentId, expectedHandoverAt: original.vehicleHandoverAt,
    amountMinor: requiredMinor, paidAt: originalPaidAt - 1_000, reference: "Lender receipt 001",
    kind: "RECEIPT" as const, reason: "Corrected date confirmed by the financing company.",
    idempotencyKey: "request-first-payment-proof-correction",
  };
  return { s, target, original, originalPaidAt, replacement };
}

test("independently reapproves a corrected receipt without rewriting original delivery", async () => {
  const { s, target, original, originalPaidAt, replacement } = await deliveredProof("delivered-proof-correction");
  const correctionId = await s.approver.as.mutation(requestCorrection, replacement);
  const approval = { orgId: s.orgId, correctionId, idempotencyKey: "approve-first-payment-proof-correction" };
  await expect(s.approver.as.mutation(approveCorrection, approval)).rejects.toThrow(/independent finance verifier/);
  const correctedId = await s.actors.verifier.as.mutation(approveCorrection, approval);
  await expect(s.actors.verifier.as.mutation(approveCorrection, approval)).resolves.toBe(correctedId);

  const restored = await s.t.run(async (ctx) => ({
    deal: await ctx.db.get(target.applicationId),
    prior: await ctx.db.get(replacement.paymentId),
    current: await ctx.db.get(correctedId),
  }));
  expect(restored.deal).toMatchObject({
    _id: original._id, vehicleId: original.vehicleId, companyId: original.companyId,
    vehicleHandoverAt: original.vehicleHandoverAt, vehicleHandoverBy: original.vehicleHandoverBy,
  });
  expect(restored.prior).toMatchObject({ paidAt: originalPaidAt, amountMinor: replacement.amountMinor, status: "VOIDED" });
  expect(restored.current).toMatchObject({ paidAt: replacement.paidAt, amountMinor: replacement.amountMinor, status: "CONFIRMED" });
  expect(await s.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target)).toMatchObject({
    proof: { status: "READY", heldMinor: 0, directMinor: replacement.amountMinor },
  });
});

test("a pending correction blocks closing and an insufficient approved receipt rolls back", async () => {
  const { s, target, originalPaidAt, replacement } = await deliveredProof("insufficient-proof-correction");
  const correctionId = await s.approver.as.mutation(requestCorrection, {
    ...replacement, amountMinor: replacement.amountMinor - 1_000,
  });
  const { pendingCorrection, proof } = await s.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target);
  expect(proof.status).toBe("UNAVAILABLE");
  expect(pendingCorrection).toMatchObject({ _id: correctionId, canApprove: false, canWithdraw: true });
  expect(await s.approver.as.query(api.applications.getClosingReadiness, target)).toMatchObject({
    checks: expect.arrayContaining([
      expect.objectContaining({ key: "FIRST_PAYMENT_RECEIVED", status: "UNAVAILABLE", reasonCode: "FIRST_PAYMENT_PROOF_UNAVAILABLE" }),
    ]),
  });
  await expect(s.actors.verifier.as.mutation(approveCorrection, {
    orgId: s.orgId, correctionId, idempotencyKey: "approve-insufficient-proof",
  })).rejects.toThrow(/does not establish the agreed first payment/);
  expect(await s.t.run((ctx) => ctx.db.get(replacement.paymentId))).toMatchObject({
    status: "CONFIRMED", paidAt: originalPaidAt, amountMinor: replacement.amountMinor,
  });
  await s.approver.as.mutation(withdrawCorrection, { orgId: s.orgId, correctionId });
  const restored = await s.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target);
  expect(restored.proof).toMatchObject({ status: "READY", directMinor: replacement.amountMinor });
  expect(restored.pendingCorrection).toBeUndefined();
  expect(restored.records).toHaveLength(1);
});

test("withdrawing the source confirmation makes its pending replacement ineligible", async () => {
  const { s, target, replacement } = await deliveredProof("withdrawn-source-correction");
  const correctionId = await s.approver.as.mutation(requestCorrection, replacement);
  await s.approver.as.mutation(api.customerFinanceCompanyPayments.voidFirstPayment, {
    ...target, paymentId: replacement.paymentId, reason: "The lender withdrew the receipt.",
  });

  await expect(s.actors.verifier.as.mutation(approveCorrection, {
    orgId: s.orgId, correctionId, idempotencyKey: "approve-after-source-withdrawal",
  })).rejects.toThrow(/receipt is no longer eligible/);
  await s.approver.as.mutation(withdrawCorrection, { orgId: s.orgId, correctionId });

  const result = await s.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target);
  expect(result.proof).toMatchObject({ status: "BLOCKED", directMinor: 0 });
  expect(result.records).toHaveLength(1);
  expect(result.records[0]).toMatchObject({ _id: replacement.paymentId, status: "VOIDED" });
});
