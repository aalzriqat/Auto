import { expect, test } from "vitest";
import { pendingFinanceIdentityDeal } from "../test-utils/financeIdentityBeforeHandoverFixture";
import { api } from "./_generated/api";

const modules = import.meta.glob("./**/*.ts");

test.each(["BUYER", "VEHICLE"] as const)(
  "offers an eligible %s correction after a fully returned showroom-only cash receipt",
  async (kind) => {
    const { seed, args, quoteId } = await pendingFinanceIdentityDeal(modules, {
      kind, creditStage: "APPROVED", replacementDownPaymentMajor: 200,
    });
    const target = { orgId: args.orgId, applicationId: args.applicationId };
    await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
      ...target, submittedQuotationMinor: 12_500_000, customerFirstPaymentMinor: 200_000, source: "MANUAL_ENTRY",
    });
    await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      ...target, approvedAmountMinor: 12_500_000, basis: "MANUAL", notes: "Original approval",
    });
    const depositId = await seed.approver.as.mutation(api.deposits.create, {
      orgId: target.orgId, quoteId, amount: 200, method: "CASH", idempotencyKey: "showroom-only-first-payment",
    });
    await expect(seed.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target)).resolves.toMatchObject({
      proof: { status: "READY", heldMinor: 200_000, directMinor: 0 },
    });
    await seed.owner.as.mutation(api.deposits.release, {
      orgId: target.orgId, depositId, resolution: "REFUNDED", refundMethod: "CASH",
      idempotencyKey: "showroom-only-full-return",
    });
    await expect(seed.t.run((ctx) => ctx.db.get(depositId))).resolves.toMatchObject({
      status: "REFUNDED", refundedAmountMinor: 200_000,
    });
    const detail = await seed.approver.as.query(api.deliveredDealIdentityCorrections.detail, { ...target, kind });
    expect(detail).toMatchObject({
      state: "AVAILABLE_BEFORE_HANDOVER",
      requiresLenderConfirmation: true,
      showroomRefund: { amountMinor: 200_000, refundedAt: expect.any(Number), stamp: expect.any(String) },
      options: [expect.objectContaining({ quoteId: args.replacementQuoteId })],
    });
    if (detail?.state !== "AVAILABLE_BEFORE_HANDOVER" || !detail.showroomRefund) {
      throw new Error("Expected the witnessed showroom-only cash refund");
    }
    const command = {
      ...args, expectedUpdatedAt: detail.updatedAt, expectedEconomicsStamp: detail.economicsStamp,
      lenderConfirmationReference: "Replacement terms confirmed by the lender",
    };
    const reviewed = { ...command, expectedShowroomRefundStamp: detail.showroomRefund.stamp };
    const financialEvidence = () => seed.t.run(async (ctx) => ({
      deposit: await ctx.db.get(depositId),
      payments: await ctx.db.query("canonicalPayments").collect(),
      events: await ctx.db.query("accountingEvents").collect(),
      entries: await ctx.db.query("journalEntries").collect(),
      lines: await ctx.db.query("journalLines").collect(),
      applications: await ctx.db.query("depositApplications").collect(),
    }));
    const correctionState = () => seed.t.run(async (ctx) => ({
      application: await ctx.db.get(target.applicationId),
      claims: await ctx.db.query("vehicleCommitmentClaims").collect(),
      roots: await ctx.db.query("commitmentRoots").collect(),
      corrections: await ctx.db.query("deliveredDealIdentityCorrections")
        .withIndex("by_org_application", (q) => q.eq("orgId", target.orgId).eq("applicationId", target.applicationId))
        .collect(),
    }));
    const before = await correctionState();
    const originalFinancialEvidence = await financialEvidence();
    await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, command))
      .rejects.toThrow(/first-payment evidence changed/i);
    await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, {
      ...reviewed, expectedShowroomRefundStamp: "a different refund proof",
    })).rejects.toThrow(/first-payment evidence changed/i);
    const identityApprover = seed.actors.identityApprover.as;
    await expect(identityApprover.query(api.deliveredDealIdentityCorrections.detail, { ...target, kind }))
      .resolves.toEqual({ state: "BLOCKED" });
    await expect(identityApprover.mutation(api.financeIdentityBeforeHandover.applyCorrection, reviewed))
      .rejects.toThrow(/independent finance approver/i);
    await expect(identityApprover.mutation(api.financeIdentityBeforeHandover.applyCorrection, command))
      .rejects.toThrow(/payment records/i);
    for (const type of ["DEPOSIT_RECEIVED", "DEPOSIT_REFUNDED"] as const) {
      const journalId = originalFinancialEvidence.events.find((event) =>
        event.sourceId === depositId && event.eventType === type)?.journalEntryId;
      if (!journalId) throw new Error("Expected both original deposit posting journals");
      await seed.t.run((ctx) => ctx.db.patch(journalId, { status: "REVERSED" }));
      await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, reviewed))
        .rejects.toThrow(/posted dealership refund/i);
      await seed.t.run((ctx) => ctx.db.patch(journalId, { status: "POSTED" }));
    }
    await expect(correctionState()).resolves.toEqual(before);
    await expect(financialEvidence()).resolves.toEqual(originalFinancialEvidence);
    await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, reviewed))
      .resolves.toBe(target.applicationId);
    const corrected = await correctionState();
    expect(corrected.application).toMatchObject({
      dealId: before.application?.dealId, dealNumber: before.application?.dealNumber, quoteId: args.replacementQuoteId,
      status: "PENDING_DOCS", handoverStatus: "BLOCKED",
    });
    expect(corrected.corrections).toEqual([
      expect.objectContaining({ status: "APPLIED_BEFORE_HANDOVER", returnedShowroomDepositId: depositId }),
    ]);
    await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, reviewed))
      .resolves.toBe(target.applicationId);
    await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, {
      ...reviewed, expectedShowroomRefundStamp: "a different refund proof",
    })).rejects.toThrow(/idempotency|same request|already used/i);
    await expect(correctionState()).resolves.toEqual(corrected);
    await expect(financialEvidence()).resolves.toEqual(originalFinancialEvidence);

    await seed.owner.as.mutation(api.applications.updateStatus, { ...target, status: "UNDER_REVIEW" });
    await seed.approver.as.mutation(api.applications.updateStatus, { ...target, status: "APPROVED" });
    await seed.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
      ...target, submittedQuotationMinor: 12_500_000, source: "MANUAL_ENTRY",
    });
    await seed.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      ...target, approvedAmountMinor: 12_500_000, basis: "MANUAL", notes: "Replacement approval",
    });
    await expect(seed.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target)).resolves.toMatchObject({
      proof: { status: "BLOCKED", heldMinor: 0, directMinor: 0 },
    });
    const blockedStamp = await seed.owner.as.query(api.applications.handoverStamp, target);
    if (!blockedStamp) throw new Error("Expected a handover revision after replacement approval");
    await expect(seed.owner.as.mutation(api.applications.registerVehicleHandover, {
      ...target, economicsStamp: blockedStamp,
    })).rejects.toThrow(/first payment/i);

    await seed.approver.as.mutation(api.deposits.create, {
      orgId: target.orgId, quoteId: args.replacementQuoteId, amount: 200, method: "CASH",
      idempotencyKey: "replacement-showroom-cash-proof",
    });
    await expect(seed.approver.as.query(api.customerFinanceCompanyPayments.firstPayment, target)).resolves.toMatchObject({
      proof: { status: "READY", heldMinor: 200_000, directMinor: 0 },
    });
    const readyStamp = await seed.owner.as.query(api.applications.handoverStamp, target);
    if (!readyStamp) throw new Error("Expected a handover revision after posting new cash proof");
    await expect(seed.owner.as.mutation(api.applications.registerVehicleHandover, {
      ...target, economicsStamp: readyStamp,
    })).resolves.toEqual(expect.any(Number));
  },
);
