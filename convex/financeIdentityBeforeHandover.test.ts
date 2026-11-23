import { isDeepStrictEqual } from "node:util";
import { expect, test } from "vitest";
import { registerHandover } from "../test-utils/convexTest";
import { pendingFinanceIdentityDeal } from "../test-utils/financeIdentityBeforeHandoverFixture";
import { api } from "./_generated/api";
import { resolveOwnership } from "./commitments";
import { economicsStamp, handoverStatusForFacts } from "./utils/financingEconomics";

const modules = import.meta.glob("./**/*.ts");
test.each([
  { case: "buyer awaiting documents", kind: "BUYER", creditStage: "PENDING_DOCS" },
  { case: "vehicle awaiting documents", kind: "VEHICLE", creditStage: "PENDING_DOCS" },
  { case: "vehicle already in credit review", kind: "VEHICLE", creditStage: "UNDER_REVIEW" },
  { case: "buyer with credit approval and no purchase terms", kind: "BUYER", creditStage: "APPROVED" },
] as const)("$case correction keeps the deal and restarts evidence review", async ({ kind, creditStage }) => {
  const { seed, original, quoteId, customerId, vehicleId, args } = await pendingFinanceIdentityDeal(modules, kind, creditStage);
  const target = { orgId: args.orgId, applicationId: args.applicationId };
  const { ruleId, documentId } = await seed.t.run(async (ctx) => {
    const ruleId = await ctx.db.insert("companyDocumentRules", {
      orgId: args.orgId, companyId: seed.companyId, documentName: "Signed identity", isRequired: true,
    });
    const fileId = await ctx.storage.store(new Blob(["verified original"], { type: "application/pdf" }));
    const documentId = await ctx.db.insert("applicationDocuments", {
      ...target, ruleId, fileId, status: "VERIFIED", verifiedBy: seed.approver.userId,
    });
    return { ruleId, documentId };
  });

  const action = api.financeIdentityBeforeHandover.applyCorrection;
  await expect(seed.approver.as.query(api.deliveredDealIdentityCorrections.detail, { ...target, kind }))
    .resolves.toMatchObject({
      state: "AVAILABLE_BEFORE_HANDOVER",
      options: [expect.objectContaining({ quoteId: args.replacementQuoteId })],
    });
  await expect(seed.owner.as.mutation(action, args)).rejects.toThrow(/independent/i);
  await expect(seed.approver.as.mutation(action, { ...args, expectedUpdatedAt: args.expectedUpdatedAt - 1 }))
    .rejects.toThrow(/changed/i);
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, args)).resolves.toBe(args.applicationId);
  await expect(seed.approver.as.mutation(action, args)).resolves.toBe(args.applicationId);

  const updated = await seed.t.run(async (ctx) => ({
    application: await ctx.db.get(args.applicationId),
    oldQuote: await ctx.db.get(quoteId),
    replacementQuote: await ctx.db.get(args.replacementQuoteId),
    document: await ctx.db.get(documentId),
    oldVehicle: await ctx.db.get(seed.vehicleId),
    currentOwnership: await resolveOwnership(ctx, args.orgId, vehicleId),
    oldOwnership: await resolveOwnership(ctx, args.orgId, seed.vehicleId),
    events: (await ctx.db.query("adminAuditLog").collect()).filter((row) =>
      row.targetId === args.applicationId && row.action === "CORRECT_FINANCE_IDENTITY_BEFORE_HANDOVER"),
    correctionHistory: await ctx.db.query("deliveredDealIdentityCorrections")
      .withIndex("by_org_application", (q) => q.eq("orgId", args.orgId).eq("applicationId", args.applicationId))
      .collect(),
  }));
  expect(updated.application).toMatchObject({
    dealId: original.dealId, dealNumber: original.dealNumber, customerId, vehicleId,
    quoteId: args.replacementQuoteId, status: "PENDING_DOCS", creditDecision: "SUBMITTED", handoverStatus: "BLOCKED",
  });
  expect(updated.application?.vehicleHandoverAt).toBeUndefined();
  expect(updated.application?.approvedAt).toBeUndefined();
  expect(updated.application?.approvedBy).toBeUndefined();
  const pricing = updated.replacementQuote?.customerQuotePricingSnapshot;
  if (!pricing) throw new Error("Expected frozen replacement quote pricing");
  expect(updated.application?.underwritingSnapshot).toMatchObject({
    employerAtSubmission: "Current employer", salaryAtSubmission: 1_500,
    totalMonthlyDebtAtSubmission: 135, proposedMonthlyInstallment: pricing.monthlyInstallment,
    dbrAtSubmission: (135 + pricing.monthlyInstallment) / 1_500,
    guarantorsAtSubmission: [{ firstName: "Current", lastName: "Guarantor", nationalIdLastFour: "7890" }],
    vehicleValuationAtSubmission: 15_000, ltvAtSubmission: (pricing.totalFinancedAmount / 15_000) * 100,
  });
  expect(updated.application?.approvedIdentityCorrectionId).toBeUndefined();
  expect(updated.oldQuote?.supersededAt).toBeDefined();
  expect(updated.document?.supersededAt).toBeDefined();
  expect(updated.currentOwnership).toMatchObject({
    kind: "OWNED", root: { customerId, vehicleId, headQuoteId: args.replacementQuoteId },
  });
  if (kind === "VEHICLE") {
    expect(updated.oldOwnership.kind).toBe("FREE");
    expect(updated.oldVehicle?.status).toBe("AVAILABLE");
  }
  expect(updated.events).toHaveLength(1);
  expect(updated.events[0]).toMatchObject({
    actorUserId: seed.approver.userId, before: { quoteId, customerId: seed.customerId, vehicleId: seed.vehicleId },
    after: { quoteId: args.replacementQuoteId, customerId, vehicleId, reason: args.reason },
  });
  if (creditStage === "APPROVED") {
    expect(updated.events[0]).toMatchObject({
      before: { creditApproval: { approvedAt: original.approvedAt, approvedBy: original.approvedBy } },
    });
    expect(updated.application?.companyRuleSnapshot?.ruleVersion).toBe(8);
    expect(updated.application?.companyRuleVersionId).toBeDefined();
    expect(updated.application?.companyRuleVersionId).not.toBe(original.companyRuleVersionId);
  }
  const originalValues = Object.entries(original).filter(([key, value]) =>
    !key.startsWith("_") && !isDeepStrictEqual(value, Reflect.get(updated.application ?? {}, key)));
  expect(updated.correctionHistory).toEqual([expect.objectContaining({
    status: "APPLIED_BEFORE_HANDOVER", originalQuoteId: quoteId, replacementQuoteId: args.replacementQuoteId,
    originalValues: expect.objectContaining(Object.fromEntries(originalValues)),
  })]);
  const [history] = updated.correctionHistory;
  await expect(seed.approver.as.mutation(api.deliveredDealIdentityCorrections.approve, {
    orgId: args.orgId, correctionId: history._id, returnedAt: Date.now(),
    returnReference: "Historical correction fixture", idempotencyKey: "approve-historical-correction",
  })).rejects.toThrow("This correction has already been applied.");
  await expect(seed.approver.as.mutation(api.deliveredDealIdentityCorrections.withdraw, {
    orgId: args.orgId, correctionId: history._id,
  })).rejects.toThrow("This correction is no longer awaiting a decision.");
  const log = await seed.actors.sales.as.query(api.applications.getLog, target);
  expect(log).toContainEqual(expect.objectContaining({ note: "Buyer or vehicle corrected before handover. Obtain fresh finance evidence." }));
  await expect(seed.approver.as.query(api.deliveredDealIdentityCorrections.detail, { ...target, kind }))
    .resolves.not.toMatchObject({ state: "APPROVED" });
  await expect(seed.owner.as.query(api.documents.getHistoryForApplication, target))
    .resolves.toEqual([expect.objectContaining({ _id: documentId, status: "VERIFIED" })]);
  await expect(seed.owner.as.query(api.documents.getForApplication, target))
    .resolves.toEqual([expect.objectContaining({ _id: null, ruleId, status: "MISSING" })]);
  await seed.owner.as.mutation(api.applications.updateStatus, { ...target, status: "UNDER_REVIEW" });
  await expect(seed.approver.as.mutation(api.applications.updateStatus, { ...target, status: "APPROVED" }))
    .rejects.toThrow(/required finance documents/i);
  const newDocumentId = await seed.owner.as.mutation(api.documents.ensureApplicationDocument, { ...target, ruleId });
  await seed.approver.as.mutation(api.documents.updateDocumentStatus, {
    orgId: target.orgId, documentId: newDocumentId, status: "WAIVED", waiverReason: "Independent replacement identity check",
  });
  await seed.approver.as.mutation(api.applications.updateStatus, { ...target, status: "APPROVED" });
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: 12_500_000, customerFirstPaymentMinor: 0, source: "MANUAL_ENTRY",
  });
  await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...target, approvedAmountMinor: 12_500_000, basis: "MANUAL", notes: "Replacement approval",
  });
  await registerHandover(seed.owner.as, api, target.orgId, target.applicationId);
  await expect(seed.t.run((ctx) => ctx.db.get(args.applicationId))).resolves.toMatchObject({
    customerId, vehicleId, dealId: original.dealId, dealNumber: original.dealNumber, handoverStatus: "HANDED_OVER",
    underwritingSnapshot: updated.application?.underwritingSnapshot,
  });
});

