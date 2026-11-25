import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import { ORGANIZATION_DELETION_STEPS } from "./adminOrgs";
import { registerHandover } from "../test-utils/convexTest";
import { newApplication, payForwardBeforeFinalize, seedFinancedDealership } from "../test-utils/financedDealFixture";

import { legacyFinancingMinor } from "../test-utils/legacyFinancing";
const modules = import.meta.glob("./**/*.ts");

async function deliveredProof(tag: string, heldMinor = 0) {
  const s = await seedFinancedDealership(tag, {
    modules, ownerPerms: [], actors: { verifier: ["confirm:finance_disbursement", "view:finance"] },
    label: "Delivered payment proof", vinPrefix: "PROOF-CORRECTION",
  });
  const { applicationId, quoteId } = await newApplication(s);
  const target = { orgId: s.orgId, applicationId };
  await s.owner.as.mutation(api.applications.updateStatus, { ...target, status: "UNDER_REVIEW" });
  await s.approver.as.mutation(api.applications.updateStatus, { ...target, status: "APPROVED" });
  const lenderMinor = 350_000;
  const requiredMinor = lenderMinor + heldMinor;
  const quotationMinor = 11_000_000;
  await s.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: quotationMinor, customerFirstPaymentMinor: requiredMinor,
    source: "MANUAL_ENTRY",
  });
  await s.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...target, approvedAmountMinor: quotationMinor,
      approvedFinancingAmountMinor: legacyFinancingMinor(quotationMinor, 85), basis: "MANUAL", notes: "Original approval",
  });
  if (heldMinor > 0) {
    await s.approver.as.mutation(api.deposits.create, {
      orgId: s.orgId, quoteId, amount: heldMinor / 1000, method: "CASH",
      idempotencyKey: "original-dealership-deposit",
    });
  }
  const originalPaidAt = Date.now() - 2_000;
  const paymentId = await s.approver.as.mutation(api.customerFinanceCompanyPayments.confirmFirstPayment, {
    ...target, amountMinor: lenderMinor, paidAt: originalPaidAt, reference: "Lender receipt 001",
    kind: "RECEIPT", idempotencyKey: "original-first-payment-proof",
  });
  await registerHandover(s.owner.as, api, s.orgId, applicationId);
  const original = await s.t.run((ctx) => ctx.db.get(applicationId));
  if (!original?.vehicleHandoverAt) throw new Error("Expected a recorded delivery");
  const replacement = {
    ...target, paymentId, expectedHandoverAt: original.vehicleHandoverAt,
    amountMinor: lenderMinor, paidAt: originalPaidAt - 1_000, reference: "Lender receipt 001",
    kind: "RECEIPT" as const, reason: "Corrected date confirmed by the financing company.",
    idempotencyKey: "request-first-payment-proof-correction",
  };
  return { s, target, original, originalPaidAt, replacement };
}

