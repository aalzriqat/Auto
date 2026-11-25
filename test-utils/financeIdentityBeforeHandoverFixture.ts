import { api } from "../convex/_generated/api";
import { economicsStamp } from "../convex/utils/financingEconomics";
import { IDENTITY_CORRECTION_PERMISSIONS } from "../convex/utils/deliveredDealIdentityCorrection";
import { PERMISSIONS } from "../convex/utils/permissions";
import { newApplication, seedFinancedDealership } from "./financedDealFixture";
export { legacyFinancingMinor } from "./legacyFinancing";

type CreditStage = "PENDING_DOCS" | "UNDER_REVIEW" | "APPROVED";

export async function pendingFinanceIdentityDeal(
  modules: Record<string, () => Promise<unknown>>,
  { kind, creditStage = "PENDING_DOCS", replacementDownPaymentMajor = 0, originalFirstPaymentMinor = 0 }: {
    kind: "BUYER" | "VEHICLE";
    creditStage?: CreditStage;
    replacementDownPaymentMajor?: number;
    originalFirstPaymentMinor?: number;
  },
) {
  const seed = await seedFinancedDealership(kind, {
    modules,
    ownerPerms: [],
    actors: { sales: [PERMISSIONS.VIEW_SALES], identityApprover: IDENTITY_CORRECTION_PERMISSIONS },
    label: "Finance identity before handover",
    vinPrefix: "PRE-HANDOVER",
  });
  const { applicationId, quoteId } = await newApplication(seed, { firstPaymentMinor: originalFirstPaymentMinor });
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
    orgId, customerId, vehicleId, vehiclePrice: 12_500, downPayment: replacementDownPaymentMajor,
    termMonths: 48, mode: "CONFIGURED_FINANCE_COMPANY", companyId: seed.companyId,
    customerEligibilityStatusIds: [seed.customerStatusId], totalFinancedAmount: 12_500 - replacementDownPaymentMajor,
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