test("correction refuses an incomplete underwriting refresh before changing the deal", async () => {
  const { seed, original, customerId, args } = await pendingFinanceIdentityDeal(modules, "BUYER");
  await seed.t.run(async (ctx) => {
    for (let index = 0; index < 101; index += 1) {
      await ctx.db.insert("guarantors", {
        orgId: args.orgId, customerId, firstName: "Additional", lastName: "Guarantor",
        nationalId: String(1_000_000_000 + index), phone: "0790000000",
      });
    }
  });
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, args))
    .rejects.toThrow(/too many guarantor records/i);
  await expect(seed.t.run((ctx) => ctx.db.get(args.applicationId))).resolves.toEqual(original);
});

test.each(["timestamp", "actor", "notes", "status"] as const)(
  "the initial correction cannot bypass recorded handover %s",
  async (evidence) => {
    const { seed, args, original, quoteId } = await pendingFinanceIdentityDeal(modules, "BUYER", "APPROVED");
    const facts = evidence === "timestamp" ? { vehicleHandoverAt: Date.now() } :
      evidence === "actor" ? { vehicleHandoverBy: seed.owner.userId } :
        evidence === "notes" ? { vehicleHandoverNotes: "Prior delivery evidence" } : {};
    const before = await seed.t.run(async (ctx) => {
      await ctx.db.patch(args.applicationId, {
        ...facts, handoverStatus: evidence === "status" ? "HANDED_OVER" : handoverStatusForFacts({ ...original, ...facts }),
      });
      const application = await ctx.db.get(args.applicationId);
      if (!application) throw new Error("Expected the recorded application");
      return { application, originalQuote: await ctx.db.get(quoteId), replacementQuote: await ctx.db.get(args.replacementQuoteId) };
    });
    await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, {
      ...args, expectedEconomicsStamp: economicsStamp(before.application),
    })).rejects.toThrow("Only eligible pre-handover deals can be corrected here.");
    await expect(seed.t.run(async (ctx) => ({
      application: await ctx.db.get(args.applicationId),
      originalQuote: await ctx.db.get(quoteId),
      replacementQuote: await ctx.db.get(args.replacementQuoteId),
    }))).resolves.toEqual(before);
  },
);

