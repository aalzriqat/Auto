import { expect, test } from "vitest";
import { pendingFinanceIdentityDeal } from "../test-utils/financeIdentityBeforeHandoverFixture";
import { insertReceiptBank } from "../test-utils/financedDealFixture";
import { api } from "./_generated/api";

import { legacyFinancingMinor } from "../test-utils/legacyFinancing";
const modules = import.meta.glob("./**/*.ts");

async function returnedSplitPayment(kind: "BUYER" | "VEHICLE", method: "CASH" | "BANK_TRANSFER" | "CARD" = "CASH") {
  const { seed, args, original, quoteId } = await pendingFinanceIdentityDeal(modules, {
    kind,
    creditStage: "APPROVED",
    replacementDownPaymentMajor: 550,
  });
  const target = { orgId: args.orgId, applicationId: args.applicationId };

  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target,
    submittedQuotationMinor: 12_500_000,
    customerFirstPaymentMinor: 550_000,
    source: "MANUAL_ENTRY",
  });
  await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...target,
    approvedAmountMinor: 12_500_000,
      approvedFinancingAmountMinor: legacyFinancingMinor(12_500_000, 100),
    basis: "MANUAL",
    notes: "Original approval",
  });

  const depositId = await seed.approver.as.mutation(api.deposits.create, {
    orgId: target.orgId,
    quoteId,
    amount: 200,
    method,
    ...(method === "CASH" ? {} : { bankAccountId: await insertReceiptBank(seed) }),
    idempotencyKey: "showroom-first-payment",
  });
  const paymentId = await seed.approver.as.mutation(api.customerFinanceCompanyPayments.confirmFirstPayment, {
    ...target,
    amountMinor: 350_000,
    paidAt: Date.now(),
    reference: "Original direct lender receipt",
    kind: "RECEIPT",
    idempotencyKey: "direct-lender-first-payment",
  });
  await expect(seed.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target)).resolves.toMatchObject({
    proof: { status: "READY", heldMinor: 200_000, directMinor: 350_000 },
  });

  const detail = () => seed.approver.as.query(api.deliveredDealIdentityCorrections.detail, { ...target, kind });
  await expect(detail()).resolves.toEqual({ state: "BLOCKED" });

  await seed.owner.as.mutation(api.deposits.release, {
    orgId: target.orgId,
    depositId,
    resolution: "REFUNDED",
    refundMethod: "CASH",
    idempotencyKey: "showroom-first-payment-return",
  });
  return { seed, args, original, quoteId, target, depositId, paymentId, detail };
}

async function originalReceiptPosting({ seed, target, depositId }: Awaited<ReturnType<typeof returnedSplitPayment>>) {
  const event = await seed.t.run((ctx) => ctx.db.query("accountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", target.orgId).eq("idempotencyKey", "deposit_received_" + depositId))
    .unique());
  if (event?.status !== "POSTED" || !event.journalEntryId) throw new Error("Expected the posted original receipt");
  return { eventId: event._id, journalId: event.journalEntryId };
}

