import { expect, test } from "vitest";
import { registerHandover } from "../test-utils/convexTest";
import { finalizeAsOwner, newApplication, seedFinancedDealership } from "../test-utils/financedDealFixture";
import { api } from "./_generated/api";
import { resolveOwnership } from "./commitments";

const modules = import.meta.glob("./**/*.ts");

async function deliveredDeal(change: "BUYER" | "VEHICLE") {
  const seed = await seedFinancedDealership(change, {
    modules,
    ownerPerms: [],
    actors: {},
    label: "Delivered identity correction",
    vinPrefix: "CORRECTION",
  });
  const { applicationId, quoteId } = await newApplication(seed);
  const target = { orgId: seed.orgId, applicationId };
  await seed.owner.as.mutation(api.applications.updateStatus, { ...target, status: "UNDER_REVIEW" });
  await seed.approver.as.mutation(api.applications.updateStatus, { ...target, status: "APPROVED" });
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: 12_500_000, customerFirstPaymentMinor: 0, source: "MANUAL_ENTRY",
  });
  await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...target, approvedAmountMinor: 12_500_000, basis: "MANUAL", notes: "Original approval",
  });
  await registerHandover(seed.owner.as, api, seed.orgId, applicationId);
  const original = await seed.t.run((ctx) => ctx.db.get(applicationId));
  const stamp = await seed.owner.as.query(api.applications.handoverStamp, target);
  const pointer = original?.currentCommitmentClaims?.[0];
  if (!original?.vehicleHandoverAt || !stamp || !pointer || !original.dealId) {
    throw new Error("Expected a canonical delivered finance application");
  }
  const customerId = change === "BUYER"
    ? await seed.t.run((ctx) => ctx.db.insert("customers", {
      orgId: seed.orgId, firstName: "New", lastName: "Buyer",
    }))
    : seed.customerId;
  const vehicleId = change === "VEHICLE"
    ? await seed.t.run((ctx) => ctx.db.insert("vehicles", {
      orgId: seed.orgId, vin: "CORRECTION-REPLACEMENT", make: "Kia", model: "Sportage",
      year: 2024, mileage: 10, color: "Black", fuelType: "Gasoline", transmission: "Automatic",
      status: "AVAILABLE", sellingPrice: 12_500, purchasePrice: 9_000, sourceType: "STOCK",
    }))
    : seed.vehicleId;
  const replacementQuoteId = await seed.owner.as.mutation(api.quotes.saveQuote, {
    orgId: seed.orgId, customerId, vehicleId, vehiclePrice: 12_500, downPayment: 0,
    termMonths: 48, mode: "CONFIGURED_FINANCE_COMPANY", companyId: seed.companyId,
    customerEligibilityStatusIds: [seed.customerStatusId], totalFinancedAmount: 12_500,
  });
  await seed.owner.as.mutation(api.quotes.updateQuoteStatus, {
    orgId: seed.orgId, quoteId: replacementQuoteId, status: "ACCEPTED",
  });
  return { seed, target, quoteId, original, dealId: original.dealId, handoverAt: original.vehicleHandoverAt,
    pointer, stamp, customerId, vehicleId, replacementQuoteId };
}

