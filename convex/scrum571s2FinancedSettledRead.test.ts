/**
 * SCRUM-571 slice 2a (D-43), end to end: finalize a FINANCED deal with a customer gap, confirm the
 * finance company's disbursement, then READ. Reproduces the live false-COMPLETE (probe case
 * "fin-settledread-after-disbursement", Jira SCRUM-571 c22202): the SETTLEMENT stage read COMPLETE and
 * `moneySettled` / `fullySettled` were true while the customer invoice still had the gap outstanding.
 *
 * Every step drives the real public mutations and the real cockpit / overview queries.
 */
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { payInvoice } from "../test-utils/saleInvoiceFixtures";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { ALL_PERMISSIONS } from "./utils/permissions";
import { getReceivableOutstandingMinor } from "./subledger";

vi.mock("./rateLimit", () => ({
  rateLimiter: { limit: vi.fn().mockResolvedValue({ ok: true }) },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.*s");

vi.setConfig({ testTimeout: 120_000 });

const VP = 20_000;
const APPROVED = 18_000;
const GAP = VP - APPROVED;
const SUPPLIER_COST = 9_500;
const SCALE = 1000; // JOD minor units
const key = () => crypto.randomUUID();

async function seedFin(tag: string) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) => ctx.db.insert("organizations", { name: `S2 ${tag}`, createdAt: Date.now() }));
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", { orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now() })
  );
  const userId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_u`, email: `${tag}@e.com`, name: "S2 User" }));
  const roleId = await t.run((ctx) => ctx.db.insert("roles", { orgId, name: "Owner", permissions: ALL_PERMISSIONS }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", { orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"] })
  );
  const asUser = t.withIdentity({ subject: `${tag}_u`, clerkId: `${tag}_u` });
  await asUser.mutation(api.chartOfAccounts.initialize, { orgId });
  const fiscalYear = new Date().getUTCFullYear();
  await asUser.mutation(api.accountingPeriods.create, {
    orgId,
    startDate: Date.UTC(fiscalYear, 0, 1),
    endDate: Date.UTC(fiscalYear, 11, 31, 23, 59, 59, 999),
    fiscalYear, periodNumber: 1,
  });
  const period = (await asUser.query(api.accountingPeriods.list, { orgId }))[0];
  await asUser.mutation(api.accountingPeriods.open, { orgId, periodId: period._id });

  const customerId = await t.run((ctx) => ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag }));
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VINS2${tag}`, make: "Toyota", model: "Camry", year: 2024, mileage: 10,
      color: "White", fuelType: "Gas", transmission: "Auto", sellingPrice: VP, status: "AVAILABLE",
      sourceType: "STOCK" as const, purchasePrice: SUPPLIER_COST,
    })
  );
  const approverId = await t.run((ctx) => ctx.db.insert("users", { clerkId: `${tag}_a`, email: `${tag}a@e.com`, name: "Approver" }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  const asApprover = t.withIdentity({ subject: `${tag}_a`, clerkId: `${tag}_a` });
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId, name: "Jordan Auto Finance", profitRate: 5, maxTermMonths: 60,
      gracePeriodMonths: 0, isActive: true, adminFees: 0, defaultLtvPercent: 100,
    })
  );
  const customerStatusId = await t.run((ctx) =>
    ctx.db.insert("orgCustomerStatuses", { orgId, label: "Eligible", isActive: true, order: 1 })
  );
  return { t, orgId, userId, asUser, asApprover, customerId, vehicleId, companyId, customerStatusId };
}
type FinSeed = Awaited<ReturnType<typeof seedFin>>;