test.each(["BUYER", "VEHICLE"] as const)("corrects the %s after returning both parts of the split first payment", async (kind) => {
  const fixture = await returnedSplitPayment(kind);
  const { seed, args, original, quoteId, target, depositId, paymentId, detail } = fixture;
  const returnedDeposit = await seed.t.run((ctx) => ctx.db.get(depositId));
  expect(returnedDeposit).toMatchObject({
    status: "REFUNDED",
    holdActive: false,
    refundedAmountMinor: 200_000,
  });
  const refund = await seed.t.run((ctx) => ctx.db.query("canonicalPayments")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", target.orgId).eq("idempotencyKey", "deposit_refund_" + depositId))
    .unique());
  expect(refund).toMatchObject({
    status: "SETTLED",
    direction: "OUT",
    customerId: original.customerId,
    amountMinor: 200_000,
    currency: "JOD",
  });

  const refundPosting = await seed.t.run((ctx) => ctx.db.query("accountingEvents")
    .withIndex("by_org_idempotency", (q) => q.eq("orgId", target.orgId).eq("idempotencyKey", "deposit_refunded_" + depositId))
    .unique());
  if (!refundPosting || refundPosting.status !== "POSTED") throw new Error("Expected a posted showroom cash refund");
  await seed.t.run((ctx) => ctx.db.patch(refundPosting._id, { status: "REVERSED" }));
  await expect(detail()).resolves.toEqual({ state: "BLOCKED" });
  await seed.t.run((ctx) => ctx.db.patch(refundPosting._id, { status: "POSTED" }));

  const option = await detail();
  expect(option).toMatchObject({
    state: "BLOCKED",
    lenderReturn: {
      originalReceipt: { paymentId, amountMinor: 350_000 },
      showroomRefund: { amountMinor: 200_000, refundedAt: returnedDeposit?.resolvedAt },
      options: [expect.objectContaining({ quoteId: args.replacementQuoteId })],
    },
  });
  if (option?.state !== "BLOCKED" || !option.lenderReturn) throw new Error("Expected the verified lender return option");

  const correction = {
    ...args,
    expectedUpdatedAt: option.lenderReturn.updatedAt,
    expectedEconomicsStamp: option.lenderReturn.economicsStamp,
    lenderConfirmationReference: "WITHDRAWN ORIGINAL TERMS",
    lenderReturn: {
      paymentId,
      receiptStamp: option.lenderReturn.originalReceipt.receiptStamp,
      reference: "DIRECT LENDER RETURN",
      refundedAt: Date.now(),
      amountMinor: 350_000,
      verifiedSamePayer: true as const,
    },
  };
  const originalPosting = await originalReceiptPosting(fixture);
  await seed.t.run((ctx) => ctx.db.patch(originalPosting.journalId, { status: "REVERSED" }));
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, correction))
    .rejects.toThrow(/posted dealership refund/i);
  await seed.t.run((ctx) => ctx.db.patch(originalPosting.journalId, { status: "POSTED" }));

  const oldDepositClaim = await seed.t.run(async (ctx) => {
    const app = await ctx.db.get(args.applicationId);
    const financeClaimId = app?.currentCommitmentClaims?.[0]?.claimId;
    const financeClaim = financeClaimId && await ctx.db.get(financeClaimId);
    if (!financeClaim) throw new Error("Expected the original finance claim");
    const claims = await ctx.db.query("vehicleCommitmentClaims")
      .withIndex("by_root_status", (q) => q.eq("rootId", financeClaim.rootId).eq("status", "ACTIVE")).take(3);
    return claims.find((claim) => claim.evidenceKind === "DEPOSIT" && claim.depositId === depositId);
  });
  if (!oldDepositClaim) throw new Error("Expected the historical deposit claim on the finance root");
  await seed.t.run((ctx) => ctx.db.patch(oldDepositClaim._id, { quoteId: args.replacementQuoteId }));
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, correction))
    .rejects.toThrow(/another commitment/i);
  await seed.t.run((ctx) => ctx.db.patch(oldDepositClaim._id, { quoteId }));

  const beforeJournal = await seed.t.run((ctx) => ctx.db.query("journalEntries").collect());
  await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, correction))
    .resolves.toBe(args.applicationId);
  await expect(seed.t.run((ctx) => ctx.db.get(args.applicationId))).resolves.toMatchObject({
    dealId: original.dealId,
    dealNumber: original.dealNumber,
    quoteId: args.replacementQuoteId,
    status: "PENDING_DOCS",
    handoverStatus: "BLOCKED",
  });
  const archived = await seed.t.run(async (ctx) => {
    const row = await ctx.db.query("deliveredDealIdentityCorrections")
      .withIndex("by_org_returned_first_payment", (q) => q.eq("orgId", target.orgId).eq("returnedDirectFirstPaymentId", paymentId))
      .unique();
    const oldRoot = row?.status === "APPLIED_BEFORE_HANDOVER" ? await ctx.db.get(row.retiredRootId) : null;
    return { row, oldRoot };
  });
  expect(archived).toMatchObject({
    row: { status: "APPLIED_BEFORE_HANDOVER", returnedShowroomDepositId: depositId },
    oldRoot: { status: "RELEASED" },
  });
  await expect(seed.t.run((ctx) => ctx.db.get(depositId))).resolves.toEqual(returnedDeposit);
  await expect(seed.t.run((ctx) => ctx.db.get(paymentId))).resolves.toMatchObject({
    status: "VOIDED",
    lenderReturn: { amountMinor: 350_000, originalCustomerId: original.customerId },
  });
  await expect(seed.t.run((ctx) => ctx.db.query("journalEntries").collect())).resolves.toEqual(beforeJournal);

  await seed.owner.as.mutation(api.applications.updateStatus, { ...target, status: "UNDER_REVIEW" });
  await seed.approver.as.mutation(api.applications.updateStatus, { ...target, status: "APPROVED" });
  await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    ...target, submittedQuotationMinor: 12_500_000, source: "MANUAL_ENTRY",
  });
  await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    ...target, approvedAmountMinor: 12_500_000,
      approvedFinancingAmountMinor: legacyFinancingMinor(12_500_000, 100), basis: "MANUAL", notes: "Replacement approval",
  });
  const waiting = await seed.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target);
  expect(waiting.proof).toMatchObject({ status: "BLOCKED", directMinor: 0 });
  const unprovedStamp = await seed.owner.as.query(api.applications.handoverStamp, target);
  if (!unprovedStamp) throw new Error("Expected the current handover revision before replacement proof");
  await expect(seed.owner.as.mutation(api.applications.registerVehicleHandover, {
    ...target, economicsStamp: unprovedStamp,
  })).rejects.toThrow(/first payment/i);

  await seed.approver.as.mutation(api.customerFinanceCompanyPayments.confirmFirstPayment, {
    ...target,
    expectedAgreement: waiting.agreement,
    verifiedReplacementAgreement: true,
    amountMinor: 550_000,
    paidAt: Date.now(),
    reference: "Replacement direct lender receipt",
    kind: "RECEIPT",
    idempotencyKey: "replacement-direct-lender-payment",
  });
  const readyStamp = await seed.owner.as.query(api.applications.handoverStamp, target);
  if (!readyStamp) throw new Error("Expected the current handover revision after replacement proof");
  await expect(seed.owner.as.mutation(api.applications.registerVehicleHandover, {
    ...target, economicsStamp: readyStamp,
  })).resolves.toEqual(expect.any(Number));
});