test("independently reapproves a corrected receipt without rewriting original delivery", async () => {
  const { s, target, original, originalPaidAt, replacement } = await deliveredProof("delivered-proof-correction");
  const correctionId = await s.approver.as.mutation(api.firstPaymentEvidenceCorrections.requestFirstPaymentEvidenceCorrection, replacement);
  const approval = { orgId: s.orgId, correctionId, idempotencyKey: "approve-first-payment-proof-correction" };
  const verifierView = await s.actors.verifier.as.query(api.customerFinanceCompanyPayments.firstPayment, target);
  expect(verifierView.pendingCorrection).toMatchObject({ _id: correctionId, canApprove: true });
  await expect(s.approver.as.mutation(api.firstPaymentEvidenceCorrections.approveFirstPaymentEvidenceCorrection, approval)).rejects.toThrow(/independent finance verifier/);
  const correctedId = await s.actors.verifier.as.mutation(api.firstPaymentEvidenceCorrections.approveFirstPaymentEvidenceCorrection, approval);
  await expect(s.actors.verifier.as.mutation(api.firstPaymentEvidenceCorrections.approveFirstPaymentEvidenceCorrection, approval)).resolves.toBe(correctedId);

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

test.each([
  { heldMinor: 200_000, requiredMinor: 550_000 },
  { heldMinor: 0, requiredMinor: 350_000 },
])("an approved amount correction keeps the actual lender receipt with $heldMinor held", async ({ heldMinor, requiredMinor }) => {
  const { s, target, replacement } = await deliveredProof(`larger-receipt-correction-${heldMinor}`, heldMinor);
  const correctionId = await s.approver.as.mutation(api.firstPaymentEvidenceCorrections.requestFirstPaymentEvidenceCorrection, {
    ...replacement, amountMinor: 360_000, paidAt: replacement.paidAt + 1_000,
  });
  await s.actors.verifier.as.mutation(api.firstPaymentEvidenceCorrections.approveFirstPaymentEvidenceCorrection, {
    orgId: s.orgId, correctionId, idempotencyKey: "approve-corrected-receipt-amount",
  });
  expect(await s.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target)).toMatchObject({
    proof: { status: "READY", requiredMinor, heldMinor, directMinor: 360_000 },
  });
  expect(await s.approver.as.query(api.applications.getClosingReadiness, target)).toMatchObject({
    checks: expect.arrayContaining([
      expect.objectContaining({ key: "FIRST_PAYMENT_RECEIVED", status: "READY" }),
    ]),
  });
});

test.each([false, true])("receipt correction preserves the original proof kind (date also changes: %s)", async (changesDate) => {
  const { s, target, originalPaidAt, replacement } = await deliveredProof("proof-kind-" + changesDate);
  await expect(s.approver.as.mutation(api.firstPaymentEvidenceCorrections.requestFirstPaymentEvidenceCorrection, {
    ...replacement,
    paidAt: changesDate ? replacement.paidAt : originalPaidAt,
    kind: "CONFIRMATION",
  })).rejects.toThrow(/keep the original proof type/i);
  const proof = await s.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target);
  expect(proof.pendingCorrection).toBeUndefined();
  expect(proof.records[0]).toMatchObject({ _id: replacement.paymentId, kind: "RECEIPT", status: "CONFIRMED" });
});

test("a pending correction blocks closing and an insufficient approved receipt rolls back", async () => {
  const { s, target, originalPaidAt, replacement } = await deliveredProof("insufficient-proof-correction");
  const correctionId = await s.approver.as.mutation(api.firstPaymentEvidenceCorrections.requestFirstPaymentEvidenceCorrection, {
    ...replacement, amountMinor: replacement.amountMinor - 1_000,
  });
  const { pendingCorrection, proof } = await s.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target);
  expect(proof.status).toBe("UNAVAILABLE");
  expect(pendingCorrection).toMatchObject({ _id: correctionId, canApprove: false, canWithdraw: true });
  const verifierView = await s.actors.verifier.as.query(api.customerFinanceCompanyPayments.firstPayment, target);
  expect(verifierView.pendingCorrection).toMatchObject({ _id: correctionId, canApprove: false, canWithdraw: true });
  expect(await s.approver.as.query(api.applications.getClosingReadiness, target)).toMatchObject({
    checks: expect.arrayContaining([
      expect.objectContaining({ key: "FIRST_PAYMENT_RECEIVED", status: "UNAVAILABLE", reasonCode: "FIRST_PAYMENT_PROOF_UNAVAILABLE" }),
    ]),
  });
  await expect(s.actors.verifier.as.mutation(api.firstPaymentEvidenceCorrections.approveFirstPaymentEvidenceCorrection, {
    orgId: s.orgId, correctionId, idempotencyKey: "approve-insufficient-proof",
  })).rejects.toThrow(/does not establish the agreed first payment/);
  expect(await s.t.run((ctx) => ctx.db.get(replacement.paymentId))).toMatchObject({
    status: "CONFIRMED", paidAt: originalPaidAt, amountMinor: replacement.amountMinor,
  });
  await s.approver.as.mutation(api.firstPaymentEvidenceCorrections.withdrawFirstPaymentEvidenceCorrection, { orgId: s.orgId, correctionId });
  const restored = await s.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target);
  expect(restored.proof).toMatchObject({ status: "READY", directMinor: replacement.amountMinor });
  expect(restored.pendingCorrection).toBeUndefined();
  expect(restored.records).toHaveLength(1);
});

