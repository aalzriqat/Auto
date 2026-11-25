import { expect, test } from "vitest";
import { registerHandover } from "../test-utils/convexTest";
import {
  finalizeAsOwner,
  newApplication,
  seedFinancedDealership,
} from "../test-utils/financedDealFixture";
import { api } from "./_generated/api";

import { legacyFinancingMinor } from "../test-utils/legacyFinancing";
const modules = import.meta.glob("./**/*.ts");

async function deliveredDealWithReplacementQuote(tag: string) {
  const s = await seedFinancedDealership(tag, {
    modules,
    ownerPerms: [],
    actors: { observer: ["view:finance", "view:finance_applications"] },
    label: "Delivered lender correction",
    vinPrefix: "LENDER-CORRECTION",
  });
  const { applicationId, quoteId } = await newApplication(s);
  const target = { orgId: s.orgId, applicationId };
  await s.owner.as.mutation(api.applications.updateStatus, {
    ...target,
    status: "UNDER_REVIEW",
  });
  await s.approver.as.mutation(api.applications.updateStatus, {
    ...target,
    status: "APPROVED",
  });
  await s.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target,
    submittedQuotationMinor: 12_500_000,
    customerFirstPaymentMinor: 0,
    source: "MANUAL_ENTRY",
  });
  await s.approver.as.mutation(
    api.financingEconomics.approveDealerPurchaseAmount,
    {
      ...target,
      approvedAmountMinor: 12_500_000,
      approvedFinancingAmountMinor: legacyFinancingMinor(12_500_000, 85),
      basis: "MANUAL",
      notes: "Original approval",
    },
  );
  await registerHandover(s.owner.as, api, s.orgId, applicationId);
  const original = await s.t.run((ctx) => ctx.db.get(applicationId));
  const stamp = await s.owner.as.query(api.applications.handoverStamp, target);
  if (
    !original?.vehicleHandoverAt ||
    !original.dealId ||
    original.dealNumber === undefined ||
    stamp === null
  ) {
    throw new Error(
      "The fixture must create a canonical deal and record its delivery.",
    );
  }
  const lenderId = await s.t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId: s.orgId,
      name: "Replacement lender",
      profitRate: 5,
      maxTermMonths: 60,
      gracePeriodMonths: 0,
      isActive: true,
      defaultLtvPercent: 100,
      adminFees: 0,
    }),
  );
  const replacementQuoteId = await s.owner.as.mutation(api.quotes.saveQuote, {
    orgId: s.orgId,
    customerId: s.customerId,
    vehicleId: s.vehicleId,
    vehiclePrice: 12_500,
    downPayment: 0,
    termMonths: 48,
    mode: "CONFIGURED_FINANCE_COMPANY",
    companyId: lenderId,
    customerEligibilityStatusIds: [s.customerStatusId],
    totalFinancedAmount: 12_500,
  });
  await s.owner.as.mutation(api.quotes.updateQuoteStatus, {
    orgId: s.orgId,
    quoteId: replacementQuoteId,
    status: "ACCEPTED",
  });
  const proposal = {
    ...target,
    replacementQuoteId,
    expectedHandoverAt: original.vehicleHandoverAt,
    expectedEconomicsStamp: stamp,
    reason:
      "The customer accepted the new lender for the same delivered vehicle.",
    idempotencyKey: "request-delivered-lender-correction",
  };
  return {
    s,
    target,
    applicationId,
    quoteId,
    original,
    lenderId,
    replacementQuoteId,
    proposal,
  };
}

