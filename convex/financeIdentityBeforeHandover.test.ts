import { expect, test } from "vitest";
import { registerHandover } from "../test-utils/convexTest";
import { newApplication, seedFinancedDealership } from "../test-utils/financedDealFixture";
import { api } from "./_generated/api";
import { resolveOwnership } from "./commitments";
import { economicsStamp } from "./utils/financingEconomics";

const modules = import.meta.glob("./**/*.ts");

async function pendingDeal(kind: "BUYER" | "VEHICLE", inCreditReview = false) {
  const seed = await seedFinancedDealership(kind, {
    modules,
    ownerPerms: [],
    actors: {},
    label: "Finance identity before handover",
    vinPrefix: "PRE-HANDOVER",
  });
  const { applicationId, quoteId } = await newApplication(seed);
  const { orgId } = seed;
  if (inCreditReview) {
    await seed.owner.as.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
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
  { case: "buyer awaiting documents", kind: "BUYER", inCreditReview: false },
  { case: "vehicle awaiting documents", kind: "VEHICLE", inCreditReview: false },
  { case: "vehicle already in credit review", kind: "VEHICLE", inCreditReview: true },
] as const)("$case correction keeps the deal and restarts evidence review", async ({ kind, inCreditReview }) => {
  const { seed, original, quoteId, customerId, vehicleId, args } = await pendingDeal(kind, inCreditReview);
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
  await expect(seed.approver.as.mutation(action, args)).resolves.toBe(args.applicationId);
  await expect(seed.approver.as.mutation(action, args)).resolves.toBe(args.applicationId);

  const updated = await seed.t.run(async (ctx) => ({
    application: await ctx.db.get(args.applicationId),
    oldQuote: await ctx.db.get(quoteId),
    document: await ctx.db.get(documentId),
    oldVehicle: await ctx.db.get(seed.vehicleId),
    currentOwnership: await resolveOwnership(ctx, args.orgId, vehicleId),
    oldOwnership: await resolveOwnership(ctx, args.orgId, seed.vehicleId),
    events: (await ctx.db.query("adminAuditLog").collect()).filter((row) =>
      row.targetId === args.applicationId && row.action === "CORRECT_FINANCE_IDENTITY_BEFORE_HANDOVER"),
  }));
  expect(updated.application).toMatchObject({
    dealId: original.dealId, dealNumber: original.dealNumber, customerId, vehicleId,
    quoteId: args.replacementQuoteId, status: "PENDING_DOCS", creditDecision: "SUBMITTED", handoverStatus: "BLOCKED",
  });
  expect(updated.application?.vehicleHandoverAt).toBeUndefined();
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
  });
});

test("the initial correction cannot bypass recorded handover", async () => {
  const { seed, args } = await pendingDeal("BUYER");
  await seed.t.run((ctx) => ctx.db.patch(args.applicationId, {
    status: "APPROVED", handoverStatus: "HANDED_OVER", vehicleHandoverAt: Date.now(), vehicleHandoverBy: seed.owner.userId,
  }));
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, args))
    .rejects.toThrow("Only an eligible deal awaiting documents or credit review can be corrected before handover.");
});

test("a recorded receipt blocks the before-handover correction even after its vehicle hold ends", async () => {
  const { seed, args, original, quoteId } = await pendingDeal("VEHICLE");
  const depositId = await seed.t.run((ctx) => ctx.db.insert("deposits", {
    orgId: args.orgId, quoteId, customerId: original.customerId, vehicleId: original.vehicleId,
    amount: 50, amountMinor: 50_000, currency: "JOD", status: "HELD", holdActive: false,
    usesVehicleHoldRows: false, createdBy: seed.owner.userId, createdAt: Date.now(),
  }));
  await expect(seed.approver.as.query(api.deliveredDealIdentityCorrections.detail, {
    orgId: args.orgId, applicationId: args.applicationId, kind: "VEHICLE",
  })).resolves.toEqual({ state: "BLOCKED" });
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, args))
    .rejects.toThrow(/payment records/i);
  const records = await seed.t.run(async (ctx) => ({
    application: await ctx.db.get(args.applicationId),
    quote: await ctx.db.get(quoteId),
    deposit: await ctx.db.get(depositId),
  }));
  expect(records.application).toEqual(original);
  expect(records.quote?.supersededAt).toBeUndefined();
  expect(records.deposit).toMatchObject({ quoteId, status: "HELD", amountMinor: 50_000 });
});