test.each(["application", "replacement quote"] as const)(
  "the correction refuses a %s owned by another dealership without changing either record",
  async (foreignRecord) => {
    const { seed, args } = await pendingFinanceIdentityDeal(modules, "BUYER");
    const foreignId = foreignRecord === "application" ? args.applicationId : args.replacementQuoteId;
    const before = await seed.t.run(async (ctx) => {
      const foreignOrgId = await ctx.db.insert("organizations", { name: "Separate dealership", createdAt: Date.now() });
      await ctx.db.patch(foreignId, { orgId: foreignOrgId });
      return {
        application: await ctx.db.get(args.applicationId),
        replacementQuote: await ctx.db.get(args.replacementQuoteId),
      };
    });
    await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, args))
      .rejects.toThrow("Record not found in this organization.");
    await expect(seed.t.run(async (ctx) => ({
      application: await ctx.db.get(args.applicationId),
      replacementQuote: await ctx.db.get(args.replacementQuoteId),
    }))).resolves.toEqual(before);
  },
);

test.each([
  { kind: "BUYER", approvedPurchase: false, terms: "sent quotation" },
  { kind: "BUYER", approvedPurchase: true, terms: "appraisal-backed approval" },
  { kind: "VEHICLE", approvedPurchase: true, terms: "appraisal-backed approval" },
] as const)("$kind correction archives recorded financing terms after lender confirmation ($terms)", async ({ kind, approvedPurchase }) => {
  const { seed, args, original, quoteId } = await pendingFinanceIdentityDeal(modules, kind, "APPROVED");
  const target = { orgId: args.orgId, applicationId: args.applicationId };
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: 12_500_000, customerFirstPaymentMinor: 0, source: "MANUAL_ENTRY",
  });
  const oldAppraisalId = approvedPurchase
    ? await seed.owner.as.mutation(api.financingEconomics.recordAppraisal, {
        ...target, appraisalAmountMinor: 11_500_000, providerType: "FINANCE_COMPANY", appraisedAt: Date.now(),
      })
    : undefined;
  if (oldAppraisalId) {
    await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      ...target, approvedAmountMinor: 11_500_000, basis: "APPRAISAL", appraisalId: oldAppraisalId,
    });
  }
  const before = await seed.t.run((ctx) => ctx.db.get(target.applicationId));
  if (!before) throw new Error("Expected the application with recorded purchase terms");
  const currentArgs = { ...args, expectedEconomicsStamp: economicsStamp(before), expectedUpdatedAt: before.updatedAt };
  await expect(seed.approver.as.query(api.deliveredDealIdentityCorrections.detail, { ...target, kind }))
    .resolves.toMatchObject({ state: "AVAILABLE_BEFORE_HANDOVER", requiresLenderConfirmation: true });
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, currentArgs))
    .rejects.toThrow("Enter the financing company's confirmation reference");
  await expect(seed.t.run((ctx) => ctx.db.get(target.applicationId))).resolves.toEqual(before);

  const confirmedArgs = { ...currentArgs, lenderConfirmationReference: "  LENDER-CORRECTION-42  " };
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, confirmedArgs))
    .resolves.toBe(target.applicationId);
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, confirmedArgs))
    .resolves.toBe(target.applicationId);
  const { corrected, history, audit, oldAppraisal, journalEntries } = await seed.t.run(async (ctx) => ({
    corrected: await ctx.db.get(target.applicationId),
    history: await ctx.db.query("deliveredDealIdentityCorrections").withIndex("by_org_application_status", (q) =>
      q.eq("orgId", target.orgId).eq("applicationId", target.applicationId).eq("status", "APPLIED_BEFORE_HANDOVER")
    ).take(2),
    audit: await ctx.db.query("adminAuditLog").withIndex("by_org", (q) => q.eq("orgId", target.orgId)).order("desc").take(20),
    oldAppraisal: oldAppraisalId ? await ctx.db.get(oldAppraisalId) : null,
    journalEntries: await ctx.db.query("journalEntries").withIndex("by_org_date", (q) => q.eq("orgId", target.orgId)).take(1),
  }));
  expect(corrected).toMatchObject({
    dealId: original.dealId, dealNumber: original.dealNumber, quoteId: args.replacementQuoteId,
    status: "PENDING_DOCS", appraisalStatus: "NOT_REQUESTED", handoverStatus: "BLOCKED",
  });
  expect(corrected?.submittedQuotationMinor).toBeUndefined();
  expect(corrected?.approvedDealerPurchaseAmountMinor).toBeUndefined();
  expect(corrected?.approvedPurchaseAppraisalId).toBeUndefined();
  expect(journalEntries).toEqual([]);
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({
    originalQuoteId: quoteId, lenderConfirmationReference: "LENDER-CORRECTION-42",
    originalValues: expect.objectContaining({
      appraisalStatus: before.appraisalStatus,
      submittedQuotationMinor: before.submittedQuotationMinor,
      submittedQuotationBy: before.submittedQuotationBy,
      ...(approvedPurchase ? {
        approvedDealerPurchaseAmountMinor: before.approvedDealerPurchaseAmountMinor,
        approvedPurchaseApprovedBy: before.approvedPurchaseApprovedBy,
        approvedPurchaseAppraisalId: oldAppraisalId,
        rawAppraisalGapMinor: 1_000_000,
        dealerContributionMinor: before.dealerContributionMinor,
        gapResolution: "PENDING_NEGOTIATION",
      } : {}),
    }),
  });
  expect(audit.filter((entry) => entry.action === "CORRECT_FINANCE_IDENTITY_BEFORE_HANDOVER"))
    .toMatchObject([{ targetId: target.applicationId, after: { correctionId: history[0]?._id } }]);

  await seed.owner.as.mutation(api.applications.updateStatus, { ...target, status: "UNDER_REVIEW" });
  await seed.approver.as.mutation(api.applications.updateStatus, { ...target, status: "APPROVED" });
  const deliver = () => registerHandover(seed.owner.as, api, target.orgId, target.applicationId);
  await expect(deliver()).rejects.toThrow(/first-payment evidence cannot be verified/i);
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: 12_500_000, customerFirstPaymentMinor: 0, source: "MANUAL_ENTRY",
  });
  await expect(deliver()).rejects.toThrow(/approved purchase amount is not recorded/i);
  if (oldAppraisalId) {
    expect(oldAppraisal).toMatchObject({ status: "SUPERSEDED", supersededAt: expect.any(Number) });
    await expect(seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      ...target, approvedAmountMinor: 11_500_000, basis: "APPRAISAL", appraisalId: oldAppraisalId,
    })).rejects.toThrow(/appraisal has been superseded/i);
  }
  await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...target, approvedAmountMinor: 12_500_000, basis: "MANUAL", notes: "Replacement approval",
  });
  expect(await deliver()).toBeGreaterThan(0);
});