test("requesting a lender replacement keeps the original agreement and suspends closing proof", async () => {
  const { s, target, applicationId, quoteId, original, proposal } =
    await deliveredDealWithReplacementQuote("request-delivered-lender");
  const requestId = await s.owner.as.mutation(
    api.deliveredLenderCorrections.request,
    proposal,
  );
  await expect(s.actors.observer.as.query(api.deliveredLenderCorrections.detail, target))
    .resolves.toBeNull();
  await expect(
    s.owner.as.mutation(api.deliveredLenderCorrections.request, proposal),
  ).resolves.toBe(requestId);
  expect(
    await s.owner.as.query(api.deliveredLenderCorrections.detail, target),
  ).toMatchObject({
    kind: "PENDING",
    correctionId: requestId,
    canApprove: false,
  });
  expect(
    await s.approver.as.query(api.deliveredLenderCorrections.detail, target),
  ).toMatchObject({
    kind: "PENDING",
    correctionId: requestId,
    canApprove: true,
  });
  expect(await s.t.run((ctx) => ctx.db.get(applicationId))).toMatchObject({
    _id: applicationId,
    dealId: original.dealId,
    dealNumber: original.dealNumber,
    quoteId,
    companyId: s.companyId,
    vehicleHandoverAt: original.vehicleHandoverAt,
    vehicleHandoverBy: original.vehicleHandoverBy,
  });
  const proof = await s.approver.as.query(
    api.customerFinanceCompanyPayments.firstPayment,
    target,
  );
  expect(proof.proof).toEqual({ status: "UNAVAILABLE" });

  await s.owner.as.mutation(api.deliveredLenderCorrections.withdraw, {
    orgId: s.orgId,
    correctionId: requestId,
  });
  const restored = await s.approver.as.query(
    api.customerFinanceCompanyPayments.firstPayment,
    target,
  );
  expect(restored.proof).toEqual({
    status: "READY",
    requiredMinor: 0,
    heldMinor: 0,
    directMinor: 0,
  });
  expect(await s.t.run((ctx) => ctx.db.get(applicationId))).toMatchObject({
    quoteId,
    companyId: s.companyId,
    vehicleHandoverAt: original.vehicleHandoverAt,
  });
});

test("an expired replacement stays withdrawable and is no longer offered for approval", async () => {
  const { s, target, replacementQuoteId, proposal } =
    await deliveredDealWithReplacementQuote("expiry-lender");
  const correctionId = await s.owner.as.mutation(
    api.deliveredLenderCorrections.request,
    proposal,
  );
  await s.owner.as.mutation(api.quotes.updateQuoteStatus, {
    orgId: s.orgId,
    quoteId: replacementQuoteId,
    status: "EXPIRED",
  });
  expect(
    await s.approver.as.query(api.deliveredLenderCorrections.detail, target),
  ).toMatchObject({ kind: "PENDING", correctionId, canApprove: false });
  await expect(
    s.approver.as.mutation(api.deliveredLenderCorrections.approve, {
      orgId: s.orgId,
      correctionId,
      lenderApprovalReference: "Replacement lender confirmation",
      idempotencyKey: "approve-expired-replacement",
    }),
  ).rejects.toThrow(/accepted quote/i);
  await expect(
    s.owner.as.mutation(api.deliveredLenderCorrections.withdraw, {
      orgId: s.orgId,
      correctionId,
    }),
  ).resolves.toBeNull();
});

test("issued custody blocks lender approval and new requests without modifying either agreement", async () => {
  const { s, target, quoteId, proposal } = await deliveredDealWithReplacementQuote("custody-lender");
  const correctionId = await s.owner.as.mutation(api.deliveredLenderCorrections.request, proposal);
  await s.owner.as.mutation(api.financeDealCosts.openDealCustody, {
    ...target,
    userId: s.actors.observer.userId,
    issuedMinor: 10_000,
    method: "CASH",
    idempotencyKey: "issue-custody-during-lender-correction",
  });
  expect(await s.approver.as.query(api.deliveredLenderCorrections.detail, target))
    .toMatchObject({ kind: "PENDING", correctionId, canApprove: false });
  await expect(s.approver.as.mutation(api.deliveredLenderCorrections.approve, {
    orgId: s.orgId,
    correctionId,
    lenderApprovalReference: "Replacement lender confirmation",
    idempotencyKey: "approve-with-custody",
  })).rejects.toThrow(/existing payment records/i);
  await s.owner.as.mutation(api.deliveredLenderCorrections.withdraw, { orgId: s.orgId, correctionId });
  expect(await s.owner.as.query(api.deliveredLenderCorrections.detail, target))
    .toEqual({ kind: "BLOCKED", reason: "RECORDED_MONEY" });
  await expect(s.owner.as.mutation(api.deliveredLenderCorrections.request, {
    ...proposal,
    idempotencyKey: "request-with-custody",
  })).rejects.toThrow(/existing payment records/i);
  expect(await s.t.run((ctx) => ctx.db.get(target.applicationId)))
    .toMatchObject({ quoteId, companyId: s.companyId });
});