test("withdrawing the source confirmation makes its pending replacement ineligible", async () => {
  const { s, target, replacement } = await deliveredProof("withdrawn-source-correction");
  const correctionId = await s.approver.as.mutation(api.firstPaymentEvidenceCorrections.requestFirstPaymentEvidenceCorrection, replacement);
  await s.approver.as.mutation(api.customerFinanceCompanyPayments.voidFirstPayment, {
    ...target, paymentId: replacement.paymentId, reason: "The lender withdrew the receipt.",
  });
  const viewer = await s.actors.verifier.as.query(api.customerFinanceCompanyPayments.firstPayment, target);
  expect(viewer.pendingCorrection).toMatchObject({ _id: correctionId, canApprove: false, canWithdraw: true });

  await expect(s.actors.verifier.as.mutation(api.firstPaymentEvidenceCorrections.approveFirstPaymentEvidenceCorrection, {
    orgId: s.orgId, correctionId, idempotencyKey: "approve-after-source-withdrawal",
  })).rejects.toThrow(/receipt is no longer eligible/);
  await s.approver.as.mutation(api.firstPaymentEvidenceCorrections.withdrawFirstPaymentEvidenceCorrection, { orgId: s.orgId, correctionId });

  const result = await s.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target);
  expect(result.proof).toMatchObject({ status: "BLOCKED", directMinor: 0 });
  expect(result.records).toHaveLength(1);
  expect(result.records[0]).toMatchObject({ _id: replacement.paymentId, status: "VOIDED" });
});

test("a fiftieth payment record consumes the last correction slot", async () => {
  const { s, target, replacement } = await deliveredProof("full-receipt-history");
  await s.t.run(async (ctx) => {
    for (let i = 0; i < 48; i += 1) {
      await ctx.db.insert("customerFinanceCompanyPayments", {
        ...target, status: "VOIDED", amountMinor: 1_000, currency: "JOD",
        paidAt: replacement.paidAt, reference: "Voided receipt " + i,
        confirmedBy: s.approver.userId, confirmedAt: replacement.paidAt,
        voidedBy: s.approver.userId, voidedAt: replacement.expectedHandoverAt,
      });
    }
  });
  const correctionId = await s.approver.as.mutation(
    api.firstPaymentEvidenceCorrections.requestFirstPaymentEvidenceCorrection, replacement,
  );
  const paymentId = await s.actors.verifier.as.mutation(api.firstPaymentEvidenceCorrections.approveFirstPaymentEvidenceCorrection, {
    orgId: s.orgId, correctionId, idempotencyKey: "fill-last-slot",
  });
  await expect(s.approver.as.mutation(api.firstPaymentEvidenceCorrections.requestFirstPaymentEvidenceCorrection, {
    ...replacement, paymentId, paidAt: replacement.paidAt - 1_000, idempotencyKey: "no-correction-slot",
  })).rejects.toThrow(/review this deal.s existing payment records/);
  const proof = await s.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target);
  expect(proof).toMatchObject({ proof: { status: "READY" }, records: expect.arrayContaining([
    expect.objectContaining({ _id: paymentId, status: "CONFIRMED" }),
  ]) });
  expect(proof.correctionHandoverAt).toBeUndefined();
  expect(proof.pendingCorrection).toBeUndefined();
});

test("a live finance forward prevents opening a delivered-first-payment correction", async () => {
  const { s, target, replacement } = await deliveredProof("delivered-proof-forward", 200_000);
  await s.owner.as.mutation(api.applications.registerExpectedPayment, {
    ...target, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });
  const feeId = await s.owner.as.mutation(api.financeDealCosts.recordDealFee, {
    ...target, expectedCurrency: "JOD", idempotencyKey: "no-closing-costs",
    feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER", paidTo: "OTHER", accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: false, actualAmountMinor: 0, description: "No closing costs.",
  });
  await s.owner.as.mutation(api.financeDealCosts.reconcileDealFee, {
    orgId: s.orgId, feeId, notes: "Matched.", expectedActualAmountMinor: 0, expectedActualEvidenceRevision: 0,
  });
  expect(await payForwardBeforeFinalize(s, s.approver.as, target.applicationId)).not.toBeNull();
  await expect(s.approver.as.mutation(
    api.firstPaymentEvidenceCorrections.requestFirstPaymentEvidenceCorrection, replacement,
  )).rejects.toThrow(/already been paid to the finance company/);
  const proof = await s.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target);
  expect(proof).toMatchObject({ proof: { status: "READY" } });
  expect(proof.correctionHandoverAt).toBeUndefined();
  expect(proof.pendingCorrection).toBeUndefined();
});

