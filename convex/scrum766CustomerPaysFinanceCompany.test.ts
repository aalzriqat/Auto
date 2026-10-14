/**
 * SCRUM-766 PR-B, the ledger half: when the customer pays the finance company
 * directly toward the net shortfall, the showroom forwards (and the sale
 * recognises) a contribution reduced by exactly that payment.
 *
 * Hand-computed deal, JOD minor units (scale 1,000), company at 85% LTV:
 *   quoted 12,500, customer first payment 500   -> showroom contribution 1,375
 *   approved 11,500: funded 9,775, first payment 500, contribution 1,225
 *   net shortfall = (12,500 - 1,375) - (11,500 - 1,225) = 850
 *   customer pays 400 to the finance company, showroom covers 450
 *   -> contribution 1,225 - 400 = 825
 *   -> sale revenue 11,500 (approved; the 400 never touched the dealership's books)
 *   -> consideration reduction 825, payable to the finance company 825.
 */
import { describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { registerHandover } from "../test-utils/convexTest";
import { finalizeAsOwner, newApplication, seedFinancedDealership } from "../test-utils/financedDealFixture";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");
const jod = (major: number) => major * 1_000;

const ALL_PERMS = [
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

async function seed(tag: string) {
  const s = await seedFinancedDealership(tag, {
    modules: MODULES, ownerPerms: ALL_PERMS, label: "S766B", vinPrefix: "VIN766B", actors: {},
  });
  // The fixture company lends 100%, which leaves the showroom nothing to contribute.
  await s.t.run((ctx) => ctx.db.patch(s.companyId, { defaultLtvPercent: 85 }));
  return s;
}
type Seeded = Awaited<ReturnType<typeof seed>>;

async function glNet(s: Seeded) {
  return await s.t.run(async (ctx) => {
    const net: Record<string, number> = {};
    for (const line of await ctx.db.query("journalLines").collect()) {
      const key = (await ctx.db.get(line.accountId))?.systemKey ?? String(line.accountId);
      net[key] = (net[key] ?? 0) + (line.debitMinor ?? 0) - (line.creditMinor ?? 0);
    }
    return net;
  });
}

async function commissionBaseOf(s: Seeded, applicationId: Id<"financeApplications">) {
  const sale = await s.t.run(async (ctx) =>
    (await ctx.db.query("sales").collect()).find((row) => row.applicationId === applicationId)
  );
  return sale?.commissionBase;
}

/** Approved at 11,500 against a 12,500 quotation; shortfall 850, resolved as given, vehicle handed over. */
async function resolvedDeal(
  s: Seeded,
  split: { customer: number; dealer: number; cash: number; financeCompany: number }
) {
  const { applicationId } = await newApplication(s);
  const { owner, approver, orgId } = s;
  await owner.as.mutation(api.applications.updateStatus, { orgId, applicationId, status: "UNDER_REVIEW" });
  await approver.as.mutation(api.applications.updateStatus, { orgId, applicationId, status: "APPROVED" });
  await owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId, applicationId, submittedQuotationMinor: jod(12_500), source: "MANUAL_ENTRY",
    customerFirstPaymentMinor: jod(500),
  });
  await approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    orgId, applicationId, approvedAmountMinor: jod(11_500), basis: "MANUAL", notes: "Approved below the quotation.",
  });
  const app = await s.t.run((ctx) => ctx.db.get(applicationId));
  expect(app?.netShortfallMinor).toBe(jod(850));
  expect(app?.dealerContributionMinor).toBe(jod(1_225));

  const served = await approver.as.query(api.applications.get, { orgId, applicationId });
  await approver.as.mutation(api.financingEconomics.resolveAppraisalGap, {
    orgId, applicationId, economicsStamp: served!.economicsStamp as string,
    customerGapShareMinor: jod(split.customer),
    dealerGapShareMinor: jod(split.dealer),
    customerGapCashToDealerMinor: jod(split.cash),
    customerGapInstallmentToDealerMinor: 0,
    customerGapToFinanceCompanyMinor: jod(split.financeCompany),
  });
  await registerHandover(owner.as, api, orgId, applicationId);
  await owner.as.mutation(api.applications.registerExpectedPayment, {
    orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });
  // The legal invoice is the approved amount plus what the customer owes the DEALERSHIP;
  // the part paid to the finance company is not billed by the dealership.
  await owner.as.mutation(api.financeDealCosts.recordLegalInvoice, {
    orgId, applicationId, legalInvoiceAmountMinor: jod(11_500 + split.cash),
    legalInvoiceNumber: `INV-${applicationId}`, legalInvoiceDate: Date.now(), issuedTo: "FINANCE_COMPANY",
  });
  const feeId = await owner.as.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", idempotencyKey: crypto.randomUUID(), orgId, applicationId,
    feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER", paidTo: "OTHER", accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: false, actualAmountMinor: 0, description: "No closing costs.",
  });
  await owner.as.mutation(api.financeDealCosts.reconcileDealFee, {
    orgId, feeId, notes: "Matched.", expectedActualAmountMinor: 0, expectedActualEvidenceRevision: 0,
  });
  return applicationId;
}