test("a noncanonical replacement cannot enter the approval queue", async () => {
  const { s, target, proposal, replacementQuoteId } =
    await deliveredDealWithReplacementQuote("noncanonical-lender");
  const legacyQuoteId = await s.t.run(async (ctx) => {
    const quote = await ctx.db.get(replacementQuoteId);
    if (!quote) throw new Error("Missing replacement quote");
    const { _id, _creationTime, ...fields } = quote;
    return ctx.db.insert("quotes", fields);
  });
  const detail = await s.owner.as.query(api.deliveredLenderCorrections.detail, target);
  expect(detail).toMatchObject({ kind: "AVAILABLE", replacements: [{ quoteId: replacementQuoteId }] });
  await expect(s.owner.as.mutation(api.deliveredLenderCorrections.request, {
    ...proposal,
    replacementQuoteId: legacyQuoteId,
  })).rejects.toThrow(/records for these quotes/i);
  const correctionId = await s.owner.as.mutation(api.deliveredLenderCorrections.request, proposal);
  await s.t.run((ctx) => ctx.db.patch(target.applicationId, { currentCommitmentClaims: undefined }));
  expect(await s.approver.as.query(api.deliveredLenderCorrections.detail, target))
    .toMatchObject({ kind: "PENDING", correctionId, canApprove: false });
});

test("a delivered multi-vehicle deal cannot enter the single-vehicle correction", async () => {
  const { s, target, proposal } = await deliveredDealWithReplacementQuote("multi-vehicle-lender");
  await s.t.run(async (ctx) => {
    const vehicle = await ctx.db.get(s.vehicleId);
    if (!vehicle) throw new Error("Missing delivered vehicle");
    const { _id, _creationTime, ...fields } = vehicle;
    const secondVehicleId = await ctx.db.insert("vehicles", { ...fields, vin: "LENDER-CORRECTION-SECOND" });
    await ctx.db.patch(target.applicationId, {
      vehicleItems: [
        { vehicleId: s.vehicleId, unitPrice: 10_000 },
        { vehicleId: secondVehicleId, unitPrice: 2_500 },
      ],
    });
  });
  expect(await s.owner.as.query(api.deliveredLenderCorrections.detail, target)).toBeNull();
  await expect(s.owner.as.mutation(api.deliveredLenderCorrections.request, proposal))
    .rejects.toThrow(/delivered deal/i);
});

test("an older eligible replacement remains available after an empty results page", async () => {
  const { s, target, replacementQuoteId } = await deliveredDealWithReplacementQuote("paged-lender");
  await s.t.run(async (ctx) => {
    const quote = await ctx.db.get(replacementQuoteId);
    if (!quote) throw new Error("Fixture must have a replacement quote");
    const { _id, _creationTime, ...fields } = quote;
    for (let index = 0; index < 25; index++) {
      await ctx.db.insert("quotes", { ...fields, companyId: s.companyId });
    }
  });
  const page = await s.owner.as.query(api.deliveredLenderCorrections.detail, target);
  expect(page).toMatchObject({ kind: "AVAILABLE", replacements: [], nextCursor: expect.any(String) });
  if (page?.kind !== "AVAILABLE" || !page.nextCursor) throw new Error("Missing continuation");
  const next = await s.owner.as.query(api.deliveredLenderCorrections.detail, { ...target, cursor: page.nextCursor });
  expect(next).toMatchObject({ kind: "AVAILABLE", replacements: [{ quoteId: replacementQuoteId }] });
});

