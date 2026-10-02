/**
 * SCRUM-557 (Opus L2) — the finance-company receipt guard in
 * `proveFinanceReceiptAuthority` reads the receivable's allocations through
 * `getActiveReceivableAllocations`, which keeps ACTIVE rows only.
 *
 *  - a receivable whose only allocation is REVERSED is not "already settled":
 *    the receipt proceeds;
 *  - the same receivable with an ACTIVE allocation is refused with the settled
 *    sentence, and nothing is written.
 *
 * The existing SCRUM-241 suite pins the ACTIVE refusal loosely (`/already/`) and
 * never exercises the REVERSED side; this file pins both exactly.
 *
 * Fixture lineage: the seed and walk helpers are taken from
 * `convex/scrum241FinanceReceiptAuthority.test.ts`.
 *
 * Evidence boundary: convex-test only — repository behaviour, not the Convex
 * runtime, not production data.
 */
import { convexTestWithComponents, registerHandover } from "../test-utils/convexTest";
import { describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
}));

const MODULES = import.meta.glob("./**/*.ts");

const PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests",
  "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "finalize:financed_deal", "confirm:finance_disbursement",
  "verify:finance_documents", "register:vehicle_handover",
  "register:expected_payment",
  "manage:finance", "view:finance",
  "view:commissions", "manage:commissions",
  "view:reports", "manage:settings",
];

const VEHICLE_PRICE = 20_000;
const PURCHASE_PRICE = 15_000;
const JOD_SCALE = 1_000;
const SETTLED_REFUSAL =
  "Part of this deal's finance-company receivable has already been settled, so it cannot be received as a single full payment. Review the existing allocation before recording this receipt.";

