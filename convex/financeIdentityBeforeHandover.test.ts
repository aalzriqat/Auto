import { isDeepStrictEqual } from "node:util";
import { expect, test } from "vitest";
import { registerHandover } from "../test-utils/convexTest";
import { newApplication, seedFinancedDealership } from "../test-utils/financedDealFixture";
import { api } from "./_generated/api";
import { resolveOwnership } from "./commitments";
import { economicsStamp, handoverStatusForFacts } from "./utils/financingEconomics";
import { PERMISSIONS } from "./utils/permissions";

const modules = import.meta.glob("./**/*.ts");

type CreditStage = "PENDING_DOCS" | "UNDER_REVIEW" | "APPROVED";

async function pendingDeal(kind: "BUYER" | "VEHICLE", creditStage: CreditStage = "PENDING_DOCS") {
  const seed = await seedFinancedDealership(kind, {
    modules,
    ownerPerms: [],
    actors: { sales: [PERMISSIONS.VIEW_SALES] },
    label: "Finance identity before handover",
    vinPrefix: "PRE-HANDOVER",
  });
  const { applicationId, quoteId } = await newApplication(seed);
  const { orgId } = seed;
  if (creditStage !== "PENDING_DOCS") {
    await seed.owner.as.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
  }
  if (creditStage === "APPROVED") {
    await seed.approver.as.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
    await seed.t.run(async (ctx) => {
      const approved = await ctx.db.get(applicationId);
      if (!approved?.companyRuleSnapshot) throw new Error("Expected the application’s original lender rules");
      const snapshot = { ...approved.companyRuleSnapshot, ruleVersion: 7 };
      const versionId = await ctx.db.insert("financeCompanyRuleVersions", {
        orgId, companyId: seed.companyId, version: 7, snapshot, createdAt: Date.now(),
      });
      await ctx.db.insert("financeCompanyRuleVersions", {
        orgId, companyId: seed.companyId, version: 8, snapshot: { ...snapshot, ruleVersion: 8 }, createdAt: Date.now(),
      });
      await ctx.db.patch(seed.companyId, { ruleVersion: 8 });
      await ctx.db.patch(applicationId, {
        companyRuleSnapshot: snapshot,
        companyRuleVersionId: versionId,
        underwritingSnapshot: { ...approved.underwritingSnapshot, employerAtSubmission: "Prior employer fixture", salaryAtSubmission: 800 },
      });
    });
  }
  const original = await seed.t.run((ctx) => ctx.db.get(applicationId));
  if (!original?.dealId) throw new Error("Expected a commercial deal");
  const customerId = kind === "BUYER"
    ? await seed.t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "New", lastName: "Buyer" }))
    : seed.customerId;
  const vehicleId = kind === "VEHICLE"
    ? await seed.t.run((ctx) => ctx.db.insert("vehicles", {
      orgId, vin: "PRE-HANDOVER-REPLACEMENT", make: "Kia", model: "Sportage",
      year: 2024, mileage: 10, color: "Black", fuelType: "Gasoline", transmission: "Automatic",
      status: "AVAILABLE", sellingPrice: 12_500, purchasePrice: 9_000, sourceType: "STOCK",
    }))
    : seed.vehicleId;
  await seed.t.run(async (ctx) => {
    await ctx.db.patch(customerId, {
      employment: { employer: "Current employer", salary: 1_500 },
      financials: { totalMonthlyDebt: 135 },
    });
    await ctx.db.insert("vehicleValuations", {
      orgId, vehicleId, companyId: seed.companyId, valuationAmount: 15_000,
    });
    const otherOrgId = await ctx.db.insert("organizations", { name: "Another dealership", createdAt: Date.now() });
    const guarantor = { customerId, lastName: "Guarantor", nationalId: "1234567890", phone: "0790000000" };
    await ctx.db.insert("guarantors", { ...guarantor, orgId, firstName: "Current" });
    await ctx.db.insert("guarantors", { ...guarantor, orgId, firstName: "Retired", isDeleted: true });
    await ctx.db.insert("guarantors", { ...guarantor, orgId: otherOrgId, firstName: "Other dealership" });
  });
  const replacementQuoteId = await seed.owner.as.mutation(api.quotes.saveQuote, {
    orgId, customerId, vehicleId, vehiclePrice: 12_500, downPayment: 0,
    termMonths: 48, mode: "CONFIGURED_FINANCE_COMPANY", companyId: seed.companyId,
    customerEligibilityStatusIds: [seed.customerStatusId], totalFinancedAmount: 12_500,
  });
  await seed.owner.as.mutation(api.quotes.updateQuoteStatus, { orgId, quoteId: replacementQuoteId, status: "ACCEPTED" });
  return {
    seed, original, quoteId, customerId, vehicleId,
    args: {
      orgId, applicationId, replacementQuoteId, expectedEconomicsStamp: economicsStamp(original),
      expectedUpdatedAt: original.updatedAt, idempotencyKey: "before-handover-correction", reason: "Replacement quote accepted",
    },
  };
}

test.each([
  { case: "buyer awaiting documents", kind: "BUYER", creditStage: "PENDING_DOCS" },
  { case: "vehicle awaiting documents", kind: "VEHICLE", creditStage: "PENDING_DOCS" },
  { case: "vehicle already in credit review", kind: "VEHICLE", creditStage: "UNDER_REVIEW" },
  { case: "buyer with credit approval and no purchase terms", kind: "BUYER", creditStage: "APPROVED" },
] as const)("$case correction keeps the deal and restarts evidence review", async ({ kind, creditStage }) => {
  const { seed, original, quoteId, customerId, vehicleId, args } = await pendingDeal(kind, creditStage);
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
  const { seed, original, customerId, args } = await pendingDeal("BUYER");
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
    const { seed, args, original, quoteId } = await pendingDeal("BUYER", "APPROVED");
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
    const { seed, args } = await pendingDeal("BUYER");
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
  const { seed, args, original, quoteId } = await pendingDeal(kind, "APPROVED");
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
  const { seed, args, original } = await pendingDeal("BUYER");
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, {
    ...args, lenderConfirmationReference: "FC-42",
  })).rejects.toThrow(/no recorded financing terms to withdraw/i);
  await expect(seed.t.run((ctx) => ctx.db.get(args.applicationId))).resolves.toEqual(original);
});

test("another correction before replacement terms preserves the handover requirement", async () => {
  const { seed, args, original } = await pendingDeal("BUYER", "APPROVED");
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
  const { seed, args } = await pendingDeal("BUYER", "APPROVED");
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
  const { seed, args, original, quoteId } = await pendingDeal("VEHICLE", recordedTerms ? "APPROVED" : "PENDING_DOCS");
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