test("independent lender replacement preserves the deal and physical handover, and requires new finance evidence", async () => {
  const {
    s,
    target,
    applicationId,
    quoteId,
    original,
    lenderId,
    replacementQuoteId,
    proposal,
  } = await deliveredDealWithReplacementQuote("approve-delivered-lender");
  const correctionId = await s.owner.as.mutation(
    api.deliveredLenderCorrections.request,
    proposal,
  );
  const approval = {
    orgId: s.orgId,
    correctionId,
    lenderApprovalReference: "Replacement lender acknowledgement RL-112",
    idempotencyKey: "approve-delivered-lender-correction",
  };
  await expect(
    s.owner.as.mutation(api.deliveredLenderCorrections.approve, approval),
  ).rejects.toThrow(/independent/i);
  await expect(
    s.approver.as.mutation(api.deliveredLenderCorrections.approve, approval),
  ).resolves.toBe(applicationId);
  await expect(
    s.approver.as.mutation(api.deliveredLenderCorrections.approve, approval),
  ).resolves.toBe(applicationId);

  const current = await s.t.run((ctx) => ctx.db.get(applicationId));
  expect(current).toMatchObject({
    _id: applicationId,
    dealId: original.dealId,
    dealNumber: original.dealNumber,
    quoteId: replacementQuoteId,
    companyId: lenderId,
    vehicleHandoverAt: original.vehicleHandoverAt,
    vehicleHandoverBy: original.vehicleHandoverBy,
    status: "PENDING_DOCS",
  });
  expect(current?.approvedDealerPurchaseAmountMinor).toBeUndefined();
  expect(original.underwritingSnapshot).toBeDefined();
  expect(original.quotationCalculationSnapshot).toBeDefined();
  expect(await s.t.run((ctx) => ctx.db.get(correctionId))).toMatchObject({
    originalApproval: {
      underwritingSnapshot: original.underwritingSnapshot,
      quotationSnapshot: original.quotationCalculationSnapshot,
      basis: original.approvedPurchaseBasis,
      notes: original.approvedPurchaseNotes,
    },
  });
  expect(
    (await s.owner.as.query(api.applications.getClosingReadiness, target))
      .state,
  ).not.toBe("READY");
  await s.owner.as.mutation(api.applications.updateStatus, {
    ...target,
    status: "UNDER_REVIEW",
  });
  await s.approver.as.mutation(api.applications.updateStatus, {
    ...target,
    status: "APPROVED",
  });
  const withoutFreshEvidence = await s.approver.as.query(
    api.customerFinanceCompanyPayments.firstPayment,
    target,
  );
  expect(withoutFreshEvidence.proof).toEqual({ status: "UNAVAILABLE" });

  await s.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target,
    submittedQuotationMinor: 12_500_000,
    customerFirstPaymentMinor: 0,
    source: "MANUAL_ENTRY",
  });
  expect((await s.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target)).proof)
    .toEqual({ status: "UNAVAILABLE" });
  await s.approver.as.mutation(
    api.financingEconomics.approveDealerPurchaseAmount,
    {
      ...target,
      approvedAmountMinor: 12_500_000,
      approvedFinancingAmountMinor: legacyFinancingMinor(12_500_000, 85),
      basis: "MANUAL",
      notes: "Replacement lender approval",
    },
  );
  const renewed = await s.approver.as.query(
    api.customerFinanceCompanyPayments.firstPayment,
    target,
  );
  expect(renewed.proof).toEqual({
    status: "READY",
    requiredMinor: 0,
    heldMinor: 0,
    directMinor: 0,
  });

  await s.owner.as.mutation(api.applications.cancelApplication, {
    ...target,
    reason: "Replacement agreement did not proceed.",
    idempotencyKey: "cancel-after-lender-correction",
  });
  expect(await s.t.run((ctx) => ctx.db.get(quoteId))).toMatchObject({
    supersededAt: expect.any(Number),
  });
  expect(await s.t.run((ctx) => ctx.db.get(correctionId))).toMatchObject({
    originalQuoteId: quoteId,
    replacementQuoteId,
  });
  await expect(
    s.owner.as.mutation(api.applications.createFromQuote, {
      orgId: s.orgId,
      quoteId,
    }),
  ).rejects.toThrow(/cannot be committed/i);
});