test("a deal without recorded terms cannot create a lender withdrawal attestation", async () => {
  const { seed, args, original } = await pendingFinanceIdentityDeal(modules, "BUYER");
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, {
    ...args, lenderConfirmationReference: "FC-42",
  })).rejects.toThrow(/no recorded financing terms to withdraw/i);
  await expect(seed.t.run((ctx) => ctx.db.get(args.applicationId))).resolves.toEqual(original);
});

test.each(["BUYER", "VEHICLE"] as const)("%s correction preserves an agreed but uncollected first payment", async (kind) => {
  const { seed, args, original } = await pendingFinanceIdentityDeal(modules, kind, "APPROVED", { replacementDownPaymentMajor: 500 });
  const target = { orgId: args.orgId, applicationId: args.applicationId };
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: 12_500_000, customerFirstPaymentMinor: 500_000, source: "MANUAL_ENTRY",
  });
  const before = await seed.t.run((ctx) => ctx.db.get(args.applicationId));
  if (!before) throw new Error("Expected the application with recorded first payment terms");
  expect(before.customerFirstPaymentMinor).toBe(500_000);
  const originalEvidence = await seed.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target);
  const proof = { ...args, expectedEconomicsStamp: economicsStamp(before), expectedUpdatedAt: before.updatedAt };
  await expect(seed.approver.as.query(api.deliveredDealIdentityCorrections.detail, { ...target, kind }))
    .resolves.toMatchObject({
      state: "AVAILABLE_BEFORE_HANDOVER", requiresLenderConfirmation: true,
      options: [expect.objectContaining({ quoteId: args.replacementQuoteId })],
    });
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, {
    ...proof, lenderConfirmationReference: "LENDER-REPLACEMENT-TERMS",
  })).resolves.toBe(args.applicationId);
  const corrected = await seed.t.run((ctx) => ctx.db.get(args.applicationId));
  expect(corrected).toMatchObject({
    dealId: original.dealId, dealNumber: original.dealNumber, quoteId: args.replacementQuoteId,
    customerFirstPaymentMinor: 500_000, status: "PENDING_DOCS", handoverStatus: "BLOCKED",
  });
  expect(corrected?.submittedQuotationMinor).toBeUndefined();

  await seed.owner.as.mutation(api.applications.updateStatus, { ...target, status: "UNDER_REVIEW" });
  await seed.approver.as.mutation(api.applications.updateStatus, { ...target, status: "APPROVED" });
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: 12_500_000, source: "MANUAL_ENTRY",
  });
  await expect(seed.t.run((ctx) => ctx.db.get(target.applicationId)))
    .resolves.toMatchObject({ customerFirstPaymentMinor: 500_000 });
  await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...target, approvedAmountMinor: 12_500_000, basis: "MANUAL", notes: "Replacement approval",
  });
  const deliver = () => registerHandover(seed.owner.as, api, target.orgId, target.applicationId);
  await expect(deliver()).rejects.toThrow(/verify the customer's agreed first payment/i);
  const staleReceipt = {
    ...target, amountMinor: 500_000, paidAt: before.updatedAt, reference: "Unsubmitted original lender receipt",
    kind: "RECEIPT" as const, idempotencyKey: "original-identity-stale-confirmation",
  };
  await expect(seed.approver.as.mutation(api.customerFinanceCompanyPayments.confirmFirstPayment, staleReceipt))
    .rejects.toThrow(/DEAL_CORRECTION_STALE/);
  await expect(seed.approver.as.mutation(api.customerFinanceCompanyPayments.confirmFirstPayment, {
    ...staleReceipt, kind: "CONFIRMATION", expectedAgreement: originalEvidence.agreement,
  })).rejects.toThrow(/DEAL_CORRECTION_STALE/);
  const evidence = await seed.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target);
  expect(evidence).toMatchObject({
    canConfirm: true, records: [], proof: { status: "BLOCKED", directMinor: 0 },
  });
  expect(evidence.agreement).not.toBe(originalEvidence.agreement);
  await seed.approver.as.mutation(api.customerFinanceCompanyPayments.confirmFirstPayment, {
    ...target, expectedAgreement: evidence.agreement, amountMinor: 500_000, paidAt: Date.now(), reference: "Replacement lender receipt",
    kind: "RECEIPT", idempotencyKey: "new-identity-first-payment-proof",
  });
  await expect(deliver()).resolves.toBeGreaterThan(0);
});