test.each(["BUYER", "VEHICLE"] as const)("%s correction retains deal identity and restarts handover", async (change) => {
  const { seed, target, quoteId, original, dealId, handoverAt, pointer, stamp, customerId, vehicleId, replacementQuoteId } =
    await deliveredDeal(change);
  const { ruleId, documentId } = await seed.t.run(async (ctx) => {
    const ruleId = await ctx.db.insert("companyDocumentRules", {
      orgId: seed.orgId, companyId: seed.companyId, documentName: "Identity proof", isRequired: true,
    });
    const fileId = await ctx.storage.store(new Blob(["original proof"], { type: "application/pdf" }));
    const documentId = await ctx.db.insert("applicationDocuments", {
      ...target, ruleId, fileId, status: "VERIFIED", verifiedBy: seed.approver.userId,
    });
    return { ruleId, documentId };
  });
  await expect(seed.owner.as.query(api.deliveredDealIdentityCorrections.detail, { ...target, kind: change }))
    .resolves.toMatchObject({ state: "AVAILABLE", options: [expect.objectContaining({ quoteId: replacementQuoteId })] });
  const requestArgs = {
    ...target, replacementQuoteId, expectedHandoverAt: handoverAt,
    expectedEconomicsStamp: stamp, reason: "Customer and finance company accepted the replacement agreement.",
    idempotencyKey: "request-identity-correction",
  };
  const correctionId = await seed.owner.as.mutation(api.deliveredDealIdentityCorrections.request, requestArgs);
  await expect(seed.owner.as.query(api.deliveredDealIdentityCorrections.detail, { ...target, kind: change }))
    .resolves.toMatchObject({ state: "PENDING", correctionId, canApprove: false });
  await expect(seed.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target))
    .resolves.toMatchObject({ proof: { status: "UNAVAILABLE" } });
  const approval = {
    orgId: seed.orgId, correctionId, returnedAt: handoverAt,
    returnReference: "Signed vehicle return receipt", idempotencyKey: "approve-identity-correction",
  };
  await expect(seed.owner.as.mutation(api.deliveredDealIdentityCorrections.approve, approval)).rejects.toThrow(/independent/i);
  await expect(seed.approver.as.mutation(api.deliveredDealIdentityCorrections.approve, { ...approval, returnedAt: handoverAt - 1 }))
    .rejects.toThrow(/actual return time/i);
  if (change === "VEHICLE") {
    const reservationId = await seed.t.run((ctx) => ctx.db.insert("vehicleReservations", {
      orgId: seed.orgId, vehicleId, customerId, status: "ACTIVE",
      reservedBy: seed.approver.userId, reservedAt: Date.now(),
    }));
    await expect(seed.approver.as.mutation(api.deliveredDealIdentityCorrections.approve, approval))
      .rejects.toThrow(/holds the replacement vehicle/i);
    await seed.t.run((ctx) => ctx.db.patch(reservationId, { status: "RELEASED" }));
  }
  await expect(seed.approver.as.mutation(api.deliveredDealIdentityCorrections.approve, approval)).resolves.toBe(target.applicationId);
  await expect(seed.approver.as.mutation(api.deliveredDealIdentityCorrections.approve, approval)).resolves.toBe(target.applicationId);

  const state = await seed.t.run(async (ctx) => {
    const [app, oldQuote, oldClaim, oldVehicle, deal, originalOwnership] = await Promise.all([
      ctx.db.get(target.applicationId), ctx.db.get(quoteId),
      ctx.db.get(pointer.claimId), ctx.db.get(original.vehicleId),
      ctx.db.get(dealId), resolveOwnership(ctx, seed.orgId, original.vehicleId),
    ]);
    const oldRoot = oldClaim && await ctx.db.get(oldClaim.rootId);
    const currentClaim = app?.currentCommitmentClaims?.[0];
    const claim = currentClaim && await ctx.db.get(currentClaim.claimId);
    const root = claim && await ctx.db.get(claim.rootId);
    return { app, deal, oldQuote, oldClaim, oldRoot, oldVehicle, originalOwnership, currentClaim, root };
  });
  expect(state.app).toMatchObject({
    dealId: original.dealId, dealNumber: original.dealNumber, quoteId: replacementQuoteId,
    customerId, vehicleId, status: "PENDING_DOCS",
  });
  expect(state.app?.vehicleHandoverAt).toBeUndefined();
  expect(state.app?.approvedDealerPurchaseAmountMinor).toBeUndefined();
  expect(state.app?.currentCommitmentClaims).toHaveLength(1);
  expect(state.oldQuote?.supersededAt).toBeDefined();
  expect(state.deal).toMatchObject({ _id: original.dealId, quoteId: replacementQuoteId });
  expect(state.oldRoot?.status).toBe("RELEASED");
  expect(state.oldClaim?.status).toBe("ACTIVE");
  expect(state.currentClaim?.vehicleId).toBe(vehicleId);
  expect(state.root).toMatchObject({ status: "OPEN", customerId, vehicleId, headQuoteId: replacementQuoteId });
  if (change === "VEHICLE") {
    expect(state.originalOwnership.kind).toBe("FREE");
    expect(state.oldVehicle?.status).toBe("IN_INSPECTION");
    expect(state.oldVehicle?.preHoldStatus).toBeUndefined();
  }
  await expect(seed.owner.as.query(api.deliveredDealIdentityCorrections.detail, { ...target, kind: change }))
    .resolves.toMatchObject({ state: "APPROVED", handoverAt, returnedAt: handoverAt,
      returnReference: approval.returnReference });
  await expect(seed.owner.as.query(api.documents.getForApplication, target))
    .resolves.toEqual([expect.objectContaining({ _id: null, ruleId, status: "MISSING" })]);
  await expect(seed.owner.as.query(api.documents.getHistoryForApplication, target))
    .resolves.toEqual([expect.objectContaining({ _id: documentId, status: "VERIFIED" })]);
  await expect(seed.approver.as.mutation(api.documents.updateDocumentStatus, {
    orgId: seed.orgId, documentId, status: "MISSING",
  })).rejects.toThrow(/no longer required/i);
  const current = await seed.owner.as.mutation(api.documents.ensureApplicationDocument, { ...target, ruleId });
  expect(current).not.toBe(documentId);
  await seed.owner.as.mutation(api.applications.updateStatus, { ...target, status: "UNDER_REVIEW" });
  await expect(seed.approver.as.mutation(api.applications.updateStatus, { ...target, status: "APPROVED" }))
    .rejects.toThrow(/required finance documents/i);
  await seed.approver.as.mutation(api.documents.updateDocumentStatus, {
    orgId: seed.orgId, documentId: current, status: "WAIVED", waiverReason: "Independent replacement identity check",
  });
  await seed.approver.as.mutation(api.applications.updateStatus, { ...target, status: "APPROVED" });
  await expect(registerHandover(seed.owner.as, api, seed.orgId, target.applicationId))
    .rejects.toThrow(/first.payment evidence cannot be verified/i);
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: 12_500_000, customerFirstPaymentMinor: 0, source: "MANUAL_ENTRY",
  });
  await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...target, approvedAmountMinor: 12_500_000, basis: "MANUAL", notes: "Replacement approval",
  });
  await registerHandover(seed.owner.as, api, seed.orgId, target.applicationId);
  const latest = await seed.t.run((ctx) => ctx.db.get(target.applicationId));
  expect(latest?.vehicleHandoverAt).toBeGreaterThan(handoverAt);
  expect(latest).toMatchObject({ customerId, vehicleId, dealId: original.dealId, handoverStatus: "HANDED_OVER" });

  await seed.owner.as.mutation(api.applications.registerExpectedPayment, {
    ...target, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });
  const feeId = await seed.owner.as.mutation(api.financeDealCosts.recordDealFee, {
    ...target, expectedCurrency: "JOD", idempotencyKey: "replacement-zero-closing-cost",
    feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER", paidTo: "OTHER",
    accountingTreatment: "SELLING_EXPENSE", deductedFromSettlement: false,
    actualAmountMinor: 0, description: "No closing costs.",
  });
  await seed.owner.as.mutation(api.financeDealCosts.reconcileDealFee, {
    orgId: seed.orgId, feeId, notes: "No closing costs.",
    expectedActualAmountMinor: 0, expectedActualEvidenceRevision: 0,
  });
  await finalizeAsOwner(seed, target.applicationId);
  const closed = await seed.t.run(async (ctx) => {
    const app = await ctx.db.get(target.applicationId);
    return { app, sale: app?.finalizedSaleId ? await ctx.db.get(app.finalizedSaleId) : null };
  });
  expect(closed.app).toMatchObject({ status: "CLOSED", vehicleHandoverAt: latest?.vehicleHandoverAt });
  expect(closed.sale).toMatchObject({ customerId, vehicleId, dealId, dealNumber: original.dealNumber, quoteId: replacementQuoteId });
  await expect(seed.owner.as.query(api.deliveredDealIdentityCorrections.detail, { ...target, kind: change }))
    .resolves.toMatchObject({ state: "APPROVED", handoverAt, returnReference: approval.returnReference });
});