test("closes through the current lender and quote without allocating another deal number", async () => {
  const {
    s,
    target,
    applicationId,
    original,
    lenderId,
    replacementQuoteId,
    proposal,
  } = await deliveredDealWithReplacementQuote("close-delivered-lender");
  const ruleId = await s.t.run((ctx) => ctx.db.insert("companyDocumentRules", {
    orgId: s.orgId,
    companyId: lenderId,
    documentName: "Replacement lender documents",
    isRequired: true,
  }));
  const correctionId = await s.owner.as.mutation(
    api.deliveredLenderCorrections.request,
    proposal,
  );
  await s.approver.as.mutation(api.deliveredLenderCorrections.approve, {
    orgId: s.orgId,
    correctionId,
    lenderApprovalReference: "Replacement approval RL-113",
    idempotencyKey: "approve-for-closing",
  });
  await s.owner.as.mutation(api.applications.updateStatus, {
    ...target,
    status: "UNDER_REVIEW",
  });
  await expect(s.approver.as.mutation(api.applications.updateStatus, {
    ...target,
    status: "APPROVED",
  })).rejects.toThrow(/required finance documents.*replacement lender documents/i);
  const document = await s.t.run((ctx) => ctx.db.query("applicationDocuments")
    .withIndex("by_application", (q) => q.eq("applicationId", applicationId))
    .filter((q) => q.eq(q.field("ruleId"), ruleId)).unique());
  if (!document) throw new Error("Replacement lender document was not initialized");
  expect(document.status).toBe("MISSING");
  const fileId = await s.t.run((ctx) => ctx.storage.store(
    new Blob(["%PDF-1.4\nReplacement lender documents"], { type: "application/pdf" }),
  ));
  // convex-test omits Content-Type metadata when storing a Blob.
  await s.t.run((ctx) =>
    (ctx.db as unknown as { patch: (id: typeof fileId, fields: { contentType: string }) => Promise<void> })
      .patch(fileId, { contentType: "application/pdf" }),
  );
  await s.owner.as.mutation(api.documents.saveDocumentFile, {
    orgId: s.orgId,
    documentId: document._id,
    fileId,
  });
  await s.approver.as.mutation(api.documents.updateDocumentStatus, {
    orgId: s.orgId,
    documentId: document._id,
    status: "VERIFIED",
  });
  await s.approver.as.mutation(api.applications.updateStatus, {
    ...target,
    status: "APPROVED",
  });
  await s.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target,
    submittedQuotationMinor: 12_500_000,
    customerFirstPaymentMinor: 0,
    source: "MANUAL_ENTRY",
  });
  await s.approver.as.mutation(
    api.financingEconomics.approveDealerPurchaseAmount,
    {
      ...target,
      approvedAmountMinor: 12_500_000,
      approvedFinancingAmountMinor: legacyFinancingMinor(12_500_000, 85),
      basis: "MANUAL",
      notes: "Replacement lender approval",
    },
  );
  await s.owner.as.mutation(api.applications.registerExpectedPayment, {
    ...target,
    method: "BANK_TRANSFER",
    expectedDate: Date.now(),
  });
  const feeId = await s.owner.as.mutation(api.financeDealCosts.recordDealFee, {
    ...target,
    expectedCurrency: "JOD",
    idempotencyKey: "zero-closing-cost",
    feeType: "OTHER_CLOSING_EXPENSE",
    paidBy: "DEALER",
    paidTo: "OTHER",
    accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: false,
    actualAmountMinor: 0,
    description: "No closing costs.",
  });
  await s.owner.as.mutation(api.financeDealCosts.reconcileDealFee, {
    orgId: s.orgId,
    feeId,
    notes: "No closing costs.",
    expectedActualAmountMinor: 0,
    expectedActualEvidenceRevision: 0,
  });
  await finalizeAsOwner(s, applicationId);
  const finalized = await s.t.run(async (ctx) => {
    const application = await ctx.db.get(applicationId);
    if (!application?.finalizedSaleId)
      throw new Error("Expected a finalized sale on the corrected deal.");
    return { sale: await ctx.db.get(application.finalizedSaleId), application };
  });
  expect(finalized.sale).toMatchObject({
    applicationId,
    quoteId: replacementQuoteId,
    dealId: original.dealId,
    dealNumber: original.dealNumber,
  });
  expect(finalized.application).toMatchObject({
    status: "CLOSED",
    companyId: lenderId,
    vehicleHandoverAt: original.vehicleHandoverAt,
  });
});