test("a quote-seeded first payment follows the replacement vehicle before any lender terms are recorded", async () => {
  const { seed, args, original } = await pendingFinanceIdentityDeal(modules, "VEHICLE", "PENDING_DOCS", { replacementDownPaymentMajor: 500, originalFirstPaymentMinor: 500_000 });
  const target = { orgId: args.orgId, applicationId: args.applicationId };
  expect(original.customerFirstPaymentMinor).toBe(500_000);
  const detail = await seed.approver.as.query(api.deliveredDealIdentityCorrections.detail, { ...target, kind: "VEHICLE" });
  expect(detail).toMatchObject({
    state: "AVAILABLE_BEFORE_HANDOVER",
    options: [expect.objectContaining({ quoteId: args.replacementQuoteId })],
  });
  expect(detail).not.toHaveProperty("requiresLenderConfirmation");
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, args))
    .resolves.toBe(args.applicationId);
  await expect(seed.t.run((ctx) => ctx.db.get(args.applicationId))).resolves.toMatchObject({
    dealId: original.dealId, dealNumber: original.dealNumber, quoteId: args.replacementQuoteId,
    customerFirstPaymentMinor: 500_000, status: "PENDING_DOCS", handoverStatus: "BLOCKED",
  });
});

test.each(["BUYER", "VEHICLE"] as const)("a %s correction retires one proven lender refund and requires fresh evidence", async (kind) => {
  const { seed, args, original } = await pendingFinanceIdentityDeal(modules, kind, "APPROVED", { replacementDownPaymentMajor: 500 });
  const target = { orgId: args.orgId, applicationId: args.applicationId };
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: 12_500_000, customerFirstPaymentMinor: 500_000, source: "MANUAL_ENTRY",
  });
  await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...target, approvedAmountMinor: 12_500_000, basis: "MANUAL", notes: "Original approval",
  });
  const paidAt = Date.now();
  const paymentId = await seed.approver.as.mutation(api.customerFinanceCompanyPayments.confirmFirstPayment, {
    ...target, amountMinor: 500_000, paidAt, reference: "Original lender receipt",
    kind: "RECEIPT", idempotencyKey: "original-direct-receipt-for-return",
  });

  const detail = await seed.approver.as.query(api.deliveredDealIdentityCorrections.detail, { ...target, kind });
  expect(detail).toMatchObject({
    state: "BLOCKED",
    lenderReturn: {
      originalReceipt: { paymentId, paidAt, amountMinor: 500_000, currency: "JOD" },
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
      reference: "LENDER REFUND-001", amountMinor: 500_000, refundedAt: Date.now(), verifiedSamePayer: true as const,
    },
  };
  const apply = () => seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, correction);
  await expect(seed.owner.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, correction))
    .rejects.toThrow(/independent/i);
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, {
    ...correction, lenderReturn: { ...correction.lenderReturn, amountMinor: 499_999 },
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
    status: "VOIDED", reference: "Original lender receipt", amountMinor: 500_000,
    lenderReturn: {
      reference: "LENDER REFUND-001", amountMinor: 500_000, originalCustomerId: original.customerId,
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
  expect(evidence).toMatchObject({ requiresVerifiedReplacementAgreement: true, proof: { status: "BLOCKED", directMinor: 0 } });
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
});

