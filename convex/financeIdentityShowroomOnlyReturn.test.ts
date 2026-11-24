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
    await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, command))
      .rejects.toThrow(/first-payment evidence changed/i);
    const receipt = await seed.t.run((ctx) => ctx.db.query("accountingEvents")
      .withIndex("by_org_idempotency", (q) => q.eq("orgId", target.orgId).eq("idempotencyKey", "deposit_received_" + depositId))
      .unique());
    if (!receipt?.journalEntryId) throw new Error("Expected the original posted receipt journal");
    const journalId = receipt.journalEntryId;
    const reviewed = { ...command, expectedShowroomRefundStamp: detail.showroomRefund.stamp };
    await seed.t.run((ctx) => ctx.db.patch(journalId, { status: "REVERSED" }));
    await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, reviewed))
      .rejects.toThrow(/posted dealership refund/i);
    await seed.t.run((ctx) => ctx.db.patch(journalId, { status: "POSTED" }));
    const before = await seed.t.run((ctx) => ctx.db.get(target.applicationId));
    const journals = await seed.t.run((ctx) => ctx.db.query("journalEntries").collect());
    await expect(seed.approver.as.mutation(api.financeIdentityBeforeHandover.applyCorrection, reviewed))
      .resolves.toBe(target.applicationId);
    await expect(seed.t.run((ctx) => ctx.db.get(target.applicationId))).resolves.toMatchObject({
      dealId: before?.dealId, dealNumber: before?.dealNumber, quoteId: args.replacementQuoteId,
      status: "PENDING_DOCS", handoverStatus: "BLOCKED",
    });
    await expect(seed.t.run((ctx) => ctx.db.query("deliveredDealIdentityCorrections")
      .withIndex("by_org_application_status", (q) => q.eq("orgId", target.orgId)
        .eq("applicationId", target.applicationId).eq("status", "APPLIED_BEFORE_HANDOVER"))
      .unique())).resolves.toMatchObject({ returnedShowroomDepositId: depositId });
    await expect(seed.t.run((ctx) => ctx.db.query("journalEntries").collect())).resolves.toEqual(journals);

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