test("legacy receipt indexing keeps correction approval and new requests unavailable", async () => {
  const { s, target, replacement } = await deliveredProof("delivered-proof-indexing");
  const correctionId = await s.approver.as.mutation(api.firstPaymentEvidenceCorrections.requestFirstPaymentEvidenceCorrection, replacement);
  await s.t.run((ctx) => ctx.db.insert("customerFinanceCompanyPayments", {
    ...target, status: "CONFIRMED", amountMinor: 1_000, currency: "JOD",
    paidAt: replacement.paidAt, reference: "Legacy appraisal-gap receipt",
    confirmedBy: s.approver.userId, confirmedAt: replacement.paidAt,
  }));
  const verifierView = await s.actors.verifier.as.query(api.customerFinanceCompanyPayments.firstPayment, target);
  expect(verifierView.pendingCorrection).toMatchObject({ _id: correctionId, canApprove: false, canWithdraw: true });
  await expect(s.actors.verifier.as.mutation(api.firstPaymentEvidenceCorrections.approveFirstPaymentEvidenceCorrection, {
    orgId: s.orgId, correctionId, idempotencyKey: "indexing-approval",
  })).rejects.toThrow(/being indexed/);
  await s.approver.as.mutation(api.firstPaymentEvidenceCorrections.withdrawFirstPaymentEvidenceCorrection, { orgId: s.orgId, correctionId });
  await expect(s.approver.as.mutation(api.firstPaymentEvidenceCorrections.requestFirstPaymentEvidenceCorrection, {
    ...replacement, idempotencyKey: "indexing-request",
  })).rejects.toThrow(/being indexed/);
  const restored = await s.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target);
  expect(restored.pendingCorrection).toBeUndefined();
  expect(restored.records[0]).toMatchObject({ _id: replacement.paymentId, status: "CONFIRMED" });
});

test("organization purge drains delivered payment corrections before advancing the saved receipt cursor", async () => {
  const { s, target, replacement } = await deliveredProof("delivered-proof-purge");
  const correctionId = await s.approver.as.mutation(
    api.firstPaymentEvidenceCorrections.requestFirstPaymentEvidenceCorrection, replacement,
  );
  const receiptCursor = ORGANIZATION_DELETION_STEPS.findIndex(
    (step) => step.kind === "orgRows" && step.table === "customerFinanceCompanyPayments",
  );
  expect(receiptCursor).toBeGreaterThanOrEqual(0);
  const requestId = await s.t.run(async (ctx) => {
    await ctx.db.patch(s.orgId, { suspended: true });
    return await ctx.db.insert("organizationDeletionRequests", {
      orgId: s.orgId, orgName: "Delivered payment proof", requestedBy: s.owner.userId,
      requestedAt: Date.now(), status: "RUNNING", currentStepIndex: receiptCursor,
    });
  });

  await expect(s.t.mutation(internal.adminOrgs.runDeletionRequestBatch, { requestId })).resolves.toMatchObject({
    status: "RUNNING", currentStepIndex: receiptCursor, deletedInBatch: 1,
  });
  const state = await s.t.run(async (ctx) => ({
    correction: await ctx.db.get(correctionId),
    source: await ctx.db.get(replacement.paymentId),
    application: await ctx.db.get(target.applicationId),
  }));
  expect(state.correction).toBeNull();
  expect(state.source?.status).toBe("CONFIRMED");
  expect(state.application?.vehicleHandoverAt).toBe(replacement.expectedHandoverAt);
});
