/**
 * SCRUM-486: literal, independent certification rows driven through public money doors.
 *
 * These harness rows cover selected owned and sourced CASH, configured-financier,
 * deposit, tenant-boundary and retired-mode paths.
 * They are not the whole route/deposit/lifecycle matrix and are not
 * real Convex platform evidence. The owner-ruling derivation lives in
 * docs/architecture/scrum486-certification-oracle.md. Expected amounts are
 * literals here and import no production accounting calculations.
 */
import { describe, expect, test, vi } from "vitest";
import { seedFinancedDealership, newApplication } from "../test-utils/financedDealFixture";
import { registerHandover } from "../test-utils/convexTest";
import { dbSnapshot } from "../test-utils/dbSnapshot";
import { expectRetiredDealMode } from "../test-utils/retiredDealMode";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

vi.mock("./rateLimit", () => ({
  rateLimiter: {
    limit: vi.fn().mockResolvedValue({ ok: true }),
    check: vi.fn().mockResolvedValue({ ok: true, retryAfter: 0 }),
  },
  checkTenantWriteLimit: vi.fn().mockResolvedValue({ ok: true }),
}));

const MODULES = import.meta.glob("./**/*.ts");
const OWNER_PERMS = [
  "create:sales", "view:sales", "edit:sales",
  "view:vehicles", "create:vehicles", "edit:vehicles",
  "view:customers", "create:customers",
  "approve:requests", "view:finance_applications", "create:finance_application",
  "review:finance_application", "approve:finance_application",
  "view:finance", "manage:finance", "view:reports",
];

async function cashQuote(tag: string) {
  const s = await seedFinancedDealership(tag, {
    modules: MODULES,
    ownerPerms: OWNER_PERMS,
    actors: {},
    label: "Certification",
    vinPrefix: "V486",
  });

  // Opening fixture facts, before any deal money moves: owned cost 10,000 JOD.
  await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { purchasePrice: 10_000 }));
  const quoteId = await s.owner.as.mutation(api.quotes.saveQuote, {
    orgId: s.orgId,
    customerId: s.customerId,
    vehicleId: s.vehicleId,
    mode: "CASH",
    vehiclePrice: 12_500,
    downPayment: 0,
    termMonths: 0,
  });
  return { s, quoteId };
}

async function sourcedCashQuote(tag: string, downPayment = 0) {
  const s = await seedFinancedDealership(tag, {
    modules: MODULES,
    ownerPerms: OWNER_PERMS,
    actors: {},
    label: "Certification",
    vinPrefix: "V486",
    sourced: true,
  });
  // Opening supplier entitlement, before the dealer accepts customer money.
  await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { sourceCost: 10_000 }));
  const quoteId = await s.owner.as.mutation(api.quotes.saveQuote, {
    orgId: s.orgId,
    customerId: s.customerId,
    vehicleId: s.vehicleId,
    mode: "CASH",
    vehiclePrice: 12_500,
    downPayment,
    termMonths: 0,
  });
  return { s, quoteId };
}

type CashSeed = Awaited<ReturnType<typeof cashQuote>>["s"];

async function completeCashSale(s: CashSeed, quoteId: Id<"quotes">, suffix: string) {
  return (await s.owner.as.mutation(api.sales.create, {
    orgId: s.orgId,
    idempotencyKey: `scrum486-cash-${suffix}`,
    quoteId,
    vehicleId: s.vehicleId,
    customerId: s.customerId,
    salespersonId: s.owner.userId,
    salePrice: 12_500,
    saleDate: Date.now(),
    status: "COMPLETED",
  })) as Id<"sales">;
}

async function authorizedOtherTenant(s: CashSeed, tag: string) {
  const clerkId = `${tag}_other_owner`;
  const orgId = await s.t.run(async (ctx) => {
    const otherOrgId = await ctx.db.insert("organizations", {
      name: "Certification other tenant", createdAt: Date.now(),
    });
    await ctx.db.insert("subscriptions", {
      orgId: otherOrgId, plan: "professional", status: "active",
      createdAt: Date.now(), updatedAt: Date.now(),
    });
    await ctx.db.insert("orgSettings", {
      orgId: otherOrgId, currency: "JOD", currencySymbol: "JD",
      enabledPaymentTypes: ["CASH", "BANK_TRANSFER"],
    });
    const userId = await ctx.db.insert("users", {
      clerkId, email: `${tag}.other@example.com`, name: "Other owner",
    });
    const roleId = await ctx.db.insert("roles", {
      orgId: otherOrgId, name: "OWNER", permissions: [...OWNER_PERMS], isSystemOwnerRole: true,
    });
    await ctx.db.insert("memberships", { orgId: otherOrgId, userId, roleId });
    return otherOrgId;
  });
  return { orgId, owner: s.t.withIdentity({ subject: clerkId, clerkId }) };
}

async function journalRows(s: CashSeed) {
  return await s.t.run(async (ctx) => {
    const entries = await ctx.db.query("journalEntries").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    const entryById = new Map(entries.map((entry) => [entry._id, entry]));
    const lines = await ctx.db.query("journalLines").withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
    return await Promise.all(lines.map(async (line) => {
      const account = await ctx.db.get(line.accountId);
      return {
        account: account?.code,
        currency: line.currency,
        debit: line.debitMinor,
        credit: line.creditMinor,
        entryStatus: entryById.get(line.journalEntryId)?.status,
      };
    }));
  });
}

async function eventStatuses(
  s: CashSeed,
  eventType: string,
  sourceId: string,
  sourceType = eventType === "SALE_COMPLETED" ? "sales" : "deposits",
) {
  return await s.t.run(async (ctx) => (
    await ctx.db.query("accountingEvents").withIndex("by_org_source", (q) =>
      q.eq("orgId", s.orgId).eq("sourceType", sourceType).eq("sourceId", sourceId)
    ).collect()
  ).filter((event) => event.eventType === eventType).map((event) => event.status));
}

function expectBalanced(rows: Awaited<ReturnType<typeof journalRows>>) {
  expect(rows.reduce((total, row) => total + row.debit - row.credit, 0)).toBe(0);
}

type JournalRow = Awaited<ReturnType<typeof journalRows>>[number];

/** Journal line order is not a dealer-visible economic result; the exact multiset is. */
function expectLiteralRows(actual: JournalRow[], expected: JournalRow[]) {
  const key = (row: JournalRow) => [
    row.account ?? "",
    row.currency,
    String(row.debit).padStart(12, "0"),
    String(row.credit).padStart(12, "0"),
    row.entryStatus ?? "",
  ].join("|");
  const order = (a: JournalRow, b: JournalRow) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
  expect([...actual].sort(order)).toEqual([...expected].sort(order));
}

function expectAdditionalRows(before: JournalRow[], after: JournalRow[], expected: JournalRow[]) {
  const additions = [...after];
  for (const old of before) {
    const index = additions.findIndex((row) => JSON.stringify(row) === JSON.stringify(old));
    expect(index).toBeGreaterThanOrEqual(0);
    additions.splice(index, 1);
  }
  expectLiteralRows(additions, expected);
}

/** The ledger consumer counts the original and its reversal, including REVERSED history. */
function netByAccount(rows: JournalRow[]) {
  const net = new Map<string, number>();
  for (const row of rows) {
    const key = `${row.account}|${row.currency}`;
    net.set(key, (net.get(key) ?? 0) + row.debit - row.credit);
  }
  return Object.fromEntries([...net].filter(([, amount]) => amount !== 0).sort());
}

/** Read public trial-balance normal-sign nets (liabilities and income are credit-positive). */
async function trialBalanceNormalBalance(s: CashSeed) {
  const periods = await s.owner.as.query(api.accountingPeriods.list, { orgId: s.orgId });
  expect(periods.length, "trial-balance check requires at least one fiscal period").toBeGreaterThan(0);
  const toDate = Math.max(...periods.map((period) => period.endDate));
  const report = await s.owner.as.query(api.accountingReports.trialBalance, { orgId: s.orgId, toDate });
  expect(report.isBalanced).toBe(true);
  return Object.fromEntries(report.rows
    .filter((row) => row.netMinor !== 0)
    .map((row) => [`${row.code}|${row.currency}`, row.netMinor] as const)
    .sort(([a], [b]) => a.localeCompare(b)));
}

async function publicIncomeStatement(s: CashSeed) {
  return s.owner.as.query(api.accountingReports.incomeStatement, {
    orgId: s.orgId,
    fromDate: Date.UTC(s.fiscalYear, 0, 1),
    toDate: Date.UTC(s.fiscalYear, 11, 31, 23, 59, 59, 999),
  });
}