test.each(["PENDING", "REVERSED"] as const)("refuses an original receipt posting in %s state", async (status) => {
  const fixture = await returnedSplitPayment("BUYER");
  const { eventId } = await originalReceiptPosting(fixture);
  await fixture.seed.t.run((ctx) => ctx.db.patch(eventId, { status }));
  await expect(fixture.detail()).resolves.toEqual({ state: "BLOCKED" });
});

test("refuses a reversed original receipt journal", async () => {
  const fixture = await returnedSplitPayment("VEHICLE");
  const { journalId } = await originalReceiptPosting(fixture);
  await fixture.seed.t.run((ctx) => ctx.db.patch(journalId, { status: "REVERSED" }));
  await expect(fixture.detail()).resolves.toEqual({ state: "BLOCKED" });
});

test("refuses a posted receipt with a mismatched deposit amount", async () => {
  const fixture = await returnedSplitPayment("BUYER");
  const { eventId } = await originalReceiptPosting(fixture);
  await fixture.seed.t.run((ctx) => ctx.db.patch(eventId, {
    payload: {
      depositId: fixture.depositId, customerId: fixture.original.customerId,
      amountMinor: 199_000, currency: "JOD", paymentMethod: "CASH",
    },
  }));
  await expect(fixture.detail()).resolves.toEqual({ state: "BLOCKED" });
});

test.each(["BANK_TRANSFER", "CARD"] as const)("refuses a %s receipt even after a full cash refund", async (method) => {
  const fixture = await returnedSplitPayment("VEHICLE", method);
  await expect(fixture.detail()).resolves.toEqual({ state: "BLOCKED" });
});

test.each([
  { postingKey: "deposit_received_", field: "bankAccountId" },
  { postingKey: "deposit_refunded_", field: "bankAccountId" },
  { postingKey: "deposit_refunded_", field: "holdId" },
])("refuses $field on the whole-row cash $postingKey payload", async ({ postingKey, field }) => {
  const { seed, target, original, depositId, detail } = await returnedSplitPayment("BUYER");
  await seed.t.run(async (ctx) => {
    const event = await ctx.db.query("accountingEvents")
      .withIndex("by_org_idempotency", (q) => q.eq("orgId", target.orgId).eq("idempotencyKey", postingKey + depositId))
      .unique();
    if (event?.status !== "POSTED") throw new Error("Expected posted cash deposit evidence");
    await ctx.db.patch(event._id, {
      payload: {
        depositId, customerId: original.customerId, amountMinor: 200_000,
        currency: "JOD", paymentMethod: "CASH", [field]: "inconsistent-source",
      },
    });
  });
  await expect(detail()).resolves.toEqual({ state: "BLOCKED" });
});