/** A financed deal approved at 18,000 on a 20,000 car: the customer owes the dealer the 2,000 gap, no deposit. */
async function prepareDeal(s: FinSeed, opts: { gap: number }) {
  const approved = VP - opts.gap;
  const quoteId = await s.asUser.mutation(api.quotes.saveQuote, {
    orgId: s.orgId, customerId: s.customerId, vehicleId: s.vehicleId, vehiclePrice: VP,
    downPayment: 0, termMonths: 48, mode: "CONFIGURED_FINANCE_COMPANY" as const,
    companyId: s.companyId, customerEligibilityStatusIds: [s.customerStatusId],
    totalFinancedAmount: VP,
  });
  const applicationId = await s.asUser.mutation(api.applications.createFromQuote, { orgId: s.orgId, quoteId });
  await s.asUser.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "UNDER_REVIEW" });
  await s.asApprover.mutation(api.applications.updateStatus, { orgId: s.orgId, applicationId, status: "APPROVED" });
  await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId: s.orgId, applicationId, submittedQuotationMinor: VP * SCALE, source: "MANUAL_ENTRY",
  });
  await s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    orgId: s.orgId, applicationId, approvedAmountMinor: approved * SCALE, basis: "MANUAL", notes: "s2a",
  });
  if (opts.gap > 0) {
    const served = await s.asApprover.query(api.applications.get, { orgId: s.orgId, applicationId });
    await s.asApprover.mutation(api.financingEconomics.resolveAppraisalGap, {
      orgId: s.orgId, applicationId, economicsStamp: served!.economicsStamp!,
      customerGapShareMinor: opts.gap * SCALE, dealerGapShareMinor: 0,
      customerGapCashToDealerMinor: opts.gap * SCALE, customerGapInstallmentToDealerMinor: 0,
      customerGapToFinanceCompanyMinor: 0,
    });
  }
  await registerHandover(s.asUser, api, s.orgId, applicationId);
  await s.asUser.mutation(api.applications.registerExpectedPayment, {
    orgId: s.orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });
  await s.asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
    orgId: s.orgId, applicationId, legalInvoiceAmountMinor: VP * SCALE,
    legalInvoiceNumber: `INV-${applicationId}`, legalInvoiceDate: Date.now(), issuedTo: "FINANCE_COMPANY",
  });
  const feeId = await s.asUser.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD", idempotencyKey: key(), orgId: s.orgId, applicationId,
    feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER", paidTo: "OTHER",
    accountingTreatment: "SELLING_EXPENSE", deductedFromSettlement: false, actualAmountMinor: 0,
    description: "No closing costs.",
  });
  await s.asUser.mutation(api.financeDealCosts.reconcileDealFee, { orgId: s.orgId, feeId, notes: "Nothing to match." });
  await s.asUser.mutation(api.applications.finalizeDeal, { idempotencyKey: key(), orgId: s.orgId, applicationId });
  return { applicationId, approved };
}

/** The deal's sale and canonical customer invoice, resolved through the application's finalized sale. */
async function invoiceOf(s: FinSeed, applicationId: Id<"financeApplications">) {
  return await s.t.run(async (ctx) => {
    const app = (await ctx.db.get(applicationId))!;
    const sale = (await ctx.db.get(app.finalizedSaleId!))!;
    return { receivableId: sale.canonicalReceivableDocumentId! };
  });
}

async function invoiceOutstanding(s: FinSeed, applicationId: Id<"financeApplications">): Promise<number> {
  const { receivableId } = await invoiceOf(s, applicationId);
  return await s.t.run((ctx) => getReceivableOutstandingMinor(ctx, receivableId));
}

/**
 * The cockpit's stage rail, which is what `moneySettled` feeds. A dealer-owned car sold through the
 * dealership publishes no management profit (`NoSupplierSettlement`), so the `fullySettled` headline cannot
 * be observed on this fixture; it is asserted on the consigned fixture in scrum571s2CustomerObligation.test.ts.
 */
async function readDeal(s: FinSeed, applicationId: Id<"financeApplications">) {
  const cockpit = await s.asUser.query(api.applications.dealCockpit, { orgId: s.orgId, applicationId });
  return {
    settlement: cockpit!.stages.find((st) => st.key === "SETTLEMENT")!.state,
    disbursement: cockpit!.stages.find((st) => st.key === "DISBURSEMENT")!.state,
    allComplete: cockpit!.stages.every((st) => st.state === "COMPLETE" || st.state === "NOT_APPLICABLE"),
  };
}

describe("SCRUM-571 s2a: finalize, confirmDisbursement, read (the live false-COMPLETE)", () => {
  test("a financed deal with a 2,000 customer gap is NOT settled after the finance company's disbursement while the invoice is open", async () => {
    const s = await seedFin("e2e_open");
    const { applicationId, approved } = await prepareDeal(s, { gap: GAP });
    expect(await invoiceOutstanding(s, applicationId)).toBe(GAP * SCALE); // the premise: the customer invoice is OPEN for the gap

    await s.asUser.mutation(api.applications.confirmDisbursement, {
      idempotencyKey: key(), orgId: s.orgId, applicationId, disbursedAmountMinor: approved * SCALE,
    });

    const read = await readDeal(s, applicationId);
    expect(read.disbursement).toBe("COMPLETE"); // the financier's leg really is finished
    // moneySettled: the stage derived from it
    expect(read.settlement).not.toBe("COMPLETE");
    expect(read.allComplete).toBe(false);
  });

  test("the same deal reads settled once the customer pays the invoice in full", async () => {
    const s = await seedFin("e2e_paid");
    const { applicationId, approved } = await prepareDeal(s, { gap: GAP });
    await s.asUser.mutation(api.applications.confirmDisbursement, {
      idempotencyKey: key(), orgId: s.orgId, applicationId, disbursedAmountMinor: approved * SCALE,
    });
    const { receivableId } = await invoiceOf(s, applicationId);
    await s.t.run((ctx) =>
      payInvoice(ctx, { orgId: s.orgId, userId: s.userId, customerId: s.customerId, receivableId, amountMinor: GAP * SCALE })
    );
    expect(await invoiceOutstanding(s, applicationId)).toBe(0);

    const read = await readDeal(s, applicationId);
    expect(read.settlement).toBe("COMPLETE");
    expect(read.allComplete).toBe(true);
  });
});
