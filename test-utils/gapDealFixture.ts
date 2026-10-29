import { expect } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { newApplication, refusalDataOf, seedFinancedDealership } from "./financedDealFixture";

/**
 * The financed deal with an appraisal shortfall, shared by the SCRUM-571 suites that settle (or refuse to settle) the
 * customer's gap. Worked figures (JOD, 3 decimals, minor units): the fixture company lends 85%, so a 12,500 quotation
 * approved at 11,500 leaves a net shortfall of 850 that the approver splits.
 */
export const jod = (major: number) => major * 1_000;

export const GAP_DEAL_PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "manage:supplier_settlement", "cancel:closed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "view:reports", "manage:settings",
];

export async function seedGapDealership(tag: string, modules: Record<string, () => Promise<unknown>>) {
  const s = await seedFinancedDealership(tag, {
    modules, ownerPerms: GAP_DEAL_PERMS, label: "S571B", vinPrefix: "VIN571B", actors: {},
  });
  // The fixture company lends 100%, which leaves the showroom nothing to contribute.
  await s.t.run((ctx) => ctx.db.patch(s.companyId, { defaultLtvPercent: 85 }));
  return s;
}
export type GapDealSeed = Awaited<ReturnType<typeof seedGapDealership>>;
export type GapAppId = Id<"financeApplications">;

/** How the 850 shortfall is shared, in minor units. customer = cash + instalment + financeCompany. */
export type GapSplit = { customer: number; dealer: number; cash: number; installment: number; financeCompany: number };

export const DEALER_ABSORBS: GapSplit = { customer: 0, dealer: jod(850), cash: 0, installment: 0, financeCompany: 0 };
export const CUSTOMER_PAYS_DEALER: GapSplit = { customer: jod(850), dealer: 0, cash: jod(850), installment: 0, financeCompany: 0 };

export const appOf = (s: GapDealSeed, applicationId: GapAppId) => s.t.run((ctx) => ctx.db.get(applicationId));

/** Approved at `approvedMajor` against a 12,500 quotation. 11,500 leaves a net shortfall of 850; 12,500 leaves none. */
export async function approvedDeal(s: GapDealSeed, approvedMajor: 11_500 | 12_500): Promise<GapAppId> {
  const { owner, approver, orgId } = s;
  const { applicationId } = await newApplication(s);
  await owner.as.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
  await approver.as.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
  await owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId, applicationId, submittedQuotationMinor: jod(12_500), source: "MANUAL_ENTRY", customerFirstPaymentMinor: jod(500),
  });
  await approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    orgId, applicationId, approvedAmountMinor: jod(approvedMajor), basis: "MANUAL", notes: "Approved.",
  });
  expect((await appOf(s, applicationId))?.netShortfallMinor ?? 0).toBe(approvedMajor === 11_500 ? jod(850) : 0);
  return applicationId;
}

export async function resolveGap(s: GapDealSeed, applicationId: GapAppId, split: GapSplit) {
  const served = await s.approver.as.query(api.applications.get, { orgId: s.orgId, applicationId });
  return s.approver.as.mutation(api.financingEconomics.resolveAppraisalGap, {
    orgId: s.orgId, applicationId, economicsStamp: served!.economicsStamp as string,
    customerGapShareMinor: split.customer,
    dealerGapShareMinor: split.dealer,
    customerGapCashToDealerMinor: split.cash,
    customerGapInstallmentToDealerMinor: split.installment,
    customerGapToFinanceCompanyMinor: split.financeCompany,
  });
}

/**
 * A row whose gap was agreed BEFORE the early refusal existed: the full split written straight to the row, as an old
 * `resolveAppraisalGap` would have left it. The only way to build the state the early refusal makes unreachable.
 */
export async function writeLegacySplit(s: GapDealSeed, applicationId: GapAppId, split: GapSplit) {
  const resolution = split.dealer === 0 ? "CUSTOMER_ABSORBS" : split.customer === 0 ? "DEALER_ABSORBS" : "SPLIT";
  await s.t.run((ctx) =>
    ctx.db.patch(applicationId, {
      gapResolution: resolution,
      customerGapShareMinor: split.customer,
      dealerGapShareMinor: split.dealer,
      customerGapCashToDealerMinor: split.cash,
      customerGapInstallmentToDealerMinor: split.installment,
      customerGapToFinanceCompanyMinor: split.financeCompany,
    })
  );
}

/** Registers the expected payment and a reconciled zero closing cost, so only the gap stands between the deal and finalize. */
export async function makeFinalizeReady(s: GapDealSeed, applicationId: GapAppId) {
  const { owner, orgId } = s;
  await owner.as.mutation(api.applications.registerExpectedPayment, {
    orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });
  const feeId = await owner.as.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(), orgId, applicationId,
    feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER", paidTo: "OTHER", accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: false, actualAmountMinor: 0, description: "No closing costs.",
  });
  await owner.as.mutation(api.financeDealCosts.reconcileDealFee, {
    orgId, feeId, notes: "Matched.", expectedActualAmountMinor: 0, expectedActualEvidenceRevision: 0,
  });
}
/** The refusal's code, or a loud marker when the call was accepted. */
export async function refusedWithCode(promise: Promise<unknown>): Promise<string> {
  const refusal = await refusalDataOf(promise);
  return refusal === null ? "<<ACCEPTED - NO REFUSAL>>" : (refusal.code ?? `<<NO CODE: ${refusal.message}>>`);
}