test.each(["different terms", "confirmed receipt"] as const)("pre-handover identity correction refuses %s with a positive first payment", async (cause) => {
  const hasReceipt = cause === "confirmed receipt";
  const { seed, args } = await pendingFinanceIdentityDeal(modules, "BUYER", "APPROVED", { replacementDownPaymentMajor: hasReceipt ? 500 : 499.999 });
  const target = { orgId: args.orgId, applicationId: args.applicationId };
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: 12_500_000, customerFirstPaymentMinor: 500_000, source: "MANUAL_ENTRY",
  });
  if (hasReceipt) {
    await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      ...target, approvedAmountMinor: 12_500_000, basis: "MANUAL", notes: "Original approval",
    });
    await seed.approver.as.mutation(api.customerFinanceCompanyPayments.confirmFirstPayment, {
      ...target, amountMinor: 500_000, paidAt: Date.now(), reference: "Original lender receipt",
      kind: "RECEIPT", idempotencyKey: "original-identity-first-payment-proof",
    });
  }
  const before = await seed.t.run((ctx) => ctx.db.get(target.applicationId));
  if (!before) throw new Error("Expected the original application");
  await expect(seed.approver.as.query(api.deliveredDealIdentityCorrections.detail, { ...target, kind: "BUYER" }))
    .resolves.toMatchObject(hasReceipt ? { state: "BLOCKED" } : { state: "AVAILABLE_BEFORE_HANDOVER", options: [] });
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, {
    ...args, expectedEconomicsStamp: economicsStamp(before), expectedUpdatedAt: before.updatedAt,
    lenderConfirmationReference: "LENDER-REPLACEMENT-TERMS",
  })).rejects.toThrow(hasReceipt ? /existing payment records/i : /must keep the agreed first payment/i);
  await expect(seed.t.run((ctx) => ctx.db.get(target.applicationId))).resolves.toEqual(before);
});