describe("SCRUM-486 literal certification matrix (harness only)", () => {
  test("owned configured financier × held 200 first payment: contribution, forward, partial refusal and full receipt", async () => {
    const s = await seedFinancedDealership("s486financedheld", {
      modules: MODULES,
      ownerPerms: OWNER_PERMS,
      actors: { salesperson: ["view:sales", "edit:sales", "view:finance"] },
      label: "Certification",
      vinPrefix: "V486",
    });
    // Opening finance-company policy: 87.4% of 12,500 = 10,925. The 200
    // customer first payment leaves 1,375 for the dealership to contribute.
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.companyId, { defaultLtvPercent: 87.4 });
      await ctx.db.patch(s.vehicleId, { purchasePrice: 10_000 });
    });
    const quoteId = await s.owner.as.mutation(api.quotes.saveQuote, {
      orgId: s.orgId,
      customerId: s.customerId,
      vehicleId: s.vehicleId,
      mode: "CONFIGURED_FINANCE_COMPANY",
      companyId: s.companyId,
      customerEligibilityStatusIds: [s.customerStatusId],
      vehiclePrice: 12_500,
      downPayment: 200,
      totalFinancedAmount: 12_300,
      termMonths: 48,
    });
    const depositId = await s.owner.as.mutation(api.deposits.create, {
      orgId: s.orgId, quoteId, amount: 200, method: "CASH",
      idempotencyKey: "s486-financed-held-deposit",
    });
    const applicationId = await s.owner.as.mutation(api.applications.createFromQuote, {
      orgId: s.orgId, quoteId,
    });
    await s.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId, applicationId, submittedQuotationMinor: 12_500_000, source: "MANUAL_ENTRY",
    });
    await s.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId, applicationId, approvedAmountMinor: 12_500_000, basis: "MANUAL",
      notes: "Independent contribution example.",
    });
    const { application, deposit } = await s.t.run(async (ctx) => ({
      application: await ctx.db.get(applicationId),
      deposit: await ctx.db.get(depositId),
    }));
    expect(application?.customerFirstPaymentMinor).toBe(200_000);
    expect(application?.financeCompanyFundedPortionMinor).toBe(10_925_000);
    expect(application?.dealerContributionMinor).toBe(1_375_000);
    expect(deposit).toMatchObject({ status: "HELD", holdActive: true, amountMinor: 200_000 });
    expectLiteralRows(await journalRows(s), [
      { account: "1100", currency: "JOD", debit: 200_000, credit: 0, entryStatus: "POSTED" },
      { account: "2100", currency: "JOD", debit: 0, credit: 200_000, entryStatus: "POSTED" },
    ]);

    await s.owner.as.mutation(api.applications.updateStatus, {
      orgId: s.orgId, applicationId, status: "UNDER_REVIEW",
    });
    await s.approver.as.mutation(api.applications.updateStatus, {
      orgId: s.orgId, applicationId, status: "APPROVED",
    });
    await registerHandover(s.owner.as, api, s.orgId, applicationId);
    await s.owner.as.mutation(api.applications.registerExpectedPayment, {
      orgId: s.orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
    });
    const feeId = await s.owner.as.mutation(api.financeDealCosts.recordDealFee, {
      expectedCurrency: "JOD", idempotencyKey: "s486-financed-held-zero-fee", orgId: s.orgId, applicationId,
      feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER", paidTo: "OTHER",
      accountingTreatment: "SELLING_EXPENSE", deductedFromSettlement: false,
      actualAmountMinor: 0, description: "No closing costs.",
    });
    await s.owner.as.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: s.orgId, feeId, notes: "No fee to settle.",
      expectedActualAmountMinor: 0,
      expectedActualEvidenceRevision: 0,
    });
    // SCRUM-411 P2-01: the deposit (200) and the contribution (1,375) are paid to the
    // finance company BEFORE the deal is finalized; finalize refuses until that payment
    // is on the books.
    const paidAt = Date.now();
    const forwardArgs = {
      orgId: s.orgId, applicationId, method: "BANK_TRANSFER" as const, paidAt,
      expectedAmountMinor: 1_575_000, reference: "CERT-FORWARD",
      idempotencyKey: "s486-financed-held-forward",
    };
    await expect(s.owner.as.mutation(api.applications.finalizeDeal, {
      idempotencyKey: "s486-financed-held-finalize-unpaid", orgId: s.orgId, applicationId,
    })).rejects.toThrow(/have not been paid yet/);
    const beforeForward = await dbSnapshot(s.t, Object.keys(schema.tables));
    await expect(s.actors.salesperson.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
      ...forwardArgs,
      idempotencyKey: "s486-financed-held-forward-salesperson-denied",
    })).rejects.toThrow(/confirm:finance_disbursement/);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(beforeForward);
    await s.approver.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, forwardArgs);
    await s.owner.as.mutation(api.applications.finalizeDeal, {
      idempotencyKey: "s486-financed-held-finalize", orgId: s.orgId, applicationId,
    });
    const finalized = await s.t.run(async (ctx) => ({
      application: await ctx.db.get(applicationId),
      deposit: await ctx.db.get(depositId),
      receivable: await ctx.db.query("receivableDocuments")
        .withIndex("by_org_source", (q) => q.eq("orgId", s.orgId)
          .eq("sourceType", "finance_application").eq("sourceId", applicationId))
        .unique(),
    }));
    expect(finalized.application?.status).toBe("CLOSED");
    expect(finalized.application?.financeCompanyForwardDueMinor).toBe(1_575_000);
    expect(finalized.deposit?.status).toBe("APPLIED");
    expect(finalized.receivable).toMatchObject({
      payerType: "FINANCE_COMPANY",
      financeCompanyId: s.companyId,
      originalAmountMinor: 12_500_000,
      status: "OPEN",
    });
    const rows = await journalRows(s);
    expectLiteralRows(rows, [
      { account: "1100", currency: "JOD", debit: 200_000, credit: 0, entryStatus: "POSTED" },
      { account: "2100", currency: "JOD", debit: 0, credit: 200_000, entryStatus: "POSTED" },
      { account: "1210", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "4100", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
      { account: "5100", currency: "JOD", debit: 10_000_000, credit: 0, entryStatus: "POSTED" },
      { account: "1400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "POSTED" },
      { account: "4180", currency: "JOD", debit: 1_375_000, credit: 0, entryStatus: "POSTED" },
      { account: "2220", currency: "JOD", debit: 0, credit: 1_375_000, entryStatus: "POSTED" },
      { account: "2100", currency: "JOD", debit: 200_000, credit: 0, entryStatus: "POSTED" },
      { account: "2220", currency: "JOD", debit: 0, credit: 200_000, entryStatus: "POSTED" },
      // The payment to the finance company recorded before the sale: 200 + 1,375.
      { account: "2220", currency: "JOD", debit: 1_575_000, credit: 0, entryStatus: "POSTED" },
      { account: "1110", currency: "JOD", debit: 0, credit: 1_575_000, entryStatus: "POSTED" },
    ]);
    expectBalanced(rows);
    // The sale credits 2220 by 1,575 (200 deposit + 1,375 contribution) and the earlier
    // payment debited it by 1,575, so the finance-company payable nets to nothing.
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1100|JOD": 200_000,
      "1110|JOD": -1_575_000,
      "1210|JOD": 12_500_000,
      "1400|JOD": -10_000_000,
      "4100|JOD": 12_500_000,
      "4180|JOD": -1_375_000,
      "5100|JOD": 10_000_000,
    });
    const income = await publicIncomeStatement(s);
    expect(income).toMatchObject({
      currency: "JOD",
      totalRevenue: 11_125_000,
      totalCogs: 10_000_000,
      grossProfit: 1_125_000,
      netIncome: 1_125_000,
    });
    expect(income.revenueRows.map((row) => [row.code, row.netMinor])).toEqual([
      ["4100", 12_500_000],
      ["4180", -1_375_000],
    ]);

    const afterForward = rows;
    expect(netByAccount(afterForward)).toEqual({
      "1100|JOD": 200_000,
      "1110|JOD": -1_575_000,
      "1210|JOD": 12_500_000,
      "1400|JOD": -10_000_000,
      "4100|JOD": -12_500_000,
      "4180|JOD": 1_375_000,
      "5100|JOD": 10_000_000,
    });
    const afterForwardSnapshot = await dbSnapshot(s.t, Object.keys(schema.tables));
    await s.approver.as.mutation(api.financeCompanyForward.recordFinanceCompanyForward, forwardArgs);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(afterForwardSnapshot);

    // The current public confirmation door accepts only the full financier
    // receivable. This pins fail-closed behavior; it does not certify the
    // separate owner-required partial-receipt lifecycle (SCRUM-814).
    await expect(s.approver.as.mutation(api.applications.confirmDisbursement, {
      orgId: s.orgId, applicationId, disbursedAmountMinor: 5_000_000,
      idempotencyKey: "s486-financed-held-partial-refusal",
    })).rejects.toThrow(/not what this financing company owes/);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(afterForwardSnapshot);

    const receiptArgs = {
      orgId: s.orgId, applicationId, disbursedAmountMinor: 12_500_000,
      idempotencyKey: "s486-financed-held-receipt",
    };
    await expect(s.actors.salesperson.as.mutation(api.applications.confirmDisbursement, {
      ...receiptArgs,
      idempotencyKey: "s486-financed-held-receipt-salesperson-denied",
    })).rejects.toThrow(/confirm:finance_disbursement/);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(afterForwardSnapshot);
    await s.approver.as.mutation(api.applications.confirmDisbursement, receiptArgs);
    const afterReceipt = await journalRows(s);
    expectAdditionalRows(afterForward, afterReceipt, [
      { account: "1110", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "1210", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
    ]);
    expect(netByAccount(afterReceipt)).toEqual({
      "1100|JOD": 200_000,
      "1110|JOD": 10_925_000,
      "1400|JOD": -10_000_000,
      "4100|JOD": -12_500_000,
      "4180|JOD": 1_375_000,
      "5100|JOD": 10_000_000,
    });
    expectBalanced(afterReceipt);
    const paid = await s.t.run(async (ctx) => ({
      application: await ctx.db.get(applicationId),
      receivable: await ctx.db.query("receivableDocuments")
        .withIndex("by_org_source", (q) => q.eq("orgId", s.orgId)
          .eq("sourceType", "finance_application").eq("sourceId", applicationId))
        .unique(),
    }));
    expect(paid.application?.disbursedAmountMinor).toBe(12_500_000);
    expect(paid.receivable?.status).toBe("PAID");
    const afterReceiptSnapshot = await dbSnapshot(s.t, Object.keys(schema.tables));
    await s.approver.as.mutation(api.applications.confirmDisbursement, receiptArgs);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(afterReceiptSnapshot);
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1100|JOD": 200_000,
      "1110|JOD": 10_925_000,
      "1400|JOD": -10_000_000,
      "4100|JOD": 12_500_000,
      "4180|JOD": -1_375_000,
      "5100|JOD": 10_000_000,
    });
    expect(await publicIncomeStatement(s)).toMatchObject({
      totalRevenue: 11_125_000,
      totalCogs: 10_000_000,
      grossProfit: 1_125_000,
      netIncome: 1_125_000,
    });
  }, 15_000);

  async function ownedFinancedOpening(tag: string) {
    const s = await seedFinancedDealership(tag, {
      modules: MODULES,
      ownerPerms: OWNER_PERMS,
      actors: { salesperson: ["view:sales", "edit:sales", "view:finance_applications", "create:finance_application"] },
      label: "Certification",
      vinPrefix: "V486",
    });
    await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { purchasePrice: 10_000 }));
    const { applicationId } = await newApplication(s);
    await s.owner.as.mutation(api.applications.updateStatus, {
      orgId: s.orgId, applicationId, status: "UNDER_REVIEW",
    });
    await s.approver.as.mutation(api.applications.updateStatus, {
      orgId: s.orgId, applicationId, status: "APPROVED",
    });
    await s.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId, applicationId, submittedQuotationMinor: 12_500_000, source: "MANUAL_ENTRY",
    });
    await s.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId, applicationId, approvedAmountMinor: 12_500_000, basis: "MANUAL",
      notes: "Certification approval of the full vehicle price.",
    });
    await registerHandover(s.owner.as, api, s.orgId, applicationId);
    await s.owner.as.mutation(api.applications.registerExpectedPayment, {
      orgId: s.orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
    });
    const feeId = await s.owner.as.mutation(api.financeDealCosts.recordDealFee, {
      expectedCurrency: "JOD", idempotencyKey: `${tag}-zero-fee`, orgId: s.orgId, applicationId,
      feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER", paidTo: "OTHER",
      accountingTreatment: "SELLING_EXPENSE", deductedFromSettlement: false,
      actualAmountMinor: 0, description: "No closing costs.",
    });
    await s.owner.as.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: s.orgId, feeId, notes: "No fee to settle.",
      expectedActualAmountMinor: 0,
      expectedActualEvidenceRevision: 0,
    });
    await s.owner.as.mutation(api.applications.finalizeDeal, {
      idempotencyKey: `${tag}-finalize`, orgId: s.orgId, applicationId,
    });
    return { s, applicationId };
  }

  test("owned configured financier × foreign application ID: neither tenant's forward or receipt changes", async () => {
    const { s, applicationId } = await ownedFinancedOpening("s486foreignfinanced");
    const other = await authorizedOtherTenant(s, "s486foreignfinanced");
    const before = await dbSnapshot(s.t, Object.keys(schema.tables));

    await expect(other.owner.mutation(api.financeCompanyForward.recordFinanceCompanyForward, {
      orgId: other.orgId, applicationId, method: "BANK_TRANSFER", paidAt: Date.now(),
      expectedAmountMinor: 0, idempotencyKey: "s486-foreign-forward-denied",
    })).rejects.toThrow(/Finance application not found in this organization/);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(before);

    await expect(other.owner.mutation(api.applications.confirmDisbursement, {
      orgId: other.orgId, applicationId, disbursedAmountMinor: 12_500_000,
      idempotencyKey: "s486-foreign-financier-receipt-denied",
    })).rejects.toThrow(/Application not found/);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(before);
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1210|JOD": 12_500_000,
      "1400|JOD": -10_000_000,
      "4100|JOD": 12_500_000,
      "5100|JOD": 10_000_000,
    });
  });

  test("owned configured financier × no deposit: full approved amount is company AR, not customer AR", async () => {
    const { s, applicationId } = await ownedFinancedOpening("s486financednone");

    const application = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(application?.status).toBe("CLOSED");
    const receivable = await s.t.run((ctx) => ctx.db.query("receivableDocuments")
      .withIndex("by_org_source", (q) => q.eq("orgId", s.orgId)
        .eq("sourceType", "finance_application").eq("sourceId", applicationId))
      .unique());
    expect(receivable).toMatchObject({
      payerType: "FINANCE_COMPANY",
      financeCompanyId: s.companyId,
      originalAmountMinor: 12_500_000,
      currency: "JOD",
      status: "OPEN",
    });
    expect(application?.finalizedSaleId).toBeDefined();
    const customerDocument = await s.t.run((ctx) => ctx.db.query("receivableDocuments")
      .withIndex("by_org_source", (q) => q.eq("orgId", s.orgId)
        .eq("sourceType", "sales").eq("sourceId", application!.finalizedSaleId!))
      .unique());
    expect(customerDocument).toMatchObject({
      payerType: "CUSTOMER",
      customerId: s.customerId,
      originalAmountMinor: 0,
      status: "PAID",
    });
    const finalizedSale = await s.t.run((ctx) => ctx.db.get(application!.finalizedSaleId!));
    expect(finalizedSale?.canonicalReceivableDocumentId).toEqual(customerDocument?._id);
    const allCustomerDocuments = await s.t.run(async (ctx) => (await ctx.db.query("receivableDocuments")
      .withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect())
      .filter((doc) => doc.customerId === s.customerId));
    expect(new Set(allCustomerDocuments.map((doc) => String(doc._id)))).toEqual(
      new Set([String(customerDocument?._id), String(receivable?._id)]));
    // The customer may remain on the document for deal provenance; payerType and
    // financeCompanyId identify who legally owes this invoice.
    const rows = await journalRows(s);
    expectLiteralRows(rows, [
      { account: "1210", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "4100", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
      { account: "5100", currency: "JOD", debit: 10_000_000, credit: 0, entryStatus: "POSTED" },
      { account: "1400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "POSTED" },
    ]);
    const companyArLine = await s.t.run(async (ctx) => {
      const lines = await ctx.db.query("journalLines")
        .withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
      const withAccounts = await Promise.all(lines.map(async (line) => ({
        line,
        account: await ctx.db.get(line.accountId),
      })));
      return withAccounts.filter(({ account }) => account?.code === "1210").map(({ line }) => line);
    });
    expect(companyArLine).toHaveLength(1);
    expect(companyArLine[0].financeCompanyId).toBe(s.companyId);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1210|JOD": 12_500_000,
      "1400|JOD": -10_000_000,
      "4100|JOD": 12_500_000,
      "5100|JOD": 10_000_000,
    });
    expect(await publicIncomeStatement(s)).toMatchObject({
      currency: "JOD",
      totalRevenue: 12_500_000,
      totalCogs: 10_000_000,
      grossProfit: 2_500_000,
      netIncome: 2_500_000,
    });
  });

  test("owned configured financier × no deposit × cancellation before receipt: finance AR and sale reverse", async () => {
    const { s, applicationId } = await ownedFinancedOpening("s486financecancel");
    const application = await s.t.run((ctx) => ctx.db.get(applicationId));
    const saleId = application?.finalizedSaleId;
    expect(saleId).toBeDefined();
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId!)).toEqual(["POSTED"]);

    const beforeDeniedCancel = await dbSnapshot(s.t, Object.keys(schema.tables));
    await expect(s.actors.salesperson.as.mutation(api.applications.cancelApplication, {
      orgId: s.orgId, applicationId, reason: "Salesperson cannot reverse a financed sale",
      idempotencyKey: "s486-finance-salesperson-cancel-denied",
    })).rejects.toThrow(/cancel:closed_deal/);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(beforeDeniedCancel);
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId!)).toEqual(["POSTED"]);

    await s.owner.as.mutation(api.applications.cancelApplication, {
      orgId: s.orgId, applicationId, reason: "Certification before financier receipt",
      idempotencyKey: "s486-finance-before-receipt-cancel",
    });

    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");
    expect((await s.t.run((ctx) => ctx.db.get(saleId!)))?.status).toBe("CANCELLED");
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId!)).toEqual(["REVERSED"]);
    const invoice = await s.t.run((ctx) => ctx.db.query("receivableDocuments")
      .withIndex("by_org_source", (q) => q.eq("orgId", s.orgId)
        .eq("sourceType", "finance_application").eq("sourceId", applicationId))
      .unique());
    expect(invoice).toMatchObject({
      payerType: "FINANCE_COMPANY", originalAmountMinor: 12_500_000, status: "CANCELLED",
    });
    const rows = await journalRows(s);
    expectLiteralRows(rows, [
      { account: "1210", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "REVERSED" },
      { account: "4100", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "REVERSED" },
      { account: "5100", currency: "JOD", debit: 10_000_000, credit: 0, entryStatus: "REVERSED" },
      { account: "1400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "REVERSED" },
      { account: "1210", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
      { account: "4100", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "5100", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "POSTED" },
      { account: "1400", currency: "JOD", debit: 10_000_000, credit: 0, entryStatus: "POSTED" },
    ]);
    const financeArDimensions = await s.t.run(async (ctx) => {
      const lines = await ctx.db.query("journalLines")
        .withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect();
      const withAccounts = await Promise.all(lines.map(async (line) => ({
        line,
        account: await ctx.db.get(line.accountId),
      })));
      return withAccounts.filter(({ account }) => account?.code === "1210")
        .map(({ line }) => line.financeCompanyId);
    });
    expect(financeArDimensions).toEqual([s.companyId, s.companyId]);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({});
    expect(await publicIncomeStatement(s)).toMatchObject({
      totalRevenue: 0, totalCogs: 0, grossProfit: 0, netIncome: 0,
    });
  });

  async function sourcedFinancedOpening(tag: string, route: "THROUGH_DEALERSHIP" | "DIRECT_TO_SUPPLIER") {
    const s = await seedFinancedDealership(tag, {
      modules: MODULES,
      ownerPerms: [...OWNER_PERMS, "manage:supplier_settlement"],
      actors: {},
      label: "Certification",
      vinPrefix: "V486",
      sourced: true,
    });
    await s.t.run((ctx) => ctx.db.patch(s.vehicleId, { sourceCost: 10_000 }));
    const { applicationId } = await newApplication(s);
    await s.owner.as.mutation(api.applications.updateStatus, {
      orgId: s.orgId, applicationId, status: "UNDER_REVIEW",
    });
    await s.approver.as.mutation(api.applications.updateStatus, {
      orgId: s.orgId, applicationId, status: "APPROVED",
    });
    await s.owner.as.mutation(api.financingEconomics.recordSubmittedQuotation, {
      orgId: s.orgId, applicationId, submittedQuotationMinor: 12_500_000, source: "MANUAL_ENTRY",
    });
    await s.approver.as.mutation(api.financingEconomics.approveDealerPurchaseAmount, {
      orgId: s.orgId, applicationId, approvedAmountMinor: 12_500_000, basis: "MANUAL",
      notes: "Certification approval of the full vehicle price.",
    });
    await registerHandover(s.owner.as, api, s.orgId, applicationId);
    await s.owner.as.mutation(api.applications.registerExpectedPayment, {
      orgId: s.orgId, applicationId, method: "BANK_TRANSFER", expectedDate: Date.now(),
    });
    const feeId = await s.owner.as.mutation(api.financeDealCosts.recordDealFee, {
      expectedCurrency: "JOD", idempotencyKey: `${tag}-zero-fee`, orgId: s.orgId, applicationId,
      feeType: "OTHER_CLOSING_EXPENSE", paidBy: "DEALER", paidTo: "OTHER",
      accountingTreatment: "SELLING_EXPENSE", deductedFromSettlement: false,
      actualAmountMinor: 0, description: "No closing costs.",
    });
    await s.owner.as.mutation(api.financeDealCosts.reconcileDealFee, {
      orgId: s.orgId, feeId, notes: "No fee to settle.",
      expectedActualAmountMinor: 0,
      expectedActualEvidenceRevision: 0,
    });
    await s.owner.as.mutation(api.applications.setSupplierSettlementRoute, {
      orgId: s.orgId, applicationId, route,
    });
    await s.owner.as.mutation(api.applications.finalizeDeal, {
      idempotencyKey: `${tag}-finalize`, orgId: s.orgId, applicationId,
    });
    return { s, applicationId };
  }

  test("SOURCED configured financier × no deposit: company AR funds supplier liability and agent margin", async () => {
    const { s, applicationId } = await sourcedFinancedOpening("s486sourcedfinance", "THROUGH_DEALERSHIP");

    const application = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(application?.status).toBe("CLOSED");
    const saleId = application?.finalizedSaleId;
    expect(saleId).toBeDefined();
    const supplierPayables = await s.t.run((ctx) => ctx.db.query("vehicleSupplierPayables")
      .withIndex("by_sale", (q) => q.eq("saleId", saleId!)).collect());
    expect(supplierPayables).toHaveLength(1);
    expect(supplierPayables[0]).toMatchObject({
      orgId: s.orgId, vehicleId: s.vehicleId, saleId,
      amountDue: 10_000, currency: "JOD", status: "PENDING",
    });
    const receivable = await s.t.run((ctx) => ctx.db.query("receivableDocuments")
      .withIndex("by_org_source", (q) => q.eq("orgId", s.orgId)
        .eq("sourceType", "finance_application").eq("sourceId", applicationId))
      .unique());
    expect(receivable).toMatchObject({
      payerType: "FINANCE_COMPANY",
      financeCompanyId: s.companyId,
      originalAmountMinor: 12_500_000,
      currency: "JOD",
      status: "OPEN",
    });
    const rows = await journalRows(s);
    expectLiteralRows(rows, [
      { account: "1210", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "2400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "POSTED" },
      { account: "4170", currency: "JOD", debit: 0, credit: 2_500_000, entryStatus: "POSTED" },
    ]);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1210|JOD": 12_500_000,
      "2400|JOD": 10_000_000,
      "4170|JOD": 2_500_000,
    });
    const income = await publicIncomeStatement(s);
    expect(income).toMatchObject({
      currency: "JOD", totalRevenue: 2_500_000, totalCogs: 0,
      grossProfit: 2_500_000, netIncome: 2_500_000,
    });
    expect(income.revenueRows.map((row) => [row.code, row.netMinor])).toEqual([["4170", 2_500_000]]);
    expect(income.cogsRows).toEqual([]);
  });

  test("SOURCED configured financier × through dealership × cancellation before receipt reverses both debts", async () => {
    const { s, applicationId } = await sourcedFinancedOpening("s486sourcedthroughcancel", "THROUGH_DEALERSHIP");
    const application = await s.t.run((ctx) => ctx.db.get(applicationId));
    const saleId = application?.finalizedSaleId;
    expect(saleId).toBeDefined();
    const supplierPayable = await s.t.run((ctx) => ctx.db.query("vehicleSupplierPayables")
      .withIndex("by_sale", (q) => q.eq("saleId", saleId!)).unique());
    expect(supplierPayable).toMatchObject({ amountDue: 10_000, status: "PENDING" });
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId!)).toEqual(["POSTED"]);

    await s.owner.as.mutation(api.applications.cancelApplication, {
      orgId: s.orgId, applicationId, reason: "Certification before company and supplier payment",
      idempotencyKey: "s486-sourced-through-before-payment-cancel",
    });

    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");
    expect((await s.t.run((ctx) => ctx.db.get(saleId!)))?.status).toBe("CANCELLED");
    expect((await s.t.run((ctx) => ctx.db.get(supplierPayable!._id)))?.status).toBe("CANCELLED");
    const invoice = await s.t.run((ctx) => ctx.db.query("receivableDocuments")
      .withIndex("by_org_source", (q) => q.eq("orgId", s.orgId)
        .eq("sourceType", "finance_application").eq("sourceId", applicationId))
      .unique());
    expect(invoice).toMatchObject({
      payerType: "FINANCE_COMPANY", originalAmountMinor: 12_500_000, status: "CANCELLED",
    });
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId!)).toEqual(["REVERSED"]);
    const rows = await journalRows(s);
    expectLiteralRows(rows, [
      { account: "1210", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "REVERSED" },
      { account: "2400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "REVERSED" },
      { account: "4170", currency: "JOD", debit: 0, credit: 2_500_000, entryStatus: "REVERSED" },
      { account: "1210", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
      { account: "2400", currency: "JOD", debit: 10_000_000, credit: 0, entryStatus: "POSTED" },
      { account: "4170", currency: "JOD", debit: 2_500_000, credit: 0, entryStatus: "POSTED" },
    ]);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({});
    expect(await publicIncomeStatement(s)).toMatchObject({
      totalRevenue: 0, totalCogs: 0, grossProfit: 0, netIncome: 0,
    });
  });

  test("SOURCED configured financier × direct supplier payment: only the supplier owes the agent margin", async () => {
    const { s, applicationId } = await sourcedFinancedOpening("s486sourceddirect", "DIRECT_TO_SUPPLIER");
    const application = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(application).toMatchObject({
      status: "CLOSED", supplierSettlementRoute: "DIRECT_TO_SUPPLIER",
      expectedDealerRemittanceMinor: 0,
    });
    const saleId = application?.finalizedSaleId;
    expect(saleId).toBeDefined();
    const { supplierReceivables, supplierPayables, financierReceivables } = await s.t.run(async (ctx) => ({
      supplierReceivables: await ctx.db.query("vehicleSupplierReceivables")
        .withIndex("by_sale", (q) => q.eq("saleId", saleId!)).collect(),
      supplierPayables: await ctx.db.query("vehicleSupplierPayables")
        .withIndex("by_sale", (q) => q.eq("saleId", saleId!)).collect(),
      financierReceivables: await ctx.db.query("receivableDocuments")
        .withIndex("by_org_source", (q) => q.eq("orgId", s.orgId)
          .eq("sourceType", "finance_application").eq("sourceId", applicationId)).collect(),
    }));
    expect(supplierReceivables).toHaveLength(1);
    expect(supplierReceivables[0]).toMatchObject({
      orgId: s.orgId, vehicleId: s.vehicleId, saleId,
      amountDue: 2_500, currency: "JOD", status: "OPEN",
    });
    expect(supplierPayables).toEqual([]);
    expect(financierReceivables).toEqual([]);
    const rows = await journalRows(s);
    expectLiteralRows(rows, [
      { account: "1240", currency: "JOD", debit: 2_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "4170", currency: "JOD", debit: 0, credit: 2_500_000, entryStatus: "POSTED" },
    ]);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1240|JOD": 2_500_000, "4170|JOD": 2_500_000,
    });
    const income = await publicIncomeStatement(s);
    expect(income).toMatchObject({
      currency: "JOD", totalRevenue: 2_500_000, totalCogs: 0,
      grossProfit: 2_500_000, netIncome: 2_500_000,
    });
    expect(income.revenueRows.map((row) => [row.code, row.netMinor])).toEqual([["4170", 2_500_000]]);
    expect(income.cogsRows).toEqual([]);
    await s.owner.as.mutation(api.applications.confirmSupplierDisbursement, {
      orgId: s.orgId, applicationId, disbursedAmountMinor: 12_500_000,
      reference: "CERT-SUPPLIER-ADVICE", idempotencyKey: "s486-sourced-direct-advice",
    });
    const advised = await s.t.run((ctx) => ctx.db.get(applicationId));
    expect(advised).toMatchObject({
      supplierDisbursedAmountMinor: 12_500_000,
      supplierDisbursementReference: "CERT-SUPPLIER-ADVICE",
    });
    expect(advised?.disbursedAt).toBeUndefined();
    expect(await journalRows(s)).toEqual(rows);
    expect((await s.t.run((ctx) => ctx.db.get(supplierReceivables[0]._id)))?.status).toBe("OPEN");
    const afterAdvice = await dbSnapshot(s.t, Object.keys(schema.tables));
    await expect(s.owner.as.mutation(api.applications.cancelApplication, {
      orgId: s.orgId, applicationId, reason: "Certification after external supplier payment",
      idempotencyKey: "s486-sourced-direct-after-advice-cancel",
    })).rejects.toThrow(/already paid/i);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(afterAdvice);
    await expect(s.approver.as.mutation(api.sales.update, {
      orgId: s.orgId, saleId: saleId!, status: "CANCELLED",
    })).rejects.toThrow(/already paid the supplier/i);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(afterAdvice);
  });

  test("SOURCED direct settlement × cancellation before supplier receipt reverses the claim", async () => {
    const { s, applicationId } = await sourcedFinancedOpening("s486directcancel", "DIRECT_TO_SUPPLIER");
    const application = await s.t.run((ctx) => ctx.db.get(applicationId));
    const saleId = application?.finalizedSaleId;
    expect(saleId).toBeDefined();
    const claim = await s.t.run((ctx) => ctx.db.query("vehicleSupplierReceivables")
      .withIndex("by_sale", (q) => q.eq("saleId", saleId!)).unique());
    expect(claim).toMatchObject({ amountDue: 2_500, status: "OPEN" });
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId!)).toEqual(["POSTED"]);

    await s.owner.as.mutation(api.applications.cancelApplication, {
      orgId: s.orgId, applicationId, reason: "Certification before supplier collection",
      idempotencyKey: "s486-direct-before-supplier-receipt-cancel",
    });
    expect((await s.t.run((ctx) => ctx.db.get(applicationId)))?.status).toBe("CANCELLED");
    expect((await s.t.run((ctx) => ctx.db.get(saleId!)))?.status).toBe("CANCELLED");
    expect((await s.t.run((ctx) => ctx.db.get(claim!._id)))?.status).toBe("CANCELLED");
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId!)).toEqual(["REVERSED"]);
    const rows = await journalRows(s);
    expectLiteralRows(rows, [
      { account: "1240", currency: "JOD", debit: 2_500_000, credit: 0, entryStatus: "REVERSED" },
      { account: "4170", currency: "JOD", debit: 0, credit: 2_500_000, entryStatus: "REVERSED" },
      { account: "1240", currency: "JOD", debit: 0, credit: 2_500_000, entryStatus: "POSTED" },
      { account: "4170", currency: "JOD", debit: 2_500_000, credit: 0, entryStatus: "POSTED" },
    ]);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({});
    expect(await publicIncomeStatement(s)).toMatchObject({
      totalRevenue: 0, totalCogs: 0, grossProfit: 0, netIncome: 0,
    });
  });

  test("SOURCED direct settlement × supplier receipt: claim clears, duplicate and premature cancellation refuse", async () => {
    const { s, applicationId } = await sourcedFinancedOpening("s486directreceipt", "DIRECT_TO_SUPPLIER");
    const application = await s.t.run((ctx) => ctx.db.get(applicationId));
    const saleId = application?.finalizedSaleId;
    expect(saleId).toBeDefined();
    const claim = await s.t.run((ctx) => ctx.db.query("vehicleSupplierReceivables")
      .withIndex("by_sale", (q) => q.eq("saleId", saleId!)).unique());
    expect(claim).toMatchObject({ amountDue: 2_500, status: "OPEN" });
    const receiptArgs = {
      orgId: s.orgId, receivableId: claim!._id, amount: 2_500,
      receiptMethod: "BANK_TRANSFER" as const,
      idempotencyKey: "s486-direct-supplier-receipt",
    };
    expect(await s.owner.as.mutation(api.supplierReceivables.recordReceipt, receiptArgs)).toEqual({
      amountReceived: 2_500, remainingAmount: 0, status: "PAID",
    });
    const paidClaim = await s.t.run((ctx) => ctx.db.get(claim!._id));
    expect(paidClaim).toMatchObject({ amountReceived: 2_500, status: "PAID", receiptSeq: 1 });
    const rows = await journalRows(s);
    expectLiteralRows(rows, [
      { account: "1240", currency: "JOD", debit: 2_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "4170", currency: "JOD", debit: 0, credit: 2_500_000, entryStatus: "POSTED" },
      { account: "1110", currency: "JOD", debit: 2_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "1240", currency: "JOD", debit: 0, credit: 2_500_000, entryStatus: "POSTED" },
    ]);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1110|JOD": 2_500_000, "4170|JOD": 2_500_000,
    });
    const beforeRetry = await dbSnapshot(s.t, Object.keys(schema.tables));
    expect(await s.owner.as.mutation(api.supplierReceivables.recordReceipt, receiptArgs)).toEqual({
      amountReceived: 2_500, remainingAmount: 0, status: "PAID",
    });
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(beforeRetry);
    await expect(s.owner.as.mutation(api.applications.cancelApplication, {
      orgId: s.orgId, applicationId, reason: "Certification cancellation after supplier receipt",
      idempotencyKey: "s486-direct-after-supplier-receipt-cancel",
    })).rejects.toThrow(/supplier has paid against its commission claim/i);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(beforeRetry);
    expect((await s.t.run((ctx) => ctx.db.get(saleId!)))?.status).toBe("COMPLETED");
  });

  test("SOURCED direct settlement × partial supplier receipts: claim and bank move only by money received", async () => {
    const { s, applicationId } = await sourcedFinancedOpening("s486directpartial", "DIRECT_TO_SUPPLIER");
    const application = await s.t.run((ctx) => ctx.db.get(applicationId));
    const saleId = application?.finalizedSaleId;
    expect(saleId).toBeDefined();
    const claim = await s.t.run((ctx) => ctx.db.query("vehicleSupplierReceivables")
      .withIndex("by_sale", (q) => q.eq("saleId", saleId!)).unique());
    expect(claim).toMatchObject({ amountDue: 2_500, status: "OPEN" });
    const firstArgs = {
      orgId: s.orgId, receivableId: claim!._id, amount: 1_000,
      receiptMethod: "BANK_TRANSFER" as const,
      idempotencyKey: "s486-direct-supplier-partial-first",
    };
    expect(await s.owner.as.mutation(api.supplierReceivables.recordReceipt, firstArgs)).toEqual({
      amountReceived: 1_000, remainingAmount: 1_500, status: "PARTIALLY_PAID",
    });
    expect(await s.t.run((ctx) => ctx.db.get(claim!._id))).toMatchObject({
      amountReceived: 1_000, receiptSeq: 1, status: "PARTIALLY_PAID",
    });
    expect(await eventStatuses(s, "SUPPLIER_RECEIVABLE_COLLECTED", claim!._id, "vehicleSupplierReceivables"))
      .toEqual(["POSTED"]);
    expectLiteralRows(await journalRows(s), [
      { account: "1240", currency: "JOD", debit: 2_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "4170", currency: "JOD", debit: 0, credit: 2_500_000, entryStatus: "POSTED" },
      { account: "1110", currency: "JOD", debit: 1_000_000, credit: 0, entryStatus: "POSTED" },
      { account: "1240", currency: "JOD", debit: 0, credit: 1_000_000, entryStatus: "POSTED" },
    ]);
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1110|JOD": 1_000_000, "1240|JOD": 1_500_000, "4170|JOD": 2_500_000,
    });
    const afterFirst = await dbSnapshot(s.t, Object.keys(schema.tables));
    expect(await s.owner.as.mutation(api.supplierReceivables.recordReceipt, firstArgs)).toEqual({
      amountReceived: 1_000, remainingAmount: 1_500, status: "PARTIALLY_PAID",
    });
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(afterFirst);
    await expect(s.owner.as.mutation(api.supplierReceivables.recordReceipt, {
      ...firstArgs, amount: 1_501, idempotencyKey: "s486-direct-supplier-overpayment",
    })).rejects.toThrow(/against .* owed/i);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(afterFirst);
    await expect(s.owner.as.mutation(api.applications.cancelApplication, {
      orgId: s.orgId, applicationId, reason: "Partial supplier payment has arrived",
      idempotencyKey: "s486-direct-partially-paid-cancel-denied",
    })).rejects.toThrow(/supplier has paid against its commission claim/i);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(afterFirst);

    expect(await s.owner.as.mutation(api.supplierReceivables.recordReceipt, {
      ...firstArgs, amount: 1_500, idempotencyKey: "s486-direct-supplier-partial-final",
    })).toEqual({ amountReceived: 2_500, remainingAmount: 0, status: "PAID" });
    expect(await s.t.run((ctx) => ctx.db.get(claim!._id))).toMatchObject({
      amountReceived: 2_500, receiptSeq: 2, status: "PAID",
    });
    expect(await eventStatuses(s, "SUPPLIER_RECEIVABLE_COLLECTED", claim!._id, "vehicleSupplierReceivables"))
      .toEqual(["POSTED", "POSTED"]);
    const rows = await journalRows(s);
    expectLiteralRows(rows, [
      { account: "1240", currency: "JOD", debit: 2_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "4170", currency: "JOD", debit: 0, credit: 2_500_000, entryStatus: "POSTED" },
      { account: "1110", currency: "JOD", debit: 1_000_000, credit: 0, entryStatus: "POSTED" },
      { account: "1240", currency: "JOD", debit: 0, credit: 1_000_000, entryStatus: "POSTED" },
      { account: "1110", currency: "JOD", debit: 1_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "1240", currency: "JOD", debit: 0, credit: 1_500_000, entryStatus: "POSTED" },
    ]);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1110|JOD": 2_500_000, "4170|JOD": 2_500_000,
    });
    expect(await publicIncomeStatement(s)).toMatchObject({
      totalRevenue: 2_500_000, totalCogs: 0, grossProfit: 2_500_000, netIncome: 2_500_000,
    });
  });

  test("owned CASH × no deposit: sale recognizes literal receivable, revenue, COGS and inventory", async () => {
    const { s, quoteId } = await cashQuote("s486cashnone");
    const saleId = await completeCashSale(s, quoteId, "no-deposit");

    const saleStatus = await s.t.run(async (ctx) => (await ctx.db.get(saleId))?.status);
    const rows = await journalRows(s);
    expect(saleStatus).toBe("COMPLETED");
    expectLiteralRows(rows, [
      { account: "1200", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "4100", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
      { account: "5100", currency: "JOD", debit: 10_000_000, credit: 0, entryStatus: "POSTED" },
      { account: "1400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "POSTED" },
    ]);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1200|JOD": 12_500_000,
      "1400|JOD": -10_000_000,
      "4100|JOD": 12_500_000,
      "5100|JOD": 10_000_000,
    });
    const income = await publicIncomeStatement(s);
    expect(income).toMatchObject({
      currency: "JOD",
      totalRevenue: 12_500_000,
      totalCogs: 10_000_000,
      grossProfit: 2_500_000,
      netIncome: 2_500_000,
    });
    expect(income.revenueRows.map((row) => [row.code, row.netMinor])).toEqual([["4100", 12_500_000]]);
    expect(income.cogsRows.map((row) => [row.code, row.netMinor])).toEqual([["5100", 10_000_000]]);
  });

  test("owned CASH × no deposit × cancellation: sale journals reverse without a customer credit", async () => {
    const { s, quoteId } = await cashQuote("s486ownedcancel");
    const saleId = await completeCashSale(s, quoteId, "owned-no-deposit-cancel");
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId)).toEqual(["POSTED"]);
    expect(netByAccount(await journalRows(s))).toEqual({
      "1200|JOD": 12_500_000,
      "1400|JOD": -10_000_000,
      "4100|JOD": -12_500_000,
      "5100|JOD": 10_000_000,
    });

    await s.approver.as.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId,
      status: "CANCELLED",
    });
    expect((await s.t.run((ctx) => ctx.db.get(saleId)))?.status).toBe("CANCELLED");
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId)).toEqual(["REVERSED"]);
    // Equal account totals cannot substitute for the event-to-journal binding.
    const saleBindings = await s.t.run(async (ctx) => {
      const events = await ctx.db.query("accountingEvents")
        .withIndex("by_org_source", (q) =>
          q.eq("orgId", s.orgId).eq("sourceType", "sales").eq("sourceId", saleId)
        ).collect();
      return Promise.all(events.map(async (event) => {
        const entryId = event.journalEntryId;
        const entry = entryId ? await ctx.db.get(entryId) : null;
        const lines = entryId ? await ctx.db.query("journalLines")
          .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entryId))
          .collect() : [];
        const rows = await Promise.all(lines.map(async (line) => {
          const account = await ctx.db.get(line.accountId);
          return {
            account: account?.code,
            currency: line.currency,
            debit: line.debitMinor,
            credit: line.creditMinor,
            entryStatus: entry?.status,
          };
        }));
        return { event, entry, rows };
      }));
    });
    expect(saleBindings).toHaveLength(2);
    const originalBinding = saleBindings.find(({ event }) => event.eventType === "SALE_COMPLETED");
    const reversalBinding = saleBindings.find(({ event }) => event.eventType === "JOURNAL_REVERSAL");
    expect(originalBinding?.entry).toMatchObject({
      accountingEventId: originalBinding?.event._id,
      sourceType: "sales", sourceId: saleId, status: "REVERSED",
    });
    expect(reversalBinding?.event).toMatchObject({
      status: "POSTED", reversalOfEventId: originalBinding?.event._id,
    });
    expect(reversalBinding?.entry).toMatchObject({
      accountingEventId: reversalBinding?.event._id,
      sourceType: "sales", sourceId: saleId, category: "REVERSAL",
      reversalOfJournalEntryId: originalBinding?.entry?._id,
    });
    const originalRows: JournalRow[] = [
      { account: "1200", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "REVERSED" },
      { account: "4100", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "REVERSED" },
      { account: "5100", currency: "JOD", debit: 10_000_000, credit: 0, entryStatus: "REVERSED" },
      { account: "1400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "REVERSED" },
    ];
    const reversalRows: JournalRow[] = [
      { account: "1200", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
      { account: "4100", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "5100", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "POSTED" },
      { account: "1400", currency: "JOD", debit: 10_000_000, credit: 0, entryStatus: "POSTED" },
    ];
    expectLiteralRows(originalBinding?.rows ?? [], originalRows);
    expectLiteralRows(reversalBinding?.rows ?? [], reversalRows);
    const rows = await journalRows(s);
    expectLiteralRows(rows, [...originalRows, ...reversalRows]);
    expectBalanced(rows);
    expect(netByAccount(rows)).toEqual({});
    expect(await trialBalanceNormalBalance(s)).toEqual({});
    expect(await publicIncomeStatement(s)).toMatchObject({
      totalRevenue: 0, totalCogs: 0, grossProfit: 0, netIncome: 0,
    });
  });

  test("SOURCED CASH × no deposit: agent margin only, full customer AR and supplier liability", async () => {
    const { s, quoteId } = await sourcedCashQuote("s486sourcedcash");
    const saleId = await completeCashSale(s, quoteId, "sourced-no-deposit");

    expect((await s.t.run((ctx) => ctx.db.get(saleId)))?.status).toBe("COMPLETED");
    const supplierPayables = await s.t.run((ctx) =>
      ctx.db.query("vehicleSupplierPayables")
        .withIndex("by_sale", (q) => q.eq("saleId", saleId))
        .collect()
    );
    expect(supplierPayables).toHaveLength(1);
    expect(supplierPayables[0]).toMatchObject({
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      saleId,
      amountDue: 10_000,
      currency: "JOD",
      status: "PENDING",
    });
    const rows = await journalRows(s);
    expectLiteralRows(rows, [
      { account: "1200", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "2400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "POSTED" },
      { account: "4170", currency: "JOD", debit: 0, credit: 2_500_000, entryStatus: "POSTED" },
    ]);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1200|JOD": 12_500_000,
      "2400|JOD": 10_000_000,
      "4170|JOD": 2_500_000,
    });
    const income = await publicIncomeStatement(s);
    expect(income).toMatchObject({
      currency: "JOD",
      totalRevenue: 2_500_000,
      totalCogs: 0,
      grossProfit: 2_500_000,
      netIncome: 2_500_000,
    });
    expect(income.revenueRows.map((row) => [row.code, row.netMinor])).toEqual([["4170", 2_500_000]]);
    expect(income.cogsRows).toEqual([]);
  });

  test("SOURCED CASH × no deposit × cancellation: agency sale and supplier claim reverse", async () => {
    const { s, quoteId } = await sourcedCashQuote("s486sourcedcancel");
    const saleId = await completeCashSale(s, quoteId, "sourced-cancel");
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId)).toEqual(["POSTED"]);
    expect(netByAccount(await journalRows(s))).toEqual({
      "1200|JOD": 12_500_000,
      "2400|JOD": -10_000_000,
      "4170|JOD": -2_500_000,
    });

    await s.approver.as.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId,
      status: "CANCELLED",
    });
    const { sale, payable } = await s.t.run(async (ctx) => ({
      sale: await ctx.db.get(saleId),
      payable: await ctx.db.query("vehicleSupplierPayables")
        .withIndex("by_sale", (q) => q.eq("saleId", saleId)).first(),
    }));
    expect(sale?.status).toBe("CANCELLED");
    expect(payable).toMatchObject({
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      saleId,
      amountDue: 10_000,
      currency: "JOD",
      status: "CANCELLED",
    });
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId)).toEqual(["REVERSED"]);
    const rows = await journalRows(s);
    expectLiteralRows(rows, [
      { account: "1200", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "REVERSED" },
      { account: "2400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "REVERSED" },
      { account: "4170", currency: "JOD", debit: 0, credit: 2_500_000, entryStatus: "REVERSED" },
      { account: "1200", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
      { account: "2400", currency: "JOD", debit: 10_000_000, credit: 0, entryStatus: "POSTED" },
      { account: "4170", currency: "JOD", debit: 2_500_000, credit: 0, entryStatus: "POSTED" },
    ]);
    expect(netByAccount(rows)).toEqual({});
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({});
    expect(await publicIncomeStatement(s)).toMatchObject({
      totalRevenue: 0, totalCogs: 0, grossProfit: 0, netIncome: 0,
    });
  });

  test.each([
    {
      route: "owned",
      quote: cashQuote,
      expectedNet: {
        "1200|JOD": 12_500_000,
        "1400|JOD": -10_000_000,
        "4100|JOD": -12_500_000,
        "5100|JOD": 10_000_000,
      },
    },
    {
      route: "sourced",
      quote: sourcedCashQuote,
      expectedNet: {
        "1200|JOD": 12_500_000,
        "2400|JOD": -10_000_000,
        "4170|JOD": -2_500_000,
      },
    },
  ])("$route CASH × completed sale: salesperson with edit:sales cannot reverse money", async ({ route, quote, expectedNet }) => {
    const { s, quoteId } = await quote(`s486${route}sellerdeny`);
    const saleId = await completeCashSale(s, quoteId, `${route}-seller-deny`);
    const clerkId = `s486${route}sellerdeny_salesperson`;
    await s.t.run(async (ctx) => {
      const userId = await ctx.db.insert("users", {
        clerkId,
        email: `${clerkId}@example.com`,
        name: "salesperson",
      });
      const roleId = await ctx.db.insert("roles", {
        orgId: s.orgId,
        name: "SALESPERSON",
        permissions: ["view:sales", "create:sales", "edit:sales"],
      });
      await ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId });
    });
    const salesperson = s.t.withIdentity({ subject: clerkId, clerkId });
    const before = await dbSnapshot(s.t, Object.keys(schema.tables));
    await expect(salesperson.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId,
      status: "CANCELLED",
    })).rejects.toThrow(/approve:requests/);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(before);
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId)).toEqual(["POSTED"]);
    expect(netByAccount(await journalRows(s))).toEqual(expectedNet);
  });

  test("SOURCED CASH × applied deposit: customer AR falls, supplier entitlement stays whole", async () => {
    const { s, quoteId } = await sourcedCashQuote("s486sourcedapplied", 200);
    const depositId = await s.owner.as.mutation(api.deposits.create, {
      orgId: s.orgId,
      quoteId,
      amount: 200,
      method: "CASH",
      idempotencyKey: "scrum486-sourced-applied-deposit",
    });
    const saleId = await completeCashSale(s, quoteId, "sourced-applied-deposit");
    const { sale, deposit, payable, applications } = await s.t.run(async (ctx) => ({
      sale: await ctx.db.get(saleId),
      deposit: await ctx.db.get(depositId),
      payable: await ctx.db.query("vehicleSupplierPayables")
        .withIndex("by_sale", (q) => q.eq("saleId", saleId)).first(),
      applications: await ctx.db.query("depositApplications")
        .withIndex("by_deposit", (q) => q.eq("depositId", depositId)).collect(),
    }));
    expect(sale?.status).toBe("COMPLETED");
    expect(deposit?.status).toBe("APPLIED");
    expect(payable).toMatchObject({
      orgId: s.orgId,
      vehicleId: s.vehicleId,
      saleId,
      amountDue: 10_000,
      currency: "JOD",
      status: "PENDING",
    });
    expect(applications).toHaveLength(1);
    expect(applications[0]).toMatchObject({ treatment: "CUSTOMER_RECEIVABLE", amountMinor: 200_000 });
    const rows = await journalRows(s);
    expectLiteralRows(rows, [
      { account: "1100", currency: "JOD", debit: 200_000, credit: 0, entryStatus: "POSTED" },
      { account: "2100", currency: "JOD", debit: 0, credit: 200_000, entryStatus: "POSTED" },
      { account: "2100", currency: "JOD", debit: 200_000, credit: 0, entryStatus: "POSTED" },
      { account: "1200", currency: "JOD", debit: 0, credit: 200_000, entryStatus: "POSTED" },
      { account: "1200", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "2400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "POSTED" },
      { account: "4170", currency: "JOD", debit: 0, credit: 2_500_000, entryStatus: "POSTED" },
    ]);
    expectBalanced(rows);
    expect(await trialBalanceNormalBalance(s)).toEqual({
      "1100|JOD": 200_000,
      "1200|JOD": 12_300_000,
      "2400|JOD": 10_000_000,
      "4170|JOD": 2_500_000,
    });
  });

  test("SOURCED CASH × applied deposit × cancellation × refund: customer money returns without supplier debt", async () => {
    const { s, quoteId } = await sourcedCashQuote("s486sourcedrefund", 200);
    const depositId = await s.owner.as.mutation(api.deposits.create, {
      orgId: s.orgId,
      quoteId,
      amount: 200,
      method: "CASH",
      idempotencyKey: "scrum486-sourced-refund-hold",
    });
    const saleId = await completeCashSale(s, quoteId, "sourced-refund");
    expect(netByAccount(await journalRows(s))).toEqual({
      "1100|JOD": 200_000,
      "1200|JOD": 12_300_000,
      "2400|JOD": -10_000_000,
      "4170|JOD": -2_500_000,
    });

    await s.approver.as.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId,
      status: "CANCELLED",
    });
    const cancelled = await s.t.run(async (ctx) => ({
      sale: await ctx.db.get(saleId),
      deposit: await ctx.db.get(depositId),
      payable: await ctx.db.query("vehicleSupplierPayables")
        .withIndex("by_sale", (q) => q.eq("saleId", saleId)).first(),
      applications: await ctx.db.query("depositApplications")
        .withIndex("by_sale", (q) => q.eq("saleId", saleId)).collect(),
    }));
    expect(cancelled.sale?.status).toBe("CANCELLED");
    expect(cancelled.payable?.status).toBe("CANCELLED");
    expect(cancelled.deposit).toMatchObject({ status: "HELD", holdActive: true, amountMinor: 200_000 });
    expect(cancelled.applications.map((application) => application.status)).toEqual(["REVERSED"]);
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId)).toEqual(["REVERSED"]);
    expect(await eventStatuses(s, "DEPOSIT_RECEIVED", depositId)).toEqual(["POSTED"]);
    const cancellationRows = await journalRows(s);
    expect(netByAccount(cancellationRows)).toEqual({ "1100|JOD": 200_000, "2100|JOD": -200_000 });
    expectBalanced(cancellationRows);
    expect(await trialBalanceNormalBalance(s)).toEqual({ "1100|JOD": 200_000, "2100|JOD": 200_000 });

    await s.approver.as.mutation(api.deposits.release, {
      orgId: s.orgId,
      depositId,
      resolution: "REFUNDED",
      refundMethod: "CASH",
      idempotencyKey: "scrum486-sourced-refund-release",
    });
    expect((await s.t.run((ctx) => ctx.db.get(depositId)))?.status).toBe("REFUNDED");
    expect(await eventStatuses(s, "DEPOSIT_REFUNDED", depositId)).toEqual(["POSTED"]);
    const finalRows = await journalRows(s);
    expect(netByAccount(finalRows)).toEqual({});
    expectBalanced(finalRows);
    expect(await trialBalanceNormalBalance(s)).toEqual({});
  });

  test("owned CASH × held/applied deposit: 200,000 liability reduces the invoice receivable, not revenue", async () => {
    const { s, quoteId } = await cashQuote("s486cashapplied");
    const depositId = await s.owner.as.mutation(api.deposits.create, {
      orgId: s.orgId,
      quoteId,
      amount: 200,
      method: "CASH",
      idempotencyKey: "scrum486-applied-deposit",
    });
    const saleId = await completeCashSale(s, quoteId, "applied-deposit");
    const { deposit, sale } = await s.t.run(async (ctx) => ({
      deposit: await ctx.db.get(depositId),
      sale: await ctx.db.get(saleId),
    }));
    const rows = await journalRows(s);
    expect(deposit?.status).toBe("APPLIED");
    expect(sale?.status).toBe("COMPLETED");
    expectLiteralRows(rows, [
      { account: "1100", currency: "JOD", debit: 200_000, credit: 0, entryStatus: "POSTED" },
      { account: "2100", currency: "JOD", debit: 0, credit: 200_000, entryStatus: "POSTED" },
      { account: "2100", currency: "JOD", debit: 200_000, credit: 0, entryStatus: "POSTED" },
      { account: "1200", currency: "JOD", debit: 0, credit: 200_000, entryStatus: "POSTED" },
      { account: "1200", currency: "JOD", debit: 12_500_000, credit: 0, entryStatus: "POSTED" },
      { account: "4100", currency: "JOD", debit: 0, credit: 12_500_000, entryStatus: "POSTED" },
      { account: "5100", currency: "JOD", debit: 10_000_000, credit: 0, entryStatus: "POSTED" },
      { account: "1400", currency: "JOD", debit: 0, credit: 10_000_000, entryStatus: "POSTED" },
    ]);
    expectBalanced(rows);
  });

  test("owned CASH × applied deposit × cancelled sale × refund: only the held customer money survives the reversal", async () => {
    const { s, quoteId } = await cashQuote("s486cancelrefund");
    const depositId = await s.owner.as.mutation(api.deposits.create, {
      orgId: s.orgId,
      quoteId,
      amount: 200,
      method: "CASH",
      idempotencyKey: "scrum486-cancel-refund-hold",
    });
    const saleId = await completeCashSale(s, quoteId, "cancel-refund");
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId)).toEqual(["POSTED"]);
    expect(await eventStatuses(s, "DEPOSIT_RECEIVED", depositId)).toEqual(["POSTED"]);
    expect(netByAccount(await journalRows(s))).toEqual({
      "1100|JOD": 200_000,
      "1200|JOD": 12_300_000,
      "1400|JOD": -10_000_000,
      "4100|JOD": -12_500_000,
      "5100|JOD": 10_000_000,
    });

    await s.approver.as.mutation(api.sales.update, {
      orgId: s.orgId,
      saleId,
      status: "CANCELLED",
    });
    const cancelled = await s.t.run(async (ctx) => ({
      sale: await ctx.db.get(saleId),
      deposit: await ctx.db.get(depositId),
      applications: await ctx.db.query("depositApplications").withIndex("by_sale", (q) => q.eq("saleId", saleId)).collect(),
    }));
    expect(cancelled.sale?.status).toBe("CANCELLED");
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId)).toEqual(["REVERSED"]);
    expect(await eventStatuses(s, "DEPOSIT_RECEIVED", depositId)).toEqual(["POSTED"]);
    expect(cancelled.deposit).toMatchObject({ status: "HELD", holdActive: true, amountMinor: 200_000 });
    expect(cancelled.applications.map((application) => application.status)).toEqual(["REVERSED"]);
    const cancellationRows = await journalRows(s);
    expect(netByAccount(cancellationRows)).toEqual({ "1100|JOD": 200_000, "2100|JOD": -200_000 });
    expectBalanced(cancellationRows);
    expect(await trialBalanceNormalBalance(s)).toEqual({ "1100|JOD": 200_000, "2100|JOD": 200_000 });

    await s.approver.as.mutation(api.deposits.release, {
      orgId: s.orgId,
      depositId,
      resolution: "REFUNDED",
      refundMethod: "CASH",
      idempotencyKey: "scrum486-cancel-refund-release",
    });
    const refunded = await s.t.run((ctx) => ctx.db.get(depositId));
    const finalRows = await journalRows(s);
    expect(refunded?.status).toBe("REFUNDED");
    expect(await eventStatuses(s, "DEPOSIT_REFUNDED", depositId)).toEqual(["POSTED"]);
    expect(netByAccount(finalRows)).toEqual({});
    expectBalanced(finalRows);
    expect(await trialBalanceNormalBalance(s)).toEqual({});
  });

  test.each([
    { ending: "REFUNDED" as const, creditAccount: "1100" },
    { ending: "FORFEITED" as const, creditAccount: "4200" },
  ])("owned CASH × held deposit × $ending before sale: only customer money moves", async ({ ending, creditAccount }) => {
    const { s, quoteId } = await cashQuote(`s486${ending.toLowerCase()}`);
    const beforeOperational = await s.owner.as.query(api.reports.getProfitAndLoss, {
      orgId: s.orgId,
      startDate: Date.UTC(s.fiscalYear, 0, 1),
      endDate: Date.UTC(s.fiscalYear, 11, 31, 23, 59, 59, 999),
    });
    const depositId = await s.owner.as.mutation(api.deposits.create, {
      orgId: s.orgId,
      quoteId,
      amount: 200,
      method: "CASH",
      idempotencyKey: `scrum486-${ending}-deposit`,
    });
    expectLiteralRows(await journalRows(s), [
      { account: "1100", currency: "JOD", debit: 200_000, credit: 0, entryStatus: "POSTED" },
      { account: "2100", currency: "JOD", debit: 0, credit: 200_000, entryStatus: "POSTED" },
    ]);

    await s.approver.as.mutation(api.deposits.release, {
      orgId: s.orgId,
      depositId,
      resolution: ending,
      ...(ending === "REFUNDED" ? { refundMethod: "CASH" as const } : {}),
      idempotencyKey: `scrum486-${ending}-release`,
    });
    const deposit = await s.t.run((ctx) => ctx.db.get(depositId));
    const saleCount = await s.t.run(async (ctx) => (await ctx.db.query("sales").collect()).length);
    const rows = await journalRows(s);
    expect(deposit?.status).toBe(ending);
    expect(saleCount).toBe(0);
    expectLiteralRows(rows, [
      { account: "1100", currency: "JOD", debit: 200_000, credit: 0, entryStatus: "POSTED" },
      { account: "2100", currency: "JOD", debit: 0, credit: 200_000, entryStatus: "POSTED" },
      { account: "2100", currency: "JOD", debit: 200_000, credit: 0, entryStatus: "POSTED" },
      { account: creditAccount, currency: "JOD", debit: 0, credit: 200_000, entryStatus: "POSTED" },
    ]);
    expectBalanced(rows);
    if (ending === "FORFEITED") {
      const income = await publicIncomeStatement(s);
      const operational = await s.owner.as.query(api.reports.getProfitAndLoss, {
        orgId: s.orgId,
        startDate: Date.UTC(s.fiscalYear, 0, 1),
        endDate: Date.UTC(s.fiscalYear, 11, 31, 23, 59, 59, 999),
      });
      expect(income.totalOtherIncome).toBe(200_000);
      expect(operational.totalRevenue).toBe(beforeOperational.totalRevenue);
      expect(operational.depositForfeitureIncome).toBe(200);
      expect(operational.depositForfeitureIncomeByCurrency).toEqual([{ currency: "JOD", amount: 200 }]);
      expect(operational.netProfit - beforeOperational.netProfit).toBe(200);

      // A chart repair can clear a duplicate's current systemKey after it
      // received historical postings. Reports must follow the event/journal,
      // not today's account mapping.
      await s.t.run(async (ctx) => {
        const account = await ctx.db.query("chartOfAccounts")
          .withIndex("by_org_code", (q) => q.eq("orgId", s.orgId).eq("code", "4200"))
          .unique();
        if (!account) throw new Error("Missing forfeiture account fixture");
        await ctx.db.patch(account._id, { systemKey: undefined });
      });
      const afterRemap = await s.owner.as.query(api.reports.getProfitAndLoss, {
        orgId: s.orgId,
        startDate: Date.UTC(s.fiscalYear, 0, 1),
        endDate: Date.UTC(s.fiscalYear, 11, 31, 23, 59, 59, 999),
      });
      expect(afterRemap.depositForfeitureIncome).toBe(200);
      expect((await publicIncomeStatement(s)).totalOtherIncome).toBe(200_000);

      await s.t.run(async (ctx) => {
        const event = await ctx.db.query("accountingEvents")
          .withIndex("by_org_eventType", (q) => q.eq("orgId", s.orgId).eq("eventType", "DEPOSIT_FORFEITED"))
          .unique();
        if (!event) throw new Error("Missing forfeiture event fixture");
        await ctx.db.patch(event._id, { journalEntryId: undefined });
      });
      await expect(s.owner.as.query(api.reports.getProfitAndLoss, {
        orgId: s.orgId,
        startDate: Date.UTC(s.fiscalYear, 0, 1),
        endDate: Date.UTC(s.fiscalYear, 11, 31, 23, 59, 59, 999),
      })).rejects.toThrow("Financial report is unavailable");
    }
  });

  test("a later forfeiture corrects legacy receipt-month turnover without rewriting its journal", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2025-04-15T12:00:00.000Z"));
      const { s, quoteId } = await cashQuote("s486legacyforfeit");
      const depositId = await s.owner.as.mutation(api.deposits.create, {
        orgId: s.orgId, quoteId, amount: 200, method: "CASH",
        idempotencyKey: "s486legacyforfeit-deposit",
      });
      await s.t.run(async (ctx) => {
        const receipts = (await ctx.db.query("transactions")
          .withIndex("by_org", (q) => q.eq("orgId", s.orgId)).collect())
          .filter((tx) => tx.category === "DEPOSIT" && tx.depositId === depositId);
        expect(receipts).toHaveLength(1);
        await ctx.db.patch(receipts[0]._id, { excludedFromRevenue: undefined });
      });
      const april = { orgId: s.orgId, startDate: Date.UTC(2025, 3, 1), endDate: Date.UTC(2025, 4, 1) - 1 };
      const may = { orgId: s.orgId, startDate: Date.UTC(2025, 4, 1), endDate: Date.UTC(2025, 5, 1) - 1 };
      expect((await s.owner.as.query(api.reports.getProfitAndLoss, april)).totalRevenue).toBe(200);
      // SCRUM-815 c22806: the old receipt was posted to a liability. Only the
      // legacy report's mistaken turnover is corrected after forfeiture.
      const receiptPostingBefore = await s.t.run(async (ctx) => {
        const events = await ctx.db.query("accountingEvents")
          .withIndex("by_org_source", (q) =>
            q.eq("orgId", s.orgId).eq("sourceType", "deposits").eq("sourceId", depositId)
          ).collect();
        const event = events.find((row) => row.eventType === "DEPOSIT_RECEIVED");
        if (!event?.journalEntryId) throw new Error("Missing posted receipt event");
        const entry = await ctx.db.get(event.journalEntryId);
        if (!entry) throw new Error("Missing posted receipt journal");
        const lines = await ctx.db.query("journalLines")
          .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", entry._id))
          .collect();
        const rows = await Promise.all(lines.map(async (line) => ({
          account: (await ctx.db.get(line.accountId))?.code,
          debit: line.debitMinor,
          credit: line.creditMinor,
        })));
        return { event, entry, lines, rows };
      });
      expect(receiptPostingBefore.entry.status).toBe("POSTED");
      expect(receiptPostingBefore.rows).toHaveLength(2);
      expect(receiptPostingBefore.rows).toEqual(expect.arrayContaining([
        { account: "1100", debit: 200_000, credit: 0 },
        { account: "2100", debit: 0, credit: 200_000 },
      ]));

      vi.setSystemTime(new Date("2025-05-15T12:00:00.000Z"));
      await s.approver.as.mutation(api.deposits.release, {
        orgId: s.orgId, depositId, resolution: "FORFEITED",
        idempotencyKey: "s486legacyforfeit-release",
      });
      const receiptMonth = await s.owner.as.query(api.reports.getProfitAndLoss, april);
      const forfeitureMonth = await s.owner.as.query(api.reports.getProfitAndLoss, may);
      expect(receiptMonth.totalRevenue).toBe(0);
      expect(receiptMonth.depositForfeitureIncome).toBe(0);
      expect(forfeitureMonth.totalRevenue).toBe(0);
      expect(forfeitureMonth.depositForfeitureIncome).toBe(200);
      expect(forfeitureMonth.netProfit).toBe(200);
      expect((await publicIncomeStatement(s)).totalOtherIncome).toBe(200_000);
      const receiptPostingAfter = await s.t.run(async (ctx) => ({
        event: await ctx.db.get(receiptPostingBefore.event._id),
        entry: await ctx.db.get(receiptPostingBefore.entry._id),
        lines: await ctx.db.query("journalLines")
          .withIndex("by_journal_entry", (q) => q.eq("journalEntryId", receiptPostingBefore.entry._id))
          .collect(),
      }));
      expect(receiptPostingAfter).toEqual({
        event: receiptPostingBefore.event,
        entry: receiptPostingBefore.entry,
        lines: receiptPostingBefore.lines,
      });

      // A slice resolution identifies the hold rather than the deposit as
      // its event source. Keep the posted journal fixed while changing only
      // that source shape, then require the same legacy receipt exclusion.
      await s.t.run(async (ctx) => {
        const deposit = await ctx.db.get(depositId);
        if (!deposit) throw new Error("Missing test deposit");
        const holdId = await ctx.db.insert("depositVehicleHolds", {
          orgId: s.orgId, depositId, vehicleId: deposit.vehicleId,
          active: false, createdAt: Date.now(),
        });
        const event = await ctx.db.query("accountingEvents")
          .withIndex("by_org_eventType", (q) =>
            q.eq("orgId", s.orgId).eq("eventType", "DEPOSIT_FORFEITED"))
          .first();
        if (!event) throw new Error("Missing test forfeiture event");
        await ctx.db.patch(event._id, {
          sourceType: "depositVehicleHolds", sourceId: holdId.toString(),
          payload: { ...(event.payload as Record<string, unknown>), holdId: holdId.toString() },
        });
      });
      expect((await s.owner.as.query(api.reports.getProfitAndLoss, april)).totalRevenue).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test("refund rows do not exhaust the legacy receipt lookup", async () => {
    const { s } = await cashQuote("s486refundvolume");
    const year = s.fiscalYear;
    await s.t.run(async (ctx) => {
      const creator = await ctx.db.query("users").first();
      if (!creator) throw new Error("Missing test user");
      for (let i = 0; i < 129; i++) {
        const depositId = await ctx.db.insert("deposits", {
          orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId,
          amount: 1, status: "REFUNDED", holdActive: false,
          createdBy: creator._id, createdAt: Date.UTC(year, 0, 2) + i,
        });
        await ctx.db.insert("transactions", {
          orgId: s.orgId, type: "OUT", amount: 1,
          date: Date.UTC(year, 0, 3) + i, category: "DEPOSIT",
          description: "Deposit refund", vehicleId: s.vehicleId, depositId,
        });
      }
    });
    const report = await s.owner.as.query(api.reports.getProfitAndLoss, {
      orgId: s.orgId,
      startDate: Date.UTC(year, 0, 1),
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    });
    expect(report.totalRevenue).toBe(0);
    expect(report.depositForfeitureIncome).toBe(0);
  });

  test("129 historical incoming receipts stay available and an over-cap report fails closed", async () => {
    const { s } = await cashQuote("s486legacyvolume");
    const year = s.fiscalYear;
    await s.t.run(async (ctx) => {
      const creator = await ctx.db.query("users").first();
      if (!creator) throw new Error("Missing test user");
      for (let i = 0; i < 129; i++) {
        const depositId = await ctx.db.insert("deposits", {
          orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId,
          amount: 1, status: "REFUNDED", holdActive: false,
          createdBy: creator._id, createdAt: Date.UTC(year, 0, 2) + i,
        });
        await ctx.db.insert("transactions", {
          orgId: s.orgId, type: "IN", amount: 1,
          date: Date.UTC(year, 0, 3) + i, category: "DEPOSIT",
          description: "Historical deposit receipt", vehicleId: s.vehicleId, depositId,
        });
      }
    });
    const report = await s.owner.as.query(api.reports.getProfitAndLoss, {
      orgId: s.orgId,
      startDate: Date.UTC(year, 0, 1),
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    });
    expect(report.totalRevenue).toBe(129);
    expect(report.depositForfeitureIncome).toBe(0);

    await s.t.run(async (ctx) => {
      const creator = await ctx.db.query("users").first();
      if (!creator) throw new Error("Missing test user");
      for (let i = 129; i < 512; i++) {
        const depositId = await ctx.db.insert("deposits", {
          orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId,
          amount: 1, status: "REFUNDED", holdActive: false,
          createdBy: creator._id, createdAt: Date.UTC(year, 0, 2) + i,
        });
        await ctx.db.insert("transactions", {
          orgId: s.orgId, type: "IN", amount: 1,
          date: Date.UTC(year, 0, 3) + i, category: "DEPOSIT",
          description: "Historical deposit receipt", vehicleId: s.vehicleId, depositId,
        });
      }
    });
    expect((await s.owner.as.query(api.reports.getProfitAndLoss, {
      orgId: s.orgId,
      startDate: Date.UTC(year, 0, 1),
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    })).totalRevenue).toBe(512);
    await s.t.run(async (ctx) => {
      const creator = await ctx.db.query("users").first();
      if (!creator) throw new Error("Missing test user");
      const depositId = await ctx.db.insert("deposits", {
        orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId,
        amount: 1, status: "REFUNDED", holdActive: false,
        createdBy: creator._id, createdAt: Date.UTC(year, 0, 2) + 512,
      });
      await ctx.db.insert("transactions", {
        orgId: s.orgId, type: "IN", amount: 1,
        date: Date.UTC(year, 0, 3) + 512, category: "DEPOSIT",
        description: "Historical deposit receipt", vehicleId: s.vehicleId, depositId,
      });
    });
    await expect(s.owner.as.query(api.reports.getProfitAndLoss, {
      orgId: s.orgId,
      startDate: Date.UTC(year, 0, 1),
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    })).rejects.toThrow("Financial report is unavailable because legacy receipt history is too large.");
  });

  test("many historical holds fail closed before source lookups return a partial total", async () => {
    const { s } = await cashQuote("s486legacyholdsvolume");
    const year = s.fiscalYear;
    await s.t.run(async (ctx) => {
      const creator = await ctx.db.query("users").first();
      if (!creator) throw new Error("Missing test user");
      for (let i = 0; i < 200; i++) {
        const depositId = await ctx.db.insert("deposits", {
          orgId: s.orgId, vehicleId: s.vehicleId, customerId: s.customerId,
          amount: 1, status: "HELD", holdActive: false,
          createdBy: creator._id, createdAt: Date.UTC(year, 0, 2) + i,
        });
        await ctx.db.insert("transactions", {
          orgId: s.orgId, type: "IN", amount: 1,
          date: Date.UTC(year, 0, 3) + i, category: "DEPOSIT",
          description: "Historical deposit receipt", vehicleId: s.vehicleId, depositId,
        });
        for (let holdIndex = 0; holdIndex < 9; holdIndex++) {
          await ctx.db.insert("depositVehicleHolds", {
            orgId: s.orgId, depositId, vehicleId: s.vehicleId,
            active: false, createdAt: Date.UTC(year, 0, 4) + i + holdIndex,
          });
        }
      }
    });
    await expect(s.owner.as.query(api.reports.getProfitAndLoss, {
      orgId: s.orgId,
      startDate: Date.UTC(year, 0, 1),
      endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
    })).rejects.toThrow("Financial report is unavailable because legacy receipt history is too large.");
  });

  test("forfeiture income follows its posted month and each journal reversal month", async () => {
    vi.useFakeTimers();
    try {
      const year = 2026;
      vi.setSystemTime(Date.UTC(year, 3, 10));
      const { s, quoteId } = await cashQuote("s486forfeitdates");
      const depositId = await s.owner.as.mutation(api.deposits.create, {
        orgId: s.orgId,
        quoteId,
        amount: 200,
        method: "CASH",
        idempotencyKey: "s486forfeitdates-deposit",
      });
      const month = (monthIndex: number) => ({
        orgId: s.orgId,
        startDate: Date.UTC(year, monthIndex, 1),
        endDate: Date.UTC(year, monthIndex + 1, 1) - 1,
      });

      expect((await s.owner.as.query(api.reports.getProfitAndLoss, month(3))).depositForfeitureIncome).toBe(0);
      vi.setSystemTime(Date.UTC(year, 4, 10));
      await s.approver.as.mutation(api.deposits.release, {
        orgId: s.orgId,
        depositId,
        resolution: "FORFEITED",
        idempotencyKey: "s486forfeitdates-release",
      });
      const originalEventId = await s.t.run(async (ctx) => {
        const event = await ctx.db.query("accountingEvents")
          .withIndex("by_org_eventType", (q) => q.eq("orgId", s.orgId).eq("eventType", "DEPOSIT_FORFEITED"))
          .unique();
        if (!event) throw new Error("Missing forfeiture event fixture");
        return event._id;
      });
      expect((await s.owner.as.query(api.reports.getProfitAndLoss, month(4))).depositForfeitureIncome).toBe(200);

      vi.setSystemTime(Date.UTC(year, 5, 10));
      const firstReversal = await s.owner.as.mutation(internal.accountingLedger.reverse, {
        orgId: s.orgId,
        originalEventId,
        reversalDate: Date.UTC(year, 5, 10),
        reason: "Report month parity fixture",
        idempotencyKey: "s486forfeitdates-reverse-1",
      });
      expect((await s.owner.as.query(api.reports.getProfitAndLoss, month(4))).depositForfeitureIncome).toBe(200);
      expect((await s.owner.as.query(api.reports.getProfitAndLoss, month(5))).depositForfeitureIncome).toBe(-200);

      vi.setSystemTime(Date.UTC(year, 6, 10));
      await s.owner.as.mutation(internal.accountingLedger.reverse, {
        orgId: s.orgId,
        originalEventId: firstReversal.reversalEventId,
        reversalDate: Date.UTC(year, 6, 10),
        reason: "Report reversal lineage fixture",
        idempotencyKey: "s486forfeitdates-reverse-2",
      });
      expect((await s.owner.as.query(api.reports.getProfitAndLoss, month(6))).depositForfeitureIncome).toBe(200);
      const fullYear = await s.owner.as.query(api.reports.getProfitAndLoss, {
        orgId: s.orgId,
        startDate: Date.UTC(year, 0, 1),
        endDate: Date.UTC(year, 11, 31, 23, 59, 59, 999),
      });
      expect(fullYear.depositForfeitureIncome).toBe(200);
      expect((await publicIncomeStatement(s)).totalOtherIncome).toBe(200_000);
    } finally {
      vi.useRealTimers();
    }
  });

  test.each(["REFUNDED", "FORFEITED"] as const)(
    "owned CASH × held deposit: salesperson cannot record or %s money and every row stays unchanged",
    async (resolution) => {
      const { s, quoteId } = await cashQuote(`s486seller${resolution.toLowerCase()}`);
      const depositId = await s.owner.as.mutation(api.deposits.create, {
        orgId: s.orgId,
        quoteId,
        amount: 200,
        method: "CASH",
        idempotencyKey: `scrum486-${resolution.toLowerCase()}-hold`,
      });
      const clerkId = `s486seller${resolution.toLowerCase()}_salesperson`;
      await s.t.run(async (ctx) => {
        const userId = await ctx.db.insert("users", {
          clerkId,
          email: `${clerkId}@example.com`,
          name: "salesperson",
        });
        const roleId = await ctx.db.insert("roles", {
          orgId: s.orgId,
          name: "SALESPERSON",
          permissions: ["view:sales", "create:sales"],
        });
        await ctx.db.insert("memberships", { orgId: s.orgId, userId, roleId });
      });
      const salesperson = s.t.withIdentity({ subject: clerkId, clerkId });
      const before = await dbSnapshot(s.t, Object.keys(schema.tables));
      await expect(salesperson.mutation(api.deposits.create, {
        orgId: s.orgId,
        quoteId,
        amount: 200,
        method: "CASH",
        idempotencyKey: "scrum486-salesperson-create-denied",
      })).rejects.toThrow(/Missing required permissions: confirm:finance_disbursement/);
      expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(before);
      await expect(salesperson.mutation(api.deposits.release, {
        orgId: s.orgId,
        depositId,
        resolution,
        ...(resolution === "REFUNDED" ? { refundMethod: "CASH" as const } : {}),
        idempotencyKey: `scrum486-salesperson-${resolution.toLowerCase()}-denied`,
      })).rejects.toThrow(/Missing required permissions: approve:requests/);
      expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(before);
      expect(netByAccount(await journalRows(s))).toEqual({ "1100|JOD": 200_000, "2100|JOD": -200_000 });
    },
  );

  test("owned CASH × foreign quote/deposit IDs: authorized second tenant cannot move either tenant's money", async () => {
    const { s, quoteId } = await cashQuote("s486foreignids");
    const depositId = await s.owner.as.mutation(api.deposits.create, {
      orgId: s.orgId, quoteId, amount: 200, method: "CASH",
      idempotencyKey: "s486-foreign-source-deposit",
    });
    const other = await authorizedOtherTenant(s, "s486foreignids");
    const before = await dbSnapshot(s.t, Object.keys(schema.tables));

    await expect(other.owner.mutation(api.deposits.create, {
      orgId: other.orgId, quoteId, amount: 200, method: "CASH",
      idempotencyKey: "s486-foreign-quote-denied",
    })).rejects.toThrow(/Quote not found in this organization/);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(before);

    await expect(other.owner.mutation(api.deposits.release, {
      orgId: other.orgId, depositId, resolution: "REFUNDED", refundMethod: "CASH",
      idempotencyKey: "s486-foreign-deposit-denied",
    })).rejects.toThrow(/Deposit not found in this organization/);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(before);
    expect(netByAccount(await journalRows(s))).toEqual({ "1100|JOD": 200_000, "2100|JOD": -200_000 });

    const saleId = await completeCashSale(s, quoteId, "foreign-sale-denial");
    const completedSale = await dbSnapshot(s.t, Object.keys(schema.tables));
    // `sales.update` loads the sale through `requireOwnedRow` (8ac18f38a), whose
    // deliberate anti-enumeration contract (utils/tenancy.ts) raises ONE generic
    // "Record not found in this organization." for both a missing and a foreign row.
    // The refusal is the same tenant denial as before; only the wording changed. The
    // behavioural assertions below (no row changes, event still POSTED) are unchanged.
    await expect(other.owner.mutation(api.sales.update, {
      orgId: other.orgId, saleId, status: "CANCELLED",
    })).rejects.toThrow(/Record not found in this organization/);
    expect(await dbSnapshot(s.t, Object.keys(schema.tables))).toEqual(completedSale);
    expect(await eventStatuses(s, "SALE_COMPLETED", saleId)).toEqual(["POSTED"]);
  });

  test.each(["LEASE", "INTERNAL_INSTALLMENT"] as const)(
    "retired %s quote route refuses before any row changes",
    async (mode) => {
      const { s } = await cashQuote(`s486retired${mode.toLowerCase()}`);
      const tables = Object.keys(schema.tables);
      const before = await dbSnapshot(s.t, tables);
      await expectRetiredDealMode(s.owner.as.mutation(api.quotes.saveQuote, {
        orgId: s.orgId,
        customerId: s.customerId,
        vehicleId: s.vehicleId,
        mode,
        vehiclePrice: 12_500,
        downPayment: 0,
        termMonths: 48,
      }));
      expect(await dbSnapshot(s.t, tables)).toEqual(before);
    },
  );
});