async function seedDealership(tag: string) {
  const t = convexTestWithComponents(schema, MODULES);
  const orgId = await t.run((ctx) =>
    ctx.db.insert("organizations", { name: `S557 ${tag}`, createdAt: Date.now() })
  );
  await t.run((ctx) =>
    ctx.db.insert("subscriptions", {
      orgId, plan: "professional", status: "active", createdAt: Date.now(), updatedAt: Date.now(),
    })
  );
  const userId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_user`, email: `${tag}@example.com`, name: "Deal User" })
  );
  const approverId = await t.run((ctx) =>
    ctx.db.insert("users", { clerkId: `${tag}_appr`, email: `${tag}.appr@example.com`, name: "Approver" })
  );
  const roleId = await t.run((ctx) =>
    ctx.db.insert("roles", { orgId, name: "OWNER", permissions: PERMS, isSystemOwnerRole: true })
  );
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId, roleId }));
  await t.run((ctx) => ctx.db.insert("memberships", { orgId, userId: approverId, roleId }));
  await t.run((ctx) =>
    ctx.db.insert("orgSettings", {
      orgId, currency: "JOD", currencySymbol: "JD", enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    })
  );

  const asUser = t.withIdentity({ subject: `${tag}_user`, clerkId: `${tag}_user` });
  const asApprover = t.withIdentity({ subject: `${tag}_appr`, clerkId: `${tag}_appr` });

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

  const customerId = await t.run((ctx) =>
    ctx.db.insert("customers", { orgId, firstName: "Buyer", lastName: tag })
  );
  const customerStatusId = await t.run((ctx) =>
    ctx.db.insert("orgCustomerStatuses", { orgId, label: "Eligible", isActive: true, order: 1 })
  );
  const vehicleId = await t.run((ctx) =>
    ctx.db.insert("vehicles", {
      orgId, vin: `VIN557${tag}`, make: "Kia", model: "Sportage", year: 2024, mileage: 10,
      color: "Blue", fuelType: "Gasoline", transmission: "Automatic",
      sellingPrice: VEHICLE_PRICE, status: "AVAILABLE",
      sourceType: "STOCK" as const, purchasePrice: PURCHASE_PRICE,
    })
  );
  const companyId = await t.run((ctx) =>
    ctx.db.insert("financeCompanies", {
      orgId, name: "Jordan Auto Finance", profitRate: 5, maxTermMonths: 60,
      gracePeriodMonths: 0, isActive: true, defaultLtvPercent: 100,
      adminFees: 0,
    })
  );

  return { t, orgId, userId, approverId, customerId, customerStatusId, vehicleId, companyId, asUser, asApprover };
}

type Seeded = Awaited<ReturnType<typeof seedDealership>>;

/** Walks a through-dealership financed deal to a CLOSED application with its finance-company receivable OPEN. */
async function closedDeal(s: Seeded) {
  const quoteId = await s.asUser.mutation(api.quotes.saveQuote, {
    orgId: s.orgId,
    customerId: s.customerId,
    vehicleId: s.vehicleId,
    vehiclePrice: VEHICLE_PRICE,
    downPayment: 0,
    termMonths: 48,
    mode: "CONFIGURED_FINANCE_COMPANY",
    companyId: s.companyId,
    customerEligibilityStatusIds: [s.customerStatusId],
    totalFinancedAmount: VEHICLE_PRICE,
  });
  const applicationId = await s.asUser.mutation(api.applications.createFromQuote, {
    orgId: s.orgId,
    quoteId,
  });
  await s.asUser.mutation(api.applications.updateStatus, {
    orgId: s.orgId, applicationId, status: "UNDER_REVIEW",
  });
  await s.asApprover.mutation(api.applications.updateStatus, {
    orgId: s.orgId, applicationId, status: "APPROVED",
  });
  await s.asUser.mutation(api.financingEconomics.recordSubmittedQuotation, {
    orgId: s.orgId,
    applicationId,
    submittedQuotationMinor: VEHICLE_PRICE * JOD_SCALE,
    source: "MANUAL_ENTRY",
  });
  await s.asApprover.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
    orgId: s.orgId,
    applicationId,
    approvedAmountMinor: VEHICLE_PRICE * JOD_SCALE,
    basis: "MANUAL",
    notes: "Approved at the quotation.",
  });

  await registerHandover(s.asUser, api, s.orgId, applicationId);
  await s.asUser.mutation(api.applications.registerExpectedPayment, {
    orgId: s.orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
  });
  await s.asUser.mutation(api.financeDealCosts.recordLegalInvoice, {
    orgId: s.orgId,
    applicationId,
    legalInvoiceAmountMinor: VEHICLE_PRICE * JOD_SCALE,
    legalInvoiceNumber: `INV-${applicationId}`,
    legalInvoiceDate: Date.now(),
    issuedTo: "FINANCE_COMPANY",
  });
  const feeId = await s.asUser.mutation(api.financeDealCosts.recordDealFee, {
    expectedCurrency: "JOD",
    idempotencyKey: crypto.randomUUID(),
    orgId: s.orgId,
    applicationId,
    feeType: "OTHER_CLOSING_EXPENSE",
    paidBy: "DEALER",
    paidTo: "OTHER",
    accountingTreatment: "SELLING_EXPENSE",
    deductedFromSettlement: false,
    actualAmountMinor: 0,
    description: "No closing costs.",
  });
  await s.asUser.mutation(api.financeDealCosts.reconcileDealFee, {
    orgId: s.orgId, feeId, notes: "Matched.",
  });
  await s.asUser.mutation(api.applications.finalizeDeal, {
    idempotencyKey: crypto.randomUUID(),
    orgId: s.orgId,
    applicationId,
  });
  const closed = await s.t.run((ctx) => ctx.db.get(applicationId));
  expect(closed?.status).toBe("CLOSED");
  return { applicationId, receiptMinor: closed!.financedSaleNetReceivableMinor! };
}

async function receivableOf(s: Seeded, applicationId: Id<"financeApplications">) {
  return await s.t.run(async (ctx) =>
    (await ctx.db.query("receivableDocuments").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).find(
      (r) => r.sourceType === "finance_application" && r.sourceId === applicationId
    )!
  );
}

/** Adversarial pre-existing allocation on the finance receivable, in the given status. */
async function seedAllocation(s: Seeded, applicationId: Id<"financeApplications">, status: "ACTIVE" | "REVERSED") {
  const receivable = await receivableOf(s, applicationId);
  await s.t.run(async (ctx) => {
    const paymentId = await ctx.db.insert("canonicalPayments", {
      orgId: s.orgId,
      direction: "IN",
      payerType: "FINANCE_COMPANY",
      financeCompanyId: s.companyId,
      method: "BANK_TRANSFER",
      amountMinor: 1_000,
      currency: "JOD",
      scale: 3,
      status: "SETTLED",
      idempotencyKey: `s557-${status}`,
      createdBy: s.userId,
      createdAt: Date.now(),
    });
    await ctx.db.insert("paymentAllocations", {
      orgId: s.orgId,
      paymentId,
      receivableDocumentId: receivable._id,
      amountMinor: 1_000,
      currency: "JOD",
      scale: 3,
      allocationDate: Date.now(),
      status,
      createdBy: s.userId,
      createdAt: Date.now(),
    });
  });
}

/** Row counts of everything a receipt writes, so "zero writes" is measured, not assumed. */
async function writeCounts(s: Seeded) {
  return await s.t.run(async (ctx) => ({
    payments: (await ctx.db.query("canonicalPayments").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).length,
    allocations: (await ctx.db.query("paymentAllocations").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).length,
    events: (await ctx.db.query("accountingEvents").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).length,
    journals: (await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect()).length,
  }));
}

describe("finance-company receipt guard — which allocations count as 'already settled'", () => {
  test("a receivable carrying only a REVERSED allocation is ACCEPTED: the receipt proceeds", async () => {
    const s = await seedDealership("rev");
    const { applicationId, receiptMinor } = await closedDeal(s);
    await seedAllocation(s, applicationId, "REVERSED");

    await s.asUser.mutation(api.applications.confirmDisbursement, {
      orgId: s.orgId, applicationId, disbursedAmountMinor: receiptMinor, idempotencyKey: "s557-rev",
    });

    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.disbursedAmountMinor).toBe(receiptMinor);
    expect((await receivableOf(s, applicationId)).status).toBe("PAID");
  });

  test("the same receivable with an ACTIVE allocation is REFUSED with the settled sentence and zero writes", async () => {
    const s = await seedDealership("act");
    const { applicationId, receiptMinor } = await closedDeal(s);
    await seedAllocation(s, applicationId, "ACTIVE");
    const before = await writeCounts(s);

    await expect(
      s.asUser.mutation(api.applications.confirmDisbursement, {
        orgId: s.orgId, applicationId, disbursedAmountMinor: receiptMinor, idempotencyKey: "s557-act",
      })
    ).rejects.toThrow(SETTLED_REFUSAL);

    expect(await writeCounts(s)).toEqual(before);
    const app = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(app?.disbursedAt).toBeUndefined();
    expect((await receivableOf(s, applicationId)).status).toBe("OPEN");
  });
});