test("another correction before replacement terms preserves the handover requirement", async () => {
  const { seed, args, original } = await pendingFinanceIdentityDeal(modules, "BUYER", "APPROVED");
  const target = { orgId: args.orgId, applicationId: args.applicationId };
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: 12_500_000, customerFirstPaymentMinor: 0, source: "MANUAL_ENTRY",
  });
  const quoted = await seed.t.run((ctx) => ctx.db.get(target.applicationId));
  if (!quoted) throw new Error("Expected the quoted application");
  await seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, {
    ...args, expectedEconomicsStamp: economicsStamp(quoted), expectedUpdatedAt: quoted.updatedAt,
    lenderConfirmationReference: "FC-42",
  });

  const customerId = await seed.t.run((ctx) => ctx.db.insert("customers", {
    orgId: target.orgId, firstName: "Next", lastName: "Buyer",
  }));
  const replacementQuoteId = await seed.owner.as.mutation(api.quotes.saveQuote, {
    orgId: target.orgId, customerId, vehicleId: original.vehicleId, vehiclePrice: 12_500, downPayment: 0,
    termMonths: 48, mode: "CONFIGURED_FINANCE_COMPANY", companyId: seed.companyId,
    customerEligibilityStatusIds: [seed.customerStatusId], totalFinancedAmount: 12_500,
  });
  await seed.owner.as.mutation(api.quotes.updateQuoteStatus, {
    orgId: target.orgId, quoteId: replacementQuoteId, status: "ACCEPTED",
  });
  const corrected = await seed.t.run((ctx) => ctx.db.get(target.applicationId));
  if (!corrected) throw new Error("Expected the first correction");
  await seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, {
    ...args, replacementQuoteId, expectedEconomicsStamp: economicsStamp(corrected),
    expectedUpdatedAt: corrected.updatedAt, idempotencyKey: "second-correction-before-handover",
  });
  await seed.owner.as.mutation(api.applications.updateStatus, { ...target, status: "UNDER_REVIEW" });
  await seed.approver.as.mutation(api.applications.updateStatus, { ...target, status: "APPROVED" });
  await expect(registerHandover(seed.owner.as, api, target.orgId, target.applicationId))
    .rejects.toThrow(/first-payment evidence cannot be verified/i);
});

