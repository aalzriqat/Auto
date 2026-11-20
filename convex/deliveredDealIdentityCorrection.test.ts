import { makeFunctionReference } from "convex/server";
import { expect, test } from "vitest";
import { registerHandover } from "../test-utils/convexTest";
import { newApplication, seedFinancedDealership } from "../test-utils/financedDealFixture";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

type Target = { orgId: Id<"organizations">; applicationId: Id<"financeApplications"> };
const request = makeFunctionReference<"mutation", Target & {
  replacementQuoteId: Id<"quotes">;
  expectedHandoverAt: number;
  expectedEconomicsStamp: string;
  reason: string;
  idempotencyKey: string;
}, string>("deliveredDealIdentityCorrections:request");
const approve = makeFunctionReference<"mutation", {
  orgId: Id<"organizations">;
  correctionId: string;
  returnedAt: number;
  returnReference: string;
  idempotencyKey: string;
}, Id<"financeApplications">>("deliveredDealIdentityCorrections:approve");

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
  return { seed, target, quoteId, original, handoverAt: original.vehicleHandoverAt,
    pointer, stamp, customerId, vehicleId, replacementQuoteId };
}

test.each(["BUYER", "VEHICLE"] as const)("%s correction retains deal identity and restarts handover", async (change) => {
  const { seed, target, quoteId, original, handoverAt, pointer, stamp, customerId, vehicleId, replacementQuoteId } =
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
  const correctionId = await seed.owner.as.mutation(request, {
    ...target, replacementQuoteId, expectedHandoverAt: handoverAt,
    expectedEconomicsStamp: stamp, reason: "Customer and finance company accepted the replacement agreement.",
    idempotencyKey: "request-identity-correction",
  });
  await expect(seed.owner.as.query(api.deliveredDealIdentityCorrections.detail, { ...target, kind: change }))
    .resolves.toMatchObject({ state: "PENDING", correctionId, canApprove: false });
  const approval = {
    orgId: seed.orgId, correctionId, returnedAt: handoverAt,
    returnReference: "Signed vehicle return receipt", idempotencyKey: "approve-identity-correction",
  };
  await expect(seed.owner.as.mutation(approve, approval)).rejects.toThrow(/independent/i);
  await expect(seed.approver.as.mutation(approve, { ...approval, returnedAt: handoverAt - 1 }))
    .rejects.toThrow(/actual return time/i);
  if (change === "VEHICLE") {
    const reservationId = await seed.t.run((ctx) => ctx.db.insert("vehicleReservations", {
      orgId: seed.orgId, vehicleId, customerId, status: "ACTIVE",
      reservedBy: seed.approver.userId, reservedAt: Date.now(),
    }));
    await expect(seed.approver.as.mutation(approve, approval)).rejects.toThrow(/holds the replacement vehicle/i);
    await seed.t.run((ctx) => ctx.db.patch(reservationId, { status: "RELEASED" }));
  }
  await expect(seed.approver.as.mutation(approve, approval)).resolves.toBe(target.applicationId);
  await expect(seed.approver.as.mutation(approve, approval)).resolves.toBe(target.applicationId);

  const state = await seed.t.run(async (ctx) => {
    const [app, oldQuote, oldClaim, oldVehicle] = await Promise.all([
      ctx.db.get(target.applicationId), ctx.db.get(quoteId),
      ctx.db.get(pointer.claimId), ctx.db.get(original.vehicleId),
    ]);
    const oldRoot = oldClaim && await ctx.db.get(oldClaim.rootId);
    const currentClaim = app?.currentCommitmentClaims?.[0];
    const claim = currentClaim && await ctx.db.get(currentClaim.claimId);
    const root = claim && await ctx.db.get(claim.rootId);
    return { app, oldQuote, oldRoot, oldVehicle, currentClaim, root };
  });
  expect(state.app).toMatchObject({
    dealId: original.dealId, dealNumber: original.dealNumber, quoteId: replacementQuoteId,
    customerId, vehicleId, status: "PENDING_DOCS",
  });
  expect(state.app?.vehicleHandoverAt).toBeUndefined();
  expect(state.app?.approvedDealerPurchaseAmountMinor).toBeUndefined();
  expect(state.app?.currentCommitmentClaims).toHaveLength(1);
  expect(state.oldQuote?.supersededAt).toBeDefined();
  expect(state.oldRoot?.status).toBe("RELEASED");
  expect(state.currentClaim?.vehicleId).toBe(vehicleId);
  expect(state.root).toMatchObject({ status: "OPEN", customerId, vehicleId, headQuoteId: replacementQuoteId });
  if (change === "VEHICLE") expect(state.oldVehicle?.status).toBe("IN_INSPECTION");
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
});