test("posted agreement evidence prevents approval and withdrawal restores the original workflow", async () => {
  const { seed, target, stamp, handoverAt, original, replacementQuoteId } = await deliveredDeal("BUYER");
  const correctionId = await seed.owner.as.mutation(api.deliveredDealIdentityCorrections.request, {
    ...target, replacementQuoteId, expectedHandoverAt: handoverAt, expectedEconomicsStamp: stamp,
    reason: "Review replacement buyer", idempotencyKey: "start-and-withdraw",
  });
  await seed.t.run((ctx) => ctx.db.patch(target.applicationId, { legalInvoiceRecordedAt: Date.now() }));
  await expect(seed.approver.as.mutation(api.deliveredDealIdentityCorrections.approve, {
    orgId: seed.orgId, correctionId, returnedAt: handoverAt,
    returnReference: "Signed return", idempotencyKey: "refuse-with-invoice",
  })).rejects.toThrow(/review the invoice|changed/i);
  const withdrawal = { orgId: seed.orgId, correctionId };
  await seed.owner.as.mutation(api.deliveredDealIdentityCorrections.withdraw, withdrawal);
  await seed.owner.as.mutation(api.deliveredDealIdentityCorrections.withdraw, withdrawal);
  const current = await seed.t.run((ctx) => ctx.db.get(target.applicationId));
  expect(current?.pendingIdentityCorrectionId).toBeUndefined();
  expect(current).toMatchObject({ customerId: original.customerId, quoteId: original.quoteId, vehicleHandoverAt: handoverAt });
});