test.each([
  { label: "quotation without an appraisal stage", facts: { appraisalStatus: "NOT_REQUESTED" } },
  { label: "finalized appraisal without approval", facts: {
    appraisalStatus: "FINALIZED", approvedDealerPurchaseAmountMinor: undefined,
    approvedPurchaseApprovedBy: undefined, approvedPurchaseApprovedAt: undefined,
  } },
  { label: "approval without its basis", facts: { approvedPurchaseBasis: undefined } },
  { label: "approval without its approver", facts: { approvedPurchaseApprovedBy: undefined } },
  { label: "approval dated before its quotation", facts: { approvedPurchaseApprovedAt: 1 } },
  { label: "noninteger submitted amount", facts: { submittedQuotationMinor: 12_500_000.5 } },
  { label: "superseded handover approval", facts: { approvedPurchaseCorrectedAfterHandoverAt: 1 } },
] as const)("recorded-terms correction refuses $label", async ({ facts }) => {
  const { seed, args } = await pendingFinanceIdentityDeal(modules, "BUYER", "APPROVED");
  const target = { orgId: args.orgId, applicationId: args.applicationId };
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: 12_500_000, customerFirstPaymentMinor: 0, source: "MANUAL_ENTRY",
  });
  await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...target, approvedAmountMinor: 12_500_000, basis: "MANUAL", notes: "Original approval",
  });
  const before = await seed.t.run(async (ctx) => {
    await ctx.db.patch(target.applicationId, facts);
    return await ctx.db.get(target.applicationId);
  });
  if (!before) throw new Error("Expected the approval terms fixture");
  await expect(seed.approver.as.query(api.deliveredDealIdentityCorrections.detail, { ...target, kind: "BUYER" }))
    .resolves.toBeNull();
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, {
    ...args, expectedEconomicsStamp: economicsStamp(before), expectedUpdatedAt: before.updatedAt,
    lenderConfirmationReference: "FC-42",
  })).rejects.toThrow(/only eligible pre-handover deals/i);
  await expect(seed.t.run((ctx) => ctx.db.get(target.applicationId))).resolves.toEqual(before);
});

test.each([false, true])("a recorded receipt blocks the correction after its vehicle hold ends, recorded terms %s", async (recordedTerms) => {
  const { seed, args, original, quoteId } = await pendingFinanceIdentityDeal(modules, "VEHICLE", recordedTerms ? "APPROVED" : "PENDING_DOCS");
  const target = { orgId: args.orgId, applicationId: args.applicationId };
  if (recordedTerms) {
    await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
      ...target, submittedQuotationMinor: 12_500_000, customerFirstPaymentMinor: 0, source: "MANUAL_ENTRY",
    });
  }
  const before = await seed.t.run((ctx) => ctx.db.get(args.applicationId));
  if (!before) throw new Error("Expected the application before correction");
  const depositId = await seed.t.run((ctx) => ctx.db.insert("deposits", {
    orgId: args.orgId, quoteId, customerId: original.customerId, vehicleId: original.vehicleId,
    amount: 50, amountMinor: 50_000, currency: "JOD", status: "HELD", holdActive: false,
    usesVehicleHoldRows: false, createdBy: seed.owner.userId, createdAt: Date.now(),
  }));
  await expect(seed.approver.as.query(api.deliveredDealIdentityCorrections.detail, {
    orgId: args.orgId, applicationId: args.applicationId, kind: "VEHICLE",
  })).resolves.toEqual({ state: "BLOCKED" });
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, {
    ...args, expectedEconomicsStamp: economicsStamp(before), expectedUpdatedAt: before.updatedAt,
    ...(recordedTerms ? { lenderConfirmationReference: "FC-42" } : {}),
  })).rejects.toThrow(/payment records/i);
  const records = await seed.t.run(async (ctx) => ({
    application: await ctx.db.get(args.applicationId),
    quote: await ctx.db.get(quoteId),
    deposit: await ctx.db.get(depositId),
  }));
  expect(records.application).toEqual(before);
  expect(records.quote?.supersededAt).toBeUndefined();
  expect(records.deposit).toMatchObject({ quoteId, status: "HELD", amountMinor: 50_000 });
});