describe("SCRUM-766 PR-B: the customer pays part of the shortfall to the finance company, through finalize", () => {
  test("400 to the finance company: the sale forwards 825, not 1,225", async () => {
    const s = await seed("a");
    const applicationId = await resolvedDeal(s, { customer: 400, dealer: 450, cash: 0, financeCompany: 400 });
    await finalizeAsOwner(s, applicationId);

    const app = await s.t.run((ctx) => ctx.db.get(applicationId as Id<"financeApplications">));
    expect(app?.dealerContributionMinor).toBe(jod(825));
    expect(app?.financeCompanyForwardDueMinor).toBe(jod(825));

    const gl = await glNet(s);
    expect(gl.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES).toBe(jod(11_500));
    expect(gl.SALES_REVENUE).toBe(-jod(11_500));
    expect(gl.SALES_CONSIDERATION_REDUCTIONS).toBe(jod(825));
    expect(gl.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-jod(825));
    // Nothing is owed to the dealership by the customer: the 400 is the company's.
    expect(gl.ACCOUNTS_RECEIVABLE_CUSTOMERS).toBeUndefined();

    // The commissionable margin (approved - contribution - cost, SCRUM-390 OR-5) is
    // frozen on the contribution BEFORE the customer's payment (1,225, not 825).
    expect((await commissionBaseOf(s, applicationId))?.contributionMinor).toBe(jod(1_225));
  });

  test("the commissionable margin is the same wherever the customer's 400 goes (Batch 2 Q-A)", async () => {
    const toCompany = await seed("c1");
    const toCompanyApp = await resolvedDeal(toCompany, { customer: 400, dealer: 450, cash: 0, financeCompany: 400 });
    await finalizeAsOwner(toCompany, toCompanyApp);
    const toDealer = await seed("c2");
    const toDealerApp = await resolvedDeal(toDealer, { customer: 400, dealer: 450, cash: 400, financeCompany: 0 });
    await finalizeAsOwner(toDealer, toDealerApp);

    // 11,500 approved, 1,225 contribution: identical whether the customer paid
    // the company or the dealership.
    const expected = { approvedMinor: jod(11_500), contributionMinor: jod(1_225), currency: "JOD" };
    expect(await commissionBaseOf(toCompany, toCompanyApp)).toEqual(expected);
    expect(await commissionBaseOf(toDealer, toDealerApp)).toEqual(expected);
    // While the ledger differs exactly by the forward: 825 to the company, 1,225 when the dealership collects.
    expect((await glNet(toCompany)).ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-jod(825));
    expect((await glNet(toDealer)).ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-jod(1_225));
  });

  test("a mixed share: 200 cash to the dealership and 400 to the finance company", async () => {
    const s = await seed("b");
    const applicationId = await resolvedDeal(s, { customer: 600, dealer: 250, cash: 200, financeCompany: 400 });
    await finalizeAsOwner(s, applicationId);

    const gl = await glNet(s);
    // Revenue is the legal invoice: approved 11,500 + the 200 the customer owes us.
    expect(gl.SALES_REVENUE).toBe(-jod(11_700));
    expect(gl.ACCOUNTS_RECEIVABLE_FINANCE_COMPANIES).toBe(jod(11_500));
    expect(gl.ACCOUNTS_RECEIVABLE_CUSTOMERS).toBe(jod(200));
    expect(gl.SALES_CONSIDERATION_REDUCTIONS).toBe(jod(825));
    expect(gl.ACCOUNTS_PAYABLE_FINANCE_COMPANIES).toBe(-jod(825));
  });
});
